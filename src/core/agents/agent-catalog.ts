import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { AgentStore } from "./agent-store.js";
import {
  installAgent,
  recoverAgentTransactions,
  uninstallAgent,
  resolveDistribution,
} from "./agent-installer.js";
import { getAgentAlias, checkDependencies, checkRuntimeAvailable, commandExists } from "./agent-dependencies.js";
import {
  compareRunnerVersions,
  isImmutableRunnerPackageSpec,
  type RunnerVersionOrder,
} from "./agent-runner-spec.js";
import type {
  AgentDefinition,
  RegistryAgent,
  AgentListItem,
  AvailabilityResult,
  InstallProgress,
  InstallResult,
  InstalledAgent,
} from "../types.js";
import { createChildLogger } from "../utils/log.js";

const log = createChildLogger({ module: "agent-catalog" });

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const DEFAULT_TTL_HOURS = 24;
const MAX_CACHE_FUTURE_SKEW_MS = 5 * 60 * 1000;

interface RegistryCache {
  fetchedAt: string;
  ttlHours: number;
  data: { agents: RegistryAgent[] };
}

export type RegistrySource = "network" | "cache" | "snapshot" | "none";

export interface RegistryStatus {
  source: RegistrySource;
  stale: boolean;
  fetchedAt?: string;
  lastRefreshError?: string;
  /** The cache timestamp is invalid or too far ahead of the host clock. */
  cacheTimestampInvalid?: boolean;
  /** Registry metadata was usable, but installed-agent reconciliation could not be persisted. */
  reconciliationPending?: boolean;
  lastReconciliationError?: string;
  /** Automatic runner reconciliation was skipped because its safety could not be proven. */
  runnerReconciliationSkipped?: number;
  lastRunnerReconciliationWarning?: string;
  /** Entries rejected by strict validation in the most recently inspected registry payload. */
  invalidEntries?: number;
  lastValidationWarning?: string;
  /** Durable agent install/uninstall journals recovered during catalog startup. */
  recoveredAgentTransactions?: number;
  agentTransactionRecoveryPending?: boolean;
  lastAgentTransactionRecoveryError?: string;
}

export type RegistryRefreshResult =
  | { ok: true; refreshed: boolean; count: number; status: RegistryStatus }
  | { ok: false; refreshed: false; error: string; status: RegistryStatus };

/**
 * Central catalog of available and installed agents.
 *
 * Combines two data sources:
 *  1. **Registry** — the remote ACP agent registry (CDN-hosted JSON), cached
 *     locally with a 24-hour TTL and a bundled snapshot as fallback.
 *  2. **Store** — locally installed agents persisted in `agents.json`.
 *
 * Provides discovery (list all agents), installation, uninstallation,
 * and resolution (name → AgentDefinition for spawning).
 */
export class AgentCatalog {
  private store: AgentStore;
  /** Agents available in the remote registry (cached in memory after load). */
  private registryAgents: RegistryAgent[] = [];
  private cachePath: string;
  private registryStatus: RegistryStatus = { source: "none", stale: true };
  private registryRefreshInFlight: Promise<RegistryRefreshResult> | undefined;
  /** Directory where binary agent archives are extracted to. */
  private agentsDir: string | undefined;

  constructor(
    store: AgentStore,
    cachePath: string,
    agentsDir?: string,
    private scopedFetch: typeof fetch = globalThis.fetch,
    private registryUrl: string = REGISTRY_URL,
  ) {
    this.store = store;
    this.cachePath = cachePath;
    this.agentsDir = agentsDir;
  }

  /**
   * Load installed agents from disk and hydrate the registry from cache/snapshot.
   *
   * Also enriches installed agents with registry metadata — fixes agents that
   * were migrated from older config formats with incomplete data.
   */
  load(): void {
    this.store.load();
    this.loadRegistryFromCacheOrSnapshot();
    if (this.agentsDir) {
      const recovery = recoverAgentTransactions(this.store, this.agentsDir);
      if (recovery.recovered > 0) {
        this.registryStatus = {
          ...this.registryStatus,
          recoveredAgentTransactions: recovery.recovered,
        };
      }
      if (recovery.pending > 0 || recovery.errors.length > 0) {
        this.registryStatus = {
          ...this.registryStatus,
          agentTransactionRecoveryPending: true,
          lastAgentTransactionRecoveryError: recovery.errors[0]
            ?? `${recovery.pending} committed agent transaction cleanup operation(s) remain pending`,
        };
      }
    }
    this.enrichInstalledFromRegistry();
  }

