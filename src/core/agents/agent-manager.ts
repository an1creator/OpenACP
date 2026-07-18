import type { AgentDefinition } from "../types.js";
import { AgentInstance, type InitializationCleanupResourceStatus } from "./agent-instance.js";
import type { AgentCatalog } from "./agent-catalog.js";
import { createChildLogger } from "../utils/log.js";
import { filterEnv } from '../security/env-filter.js';
import type { ProxyService } from '../network/proxy-service.js';
import { redactNetworkSecrets } from '../security/network-redaction.js';

const log = createChildLogger({ module: "agent-manager" });

const WARM_TTL_MS = 5 * 60 * 1000; // 5 minutes
const WARM_CLEANUP_MAX_ATTEMPTS = 3;
const WARM_CLEANUP_RETRY_BASE_MS = 250;
const WARM_SHUTDOWN_RETRY_BASE_MS = 25;

interface WarmEntry {
  agentName: string;
  workingDir: string;
  /**
   * The allowedPaths set baked into the warm instance's PathGuard at spawn time.
   * Must match the requested set on takeWarm — different paths produce a
   * different security boundary, so a mismatched warm is not safe to claim.
   */
  allowedPaths: readonly string[];
  instance: AgentInstance;
  createdAt: number;
  policyGeneration: number;
  /** Canonical JSON identity of the exact definition/environment/path boundary used to spawn. */
  definitionFingerprint: string;
}

interface ResolvedWarmRuntime {
  definition: AgentDefinition;
  environment: Record<string, string>;
  fingerprint: string;
}

interface WarmCleanup {
  entry: WarmEntry;
  state: 'pending' | 'failed';
  attempts: number;
  reason: string;
  operation: Promise<boolean> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  lastError?: string;
}

export interface WarmPoolResourceStatus {
  state: 'empty' | 'warming' | 'ready' | 'claiming' | 'cleanupPending' | 'failed' | 'closing';
  capacity: 1;
  agent?: string;
  createdAt?: string;
  expiresAt?: string;
  cleanupAttempts?: number;
  lastError?: string;
}

/**
 * Order-insensitive equality on two path lists. Used to decide whether a warm
 * instance's PathGuard configuration matches a fresh request.
 */
function pathListsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

/**
 * Canonical JSON serialization is compared directly rather than hashed, so
 * equality has no digest-collision failure mode. Object-key order is cosmetic;
 * array order (notably runner arguments) remains significant.
 */
function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Agent definition contains a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('Agent definition contains a non-serializable value');
}

function createDefinitionFingerprint(
  definition: AgentDefinition,
  workingDir: string,
  allowedPaths: readonly string[],
  environment: Readonly<Record<string, string>>,
): string {
  return canonicalJson({
    definition,
    workingDir,
    allowedPaths: [...allowedPaths].sort(),
    environment,
  });
}

/**
 * High-level facade for spawning and resuming agent instances.
 *
 * Resolves agent names to definitions via AgentCatalog, then delegates
 * to AgentInstance for subprocess management. Used by SessionFactory
 * to create the agent backing a session.
 *
 * Maintains a single-slot warm pool: one pre-initialized AgentInstance
 * (subprocess spawned + ACP initialize done) is kept ready so the next
 * createSession only pays for the newSession RPC (~300ms) instead of a
 * full subprocess spawn (~2–3s).
 *
 * Agent switching (swapping the agent mid-session) is coordinated at the
 * Session layer — AgentManager only handles individual spawn/resume calls.
 */
export class AgentManager {
  private warmEntry: WarmEntry | null = null;
  /** In-flight prewarm promise — guards against concurrent prewarm calls. */
  private warming: Promise<void> | null = null;
  private warmExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private warmGeneration = 0;
  private warmPoolClosing = false;
  private warmCleanup: WarmCleanup | null = null;
  private warmClaiming: WarmEntry | null = null;
  private warmClaimOperation: Promise<void> | null = null;
  private warmShutdownOperation: Promise<void> | null = null;

  constructor(private catalog: AgentCatalog, private proxyService?: ProxyService) {
    if (proxyService?.registerScope) for (const name of Object.keys(catalog.getInstalledEntries())) proxyService.registerScope(`agents.${name}`)
  }
  private currentPolicyGeneration(): number {
    return typeof this.proxyService?.getPolicyGeneration === 'function' ? this.proxyService.getPolicyGeneration() : 0
  }

  private childEnv(agentDef: AgentDefinition, routeName = agentDef.name): Record<string, string> | undefined {
    if (!this.proxyService) return undefined
    const filtered = filterEnv(process.env as Record<string, string>, agentDef.env)
    return this.proxyService.buildAgentEnv(routeName, filtered)
  }

