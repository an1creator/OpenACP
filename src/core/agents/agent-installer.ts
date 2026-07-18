/**
 * Agent installation and uninstallation logic.
 *
 * Handles three distribution types:
 *  - **npx** — Node package runner (no download, resolved on first use)
 *  - **uvx** — Python package runner (no download, resolved on first use)
 *  - **binary** — pre-built archive downloaded and extracted to `~/.openacp/agents/`
 *
 * Binary archives are validated before and after extraction to prevent
 * path traversal attacks and symlink escapes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createChildLogger } from "../utils/log.js";
import type { InstalledAgent, RegistryAgent, InstallProgress, InstallResult } from "../types.js";
import { getAgentAlias, checkDependencies, checkRuntimeAvailable, getAgentSetup } from "./agent-dependencies.js";
import { isImmutableRunnerPackageSpec } from "./agent-runner-spec.js";
import { AgentStore } from "./agent-store.js";

const log = createChildLogger({ module: "agent-installer" });

const DEFAULT_AGENTS_DIR = path.join(os.homedir(), ".openacp", "agents");
const INSTALL_LOCK_WAIT_ATTEMPTS = 200;
const INSTALL_LOCK_WAIT_MS = 10;
const INSTALL_LOCK_STALE_MS = 30_000;

export const MAX_DOWNLOAD_SIZE = 500 * 1024 * 1024; // 500MB
const MAX_COMMITTED_CLEANUPS_PER_INSTALL = 8;

/** Verify SHA-256 checksum of a downloaded binary archive. */
export function verifyChecksum(buffer: Buffer, expectedHash: string): void {
  if (!/^[a-fA-F0-9]{64}$/.test(expectedHash)) {
    throw new Error("Integrity check failed: registry SHA-256 digest is invalid");
  }
  const actualHash = crypto.createHash("sha256").update(buffer).digest("hex");
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(
      `Integrity check failed: expected ${expectedHash}, got ${actualHash}`,
    );
  }
}

/**
 * Validate archive entries before extraction to prevent path traversal attacks.
 *
 * Rejects entries containing `..` path segments or absolute paths that could
 * write files outside the destination directory.
 */
export function validateArchiveContents(entries: string[], destDir: string): void {
  for (const entry of entries) {
    const portable = entry.replaceAll("\\", "/");
    // Check for path traversal segments, not just substring — avoids false positives
    // on filenames like "setup..sh" or "..config" that are not traversal attacks.
    const segments = portable.split("/");
    if (segments.includes("..")) {
      throw new Error(`Archive contains unsafe path traversal: ${entry}`);
    }
    if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(entry)) {
      throw new Error(`Archive contains unsafe absolute path: ${entry}`);
    }
  }
}

/** Resolve a registry command under its installation root on every host platform. */
export function resolveBinaryCommandPath(rootDir: string, commandPath: string): string {
  const portable = commandPath.replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(commandPath)) {
    throw new Error("Registered agent command must be relative to its installation directory");
  }
  const segments = portable.split("/").filter((segment) => segment && segment !== ".");
  if (segments.includes("..")) {
    throw new Error("Registered agent command escapes its installation directory");
  }
  const resolved = path.resolve(rootDir, ...segments);
  const root = path.resolve(rootDir);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error("Registered agent command escapes its installation directory");
  }
  return resolved;
}

export type BinaryPayloadKind = "zip" | "tar-gzip" | "tar-bzip2" | "raw";

/** Classify registry payloads by the URL pathname, ignoring query strings/fragments. */
export function getBinaryPayloadKind(archiveUrl: string): BinaryPayloadKind {
  let pathname: string;
  try {
    pathname = new URL(archiveUrl).pathname.toLowerCase();
  } catch {
    pathname = archiveUrl.split(/[?#]/, 1)[0]!.toLowerCase();
  }
  if (pathname.endsWith(".zip")) return "zip";
  if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) return "tar-gzip";
  if (pathname.endsWith(".tar.bz2") || pathname.endsWith(".tbz2")) return "tar-bzip2";
  return "raw";
}

/** @deprecated Use validateArchiveContents instead */
export const validateTarContents = validateArchiveContents;

/** Safety check: refuse to delete paths outside the agents directory during uninstall. */
export function validateUninstallPath(binaryPath: string, agentsDir: string): void {
  const realPath = path.resolve(binaryPath);
  const realAgentsDir = path.resolve(agentsDir);
  if (!realPath.startsWith(realAgentsDir + path.sep) && realPath !== realAgentsDir) {
    throw new Error(`Refusing to delete path outside agents directory: ${realPath}`);
  }
}

// Map Node's os.arch/platform values to the naming convention used by the
// ACP agent registry's binary distribution targets.
const ARCH_MAP: Record<string, string> = {
  arm64: "aarch64",
  x64: "x86_64",
};

const PLATFORM_MAP: Record<string, string> = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
};

/** Build a platform-arch key (e.g., "darwin-aarch64") for binary distribution lookup. */
export function getPlatformKey(): string {
  const platform = PLATFORM_MAP[process.platform] ?? process.platform;
  const arch = ARCH_MAP[process.arch] ?? process.arch;
  return `${platform}-${arch}`;
}

export type ResolvedDistribution =
  | { type: "npx"; package: string; args: string[]; env?: Record<string, string> }
  | { type: "uvx"; package: string; args: string[]; env?: Record<string, string> }
  | {
      type: "binary";
      archive: string;
      cmd: string;
      args: string[];
      env?: Record<string, string>;
      sha256?: string;
    };

/**
 * Determine how to run an agent on this platform.
 *
 * Returns the distribution type (npx/uvx/binary) with all necessary
 * metadata, or null if no distribution exists for the current platform.
 */
export function resolveDistribution(agent: RegistryAgent): ResolvedDistribution | null {
  const dist = agent.distribution;

  if (dist.npx) {
    return { type: "npx", package: dist.npx.package, args: dist.npx.args ?? [], env: dist.npx.env };
  }
  if (dist.uvx) {
    return { type: "uvx", package: dist.uvx.package, args: dist.uvx.args ?? [], env: dist.uvx.env };
  }
  if (dist.binary) {
    const platformKey = getPlatformKey();
    const target = dist.binary[platformKey];
    if (!target) return null;
    return {
      type: "binary",
      archive: target.archive,
      cmd: target.cmd,
      args: target.args ?? [],
      env: target.env,
      sha256: target.sha256,
    };
  }
  return null;
}

/**
 * Build an InstalledAgent record from a resolved distribution.
 *
 * For npx/uvx agents, the reviewed registry package spec is retained exactly.
 * This keeps the stored version and the runtime selected by the package runner aligned.
 */