  // --- Registry ---

  /** Fetch the latest registry, joining an already-running refresh if present. */
  fetchRegistry(): Promise<RegistryRefreshResult> {
    if (this.registryRefreshInFlight) return this.registryRefreshInFlight;
    const operation = this.performRegistryRefresh();
    this.registryRefreshInFlight = operation;
    void operation.finally(() => {
      if (this.registryRefreshInFlight === operation) this.registryRefreshInFlight = undefined;
    });
    return operation;
  }

  private async performRegistryRefresh(): Promise<RegistryRefreshResult> {
    let invalidEntries: number | undefined;
    try {
      log.info("Fetching agent registry from CDN...");
      const response = await this.scopedFetch(this.registryUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as { agents?: unknown };
      const validated = validateRegistryAgents(
        data.agents,
        allowsInsecureRegistryArchives(this.registryUrl),
      );
      if (!validated || (validated.inputCount > 0 && validated.agents.length === 0)) {
        invalidEntries = validated?.invalidEntries;
        throw new Error("Registry response has an invalid agents array");
      }
      invalidEntries = validated.invalidEntries;
      const registryData = { agents: validated.agents };

      const cache: RegistryCache = {
        fetchedAt: new Date().toISOString(),
        ttlHours: DEFAULT_TTL_HOURS,
        data: registryData,
      };
      this.persistRegistryCache(cache);
      this.registryAgents = registryData.agents;
      this.registryStatus = {
        source: "network",
        stale: false,
        fetchedAt: cache.fetchedAt,
        ...registryValidationStatus(validated.invalidEntries, "network"),
        ...agentTransactionRecoveryStatus(this.registryStatus),
      };
      this.enrichInstalledFromRegistry();
      log.info({ count: this.registryAgents.length }, "Registry updated");
      return {
        ok: true,
        refreshed: true,
        count: this.registryAgents.length,
        status: this.getRegistryStatus(),
      };
    } catch (err) {
      const error = formatRegistryError(err);
      this.registryStatus = {
        ...this.registryStatus,
        stale: true,
        lastRefreshError: error,
        ...(invalidEntries === undefined
          ? {}
          : registryValidationStatus(invalidEntries, "network response")),
      };
      log.warn({ error }, "Failed to fetch registry, using packaged or cached data");
      return {
        ok: false,
        refreshed: false,
        error,
        status: this.getRegistryStatus(),
      };
    }
  }

  /** Re-fetch registry only if the local cache has expired (24-hour TTL). */
  async refreshRegistryIfStale(): Promise<RegistryRefreshResult> {
    if (this.registryRefreshInFlight) return this.registryRefreshInFlight;
    if (this.isCacheStale()) {
      return this.fetchRegistry();
    }
    return {
      ok: true,
      refreshed: false,
      count: this.registryAgents.length,
      status: this.getRegistryStatus(),
    };
  }

  getRegistryStatus(): RegistryStatus {
    return { ...this.registryStatus };
  }

  getRegistryAgents(): RegistryAgent[] {
    return this.registryAgents;
  }

  getRegistryAgent(registryId: string): RegistryAgent | undefined {
    return this.registryAgents.find((a) => a.id === registryId);
  }

  /** Find a registry agent by registry ID or by its short alias (e.g., "claude"). */
  findRegistryAgent(keyOrId: string): RegistryAgent | undefined {
    const byId = this.registryAgents.find((a) => a.id === keyOrId);
    if (byId) return byId;
    return this.registryAgents.find((a) => getAgentAlias(a.id) === keyOrId);
  }

  // --- Installed ---

  getInstalled(): InstalledAgent[] {
    return Object.values(this.store.getInstalled());
  }

  getInstalledEntries(): Record<string, InstalledAgent> {
    return this.store.getInstalled();
  }

  getInstalledAgent(key: string): InstalledAgent | undefined {
    return this.store.getAgent(key);
  }

  // --- Discovery ---

  /**
   * Build the unified list of all agents (installed + registry-only).
   *
   * Installed agents appear first with their live availability status.
   * Registry agents that aren't installed yet show whether a distribution
   * exists for the current platform. Missing external dependencies
   * (e.g., claude CLI) are surfaced as `missingDeps` for UI display
   * but do NOT block installation.
   */
  getAvailable(): AgentListItem[] {
    const installed = this.getInstalledEntries();
    const items: AgentListItem[] = [];
    const seenKeys = new Set<string>();

    for (const [key, agent] of Object.entries(installed)) {
      seenKeys.add(key);
      const availability = agent.registryId
        ? checkDependencies(agent.registryId)
        : { available: true };
      const runtimeAvailable = agent.distribution === "npx" || agent.distribution === "uvx"
        ? checkRuntimeAvailable(agent.distribution)
        : agent.distribution === "binary"
          ? fs.existsSync(agent.command)
          : commandExists(agent.command);
      const registryEntry = agent.registryId
        ? this.registryAgents.find((a) => a.id === agent.registryId)
        : undefined;
      const registryDist = registryEntry ? resolveDistribution(registryEntry) : null;
      const expectedArgs = registryDist ? distributionArgs(registryDist) : undefined;
      const sameDistribution = Boolean(registryDist && registryDist.type === agent.distribution);
      const registryVersionOrder = registryEntry && sameDistribution
        ? compareDistributionVersions(agent.distribution, agent.version, registryEntry.version)
        : "unknown";
      const runnerDrift = Boolean(
        sameDistribution
        && (registryDist?.type === "npx" || registryDist?.type === "uvx")
        && expectedArgs
        && (agent.command !== registryDist.type || !arraysEqual(agent.args, expectedArgs)),
      );
      const updateRequired = Boolean(registryEntry && registryDist && (
        !sameDistribution
        || registryVersionOrder === -1
        || (registryVersionOrder === 0 && runnerDrift)
      ));
      items.push({
        key,
        registryId: agent.registryId ?? key,
        name: agent.name,
        version: agent.version,
        availableVersion: updateRequired ? registryEntry?.version : undefined,
        description: registryEntry?.description,
        distribution: agent.distribution,
        installed: true,
        updateRequired,
        available: availability.available && runtimeAvailable,
        missingDeps: [
          ...(availability.missing?.map((m) => m.label) ?? []),
          ...(!runtimeAvailable ? [agent.distribution === "binary" ? "installed binary" : agent.command] : []),
        ],
      });
    }

    for (const agent of this.registryAgents) {
      const alias = getAgentAlias(agent.id);
      if (seenKeys.has(alias)) continue;
      seenKeys.add(alias);

      const dist = resolveDistribution(agent);
      const availability = checkDependencies(agent.id);
      const runtimeAvailable = dist?.type === "npx" || dist?.type === "uvx"
        ? checkRuntimeAvailable(dist.type)
        : true;

      // An uninstalled agent is "available" (shows Install button) as long as a
      // distribution exists for this platform. Missing external dependencies
      // (e.g. claude CLI, codex CLI) are surfaced via missingDeps so the UI can
      // show post-install setup instructions — they should NOT block installation.
      items.push({
        key: alias,
        registryId: agent.id,
        name: agent.name,
        version: agent.version,
        description: agent.description,
        distribution: dist?.type ?? "binary",
        installed: false,
        available: dist !== null && runtimeAvailable,
        missingDeps: [
          ...(availability.missing?.map((m) => m.label) ?? []),
          ...(!runtimeAvailable && dist ? [dist.type] : []),
        ],
      });
    }

    return items;
  }

  /** Check if an agent can be installed on this system (platform + dependencies). */
  checkAvailability(keyOrId: string): AvailabilityResult {
    const agent = this.findRegistryAgent(keyOrId);
    if (!agent) return { available: false, reason: "Not found in the agent registry." };

    const dist = resolveDistribution(agent);
    if (!dist) {
      return { available: false, reason: `Not available for your system. Check ${agent.website ?? agent.repository ?? "their website"} for other options.` };
    }

    if ((dist.type === "npx" || dist.type === "uvx") && !checkRuntimeAvailable(dist.type)) {
      return {
        available: false,
        reason: `${dist.type} is required to install and run this agent.`,
        missing: [{ label: dist.type, installHint: dist.type === "uvx" ? "pip install uv" : "Install Node.js with npm" }],
      };
    }

    return checkDependencies(agent.id);
  }

  // --- Install/Uninstall ---

  /**
   * Install an agent from the registry.
   *
   * Resolves the distribution (npx/uvx/binary), downloads binary archives
   * if needed, and persists the agent definition in the store.
   */
  async install(keyOrId: string, progress?: InstallProgress, force?: boolean): Promise<InstallResult> {
    const agent = this.findRegistryAgent(keyOrId);
    if (!agent) {
      const msg = `"${keyOrId}" was not found in the agent registry. Run "openacp agents" to see what's available.`;
      await progress?.onError(msg);
      return { ok: false, agentKey: keyOrId, error: msg };
    }

    return installAgent(
      agent,
      this.store,
      progress,
      this.agentsDir,
      this.scopedFetch,
      { force: force === true },
    );
  }

  /**
   * Register an agent directly into the catalog store without going through
   * the registry installer. Used to pre-register bundled agents (e.g. Claude)
   * when their CLI dependency is not yet installed.
   */
  registerFallbackAgent(key: string, data: InstalledAgent): void {
    this.store.addAgent(key, data);
  }

  /** Remove an installed agent and delete its binary directory if applicable. */
  async uninstall(key: string): Promise<{ ok: boolean; error?: string }> {
    if (this.store.hasAgent(key)) {
      await uninstallAgent(key, this.store, this.agentsDir);
      return { ok: true };
    }
    return { ok: false, error: `"${key}" is not installed.` };
  }

  // --- Resolution (for AgentManager) ---

  /** Convert an installed agent's short key to an AgentDefinition for spawning. */
  resolve(key: string): AgentDefinition | undefined {
    const agent = this.store.getAgent(key);
    if (!agent) return undefined;
    return {
      name: key,
      command: agent.command,
      args: agent.args,
      workingDirectory: agent.workingDirectory,
      env: agent.env,
      initTimeoutMs: agent.initTimeoutMs,
    };
  }

  // --- Internal ---

  /**
   * Enrich installed agents (especially migrated ones) with registry data.
   * Fixes agents that were migrated with version:"unknown", distribution:"custom",
   * or generic names by matching them to registry entries.
   */
  private enrichInstalledFromRegistry(): void {
    const installed = this.store.getInstalled();
    let changed = false;
    let runnerReconciliationSkipped = 0;
    let lastRunnerReconciliationWarning: string | undefined;

    const skipRunnerReconciliation = (reason: string): void => {
      runnerReconciliationSkipped++;
      lastRunnerReconciliationWarning = reason;
    };

    for (const [key, agent] of Object.entries(installed)) {
      const regAgent = agent.registryId
        ? this.registryAgents.find((a) => a.id === agent.registryId)
        : this.registryAgents.find((a) => getAgentAlias(a.id) === key);

      if (!regAgent) continue;

      const currentDist = resolveDistribution(regAgent);
      let updated = false;

      if (!currentDist || currentDist.type !== agent.distribution) {
        if (currentDist) {
          skipRunnerReconciliation("Installed and registry runner distributions differ; explicit installation is required");
        }
        continue;
      }

      const versionOrder = compareDistributionVersions(
        agent.distribution,
        agent.version,
        regAgent.version,
      );

      if (agent.distribution === "npx" || agent.distribution === "uvx") {
        const installedRunnerIsTruthful = agent.command === agent.distribution
          && typeof agent.args[0] === "string"
          && isImmutableRunnerPackageSpec(agent.distribution, agent.args[0], agent.version);
        const registryRunnerIsTruthful = currentDist.type === agent.distribution
          && isImmutableRunnerPackageSpec(currentDist.type, currentDist.package, regAgent.version);
        if (!installedRunnerIsTruthful || !registryRunnerIsTruthful || versionOrder === "unknown") {
          skipRunnerReconciliation("Runner version or package metadata is not safely comparable; explicit installation is required");
          continue;
        }

        if (versionOrder === -1) {
          const args = distributionArgs(currentDist);
          agent.command = currentDist.type;
          agent.args = args;
          agent.env = { ...currentDist.env, ...agent.env };
          agent.version = regAgent.version;
          if (agent.name !== regAgent.name) agent.name = regAgent.name;
          if (!agent.registryId) agent.registryId = regAgent.id;
          updated = true;
        } else if (versionOrder === 0) {
          // Equal ecosystem versions may differ textually (notably PEP 440), but
          // the installed runner/version identity remains the source of truth.
          if (agent.name !== regAgent.name) {
            agent.name = regAgent.name;
            updated = true;
          }
          if (!agent.registryId) {
            agent.registryId = regAgent.id;
            updated = true;
          }
        }
      } else if (versionOrder === 0) {
        // Binary/custom runtimes are never replaced during catalog reads. Only
        // exact-version cosmetic metadata may be enriched safely.
        if (agent.name !== regAgent.name) {
          agent.name = regAgent.name;
          updated = true;
        }
        if (!agent.registryId) {
          agent.registryId = regAgent.id;
          updated = true;
        }
      } else if (versionOrder === "unknown") {
        skipRunnerReconciliation("Installed and registry versions are not safely comparable; explicit installation is required");
      }
      if (updated) changed = true;
    }

    if (runnerReconciliationSkipped > 0) {
      this.registryStatus = {
        ...this.registryStatus,
        runnerReconciliationSkipped,
        lastRunnerReconciliationWarning,
      };
    } else {
      const {
        runnerReconciliationSkipped: _skipped,
        lastRunnerReconciliationWarning: _warning,
        ...status
      } = this.registryStatus;
      this.registryStatus = status;
    }

    if (changed) {
      try {
        const merge = this.store.replaceInstalled(installed);
        if (merge.conflictKeys.length > 0) {
          const diagnostic = `${merge.conflictKeys.length} installed agent definition(s) changed concurrently and were retained; reconciliation will retry`;
          this.registryStatus = {
            ...this.registryStatus,
            reconciliationPending: true,
            lastReconciliationError: diagnostic,
          };
          log.warn({ conflicts: merge.conflictKeys.length }, diagnostic);
          return;
        }
        const { reconciliationPending: _pending, lastReconciliationError: _error, ...status } = this.registryStatus;
        this.registryStatus = status;
        log.info("Enriched installed agents with registry data");
      } catch (err) {
        const diagnostic = "Installed agent metadata reconciliation could not be persisted; existing definitions remain active";
        this.registryStatus = {
          ...this.registryStatus,
          reconciliationPending: true,
          lastReconciliationError: diagnostic,
        };
        log.warn({ err }, diagnostic);
      }
    } else if (this.registryStatus.reconciliationPending) {
      const { reconciliationPending: _pending, lastReconciliationError: _error, ...status } = this.registryStatus;
      this.registryStatus = status;
    }
  }

  private isCacheStale(): boolean {
    if (!fs.existsSync(this.cachePath)) return true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.cachePath, "utf-8") as string) as RegistryCache;
      return classifyCacheFreshness(raw).stale;
    } catch {
      return true;
    }
  }

  private persistRegistryCache(cache: RegistryCache): void {
    const cacheDir = path.dirname(this.cachePath);
    const tmpPath = path.join(
      cacheDir,
      `.${path.basename(this.cachePath)}-${process.pid}-${crypto.randomUUID()}.tmp`,
    );
    fs.mkdirSync(cacheDir, { recursive: true });
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      fs.renameSync(tmpPath, this.cachePath);
    } catch (error) {
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch (cleanupError) {
        log.warn({ cleanupError }, "Failed to remove an incomplete registry cache write");
      }
      throw error;
    }
  }

  private loadRegistryFromCacheOrSnapshot(): void {
    // Try cache first
    if (fs.existsSync(this.cachePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.cachePath, "utf-8") as string) as RegistryCache;
        const validated = validateRegistryAgents(
          raw.data?.agents,
          allowsInsecureRegistryArchives(this.registryUrl),
        );
        if (validated && (validated.inputCount === 0 || validated.agents.length > 0)) {
          const freshness = classifyCacheFreshness(raw);
          this.registryAgents = validated.agents;
          this.registryStatus = {
            source: "cache",
            stale: freshness.stale,
            fetchedAt: raw.fetchedAt,
            ...(freshness.timestampInvalid ? { cacheTimestampInvalid: true } : {}),
            ...registryValidationStatus(validated.invalidEntries, "cache"),
          };
          log.debug({ count: this.registryAgents.length }, "Loaded registry from cache");
          return;
        }
      } catch {
        log.warn("Failed to load registry cache");
      }
    }

    // Fallback: bundled snapshot
    try {
      // Try multiple paths for tsc and tsup builds
      const candidates = [
        path.join(import.meta.dirname, "data", "registry-snapshot.json"),
        path.join(import.meta.dirname, "..", "data", "registry-snapshot.json"),
        path.join(import.meta.dirname, "..", "..", "data", "registry-snapshot.json"),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          const raw = JSON.parse(fs.readFileSync(candidate, "utf-8") as string) as { agents?: unknown };
          const validated = validateRegistryAgents(raw.agents);
          if (!validated || (validated.inputCount > 0 && validated.agents.length === 0)) continue;
          this.registryAgents = validated.agents;
          this.registryStatus = {
            source: "snapshot",
            stale: true,
            ...registryValidationStatus(validated.invalidEntries, "snapshot"),
          };
          log.debug({ count: this.registryAgents.length }, "Loaded registry from bundled snapshot");
          return;
        }
      }

      log.warn("No registry data available (no cache, no snapshot)");
      this.registryStatus = { source: "none", stale: true };
    } catch {
      log.warn("Failed to load bundled registry snapshot");
      this.registryStatus = { source: "none", stale: true };
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyCacheFreshness(cache: Pick<RegistryCache, "fetchedAt" | "ttlHours">): {
  stale: boolean;
  timestampInvalid: boolean;
} {
  const now = Date.now();
  const fetchedAt = new Date(cache.fetchedAt).getTime();
  const ttlHours = cache.ttlHours ?? DEFAULT_TTL_HOURS;
  const timestampInvalid = !Number.isFinite(fetchedAt) || fetchedAt > now + MAX_CACHE_FUTURE_SKEW_MS;
  const ttlInvalid = !Number.isFinite(ttlHours) || ttlHours <= 0;
  if (timestampInvalid || ttlInvalid) return { stale: true, timestampInvalid };
  return {
    stale: now - fetchedAt > ttlHours * 60 * 60 * 1000,
    timestampInvalid: false,
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function distributionArgs(
  dist: Exclude<ReturnType<typeof resolveDistribution>, null>,
): string[] {
  if (dist.type === "binary") return dist.args;
  return [dist.package, ...dist.args];
}

function formatRegistryError(error: unknown): string {
  if (error instanceof Error && /^HTTP \d{3}$/.test(error.message)) {
    return `ACP Registry request failed (${error.message})`;
  }
  return "ACP Registry could not be reached or returned invalid data";
}

interface ValidatedRegistryAgents {
  agents: RegistryAgent[];
  inputCount: number;
  invalidEntries: number;
}

function validateRegistryAgents(
  value: unknown,
  allowInsecureHttp = false,
): ValidatedRegistryAgents | undefined {
  if (!Array.isArray(value)) return undefined;
  const agents: RegistryAgent[] = [];
  const seenIds = new Set<string>();
  let invalidEntries = 0;
  for (const candidate of value) {
    if (!isRegistryAgent(candidate, allowInsecureHttp) || seenIds.has(candidate.id)) {
      invalidEntries++;
      continue;
    }
    seenIds.add(candidate.id);
    agents.push(candidate);
  }
  return { agents, inputCount: value.length, invalidEntries };
}

function registryValidationStatus(
  invalidEntries: number,
  source: string,
): Pick<RegistryStatus, "invalidEntries" | "lastValidationWarning"> {
  if (invalidEntries === 0) return {};
  return {
    invalidEntries,
    lastValidationWarning: `${invalidEntries} invalid or duplicate agent registry entr${invalidEntries === 1 ? "y was" : "ies were"} skipped from ${source}`,
  };
}

function agentTransactionRecoveryStatus(
  status: RegistryStatus,
): Pick<RegistryStatus, "recoveredAgentTransactions" | "agentTransactionRecoveryPending" | "lastAgentTransactionRecoveryError"> {
  return {
    ...(status.recoveredAgentTransactions === undefined
      ? {}
      : { recoveredAgentTransactions: status.recoveredAgentTransactions }),
    ...(status.agentTransactionRecoveryPending === undefined
      ? {}
      : { agentTransactionRecoveryPending: status.agentTransactionRecoveryPending }),
    ...(status.lastAgentTransactionRecoveryError === undefined
      ? {}
      : { lastAgentTransactionRecoveryError: status.lastAgentTransactionRecoveryError }),
  };
}

function allowsInsecureRegistryArchives(registryUrl: string): boolean {
  try {
    return new URL(registryUrl).protocol === "http:";
  } catch {
    return false;
  }
}

function isRegistryAgent(value: unknown, allowInsecureHttp = false): value is RegistryAgent {
  if (!isPlainRecord(value)) return false;
  if (!isBoundedString(value.id, 1, 128) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id)) return false;
  if (!isBoundedString(value.name, 1, 256)) return false;
  if (!isBoundedString(value.version, 1, 128)) return false;
  if (!isBoundedString(value.description, 1, 8_192)) return false;
  return isRegistryDistribution(value.distribution, value.version, allowInsecureHttp);
}

function isRegistryDistribution(value: unknown, registryVersion: string, allowInsecureHttp: boolean): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length === 0 || keys.some((key) => !["npx", "uvx", "binary"].includes(key))) return false;
  if ("npx" in value && !isRunnerDistribution(value.npx, "npx", registryVersion)) return false;
  if ("uvx" in value && !isRunnerDistribution(value.uvx, "uvx", registryVersion)) return false;
  if ("binary" in value && !isBinaryDistribution(value.binary, allowInsecureHttp)) return false;
  return true;
}

