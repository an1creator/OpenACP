import type { AgentManager } from "./agents/agent-manager.js";
import type { SessionManager } from "./sessions/session-manager.js";
import type { ConfigManager } from "./config/config.js";
import type { SessionBridge } from "./sessions/session-bridge.js";
import {
  SessionTerminatingError,
  type Session,
  type SessionAttachmentLease,
} from "./sessions/session.js";
import type { IChannelAdapter } from "./channel.js";
import type { EventBus } from "./event-bus.js";
import type { MiddlewareChain } from "./plugin/middleware-chain.js";
import type { AgentEvent } from "./types.js";
import type { ContextManager } from "../plugins/context/context-manager.js";
import { getAgentCapabilities } from "./agents/agent-registry.js";
import { createChildLogger } from "./utils/log.js";
import { Hook, BusEvent, SessionEv } from "./events.js";

const log = createChildLogger({ module: "agent-switch" });

/** Dependencies injected from OpenACPCore to avoid circular imports. */
export interface AgentSwitchDeps {
  sessionManager: SessionManager;
  agentManager: AgentManager;
  configManager: ConfigManager;
  eventBus: EventBus;
  adapters: Map<string, IChannelAdapter>;
  createBridge: (session: Session, adapter: IChannelAdapter, adapterId?: string) => SessionBridge;
  disconnectSessionBridges: (sessionId: string) => number;
  getMiddlewareChain: () => MiddlewareChain | undefined;
  getService: <T>(name: string) => T | undefined;
}

/**
 * Coordinates the state transitions required when switching agents mid-session.
 *
 * Switching agents is a multi-step process with rollback support:
 * 1. Run `agent:beforeSwitch` middleware (blocking — plugins can veto)
 * 2. Determine whether to resume a previous agent session or spawn fresh
 * 3. Disconnect all SessionBridges and clean up adapter state
 * 4. Replace the agent instance on the session (with rollback on failure)
 * 5. Reconnect all bridges to the new agent
 * 6. Persist updated session record
 * 7. Fire `agent:afterSwitch` middleware (non-blocking)
 *
 * A per-session lock prevents concurrent switches on the same session.
 */
export class AgentSwitchHandler {
  /** Prevents concurrent switch operations on the same session */
  private switchingLocks = new Set<string>();

  constructor(private deps: AgentSwitchDeps) {}

  private isSwitchTargetLive(sessionId: string, session: Session): boolean {
    return this.deps.sessionManager.getSession(sessionId) === session && !session.isTerminating;
  }

  private assertSwitchTargetLive(sessionId: string, session: Session): void {
    if (!this.isSwitchTargetLive(sessionId, session)) {
      throw new SessionTerminatingError(sessionId);
    }
  }

  private captureAttachmentLeases(session: Session): Array<{
    adapterId: string;
    lease: SessionAttachmentLease;
  }> {
    return [...new Set(session.attachedAdapters)].map((adapterId) => {
      const threadId = session.threadIds.get(adapterId)
        ?? (session.channelId === adapterId ? session.threadId : undefined);
      const lease = threadId === undefined
        ? null
        : session.captureAttachmentLease(adapterId, threadId);
      if (!lease) {
        throw new Error(`Attached adapter "${adapterId}" has no coherent session binding`);
      }
      return { adapterId, lease };
    });
  }

  private reconnectCurrentAttachments(
    session: Session,
    attachments: Array<{ adapterId: string; lease: SessionAttachmentLease }>,
  ): void {
    for (const { adapterId, lease } of attachments) {
      if (!session.isAttachmentLeaseCurrent(lease)) continue;
      const adapter = this.deps.adapters.get(adapterId);
      if (!adapter) {
        throw new Error(`Attached adapter "${adapterId}" became unavailable during agent switch`);
      }
      this.deps.createBridge(session, adapter, adapterId).connect();
    }
  }

  /**
   * Switch a session to a different agent. Returns whether the previous
   * agent session was resumed or a new one was spawned.
   */
  async switch(sessionId: string, toAgent: string): Promise<{ resumed: boolean }> {
    if (this.switchingLocks.has(sessionId)) {
      throw new Error('Switch already in progress');
    }
    this.switchingLocks.add(sessionId);
    try {
      return await this.doSwitch(sessionId, toAgent);
    } finally {
      this.switchingLocks.delete(sessionId);
    }
  }