export function buildInstalledAgent(
  registryId: string,
  name: string,
  version: string,
  dist: ResolvedDistribution,
  binaryPath?: string,
): InstalledAgent {
  if (dist.type === "npx") {
    assertImmutableRunnerPackageSpec("npx", dist.package, version);
    return {
      registryId, name, version, distribution: "npx",
      command: "npx", args: [dist.package, ...dist.args],
      env: dist.env ?? {}, installedAt: new Date().toISOString(), binaryPath: null,
    };
  }
  if (dist.type === "uvx") {
    assertImmutableRunnerPackageSpec("uvx", dist.package, version);
    return {
      registryId, name, version, distribution: "uvx",
      command: "uvx", args: [dist.package, ...dist.args],
      env: dist.env ?? {}, installedAt: new Date().toISOString(), binaryPath: null,
    };
  }
  // binary
  const absCmd = resolveBinaryCommandPath(binaryPath!, dist.cmd);
  return {
    registryId, name, version, distribution: "binary",
    command: absCmd, args: dist.args,
    env: dist.env ?? {}, installedAt: new Date().toISOString(), binaryPath: binaryPath!,
  };
}

function assertImmutableRunnerPackageSpec(
  runner: "npx" | "uvx",
  packageSpec: string,
  version: string,
): void {
  if (!isImmutableRunnerPackageSpec(runner, packageSpec, version)) {
    throw new Error(`${runner} package spec must select exactly registry version ${version}`);
  }
}

/**
 * Install an agent from the registry.
 *
 * Steps:
 *  1. Resolve distribution type for the current platform
 *  2. Check runtime availability (uvx/npx must exist)
 *  3. Check external CLI dependencies (non-blocking — surfaced as setup steps)
 *  4. Download and extract binary archives (binary type only)
 *  5. Save to the agent store
 *  6. Return setup instructions for post-install configuration
 */
export async function installAgent(
  agent: RegistryAgent,
  store: AgentStore,
  progress?: InstallProgress,
  agentsDir?: string,
  scopedFetch: typeof fetch = globalThis.fetch,
  options: AgentInstallOptions = { force: true },
): Promise<InstallResult> {
  const agentKey = getAgentAlias(agent.id);
  await progress?.onStart(agent.id, agent.name);

  // 1. Resolve distribution
  const dist = resolveDistribution(agent);
  if (!dist) {
    const platformKey = getPlatformKey();
    const msg = `${agent.name} is not available for your system (${platformKey}). Check their website for other install options.`;
    await progress?.onError(msg);
    return { ok: false, agentKey, error: msg };
  }
  if ((dist.type === "npx" || dist.type === "uvx")
    && !isImmutableRunnerPackageSpec(dist.type, dist.package, agent.version)) {
    const msg = `${agent.name} has an invalid ${dist.type} package spec. The registry package must select exactly v${agent.version}.`;
    await progress?.onError(msg);
    return { ok: false, agentKey, error: msg };
  }

  // 2. Check runtime availability (hard requirement — uvx/npx must exist to run)
  if (dist.type === "uvx" && !checkRuntimeAvailable("uvx")) {
    const msg = `${agent.name} requires Python's uvx tool.\nInstall it with: pip install uv`;
    await progress?.onError(msg, "pip install uv");
    return { ok: false, agentKey, error: msg, hint: "pip install uv" };
  }
  if (dist.type === "npx" && !checkRuntimeAvailable("npx")) {
    const msg = `${agent.name} requires the npx package runner.\nInstall a supported Node.js distribution that includes npm and npx.`;
    await progress?.onError(msg, "Install Node.js 22 or newer with npm");
    return { ok: false, agentKey, error: msg, hint: "Install Node.js 22 or newer with npm" };
  }

  // 3. Check external CLI dependencies (non-blocking — install proceeds, setup steps
  //    guide the user to install required CLIs afterward)
  const depResult = checkDependencies(agent.id);

  // 4. Prepare the runtime. Network access and archive tools stay outside the
  //    per-agent transaction lock so one slow download cannot block another
  //    OpenACP operation.
  let binaryPath: string | undefined;
  let binaryTransaction: BinaryInstallTransaction | undefined;

  if (dist.type === "binary") {
    try {
      binaryTransaction = await prepareBinaryInstall(
        agent.id,
        dist.archive,
        dist.cmd,
        dist.sha256,
        progress,
        agentsDir,
        scopedFetch,
      );
      binaryPath = binaryTransaction.destination;
    } catch (err) {
      const rollback = binaryTransaction?.rollback();
      const msg = rollback?.previousRuntime === "preserved"
        ? `Failed to activate ${agent.name}. The previous runtime could not be restored automatically; its recovery backup was preserved.`
        : `Failed to download ${agent.name}. Please try again or install manually.`;
      log.warn({ err, rollback, agentId: agent.id }, "Binary agent installation failed");
      await progress?.onError(msg);
      return { ok: false, agentKey, error: msg };
    }
  } else {
    await progress?.onStep("Setting up... (will download on first use)");
  }

  // 5. Serialize activation and metadata persistence for this agent. Lock
  //    ordering is always per-agent install lock -> short-lived AgentStore
  //    lock; no call path may acquire them in the opposite order.
  const installed = buildInstalledAgent(agent.id, agent.name, agent.version, dist, binaryPath);
  const rootDir = agentsDir ?? DEFAULT_AGENTS_DIR;
  let cleanup: BinaryCommitResult | undefined;
  let installError: unknown;
  let rollback: BinaryRollbackResult | undefined;
  let lock: number | undefined;
  let journal: BinaryInstallJournal | undefined;
  let journalWritten = false;
  let metadataPersisted = false;
  let metadataRestored = true;
  let binaryCommitted = false;
  let previousAgent: InstalledAgent | undefined;
  let lockedDecision: InstallResult | undefined;

  try {
    lock = acquireAgentInstallLock(rootDir, agent.id);
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agent.id)) {
      recoverInterruptedBinaryInstall(rootDir, agent.id, store);
      recoverInterruptedBinaryUninstall(rootDir, agent.id, store);
    }
    if (binaryTransaction) {
      cleanupCommittedBinaryArtifacts(rootDir, agent.id);
    }
    // Re-read after waiting for the transaction lock. A competing install may
    // have completed while this process was downloading its staged runtime.
    store.load();
    previousAgent = store.getAgent(agentKey);

    if (previousAgent && options.force !== true) {
      rollback = binaryTransaction?.rollback();
      if (previousAgent.registryId === agent.id && previousAgent.version === agent.version) {
        lockedDecision = { ok: true, agentKey, alreadyInstalled: true };
      } else {
        const msg = `${agent.name} is already installed as v${previousAgent.version}. Use --force to replace it with v${agent.version}.`;
        lockedDecision = { ok: false, agentKey, error: msg };
      }
    } else {
      if (binaryTransaction) {
        journal = {
          version: 1,
          agentId: agent.id,
          agentKey,
          transactionId: binaryTransaction.transactionId,
          phase: "prepared",
          createdAt: Date.now(),
          previousAgent: previousAgent ?? null,
          nextAgent: installed,
        };
        writeBinaryInstallJournal(rootDir, journal);
        journalWritten = true;
        binaryTransaction.activate();
        journal.phase = "activated";
        writeBinaryInstallJournal(rootDir, journal);
      }

      store.addAgent(agentKey, installed);
      metadataPersisted = true;

      if (binaryTransaction && journal) {
        journal.phase = "metadata-committed";
        writeBinaryInstallJournal(rootDir, journal);
        try {
          cleanup = binaryTransaction.commit();
          binaryCommitted = true;
          try {
            removeBinaryInstallJournal(rootDir, agent.id);
          } catch (journalError) {
            cleanup = { cleanupPending: true, cleanupRetryable: true };
            log.warn({ journalError, agentId: agent.id }, "Agent install committed; journal cleanup will be retried");
          }
        } catch (err) {
          // Metadata and runtime are already authoritative. Preserve the journal
          // so the next locked install can retry cleanup instead of rolling back.
          binaryCommitted = true;
          cleanup = { cleanupPending: true, cleanupRetryable: true };
          log.warn({ err, agentId: agent.id }, "Agent install committed; cleanup will be recovered later");
        }
      }
    }
  } catch (err) {
    installError = err;
    if (!binaryCommitted) rollback = binaryTransaction?.rollback();
    if (metadataPersisted && !binaryCommitted) {
      try {
        if (previousAgent) store.addAgent(agentKey, previousAgent);
        else store.removeAgent(agentKey, installed);
      } catch (restoreError) {
        metadataRestored = false;
        log.error({ restoreError, agentId: agent.id }, "Could not restore agent metadata after failed activation");
      }
    }
    if (journalWritten
      && metadataRestored
      && rollback?.previousRuntime !== "preserved"
      && !rollback?.cleanupPending) {
      try {
        removeBinaryInstallJournal(rootDir, agent.id);
      } catch (journalError) {
        log.warn({ journalError, agentId: agent.id }, "Failed install journal will be recovered later");
      }
    }
  } finally {
    if (lock !== undefined) releaseAgentInstallLock(rootDir, agent.id, lock);
  }

  if (lockedDecision) {
    if (rollback?.cleanupPending) {
      const msg = `No changes were made to ${agent.name}, but its inactive staged runtime could not be removed automatically.`;
      await progress?.onError(msg);
      return { ok: false, agentKey, error: msg };
    }
    if (lockedDecision.ok) {
      await progress?.onStep(`${agent.name} v${agent.version} is already installed; no changes were made.`);
    } else {
      await progress?.onError(lockedDecision.error!);
    }
    return lockedDecision;
  }

  if (installError) {
    const msg = rollback?.previousRuntime === "preserved"
      ? `Failed to save ${agent.name}. The previous runtime could not be restored automatically; its recovery backup was preserved.`
      : rollback?.cleanupPending
        ? `Failed to save ${agent.name}. The incomplete runtime could not be removed automatically; manual cleanup may be required.`
        : rollback?.previousRuntime === "restored"
          ? `Failed to save ${agent.name}. The previous installation was restored.`
          : `Failed to save ${agent.name}. No runtime or metadata changes were kept.`;
    log.warn({ err: installError, rollback, agentId: agent.id }, "Agent activation transaction failed");
    await progress?.onError(msg);
    return { ok: false, agentKey, error: msg };
  }

  // 6. Build setup steps: prefer agent-specific steps; fall back to dep install hints
  const setup = getAgentSetup(agent.id);
  const setupSteps = setup?.setupSteps ?? (
    depResult.missing?.map((m) => `${m.label}: ${m.installHint}`) ?? []
  );

  await progress?.onSuccess(agent.name);
  return {
    ok: true,
    agentKey,
    setupSteps: setupSteps.length > 0 ? setupSteps : undefined,
    ...(cleanup?.cleanupPending
      ? {
          cleanupPending: true,
          cleanupRetryable: cleanup.cleanupRetryable,
          cleanupMessage: cleanup.cleanupRetryable
            ? "The agent is installed, but cleanup of the previous runtime is pending and will be retried on the next install"
            : "The agent is installed, but an unmarked recovery artifact could not be removed automatically; manual cleanup may be required",
        }
      : {}),
  };
}