function isRunnerDistribution(
  value: unknown,
  runner: "npx" | "uvx",
  registryVersion: string,
): boolean {
  if (!isPlainRecord(value)) return false;
  if (Object.keys(value).some((key) => !["package", "args", "env"].includes(key))) return false;
  if (!isBoundedString(value.package, 1, 512)
    || !isImmutableRunnerPackageSpec(runner, value.package, registryVersion)) return false;
  return isRegistryArgs(value.args) && isRegistryEnv(value.env);
}

function isBinaryDistribution(value: unknown, allowInsecureHttp: boolean): boolean {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) return false;
  return Object.entries(value).every(([platform, target]) => {
    if (!/^(?:darwin|linux|windows)-(?:aarch64|x86_64)$/.test(platform)) return false;
    if (!isPlainRecord(target)) return false;
    if (Object.keys(target).some((key) => !["archive", "cmd", "args", "env", "sha256"].includes(key))) return false;
    if (!isSecureRegistryUrl(target.archive, allowInsecureHttp) || !isSafeRelativeCommand(target.cmd)) return false;
    if (!isRegistryArgs(target.args) || !isRegistryEnv(target.env)) return false;
    return target.sha256 === undefined
      || (typeof target.sha256 === "string" && /^[a-fA-F0-9]{64}$/.test(target.sha256));
  });
}