  private async doSwitch(sessionId: string, toAgent: string): Promise<{ resumed: boolean }> {
    const { sessionManager, agentManager, configManager, eventBus, adapters } = this.deps;

    const session = sessionManager.getSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const agentDef = agentManager.getAgent(toAgent);
    if (!agentDef) throw new Error(`Agent "${toAgent}" is not installed`);

    const fromAgent = session.agentName;
    if (toAgent === fromAgent) {
      throw new Error(`Session is already using agent "${toAgent}"`);
    }

    // 1. Middleware: agent:beforeSwitch (blocking)
    const middlewareChain = this.deps.getMiddlewareChain();
    const result = await middlewareChain?.execute(Hook.AGENT_BEFORE_SWITCH, {
      sessionId,
      fromAgent,
      toAgent,
    }, async (payload) => payload);
    this.assertSwitchTargetLive(sessionId, session);
    if (middlewareChain && !result) throw new Error('Agent switch blocked by middleware');

    // 2. Determine resume vs new — if the agent was used before in this session
    //    and supports resume, reconnect to its previous subprocess instead of spawning fresh
    const lastEntry = session.findLastSwitchEntry(toAgent);
    const caps = getAgentCapabilities(toAgent);
    const canResume = !!(lastEntry && caps.supportsResume);
    let resumed = false;

    // Emit "starting" events so UI can reflect long-running switches
    const startEvent: AgentEvent = {
      type: "system_message",
      message: `Switching from ${fromAgent} to ${toAgent}...`,
    };
    session.emit(SessionEv.AGENT_EVENT, startEvent);
    eventBus.emit(BusEvent.AGENT_EVENT, { sessionId, turnId: '', event: startEvent });
    eventBus.emit(BusEvent.SESSION_AGENT_SWITCH, {
      sessionId,
      fromAgent,
      toAgent,
      status: "starting",
    });

    // 3. Disconnect ALL bridges and retire action UI on every unique attached adapter.
    //    The in-memory snapshot is suspended first so stale callbacks cannot route
    //    while cleanup or a replacement spawn is still pending.
    const attachmentLeases = this.captureAttachmentLeases(session);
    const hadBridges = this.deps.disconnectSessionBridges(sessionId) > 0;
    session.suspendAgentActions();

    const cleanupErrors: unknown[] = [];
    for (const { adapterId, lease } of attachmentLeases) {
      // A concurrent explicit detach owns this adapter now. It must stay detached
      // and must never be recreated by this older switch transaction.
      if (!session.isAttachmentLeaseCurrent(lease)) continue;
      const adapter = adapters.get(adapterId);
      if (!adapter) {
        cleanupErrors.push(new Error(`Attached adapter "${adapterId}" is unavailable during switch cleanup`));
        continue;
      }
      try {
        if (adapter.cleanupAgentActionState) {
          await adapter.cleanupAgentActionState(session.id);
        } else if (adapter.cleanupSkillCommands) {
          await adapter.cleanupSkillCommands(session.id);
        } else if (adapter.sendSkillCommands) {
          await adapter.sendSkillCommands(session.id, []);
        }
      } catch (error) {
        cleanupErrors.push(error);
        log.warn({ sessionId, adapterId, err: error }, "Failed to clean adapter agent actions");
      }
      try {
        await adapter.cleanupSessionState?.(session.id);
      } catch (error) {
        cleanupErrors.push(error);
        log.warn({ sessionId, adapterId, err: error }, "Failed to clean adapter session state");
      }
    }
    this.assertSwitchTargetLive(sessionId, session);

    if (cleanupErrors.length > 0) {
      session.restoreCurrentAgentActions();
      if (hadBridges) {
        try {
          this.reconnectCurrentAttachments(session, attachmentLeases);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      const cleanupError = new AggregateError(cleanupErrors, "Failed to clean adapter state before agent switch");
      const failedEvent: AgentEvent = {
        type: "system_message",
        message: `Failed to switch to ${toAgent}: ${cleanupError.message}`,
      };
      session.emit(SessionEv.AGENT_EVENT, failedEvent);
      eventBus.emit(BusEvent.AGENT_EVENT, { sessionId, turnId: '', event: failedEvent });
      eventBus.emit(BusEvent.SESSION_AGENT_SWITCH, {
        sessionId,
        fromAgent,
        toAgent,
        status: "failed",
        error: cleanupError.message,
      });
      throw cleanupError;
    }

    const fromAgentSessionId = session.agentSessionId;
    const fromPromptCount = session.promptCount;
    const fromFirstAgent = session.firstAgent;
    const fromSwitchHistory = structuredClone(session.agentSwitchHistory);

    // 4. Switch agent on session (with rollback on failure).
    //    switchAgent() replaces the session's agent instance atomically — if the
    //    factory callback throws, the session state is unchanged.
    const fileService = this.deps.getService<import('../plugins/file-service/file-service.js').FileService>('file-service');
    const configAllowedPaths = configManager.get().workspace?.security?.allowedPaths ?? [];
    try {
      this.assertSwitchTargetLive(sessionId, session);
      await session.switchAgent(toAgent, async () => {
        if (canResume) {
          try {
            const instance = await agentManager.resume(toAgent, session.workingDirectory, lastEntry!.agentSessionId, configAllowedPaths);
            if (fileService) instance.addAllowedPath(fileService.baseDir);
            resumed = true;
            return instance;
          } catch (error) {
            this.assertSwitchTargetLive(sessionId, session);
            // Resume failed (session expired or unavailable) — fall through to spawn with context
            log.warn({ sessionId, toAgent, err: error }, "Resume failed, falling back to new agent with context injection");
          }
        }

        // Build history before spawning. This keeps the replacement factory free of
        // async boundaries after it owns a process, so terminal cleanup can take
        // ownership as soon as spawn/resume returns.
        let contextMarkdown: string | undefined;
        try {
          const contextService = this.deps.getService<ContextManager>('context');
          if (contextService) {
            const config = configManager.get();
            const labelAgent = config.agentSwitch?.labelHistory ?? true;
            await contextService.flushSession(sessionId);
            this.assertSwitchTargetLive(sessionId, session);
            const contextResult = await contextService.buildContext(
              { type: 'session', value: sessionId, repoPath: session.workingDirectory },
              { labelAgent, noCache: true },
            );
            this.assertSwitchTargetLive(sessionId, session);
            contextMarkdown = contextResult?.markdown;
          }
        } catch (error) {
          if (!this.isSwitchTargetLive(sessionId, session)) throw error;
          // Context injection is best-effort
        }
        // Fresh spawn: inject conversation history from the context service so the
        // new agent has awareness of what was discussed with the previous agent.
        const instance = await agentManager.spawn(toAgent, session.workingDirectory, configAllowedPaths);
        if (fileService) instance.addAllowedPath(fileService.baseDir);
        if (contextMarkdown) session.setContext(contextMarkdown);
        return instance;
      });
      this.assertSwitchTargetLive(sessionId, session);

      // Runtime activation is provisional until both bridge ownership and the
      // durable session record commit. Any failure below enters the same rollback.
      if (hadBridges) this.reconnectCurrentAttachments(session, attachmentLeases);
      this.assertSwitchTargetLive(sessionId, session);
      await sessionManager.patchRecord(sessionId, {
        agentName: toAgent,
        agentSessionId: session.agentSessionId,
        firstAgent: session.firstAgent,
        currentPromptCount: 0,
        agentSwitchHistory: session.agentSwitchHistory,
      }, { expectedSession: session });
      this.assertSwitchTargetLive(sessionId, session);
      session.restoreCurrentAgentActions();
    } catch (err) {
      // Cancellation/destroy is a terminal boundary, not a switch failure. Never
      // resurrect the old agent, reconnect bridges, emit switch results, or patch
      // the durable record after that boundary.
      if (!this.isSwitchTargetLive(sessionId, session)) {
        log.info({ sessionId, fromAgent, toAgent }, "Agent switch stopped because the session is terminating");
        throw err instanceof SessionTerminatingError ? err : new SessionTerminatingError(sessionId);
      }
      const errorMessage = err instanceof Error ? err.message : String(err);

      const failedEvent: AgentEvent = {
        type: "system_message",
        message: `Failed to switch to ${toAgent}: ${errorMessage}`,
      };
      session.emit(SessionEv.AGENT_EVENT, failedEvent);
      eventBus.emit(BusEvent.AGENT_EVENT, { sessionId, turnId: '', event: failedEvent });
      eventBus.emit(BusEvent.SESSION_AGENT_SWITCH, {
        sessionId,
        fromAgent,
        toAgent,
        status: "failed",
        error: errorMessage,
      });

      // Rollback runtime and durable identity before making old bridges visible.
      try {
        this.deps.disconnectSessionBridges(sessionId);
        await session.restoreAgentAfterFailedSwitch(fromAgent, async () => {
          try {
            return await agentManager.resume(fromAgent, session.workingDirectory, fromAgentSessionId);
          } catch (resumeError) {
            if (!this.isSwitchTargetLive(sessionId, session)) throw resumeError;
            return agentManager.spawn(fromAgent, session.workingDirectory);
          }
        });
        this.assertSwitchTargetLive(sessionId, session);
        await sessionManager.patchRecord(sessionId, {
          agentName: fromAgent,
          agentSessionId: session.agentSessionId,
          firstAgent: fromFirstAgent,
          currentPromptCount: fromPromptCount,
          agentSwitchHistory: fromSwitchHistory,
        }, { expectedSession: session });
        this.assertSwitchTargetLive(sessionId, session);
        session.restoreCurrentAgentActions();
        if (hadBridges) this.reconnectCurrentAttachments(session, attachmentLeases);
        log.warn({ sessionId, fromAgent, toAgent, err }, "Agent switch failed, rolled back to previous agent");
      } catch (rollbackErr) {
        if (!this.isSwitchTargetLive(sessionId, session)) {
          log.info({ sessionId, fromAgent, toAgent }, "Agent switch rollback stopped because the session is terminating");
          throw rollbackErr instanceof SessionTerminatingError
            ? rollbackErr
            : new SessionTerminatingError(sessionId);
        }
        session.fail(`Switch failed and rollback failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`);
        this.deps.disconnectSessionBridges(sessionId);
        try {
          await session.destroy();
        } catch (destroyError) {
          log.error({ sessionId, destroyError }, "Failed to terminate divergent runtime after rollback failure");
        }
        try {
          await sessionManager.patchRecord(sessionId, {
            status: "error",
            agentName: session.agentName,
            agentSessionId: session.agentSessionId,
            firstAgent: session.firstAgent,
            currentPromptCount: session.promptCount,
            agentSwitchHistory: session.agentSwitchHistory,
          }, { expectedSession: session });
        } catch (durabilityError) {
          log.error({ sessionId, durabilityError }, "Failed to persist terminal switch rollback failure");
        }
        log.error({ sessionId, fromAgent, toAgent, err, rollbackErr }, "Agent switch failed and rollback also failed");
        throw new AggregateError([err, rollbackErr], "Agent switch failed and rollback failed");
      }
      throw err;
    }

    // Success is externally visible only after bridge ownership and durable state
    // both commit. A cancellation while persistence is pending must not announce a
    // switch that ultimately crosses the terminal boundary.
    const successEvent: AgentEvent = {
      type: "system_message",
      message: resumed
        ? `Switched to ${toAgent} (resumed previous session).`
        : `Switched to ${toAgent} (new session).`,
    };
    session.emit(SessionEv.AGENT_EVENT, successEvent);
    eventBus.emit(BusEvent.AGENT_EVENT, { sessionId, turnId: '', event: successEvent });
    eventBus.emit(BusEvent.SESSION_AGENT_SWITCH, {
      sessionId,
      fromAgent,
      toAgent,
      status: "succeeded",
      resumed,
    });

    // 7. Middleware: agent:afterSwitch (fire-and-forget)
    middlewareChain?.execute(Hook.AGENT_AFTER_SWITCH, {
      sessionId,
      fromAgent,
      toAgent,
      resumed,
    }, async (p) => p).catch((error) => {
      log.warn({ sessionId, fromAgent, toAgent, err: error }, "Agent afterSwitch hook failed");
    });

    return { resumed };
  }
}