export interface AgentInstallOptions {
  /** Explicitly allow replacing any currently installed version for this agent key. */
  force?: boolean;
}

interface BinaryCommitResult {
  cleanupPending: boolean;
  cleanupRetryable: boolean;
}

interface BinaryRollbackResult {
  previousRuntime: "none" | "restored" | "preserved";
  cleanupPending: boolean;
}

type BinaryInstallPhase = "prepared" | "activated" | "metadata-committed";
type BinaryUninstallPhase = "prepared" | "runtime-moved" | "metadata-removed";

interface BinaryInstallJournal {
  version: 1;
  agentId: string;
  agentKey: string;
  transactionId: string;
  phase: BinaryInstallPhase;
  createdAt: number;
  previousAgent: InstalledAgent | null;
  nextAgent: InstalledAgent;
}

interface BinaryUninstallJournal {
  version: 1;
  agentId: string;
  agentKey: string;
  transactionId: string;
  phase: BinaryUninstallPhase;
  createdAt: number;
  previousAgent: InstalledAgent;
  runtimePath: string;
}

export interface AgentTransactionRecoveryResult {
  recovered: number;
  pending: number;
  errors: string[];
}

export class AgentInstallBusyError extends Error {
  constructor() {
    super("Another process is updating this agent");
    this.name = "AgentInstallBusyError";
  }
}

class AgentInstallRecoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentInstallRecoveryError";
  }
}

function agentInstallStatePaths(rootDir: string, agentId: string): {
  lockDir: string;
  lockPath: string;
  journalPath: string;
  uninstallJournalPath: string;
} {
  const identity = crypto.createHash("sha256").update(agentId).digest("hex").slice(0, 32);
  const lockDir = path.join(rootDir, ".locks");
  return {
    lockDir,
    lockPath: path.join(lockDir, `${identity}.lock`),
    journalPath: path.join(lockDir, `${identity}.transaction.json`),
    uninstallJournalPath: path.join(lockDir, `${identity}.uninstall.json`),
  };
}

function acquireAgentInstallLock(rootDir: string, agentId: string): number {
  const { lockDir, lockPath } = agentInstallStatePaths(rootDir, agentId);
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < INSTALL_LOCK_WAIT_ATTEMPTS; attempt++) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      fs.fsyncSync(fd);
      return fd;
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* best effort */ }
        try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (removeStaleAgentInstallLock(lockPath)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, INSTALL_LOCK_WAIT_MS);
    }
  }
  throw new AgentInstallBusyError();
}

function releaseAgentInstallLock(rootDir: string, agentId: string, fd: number): void {
  const { lockPath } = agentInstallStatePaths(rootDir, agentId);
  try { fs.closeSync(fd); } catch { /* best effort */ }
  try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
}