  /** Resolve, snapshot, and fingerprint the exact subprocess inputs without logging their values. */
  private resolveWarmRuntime(
    agentName: string,
    workingDir: string,
    allowedPaths: readonly string[],
  ): ResolvedWarmRuntime | null {
    try {
      const resolved = this.catalog.resolve(agentName);
      if (!resolved) return null;
      const definition = structuredClone(resolved);
      const environment = structuredClone(
        this.childEnv(definition, agentName)
          ?? filterEnv(process.env as Record<string, string>, definition.env),
      );
      return {
        definition,
        environment,
        fingerprint: createDefinitionFingerprint(definition, workingDir, allowedPaths, environment),
      };
    } catch {
      log.warn({ agentName }, 'Agent definition could not be fingerprinted');
      return null;
    }
  }

  private clearWarmExpiryTimer(): void {
    if (this.warmExpiryTimer) clearTimeout(this.warmExpiryTimer);
    this.warmExpiryTimer = null;
  }

  private clearWarmCleanupRetry(cleanup = this.warmCleanup): void {
    if (cleanup?.retryTimer) clearTimeout(cleanup.retryTimer);
    if (cleanup) cleanup.retryTimer = null;
  }

  private scheduleWarmCleanupRetry(cleanup: WarmCleanup): void {
    if (
      this.warmPoolClosing ||
      this.warmCleanup !== cleanup ||
      cleanup.state !== 'failed' ||
      cleanup.attempts >= WARM_CLEANUP_MAX_ATTEMPTS
    ) return;
    this.clearWarmCleanupRetry(cleanup);
    const delay = WARM_CLEANUP_RETRY_BASE_MS * (2 ** (cleanup.attempts - 1));
    cleanup.retryTimer = setTimeout(() => {
      cleanup.retryTimer = null;
      if (this.warmCleanup !== cleanup || cleanup.state !== 'failed') return;
      void this.beginWarmCleanup(cleanup.entry, cleanup.reason);
    }, delay);
    cleanup.retryTimer.unref?.();
  }

  /**
   * Destroy one warm resource through a shared, retryable ownership boundary.
   * The slot remains occupied until destroy confirms success, so diagnostics
   * never report `empty` while the subprocess may still exist.
   */
  private beginWarmCleanup(
    entry: WarmEntry,
    reason: string,
    scheduleRetry = true,
  ): Promise<boolean> {
    const existing = this.warmCleanup;
    if (existing?.entry === entry && existing.state === 'pending' && existing.operation) {
      return existing.operation;
    }
    if (existing && existing.entry !== entry) {
      return Promise.resolve(false);
    }

    const cleanup = existing ?? {
      entry,
      state: 'failed' as const,
      attempts: 0,
      reason,
      operation: null,
      retryTimer: null,
    };
    this.clearWarmCleanupRetry(cleanup);
    cleanup.state = 'pending';
    cleanup.reason = reason;
    cleanup.attempts += 1;
    cleanup.lastError = undefined;
    this.warmCleanup = cleanup;

    const operation = Promise.resolve().then(() => entry.instance.destroy()).then(
      () => {
        if (this.warmEntry === entry) this.warmEntry = null;
        if (this.warmClaiming === entry) this.warmClaiming = null;
        if (this.warmCleanup === cleanup) this.warmCleanup = null;
        return true;
      },
      (error: unknown) => {
        cleanup.state = 'failed';
        cleanup.lastError = redactNetworkSecrets(
          error instanceof Error ? error.message : String(error),
        );
        log.warn(
          { error: cleanup.lastError, agentName: entry.agentName, attempts: cleanup.attempts, reason },
          'Warm-pool cleanup failed; ownership retained',
        );
        if (scheduleRetry) this.scheduleWarmCleanupRetry(cleanup);
        return false;
      },
    ).finally(() => {
      if (this.warmCleanup === cleanup) cleanup.operation = null;
    });
    cleanup.operation = operation;
    return operation;
  }

  private scheduleWarmExpiry(entry: WarmEntry): void {
    this.clearWarmExpiryTimer();
    const generation = this.warmGeneration;
    this.warmExpiryTimer = setTimeout(() => {
      this.warmExpiryTimer = null;
      if (
        this.warmPoolClosing ||
        this.warmGeneration !== generation ||
        this.warmEntry !== entry
      ) return;
      log.debug(
        { agentName: entry.agentName, workingDir: entry.workingDir },
        'Warm-pool: TTL expired — background reaper destroying warm instance',
      );
      void this.beginWarmCleanup(entry, 'ttl-expired');
    }, WARM_TTL_MS);
    this.warmExpiryTimer.unref?.();
  }