function isRegistryArgs(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value)
      && value.length <= 128
      && value.every((arg) => isBoundedString(arg, 1, 4_096) && !/[\u0000]/.test(arg)));
}

function isRegistryEnv(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainRecord(value) || Object.keys(value).length > 128) return false;
  return Object.entries(value).every(([key, envValue]) => (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    && isBoundedString(envValue, 0, 16_384)
    && !envValue.includes("\0")
  ));
}

function isSecureRegistryUrl(value: unknown, allowInsecureHttp: boolean): boolean {
  if (!isBoundedString(value, 1, 4_096)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "https:" || (allowInsecureHttp && parsed.protocol === "http:"))
      && parsed.hostname.length > 0
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function isSafeRelativeCommand(value: unknown): boolean {
  if (!isBoundedString(value, 1, 1_024) || value.includes("\0")) return false;
  const portable = value.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(value)) return false;
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  return segments.length > 0 && !segments.includes("..");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function compareDistributionVersions(
  distribution: InstalledAgent["distribution"],
  current: string,
  available: string,
): RunnerVersionOrder {
  if (distribution === "npx" || distribution === "uvx") {
    return compareRunnerVersions(distribution, current, available);
  }
  // Binary registry releases predominantly use SemVer, but malformed or
  // calendar-style legacy values remain deliberately incomparable.
  if (distribution === "binary") return compareRunnerVersions("npx", current, available);
  return "unknown";
}