function removeStaleAgentInstallLock(lockPath: string): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8") as string) as {
      pid?: number;
      createdAt?: number;
    };
    const old = !Number.isFinite(lock.createdAt)
      || Date.now() - Number(lock.createdAt) > INSTALL_LOCK_STALE_MS;
    let dead = false;
    if (Number.isInteger(lock.pid)) {
      try { process.kill(lock.pid!, 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (dead || (old && !Number.isInteger(lock.pid))) {
      fs.unlinkSync(lockPath);
      return true;
    }
  } catch {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > INSTALL_LOCK_STALE_MS) {
        fs.unlinkSync(lockPath);
        return true;
      }
    } catch { /* A competing process may have released it. */ }
  }
  return false;
}

function writeBinaryInstallJournal(rootDir: string, journal: BinaryInstallJournal): void {
  const { lockDir, journalPath } = agentInstallStatePaths(rootDir, journal.agentId);
  writeAgentTransactionJournal(lockDir, journalPath, journal);
}

function writeBinaryUninstallJournal(rootDir: string, journal: BinaryUninstallJournal): void {
  const { lockDir, uninstallJournalPath } = agentInstallStatePaths(rootDir, journal.agentId);
  writeAgentTransactionJournal(lockDir, uninstallJournalPath, journal);
}