  getWarmPoolResourceStatus(): WarmPoolResourceStatus {
    const cleanup = this.warmCleanup;
    if (cleanup && this.warmEntry === cleanup.entry) {
      return {
        state: cleanup.state === 'pending' ? 'cleanupPending' : 'failed',
        capacity: 1,
        agent: cleanup.entry.agentName,
        createdAt: new Date(cleanup.entry.createdAt).toISOString(),
        expiresAt: new Date(cleanup.entry.createdAt + WARM_TTL_MS).toISOString(),
        cleanupAttempts: cleanup.attempts,
        ...(cleanup.lastError ? { lastError: cleanup.lastError } : {}),
      };
    }
    if (this.warmClaiming) {
      return {
        state: 'claiming',
        capacity: 1,
        agent: this.warmClaiming.agentName,
        createdAt: new Date(this.warmClaiming.createdAt).toISOString(),
        expiresAt: new Date(this.warmClaiming.createdAt + WARM_TTL_MS).toISOString(),
      };
    }
    if (this.warmPoolClosing) return { state: 'closing', capacity: 1 };
    if (this.warmEntry) {
      return {
        state: 'ready',
        capacity: 1,
        agent: this.warmEntry.agentName,
        createdAt: new Date(this.warmEntry.createdAt).toISOString(),
        expiresAt: new Date(this.warmEntry.createdAt + WARM_TTL_MS).toISOString(),
      };
    }
    return { state: this.warming ? 'warming' : 'empty', capacity: 1 };
  }

  /** Failed handshakes remain owned by AgentInstance until child exit is confirmed. */
  getInitializationCleanupResourceStatus(): InitializationCleanupResourceStatus {
    return AgentInstance.getInitializationCleanupResourceStatus();
  }

  /** Return definitions for all installed agents. */
  getAvailableAgents(): AgentDefinition[] {
    return Object.keys(this.catalog.getInstalledEntries())
      .flatMap((key) => {
        const definition = this.catalog.resolve(key);
        return definition ? [definition] : [];
      });
  }

  /** Look up a single agent definition by its short name (e.g., "claude", "gemini"). */
  getAgent(name: string): AgentDefinition | undefined {
    return this.catalog.resolve(name);
  }

  /**
   * Spawn-and-initialize one AgentInstance in the background for the given
   * agent/workingDir/allowedPaths. Safe to call repeatedly — a second call
   * while warming is in flight is a no-op (logged at debug), and a call while
   * a valid warm entry with matching params already exists is a no-op.
   *
   * If a warm entry exists with mismatched params, cleanup retains the slot
   * until destroy succeeds; only then can a replacement prewarm begin.
   */
  prewarm(agentName: string, workingDir: string, allowedPaths: readonly string[] = []): void {
    if (this.warmPoolClosing) return;
    if (this.warming || this.warmClaiming || this.warmCleanup) {
      log.debug(
        { requestedAgent: agentName, requestedWorkingDir: workingDir },
        "prewarm: another warm spawn already in flight; request dropped",
      );
      return;
    }
    const runtime = this.resolveWarmRuntime(agentName, workingDir, allowedPaths);
    if (!runtime) {
      log.debug({ agentName }, "prewarm: agent not installed or definition invalid, skipping");
      return;
    }
    if (this.warmEntry) {
      const e = this.warmEntry;
      if (
        e.agentName === agentName &&
        e.workingDir === workingDir &&
        pathListsEqual(e.allowedPaths, allowedPaths) &&
        e.definitionFingerprint === runtime.fingerprint
      ) {
        return; // exact match — no-op
      }
      // Mismatched entry — retain ownership until cleanup succeeds. A later
      // caller can request another prewarm after a failed cleanup retry.
      this.clearWarmExpiryTimer();
      void this.beginWarmCleanup(e, 'prewarm-mismatch').then((destroyed) => {
        if (destroyed && !this.warmPoolClosing) {
          this.prewarm(agentName, workingDir, allowedPaths);
        }
      });
      return;
    }
    const policyGeneration = this.currentPolicyGeneration()
    const warmGeneration = this.warmGeneration
    this.warming = (async () => {
      try {
        const instance = await AgentInstance.spawnSubprocess(
          runtime.definition,
          workingDir,
          [...allowedPaths],
          runtime.environment,
        );
        const entry: WarmEntry = {
          agentName,
          workingDir,
          allowedPaths: [...allowedPaths],
          instance,
          createdAt: Date.now(),
          policyGeneration,
          definitionFingerprint: runtime.fingerprint,
        };
        const currentRuntime = this.resolveWarmRuntime(agentName, workingDir, allowedPaths);
        const lifecycleInvalidated = this.warmPoolClosing
          || this.warmGeneration !== warmGeneration
          || this.currentPolicyGeneration() !== policyGeneration;
        // Invalidated candidates cross the same owned cleanup boundary; shutdown
        // can retry a rejected destroy instead of orphaning the process.
        if (
          lifecycleInvalidated ||
          currentRuntime?.fingerprint !== entry.definitionFingerprint
        ) {
          this.warmEntry = entry;
          const reason = lifecycleInvalidated
            ? 'prewarm-invalidated'
            : currentRuntime
              ? 'definition-changed-during-prewarm'
              : 'definition-unavailable-after-prewarm';
          await this.beginWarmCleanup(
            entry,
            reason,
            !this.warmPoolClosing,
          );
          return;
        }
        this.warmEntry = entry;
        this.scheduleWarmExpiry(this.warmEntry);
        log.info({ agentName, workingDir }, "Agent warm-pool: instance ready");
      } catch (err) {
        log.warn({ err, agentName }, "Agent warm-pool: prewarm failed");
      } finally {
        this.warming = null;
      }
    })();
  }

