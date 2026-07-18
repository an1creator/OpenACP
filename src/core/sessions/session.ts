import { nanoid } from "nanoid";
import type { AgentInstance } from "../agents/agent-instance.js";
import type { AgentCapabilities, AgentCommand, AgentEvent, AgentSwitchEntry, Attachment, PermissionRequest, SessionStatus, ConfigOption, SetConfigOptionValue, SessionModeState, SessionModelState, TurnMeta, ElicitationRequest, ElicitationResolvedEvent } from "../types.js";
import type { CreateElicitationRequest, CreateElicitationResponse, ElicitationSchema } from "@agentclientprotocol/sdk";
import { TypedEmitter } from "../utils/typed-emitter.js";
import { PromptQueue } from "./prompt-queue.js";
import { PermissionGate } from "./permission-gate.js";
import { ElicitationGate } from "./elicitation-gate.js";
import { createChildLogger, createSessionLogger, closeSessionLogger, type Logger } from "../utils/log.js";
import type { SpeechService } from "../../plugins/speech/exports.js";
import type { MiddlewareChain } from "../plugin/middleware-chain.js";
import * as fs from "node:fs";
import type { TurnRouting } from "./turn-context.js";
import { createTurnContext, getEffectiveTarget, type TurnContext } from "./turn-context.js";
import {
  captureAgentTitleContext,
  isPromptEcho,
  normalizeSessionName,
  restoreSessionName,
  type AgentTitleContext,
  type AgentTitleDecision,
  type SessionNameSource,
} from "./session-naming.js";
import { Hook, SessionEv } from "../events.js";
import { redactNetworkSecrets } from "../security/network-redaction.js";
const moduleLog = createChildLogger({ module: "session" });

type FormElicitationRequest = CreateElicitationRequest & {
  mode: "form";
  requestedSchema: ElicitationSchema;
  sessionId: string;
  toolCallId?: string | null;
};

// Telegram expands escaped HTML entities, so this keeps the rendered warning below its 4,096-character limit.
const MAX_TRANSCRIPTION_ERROR_LENGTH = 700;

const CONFIG_CHANGE_BLOCKED = "Configuration change was blocked by policy.";
const CONFIG_CHANGE_SUPERSEDED = "Configuration change was cancelled because the session changed.";
const CONFIG_CHANGE_UNACKNOWLEDGED = "The agent did not acknowledge the configuration change.";
const CONFIG_CHANGE_QUEUE_TIMEOUT = "Configuration change could not start before the queue timeout.";
const CONFIG_MUTATION_QUEUE_TIMEOUT_MS = 30_000;

/** Non-enumerable ownership marker used during headless → bridge handoff. */
export const HEADLESS_DELIVERY_CLAIM = Symbol("openacp.headlessDeliveryClaim");

export interface HeadlessDeliveryClaim {
  readonly sessionId: string;
  readonly id: number;
  readonly epoch: number;
  readonly kind: string;
}

export type HeadlessClaimedPayload<T extends object> = T & {
  [HEADLESS_DELIVERY_CLAIM]?: HeadlessDeliveryClaim;
};

export function markHeadlessDelivery<T extends object>(
  payload: T,
  claim: HeadlessDeliveryClaim,
): HeadlessClaimedPayload<T> {
  Object.defineProperty(payload, HEADLESS_DELIVERY_CLAIM, {
    configurable: false,
    enumerable: false,
    value: claim,
    writable: false,
  });
  return payload;
}

export interface ConfigOptionChangeOutcome {
  acknowledged: boolean;
  authoritative: boolean;
  effective?: ConfigOption;
  reason?: "blocked" | "superseded" | "unacknowledged" | "queue_timeout";
  message?: string;
  /** Monotonic state revision associated with configOptions. */
  revision: number;
  /** Stable state snapshot at the mutation's linearization point. */
  configOptions: ConfigOption[];
}

function sanitizeElicitationSchema(schema: ElicitationSchema): ElicitationSchema {
  const sanitized = structuredClone(schema) as ElicitationSchema & { _meta?: unknown };
  delete sanitized._meta;
  for (const property of Object.values(sanitized.properties ?? {})) {
    delete (property as { _meta?: unknown })._meta;
    if ("oneOf" in property && Array.isArray(property.oneOf)) {
      for (const option of property.oneOf) delete (option as { _meta?: unknown })._meta;
    }
    if ("items" in property && property.items && typeof property.items === "object") {
      delete (property.items as { _meta?: unknown })._meta;
      if ("anyOf" in property.items && Array.isArray(property.items.anyOf)) {
        for (const option of property.items.anyOf) delete (option as { _meta?: unknown })._meta;
      }
    }
  }
  return sanitized;
}

function codexSensitiveFields(request: FormElicitationRequest): string[] {
  return Object.entries(request.requestedSchema.properties ?? {})
    .filter(([, property]) => {
      const meta = property._meta as Record<string, unknown> | null | undefined;
      const codex = meta?.codex;
      return typeof codex === "object" && codex !== null && (codex as { isSecret?: unknown }).isSecret === true;
    })
    .map(([fieldId]) => fieldId);
}

