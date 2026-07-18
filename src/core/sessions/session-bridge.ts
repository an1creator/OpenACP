import type { Session } from "./session.js";
import type { IChannelAdapter } from "../channel.js";
import type { MessageTransformer } from "../message-transformer.js";
import type { NotificationManager } from "../../plugins/notifications/notification.js";
import type { SessionManager } from "./session-manager.js";
import type { AgentEvent, PermissionRequest, SessionStatus, ElicitationRequest, ElicitationResolvedEvent } from "../types.js";
import type { EventBus } from "../event-bus.js";
import type { FileServiceInterface } from "../plugin/types.js";
import type { MiddlewareChain } from "../plugin/middleware-chain.js";
import type { DebugTracer } from "../utils/debug-tracer.js";
import { createChildLogger } from "../utils/log.js";
import { isPermissionBypass } from "../utils/bypass-detection.js";
// micromatch is a CJS module — must use default import and destructure
import micromatch from "micromatch";
const { isMatch } = micromatch;
import { isSystemEvent, getEffectiveTarget, extractSender, type TurnContext, type TurnRouting } from "./turn-context.js";
import { Hook, BusEvent, SessionEv } from "../events.js";
import type { AgentTitleContext } from "./session-naming.js";

const log = createChildLogger({ module: "session-bridge" });
const TERMINAL_STEP_TIMEOUT_MS = 2_000;

type AwaitedStep<T> =
  | { status: "fulfilled"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "timed-out" }
  | { status: "aborted" };