function writeAgentTransactionJournal(
  lockDir: string,
  journalPath: string,
  journal: BinaryInstallJournal | BinaryUninstallJournal,
): void {
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const tmpPath = `${journalPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const fd = fs.openSync(tmpPath, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmpPath, journalPath);
    try {
      const dirFd = fs.openSync(lockDir, "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch { /* Directory fsync is not supported on every platform. */ }
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* Preserve the write error. */ }
    throw error;
  }
}

function removeBinaryInstallJournal(rootDir: string, agentId: string): void {
  fs.rmSync(agentInstallStatePaths(rootDir, agentId).journalPath, { force: true });
}

function removeBinaryUninstallJournal(rootDir: string, agentId: string): void {
  fs.rmSync(agentInstallStatePaths(rootDir, agentId).uninstallJournalPath, { force: true });
}

function binaryUninstallBackup(rootDir: string, agentId: string, transactionId: string): string {
  const identity = crypto.createHash("sha256").update(agentId).digest("hex").slice(0, 16);
  return path.join(rootDir, `.${identity}-${transactionId}.uninstall`);
}

function recoverInterruptedBinaryInstall(rootDir: string, agentId: string, store: AgentStore): boolean {
  const { journalPath } = agentInstallStatePaths(rootDir, agentId);
  if (!fs.existsSync(journalPath)) return false;

  let journal: BinaryInstallJournal;
  try {
    const candidate = JSON.parse(fs.readFileSync(journalPath, "utf8") as string) as unknown;
    if (!isBinaryInstallJournal(candidate, agentId)) {
      throw new Error("invalid transaction journal");
    }
    journal = candidate;
  } catch (error) {
    throw new AgentInstallRecoveryError(
      "An interrupted agent install has an invalid recovery journal",
      { cause: error },
    );
  }

  const destination = path.join(rootDir, agentId);
  const stem = path.join(rootDir, `.${agentId}-${journal.transactionId}`);
  const staging = `${stem}.tmp`;
  const backup = `${stem}.backup`;
  const cleanup = `${stem}.cleanup`;
  const cleanupMarker = `${stem}.committed`;
  const runtimeMarker = binaryTransactionMarker(destination, journal.transactionId);
  store.load();
  const current = store.getAgent(journal.agentKey);
  const currentIsNext = isDeepStrictEqual(current, journal.nextAgent);
  const destinationExists = fs.existsSync(destination);
  const transactionRuntimeActive = fs.existsSync(runtimeMarker);

  if (currentIsNext && destinationExists && transactionRuntimeActive
    && journal.phase !== "metadata-committed") {
    // Persist the observed commit point before cleanup. If cleanup itself is
    // interrupted, a later recovery must still keep this matching runtime.
    journal.phase = "metadata-committed";
    writeBinaryInstallJournal(rootDir, journal);
  }
  if (currentIsNext
    && destinationExists
    && (transactionRuntimeActive || journal.phase === "metadata-committed")) {
    // The metadata commit is the point of no return. Finish cleanup and keep
    // the matching activated runtime.
    fs.rmSync(runtimeMarker, { force: true });
    for (const artifact of [cleanup, backup, staging, cleanupMarker]) {
      fs.rmSync(artifact, { recursive: true, force: true });
    }
    removeBinaryInstallJournal(rootDir, agentId);
    log.info({ agentId }, "Recovered a committed binary agent installation");
    return true;
  }

  // Metadata was not committed (or no matching runtime survived). Restore the
  // previous runtime and metadata without touching an unrelated destination.
  if (transactionRuntimeActive) fs.rmSync(destination, { recursive: true, force: true });
  if (fs.existsSync(backup)) {
    if (fs.existsSync(destination)) {
      throw new AgentInstallRecoveryError(
        "An interrupted agent install left both an active runtime and a recovery backup",
      );
    }
    fs.renameSync(backup, destination);
  }
  if (journal.previousAgent?.binaryPath === destination && !fs.existsSync(destination)) {
    throw new AgentInstallRecoveryError("The previous agent runtime could not be recovered");
  }
  if (currentIsNext) {
    if (journal.previousAgent) store.addAgent(journal.agentKey, journal.previousAgent);
    else store.removeAgent(journal.agentKey, journal.nextAgent);
  }
  for (const artifact of [staging, cleanup, cleanupMarker]) {
    fs.rmSync(artifact, { recursive: true, force: true });
  }
  removeBinaryInstallJournal(rootDir, agentId);
  log.info({ agentId }, "Rolled back an interrupted binary agent installation");
  return true;
}

type BinaryUninstallRecoveryOutcome = "none" | "rolled-back" | "completed" | "superseded" | "cleanup-pending";

function recoverInterruptedBinaryUninstall(
  rootDir: string,
  agentId: string,
  store: AgentStore,
): BinaryUninstallRecoveryOutcome {
  const { uninstallJournalPath } = agentInstallStatePaths(rootDir, agentId);
  if (!fs.existsSync(uninstallJournalPath)) return "none";

  let journal: BinaryUninstallJournal;
  try {
    const candidate = JSON.parse(fs.readFileSync(uninstallJournalPath, "utf8") as string) as unknown;
    if (!isBinaryUninstallJournal(candidate, agentId)) {
      throw new Error("invalid uninstall transaction journal");
    }
    journal = candidate;
  } catch (error) {
    throw new AgentInstallRecoveryError(
      "An interrupted agent uninstall has an invalid recovery journal",
      { cause: error },
    );
  }

  validateUninstallPath(journal.runtimePath, rootDir);
  const backupPath = binaryUninstallBackup(rootDir, agentId, journal.transactionId);
  store.load();
  const current = store.getAgent(journal.agentKey);
  const metadataStillOwnsPreviousRuntime = ownsSameBinaryRuntimeActivation(current, journal.previousAgent);

  if (metadataStillOwnsPreviousRuntime) {
    // CAS did not commit. Cosmetic registry reconciliation may have changed
    // display metadata, but installedAt + executable location still identify
    // the same activated runtime, so restore its authoritative backup.
    if (fs.existsSync(backupPath)) {
      if (fs.existsSync(journal.runtimePath)) {
        fs.rmSync(journal.runtimePath, { recursive: true, force: true });
      }
      fs.renameSync(backupPath, journal.runtimePath);
    }
    if (!fs.existsSync(journal.runtimePath)) {
      throw new AgentInstallRecoveryError("The uninstalled agent runtime could not be restored");
    }
    removeBinaryUninstallJournal(rootDir, agentId);
    log.info({ agentId }, "Rolled back an interrupted binary agent uninstall");
    return "rolled-back";
  }

  const replacementTargetsSamePath = current?.distribution === "binary"
    && current.binaryPath !== null
    && sameResolvedPath(current.binaryPath, journal.runtimePath);
  if (replacementTargetsSamePath) {
    const replacementCommandIsInside = pathIsInside(current.command, journal.runtimePath);
    if (!replacementCommandIsInside || !fs.existsSync(current.command)) {
      // A changed install identity points at the detached path but no verified
      // replacement runtime is active there. The backup is the only known-good
      // copy; keep both it and the journal for Doctor/manual recovery.
      throw new AgentInstallRecoveryError(
        "Agent metadata changed during uninstall but its replacement runtime is missing",
      );
    }
  } else if (fs.existsSync(journal.runtimePath)) {
    fs.rmSync(journal.runtimePath, { recursive: true, force: true });
  }

  // The old metadata is absent, points elsewhere, or a complete replacement
  // activation owns the old destination. Only now is its detached backup safe
  // to remove.
  if (fs.existsSync(backupPath)) {
    try {
      fs.rmSync(backupPath, { recursive: true, force: true });
    } catch (error) {
      log.warn({ error, agentId, backupPath }, "Committed agent uninstall cleanup remains pending");
      return "cleanup-pending";
    }
  }
  try {
    removeBinaryUninstallJournal(rootDir, agentId);
  } catch (error) {
    log.warn({ error, agentId }, "Committed agent uninstall journal cleanup remains pending");
    return "cleanup-pending";
  }
  if (replacementTargetsSamePath) {
    log.info({ agentId }, "Preserved a replacement runtime after a stale uninstall CAS conflict");
    return "superseded";
  }
  log.info({ agentId }, "Completed an interrupted binary agent uninstall");
  return "completed";
}

function ownsSameBinaryRuntimeActivation(
  current: InstalledAgent | undefined,
  previous: InstalledAgent,
): boolean {
  return current?.distribution === "binary"
    && current.binaryPath !== null
    && previous.binaryPath !== null
    && sameResolvedPath(current.binaryPath, previous.binaryPath)
    && sameResolvedPath(current.command, previous.command)
    && current.installedAt === previous.installedAt;
}

function sameResolvedPath(left: string, right: string): boolean {
  const leftResolved = path.resolve(left);
  const rightResolved = path.resolve(right);
  return process.platform === "win32"
    ? leftResolved.toLowerCase() === rightResolved.toLowerCase()
    : leftResolved === rightResolved;
}

function pathIsInside(candidate: string, directory: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedDirectory = path.resolve(directory);
  if (process.platform === "win32") {
    const normalizedCandidate = resolvedCandidate.toLowerCase();
    const normalizedDirectory = resolvedDirectory.toLowerCase();
    return normalizedCandidate === normalizedDirectory
      || normalizedCandidate.startsWith(`${normalizedDirectory}${path.sep}`);
  }
  return resolvedCandidate === resolvedDirectory
    || resolvedCandidate.startsWith(`${resolvedDirectory}${path.sep}`);
}

function isBinaryInstallJournal(value: unknown, expectedAgentId: string): value is BinaryInstallJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<BinaryInstallJournal>;
  return journal.version === 1
    && journal.agentId === expectedAgentId
    && typeof journal.agentKey === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.transactionId ?? "")
    && ["prepared", "activated", "metadata-committed"].includes(journal.phase ?? "")
    && Number.isFinite(journal.createdAt)
    && (journal.previousAgent === null || isInstalledAgent(journal.previousAgent))
    && isInstalledAgent(journal.nextAgent);
}

function isBinaryUninstallJournal(value: unknown, expectedAgentId: string): value is BinaryUninstallJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Partial<BinaryUninstallJournal>;
  return journal.version === 1
    && journal.agentId === expectedAgentId
    && journal.agentId.length > 0
    && journal.agentId.length <= 256
    && !journal.agentId.includes("\0")
    && typeof journal.agentKey === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.transactionId ?? "")
    && ["prepared", "runtime-moved", "metadata-removed"].includes(journal.phase ?? "")
    && Number.isFinite(journal.createdAt)
    && isInstalledAgent(journal.previousAgent)
    && journal.previousAgent.distribution === "binary"
    && typeof journal.runtimePath === "string"
    && journal.previousAgent.binaryPath === journal.runtimePath;
}

export function inspectAgentTransactions(agentsDir: string = DEFAULT_AGENTS_DIR): { pending: number } {
  const lockDir = path.join(agentsDir, ".locks");
  try {
    const pending = fs.readdirSync(lockDir).filter((name) => (
      /^[0-9a-f]{32}\.(?:transaction|uninstall)\.json$/i.test(name)
    )).length;
    return { pending };
  } catch {
    return { pending: 0 };
  }
}

function findPendingAgentTransactionIdentity(rootDir: string, agentKey: string): string | undefined {
  const lockDir = path.join(rootDir, ".locks");
  try {
    for (const name of fs.readdirSync(lockDir).filter((entry) => (
      /^[0-9a-f]{32}\.(?:transaction|uninstall)\.json$/i.test(entry)
    )).slice(0, 64)) {
      try {
        const journal = JSON.parse(fs.readFileSync(path.join(lockDir, name), "utf8") as string) as {
          agentId?: unknown;
          agentKey?: unknown;
        };
        if (journal.agentKey === agentKey
          && typeof journal.agentId === "string"
          && journal.agentId.length > 0
          && journal.agentId.length <= 256
          && !journal.agentId.includes("\0")) {
          return journal.agentId;
        }
      } catch { /* Full recovery reports malformed journals. */ }
    }
  } catch { /* No transaction directory yet. */ }
  return undefined;
}

/** Recover durable install/uninstall journals. Callers must not hold AgentStore's lock. */
export function recoverAgentTransactions(
  store: AgentStore,
  agentsDir: string = DEFAULT_AGENTS_DIR,
): AgentTransactionRecoveryResult {
  const lockDir = path.join(agentsDir, ".locks");
  const result: AgentTransactionRecoveryResult = { recovered: 0, pending: 0, errors: [] };
  let journalNames: string[];
  try {
    journalNames = fs.readdirSync(lockDir).filter((name) => (
      /^[0-9a-f]{32}\.(?:transaction|uninstall)\.json$/i.test(name)
    ));
  } catch {
    return result;
  }

  const agentIds = new Set<string>();
  for (const name of journalNames.slice(0, 64)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(lockDir, name), "utf8") as string) as {
        agentId?: unknown;
      };
      if (typeof candidate.agentId !== "string"
        || candidate.agentId.length === 0
        || candidate.agentId.length > 256
        || candidate.agentId.includes("\0")) {
        throw new Error("invalid agent identity");
      }
      agentIds.add(candidate.agentId);
    } catch (error) {
      result.errors.push("An agent transaction journal is invalid and requires manual recovery");
      log.error({ error, journal: name }, "Invalid agent transaction journal");
    }
  }

  for (const agentId of agentIds) {
    let lock: number | undefined;
    try {
      lock = acquireAgentInstallLock(agentsDir, agentId);
      if (recoverInterruptedBinaryInstall(agentsDir, agentId, store)) result.recovered++;
      const uninstall = recoverInterruptedBinaryUninstall(agentsDir, agentId, store);
      if (uninstall === "rolled-back" || uninstall === "completed" || uninstall === "superseded") {
        result.recovered++;
      }
    } catch (error) {
      result.errors.push(`Agent transaction recovery failed for ${agentId}`);
      log.error({ error, agentId }, "Agent transaction recovery failed");
    } finally {
      if (lock !== undefined) releaseAgentInstallLock(agentsDir, agentId, lock);
    }
  }

  result.pending = inspectAgentTransactions(agentsDir).pending;
  return result;
}

function isInstalledAgent(value: unknown): value is InstalledAgent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const agent = value as Partial<InstalledAgent>;
  return (typeof agent.registryId === "string" || agent.registryId === null)
    && typeof agent.name === "string"
    && typeof agent.version === "string"
    && ["npx", "uvx", "binary", "custom"].includes(agent.distribution ?? "")
    && typeof agent.command === "string"
    && Array.isArray(agent.args) && agent.args.every((arg) => typeof arg === "string")
    && Boolean(agent.env) && typeof agent.env === "object" && !Array.isArray(agent.env)
    && Object.values(agent.env).every((envValue) => typeof envValue === "string")
    && typeof agent.installedAt === "string"
    && (typeof agent.binaryPath === "string" || agent.binaryPath === null);
}

function binaryTransactionMarker(directory: string, transactionId: string): string {
  return path.join(directory, `.openacp-install-${transactionId}.marker`);
}

interface BinaryInstallTransaction {
  transactionId: string;
  destination: string;
  activate(): void;
  commit(): BinaryCommitResult;
  rollback(): BinaryRollbackResult;
}

async function prepareBinaryInstall(
  agentId: string,
  archiveUrl: string,
  commandPath: string,
  expectedSha256?: string,
  progress?: InstallProgress,
  agentsDir?: string,
  scopedFetch: typeof fetch = globalThis.fetch,
): Promise<BinaryInstallTransaction> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(agentId)) {
    throw new Error("Registry agent ID is not safe for a local installation path");
  }
  const rootDir = agentsDir ?? DEFAULT_AGENTS_DIR;
  fs.mkdirSync(rootDir, { recursive: true });
  const transactionId = crypto.randomUUID();
  const destDir = path.join(rootDir, agentId);
  const stagingDir = path.join(rootDir, `.${agentId}-${transactionId}.tmp`);
  const backupDir = path.join(rootDir, `.${agentId}-${transactionId}.backup`);
  const cleanupDir = path.join(rootDir, `.${agentId}-${transactionId}.cleanup`);
  const cleanupMarker = path.join(rootDir, `.${agentId}-${transactionId}.committed`);
  fs.mkdirSync(stagingDir, { recursive: true });
  let prepared = false;
  let activated = false;
  let committed = false;
  let previousRuntimeMoved = false;
  let previousRuntimeRestored = false;

  try {
    await progress?.onStep("Downloading...");
    log.info({ agentId, url: archiveUrl }, "Downloading agent binary");

    const response = await scopedFetch(archiveUrl);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    const buffer = await readResponseWithProgress(response, contentLength, progress);
    if (expectedSha256) verifyChecksum(buffer, expectedSha256);

    await progress?.onStep("Preparing...");

    switch (getBinaryPayloadKind(archiveUrl)) {
      case "zip":
        await extractZip(buffer, stagingDir);
        break;
      case "tar-gzip":
        await extractTar(buffer, stagingDir, "gzip");
        break;
      case "tar-bzip2":
        await extractTar(buffer, stagingDir, "bzip2");
        break;
      case "raw": {
        const rawCommand = resolveBinaryCommandPath(stagingDir, commandPath);
        fs.mkdirSync(path.dirname(rawCommand), { recursive: true });
        fs.writeFileSync(rawCommand, buffer, { mode: process.platform === "win32" ? 0o644 : 0o755 });
        break;
      }
    }

    const stagedCommand = resolveBinaryCommandPath(stagingDir, commandPath);
    if (!fs.existsSync(stagedCommand) || !fs.statSync(stagedCommand).isFile()) {
      throw new Error("Downloaded archive does not contain the registered agent command");
    }
    if (process.platform !== "win32") {
      const mode = fs.statSync(stagedCommand).mode;
      fs.chmodSync(stagedCommand, mode | 0o111);
      fs.accessSync(stagedCommand, fs.constants.X_OK);
    }
    fs.writeFileSync(binaryTransactionMarker(stagingDir, transactionId), "", {
      flag: "wx",
      mode: 0o600,
    });

    prepared = true;
    return {
      transactionId,
      destination: destDir,
      activate(): void {
        if (activated) return;
        if (fs.existsSync(destDir)) {
          fs.renameSync(destDir, backupDir);
          previousRuntimeMoved = true;
        }
        try {
          fs.renameSync(stagingDir, destDir);
          activated = true;
        } catch (error) {
          if (fs.existsSync(backupDir) && !fs.existsSync(destDir)) {
            try {
              fs.renameSync(backupDir, destDir);
              previousRuntimeMoved = false;
              previousRuntimeRestored = true;
            } catch (restoreError) {
              log.error(
                { error, restoreError, agentId },
                "Agent activation failed and the previous runtime could not be restored immediately",
              );
            }
          }
          throw error;
        }
      },
      commit(): BinaryCommitResult {
        // Runtime and metadata are already authoritative at this point. Cleanup
        // is deliberately non-fatal and must never trigger rollback of them.
        committed = true;
        activated = false;
        let cleanupAttemptFailed = false;
        try {
          fs.rmSync(binaryTransactionMarker(destDir, transactionId), { force: true });
        } catch (err) {
          cleanupAttemptFailed = true;
          log.warn({ err, agentId }, "Agent install committed; could not remove its transaction marker");
        }
        if (fs.existsSync(backupDir)) {
          try {
            fs.writeFileSync(cleanupMarker, "", { flag: "wx", mode: 0o600 });
          } catch (err) {
            log.warn({ err, agentId }, "Agent install committed; could not create a cleanup retry marker");
          }
          try {
            fs.renameSync(backupDir, cleanupDir);
            previousRuntimeMoved = false;
          } catch (err) {
            log.warn({ err, agentId }, "Agent install committed; could not mark the prior runtime for cleanup");
          }
        }
        for (const artifact of [cleanupDir, backupDir, stagingDir]) {
          try {
            fs.rmSync(artifact, { recursive: true, force: true });
          } catch (err) {
            cleanupAttemptFailed = true;
            log.warn({ err, agentId }, "Agent install committed; runtime cleanup will be retried");
          }
        }
        const runtimeCleanupPending = [cleanupDir, backupDir, stagingDir]
          .some((artifact) => fs.existsSync(artifact));
        if (!runtimeCleanupPending) {
          try {
            fs.rmSync(cleanupMarker, { force: true });
          } catch (err) {
            cleanupAttemptFailed = true;
            log.warn({ err, agentId }, "Agent install committed; cleanup marker removal will be retried");
          }
        }
        const cleanupPending = [cleanupDir, backupDir, stagingDir, cleanupMarker]
          .some((artifact) => fs.existsSync(artifact));
        const cleanupRetryable = !cleanupPending
          || fs.existsSync(cleanupMarker)
          || fs.existsSync(cleanupDir);
        if (cleanupAttemptFailed && !cleanupPending) {
          log.debug({ agentId }, "Agent runtime cleanup reported an error but left no pending artifact");
        }
        return { cleanupPending, cleanupRetryable };
      },
      rollback(): BinaryRollbackResult {
        if (committed) return { previousRuntime: "none", cleanupPending: false };
        let cleanupPending = false;
        let previousRuntime: BinaryRollbackResult["previousRuntime"] = previousRuntimeRestored
          ? "restored"
          : "none";
        if (activated) {
          try {
            fs.rmSync(destDir, { recursive: true, force: true });
          } catch (err) {
            cleanupPending = true;
            log.error({ err, agentId }, "Could not remove a failed replacement runtime during rollback");
          }
          activated = false;
        }
        if (fs.existsSync(backupDir)) {
          if (!fs.existsSync(destDir)) {
            try {
              fs.renameSync(backupDir, destDir);
              previousRuntimeMoved = false;
              previousRuntime = "restored";
            } catch (err) {
              previousRuntime = "preserved";
              cleanupPending = true;
              log.error({ err, agentId }, "Previous agent runtime recovery backup was preserved");
            }
          } else {
            previousRuntime = "preserved";
            cleanupPending = true;
          }
        } else if (previousRuntimeMoved) {
          previousRuntime = "preserved";
          cleanupPending = true;
        }
        try {
          fs.rmSync(stagingDir, { recursive: true, force: true });
        } catch (err) {
          cleanupPending = true;
          log.warn({ err, agentId }, "Could not remove an inactive agent staging directory");
        }
        return { previousRuntime, cleanupPending };
      },
    };
  } finally {
    if (!prepared) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      if (fs.existsSync(backupDir) && !fs.existsSync(destDir)) fs.renameSync(backupDir, destDir);
      else fs.rmSync(backupDir, { recursive: true, force: true });
    }
  }
}

/**
 * Retry cleanup only for obsolete runtimes explicitly marked by a completed
 * OpenACP transaction. Active `.backup` and `.tmp` paths are never touched.
 */
function cleanupCommittedBinaryArtifacts(rootDir: string, agentId: string): void {
  if (!fs.existsSync(rootDir)) return;
  const escapedAgentId = agentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const transactionStem = `\\.${escapedAgentId}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`;
  const cleanupMarkerName = new RegExp(
    `^(${transactionStem})\\.committed$`,
    "i",
  );
  const committedCleanupName = new RegExp(
    `^(${transactionStem})\\.cleanup$`,
    "i",
  );
  const resolvedRoot = path.resolve(rootDir);
  const candidates = new Map<string, string | undefined>();
  for (const name of fs.readdirSync(resolvedRoot)) {
    const markerMatch = cleanupMarkerName.exec(name);
    const cleanupMatch = committedCleanupName.exec(name);
    const stem = markerMatch?.[1] ?? cleanupMatch?.[1];
    if (!stem) continue;
    if (markerMatch || !candidates.has(stem)) {
      candidates.set(stem, markerMatch ? name : candidates.get(stem));
    }
  }

  for (const [stem, markerName] of [...candidates].slice(0, MAX_COMMITTED_CLEANUPS_PER_INSTALL)) {
    let cleanupComplete = true;
    for (const suffix of [".cleanup", ".backup"] as const) {
      const artifact = path.join(resolvedRoot, `${stem}${suffix}`);
      if (path.dirname(artifact) !== resolvedRoot) continue;
      try {
        fs.rmSync(artifact, { recursive: true, force: true });
      } catch (err) {
        cleanupComplete = false;
        log.warn({ err, agentId }, "Could not retry committed agent runtime cleanup");
      }
    }
    if (!cleanupComplete) continue;
    if (!markerName) continue;
    const marker = path.join(resolvedRoot, markerName);
    try {
      fs.rmSync(marker, { force: true });
    } catch (err) {
      log.warn({ err, agentId }, "Could not remove completed agent cleanup marker");
    }
  }
}

/**
 * Read a fetch response body with download progress reporting and size limit enforcement.
 *
 * Streams chunks incrementally to avoid buffering the entire response
 * in memory before checking the size.
 */
export async function readResponseWithProgress(
  response: Pick<Response, 'body' | 'arrayBuffer'>,
  contentLength: number,
  progress?: InstallProgress,
): Promise<Buffer> {
  if (contentLength > MAX_DOWNLOAD_SIZE) {
    throw new Error(`Download exceeds size limit of ${MAX_DOWNLOAD_SIZE} bytes`);
  }
  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_DOWNLOAD_SIZE) {
      throw new Error(`Download exceeds size limit of ${MAX_DOWNLOAD_SIZE} bytes`);
    }
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let received = 0;

  const consume = async (value: Uint8Array) => {
    chunks.push(value); received += value.length
    if (received > MAX_DOWNLOAD_SIZE) throw new Error(`Download exceeds size limit of ${MAX_DOWNLOAD_SIZE} bytes`)
    if (contentLength > 0) await progress?.onDownloadProgress(Math.min(100, Math.round((received / contentLength) * 100)))
  }

  const body = response.body as unknown as {
    getReader?: () => ReadableStreamDefaultReader<Uint8Array>
    destroy?: (error?: Error) => void
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | Buffer>
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; await consume(value) }
    } catch (error) {
      await reader.cancel?.(error).catch(() => {})
      throw error
    } finally { reader.releaseLock?.() }
  } else if (body[Symbol.asyncIterator]) {
    try {
      for await (const value of body as AsyncIterable<Uint8Array | Buffer>) await consume(new Uint8Array(value))
    } catch (error) {
      body.destroy?.(error instanceof Error ? error : undefined)
      throw error
    }
  } else {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > MAX_DOWNLOAD_SIZE) throw new Error(`Download exceeds size limit of ${MAX_DOWNLOAD_SIZE} bytes`)
    return buffer
  }

  return Buffer.concat(chunks);
}

/**
 * Post-extraction safety check: verify all extracted files resolve within
 * the destination directory. Catches symlink-based escapes that wouldn't
 * be detected by pre-extraction path validation alone.
 */
function validateExtractedPaths(destDir: string): void {
  const realDest = fs.realpathSync(destDir);
  const entries = fs.readdirSync(destDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    // Node <20.12 uses `path`, >=20.12 uses `parentPath` on Dirent with recursive readdir
    const dirent = entry as fs.Dirent & { parentPath?: string; path?: string };
    const parentPath = dirent.parentPath ?? dirent.path ?? destDir;
    const fullPath = path.join(parentPath, entry.name);
    let realPath: string;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      // Broken symlink — check where it points
      const linkTarget = fs.readlinkSync(fullPath);
      realPath = path.resolve(path.dirname(fullPath), linkTarget);
    }
    if (!realPath.startsWith(realDest + path.sep) && realPath !== realDest) {
      fs.rmSync(destDir, { recursive: true, force: true });
      throw new Error(`Archive contains unsafe path: ${entry.name}`);
    }
  }
}

async function extractTar(
  buffer: Buffer,
  destDir: string,
  compression: "gzip" | "bzip2",
): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const tmpFile = path.join(destDir, compression === "gzip" ? "_archive.tar.gz" : "_archive.tar.bz2");
  fs.writeFileSync(tmpFile, buffer);
  try {
    // Validate contents BEFORE extraction
    const listing = execFileSync("tar", ["tf", tmpFile], { stdio: "pipe" })
      .toString().trim().split("\n").filter(Boolean);
    validateArchiveContents(listing, destDir);
    // Safe to extract
    execFileSync("tar", [compression === "gzip" ? "xzf" : "xjf", tmpFile, "-C", destDir], { stdio: "pipe" });
  } finally {
    fs.unlinkSync(tmpFile);
  }
  validateExtractedPaths(destDir);
}

async function extractZip(buffer: Buffer, destDir: string): Promise<void> {
  const { execFileSync } = await import("node:child_process");
  const tmpFile = path.join(destDir, "_archive.zip");
  fs.writeFileSync(tmpFile, buffer);
  try {
    // Modern Windows ships bsdtar but not a standalone unzip command. On
    // POSIX, unzip's name-only mode avoids parsing its human-readable table.
    const entries = process.platform === "win32"
      ? execFileSync("tar", ["tf", tmpFile], { stdio: "pipe" }).toString().split("\n").filter(Boolean)
      : execFileSync("unzip", ["-Z1", tmpFile], { stdio: "pipe" }).toString().split("\n").filter(Boolean);
    validateArchiveContents(entries, destDir);
    if (process.platform === "win32") {
      execFileSync("tar", ["xf", tmpFile, "-C", destDir], { stdio: "pipe" });
    } else {
      execFileSync("unzip", ["-o", tmpFile, "-d", destDir], { stdio: "pipe" });
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }
  validateExtractedPaths(destDir);
}

/** Remove an agent from the store and delete its binary directory if present. */
export async function uninstallAgent(
  agentKey: string,
  store: AgentStore,
  agentsDir?: string,
): Promise<void> {
  const rootDir = agentsDir ?? DEFAULT_AGENTS_DIR;
  store.load();
  const initial = store.getAgent(agentKey);
  const lockIdentity = initial?.registryId
    ?? findPendingAgentTransactionIdentity(rootDir, agentKey)
    ?? agentKey;
  const lock = acquireAgentInstallLock(rootDir, lockIdentity);
  let journal: BinaryUninstallJournal | undefined;
  let journalWritten = false;
  let metadataRemoved = false;
  try {
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lockIdentity)) {
      recoverInterruptedBinaryInstall(rootDir, lockIdentity, store);
    }
    recoverInterruptedBinaryUninstall(rootDir, lockIdentity, store);
    store.load();
    const agent = store.getAgent(agentKey);
    if (!agent) return;

    if (agent.binaryPath && fs.existsSync(agent.binaryPath)) {
      validateUninstallPath(agent.binaryPath, rootDir);
      const transactionId = crypto.randomUUID();
      journal = {
        version: 1,
        agentId: lockIdentity,
        agentKey,
        transactionId,
        phase: "prepared",
        createdAt: Date.now(),
        previousAgent: agent,
        runtimePath: agent.binaryPath,
      };
      writeBinaryUninstallJournal(rootDir, journal);
      journalWritten = true;
      fs.renameSync(
        journal.runtimePath,
        binaryUninstallBackup(rootDir, lockIdentity, transactionId),
      );
      journal.phase = "runtime-moved";
      writeBinaryUninstallJournal(rootDir, journal);
    }

    if (!store.removeAgent(agentKey, agent)) {
      throw new Error("Agent definition changed while it was being uninstalled");
    }
    metadataRemoved = true;
    if (journal) {
      journal.phase = "metadata-removed";
      writeBinaryUninstallJournal(rootDir, journal);
      const backupPath = binaryUninstallBackup(rootDir, lockIdentity, journal.transactionId);
      try {
        fs.rmSync(backupPath, { recursive: true, force: true });
      } catch (error) {
        log.warn({ error, agentKey, backupPath }, "Agent was uninstalled but old runtime cleanup is pending");
        return;
      }
      try {
        removeBinaryUninstallJournal(rootDir, lockIdentity);
      } catch (error) {
        log.warn({ error, agentKey }, "Agent was uninstalled but transaction journal cleanup is pending");
        return;
      }
      log.info({ agentKey, binaryPath: journal.runtimePath }, "Deleted agent binary");
    }
  } catch (error) {
    if (journalWritten) {
      try {
        const outcome = recoverInterruptedBinaryUninstall(rootDir, lockIdentity, store);
        if (metadataRemoved && (outcome === "completed" || outcome === "cleanup-pending")) {
          log.warn({ error, agentKey, outcome }, "Agent uninstall committed with deferred recovery cleanup");
          return;
        }
      } catch (restoreError) {
        log.error({ restoreError, agentKey }, "Could not recover an interrupted agent uninstall");
      }
    }
    throw error;
  } finally {
    releaseAgentInstallLock(rootDir, lockIdentity, lock);
  }
}