  /**
   * Destroy the warm instance (if any) and clear the slot. Called from the
   * server shutdown path so the warm subprocess does not outlive its parent.
   * Best-effort — errors are swallowed since shutdown should not fail.
   */
  async destroyWarm(): Promise<void> {
    this.warmGeneration += 1;
    this.clearWarmExpiryTimer();
    // A route/config change may race with an in-flight prewarm. Wait for that
    // spawn to settle so the old-policy process cannot repopulate the slot.
    const inFlight = this.warming;
    if (inFlight) {
      try { await inFlight; } catch { /* prewarm already logs failures */ }
    }
    const claim = this.warmClaimOperation;
    if (claim) await claim.catch(() => {});
    const entry = this.warmEntry;
    if (entry) await this.beginWarmCleanup(entry, 'destroy-warm');
  }

  /** Permanently close the warm-pool lifecycle during daemon shutdown. */
  async shutdownWarmPool(): Promise<void> {
    if (this.warmShutdownOperation) return this.warmShutdownOperation;
    this.warmPoolClosing = true;
    const operation = (async () => {
      this.warmGeneration += 1;
      this.clearWarmExpiryTimer();
      this.clearWarmCleanupRetry();
      if (this.warming) await this.warming.catch(() => {});
      if (this.warmClaimOperation) await this.warmClaimOperation.catch(() => {});
      for (let attempt = 0; attempt < WARM_CLEANUP_MAX_ATTEMPTS; attempt++) {
        const entry = this.warmEntry;
        if (!entry) break;
        const destroyed = await this.beginWarmCleanup(entry, 'shutdown', false);
        if (destroyed) break;
        if (attempt + 1 < WARM_CLEANUP_MAX_ATTEMPTS) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, WARM_SHUTDOWN_RETRY_BASE_MS * (2 ** attempt));
          });
        }
      }
      await AgentInstance.shutdownInitializationCleanups();
    })();
    this.warmShutdownOperation = operation;
    try {
      await operation;
    } finally {
      if (this.warmShutdownOperation === operation) this.warmShutdownOperation = null;
    }
  }

  /**
   * Take the warm instance if it matches the given agent/workingDir/allowedPaths
   * AND is alive AND has not exceeded its TTL. Mismatch and failure branches
   * retain owned cleanup state; a matching entry remains owned as `claiming`
   * until claimForSession either transfers or releases it.
   *
   * `allowedPaths` is part of the match key because it is baked into the
   * subprocess's PathGuard at spawn time and cannot be safely re-applied
   * post-hoc on a warm instance.
   */
  private takeWarm(
    agentName: string,
    workingDir: string,
    allowedPaths: readonly string[],
  ): WarmEntry | null {
    const entry = this.warmEntry;
    if (!entry || this.warmCleanup || this.warmClaiming) return null;
    if (entry.agentName !== agentName || entry.workingDir !== workingDir) return null;
    if (entry.policyGeneration !== this.currentPolicyGeneration()) {
      this.clearWarmExpiryTimer();
      void this.beginWarmCleanup(entry, 'proxy-policy-changed');
      return null;
    }
    if (!pathListsEqual(entry.allowedPaths, allowedPaths)) {
      // Security-relevant mismatch: PathGuard differs. Discard and clear.
      log.debug(
        { agentName, workingDir },
        "Warm-pool: allowedPaths mismatch on takeWarm — discarding warm",
      );
      this.clearWarmExpiryTimer();
      void this.beginWarmCleanup(entry, 'allowed-paths-mismatch');
      return null;
    }
    const currentRuntime = this.resolveWarmRuntime(agentName, workingDir, allowedPaths);
    if (!currentRuntime || currentRuntime.fingerprint !== entry.definitionFingerprint) {
      this.clearWarmExpiryTimer();
      void this.beginWarmCleanup(
        entry,
        currentRuntime ? 'definition-changed-before-claim' : 'definition-unavailable-before-claim',
      );
      return null;
    }
    if (Date.now() - entry.createdAt > WARM_TTL_MS) {
      log.debug({ agentName, workingDir }, "Warm-pool: TTL expired — discarding warm");
      this.clearWarmExpiryTimer();
      void this.beginWarmCleanup(entry, 'ttl-expired-on-claim');
      return null;
    }
    if (entry.instance.isDead) {
      log.warn(
        { agentName, workingDir },
        "Warm-pool: instance died before claim — discarding",
      );
      this.clearWarmExpiryTimer();
      // Subprocess is gone but listeners and StderrCapture are still referenced.
      void this.beginWarmCleanup(entry, 'dead-before-claim');
      return null;
    }
    this.clearWarmExpiryTimer();
    this.warmClaiming = entry;
    return entry;
  }

  /**
   * Spawn a new agent subprocess with a fresh session.
   *
   * When a warm instance is available for the requested agent/workingDir, it is
   * claimed (only the newSession RPC is paid) instead of a full subprocess spawn.
   * After a successful warm claim, a background refill is kicked off so the next
   * caller also benefits.
   *
   * @throws If the agent is not installed — includes install instructions in the error message.
   */
  async spawn(
    agentName: string,
    workingDirectory: string,
    allowedPaths?: string[],
  ): Promise<AgentInstance> {
    const requestedPaths = allowedPaths ?? [];

    // Fast path: claim the warm instance if it matches (agent + workingDir + allowedPaths).
    const warmEntry = this.takeWarm(agentName, workingDirectory, requestedPaths);
    if (warmEntry) {
      const warm = warmEntry.instance;
      const claimOperation = (async () => {
        try {
          await warm.claimForSession(workingDirectory);
          const currentRuntime = this.resolveWarmRuntime(agentName, workingDirectory, requestedPaths);
          if (!currentRuntime || currentRuntime.fingerprint !== warmEntry.definitionFingerprint) {
            throw new Error('Agent definition changed while claiming the warm process');
          }
          if (this.warmEntry === warmEntry) this.warmEntry = null;
          if (this.warmClaiming === warmEntry) this.warmClaiming = null;
        } catch (error) {
          if (this.warmClaiming === warmEntry) this.warmClaiming = null;
          await this.beginWarmCleanup(warmEntry, 'claim-failed');
          throw error;
        }
      })();
      this.warmClaimOperation = claimOperation.then(() => undefined, () => undefined);
      try {
        await claimOperation;
        // Refill in background for the next caller.
        this.prewarm(agentName, workingDirectory, requestedPaths);
        return warm;
      } catch (err) {
        log.warn({ err, agentName }, "Warm claim failed — falling back to fresh spawn");
        // fall through to regular spawn
      } finally {
        this.warmClaimOperation = null;
      }
    }

    const freshRuntime = this.resolveWarmRuntime(agentName, workingDirectory, requestedPaths);
    if (!freshRuntime) {
      throw new Error(
        `Agent "${agentName}" is not installed. Run "openacp agents install ${agentName}" to add it.`,
      );
    }
    return AgentInstance.spawn(
      freshRuntime.definition,
      workingDirectory,
      undefined,
      allowedPaths,
      freshRuntime.environment,
    );
  }

  /**
   * Spawn a subprocess and resume an existing agent session.
   *
   * Falls back to a new session if the agent cannot restore the given session ID.
   * Resume does not use the warm pool — it requires a specific existing session.
   */
  async resume(
    agentName: string,
    workingDirectory: string,
    agentSessionId: string,
    allowedPaths?: string[],
  ): Promise<AgentInstance> {
    const agentDef = this.getAgent(agentName);
    if (!agentDef) {
      throw new Error(
        `Agent "${agentName}" is not installed. Run "openacp agents install ${agentName}" to add it.`,
      );
    }
    const environment = this.childEnv(agentDef, agentName)
    return environment
      ? AgentInstance.resume(agentDef, workingDirectory, agentSessionId, undefined, allowedPaths, environment)
      : AgentInstance.resume(agentDef, workingDirectory, agentSessionId, undefined, allowedPaths);
  }
}