function codexAutoResolutionMs(request: FormElicitationRequest): number | undefined {
  const codex = request._meta?.codex;
  const value = typeof codex === "object" && codex !== null
    ? (codex as { autoResolutionMs?: unknown }).autoResolutionMs
    : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function formatPromptError(err: unknown): string {
  const message = extractErrorMessage(err);
  return message ?? "Unknown error";
}

function formatTranscriptionWarning(err: unknown): string {
  return `⚠️ Voice transcription failed; the original audio was kept and will be passed to the agent. ${formatTranscriptionDiagnostic(err)}`;
}

function formatTranscriptionDiagnostic(err: unknown): string {
  const safe = redactNetworkSecrets(formatPromptError(err));
  if (safe.length <= MAX_TRANSCRIPTION_ERROR_LENGTH) return safe;

  const marker = "\n[middle output truncated]\n";
  const available = MAX_TRANSCRIPTION_ERROR_LENGTH - marker.length;
  const headLength = Math.ceil(available * 0.6);
  return `${safe.slice(0, headLength)}${marker}${safe.slice(-(available - headLength))}`;
}

function extractErrorMessage(value: unknown, seen = new WeakSet<object>()): string | null {
  if (typeof value === "string") return normalizeErrorMessage(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null || typeof value !== "object") return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (value instanceof Error) {
    const direct = normalizeErrorMessage(value.message);
    if (direct && !isGenericPromptErrorMessage(direct)) return direct;

    const cause = extractErrorMessage((value as { cause?: unknown }).cause, seen);
    if (cause) return cause;

    return direct ?? normalizeErrorMessage(value.name);
  }

  const record = value as Record<string, unknown>;
  const direct = typeof record.message === "string" ? normalizeErrorMessage(record.message) : null;
  if (direct && !isGenericPromptErrorMessage(direct)) return direct;

  for (const key of ["error", "reason", "details", "detail", "data", "cause"]) {
    const nested = extractErrorMessage(record[key], seen);
    if (nested) return nested;
  }
  // "message" is already captured in `direct` above; use it as last resort before JSON fallback.
  if (direct) return direct;

  try {
    const json = JSON.stringify(value);
    const jsonMessage = json ? normalizeErrorMessage(json) : null;
    if (jsonMessage && jsonMessage !== "{}") return jsonMessage;
  } catch {
    // Fall through to a stable fallback below.
  }

  const name = (value as { constructor?: { name?: string } }).constructor?.name;
  return name && name !== "Object" ? name : null;
}

function normalizeErrorMessage(message: string | undefined): string | null {
  const trimmed = message?.trim();
  if (!trimmed || trimmed === "[object Object]" || trimmed === "undefined" || trimmed === "null") {
    return null;
  }
  return trimmed;
}

// JSON-RPC -32603 surfaces "Internal error" as its top-level message, which is not
// meaningful to users. Skip it and look for a more specific cause in nested fields.
function isGenericPromptErrorMessage(message: string): boolean {
  return message === "Internal error";
}

// TTS injection pattern: we append TTS_PROMPT_INSTRUCTION to the user's prompt so the
// agent includes a [TTS]...[/TTS] block in its response. After the response completes,
// we extract that block via TTS_BLOCK_REGEX and synthesize speech from it. The TTS block
// is then stripped from the text shown to the user (via tts_strip event).
export const TTS_PROMPT_INSTRUCTION = `\n\nAdditionally, include a [TTS]...[/TTS] block with a spoken-friendly summary of your response. Focus on key information, decisions the user needs to make, or actions required. The agent decides what to say and how long. Respond in the same language the user is using. This instruction applies to this message only.`;
export const TTS_BLOCK_REGEX = /\[TTS\]([\s\S]*?)\[\/TTS\]/;
export const TTS_MAX_LENGTH = 5000;
export const TTS_TIMEOUT_MS = 30_000;

const AGENT_CANCEL_TIMEOUT_MS = 5_000;
const QUEUE_TEARDOWN_TIMEOUT_MS = 1_000;
const OPERATION_TIMEOUT = Symbol('operation-timeout');

type ObservedOperation =
  | { ok: true }
  | { ok: false; error: unknown };

async function waitForObservedOperation(
  operation: Promise<ObservedOperation>,
  timeoutMs: number,
): Promise<ObservedOperation | typeof OPERATION_TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof OPERATION_TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(OPERATION_TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function observeOperation(operation: Promise<unknown>): Promise<ObservedOperation> {
  return operation.then(
    () => ({ ok: true } as const),
    (error: unknown) => ({ ok: false, error } as const),
  );
}

/** Raised when an async agent replacement crosses the terminal session boundary. */
export class SessionTerminatingError extends Error {
  readonly code = 'SESSION_TERMINATING';

  constructor(sessionId: string) {
    super(`Session ${sessionId} is terminating`);
    this.name = 'SessionTerminatingError';
  }
}

/** Raised when agent:beforePrompt middleware rejects a prompt before queue admission. */
export class PromptBlockedError extends Error {
  readonly code = 'MESSAGE_BLOCKED';

  constructor() {
    super('Message was blocked by ingress policy');
    this.name = 'PromptBlockedError';
  }
}

/** One prompt-local admission result. Rollback is idempotent and only releases a newly acquired slot. */
export interface PromptAdmission {
  commit(): void;
  rollback(): void;
}

/** Manager-provided guard used before an errored live session can accept or start more work. */
export type PromptAdmissionGuard = () => Promise<PromptAdmission>;

interface AutoNameAttempt {
  token: number;
  nameRevision: number;
  nameSource: SessionNameSource | undefined;
  name: string | undefined;
  agentInstance: AgentInstance;
  agentGeneration: number;
  agentOwnershipEpoch: number;
}

// Session state machine — valid transitions: from → Set<to>
//
//   initializing → active (first prompt received)
//                → error  (agent spawn failed)
//   active       → error     (unrecoverable prompt failure)
//                → finished  (agent signaled session_end)
//                → cancelled (user cancelled the session)
//   error        → active    (retry: user sends a new prompt)
//                → cancelled (user gives up)
//   cancelled    → (terminal — no further transitions)
//   finished     → (terminal — no further transitions)
const VALID_TRANSITIONS: Record<SessionStatus, Set<SessionStatus>> = {
  initializing: new Set(["active", "error", "cancelled"]),
  active: new Set(["error", "finished", "cancelled"]),
  error: new Set(["active", "cancelled"]),
  cancelled: new Set(),
  finished: new Set(),
};

/** Events emitted by a Session instance — SessionBridge subscribes to relay them to adapters. */
export interface SessionEvents {
  agent_event: (event: AgentEvent) => void;
  permission_request: (request: PermissionRequest) => void;
  elicitation_request: (request: ElicitationRequest) => void;
  elicitation_resolved: (event: ElicitationResolvedEvent) => void;
  session_end: (reason: string) => void;
  status_change: (from: SessionStatus, to: SessionStatus) => void;
  named: (name: string) => void;
  error: (error: Error) => void;
  prompt_count_changed: (count: number) => void;
  turn_started: (ctx: TurnContext) => void;
  /** Fired synchronously when a prompt is placed behind a running prompt in the queue. */
  prompt_queued: (data: { turnId: string | undefined; position: number; routing: TurnRouting | undefined }) => void;
}

/**
 * Manages a single conversation between a user and an AI agent.
 *
 * Wraps an AgentInstance with serial prompt queuing (via PromptQueue), permission
 * gating (via PermissionGate), TTS/STT integration, auto-naming, and a state
 * machine tracking the session lifecycle. SessionBridge subscribes to this
 * emitter to forward agent output to channel adapters.
 *
 * A session can be attached to multiple adapters simultaneously (e.g., Telegram
 * and SSE). The `threadIds` map tracks which thread each adapter uses.
 */
export class Session extends TypedEmitter<SessionEvents> {
  id: string;
  channelId: string;
  /** @deprecated Use threadIds map directly. Getter returns primary adapter's threadId. */
  get threadId(): string {
    return this.threadIds.get(this.channelId) ?? "";
  }
  set threadId(value: string) {
    if (value) {
      this.threadIds.set(this.channelId, value);
    }
  }
  agentName: string;
  workingDirectory: string;
  private _agentInstance!: AgentInstance;
  get agentInstance(): AgentInstance { return this._agentInstance; }
  private _agentGeneration = 0;
  private _configMutationTail: Promise<void> = Promise.resolve();
  private _configMutationEpoch = 0;
  private _configMutationPaused = false;
  private _configRevision = 0;
  private _resolveConfigMutationInvalidation: () => void = () => {};
  private _configMutationInvalidation: Promise<void> = new Promise((resolve) => {
    this._resolveConfigMutationInvalidation = resolve;
  });
  private _headlessPermissionHandler?: NonNullable<AgentInstance["onPermissionRequest"]>;
  private _agentOwnershipEpoch = 0;
  /** Monotonic identity for async continuations crossing an agent replacement. */
  get agentGeneration(): number { return this._agentGeneration; }
  /** Monotonic identity for durable config snapshots. */
  get configRevision(): number { return this._configRevision; }
  /** Setting agentInstance wires the agent→session event relay and commands buffer.
   *  This happens both at construction and on agent switch (switchAgent). */
  set agentInstance(agent: AgentInstance) {
    this.invalidateConfigMutations(false);
    this.invalidateAutoNaming();
    this._agentOwnershipEpoch += 1;
    this._agentInstance = agent;
    this._agentGeneration += 1;
    this.wireAgentRelay();
    this.wireCommandsBuffer();
    this.wireElicitationHandler();
    if (this._connectedBridgeIds.size === 0 && this._headlessPermissionHandler) {
      this._agentInstance.onPermissionRequest = this._headlessPermissionHandler;
    }
  }
  agentSessionId: string = "";
  private _status: SessionStatus = "initializing";
  name?: string;
  private _nameSource: SessionNameSource | undefined;
  private _nameRevision = 0;
  private _autoNameAttemptToken = 0;
  private _autoNameOperation: Promise<void> | null = null;
  createdAt: Date = new Date();
  voiceMode: "off" | "next" | "on" = "off";
  configOptions: ConfigOption[] = [];
  clientOverrides: { bypassPermissions?: boolean } = {};
  agentCapabilities?: AgentCapabilities;
  archiving: boolean = false;
  promptCount: number = 0;
  firstAgent: string;
  agentSwitchHistory: AgentSwitchEntry[] = [];
  isAssistant: boolean = false;
  log: Logger;
  middlewareChain?: MiddlewareChain;
  /** Latest commands emitted by the agent — buffered before bridge connects so they're not lost */
  latestCommands: AgentCommand[] | null = null;
  /** Adapters currently attached to this session (including primary) */
  attachedAdapters: string[] = [];
  /** Per-adapter thread IDs: adapterId → threadId */
  threadIds: Map<string, string> = new Map();
  /** Active turn context — sealed on prompt dequeue, cleared on turn end */
  activeTurnContext: TurnContext | null = null;

  readonly permissionGate = new PermissionGate();
  readonly elicitationGate = new ElicitationGate((event) => {
    this.emit(SessionEv.ELICITATION_RESOLVED, event);
  });
  private readonly queue: PromptQueue;
  private speechService?: SpeechService;
  private pendingContext: string | null = null;
  /** Per-turn abort tracking — avoids race when next turn resets before current turn reads */
  private _abortedTurnIds = new Set<string>();
  private _activePromptPhase: 'preprocessing' | 'agent' | null = null;
  /** Last completed turnId — used by abortPrompt() to retroactively mark a just-finished turn as interrupted */
  private _lastCompletedTurnId: string | null = null;
  /** Idempotent teardown checkpoints allow cleanup retry after a partial failure. */
  private _closedLogger = false;
  private _destroyOperation: Promise<void> | null = null;
  private _lifecycleState: 'live' | 'terminating' | 'destroyed' = 'live';
  private _notifyTermination!: () => void;
  private readonly _terminationRequested = new Promise<void>((resolve) => {
    this._notifyTermination = resolve;
  });
  private readonly _agentDestroyOps = new WeakMap<AgentInstance, Promise<void>>();
  private readonly _agentCancellationOps = new WeakMap<AgentInstance, {
    generation: number;
    operation: Promise<ObservedOperation>;
  }>();
  private _queueCloseOperation: Promise<ObservedOperation> | null = null;
  private _promptAdmissionGuard?: PromptAdmissionGuard;
  /** Bridges connected before a terminal event are the final-delivery recipients. */
  private readonly _connectedBridgeIds = new Set<string>();
  private _headlessDeliveryEpoch = 0;
  private _nextHeadlessDeliveryClaimId = 1;
  private readonly _activeHeadlessDeliveryClaims = new Map<number, HeadlessDeliveryClaim>();
  private _nextTerminalDeliveryGeneration = 1;
  private _terminalDelivery: {
    generation: number;
    recipients: Set<string>;
    claimed: Set<string>;
    completed: Set<string>;
    eventPublished: boolean;
    notificationSent: boolean;
    aborted: boolean;
    durability: Promise<void> | null;
    deadlineAt: number;
    failure: string | null;
    completion: Promise<void>;
    resolveCompletion: () => void;
  } | null = null;

  private _autoApprovedCommands: string[] = []

  get autoApprovedCommands(): string[] {
    return this._autoApprovedCommands
  }

  /** True from the synchronous start of destroy(); replacement work must stop. */
  get isTerminating(): boolean {
    return this._lifecycleState !== 'live';
  }

  /** Install the lifecycle owner's atomic capacity guard. */
  setPromptAdmissionGuard(guard: PromptAdmissionGuard): void {
    this._promptAdmissionGuard = guard;
  }

  /**
   * Cross the monotonic terminal boundary synchronously, before cancellation does
   * any durable I/O. This does not itself cancel prompts or destroy resources.
   */
  beginTermination(): void {
    if (this._lifecycleState !== 'live') return;
    this._lifecycleState = 'terminating';
    this.invalidateAutoNaming();
    this._agentOwnershipEpoch += 1;
    this.invalidateConfigMutations(true);
    this.elicitationGate.cancelAll("session_end");
    this._notifyTermination();
  }

  constructor(opts: {
    id?: string;
    channelId: string;
    agentName: string;
    workingDirectory: string;
    agentInstance: AgentInstance;
    speechService?: SpeechService;
    isAssistant?: boolean;
    autoApprovedCommands?: string[];
  }) {
    super();
    this.id = opts.id || nanoid(12);
    this.channelId = opts.channelId;
    this.attachedAdapters = [opts.channelId];
    this.agentName = opts.agentName;
    this.firstAgent = opts.agentName;
    this.workingDirectory = opts.workingDirectory;
    this.agentInstance = opts.agentInstance;
    this.speechService = opts.speechService;
    this.isAssistant = opts.isAssistant ?? false;
    this._autoApprovedCommands = opts.autoApprovedCommands ?? [];
    this.log = createSessionLogger(this.id, moduleLog);
    this.log.info({ agentName: this.agentName }, "Session created");

    this.queue = new PromptQueue(
      (text, userPrompt, attachments, routing, turnId, meta, signal) => this.processPrompt(text, userPrompt, attachments, routing, turnId, meta, signal),
      (err) => {
        this.log.error({ err }, "Prompt execution failed");
        const message = formatPromptError(err);
        this.fail(message);
        this.emit(SessionEv.AGENT_EVENT, { type: "error", message: `Prompt execution failed: ${message}` });
      },
      (turnId, position, routing) => {
        this.emit(SessionEv.PROMPT_QUEUED, { turnId, position, routing });
      },
    );

  }

  /** Wire the agent→session event relay on the current agentInstance.
   *  Removes any previous relay first to avoid duplicates on agent switch.
   *  This relay ensures session.emit("agent_event") fires for ALL sessions,
   *  including headless API sessions that have no SessionBridge attached. */
  private agentRelayCleanup?: () => void;
  private wireAgentRelay(): void {
    this.agentRelayCleanup?.();
    const instance = this._agentInstance;
    const handler = (event: AgentEvent) => {
      this.emit(SessionEv.AGENT_EVENT, event);
    };
    instance.on(SessionEv.AGENT_EVENT, handler);
    this.agentRelayCleanup = () => instance.off(SessionEv.AGENT_EVENT, handler);
  }

  private wireElicitationHandler(): void {
    const instance = this._agentInstance;
    const generation = this.agentGeneration;
    const ownershipEpoch = this._agentOwnershipEpoch;
    instance.onElicitationRequest = (request) => {
      if (
        this.isTerminating
        || this.agentInstance !== instance
        || this.agentGeneration !== generation
        || this._agentOwnershipEpoch !== ownershipEpoch
        || request.mode !== "form"
        || !("sessionId" in request)
        || !("requestedSchema" in request)
        || typeof request.requestedSchema !== "object"
        || request.requestedSchema === null
      ) return Promise.resolve({ action: "cancel" });
      return this.requestElicitation(
        request as FormElicitationRequest,
        instance,
        generation,
        ownershipEpoch,
      );
    };
  }

  private async requestElicitation(
    request: FormElicitationRequest,
    instance: AgentInstance,
    generation: number,
    ownershipEpoch: number,
  ): Promise<CreateElicitationResponse> {
    if (
      this.isTerminating
      || this.agentInstance !== instance
      || this.agentGeneration !== generation
      || this._agentOwnershipEpoch !== ownershipEpoch
    ) return { action: "cancel" };
    const turn = this.activeTurnContext;
    const targetAdapterId = turn ? getEffectiveTarget(turn) ?? undefined : this.channelId;
    const channelUser = turn?.meta?.channelUser;
    const principal = turn?.meta?.principal;
    const identity = turn?.meta?.identity;
    const sourceAdapterId = typeof channelUser === "object" && channelUser !== null
      && typeof (channelUser as { channelId?: unknown }).channelId === "string"
      ? (channelUser as { channelId: string }).channelId
      : turn?.sourceAdapterId ?? this.channelId;
    const owner = {
      adapterId: sourceAdapterId,
      userId: typeof channelUser === "object" && channelUser !== null
        && typeof (channelUser as { userId?: unknown }).userId === "string"
        ? (channelUser as { userId: string }).userId
        : undefined,
      canonicalUserId: typeof principal === "object" && principal !== null
        && (principal as { type?: unknown }).type === "api"
        && typeof (principal as { linkedUserId?: unknown }).linkedUserId === "string"
        ? (principal as { linkedUserId: string }).linkedUserId
        : typeof identity === "object" && identity !== null
          && typeof (identity as { userId?: unknown }).userId === "string"
          ? (identity as { userId: string }).userId
          : undefined,
      conversationId: sourceAdapterId ? this.threadIds.get(sourceAdapterId) : undefined,
      apiCredential: typeof principal === "object" && principal !== null
        && (principal as { type?: unknown }).type === "api"
        ? (principal as { credential?: "secret" | "jwt" }).credential
        : undefined,
      apiTokenId: typeof principal === "object" && principal !== null
        && (principal as { type?: unknown }).type === "api"
        && typeof (principal as { tokenId?: unknown }).tokenId === "string"
        ? (principal as { tokenId: string }).tokenId
        : undefined,
    };
    const requestId = nanoid(12);
    const sensitiveFields = codexSensitiveFields(request);
    try {
      if (
        this.isTerminating
        || this.agentInstance !== instance
        || this.agentGeneration !== generation
        || this._agentOwnershipEpoch !== ownershipEpoch
      ) return { action: "cancel" };
      const response = this.elicitationGate.request({
        id: requestId,
        sessionId: this.id,
        turnId: turn?.turnId,
        targetAdapterId,
        toolCallId: request.toolCallId ?? undefined,
        mode: "form",
        message: request.message,
        requestedSchema: sanitizeElicitationSchema(request.requestedSchema),
        owner,
        sensitiveFields: sensitiveFields.length > 0 ? sensitiveFields : undefined,
        timeoutMs: codexAutoResolutionMs(request),
      });
      const pending = this.elicitationGate.get(requestId);
      if (!pending) return { action: "cancel" };
      this.emit(SessionEv.ELICITATION_REQUEST, pending);
      return await response;
    } catch (error) {
      this.log.warn(
        { requestId, error: error instanceof Error ? error.message : String(error) },
        "ACP form input request was rejected",
      );
      this.emit(SessionEv.AGENT_EVENT, {
        type: "system_message",
        message: "The agent requested input that OpenACP could not present safely. The request was cancelled.",
      });
      return { action: "cancel" };
    }
  }

  /** Wire a listener on the current agentInstance to buffer commands_update events.
   *  Must be called after every agentInstance replacement (constructor + switchAgent). */
  private commandsBufferCleanup?: () => void;
  private wireCommandsBuffer(): void {
    // Remove previous listener (if switching agents) to avoid leaks
    this.commandsBufferCleanup?.();
    const instance = this._agentInstance;
    const handler = (event: AgentEvent) => {
      if (event.type === "commands_update") {
        this.latestCommands = event.commands;
      }
    };
    instance.on(SessionEv.AGENT_EVENT, handler);
    this.commandsBufferCleanup = () => instance.off(SessionEv.AGENT_EVENT, handler);
  }

  // --- State Machine ---

  get status(): SessionStatus {
    return this._status;
  }


  /** Transition to active — from initializing, error, or cancelled */
  activate(): boolean {
    if (this.isTerminating || this._status === "cancelled") return false;
    this.transition("active");
    return true;
  }

  /** Transition to error — from initializing or active. Idempotent if already in error. */
  fail(reason: string): boolean {
    if (this.isTerminating || this._status === "error") return false;
    this.transition("error");
    this.emit(SessionEv.ERROR, new Error(reason));
    return true;
  }

  /** Transition to finished — from active only. Emits session_end for backward compat. */
  finish(reason?: string): boolean {
    // Cancellation/destroy owns the lifecycle once beginTermination() fires.
    // Delayed middleware or agent events must not race it to another terminal state.
    if (this.isTerminating) return false;
    this.elicitationGate.cancelAll("session_end");
    this.transition("finished");
    this.emit(SessionEv.SESSION_END, reason ?? "completed");
    return true;
  }

  /** Track bridge membership so a terminal event can snapshot exact recipients. */
  registerBridge(adapterId: string): void {
    if (this._status === "finished" || this.isTerminating) return;
    if (this._connectedBridgeIds.size === 0) this._headlessDeliveryEpoch += 1;
    this._connectedBridgeIds.add(adapterId);
  }

  unregisterBridge(adapterId: string): void {
    const removed = this._connectedBridgeIds.delete(adapterId);
    if (removed && this._connectedBridgeIds.size === 0) this._headlessDeliveryEpoch += 1;
    if (this._connectedBridgeIds.size === 0 && this._headlessPermissionHandler && !this.isTerminating) {
      this.agentInstance.onPermissionRequest = this._headlessPermissionHandler;
    }
    const delivery = this._terminalDelivery;
    if (!delivery?.recipients.has(adapterId)) return;
    this.completeTerminalDelivery(adapterId, delivery.generation);
  }

  get hasConnectedBridges(): boolean {
    return this._connectedBridgeIds.size > 0;
  }

  /** Claim one event synchronously before the first bridge ownership cutover. */
  claimHeadlessDelivery(kind: string): HeadlessDeliveryClaim | null {
    if (this.hasConnectedBridges || this.isTerminating) return null;
    const claim: HeadlessDeliveryClaim = Object.freeze({
      sessionId: this.id,
      id: this._nextHeadlessDeliveryClaimId++,
      epoch: this._headlessDeliveryEpoch,
      kind,
    });
    this._activeHeadlessDeliveryClaims.set(claim.id, claim);
    return claim;
  }

  isHeadlessDeliveryClaimActive(claim: HeadlessDeliveryClaim | undefined): boolean {
    if (!claim || claim.sessionId !== this.id) return false;
    return this._activeHeadlessDeliveryClaims.get(claim.id) === claim;
  }

  releaseHeadlessDelivery(claim: HeadlessDeliveryClaim): void {
    if (this._activeHeadlessDeliveryClaims.get(claim.id) === claim) {
      this._activeHeadlessDeliveryClaims.delete(claim.id);
    }
  }

  hasActiveHeadlessDelivery(kind: string): boolean {
    for (const claim of this._activeHeadlessDeliveryClaims.values()) {
      if (claim.kind === kind) return true;
    }
    return false;
  }

  /** Preserve headless permission ownership across attach/detach and agent replacement. */
  setHeadlessPermissionHandler(handler: NonNullable<AgentInstance["onPermissionRequest"]>): void {
    this._headlessPermissionHandler = handler;
    if (!this.hasConnectedBridges) this.agentInstance.onPermissionRequest = handler;
  }

  /**
   * Establish a single terminal winner and snapshot all bridges that must receive
   * the completion event. Later bridge handlers join the same generation.
   */
  beginTerminalDelivery(reason?: string): number | null {
    if (this._terminalDelivery) return this._terminalDelivery.generation;
    if (this.isTerminating || this._status !== "active") return null;

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const delivery = {
      generation: this._nextTerminalDeliveryGeneration++,
      recipients: new Set(this._connectedBridgeIds),
      claimed: new Set<string>(),
      completed: new Set<string>(),
      eventPublished: false,
      notificationSent: false,
      aborted: false,
      durability: null,
      deadlineAt: Date.now() + 5_000,
      failure: null,
      completion,
      resolveCompletion,
    };
    this._terminalDelivery = delivery;
    try {
      if (!this.finish(reason)) {
        this._terminalDelivery = null;
        resolveCompletion();
        return null;
      }
    } catch (error) {
      this._terminalDelivery = null;
      resolveCompletion();
      throw error;
    }
    if (delivery.recipients.size === 0) resolveCompletion();
    return delivery.generation;
  }

  claimTerminalDelivery(adapterId: string, generation: number): boolean {
    const delivery = this._terminalDelivery;
    if (
      !delivery ||
      delivery.aborted ||
      delivery.generation !== generation ||
      !delivery.recipients.has(adapterId) ||
      delivery.claimed.has(adapterId)
    ) return false;
    delivery.claimed.add(adapterId);
    return true;
  }

  /** Allow an explicit retry when terminal durability failed before delivery. */
  releaseTerminalDeliveryClaim(adapterId: string, generation: number): void {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.generation !== generation || delivery.completed.has(adapterId)) return;
    delivery.claimed.delete(adapterId);
  }

  /** Every bridge awaits the same terminal persistence transaction. */
  ensureTerminalDurability(
    generation: number,
    persist: () => Promise<void>,
  ): Promise<void> {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.generation !== generation || delivery.aborted) {
      return Promise.reject(new SessionTerminatingError(this.id));
    }
    delivery.durability ??= Promise.resolve().then(persist);
    return delivery.durability;
  }

  terminalDeliveryDeadline(generation: number): number | null {
    const delivery = this._terminalDelivery;
    return delivery && delivery.generation === generation && !delivery.aborted
      ? delivery.deadlineAt
      : null;
  }

  /** Abort an undeliverable generation and release every waiter exactly once. */
  abortTerminalDelivery(generation: number): boolean {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.generation !== generation || delivery.aborted) return false;
    delivery.aborted = true;
    delivery.claimed.clear();
    delivery.completed = new Set(delivery.recipients);
    delivery.resolveCompletion();
    return true;
  }

  markTerminalDeliveryFailed(generation: number, reason: string): void {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.generation !== generation || delivery.failure) return;
    delivery.failure = reason;
  }

  get terminalDeliveryFailure(): string | null {
    return this._terminalDelivery?.failure ?? null;
  }

  isTerminalDeliveryRecipient(adapterId: string, generation?: number): boolean {
    const delivery = this._terminalDelivery;
    return Boolean(
      delivery &&
      !delivery.aborted &&
      (generation === undefined || delivery.generation === generation) &&
      delivery.recipients.has(adapterId) &&
      !delivery.completed.has(adapterId),
    );
  }

  claimTerminalEventPublication(generation: number): boolean {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.aborted || delivery.generation !== generation || delivery.eventPublished) return false;
    delivery.eventPublished = true;
    return true;
  }

  claimTerminalNotification(generation: number): boolean {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.aborted || delivery.generation !== generation || delivery.notificationSent) return false;
    delivery.notificationSent = true;
    return true;
  }

  /** Return true only for the bridge that completes the delivery barrier. */
  completeTerminalDelivery(adapterId: string, generation: number): boolean {
    const delivery = this._terminalDelivery;
    if (!delivery || delivery.aborted || delivery.generation !== generation || !delivery.recipients.has(adapterId)) {
      return false;
    }
    delivery.completed.add(adapterId);
    if (delivery.completed.size !== delivery.recipients.size) return false;
    delivery.resolveCompletion();
    return true;
  }

  get hasTerminalDelivery(): boolean {
    return this._terminalDelivery !== null;
  }

  waitForTerminalDelivery(): Promise<void> | null {
    return this._terminalDelivery?.completion ?? null;
  }

  /** Transition to cancelled — from initializing, active, or error. */
  markCancelled(): void {
    this.elicitationGate.cancelAll("session_end");
    this.transition("cancelled");
  }

  private transition(to: SessionStatus): void {
    const from = this._status;
    const allowed = VALID_TRANSITIONS[from];
    if (!allowed?.has(to)) {
      throw new Error(
        `Invalid session transition: ${from} → ${to}`,
      );
    }
    this._status = to;
    this.log.debug({ from, to }, "Session status transition");
    this.emit(SessionEv.STATUS_CHANGE, from, to);
  }

  /** Number of prompts waiting in queue */
  get queueDepth(): number {
    return this.queue.pending;
  }

  /** Whether a prompt is currently being processed by the agent */
  get promptRunning(): boolean {
    return this.queue.isProcessing;
  }

  /** Snapshot of queued (not yet processing) items — for inspection by API consumers. */
  get queueItems() {
    return this.queue.pendingItems;
  }

  // --- Context Injection ---

  /** Store context markdown to be prepended to the next prompt (used for session resume with history). */
  setContext(markdown: string): void {
    this.pendingContext = markdown;
  }

  // --- Voice Mode ---

  /** Set TTS mode: "off" = disabled, "next" = one-shot (auto-resets after prompt), "on" = persistent. */
  setVoiceMode(mode: "off" | "next" | "on"): void {
    this.voiceMode = mode;
    this.log.info({ voiceMode: mode }, "TTS mode changed");
  }

  // --- Public API ---

  /**
   * Enqueue a user prompt for serial processing.
   *
   * Runs the prompt through agent:beforePrompt middleware (which can modify or block),
   * then adds it to the PromptQueue. Returns a turnId that callers can use to correlate
   * queued/processing events before the prompt actually runs.
   */
  private async submitPrompt(
    text: string,
    attachments?: Attachment[],
    routing?: TurnRouting,
    externalTurnId?: string,
    meta?: TurnMeta,
    onAccepting?: (turnId: string) => void,
  ): Promise<{ turnId: string; completion: Promise<void> }> {
    const currentStatus = this._status as SessionStatus;
    if (this.isTerminating || currentStatus === "finished" || currentStatus === "cancelled") {
      throw new SessionTerminatingError(this.id);
    }
    // Use pre-generated turnId if provided (so callers can emit events before awaiting the queue)
    const turnId = externalTurnId ?? nanoid(8);
    const turnMeta: TurnMeta = meta ?? { turnId };
    // Capture raw user prompt before middleware can modify it
    const userPrompt = text;
    // Hook: agent:beforePrompt — modifiable, can block
    if (this.middlewareChain) {
      const payload = { text, attachments, sessionId: this.id, sourceAdapterId: routing?.sourceAdapterId, meta: turnMeta };
      const result = await this.middlewareChain.execute(Hook.AGENT_BEFORE_PROMPT, payload, async (p) => p);
      if (!result) throw new PromptBlockedError();
      text = result.text;
      attachments = result.attachments;
    }
    // Middleware awaited above, so re-check the monotonic lifecycle boundary
    // immediately before the synchronous queue admission.
    if (this.isTerminating || this._status === "finished" || this._status === "cancelled") {
      throw new SessionTerminatingError(this.id);
    }
    const admission = this._promptAdmissionGuard
      ? await this._promptAdmissionGuard()
      : undefined;
    const postAdmissionStatus = this._status as SessionStatus;
    if (this.isTerminating || postAdmissionStatus === "finished" || postAdmissionStatus === "cancelled") {
      admission?.rollback();
      throw new SessionTerminatingError(this.id);
    }
    try {
      onAccepting?.(turnId);
      const completion = this.queue.submit(text, userPrompt, attachments, routing, turnId, turnMeta);
      admission?.commit();
      return { turnId, completion };
    } catch (error) {
      admission?.rollback();
      throw error;
    }
  }

  async enqueuePrompt(text: string, attachments?: Attachment[], routing?: TurnRouting, externalTurnId?: string, meta?: TurnMeta): Promise<string> {
    const accepted = await this.submitPrompt(text, attachments, routing, externalTurnId, meta);
    await accepted.completion;
    return accepted.turnId;
  }

  /**
   * Admit a prompt and return after middleware and queue acceptance, without
   * waiting for the agent turn to finish. Used by REST/SSE request handlers.
   */
  async acceptPrompt(
    text: string,
    attachments?: Attachment[],
    routing?: TurnRouting,
    externalTurnId?: string,
    meta?: TurnMeta,
    onAccepting?: (turnId: string) => void,
  ): Promise<string> {
    const accepted = await this.submitPrompt(
      text,
      attachments,
      routing,
      externalTurnId,
      meta,
      onAccepting,
    );
    // PromptQueue observes processor failures internally. Keep this explicit so
    // future queue implementations cannot create an unhandled completion.
    void accepted.completion.catch(() => {});
    return accepted.turnId;
  }

  private async processPrompt(text: string, userPrompt: string, attachments?: Attachment[], routing?: TurnRouting, turnId?: string, meta?: TurnMeta, signal?: AbortSignal): Promise<void> {
    // Terminal sessions may still have queued callbacks, but cannot start work.
    if (this.isTerminating || this._status === "finished" || this._status === "cancelled") return;

    // A previous queued turn may have failed after later prompts were accepted.
    // Reacquire capacity before publishing turn-start or returning to active.
    let reactivationAdmission: PromptAdmission | undefined;
    if (this._status === "error" && this._promptAdmissionGuard) {
      reactivationAdmission = await this._promptAdmissionGuard();
      const postAdmissionStatus = this._status as SessionStatus;
      if (this.isTerminating || postAdmissionStatus === "finished" || postAdmissionStatus === "cancelled") {
        reactivationAdmission?.rollback();
        return;
      }
    }

    if (this._status === "initializing" || this._status === "error") {
      if (!this.activate()) {
        reactivationAdmission?.rollback();
        return;
      }
    }
    reactivationAdmission?.commit();

    // Seal turn context — bridges use this to decide routing for every emitted event
    // Pass the pre-generated turnId so message:queued and message:processing share the same ID
    this.activeTurnContext = createTurnContext(
      routing?.sourceAdapterId ?? this.channelId,
      routing?.responseAdapterId,
      turnId,
      userPrompt,
      text,      // finalPrompt (after middleware transformations)
      attachments,
      meta,
    );

    // Emit turn_started so SessionBridge can emit message:processing on EventBus
    this.emit(SessionEv.TURN_STARTED, this.activeTurnContext);

    this.promptCount++;
    this.emit(SessionEv.PROMPT_COUNT_CHANGED, this.promptCount);

    const promptStart = Date.now();
    this.log.debug("Prompt execution started");

    // Context injection: prepend on first real prompt only
    const contextUsed = this.pendingContext;
    if (contextUsed) {
      text = `[CONVERSATION HISTORY - This is context from previous sessions, not current conversation]\n\n${contextUsed}\n\n[END CONVERSATION HISTORY]\n\n${text}`;
      this.log.debug("Context injected into prompt");
    }

    // Hook: turn:start covers local preprocessing as part of the turn lifecycle.
    if (this.middlewareChain) {
      this.middlewareChain.execute(Hook.TURN_START, {
        sessionId: this.id,
        promptText: text,
        promptNumber: this.promptCount,
        turnId: this.activeTurnContext?.turnId ?? turnId ?? '',
        meta,
        userPrompt: this.activeTurnContext?.userPrompt,
        sourceAdapterId: this.activeTurnContext?.sourceAdapterId,
        responseAdapterId: this.activeTurnContext?.responseAdapterId,
      }, async (payload) => payload).catch((error) => {
        this.log.warn({ err: error, hook: Hook.TURN_START }, "Session hook failed");
      });
    }

    // STT: transcribe audio attachments if agent doesn't support audio
    this._activePromptPhase = 'preprocessing';
    let processed: { text: string; attachments?: Attachment[] };
    try {
      processed = await this.maybeTranscribeAudio(text, attachments, signal);
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted) {
        const interruptedTurnId = this.activeTurnContext?.turnId ?? turnId ?? '';
        this.elicitationGate.cancelTurn(interruptedTurnId);
        this._abortedTurnIds.delete(interruptedTurnId);
        if (this.middlewareChain) {
          this.middlewareChain.execute(Hook.TURN_END, {
            sessionId: this.id, stopReason: 'interrupted', durationMs: Date.now() - promptStart,
            turnId: interruptedTurnId, meta,
          }, async (payload) => payload).catch((hookError) => {
            this.log.warn({ err: hookError, hook: Hook.TURN_END }, "Session hook failed");
          });
          this.middlewareChain.execute(Hook.AGENT_AFTER_TURN, {
            sessionId: this.id, turnId: interruptedTurnId, fullText: '', stopReason: 'interrupted', meta,
          }, async (payload) => payload).catch((hookError) => {
            this.log.warn({ err: hookError, hook: Hook.AGENT_AFTER_TURN }, "Session hook failed");
          });
        }
        this._lastCompletedTurnId = interruptedTurnId || null;
        this.activeTurnContext = null;
      }
      this._activePromptPhase = null;
      throw error;
    }

    // TTS: determine if TTS is active for this prompt
    const ttsActive =
      this.voiceMode !== "off" &&
      !!this.speechService?.isTTSAvailable();

    // TTS: inject prompt instruction
    if (ttsActive) {
      processed.text += TTS_PROMPT_INSTRUCTION;
    }

    // TTS: set up text accumulator before prompting
    let accumulatedText = "";
    const accumulatorListener = ttsActive
      ? (event: AgentEvent) => {
          if (event.type === "text") {
            accumulatedText += event.content;
          }
        }
      : null;

    if (accumulatorListener) {
      this.on(SessionEv.AGENT_EVENT, accumulatorListener);
    }

    // Buffer text events for agent:afterTurn hook — accumulates full response text
    const turnTextBuffer: string[] = [];
    const turnTextListener = (event: AgentEvent) => {
      if (event.type === 'text' && typeof (event as any).content === 'string') {
        turnTextBuffer.push((event as any).content);
      }
    };
    this.on(SessionEv.AGENT_EVENT, turnTextListener);

    // Hook: agent:afterEvent — fire for every agent event, including headless API sessions.
    // Listens directly on agentInstance so it works regardless of whether a SessionBridge is connected.
    // The bridge previously fired this hook from dispatchAgentEvent, but that path is skipped when
    // no adapter is attached (headless), causing AI response steps to be missing from history.
    const mw = this.middlewareChain;
    const afterEventListener = mw
      ? (event: AgentEvent) => {
          mw.execute(Hook.AGENT_AFTER_EVENT, { sessionId: this.id, event, outgoingMessage: { type: 'text' as const, text: '' } }, async (e) => e).catch((hookError) => {
            this.log.warn({ err: hookError, hook: Hook.AGENT_AFTER_EVENT }, "Session hook failed");
          });
        }
      : null;

    const turnAgent = this.agentInstance;
    if (afterEventListener) {
      turnAgent.on(SessionEv.AGENT_EVENT, afterEventListener);
    }

    let stopReason: string = 'end_turn';
    let promptError: unknown;
    this._activePromptPhase = 'agent';
    try {
      signal?.throwIfAborted();
      const response = await turnAgent.prompt(processed.text, processed.attachments);
      signal?.throwIfAborted();
      if (response && typeof response === 'object' && 'stopReason' in response) {
        stopReason = (response as { stopReason?: string }).stopReason ?? 'end_turn';
      }
      // Clear context only after successful prompt — if prompt fails, context is preserved for retry
      if (contextUsed) {
        this.pendingContext = null;
      }
      // Reset "next" voice mode only after successful prompt
      if (ttsActive && this.voiceMode === "next") {
        this.voiceMode = "off";
      }
    } catch (err) {
      stopReason = 'error';
      promptError = err;
    } finally {
      if (accumulatorListener) {
        this.off(SessionEv.AGENT_EVENT, accumulatorListener);
      }
      if (afterEventListener) {
        turnAgent.off(SessionEv.AGENT_EVENT, afterEventListener);
      }
      this.off(SessionEv.AGENT_EVENT, turnTextListener);

      const finalTurnId = this.activeTurnContext?.turnId ?? turnId ?? '';
      this.elicitationGate.cancelTurn(finalTurnId);
      const wasExplicitlyAborted = this._abortedTurnIds.has(finalTurnId);
      if (wasExplicitlyAborted) this._abortedTurnIds.delete(finalTurnId);
      const wasAborted = wasExplicitlyAborted || signal?.aborted === true;
      const finalStopReason = wasAborted ? 'interrupted' : stopReason;

      // Hook: turn:end — always fires, even on error
      if (this.middlewareChain) {
        this.middlewareChain.execute(Hook.TURN_END, { sessionId: this.id, stopReason: finalStopReason as import('../types.js').StopReason, durationMs: Date.now() - promptStart, turnId: finalTurnId, meta }, async (p) => p).catch((hookError) => {
          this.log.warn({ err: hookError, hook: Hook.TURN_END }, "Session hook failed");
        });
      }

      // Hook: agent:afterTurn — full assembled text, read-only, fire-and-forget
      if (this.middlewareChain) {
        this.middlewareChain.execute(Hook.AGENT_AFTER_TURN, {
          sessionId: this.id,
          turnId: finalTurnId,
          fullText: turnTextBuffer.join(''),
          stopReason: finalStopReason as import('../types.js').StopReason,
          meta,
        }, async (p) => p).catch((hookError) => {
          this.log.warn({ err: hookError, hook: Hook.AGENT_AFTER_TURN }, "Session hook failed");
        });
      }

      // Track the completed turnId so late abortPrompt() calls can retroactively mark it
      this._lastCompletedTurnId = finalTurnId || null;
      // Always clear turn context so routing state is never stale after a failed turn
      this.activeTurnContext = null;
      this._activePromptPhase = null;
    }

    // Re-throw so PromptQueue error handler can call this.fail()
    if (promptError !== undefined) {
      throw promptError;
    }

    this.log.info(
      { durationMs: Date.now() - promptStart },
      "Prompt execution completed",
    );

    // TTS: fire-and-forget post-response synthesis
    if (ttsActive && accumulatedText) {
      this.processTTSResponse(accumulatedText).catch((err) => {
        this.log.warn({ err }, "TTS post-processing failed");
      });
    }

    // Also trigger auto-naming when name is still an adopted-session placeholder.
    if (!this.name || this._nameSource === "placeholder") {
      this._activePromptPhase = 'agent';
      try {
        await this.autoName(turnAgent);
      } finally {
        this._activePromptPhase = null;
      }
    }
  }

  /**
   * Transcribe audio attachments to text if the agent doesn't support audio natively.
   * Audio attachments are removed and their transcriptions are appended to the prompt text.
   */
  private async maybeTranscribeAudio(
    text: string,
    attachments?: Attachment[],
    signal?: AbortSignal,
  ): Promise<{ text: string; attachments?: Attachment[] }> {
    if (!attachments?.length || !this.speechService) {
      return { text, attachments };
    }

    const hasAudioCapability = this.agentInstance.promptCapabilities?.audio === true;
    if (hasAudioCapability) {
      return { text, attachments };
    }

    if (!this.speechService.isSTTAvailable()) {
      return { text, attachments };
    }

    let transcribedText = text;
    const remainingAttachments: Attachment[] = [];

    for (const att of attachments) {
      signal?.throwIfAborted();
      if (att.type !== "audio") {
        remainingAttachments.push(att);
        continue;
      }

      try {
        const audioPath = att.originalFilePath || att.filePath;
        const audioMime = att.originalFilePath ? "audio/ogg" : att.mimeType;
        const audioBuffer = await fs.promises.readFile(audioPath);
        const result = await this.speechService.transcribe(audioBuffer, audioMime, { signal });
        signal?.throwIfAborted();
        this.log.info({ provider: "stt", duration: result.duration }, "Voice transcribed");
        // Notify user of transcription result
        this.emit(SessionEv.AGENT_EVENT, {
          type: "system_message",
          message: `🎤 You said: ${result.text}`,
        });
        // Strip [Audio: ...] placeholder since we have the transcription
        transcribedText = transcribedText.replace(/\[Audio:\s*[^\]]*\]\s*/g, "").trim();
        transcribedText = transcribedText
          ? `${transcribedText}\n${result.text}`
          : result.text;
      } catch (err) {
        if (signal?.aborted) {
          if (err instanceof Error && err.name === 'AbortError' && err.cause) {
            this.log.warn({ err }, "STT cancellation cleanup failed");
          }
          throw signal.reason;
        }
        this.log.warn({ err: formatTranscriptionDiagnostic(err) }, "STT transcription failed, keeping audio attachment");
        this.emit(SessionEv.AGENT_EVENT, {
          type: "system_message",
          message: formatTranscriptionWarning(err),
        });
        remainingAttachments.push(att);
      }
    }

    return {
      text: transcribedText,
      attachments: remainingAttachments.length > 0 ? remainingAttachments : undefined,
    };
  }

  /** Extract [TTS] block from agent response, synthesize speech, and emit audio_content event. */
  private async processTTSResponse(responseText: string): Promise<void> {
    const match = TTS_BLOCK_REGEX.exec(responseText);
    if (!match?.[1]) {
      this.log.debug("No [TTS] block found in response, skipping synthesis");
      return;
    }

    let ttsText = match[1].trim();
    if (!ttsText) return;

    if (ttsText.length > TTS_MAX_LENGTH) {
      ttsText = ttsText.slice(0, TTS_MAX_LENGTH);
    }

    try {
      let ttsTimer: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        ttsTimer = setTimeout(() => reject(new Error("TTS synthesis timed out")), TTS_TIMEOUT_MS);
      });
      try {
        const result = await Promise.race([
          this.speechService!.synthesize(ttsText),
          timeoutPromise,
        ]);
        const base64 = result.audioBuffer.toString("base64");
        this.emit(SessionEv.AGENT_EVENT, {
          type: "audio_content",
          data: base64,
          mimeType: result.mimeType,
        });
        this.emit(SessionEv.AGENT_EVENT, { type: "tts_strip" });
        this.log.info("TTS synthesis completed");
      } finally {
        clearTimeout(ttsTimer!);
      }
    } catch (err) {
      this.log.warn({ err }, "TTS synthesis failed, skipping");
    }
  }

  // Sends a special prompt to the agent to generate a short session title.
  // The session emitter is paused (excluding non-agent_event emissions) so the naming
  // prompt's output is intercepted by a capture handler instead of being forwarded to adapters.
  private autoName(agentInstance: AgentInstance): Promise<void> {
    if (this._autoNameOperation) return this._autoNameOperation;

    const attempt: AutoNameAttempt = {
      token: ++this._autoNameAttemptToken,
      nameRevision: this._nameRevision,
      nameSource: this._nameSource,
      name: this.name,
      agentInstance,
      agentGeneration: this.agentGeneration,
      agentOwnershipEpoch: this._agentOwnershipEpoch,
    };
    let operation!: Promise<void>;
    operation = this.runAutoName(attempt).finally(() => {
      if (this._autoNameOperation === operation) this._autoNameOperation = null;
    });
    this._autoNameOperation = operation;
    return operation;
  }

  private async runAutoName(attempt: AutoNameAttempt): Promise<void> {
    let title = "";

    // Temporarily remove all agent_event listeners so auto-name output
    // is not forwarded to the adapter. Add a capture-only listener instead.
    const captureHandler = (event: AgentEvent) => {
      if (event.type === "text") title += event.content;
      // Swallow all other events from auto-name prompt
    };

    // Pause the session emitter so agent_event emissions from SessionBridge
    // don't reach the adapter during auto-name. The AgentInstance emitter
    // stays active — we just intercept with our capture handler.
    this.pause((event) => event !== SessionEv.AGENT_EVENT);
    attempt.agentInstance.on(SessionEv.AGENT_EVENT, captureHandler);

    try {
      await attempt.agentInstance.prompt(
        "Summarize this conversation in max 5 words for a topic title. Reply ONLY with the title, nothing else.",
      );
      const name = title || `Session ${this.id.slice(0, 6)}`;
      if (this.commitAutoNameIfCurrent(name, attempt)) {
        this.log.info({ name: this.name }, "Session auto-named");
      }
    } catch (error) {
      if (this.commitAutoNameIfCurrent(`Session ${this.id.slice(0, 6)}`, attempt)) {
        this.log.warn({ err: error, name: this.name }, "Session auto-name failed; using fallback");
      }
    } finally {
      attempt.agentInstance.off(SessionEv.AGENT_EVENT, captureHandler);
      // Discard buffered auto-name agent_events, then resume normal delivery
      this.clearBuffer();
      this.resume();
    }
  }

  private commitAutoNameIfCurrent(name: string, attempt: AutoNameAttempt): boolean {
    if (
      attempt.token !== this._autoNameAttemptToken
      || attempt.nameRevision !== this._nameRevision
      || attempt.nameSource !== this._nameSource
      || attempt.name !== this.name
      || attempt.agentInstance !== this.agentInstance
      || attempt.agentGeneration !== this.agentGeneration
      || attempt.agentOwnershipEpoch !== this._agentOwnershipEpoch
      || (attempt.nameSource !== undefined && attempt.nameSource !== "placeholder")
      || this.isTerminating
      || this._status === "cancelled"
      || this._status === "finished"
    ) return false;

    this.setName(name, "auto");
    return true;
  }

  private invalidateAutoNaming(): void {
    this._autoNameAttemptToken += 1;
  }


  // --- ACP Mode / Config / Model State ---

  setInitialConfigOptions(options: ConfigOption[]): void {
    this.replaceConfigOptions(options ?? []);
  }

  setAgentCapabilities(caps: AgentCapabilities | undefined): void {
    this.agentCapabilities = caps;
  }

  /**
   * Hydrate configOptions and agentCapabilities from a spawn response.
   * Handles both the native configOptions format and legacy modes/models fields.
   */
  applySpawnResponse(resp: { modes?: unknown; configOptions?: unknown; models?: unknown } | undefined, caps: AgentCapabilities | undefined): void {
    if (caps) this.agentCapabilities = caps;
    if (!resp) return;

    if (resp.configOptions) {
      this.replaceConfigOptions(resp.configOptions as ConfigOption[]);
      return;
    }

    // Convert legacy modes/models fields (old ACP format) to configOptions
    const legacyOptions: ConfigOption[] = [];
    if (resp.modes) {
      const m = resp.modes as SessionModeState;
      legacyOptions.push({
        id: 'mode', name: 'Mode', category: 'mode', type: 'select',
        currentValue: m.currentModeId,
        options: m.availableModes.map(x => ({ value: x.id, name: x.name, description: x.description })),
      });
    }
    if (resp.models) {
      const m = resp.models as SessionModelState;
      legacyOptions.push({
        id: 'model', name: 'Model', category: 'model', type: 'select',
        currentValue: m.currentModelId,
        options: m.availableModels.map(x => ({ value: (x as any).modelId ?? x.id, name: x.name, description: x.description })),
      });
    }
    if (legacyOptions.length > 0) this.replaceConfigOptions(legacyOptions);
  }

  getConfigOption(id: string): ConfigOption | undefined {
    return this.configOptions.find(o => o.id === id);
  }

  getConfigByCategory(category: string): ConfigOption | undefined {
    return this.configOptions.find(o => o.category === category);
  }

  getConfigValue(id: string): string | undefined {
    const option = this.getConfigOption(id);
    if (!option) return undefined;
    return String(option.currentValue);
  }

  /** Source of the current name, persisted so a manual rename keeps priority after resume. */
  get nameSource(): SessionNameSource | undefined {
    return this._nameSource;
  }

  /** Initialize a restored or system-provided name without publishing a rename event. */
  initializeName(name: string, source: SessionNameSource = "persisted"): string {
    const normalized = source === "persisted" || source === "manual"
      ? restoreSessionName(name)
      : normalizeSessionName(name, {
        generated: source === "agent" || source === "auto",
      });
    if (!normalized) throw new Error("Session name must contain visible text");
    this.name = normalized;
    this._nameSource = source;
    this._nameRevision += 1;
    return normalized;
  }

  /** Capture ACP title provenance before asynchronous middleware can outlive the turn. */
  captureAgentTitleContext(): AgentTitleContext {
    return captureAgentTitleContext(this.activeTurnContext, this._nameRevision);
  }

  /**
   * Apply a title reported by an ACP agent through the connector-neutral naming policy.
   * Prompt echoes and stale events are ignored; accepted names are normalized once in core.
   */
  applyAgentTitle(name: string, context: AgentTitleContext): AgentTitleDecision {
    if (isPromptEcho(name, context)) return { status: "ignored", reason: "prompt_echo" };
    if (context.turnId !== null && context.nameRevision !== this._nameRevision) {
      return { status: "ignored", reason: "stale" };
    }
    if (this._nameSource === "manual") {
      return { status: "ignored", reason: "manual_priority" };
    }

    const normalized = normalizeSessionName(name, { generated: true });
    if (!normalized) return { status: "ignored", reason: "empty" };
    if (normalized === this.name) return { status: "ignored", reason: "unchanged" };

    this.commitName(normalized, "agent");
    return { status: "accepted", name: normalized };
  }

  /** Set a manual, generated, restored, or system name and publish one normalized rename. */
  setName(name: string, source: SessionNameSource = "manual"): string {
    const normalized = normalizeSessionName(name, {
      generated: source === "agent" || source === "auto",
    });
    if (!normalized) throw new Error("Session name must contain visible text");
    if (normalized === this.name && source === this._nameSource) return normalized;
    this.commitName(normalized, source);
    return normalized;
  }

  private commitName(name: string, source: SessionNameSource): void {
    this.name = name;
    this._nameSource = source;
    this._nameRevision += 1;
    this.emit(SessionEv.NAMED, name);
  }

  /** Send a config option change and report the effective agent-acknowledged state. */
  async setConfigOption(
    configId: string,
    value: SetConfigOptionValue,
  ): Promise<ConfigOptionChangeOutcome> {
    return this.runSerializedConfigMutation(
      () => this.configFailure("superseded", CONFIG_CHANGE_SUPERSEDED, configId),
      () => this.configFailure("queue_timeout", CONFIG_CHANGE_QUEUE_TIMEOUT, configId),
      async ({ agent, generation, epoch, invalidation }) => {
        const oldValue = this.getConfigOption(configId)?.currentValue;
        let requestedValue = value;

        if (this.middlewareChain) {
          const result = await this.middlewareChain.execute(
            Hook.CONFIG_BEFORE_CHANGE,
            {
              sessionId: this.id,
              configId,
              oldValue,
              newValue: value.value,
            },
            async (payload) => payload,
            { onError: 'block' },
          );
          if (!result || typeof result.newValue !== typeof value.value) {
            return this.configFailure("blocked", CONFIG_CHANGE_BLOCKED, configId);
          }
          requestedValue = value.type === "boolean"
            ? { type: "boolean", value: result.newValue as boolean }
            : { type: "select", value: result.newValue as string };
        }

        if (!this.isCurrentConfigMutation(agent, generation, epoch)) {
          return this.configFailure("superseded", CONFIG_CHANGE_SUPERSEDED, configId);
        }

        const rpc = Promise.resolve()
          .then(() => agent.setConfigOption(configId, requestedValue))
          .then(
            (response) => ({ status: "fulfilled" as const, response }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
        const rpcResult = await Promise.race([
          rpc,
          invalidation.then(() => ({ status: "superseded" as const })),
        ]);
        if (rpcResult.status === "superseded") {
          return this.configFailure("superseded", CONFIG_CHANGE_SUPERSEDED, configId);
        }
        if (rpcResult.status === "rejected") throw rpcResult.error;
        const response = rpcResult.response;
        if (!this.isCurrentConfigMutation(agent, generation, epoch)) {
          return this.configFailure("superseded", CONFIG_CHANGE_SUPERSEDED, configId);
        }

        if (response.legacyAcknowledged !== true && Array.isArray(response.configOptions)) {
          this.replaceConfigOptions(response.configOptions as ConfigOption[]);
          const outcome = this.configSuccess(true, configId);
          this.notifyConfigAfterChange(configId, oldValue, requestedValue.value, outcome);
          return outcome;
        }
        if (
          response.legacyAcknowledged === true
          && requestedValue.type === 'select'
          && this.getConfigOption(configId)?.type === 'select'
        ) {
          // Legacy mode/model methods have no authoritative response. Their successful
          // JSON-RPC settlement is the only acknowledgement available.
          this.replaceConfigOptions(this.configOptions.map((option): ConfigOption =>
            option.id === configId && option.type === 'select'
              ? { ...option, currentValue: requestedValue.value }
              : option
          ));
          const outcome = this.configSuccess(false, configId);
          this.notifyConfigAfterChange(configId, oldValue, requestedValue.value, outcome);
          return outcome;
        }
        return this.configFailure("unacknowledged", CONFIG_CHANGE_UNACKNOWLEDGED, configId);
      },
    );
  }

  private replaceConfigOptions(options: ConfigOption[]): void {
    this.configOptions = structuredClone(options);
    this._configRevision += 1;
  }

  private configSuccess(authoritative: boolean, configId: string): ConfigOptionChangeOutcome {
    const configOptions = structuredClone(this.configOptions);
    return {
      acknowledged: true,
      authoritative,
      effective: configOptions.find((option) => option.id === configId),
      revision: this.configRevision,
      configOptions,
    };
  }

  private configFailure(
    reason: NonNullable<ConfigOptionChangeOutcome["reason"]>,
    message: string,
    configId: string,
  ): ConfigOptionChangeOutcome {
    const configOptions = structuredClone(this.configOptions);
    return {
      acknowledged: false,
      authoritative: false,
      effective: configOptions.find((option) => option.id === configId),
      reason,
      message,
      revision: this.configRevision,
      configOptions,
    };
  }

  private invalidateConfigMutations(paused: boolean): void {
    this._configMutationEpoch += 1;
    this._configRevision += 1;
    this._configMutationPaused = paused;
    this._resolveConfigMutationInvalidation();
    this._configMutationTail = Promise.resolve();
    this._configMutationInvalidation = new Promise((resolve) => {
      this._resolveConfigMutationInvalidation = resolve;
    });
  }

  private isCurrentConfigMutation(agent: AgentInstance, generation: number, epoch: number): boolean {
    return !this.isTerminating
      && !this._configMutationPaused
      && this.agentInstance === agent
      && this.agentGeneration === generation
      && this._configMutationEpoch === epoch;
  }

  private async waitForConfigMutationSlot(
    predecessor: Promise<void>,
    invalidation: Promise<void>,
  ): Promise<"ready" | "superseded" | "queue_timeout"> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: "ready" | "superseded" | "queue_timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish("queue_timeout"), CONFIG_MUTATION_QUEUE_TIMEOUT_MS);
      void predecessor.then(() => finish("ready"));
      void invalidation.then(() => finish("superseded"));
    });
  }

  private async runSerializedConfigMutation<T>(
    onSuperseded: () => T,
    onQueueTimeout: () => T,
    operation: (context: {
      agent: AgentInstance;
      generation: number;
      epoch: number;
      invalidation: Promise<void>;
    }) => Promise<T>,
    expectedAgentGeneration: number = this.agentGeneration,
  ): Promise<T> {
    const agent = this.agentInstance;
    const generation = expectedAgentGeneration;
    const epoch = this._configMutationEpoch;
    const invalidation = this._configMutationInvalidation;
    if (!this.isCurrentConfigMutation(agent, generation, epoch)) return onSuperseded();

    const predecessor = this._configMutationTail;
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    this._configMutationTail = predecessor.then(() => completed);

    const slot = await this.waitForConfigMutationSlot(predecessor, invalidation);
    if (slot !== "ready") {
      release();
      return slot === "queue_timeout" ? onQueueTimeout() : onSuperseded();
    }
    if (!this.isCurrentConfigMutation(agent, generation, epoch)) {
      release();
      return onSuperseded();
    }

    try {
      return await operation({ agent, generation, epoch, invalidation });
    } finally {
      release();
    }
  }

  private notifyConfigAfterChange(
    configId: string,
    oldValue: unknown,
    requestedValue: unknown,
    outcome: ConfigOptionChangeOutcome,
    effectiveValue: unknown = outcome.effective?.currentValue,
  ): void {
    if (!this.middlewareChain || !outcome.acknowledged) return;
    void this.middlewareChain.execute(
      Hook.CONFIG_AFTER_CHANGE,
      {
        sessionId: this.id,
        configId,
        oldValue: structuredClone(oldValue),
        requestedValue: structuredClone(requestedValue),
        newValue: structuredClone(effectiveValue),
        acknowledged: true as const,
        authoritative: outcome.authoritative,
      },
      async (payload) => payload,
    ).catch((error) => {
      moduleLog.warn(
        { err: redactNetworkSecrets(error instanceof Error ? error.message : String(error)), sessionId: this.id, configId },
        "Config after-change middleware failed",
      );
    });
  }

  async updateConfigOptions(
    options: ConfigOption[],
    expectedAgentGeneration?: number,
    ownsMutation: () => boolean = () => true,
  ): Promise<boolean> {
    const generation = expectedAgentGeneration ?? this.agentGeneration;
    return this.runSerializedConfigMutation(
      () => false,
      () => false,
      async ({ agent, generation: activeGeneration, epoch }) => {
        if (!ownsMutation()) return false;
        const oldOptions = structuredClone(this.configOptions);
        let nextOptions = structuredClone(options);
        if (this.middlewareChain) {
          const result = await this.middlewareChain.execute(
            Hook.CONFIG_BEFORE_CHANGE,
            { sessionId: this.id, configId: 'options', oldValue: oldOptions, newValue: nextOptions },
            async (payload) => payload,
            { onError: 'block' },
          );
          if (!result || !Array.isArray(result.newValue)) return false;
          nextOptions = structuredClone(result.newValue as ConfigOption[]);
        }
        if (!ownsMutation() || !this.isCurrentConfigMutation(agent, activeGeneration, epoch)) return false;
        this.replaceConfigOptions(nextOptions);
        const configOptions = structuredClone(this.configOptions);
        this.notifyConfigAfterChange('options', oldOptions, options, {
          acknowledged: true,
          authoritative: true,
          effective: undefined,
          revision: this.configRevision,
          configOptions,
        }, configOptions);
        return true;
      },
      generation,
    );
  }

  /** Snapshot of current ACP state for persistence */
  toAcpStateSnapshot(): NonNullable<import("../types.js").SessionRecord["acpState"]> {
    return {
      configOptions: this.configOptions.length > 0 ? this.configOptions : undefined,
      agentCapabilities: this.agentCapabilities,
    };
  }

  /** Check if the agent supports a specific session capability */
  supportsCapability(cap: 'list' | 'fork' | 'close' | 'loadSession'): boolean {
    if (cap === 'loadSession') return this.agentCapabilities?.loadSession === true;
    return this.agentCapabilities?.sessionCapabilities?.[cap] === true;
  }

  private getAgentCancellationOperation(
    agentInstance: AgentInstance,
    generation: number,
  ): Promise<ObservedOperation> {
    const existing = this._agentCancellationOps.get(agentInstance);
    if (existing?.generation === generation) return existing.operation;

    let record!: { generation: number; operation: Promise<ObservedOperation> };
    const operation = observeOperation(Promise.resolve().then(() => agentInstance.cancel())).then((result) => {
      // Keep a settled request shared for the rest of its generation: the prompt
      // may ignore cancellation while repeated cancel or terminal destroy arrives.
      // A late settlement may clean up only its own inactive record; otherwise it
      // could delete a newer generation's operation and poison cancellation again.
      if (
        this.queue.currentGeneration !== generation
        && this._agentCancellationOps.get(agentInstance) === record
      ) {
        this._agentCancellationOps.delete(agentInstance);
      }
      return result;
    });
    record = { generation, operation };
    this._agentCancellationOps.set(agentInstance, record);
    return operation;
  }

  private async requestAgentCancellation(
    agentInstance: AgentInstance = this.agentInstance,
    generation: number | null = this.queue.currentGeneration,
  ): Promise<void> {
    if (generation === null) return;
    const result = await waitForObservedOperation(
      this.getAgentCancellationOperation(agentInstance, generation),
      AGENT_CANCEL_TIMEOUT_MS,
    );
    if (result === OPERATION_TIMEOUT) {
      this.log.warn("Agent cancellation did not settle within 5 seconds");
    } else if (!result.ok) {
      this.log.warn({ err: result.error }, "Agent cancellation failed");
    }
  }

  private async quiesceQueueForAgentSwitch(agentInstance: AgentInstance): Promise<void> {
    const cancellation = this.queue.isProcessing && this._activePromptPhase === 'agent'
      ? this.requestAgentCancellation(agentInstance)
      : Promise.resolve();
    const queueCleanup = this.queue.clear(cancellation);
    await cancellation;
    await this.destroyAgent(agentInstance);
    await queueCleanup;
  }

  private assertReplacementAllowed(): void {
    if (this.isTerminating) throw new SessionTerminatingError(this.id);
  }

  /** Share one successful/in-flight process teardown per concrete AgentInstance. */
  private destroyAgent(agentInstance: AgentInstance): Promise<void> {
    const existing = this._agentDestroyOps.get(agentInstance);
    if (existing) return existing;

    let shared!: Promise<void>;
    shared = Promise.resolve()
      .then(() => agentInstance.destroy())
      .catch((error) => {
        // A real teardown failure remains retryable, while concurrent callers still
        // observe the same attempt. Successful teardown stays memoized in the WeakMap.
        if (this._agentDestroyOps.get(agentInstance) === shared) {
          this._agentDestroyOps.delete(agentInstance);
        }
        throw error;
      });
    this._agentDestroyOps.set(agentInstance, shared);
    return shared;
  }

  private observeReplacementCleanup(agentInstance: AgentInstance): void {
    this.destroyAgent(agentInstance).catch((error) => {
      this.log.warn(
        { err: redactNetworkSecrets(error instanceof Error ? error.message : String(error)) },
        "Late replacement agent cleanup failed",
      );
    });
  }

  /**
   * Own a replacement from factory start until guarded assignment. If destroy()
   * wins the race, return promptly and observe/destroy any agent produced later.
   */
  private async createReplacementAgent(createAgent: () => Promise<AgentInstance>): Promise<AgentInstance> {
    this.assertReplacementAllowed();
    const creation = Promise.resolve().then(createAgent);
    const outcome = creation.then(
      (agent) => ({ status: 'created' as const, agent }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
    const result = await Promise.race([
      outcome,
      this._terminationRequested.then(() => ({ status: 'terminated' as const })),
    ]);

    if (result.status === 'terminated') {
      // The factory may be uncooperative and settle much later. Its rejection and
      // any eventual agent teardown remain observed without holding switch open.
      void outcome.then((lateResult) => {
        if (lateResult.status === 'created') this.observeReplacementCleanup(lateResult.agent);
      });
      throw new SessionTerminatingError(this.id);
    }
    if (result.status === 'failed') throw result.error;
    if (this.isTerminating) {
      this.observeReplacementCleanup(result.agent);
      throw new SessionTerminatingError(this.id);
    }
    return result.agent;
  }

  /** Cancel the current prompt. Queued prompts continue processing. Stays in active state. */
  async abortPrompt(): Promise<void> {
    // Hook: agent:beforeCancel — modifiable, can block
    if (this.middlewareChain) {
      const result = await this.middlewareChain.execute(Hook.AGENT_BEFORE_CANCEL, { sessionId: this.id }, async (p) => p);
      if (!result) return; // blocked by middleware
    }
    const turnId = this.activeTurnContext?.turnId;
    if (turnId) this.elicitationGate.cancelTurn(turnId);

    if (turnId) {
      // Turn is still in-flight — mark for interrupted stopReason in the finally block
      this._abortedTurnIds.add(turnId);

      const cancelRequest = this.requestAgentCancellation();
      // Signal local preprocessing immediately, but keep queue serialization
      // until both provider cleanup and the agent cancellation request settle.
      const queueCleanup = this.queue.abortCurrent(cancelRequest);
      await Promise.all([cancelRequest, queueCleanup]);
    } else if (this._lastCompletedTurnId && !this.queue.isProcessing) {
      // Turn already completed before cancel arrived — retroactively update
      // the history record so the client sees stopReason: "interrupted" on reload.
      const retroTurnId = this._lastCompletedTurnId;
      this._lastCompletedTurnId = null;
      if (this.middlewareChain) {
        await this.middlewareChain.execute(Hook.TURN_END, {
          sessionId: this.id,
          stopReason: 'interrupted' as import('../types.js').StopReason,
          durationMs: 0,
          turnId: retroTurnId,
        }, async (p) => p).catch((hookError) => {
          this.log.warn({ err: hookError, hook: Hook.TURN_END }, "Session hook failed");
        });
      }
    }

    this.log.info("Prompt aborted (queue preserved, %d pending)", this.queue.pending);
  }

  /** Discard all queued prompts without interrupting the in-flight prompt. */
  clearQueue(): void {
    const dropped = this.queue.pending;
    this.queue.clearPending();
    this.log.info("Queue cleared (%d pending prompts discarded)", dropped);
  }

  /**
   * Cancel the in-flight prompt AND discard all queued prompts.
   * Full reset — nothing remains in the pipeline after this call.
   */
  async flushAll(): Promise<void> {
    // Hook: agent:beforeCancel — modifiable, can block
    if (this.middlewareChain) {
      const result = await this.middlewareChain.execute(Hook.AGENT_BEFORE_CANCEL, { sessionId: this.id }, async (p) => p);
      if (!result) return; // blocked by middleware
    }
    const turnId = this.activeTurnContext?.turnId;
    if (turnId) this.elicitationGate.cancelTurn(turnId);
    if (turnId) this._abortedTurnIds.add(turnId);

    const cancelRequest = this.requestAgentCancellation();
    const queueCleanup = this.queue.clear(cancelRequest);
    await Promise.all([cancelRequest, queueCleanup]);
    this.log.info("Session flushed (prompt cancelled, queue cleared)");
  }

  /**
   * Skip the queue: cancel the in-flight prompt, discard all other queued
   * items, and promote the specified turn to process next.
   *
   * Used when the user clicks "Process Now" on a queued message — they want
   * THIS message handled immediately, discarding everything else in the pipeline.
   *
   * @returns true if the turn was found and promoted, false if already processed
   */
  async prioritizePrompt(turnId: string): Promise<boolean> {
    // Rearrange queue: keep only the target item
    const found = this.queue.prioritize(turnId);
    if (!found) return false;

    // Cancel agent so the current processPrompt resolves and drainNext
    // picks up the promoted item. Timeout fallback if agent is unresponsive.
    if (this.activeTurnContext?.turnId) this.elicitationGate.cancelTurn(this.activeTurnContext.turnId);
    const cancelRequest = this.requestAgentCancellation();

    const queueCleanup = this.queue.isProcessing
      ? this.queue.abortCurrent(cancelRequest)
      : Promise.resolve();
    await Promise.all([cancelRequest, queueCleanup]);

    this.log.info({ turnId }, "Prompt prioritized");
    return true;
  }

  /** Search backward through agentSwitchHistory for the last entry matching agentName */
  findLastSwitchEntry(agentName: string): AgentSwitchEntry | undefined {
    for (let i = this.agentSwitchHistory.length - 1; i >= 0; i--) {
      if (this.agentSwitchHistory[i].agentName === agentName) {
        return this.agentSwitchHistory[i];
      }
    }
    return undefined;
  }

  /** Switch the agent instance in-place, preserving session identity */
  async switchAgent(agentName: string, createAgent: () => Promise<AgentInstance>): Promise<void> {
    this.assertReplacementAllowed();
    if (agentName === this.agentName) {
      throw new Error(`Already using ${agentName}`);
    }
    // Switching is a synchronous config mutation boundary: queued work must not
    // reach the old agent while replacement teardown is in progress.
    this.invalidateAutoNaming();
    this.invalidateConfigMutations(true);
    this._agentOwnershipEpoch += 1;

    // Record current agent in history
    this.agentSwitchHistory.push({
      agentName: this.agentName,
      agentSessionId: this.agentSessionId,
      switchedAt: new Date().toISOString(),
      promptCount: this.promptCount,
    });

    // Reject any pending permission request before destroying old agent
    if (this.permissionGate.isPending) {
      this.permissionGate.reject("Agent switched");
    }
    this.elicitationGate.cancelAll("cancelled");

    const oldAgent = this.agentInstance;
    await this.quiesceQueueForAgentSwitch(oldAgent);
    this.assertReplacementAllowed();

    // Create and wire new agent. Session owns the candidate until the final
    // synchronous lifecycle check and destroys it if terminal teardown wins.
    const newAgent = await this.createReplacementAgent(createAgent);
    let installed = false;
    try {
      this.assertReplacementAllowed();
      this.elicitationGate.cancelAll("cancelled");
      this.agentInstance = newAgent;
      this.agentName = agentName;
      this.agentSessionId = newAgent.sessionId;
      this.promptCount = 0;

      // Hydrate ACP state from the new agent's spawn response
      this.agentCapabilities = undefined;
      this.replaceConfigOptions([]);
      this.latestCommands = null;
      this.applySpawnResponse(newAgent.initialSessionResponse, newAgent.agentCapabilities);
      installed = true;
    } finally {
      if (!installed) this.observeReplacementCleanup(newAgent);
    }

    this.log.info({ from: this.agentSwitchHistory.at(-1)!.agentName, to: agentName }, "Agent switched");
  }

  /** Install a rollback process without bypassing the terminal replacement guard. */
  async restoreAgentAfterFailedSwitch(
    agentName: string,
    createAgent: () => Promise<AgentInstance>,
  ): Promise<void> {
    const rollbackAgent = await this.createReplacementAgent(createAgent);
    let installed = false;
    try {
      this.assertReplacementAllowed();
      const previous = this.agentSwitchHistory.at(-1);
      if (!previous || previous.agentName !== agentName) {
        throw new Error(`Cannot roll back agent switch to ${agentName}`);
      }
      this.agentSwitchHistory.pop();
      this.agentInstance = rollbackAgent;
      this.agentName = agentName;
      this.agentSessionId = rollbackAgent.sessionId;
      this.promptCount = previous.promptCount;
      installed = true;
    } finally {
      if (!installed) this.observeReplacementCleanup(rollbackAgent);
    }
  }

  /** Tear down the session: reject pending permissions, clear queue, destroy agent subprocess. */
  destroy(): Promise<void> {
    this.beginTermination();
    if (this._destroyOperation) return this._destroyOperation;

    const operation = this.performDestroy();
    const shared = operation.catch((error) => {
      // Retry is allowed only after the shared teardown has actually failed.
      // A manager/API deadline does not clear this promise, so repeated cancellation
      // keeps observing the same in-flight process teardown instead of invoking it twice.
      if (this._destroyOperation === shared) this._destroyOperation = null;
      throw error;
    });
    this._destroyOperation = shared;
    return shared;
  }

  private async performDestroy(): Promise<void> {
    this.log.info("Session destroyed");
    // Reject any pending permission promise so callers don't hang
    if (this.permissionGate.isPending) {
      this.permissionGate.reject("Session destroyed");
    }
    const agentInstance = this.agentInstance;
    const activePromptPhase = this._activePromptPhase;
    const cancellation = this.queue.isProcessing && activePromptPhase === 'agent'
      ? this.requestAgentCancellation(agentInstance)
      : Promise.resolve();

    // close() is terminal: pending callers resolve immediately and drainNext() can
    // never start another prompt. Its eventual settlement is explicitly observed,
    // but an uncooperative processor cannot hold process teardown open forever.
    if (!this._queueCloseOperation) {
      this._queueCloseOperation = observeOperation(this.queue.close(cancellation));
    }
    if (activePromptPhase === 'preprocessing') {
      // Local STT providers use AbortSignal for their own process/file cleanup.
      // Preserve that ordering when cleanup cooperates, but force agent teardown
      // after the same five-second grace if preprocessing never settles.
      const preprocessing = await waitForObservedOperation(
        this._queueCloseOperation,
        AGENT_CANCEL_TIMEOUT_MS,
      );
      if (preprocessing === OPERATION_TIMEOUT) {
        this.log.warn("Prompt preprocessing cleanup did not settle within 5 seconds");
      } else if (!preprocessing.ok) {
        throw preprocessing.error;
      }
    } else {
      await cancellation;
    }
    await this.destroyAgent(agentInstance);
    // Once the subprocess is gone, an ACP prompt promise may still never settle
    // (for example, a broken adapter that ignores process exit). Release terminal
    // queue callers while keeping all late settlements rejection-observed.
    this.queue.releaseAfterTerminalTeardown();
    const queueResult = await waitForObservedOperation(
      this._queueCloseOperation,
      QUEUE_TEARDOWN_TIMEOUT_MS,
    );
    if (queueResult === OPERATION_TIMEOUT) {
      this.log.warn("Terminal prompt queue did not settle within 1 second after process teardown");
    } else if (!queueResult.ok) {
      throw queueResult.error;
    }
    if (!this._closedLogger) {
      await closeSessionLogger(this.log);
      this._closedLogger = true;
    }
    this._lifecycleState = 'destroyed';
  }
}
