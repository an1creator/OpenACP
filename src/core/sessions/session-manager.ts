import type { AgentManager } from "../agents/agent-manager.js";
import { Session, SessionTerminatingError, type PromptAdmission } from "./session.js";
import type { SessionStore } from "./session-store.js";
import type { EventBus } from "../event-bus.js";
import type { MiddlewareChain } from "../plugin/middleware-chain.js";
import type { SessionStatus, ConfigOption, AgentCapabilities } from "../types.js";
import { Hook, BusEvent, SessionEv } from "../events.js";
import { createChildLogger } from "../utils/log.js";
import { redactNetworkSecrets } from "../security/network-redaction.js";

const log = createChildLogger({ module: 'session-manager' });
const SESSION_CANCEL_CLEANUP_TIMEOUT_MS = 9_000;
// Store-less managers need a short idempotency window for immediate retry, but
// must not retain every historical ID forever or claim truth after that window.
const NO_STORE_TERMINAL_TOMBSTONE_TTL_MS = 15 * 60 * 1000;
const NO_STORE_TERMINAL_TOMBSTONE_CAPACITY = 1_024;

function isTerminalStatus(status: SessionStatus | undefined): status is 'cancelled' | 'finished' {
  return status === 'cancelled' || status === 'finished';
}

/**
 * Merge a durable record without ever replacing an already-persisted terminal
 * winner. Metadata remains patchable after termination, but status is monotonic.
 */
function mergeRecordMonotonic(
  record: import('../types.js').SessionRecord,
  patch: Partial<import('../types.js').SessionRecord>,
): import('../types.js').SessionRecord {
  if (isTerminalStatus(record.status)) {
    // Metadata-only patches (or an idempotent write of the same terminal state)
    // remain useful. A conflicting status identifies stale lifecycle work, so its
    // accompanying metadata is rejected as one atomic patch.
    if (patch.status !== undefined && patch.status !== record.status) return record;
    return { ...record, ...patch, status: record.status };
  }
  return { ...record, ...patch };
}

export class SessionRegistrationSupersededError extends Error {
  readonly code = 'SESSION_REGISTRATION_SUPERSEDED';

  constructor(sessionId: string, reason = 'session lifecycle changed') {
    super(`Session ${sessionId} registration was superseded: ${reason}`);
    this.name = 'SessionRegistrationSupersededError';
  }
}

export class SessionLimitError extends Error {
  readonly code = 'SESSION_LIMIT';

  constructor(readonly limit: number) {
    super(`Maximum concurrent sessions reached (${limit})`);
    this.name = 'SessionLimitError';
  }
}

/** One-use capacity lease reserved before ACP spawn and retained by its live session. */
export interface SessionAdmissionLease {
  readonly token: symbol;
  readonly released: boolean;
  readonly committed: boolean;
}

interface ManagedSessionAdmissionLease extends SessionAdmissionLease {
  released: boolean;
  committed: boolean;
  owner?: Session;
  promptClaims: number;
  promptCommitted: boolean;
}

/** A bounded, one-use lease for registering a resumed existing session. */
export interface SessionRegistrationLease {
  readonly sessionId: string;
  readonly generation: number;
  readonly invalidated: boolean;
  readonly invalidation: Promise<void>;
}

interface ManagedSessionRegistrationLease extends SessionRegistrationLease {
  invalidated: boolean;
  released: boolean;
  finishedReopenConsumed: boolean;
  invalidate(reason: string): void;
}

type CleanupOutcome =
  | { status: 'completed' }
  | { status: 'failed'; error: unknown }
  | { status: 'timed-out' };

interface SessionTeardownEntry {
  session: Session;
  operation: Promise<void>;
  state: 'pending' | 'failed';
  error?: unknown;
}

interface TerminalCancellationTombstone {
  status: 'cancelled' | 'finished';
  expiresAt: number;
}