async function observeBoundedStep<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<AwaitedStep<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  const observed = operation.then<AwaitedStep<T>, AwaitedStep<T>>(
    (value) => ({ status: "fulfilled", value }),
    (error: unknown) => ({ status: "rejected", error }),
  );
  try {
    return await Promise.race([
      observed,
      new Promise<AwaitedStep<T>>((resolve) => {
        timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
      }),
      new Promise<AwaitedStep<T>>((resolve) => {
        if (signal.aborted) {
          resolve({ status: "aborted" });
          return;
        }
        const onAbort = () => resolve({ status: "aborted" });
        signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbortListener?.();
  }
}

/** Services required by SessionBridge for message transformation, persistence, and middleware. */
export interface BridgeDeps {
  messageTransformer: MessageTransformer;
  notificationManager: NotificationManager;
  sessionManager: SessionManager;
  eventBus?: EventBus;
  fileService?: FileServiceInterface;
  middlewareChain?: MiddlewareChain;
}

/**
 * Connects a Session to a channel adapter, forwarding agent events to the adapter's
 * stream interface and wiring up permission handling, lifecycle persistence, and middleware.
 *
 * Each adapter attached to a session gets its own bridge. The bridge subscribes to
 * Session events (agent_event, permission_request, status_change, etc.) and translates
 * them into adapter-specific calls (sendMessage, sendPermissionRequest, renameSessionThread).
 *
 * Multi-adapter routing: when a TurnContext is active, turn events (text, tool_call, etc.)
 * are forwarded only to the adapter that originated the prompt. System events (commands_update,
 * session_end, etc.) are always broadcast to all bridges.
 */
export class SessionBridge {
  private connected = false;
  private cleanupFns: Array<() => void> = [];
  private lifecycleController: AbortController | null = null;
  readonly adapterId: string;

  constructor(
    private session: Session,
    private adapter: IChannelAdapter,
    private deps: BridgeDeps,
    adapterId?: string,
  ) {
    this.adapterId = adapterId ?? adapter.name;
  }

  private get tracer(): DebugTracer | null {
    return this.session.agentInstance.debugTracer ?? null;
  }

  /** Async continuations may resume after cancellation disconnected this bridge. */
  private isCurrentBridgeIdentity(): boolean {
    const manager = this.deps.sessionManager;
    const check = manager.isCurrentSession ?? manager.isCurrentLiveSession;
    return this.connected && (
      typeof check !== "function" || check.call(manager, this.session)
    );
  }

  /** Ordinary work cannot continue after either terminal state. */
  private isCurrentLiveBridge(): boolean {
    return this.isCurrentBridgeIdentity()
      && !this.session.isTerminating
      && this.session.status !== "finished"
      && this.session.status !== "cancelled";
  }

  private canHandleAgentEvent(event: AgentEvent, agentGeneration: number): boolean {
    if (!this.isCurrentBridgeIdentity() || this.session.agentGeneration !== agentGeneration) return false;
    if (event.type !== "session_end") return this.isCurrentLiveBridge();
    if (!this.session.isTerminating && this.session.status === "active") return true;
    return this.session.isTerminalDeliveryRecipient(this.adapterId);
  }

  private isCurrentTerminalBridge(generation: number): boolean {
    return this.isCurrentBridgeIdentity()
      && !this.deps.sessionManager.isClosing
      && this.session.isTerminalDeliveryRecipient(this.adapterId, generation);
  }

  private async awaitTerminalStep<T>(
    label: string,
    generation: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const deadline = this.session.terminalDeliveryDeadline(generation);
    const signal = this.lifecycleController?.signal;
    if (!signal || deadline === null || !this.isCurrentTerminalBridge(generation)) {
      throw new Error(`Terminal ${label} aborted`);
    }
    const timeoutMs = Math.min(TERMINAL_STEP_TIMEOUT_MS, Math.max(1, deadline - Date.now()));
    const deferredOperation = Promise.resolve().then(() => {
      if (signal.aborted || !this.isCurrentTerminalBridge(generation)) {
        throw new Error(`Terminal ${label} superseded`);
      }
      return operation();
    });
    const outcome = await observeBoundedStep(deferredOperation, timeoutMs, signal);
    if (!this.isCurrentTerminalBridge(generation)) {
      throw new Error(`Terminal ${label} superseded`);
    }
    if (outcome.status === "fulfilled") return outcome.value;
    if (outcome.status === "rejected") throw outcome.error;
    if (outcome.status === "timed-out") throw new Error(`Terminal ${label} timed out after ${timeoutMs}ms`);
    throw new Error(`Terminal ${label} aborted`);
  }

  /** Register a listener and track it for cleanup */
  private listen(emitter: any, event: string, handler: (...args: any[]) => void): void {
    emitter.on(event, handler);
    this.cleanupFns.push(() => emitter.off(event, handler));
  }

  /** Send message to adapter, optionally running through message:outgoing middleware */
  private async sendMessage(
    sessionId: string,
    message: ReturnType<MessageTransformer["transform"]>,
    agentGeneration = this.session.agentGeneration,
  ): Promise<void> {
    try {
      if (!this.isCurrentLiveBridge()) return;
      const mw = this.deps.middlewareChain;
      if (mw) {
        const result = await mw.execute(Hook.MESSAGE_OUTGOING, { sessionId, message }, async (m) => m);
        if (!this.isCurrentLiveBridge() || this.session.agentGeneration !== agentGeneration) return;
        this.tracer?.log("core", { step: "middleware:outgoing", sessionId, hook: "message:outgoing", blocked: !result });
        if (!result) return;
        this.tracer?.log("core", { step: "dispatch", sessionId, message: result.message });
        this.adapter.sendMessage(sessionId, result.message).catch((err) => {
          log.error({ err, sessionId }, "Failed to send message to adapter");
        });
      } else {
        if (!this.isCurrentLiveBridge() || this.session.agentGeneration !== agentGeneration) return;
        this.tracer?.log("core", { step: "dispatch", sessionId, message });
        this.adapter.sendMessage(sessionId, message).catch((err) => {
          log.error({ err, sessionId }, "Failed to send message to adapter");
        });
      }
    } catch (err) {
      log.error({ err, sessionId }, "Error in sendMessage middleware");
    }
  }

  /** Terminal delivery awaits middleware and the adapter before bridge cleanup. */
  private async sendTerminalMessage(
    sessionId: string,
    message: ReturnType<MessageTransformer["transform"]>,
    terminalGeneration: number,
  ): Promise<void> {
    if (!this.isCurrentTerminalBridge(terminalGeneration)) return;
    const mw = this.deps.middlewareChain;
    const result = mw
      ? await this.awaitTerminalStep(
          "outgoing middleware",
          terminalGeneration,
          () => mw.execute(Hook.MESSAGE_OUTGOING, { sessionId, message }, async (m) => m),
        )
      : { sessionId, message };
    if (
      !result ||
      !this.isCurrentTerminalBridge(terminalGeneration)
    ) return;
    this.tracer?.log("core", { step: "dispatch", sessionId, message: result.message });
    await this.awaitTerminalStep(
      "adapter send",
      terminalGeneration,
      () => this.adapter.sendMessage(sessionId, result.message),
    );
  }

  /**
   * Determine if this bridge should forward the given event based on turn routing.
   * System events are always forwarded; turn events are routed only to the target adapter.
   */
  shouldForward(event: AgentEvent): boolean {
    // System events → always forward to all bridges
    if (isSystemEvent(event)) return true;

    // No active turn context → forward (backward compat)
    const ctx = this.session.activeTurnContext;
    if (!ctx) return true;

    // Get effective target (null = silent, string = target adapterId)
    const target = getEffectiveTarget(ctx);

    // Silent turn → suppress all turn events
    if (target === null) return false;

    // Turn events → only forward to target adapter
    return this.adapterId === target;
  }

  /**
   * Subscribe to session events and start forwarding them to the adapter.
   *
   * Wires: agent events → adapter dispatch, permission UI, lifecycle persistence
   * (status changes, naming, prompt count), and EventBus notifications.
   * Also replays any commands or config options that arrived before the bridge connected.
   */
  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.lifecycleController = new AbortController();
    this.session.registerBridge(this.adapterId);

    // Wire session events to adapter (session → adapter dispatch)
    // The agent→session relay is owned by the Session itself (wireAgentRelay),
    // so session.on(SessionEv.AGENT_EVENT) fires for all sessions including headless ones.
    this.listen(this.session, SessionEv.AGENT_EVENT, (event: AgentEvent) => {
      const agentGeneration = this.session.agentGeneration;
      const titleContext = event.type === "session_info_update" && event.title
        ? this.session.captureAgentTitleContext()
        : undefined;
      if (this.shouldForward(event)) {
        this.dispatchAgentEvent(event, agentGeneration, titleContext);
      } else {
        // Event is not forwarded to this adapter's channel, but EventBus observers
        // (e.g. /events SSE stream) still need to see it for cross-adapter visibility.
        this.deps.eventBus?.emit(BusEvent.AGENT_EVENT, { sessionId: this.session.id, turnId: '', event });
      }
    });

    // Wire permissions
    // Only register the onPermissionRequest handler for the primary adapter (first bridge to connect).
    // Secondary bridges must not overwrite it — each bridge receives the permission_request session
    // event and sends UI to its own adapter via the listener below.
    if (!this.session.agentInstance.onPermissionRequest ||
        (this.session.agentInstance.onPermissionRequest as any).__bridgeId === undefined) {
      const handler = async (request: PermissionRequest) => {
        return this.resolvePermission(request);
      };
      (handler as any).__bridgeId = this.adapterId;
      this.session.agentInstance.onPermissionRequest = handler;
    }

    // Wire permission UI for secondary bridges — when the primary bridge emits
    // "permission_request" (after setPending), secondary bridges forward it to their adapter.
    // The primary bridge sends its UI directly in resolvePermission (awaited, preserving
    // ordering guarantees). Secondary bridges use this fire-and-forget listener.
    this.listen(this.session, SessionEv.PERMISSION_REQUEST, async (request: PermissionRequest) => {
      if (!this.isCurrentLiveBridge()) return;
      // Skip if this is the primary bridge — it handles UI directly in resolvePermission.
      const current = this.session.agentInstance.onPermissionRequest as any;
      if (current?.__bridgeId === this.adapterId) return;
      // Only send UI when the gate is pending (guard against informational-only emits
      // from auto-approve paths).
      if (!this.session.permissionGate.isPending) return;
      try {
        await this.adapter.sendPermissionRequest(this.session.id, request);
      } catch (err) {
        log.error({ err, sessionId: this.session.id, adapterId: this.adapterId }, "Failed to send permission request to adapter");
      }
    });

    this.listen(this.session, SessionEv.ELICITATION_REQUEST, (request: ElicitationRequest) => {
      if (!this.isCurrentLiveBridge() || request.targetAdapterId !== this.adapterId) return;
      const task = async () => {
        const secureInput = this.adapter.capabilities.elicitation?.secureInput ?? "none";
        if (
          request.sensitiveFields?.length
          && request.owner?.apiCredential === undefined
          && (
            !request.owner?.userId
            || (secureInput !== "private" && secureInput !== "delete-after-capture")
          )
        ) {
          await this.adapter.sendMessage(this.session.id, {
            type: "system_message",
            text: "The agent requested protected input, but this connector cannot capture it safely. The request was cancelled.",
          });
          this.session.elicitationGate.cancel(request.id, "delivery_failed");
          return;
        }
        if (
          request.sensitiveFields?.length
          && request.owner?.apiCredential !== undefined
          && secureInput !== "none"
        ) {
          await this.adapter.sendMessage(this.session.id, {
            type: "system_message",
            text: `Protected input required: ${request.message}\nRespond through the authenticated REST endpoint for this session.`,
          });
          return;
        }
        if (this.adapter.sendElicitationRequest && this.adapter.capabilities.elicitation?.form) {
          await this.adapter.sendElicitationRequest(this.session.id, request);
          return;
        }
        await this.adapter.sendMessage(this.session.id, {
          type: "system_message",
          text: `Input required: ${request.message}\nRespond through the authenticated REST endpoint for this session.`,
        });
      };
      void task().catch((error) => {
        log.error(
          { err: error, sessionId: this.session.id, requestId: request.id, adapterId: this.adapterId },
          "Failed to present structured input request",
        );
        this.session.elicitationGate.cancel(request.id, "delivery_failed");
      });
    });

    this.listen(this.session, SessionEv.ELICITATION_RESOLVED, (event: ElicitationResolvedEvent) => {
      if (!this.adapter.dismissElicitationRequest) return;
      void this.adapter.dismissElicitationRequest(this.session.id, event).catch((error) => {
        log.warn(
          { err: error, sessionId: this.session.id, requestId: event.requestId, adapterId: this.adapterId },
          "Failed to dismiss structured input UI",
        );
      });
    });

    // Wire lifecycle: persist status changes and auto-disconnect on terminal states
    this.listen(this.session, SessionEv.STATUS_CHANGE, (from: SessionStatus, to: SessionStatus) => {
      const directFinished = to === 'finished' && !this.session.hasTerminalDelivery;
      const persisted = this.deps.sessionManager.patchRecord(this.session.id, {
        status: to,
        lastActiveAt: new Date().toISOString(),
      }, {
        expectedSession: this.session,
        ...(directFinished ? { immediate: true } : {}),
      });
      persisted.catch((err) => {
        log.error({ err, sessionId: this.session.id }, "Failed to persist session status");
      });
      if (!this.session.isAssistant) {
        this.deps.eventBus?.emit(BusEvent.SESSION_UPDATED, {
          sessionId: this.session.id,
          status: to,
        });
      }

      // A direct finish() call has no agent completion event to own a delivery
      // barrier, so retain the legacy cleanup path for that special case.
      if (directFinished) {
        void persisted.then(
          () => {
            const finalize = this.deps.sessionManager.finalizeFinishedSession;
            if (typeof finalize === 'function') return finalize.call(this.deps.sessionManager, this.session);
            this.deps.sessionManager.releaseSessionResources?.(this.session);
            if (this.connected) this.disconnect();
          },
          () => undefined,
        );
      }
    });

    // Wire lifecycle: persist and relay name changes to all adapters.
    this.listen(this.session, SessionEv.NAMED, async (name: string) => {
      try {
        if (!this.isCurrentLiveBridge()) return;
        await this.deps.sessionManager.patchRecord(
          this.session.id,
          { name, nameSource: this.session.nameSource },
          { expectedSession: this.session },
        );
        if (!this.isCurrentLiveBridge()) return;
        if (!this.session.isAssistant) {
          this.deps.eventBus?.emit(BusEvent.SESSION_UPDATED, {
            sessionId: this.session.id,
            name,
          });
        }
        await this.adapter.renameSessionThread(this.session.id, name);
      } catch (err) {
        log.error({ err, sessionId: this.session.id }, "Failed to persist or relay session name");
      }
    });

    // Wire lifecycle: persist prompt count after each prompt for resume decisions
    this.listen(this.session, SessionEv.PROMPT_COUNT_CHANGED, (count: number) => {
      this.deps.sessionManager.patchRecord(
        this.session.id,
        { currentPromptCount: count },
        { expectedSession: this.session },
      ).catch((err) => {
        log.error({ err, sessionId: this.session.id }, "Failed to persist prompt count");
      });
    });

    // Wire turn_started: emit message:processing on EventBus so SSE clients
    // (including other connected App windows) can show the streaming assistant stub.
    this.listen(this.session, SessionEv.TURN_STARTED, (ctx: TurnContext) => {
      this.deps.eventBus?.emit(BusEvent.MESSAGE_PROCESSING, {
        sessionId: this.session.id,
        turnId: ctx.turnId,
        sourceAdapterId: ctx.sourceAdapterId,
        userPrompt: ctx.userPrompt,
        finalPrompt: ctx.finalPrompt,
        attachments: ctx.attachments,
        sender: extractSender(ctx.meta),
        timestamp: new Date().toISOString(),
      });
    });

    // Wire prompt_queued → emit prompt:waiting on EventBus for adapters to show queue notifications.
    // This event fires synchronously from inside PromptQueue.enqueue() when an item is placed
    // behind a running prompt, so sourceAdapterId and queueDepth are accurate (no race condition).
    this.listen(this.session, SessionEv.PROMPT_QUEUED, (data: { turnId: string | undefined; position: number; routing: TurnRouting | undefined }) => {
      this.deps.eventBus?.emit(BusEvent.PROMPT_WAITING, {
        sessionId: this.session.id,
        turnId: data.turnId ?? '',
        sourceAdapterId: data.routing?.sourceAdapterId ?? this.session.channelId,
        queueDepth: data.position,
      });
    });

    // Replay a pre-connection snapshot. If no authoritative snapshot arrived,
    // explicitly clear connector state so restart/resume cannot resurrect a
    // persisted command dump from an older agent process.
    const currentCommands = this.session.latestCommands ?? [];
    log.debug({ commands: currentCommands }, "Commands available");
    Promise.resolve(this.adapter.sendSkillCommands?.(this.session.id, currentCommands)).catch((err) => {
      log.warn({ err, sessionId: this.session.id }, "Failed to replay agent command snapshot");
    });

    // Replay configOptions so the adapter reflects the current agent's options
    if (
      this.session.configOptions.length > 0
      && !this.session.hasActiveHeadlessDelivery("agent:config")
    ) {
      this.session.emit(SessionEv.AGENT_EVENT, { type: "config_option_update", options: this.session.configOptions });
    }
  }

  /** Unsubscribe all session event listeners and clean up adapter state. */
  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.lifecycleController?.abort();
    this.lifecycleController = null;
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
    // Only clear onPermissionRequest if this bridge currently owns it.
    // This prevents a disconnecting secondary bridge from killing permission
    // handling for all surviving bridges.
    const current = this.session.agentInstance.onPermissionRequest as any;
    if (current?.__bridgeId === this.adapterId) {
      this.session.agentInstance.onPermissionRequest = async () => "";
    }
    // unregisterBridge restores the headless permission owner when this was the
    // final attached bridge, so it must run after clearing the bridge handler.
    this.session.unregisterBridge(this.adapterId);
    // Clean up transformer caches for this session
    this.deps.messageTransformer.clearSessionCaches?.(this.session.id);
  }

  /** Dispatch an agent event through middleware and to the adapter */
  private async dispatchAgentEvent(
    event: AgentEvent,
    agentGeneration: number,
    titleContext?: AgentTitleContext,
  ): Promise<void> {
    if (!this.canHandleAgentEvent(event, agentGeneration)) return;
    this.tracer?.log("core", { step: "agent_event", sessionId: this.session.id, event });
    const mw = this.deps.middlewareChain;
    if (mw) {
      try {
        const result = await mw.execute(Hook.AGENT_BEFORE_EVENT, { sessionId: this.session.id, event }, async (e) => e);
        if (!this.canHandleAgentEvent(event, agentGeneration)) return;
        this.tracer?.log("core", { step: "middleware:before", sessionId: this.session.id, hook: "agent:beforeEvent", blocked: !result });
        if (!result) return; // blocked by middleware
        const transformedEvent = result.event;
        if (!this.canHandleAgentEvent(transformedEvent, agentGeneration)) return;
        this.handleAgentEvent(transformedEvent, agentGeneration, titleContext);
      } catch {
        // Middleware error — proceed with original event
        if (!this.canHandleAgentEvent(event, agentGeneration)) return;
        try {
          this.handleAgentEvent(event, agentGeneration, titleContext);
        } catch (err) {
          log.error({ err, sessionId: this.session.id }, "Error handling agent event (middleware fallback)");
        }
      }
    } else {
      try {
        this.handleAgentEvent(event, agentGeneration, titleContext);
      } catch (err) {
        log.error({ err, sessionId: this.session.id }, "Error handling agent event");
      }
    }
  }

  private handleAgentEvent(
    event: AgentEvent,
    agentGeneration: number,
    titleContext?: AgentTitleContext,
  ): import('../types.js').OutgoingMessage | undefined {
    if (!this.canHandleAgentEvent(event, agentGeneration)) return undefined;
    const session = this.session;
    const ctx = {
      get id() {
        return session.id;
      },
      get workingDirectory() {
        return session.workingDirectory;
      },
    };

    let outgoing: import('../types.js').OutgoingMessage | undefined;

      switch (event.type) {
        case "text":
        case "thought":
        case "tool_call":
        case "tool_update":
        case "plan":
        case "usage":
          outgoing = this.deps.messageTransformer.transform(event, ctx);
          this.tracer?.log("core", { step: "transform", sessionId: this.session.id, input: event, output: outgoing });
          this.sendMessage(this.session.id, outgoing, agentGeneration);
          break;

        case "session_end":
          outgoing = this.beginTerminalDelivery(event);
          break;

        case "error":
          if (!this.session.fail(event.message)) break;
          this.adapter.cleanupSkillCommands?.(this.session.id);
          outgoing = this.deps.messageTransformer.transform(event);
          this.sendMessage(this.session.id, outgoing, agentGeneration);
          this.deps.notificationManager.notify(this.session.channelId, {
            sessionId: this.session.id,
            sessionName: this.session.name,
            type: "error",
            summary: event.message,
          });
          break;

        case "image_content": {
          if (this.deps.fileService) {
            const fs = this.deps.fileService;
            const sid = this.session.id;
            const { data, mimeType } = event;
            const buffer = Buffer.from(data, "base64");
            const ext = fs.extensionFromMime(mimeType);
            fs.saveFile(sid, `agent-image${ext}`, buffer, mimeType)
              .then((att) => {
                if (!this.isCurrentLiveBridge() || this.session.agentGeneration !== agentGeneration) return;
                this.sendMessage(sid, {
                  type: "attachment",
                  text: "",
                  attachment: att,
                }, agentGeneration);
              })
              .catch((err) => log.error({ err }, "Failed to save agent image"));
          }
          break;
        }
        case "audio_content": {
          if (this.deps.fileService) {
            const fs = this.deps.fileService;
            const sid = this.session.id;
            const { data, mimeType } = event;
            const buffer = Buffer.from(data, "base64");
            const ext = fs.extensionFromMime(mimeType);
            fs.saveFile(sid, `agent-audio${ext}`, buffer, mimeType)
              .then((att) => {
                if (!this.isCurrentLiveBridge() || this.session.agentGeneration !== agentGeneration) return;
                this.sendMessage(sid, {
                  type: "attachment",
                  text: "",
                  attachment: att,
                }, agentGeneration);
              })
              .catch((err) => log.error({ err }, "Failed to save agent audio"));
          }
          break;
        }

        case "commands_update":
          log.debug({ commands: event.commands }, "Commands available");
          Promise.resolve(this.adapter.sendSkillCommands?.(this.session.id, event.commands)).catch((err) => {
            log.warn({ err, sessionId: this.session.id }, "Failed to update agent command snapshot");
          });
          break;

        case "system_message":
          outgoing = this.deps.messageTransformer.transform(event);
          this.sendMessage(this.session.id, outgoing, agentGeneration);
          break;

        case "session_info_update":
          if (event.title) {
            const decision = this.session.applyAgentTitle(
              event.title,
              titleContext ?? this.session.captureAgentTitleContext(),
            );
            if (decision.status === "ignored") break;
            event = { ...event, title: decision.name };
            outgoing = this.deps.messageTransformer.transform(event);
            this.sendMessage(this.session.id, outgoing, agentGeneration);
          }
          // title-less updates (e.g. updatedAt-only) carry no user-visible content
          break;

        case "config_option_update":
          this.session.updateConfigOptions(event.options, agentGeneration).then((applied) => {
            if (applied === false) return;
            if (!this.isCurrentLiveBridge() || this.session.agentGeneration !== agentGeneration) return;
            this.persistAcpState();
          }).catch(() => { /* middleware blocked or error — skip persist */ });
          outgoing = this.deps.messageTransformer.transform(event);
          this.sendMessage(this.session.id, outgoing, agentGeneration);
          break;

        case "user_message_chunk":
          outgoing = this.deps.messageTransformer.transform(event);
          this.sendMessage(this.session.id, outgoing, agentGeneration);
          break;

        case "resource_content":
        case "resource_link":
          outgoing = this.deps.messageTransformer.transform(event);
          this.sendMessage(this.session.id, outgoing, agentGeneration);
          break;

        case "tts_strip":
          this.adapter.stripTTSBlock?.(this.session.id);
          break;
      }

      if (event.type !== "session_end") {
        this.deps.eventBus?.emit(BusEvent.AGENT_EVENT, {
          sessionId: this.session.id,
          turnId: this.session.activeTurnContext?.turnId ?? '',
          event,
        });
      }

    return outgoing;
  }

  private beginTerminalDelivery(
    event: Extract<AgentEvent, { type: "session_end" }>,
  ): import('../types.js').OutgoingMessage | undefined {
    const generation = this.session.beginTerminalDelivery(event.reason);
    if (generation === null || !this.session.claimTerminalDelivery(this.adapterId, generation)) {
      return undefined;
    }
    const outgoing = this.deps.messageTransformer.transform(event);
    void this.deliverTerminalEvent(event, outgoing, generation);
    return outgoing;
  }

  private async deliverTerminalEvent(
    event: Extract<AgentEvent, { type: "session_end" }>,
    outgoing: import('../types.js').OutgoingMessage,
    generation: number,
  ): Promise<void> {
    let durable = false;
    try {
      await this.session.ensureTerminalDurability(generation, () => (
        this.deps.sessionManager.patchRecord(this.session.id, {
          status: "finished",
          lastActiveAt: new Date().toISOString(),
        }, { immediate: true, expectedSession: this.session })
      ));
      durable = true;
      if (!this.isCurrentTerminalBridge(generation)) return;

      if (this.adapter.cleanupSkillCommands) {
        await this.awaitTerminalStep(
          "skill cleanup",
          generation,
          () => this.adapter.cleanupSkillCommands!(this.session.id),
        );
      }
      if (!this.isCurrentTerminalBridge(generation)) return;
      if (this.session.claimTerminalEventPublication(generation)) {
        this.deps.eventBus?.emit(BusEvent.AGENT_EVENT, {
          sessionId: this.session.id,
          turnId: this.session.activeTurnContext?.turnId ?? '',
          event,
        });
      }
      await this.sendTerminalMessage(this.session.id, outgoing, generation);
      if (!this.isCurrentTerminalBridge(generation)) return;
      if (this.session.claimTerminalNotification(generation)) {
        await this.awaitTerminalStep(
          "notification",
          generation,
          () => this.deps.notificationManager.notify(this.session.channelId, {
            sessionId: this.session.id,
            sessionName: this.session.name,
            type: "completed",
            summary: `Session "${this.session.name || this.session.id}" completed\n⏱ ${Math.round((Date.now() - this.session.createdAt.getTime()) / 60000)} min · 💬 ${this.session.promptCount} prompts`,
          }),
        );
      }
    } catch (err) {
      this.session.markTerminalDeliveryFailed(
        generation,
        err instanceof Error ? err.message : String(err),
      );
      log.error({ err, sessionId: this.session.id, adapterId: this.adapterId }, "Terminal session delivery failed");
    } finally {
      if (!durable) {
        if (this.session.abortTerminalDelivery(generation)) {
          this.deps.sessionManager.releaseSessionResources?.(this.session);
        }
        return;
      }
      if (this.session.completeTerminalDelivery(this.adapterId, generation)) {
        const finalize = this.deps.sessionManager.finalizeFinishedSession;
        if (typeof finalize !== 'function') {
          this.deps.sessionManager.releaseSessionResources?.(this.session);
          return;
        }
        void finalize.call(this.deps.sessionManager, this.session).catch((cleanupError) => {
          log.error(
            { err: cleanupError, sessionId: this.session.id },
            'Finished session teardown coordination failed',
          );
        });
      }
    }
  }

  /** Persist current ACP state (configOptions, agentCapabilities) to session store as cache */
  private persistAcpState(): void {
    if (!this.isCurrentLiveBridge()) return;
    this.deps.sessionManager.patchRecord(this.session.id, {
      acpState: this.session.toAcpStateSnapshot(),
    }, { expectedSession: this.session });
  }

  /** Resolve a permission request through the full pipeline: middleware -> auto-approve -> ask user */
  private async resolvePermission(request: PermissionRequest): Promise<string> {
    if (!this.isCurrentLiveBridge()) return "";
    const startTime = Date.now();
    const mw = this.deps.middlewareChain;

    // Step 1: Middleware
    let permReq = request;
    if (mw) {
      const payload = { sessionId: this.session.id, request, autoResolve: undefined as string | undefined };
      const result = await mw.execute(Hook.PERMISSION_BEFORE_REQUEST, payload, async (r) => r);
      if (!this.isCurrentLiveBridge()) return "";
      if (!result) return ""; // blocked by middleware
      permReq = result.request;
      // If middleware set autoResolve, skip UI and return directly
      if (result.autoResolve) {
        this.emitAfterResolve(mw, permReq.id, result.autoResolve, 'middleware', startTime);
        return result.autoResolve;
      }
    }

    this.deps.eventBus?.emit(BusEvent.PERMISSION_REQUEST, {
      sessionId: this.session.id,
      permission: permReq,
    });

    // Step 2: Auto-approve
    const autoDecision = this.checkAutoApprove(permReq);
    if (autoDecision) {
      // Emit informational event even on auto-approve (for SSE / monitoring consumers)
      this.session.emit(SessionEv.PERMISSION_REQUEST, permReq);
      this.emitAfterResolve(mw, permReq.id, autoDecision, 'system', startTime);
      return autoDecision;
    }

    // Step 3: Ask user
    // Set pending BEFORE emitting "permission_request" so that secondary bridge listeners
    // can guard on isPending. This also prevents a race where the user resolves before we
    // start waiting.
    const promise = this.session.permissionGate.setPending(permReq);

    // Emit the session event AFTER setPending — secondary bridges listen to this and forward
    // the permission UI to their own adapters (fire-and-forget).
    this.session.emit(SessionEv.PERMISSION_REQUEST, permReq);

    // Send permission UI to this bridge's own adapter (primary bridge path, awaited to
    // preserve the ordering guarantee: setPending → sendPermissionRequest).
    await this.adapter.sendPermissionRequest(this.session.id, permReq);
    if (!this.isCurrentLiveBridge()) return "";

    // Wait for user response — adapter resolves this promise
    const optionId = await promise;
    if (!this.isCurrentLiveBridge()) return optionId;

    // Broadcast permission:resolved so other adapters can dismiss their UI
    this.deps.eventBus?.emit(BusEvent.PERMISSION_RESOLVED, {
      sessionId: this.session.id,
      requestId: permReq.id,
      decision: optionId,
      optionId,
      resolvedBy: this.adapterId,
    });

    this.emitAfterResolve(mw, permReq.id, optionId, 'user', startTime);
    return optionId;
  }

  /** Check if a permission request should be auto-approved (bypass mode only) */
  private checkAutoApprove(request: PermissionRequest): string | null {
    // Bypass mode: auto-approve all permissions (agent-side or client-side)
    const modeOption = this.session.getConfigByCategory("mode");
    const isAgentBypass = modeOption && isPermissionBypass(
      typeof modeOption.currentValue === "string" ? modeOption.currentValue : ""
    );
    const isClientBypass = this.session.clientOverrides.bypassPermissions;
    if (isAgentBypass || isClientBypass) {
      const allowOption = request.options.find((o) => o.isAllow);
      if (allowOption) {
        log.info(
          { sessionId: this.session.id, requestId: request.id, optionId: allowOption.id, agentBypass: !!isAgentBypass, clientBypass: !!isClientBypass },
          "Bypass mode: auto-approving permission",
        );
        return allowOption.id;
      }
    }

    // Plugin-declared auto-approved command patterns (micromatch glob matching).
    // Multi-line shell commands (heredoc bodies, `\`-line continuations) contain
    // real newlines which micromatch globs do not cross — normalize runs of
    // whitespace to a single space so the whole command becomes a single line
    // for matching purposes.
    const patterns = this.session.autoApprovedCommands;
    if (patterns.length > 0 && request.description) {
      const normalized = request.description.replace(/\s+/g, ' ').trim();
      if (isMatch(normalized, patterns, { dot: true })) {
        const allowOption = request.options.find((o) => o.isAllow);
        if (allowOption) {
          log.info(
            { sessionId: this.session.id, requestId: request.id, command: request.description },
            "autoApprovedCommands: auto-approving matching command",
          );
          return allowOption.id;
        }
      }
    }

    return null;
  }

  /** Emit permission:afterResolve middleware hook (fire-and-forget) */
  private emitAfterResolve(mw: MiddlewareChain | undefined, requestId: string, decision: string, userId: string, startTime: number): void {
    if (mw) {
      mw.execute(Hook.PERMISSION_AFTER_RESOLVE, {
        sessionId: this.session.id, requestId, decision, userId, durationMs: Date.now() - startTime,
      }, async (p) => p).catch(() => {});
    }
  }
}