async function waitForSessionCleanup(operation: Promise<void>): Promise<CleanupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observed = operation.then<CleanupOutcome, CleanupOutcome>(
    () => ({ status: 'completed' }),
    (error: unknown) => ({ status: 'failed', error }),
  );
  try {
    return await Promise.race([
      observed,
      new Promise<CleanupOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ status: 'timed-out' }), SESSION_CANCEL_CLEANUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Flattened view of a session for API consumers — merges live state with stored record. */
export interface SessionSummary {
  id: string;
  agent: string;
  status: SessionStatus;
  name: string | null;
  workspace: string;
  channelId: string;
  createdAt: string;
  lastActiveAt: string | null;
  dangerousMode: boolean;
  queueDepth: number;
  promptRunning: boolean;
  configOptions?: ConfigOption[];
  capabilities: AgentCapabilities | null;
  isLive: boolean;
}

export interface CancelSessionResult {
  sessionId: string;
  cancelled: boolean;
  previousStatus: SessionStatus;
  status: 'cancelled' | 'finished';
  alreadyTerminal: boolean;
  /** Terminal state is durable, but process/logger cleanup needs another cancel retry. */
  cleanupPending: boolean;
  warning?: string;
}

/** Additive internal-resource diagnostics exposed by authenticated health details. */
export interface SessionServiceResourceStatus {
  assistant: { live: number; active: number };
  terminalCleanup: { pending: number; failed: number };
}

/**
 * Registry for live Session instances. Provides lookup by session ID, channel+thread,
 * or agent session ID. Coordinates session lifecycle: creation, cancellation, persistence,
 * and graceful shutdown.
 *
 * Live sessions are kept in an in-memory Map. The optional SessionStore handles
 * disk persistence — the manager delegates save/patch/remove operations to the store.
 */
export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private store: SessionStore | null;
  private eventBus?: EventBus;
  middlewareChain?: MiddlewareChain;
  // Set to true after shutdownAll() flushes "finished" state to disk.
  // Prevents SessionBridge STATUS_CHANGE listeners from overwriting the flushed state
  // with transient error status from in-flight prompts that fail after shutdown.
  private _shutdownComplete = false;
  /** Global lifecycle fence: no session may register after teardown begins. */
  private _closing = false;
  private closeOperation: Promise<void> | null = null;
  private cancellationOps = new Map<string, Promise<CancelSessionResult>>();
  /** Bounded, expiring idempotency window used only when no durable store exists. */
  private terminalCancellationStatuses = new Map<string, TerminalCancellationTombstone>();
  /** Shared process teardown for completion/cancel races, keyed by durable session ID. */
  private sessionTeardownOps = new Map<string, SessionTeardownEntry>();
  private nextRegistrationGeneration = 1;
  private pendingRegistrations = new Map<string, Set<ManagedSessionRegistrationLease>>();
  private ownedRegistrationLeases = new WeakSet<object>();
  private sessionLimitProvider: () => number | Promise<number> = () => 20;
  private admissionReservations = new Set<ManagedSessionAdmissionLease>();
  private sessionAdmissionOwners = new Map<Session, ManagedSessionAdmissionLease>();
  private admissionLifecycleWired = new WeakSet<Session>();
  private admissionTail: Promise<void> = Promise.resolve();
  /** Transient only; completed cancellation is enforced by the terminal store record. */
  private cancellingSessionIds = new Set<string>();
  /** Serialize durable mutations per session so terminal cancellation always wins. */
  private recordMutationTails = new Map<string, Promise<void>>();
  /** Core-owned resources (bridges, adapter listeners) must detach at the sync terminal boundary. */
  private cleanupSessionResources?: (sessionId: string) => void;

  private async withRecordMutation<T>(sessionId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.recordMutationTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(mutation);
    const tail = operation.then(() => undefined, () => undefined);
    this.recordMutationTails.set(sessionId, tail);
    try {
      return await operation;
    } finally {
      if (this.recordMutationTails.get(sessionId) === tail) {
        this.recordMutationTails.delete(sessionId);
      }
    }
  }

  private pruneTerminalCancellationStatuses(now = Date.now()): void {
    for (const [sessionId, tombstone] of this.terminalCancellationStatuses) {
      if (tombstone.expiresAt <= now) this.terminalCancellationStatuses.delete(sessionId);
    }
    while (this.terminalCancellationStatuses.size > NO_STORE_TERMINAL_TOMBSTONE_CAPACITY) {
      const oldest = this.terminalCancellationStatuses.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminalCancellationStatuses.delete(oldest);
    }
  }

  private getTerminalCancellationStatus(sessionId: string): 'cancelled' | 'finished' | undefined {
    if (this.store) return undefined;
    const now = Date.now();
    this.pruneTerminalCancellationStatuses(now);
    const tombstone = this.terminalCancellationStatuses.get(sessionId);
    if (!tombstone || tombstone.expiresAt <= now) return undefined;
    return tombstone.status;
  }

  private rememberTerminalCancellationStatus(
    sessionId: string,
    status: 'cancelled' | 'finished',
  ): void {
    if (this.store) return;
    this.pruneTerminalCancellationStatuses();
    // Refresh insertion order for deterministic oldest-first capacity eviction.
    this.terminalCancellationStatuses.delete(sessionId);
    this.terminalCancellationStatuses.set(sessionId, {
      status,
      expiresAt: Date.now() + NO_STORE_TERMINAL_TOMBSTONE_TTL_MS,
    });
    this.pruneTerminalCancellationStatuses();
  }

  private cleanupOwnedResources(sessionId: string): void {
    try {
      this.cleanupSessionResources?.(sessionId);
    } catch (error) {
      log.warn(
        {
          sessionId,
          error: redactNetworkSecrets(error instanceof Error ? error.message : String(error)),
        },
        'Session resource cleanup failed at terminal boundary',
      );
    }
  }

  /**
   * Cross the resource terminal boundary synchronously and start one shared
   * Session.destroy() operation. Durable state must be written by the caller
   * before invoking this method.
   */
  private startSessionTeardown(session: Session, removeLiveIdentity = false): Promise<void> {
    const existing = this.sessionTeardownOps.get(session.id);
    if (existing?.session === session && existing.state === 'pending') {
      if (removeLiveIdentity && this.sessions.get(session.id) === session) {
        this.releaseOwnedSessionAdmission(session);
        this.cleanupOwnedResources(session.id);
        this.sessions.delete(session.id);
      }
      return existing.operation;
    }
    if (existing?.session === session && existing.state === 'failed') {
      this.sessionTeardownOps.delete(session.id);
    } else if (existing) {
      return existing.operation;
    }

    session.beginTermination();
    this.releaseOwnedSessionAdmission(session);
    this.cleanupOwnedResources(session.id);
    if (removeLiveIdentity && this.sessions.get(session.id) === session) this.sessions.delete(session.id);

    const entry = {} as SessionTeardownEntry;
    const operation = session.destroy().then(
      () => {
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
        if (this.sessionTeardownOps.get(session.id) === entry) {
          this.sessionTeardownOps.delete(session.id);
        }
        if (this.middlewareChain) {
          this.middlewareChain.execute(
            Hook.SESSION_AFTER_DESTROY,
            { sessionId: session.id },
            async (payload) => payload,
          ).catch(() => {});
        }
      },
      (error: unknown) => {
        if (this.sessionTeardownOps.get(session.id) === entry) {
          entry.state = 'failed';
          entry.error = error;
        }
        throw error;
      },
    );
    entry.session = session;
    entry.operation = operation;
    entry.state = 'pending';
    this.sessionTeardownOps.set(session.id, entry);
    return operation;
  }

  /**
   * Finalize a durable ordinary completion after its terminal delivery barrier.
   * The wait is bounded for event-loop health; the shared destroy promise remains
   * observed and removes the live identity immediately.
   */
  async finalizeFinishedSession(session: Session): Promise<CleanupOutcome> {
    const current = this.sessions.get(session.id);
    const existing = this.sessionTeardownOps.get(session.id);
    if (current !== session && existing?.session !== session) {
      return { status: 'completed' };
    }
    const cleanup = await waitForSessionCleanup(this.startSessionTeardown(session, true));
    if (cleanup.status !== 'completed') {
      log.warn(
        {
          sessionId: session.id,
          error: cleanup.status === 'failed'
            ? redactNetworkSecrets(cleanup.error instanceof Error ? cleanup.error.message : String(cleanup.error))
            : `cleanup exceeded ${SESSION_CANCEL_CLEANUP_TIMEOUT_MS}ms`,
        },
        cleanup.status === 'failed'
          ? 'Finished session agent/logger cleanup failed'
          : 'Finished session agent/logger cleanup is still running',
      );
    }
    return cleanup;
  }

  /** Cross the manager-wide terminal boundary before teardown performs any I/O. */
  private beginClosing(reason: string): void {
    if (!this._closing) {
      this._closing = true;
      for (const pending of this.pendingRegistrations.values()) {
        for (const lease of pending) lease.invalidate(reason);
      }
      this.pendingRegistrations.clear();
    }
    for (const session of this.sessions.values()) {
      session.beginTermination();
      this.releaseOwnedSessionAdmission(session);
      this.cleanupOwnedResources(session.id);
    }
  }

  private rejectRegistration(session: Session, reason: string): never {
    session.beginTermination();
    session.destroy().catch((error) => {
      log.warn(
        {
          sessionId: session.id,
          error: redactNetworkSecrets(error instanceof Error ? error.message : String(error)),
        },
        'Rejected session registration cleanup failed',
      );
    });
    throw new SessionRegistrationSupersededError(session.id, reason);
  }

  /**
   * Inject the EventBus after construction. Deferred because EventBus is created
   * after SessionManager during bootstrap, so it cannot be passed to the constructor.
   */
  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  setSessionResourceCleanup(cleanup: (sessionId: string) => void): void {
    this.cleanupSessionResources = cleanup;
  }

  constructor(store: SessionStore | null = null) {
    this.store = store;
  }

  /** Configure the hot-reloadable global session cap used by every creation surface. */
  setSessionLimitProvider(provider: () => number | Promise<number>): void {
    this.sessionLimitProvider = provider;
  }

  private async withAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
    let releaseLock!: () => void;
    const previous = this.admissionTail;
    this.admissionTail = new Promise<void>((resolve) => { releaseLock = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      releaseLock();
    }
  }

  private async configuredSessionLimit(): Promise<number> {
    const configured = await this.sessionLimitProvider();
    return Number.isFinite(configured) ? Math.max(0, Math.floor(configured)) : 20;
  }

  private usedSessionCapacity(): number {
    const unownedLive = [...this.sessions.values()].filter(
      (session) => (
        session.status === 'active'
        || session.status === 'initializing'
      ) && !this.sessionAdmissionOwners.has(session),
    ).length;
    return this.sessionAdmissionOwners.size + this.admissionReservations.size + unownedLive;
  }

  private newAdmissionLease(): ManagedSessionAdmissionLease {
    return {
      token: Symbol('session-admission'),
      released: false,
      committed: false,
      promptClaims: 0,
      promptCommitted: false,
    };
  }

  private releaseOwnedSessionAdmission(session: Session): void {
    const admission = this.sessionAdmissionOwners.get(session);
    if (!admission) return;
    this.sessionAdmissionOwners.delete(session);
    admission.released = true;
    admission.owner = undefined;
    admission.promptClaims = 0;
  }

  private wireSessionAdmissionLifecycle(session: Session): void {
    if (this.admissionLifecycleWired.has(session)) return;
    this.admissionLifecycleWired.add(session);
    // Some embedders provide a Session-compatible test/double object. The
    // runtime Session always exposes the guard; keep registration compatible
    // with older structural consumers that do not submit prompts here.
    if (typeof session.setPromptAdmissionGuard === 'function') {
      session.setPromptAdmissionGuard(() => this.ensureSessionPromptAdmission(session));
    }
    session.on(SessionEv.STATUS_CHANGE, (_from, to) => {
      if (to === 'error' || to === 'cancelled' || to === 'finished') {
        this.releaseOwnedSessionAdmission(session);
      }
    });
  }

  private commitSessionAdmission(
    session: Session,
    admission: ManagedSessionAdmissionLease,
  ): void {
    this.admissionReservations.delete(admission);
    if (this.sessionAdmissionOwners.has(session)) {
      admission.released = true;
      return;
    }
    admission.committed = true;
    if (session.status !== 'active' && session.status !== 'initializing') {
      admission.released = true;
      return;
    }
    admission.owner = session;
    this.sessionAdmissionOwners.set(session, admission);
  }

  private async ensureSessionPromptAdmission(session: Session): Promise<PromptAdmission> {
    return this.withAdmissionLock(async () => {
      if (this._closing || !this.isCurrentLiveSession(session)) {
        throw new SessionTerminatingError(session.id);
      }
      const existing = this.sessionAdmissionOwners.get(session);
      if (session.status === 'active' || session.status === 'initializing') {
        return { commit() {}, rollback() {} };
      }
      if (session.status !== 'error') {
        throw new SessionTerminatingError(session.id);
      }

      let admission = existing;
      if (!admission) {
        const limit = await this.configuredSessionLimit();
        if (this._closing || !this.isCurrentLiveSession(session)) {
          throw new SessionTerminatingError(session.id);
        }
        if (this.usedSessionCapacity() >= limit) throw new SessionLimitError(limit);
        admission = this.newAdmissionLease();
        admission.committed = true;
        admission.owner = session;
        this.sessionAdmissionOwners.set(session, admission);
      }

      admission.promptClaims += 1;
      let settled = false;
      return {
        commit: () => {
          if (settled) return;
          settled = true;
          admission!.promptClaims = Math.max(0, admission!.promptClaims - 1);
          admission!.promptCommitted = true;
        },
        rollback: () => {
          if (settled) return;
          settled = true;
          admission!.promptClaims = Math.max(0, admission!.promptClaims - 1);
          if (
            admission!.promptClaims === 0
            && !admission!.promptCommitted
            && session.status === 'error'
            && this.sessionAdmissionOwners.get(session) === admission
          ) {
            this.releaseOwnedSessionAdmission(session);
          }
        },
      };
    });
  }

  /**
   * Atomically reserve one live-session slot before spawning an ACP process.
   * Reservations count alongside active/initializing sessions, closing the
   * concurrent-create and concurrent-resume check-then-act race.
   */
  async reserveSessionAdmission(): Promise<SessionAdmissionLease> {
    if (this._closing) throw new Error('Session manager is shutting down');
    return this.withAdmissionLock(async () => {
      if (this._closing) throw new Error('Session manager is shutting down');
      const limit = await this.configuredSessionLimit();
      if (this._closing) throw new Error('Session manager is shutting down');
      if (this.usedSessionCapacity() >= limit) throw new SessionLimitError(limit);
      const lease = this.newAdmissionLease();
      this.admissionReservations.add(lease);
      return lease;
    });
  }

  /** Release a failed or aborted reservation. Committed leases are released by lifecycle transitions. */
  releaseSessionAdmission(lease: SessionAdmissionLease): void {
    const managed = lease as ManagedSessionAdmissionLease;
    if (managed.released || managed.committed) return;
    managed.released = true;
    this.admissionReservations.delete(managed);
  }

  /** Create a new session by spawning an agent and persisting the initial record. */
  async createSession(
    channelId: string,
    agentName: string,
    workingDirectory: string,
    agentManager: AgentManager,
    options?: { autoApprovedCommands?: string[] },
  ): Promise<Session> {
    const admission = await this.reserveSessionAdmission();
    let session: Session | undefined;
    try {
      const agentInstance = await agentManager.spawn(agentName, workingDirectory);
      session = new Session({
        channelId,
        agentName,
        workingDirectory,
        agentInstance,
        autoApprovedCommands: options?.autoApprovedCommands ?? [],
      });
      session.agentSessionId = session.agentInstance.sessionId;
      this.registerSession(session, undefined, admission);
      const registeredSession = session;

      if (this.store) {
        await this.withRecordMutation(registeredSession.id, () => this.store!.save({
          sessionId: registeredSession.id,
          agentSessionId: registeredSession.agentInstance.sessionId,
          agentName: registeredSession.agentName,
          workingDir: registeredSession.workingDirectory,
          channelId,
          status: registeredSession.status,
          createdAt: registeredSession.createdAt.toISOString(),
          lastActiveAt: new Date().toISOString(),
          name: registeredSession.name,
          nameSource: registeredSession.nameSource,
          clientOverrides: {},
          platform: {},
        }));
      }
      return registeredSession;
    } catch (error) {
      if (session) await this.discardSession(session);
      throw error;
    } finally {
      this.releaseSessionAdmission(admission);
    }
  }

  /** Look up a live session by its OpenACP session ID. */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  isCurrentLiveSession(session: Session): boolean {
    return this.sessions.get(session.id) === session && !session.isTerminating;
  }

  /** Exact live-map identity, including a finished winner completing final delivery. */
  isCurrentSession(session: Session): boolean {
    return this.sessions.get(session.id) === session;
  }

  get isClosing(): boolean {
    return this._closing;
  }

  assertCurrentLiveSession(session: Session): void {
    if (!this.isCurrentLiveSession(session)) {
      throw new SessionTerminatingError(session.id);
    }
  }

  /** Look up a live session by adapter channel and thread ID (checks per-adapter threadIds map first, then legacy fields). */
  getSessionByThread(channelId: string, threadId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      // New: check per-adapter threadIds map
      const adapterThread = session.threadIds.get(channelId);
      if (adapterThread === threadId) return session;
      // Backward compat: check legacy channelId + threadId
      if (session.channelId === channelId && session.threadId === threadId) {
        return session;
      }
    }
    return undefined;
  }

  /** Look up a live session by the agent's internal session ID (assigned by the ACP subprocess). */
  getSessionByAgentSessionId(agentSessionId: string): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.agentSessionId === agentSessionId) {
        return session;
      }
    }
    return undefined;
  }

  /**
   * Return every current live session with the exact ACP agent-session identity.
   *
   * Unlike user-facing session listings, this includes assistant sessions. Callers
   * that require an unambiguous owner must inspect the full result instead of
   * accepting whichever matching session happened to be inserted first.
   */
  getCurrentLiveSessionsByAgentSessionId(agentSessionId: string): Session[] {
    const matches: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.agentSessionId === agentSessionId && this.isCurrentLiveSession(session)) {
        matches.push(session);
      }
    }
    return matches;
  }

  /** Look up the persisted SessionRecord by the agent's internal session ID. */
  getRecordByAgentSessionId(
    agentSessionId: string,
  ): import("../types.js").SessionRecord | undefined {
    return this.store?.findByAgentSessionId(agentSessionId);
  }

  /** Look up the persisted SessionRecord by channel and thread ID. */
  getRecordByThread(
    channelId: string,
    threadId: string,
  ): import("../types.js").SessionRecord | undefined {
    return this.store?.findByPlatform(
      channelId,
      (p) => String(p.topicId) === threadId || p.threadId === threadId,
    );
  }

  /**
   * Acquire a one-use registration generation before the first async resume/create
   * boundary. Cancellation invalidates every outstanding lease for the session ID.
   */
  beginSessionRegistration(sessionId: string): SessionRegistrationLease {
    if (this._closing) {
      throw new SessionRegistrationSupersededError(sessionId, 'session manager is shutting down');
    }
    if (this.cancellingSessionIds.has(sessionId)) {
      throw new SessionRegistrationSupersededError(sessionId, 'cancellation is in progress');
    }
    if (this.sessionTeardownOps.has(sessionId)) {
      throw new SessionRegistrationSupersededError(sessionId, 'terminal process cleanup is in progress');
    }
    if (this.sessions.has(sessionId)) {
      throw new SessionRegistrationSupersededError(sessionId, 'session is already live');
    }
    if ((this.pendingRegistrations.get(sessionId)?.size ?? 0) > 0) {
      throw new SessionRegistrationSupersededError(sessionId, 'session registration is already in progress');
    }
    const record = this.store?.get(sessionId);
    if (record?.status === 'cancelled') {
      throw new SessionRegistrationSupersededError(sessionId, `stored session is ${record.status}`);
    }

    let resolveInvalidation!: () => void;
    const invalidation = new Promise<void>((resolve) => { resolveInvalidation = resolve; });
    const lease: ManagedSessionRegistrationLease = {
      sessionId,
      generation: this.nextRegistrationGeneration++,
      invalidated: false,
      released: false,
      finishedReopenConsumed: false,
      invalidation,
      invalidate: () => {
        if (lease.invalidated) return;
        lease.invalidated = true;
        resolveInvalidation();
      },
    };
    this.ownedRegistrationLeases.add(lease);
    const pending = this.pendingRegistrations.get(sessionId) ?? new Set();
    pending.add(lease);
    this.pendingRegistrations.set(sessionId, pending);
    return lease;
  }

  releaseSessionRegistration(lease: SessionRegistrationLease): void {
    const managed = lease as ManagedSessionRegistrationLease;
    if (!this.ownedRegistrationLeases.has(managed) || managed.released) return;
    managed.released = true;
    const pending = this.pendingRegistrations.get(managed.sessionId);
    pending?.delete(managed);
    if (pending?.size === 0) this.pendingRegistrations.delete(managed.sessionId);
  }

  private invalidateSessionRegistrations(sessionId: string, reason: string): void {
    this.cancellingSessionIds.add(sessionId);
    const pending = this.pendingRegistrations.get(sessionId);
    if (!pending) return;
    for (const lease of pending) lease.invalidate(reason);
    this.pendingRegistrations.delete(sessionId);
  }

  /** Register a session that was created externally (e.g. restored from store on startup). */
  registerSession(
    session: Session,
    lease?: SessionRegistrationLease,
    admissionLease?: SessionAdmissionLease,
  ): void {
    if (this._closing) {
      this.rejectRegistration(session, 'session manager is shutting down');
    }
    const admission = admissionLease as ManagedSessionAdmissionLease | undefined;
    if (admission && (
      admission.released
      || admission.committed
      || !this.admissionReservations.has(admission)
    )) {
      this.rejectRegistration(session, 'session admission lease is no longer current');
    }
    const existing = this.sessions.get(session.id);
    if (existing) {
      if (existing === session) {
        this.wireSessionAdmissionLifecycle(session);
        if (admission) this.commitSessionAdmission(session, admission);
        return;
      }
      this.rejectRegistration(session, 'session is already live');
    }
    if (!lease && (this.pendingRegistrations.get(session.id)?.size ?? 0) > 0) {
      this.rejectRegistration(session, 'session registration is already in progress');
    }
    if (lease) {
      const managed = lease as ManagedSessionRegistrationLease;
      const pending = this.pendingRegistrations.get(session.id);
      const invalid = !this.ownedRegistrationLeases.has(managed)
        || managed.sessionId !== session.id
        || managed.released
        || managed.invalidated
        || !pending?.has(managed)
        || this.cancellingSessionIds.has(session.id);
      if (invalid) {
        this.rejectRegistration(session, 'registration lease is no longer current');
      }
    } else if (this.cancellingSessionIds.has(session.id)) {
      this.rejectRegistration(session, 'cancellation is in progress');
    }
    this.terminalCancellationStatuses.delete(session.id);
    this.sessions.set(session.id, session);
    this.wireSessionAdmissionLifecycle(session);
    if (admission) this.commitSessionAdmission(session, admission);
  }

  /**
   * Roll back a just-registered live session when Core cannot durably create its
   * initial record. Identity guarding prevents an old failure from removing a retry.
   */
  async discardSession(session: Session): Promise<void> {
    if (this.sessions.get(session.id) !== session) return;
    session.beginTermination();
    this.releaseOwnedSessionAdmission(session);
    this.cleanupOwnedResources(session.id);
    this.sessions.delete(session.id);
    const cleanup = await waitForSessionCleanup(session.destroy());
    if (cleanup.status !== 'completed') {
      log.warn(
        {
          sessionId: session.id,
          error: cleanup.status === 'failed'
            ? redactNetworkSecrets(cleanup.error instanceof Error ? cleanup.error.message : String(cleanup.error))
            : `cleanup exceeded ${SESSION_CANCEL_CLEANUP_TIMEOUT_MS}ms`,
        },
        'Discarded session cleanup did not complete',
      );
    }
  }

  /** Release Core-owned listeners/bridges for a terminal live identity. */
  releaseSessionResources(session: Session): void {
    if (this.sessions.get(session.id) !== session) return;
    this.cleanupOwnedResources(session.id);
  }

  /**
   * Merge a partial update into the stored SessionRecord. If no record exists yet and
   * the patch includes `sessionId`, it is treated as an initial save.
   * Pass `{ immediate: true }` to flush the store to disk synchronously.
   */
  async patchRecord(
    sessionId: string,
    patch: Partial<import("../types.js").SessionRecord>,
    options?: {
      immediate?: boolean;
      expectedSession?: Session;
      /** Skip a stale config snapshot after a newer in-memory revision wins. */
      expectedConfigRevision?: number;
      /**
       * Authorizes one initial finished -> initializing transition for the exact
       * live session registered under this still-current lifecycle lease.
       */
      registrationLease?: SessionRegistrationLease;
    },
  ): Promise<void> {
    if (!this.store) return;
    await this.withRecordMutation(sessionId, async () => {
      // Check lifecycle inside the serialized mutation, not before waiting: a
      // cancellation may have crossed the terminal boundary while this patch queued.
      if (this._shutdownComplete) return;
      if (options?.expectedSession && (
        this.sessions.get(sessionId) !== options.expectedSession ||
        options.expectedSession.isTerminating
      )) {
        if (options.registrationLease) {
          throw new SessionRegistrationSupersededError(sessionId, 'initial persistence no longer owns the live session');
        }
        return;
      }
      if (
        options?.expectedConfigRevision !== undefined
        && options.expectedSession?.configRevision !== options.expectedConfigRevision
      ) return;
      const record = this.store!.get(sessionId);
      if (record) {
        let merged: import('../types.js').SessionRecord;
        if (record.status === 'finished' && patch.status === 'initializing' && options?.registrationLease) {
          const managed = options.registrationLease as ManagedSessionRegistrationLease;
          const pending = this.pendingRegistrations.get(sessionId);
          const expectedSession = options.expectedSession;
          const authorized = this.ownedRegistrationLeases.has(managed)
            && managed.sessionId === sessionId
            && !managed.released
            && !managed.invalidated
            && !managed.finishedReopenConsumed
            && pending?.has(managed) === true
            && !this.cancellingSessionIds.has(sessionId)
            && expectedSession !== undefined
            && this.sessions.get(sessionId) === expectedSession
            && !expectedSession.isTerminating
            && expectedSession.status === 'initializing';
          if (!authorized) {
            throw new SessionRegistrationSupersededError(sessionId, 'finished-session reopen authorization is no longer current');
          }
          // Consume before persistence. A failed save must not leave reusable
          // authorization that could reopen the same terminal generation twice.
          managed.finishedReopenConsumed = true;
          merged = { ...record, ...patch, status: 'initializing' };
        } else {
          if (options?.registrationLease && isTerminalStatus(record.status) && patch.status !== record.status) {
            throw new SessionRegistrationSupersededError(sessionId, `stored session is ${record.status}`);
          }
          merged = mergeRecordMonotonic(record, patch);
        }
        if (merged !== record) {
          if (options?.immediate) {
            await this.store!.save(merged, { immediate: true });
          } else {
            await this.store!.save(merged);
          }
        } else if (options?.immediate) {
          // The terminal state may already be accepted in memory by an earlier
          // debounced mutation. Force that generation durable before teardown.
          this.store!.flush();
        }
      } else if (patch.sessionId) {
        // Initial save — treat patch as full record
        if (options?.immediate) {
          await this.store!.save(
            patch as import("../types.js").SessionRecord,
            { immediate: true },
          );
        } else {
          await this.store!.save(patch as import("../types.js").SessionRecord);
        }
      } else if (options?.immediate) {
        this.store!.flush();
      }
    });
  }

  /** Retrieve the persisted SessionRecord for a given session ID. Returns undefined if no store or record not found. */
  getSessionRecord(
    sessionId: string,
  ): import("../types.js").SessionRecord | undefined {
    return this.store?.get(sessionId);
  }

  /**
   * Cancel a session exactly once. Concurrent callers share one operation;
   * terminal sessions return an idempotent result instead of throwing.
   */
  async cancelSession(sessionId: string): Promise<CancelSessionResult> {
    const existing = this.cancellationOps.get(sessionId);
    if (existing) return existing;
    const operation = this.performCancelSession(sessionId);
    this.cancellationOps.set(sessionId, operation);
    try { return await operation; }
    finally {
      if (this.cancellationOps.get(sessionId) === operation) {
        this.cancellationOps.delete(sessionId);
        this.cancellingSessionIds.delete(sessionId);
      }
    }
  }

  private async performCancelSession(sessionId: string): Promise<CancelSessionResult> {
    const liveSession = this.sessions.get(sessionId);
    const teardownBefore = this.sessionTeardownOps.get(sessionId);
    const session = liveSession ?? teardownBefore?.session;
    const recordBefore = this.store?.get(sessionId);
    const terminalStatusBefore = this.getTerminalCancellationStatus(sessionId);
    // An already-durable terminal record is the winner even if an inconsistent
    // stale live object still exists. Otherwise the synchronous in-memory state wins.
    let previousStatus = isTerminalStatus(recordBefore?.status)
      ? recordBefore.status
      : session?.status ?? recordBefore?.status ?? terminalStatusBefore;
    if (!previousStatus) {
      const error = new Error(`Session "${sessionId}" not found`) as Error & { code?: string };
      error.code = 'SESSION_NOT_FOUND';
      throw error;
    }
    let alreadyTerminal = previousStatus === 'cancelled' || previousStatus === 'finished';
    let finalStatus: 'cancelled' | 'finished' = previousStatus === 'finished' ? 'finished' : 'cancelled';
    this.rememberTerminalCancellationStatus(sessionId, finalStatus);

    this.invalidateSessionRegistrations(sessionId, 'session cancellation started');
    // Stop all replacement/resume commits before the first durable await. The
    // remaining cancellation work may block on storage or process cleanup, but
    // switch factories must already observe the terminal boundary.
    const terminalDelivery = session?.status === 'finished'
      ? session.waitForTerminalDelivery()
      : null;
    session?.beginTermination();
    // If completion already won, its recipient snapshot owns bridge cleanup.
    // A cancellation winner still disconnects synchronously before durable I/O.
    if (!terminalDelivery) this.cleanupOwnedResources(sessionId);

    // Persist and flush the terminal winner before touching an agent or logger
    // that may fail during teardown. A terminal record written by an earlier
    // serialized mutation remains authoritative.
    if (this.store) {
      await this.withRecordMutation(sessionId, async () => {
        const record = this.store!.get(sessionId)
        if (!record) return;
        if (isTerminalStatus(record.status)) {
          previousStatus = record.status;
          finalStatus = record.status;
          alreadyTerminal = true;
          // A terminal working record may still be a debounced mutation while
          // disk contains an active session. Cancellation cannot tear down until
          // the accepted terminal generation is durable.
          this.store!.flush()
        } else {
          await this.store!.save(
            { ...record, status: finalStatus },
            { immediate: true },
          )
        }
      })
    }

    let cleanupPending = false
    let terminalDeliveryWarning: string | null = null
    if (session) {
      if (terminalDelivery) {
        await terminalDelivery;
        terminalDeliveryWarning = session.terminalDeliveryFailure;
        this.cleanupOwnedResources(sessionId);
      }
      if (!alreadyTerminal && finalStatus === 'cancelled') {
        session.markCancelled();
      }
      // Session.destroy owns prompt cancellation and subprocess teardown as one
      // shared operation. Awaiting abortPrompt first can deadlock here when an ACP
      // prompt ignores both cancellation and its local AbortSignal. The manager's
      // deadline keeps external DELETE/cancel requests bounded while the teardown
      // promise remains observed and shared for a later retry.
      const cleanup = await waitForSessionCleanup(this.startSessionTeardown(session));
      if (cleanup.status !== 'completed') {
        cleanupPending = true
        log.warn(
          {
            sessionId,
            error: cleanup.status === 'failed'
              ? redactNetworkSecrets(cleanup.error instanceof Error ? cleanup.error.message : String(cleanup.error))
              : `cleanup exceeded ${SESSION_CANCEL_CLEANUP_TIMEOUT_MS}ms`,
          },
          cleanup.status === 'failed'
            ? `Session is durably ${finalStatus} but agent/logger cleanup failed; repeat cancellation to retry cleanup`
            : `Session is durably ${finalStatus} but agent/logger cleanup is still running; repeat cancellation to observe cleanup`,
        )
      }
    }
    return {
      sessionId,
      cancelled: !alreadyTerminal,
      previousStatus,
      status: finalStatus,
      alreadyTerminal,
      cleanupPending,
      ...(cleanupPending
        ? { warning: `Session state is ${finalStatus} and persisted; process cleanup is pending. Repeat cancellation to retry cleanup.` }
        : terminalDeliveryWarning
          ? { warning: `Session state is ${finalStatus} and persisted; final channel delivery did not complete: ${redactNetworkSecrets(terminalDeliveryWarning)}` }
          : {}),
    };
  }

  /** List live (in-memory) sessions, optionally filtered by channel. Excludes assistant sessions. */
  listSessions(channelId?: string): Session[] {
    const all = Array.from(this.sessions.values()).filter(s => !s.isAssistant);
    if (channelId) return all.filter((s) => s.channelId === channelId);
    return all;
  }

  /** Additive diagnostics for internal sessions hidden from user listings. */
  getServiceResourceStatus(): SessionServiceResourceStatus {
    const assistants = Array.from(this.sessions.values()).filter((session) => session.isAssistant);
    const teardown = Array.from(this.sessionTeardownOps.values());
    return {
      assistant: {
        live: assistants.length,
        active: assistants.filter(
          (session) => session.status === 'active' || session.status === 'initializing',
        ).length,
      },
      terminalCleanup: {
        pending: teardown.filter((entry) => entry.state === 'pending').length,
        failed: teardown.filter((entry) => entry.state === 'failed').length,
      },
    };
  }

  /**
   * List all sessions (live + stored) as SessionSummary. Live sessions take precedence
   * over stored records — their real-time state (queueDepth, promptRunning) is used.
   */
  listAllSessions(channelId?: string): SessionSummary[] {
    if (this.store) {
      let records = this.store.list().filter(r => !r.isAssistant);
      if (channelId) records = records.filter((r) => r.channelId === channelId);
      const summaries: SessionSummary[] = records.map((record) => {
        const live = this.sessions.get(record.sessionId);
        // Durable terminal state is authoritative even while bounded process
        // cleanup leaves a stale in-memory identity behind.
        if (live && !isTerminalStatus(record.status)) {
          return {
            id: live.id,
            agent: live.agentName,
            status: live.status,
            name: live.name ?? null,
            workspace: live.workingDirectory,
            channelId: live.channelId,
            createdAt: live.createdAt.toISOString(),
            lastActiveAt: record.lastActiveAt ?? null,
            dangerousMode: live.clientOverrides.bypassPermissions ?? false,
            queueDepth: live.queueDepth,
            promptRunning: live.promptRunning,
            configOptions: live.configOptions?.length ? live.configOptions : undefined,
            capabilities: live.agentCapabilities ?? null,
            isLive: true,
          };
        }
        return {
          id: record.sessionId,
          agent: record.agentName,
          status: record.status,
          name: record.name ?? null,
          workspace: record.workingDir,
          channelId: record.channelId,
          createdAt: record.createdAt,
          lastActiveAt: record.lastActiveAt ?? null,
          dangerousMode: record.clientOverrides?.bypassPermissions ?? false,
          queueDepth: 0,
          promptRunning: false,
          configOptions: record.acpState?.configOptions,
          capabilities: record.acpState?.agentCapabilities ?? null,
          isLive: false,
        };
      });

      // A live session can briefly exist without a store record (for example while
      // an adapter is finishing its persistence step). Keep it visible in API and
      // health results instead of letting the store become an accidental filter.
      const storedIds = new Set(records.map((record) => record.sessionId));
      for (const live of this.listSessions(channelId)) {
        if (storedIds.has(live.id)) continue;
        summaries.push({
          id: live.id,
          agent: live.agentName,
          status: live.status,
          name: live.name ?? null,
          workspace: live.workingDirectory,
          channelId: live.channelId,
          createdAt: live.createdAt.toISOString(),
          lastActiveAt: null,
          dangerousMode: live.clientOverrides.bypassPermissions ?? false,
          queueDepth: live.queueDepth,
          promptRunning: live.promptRunning,
          configOptions: live.configOptions?.length ? live.configOptions : undefined,
          capabilities: live.agentCapabilities ?? null,
          isLive: true,
        });
      }
      return summaries;
    }

    // Fallback: no store — return live sessions only
    let live = Array.from(this.sessions.values()).filter(s => !s.isAssistant);
    if (channelId) live = live.filter((s) => s.channelId === channelId);
    return live.map((s) => ({
      id: s.id,
      agent: s.agentName,
      status: s.status,
      name: s.name ?? null,
      workspace: s.workingDirectory,
      channelId: s.channelId,
      createdAt: s.createdAt.toISOString(),
      lastActiveAt: null,
      dangerousMode: s.clientOverrides.bypassPermissions ?? false,
      queueDepth: s.queueDepth,
      promptRunning: s.promptRunning,
      configOptions: s.configOptions?.length ? s.configOptions : undefined,
      capabilities: s.agentCapabilities ?? null,
      isLive: true,
    }));
  }

  /** List all stored SessionRecords, optionally filtered by status. Excludes assistant sessions. */
  listRecords(filter?: {
    statuses?: string[];
  }): import("../types.js").SessionRecord[] {
    if (!this.store) return [];
    let records = this.store.list().filter(r => !r.isAssistant);
    if (filter?.statuses?.length) {
      records = records.filter((r) => filter.statuses!.includes(r.status));
    }
    return records;
  }

  /** Remove a session's stored record and emit a SESSION_DELETED event. */
  async removeRecord(sessionId: string): Promise<void> {
    this.terminalCancellationStatuses.delete(sessionId);
    if (!this.store) return;
    await this.withRecordMutation(sessionId, () => this.store!.remove(sessionId));
    this.eventBus?.emit(BusEvent.SESSION_DELETED, { sessionId });
  }

  /**
   * Graceful shutdown: persist session state without killing agent subprocesses.
   * Agent processes will exit naturally when the parent process terminates.
   */
  async shutdownAll(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.beginClosing('session manager shutdown started');
    const operation = this.performShutdownAll();
    this.closeOperation = operation;
    try {
      await operation;
    } catch (error) {
      if (!this._shutdownComplete && this.closeOperation === operation) {
        this.closeOperation = null;
      }
      throw error;
    }
  }

  private async performShutdownAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    if (this.store) {
      for (const session of sessions) {
        const record = this.store.get(session.id);
        if (record) {
          await this.patchRecord(session.id, {
            status: "finished",
            acpState: session.toAcpStateSnapshot(),
            clientOverrides: session.clientOverrides,
            currentPromptCount: session.promptCount,
            agentSwitchHistory: session.agentSwitchHistory,
          });
        }
      }
      this.store.flush();
    }
    this._shutdownComplete = true;
    this.sessions.clear();
    this.terminalCancellationStatuses.clear();
  }

  /**
   * Forcefully destroy all sessions (kill agent subprocesses).
   * Use only when sessions must be fully torn down (e.g. archive).
   * Unlike shutdownAll(), this does NOT snapshot live session state (acpState, etc.)
   * because destroyed sessions are terminal and will not be resumed.
   */
  async destroyAll(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.beginClosing('session manager destruction started');
    const operation = this.performDestroyAll();
    this.closeOperation = operation;
    try {
      await operation;
    } catch (error) {
      if (!this._shutdownComplete && this.closeOperation === operation) {
        this.closeOperation = null;
      }
      throw error;
    }
  }

  private async performDestroyAll(): Promise<void> {
    const sessions = [...this.sessions.values()];
    const sessionIds = sessions.map((session) => session.id);
    if (this.store) {
      for (const session of sessions) {
        const record = this.store.get(session.id);
        if (record) {
          await this.patchRecord(session.id, { status: "finished" });
        }
      }
      this.store.flush();
    }
    for (const session of sessions) await session.destroy();
    this._shutdownComplete = true;
    this.sessions.clear();
    this.terminalCancellationStatuses.clear();
    // Hook: session:afterDestroy — read-only, fire-and-forget
    if (this.middlewareChain) {
      for (const sessionId of sessionIds) {
        this.middlewareChain.execute(Hook.SESSION_AFTER_DESTROY, { sessionId }, async (p) => p).catch(() => {});
      }
    }
  }
}
