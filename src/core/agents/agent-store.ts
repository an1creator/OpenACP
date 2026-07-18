/**
 * Persistent storage for installed agent definitions.
 *
 * Agents are stored in `agents.json` (typically `~/.openacp/agents.json`).
 * The file is validated with Zod on load; corrupted or invalid data is
 * discarded gracefully with a warning. Writes use atomic rename to
 * prevent partial writes from corrupting the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { InstalledAgent } from "../types.js";
import { createChildLogger } from "../utils/log.js";

const log = createChildLogger({ module: "agent-store" });
const LOCK_WAIT_ATTEMPTS = 200;
const LOCK_WAIT_MS = 10;
const LOCK_STALE_MS = 30_000;

const InstalledAgentSchema = z.object({
  registryId: z.string().nullable(),
  name: z.string(),
  version: z.string(),
  distribution: z.enum(["npx", "uvx", "binary", "custom"]),
  command: z.string(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  workingDirectory: z.string().optional(),
  installedAt: z.string(),
  binaryPath: z.string().nullable().default(null),
  initTimeoutMs: z.number().positive().optional(),
});

const AgentStoreSchema = z.object({
  version: z.number().default(1),
  revision: z.number().int().nonnegative().default(0),
  installed: z.record(z.string(), InstalledAgentSchema).default({}),
});

type AgentStoreData = z.infer<typeof AgentStoreSchema>;

export interface AgentStoreMergeResult {
  appliedKeys: string[];
  conflictKeys: string[];
  revision: number;
}

export class AgentStoreBusyError extends Error {
  constructor() {
    super("Agent store is locked by another process");
    this.name = "AgentStoreBusyError";
  }
}

export class AgentStorePersistenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentStorePersistenceError";
  }
}

/** JSON-backed store for installed agent definitions (`agents.json`). */
export class AgentStore {
  private data: AgentStoreData = emptyStoreData();
  readonly filePath: string;
  readonly lockPath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
  }

  /** Load and validate the store from disk. Starts fresh if file is missing or invalid. */
  load(): void {
    try {
      this.data = this.readDataFile();
    } catch (err) {
      log.warn({ err }, "Failed to read agents.json, starting fresh");
      this.data = emptyStoreData();
    }
  }

  exists(): boolean {
    return fs.existsSync(this.filePath);
  }

  getInstalled(): Record<string, InstalledAgent> {
    return cloneInstalledAgents(this.data.installed);
  }

  getAgent(key: string): InstalledAgent | undefined {
    const agent = this.data.installed[key];
    return agent ? cloneInstalledAgent(agent) : undefined;
  }

  addAgent(key: string, agent: InstalledAgent): void {
    const candidate = cloneInstalledAgent(agent);
    this.updateUnderLock((installed) => {
      installed[key] = candidate;
      return true;
    });
  }

  removeAgent(key: string, expected?: InstalledAgent): boolean {
    let removed = false;
    this.updateUnderLock((installed) => {
      const current = installed[key];
      if (!current || (expected && !isDeepStrictEqual(current, expected))) return false;
      delete installed[key];
      removed = true;
      return true;
    });
    return removed;
  }

  hasAgent(key: string): boolean {
    return key in this.data.installed;
  }

  /**
   * Merge a detached reconciliation draft without overwriting concurrent keys.
   *
   * Only keys changed relative to this instance's loaded base are considered.
   * A key changed by another writer after that base was loaded is retained and
   * reported as a conflict for a later reconciliation pass.
   */
  replaceInstalled(installed: Record<string, InstalledAgent>): AgentStoreMergeResult {
    const base = cloneInstalledAgents(this.data.installed);
    const draft = cloneInstalledAgents(installed);
    const changedKeys = new Set([...Object.keys(base), ...Object.keys(draft)]);
    for (const key of [...changedKeys]) {
      if (isDeepStrictEqual(base[key], draft[key])) changedKeys.delete(key);
    }
    const appliedKeys: string[] = [];
    const conflictKeys: string[] = [];
    const committed = this.updateUnderLock((current) => {
      for (const key of changedKeys) {
        if (!isDeepStrictEqual(current[key], base[key])) {
          conflictKeys.push(key);
          continue;
        }
        const candidate = draft[key];
        if (candidate) current[key] = cloneInstalledAgent(candidate);
        else delete current[key];
        appliedKeys.push(key);
      }
      return appliedKeys.length > 0;
    });
    return { appliedKeys, conflictKeys, revision: committed.revision };
  }

  /**
   * Persist the store to disk using atomic write (write to .tmp, then rename).
   * File permissions are restricted to owner-only (0o600) since the store
   * may contain agent binary paths and environment variables.
   */
  private save(data: AgentStoreData = this.data): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmpPath = path.join(
      directory,
      `.${path.basename(this.filePath)}-${process.pid}-${Date.now()}-${crypto.randomUUID()}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      fs.chmodSync(tmpPath, 0o600);
      const fd = fs.openSync(tmpPath, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmpPath, this.filePath);
      try {
        const dirFd = fs.openSync(directory, "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch { /* Directory fsync is not supported on every platform. */ }
    } catch (error) {
      try { fs.rmSync(tmpPath, { force: true }); } catch { /* Preserve the write error. */ }
      throw error;
    }
  }

  private updateUnderLock(
    mutate: (installed: Record<string, InstalledAgent>) => boolean,
  ): AgentStoreData {
    const lock = this.acquireLock();
    let current: AgentStoreData | undefined;
    try {
      this.cleanupOrphanTemps();
      try {
        current = this.readDataFile();
      } catch (error) {
        this.quarantineInvalidStore(error);
        current = emptyStoreData();
      }
      const next = cloneStoreData(current);
      if (!mutate(next.installed)) {
        this.data = cloneStoreData(current);
        return this.data;
      }
      if (!Number.isSafeInteger(current.revision + 1)) {
        throw new AgentStorePersistenceError("Agent store revision is exhausted");
      }
      next.revision = current.revision + 1;
      const validated = AgentStoreSchema.parse(next);
      this.save(validated);
      this.data = cloneStoreData(validated);
      return this.data;
    } catch (error) {
      if (current) this.data = cloneStoreData(current);
      throw error;
    } finally {
      this.releaseLock(lock);
    }
  }

  private readDataFile(): AgentStoreData {
    if (!fs.existsSync(this.filePath)) return emptyStoreData();
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf-8") as string);
      return AgentStoreSchema.parse(raw);
    } catch (error) {
      throw new AgentStorePersistenceError("agents.json is invalid", { cause: error });
    }
  }

  private quarantineInvalidStore(error: unknown): void {
    const cause = error instanceof AgentStorePersistenceError ? error.cause : error;
    if (!(cause instanceof SyntaxError) && !(cause instanceof z.ZodError)) throw error;
    if (!fs.existsSync(this.filePath)) return;
    const quarantinePath = `${this.filePath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
    try {
      fs.chmodSync(this.filePath, 0o600);
      fs.renameSync(this.filePath, quarantinePath);
      log.warn({ error, quarantinePath }, "Quarantined an invalid agents.json before recovery");
    } catch (quarantineError) {
      throw new AgentStorePersistenceError("agents.json is invalid and could not be quarantined", {
        cause: quarantineError,
      });
    }
  }

  private acquireLock(): number {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_WAIT_ATTEMPTS; attempt++) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.lockPath, "wx", 0o600);
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
        fs.fsyncSync(fd);
        return fd;
      } catch (error) {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch { /* best effort */ }
          try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (this.removeStaleLock()) continue;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
      }
    }
    throw new AgentStoreBusyError();
  }

  private releaseLock(fd: number): void {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(this.lockPath); } catch { /* best effort */ }
  }

  private removeStaleLock(): boolean {
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockPath, "utf8")) as {
        pid?: number;
        createdAt?: number;
      };
      const old = !Number.isFinite(lock.createdAt)
        || Date.now() - Number(lock.createdAt) > LOCK_STALE_MS;
      let dead = false;
      if (Number.isInteger(lock.pid)) {
        try { process.kill(lock.pid!, 0); }
        catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      }
      if (dead || (old && !Number.isInteger(lock.pid))) {
        fs.unlinkSync(this.lockPath);
        return true;
      }
    } catch {
      try {
        if (Date.now() - fs.statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(this.lockPath);
          return true;
        }
      } catch { /* A competing writer may have released it. */ }
    }
    return false;
  }

  private cleanupOrphanTemps(): void {
    const directory = path.dirname(this.filePath);
    const escaped = path.basename(this.filePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`^\\.${escaped}-\\d+-\\d+-[0-9a-f-]+\\.tmp$`, "i");
    try {
      for (const name of fs.readdirSync(directory).filter((entry) => pattern.test(entry)).slice(0, 16)) {
        fs.rmSync(path.join(directory, name), { force: true });
      }
    } catch { /* The directory may not exist before the first write. */ }
  }
}

function emptyStoreData(): AgentStoreData {
  return { version: 1, revision: 0, installed: {} };
}

function cloneStoreData(data: AgentStoreData): AgentStoreData {
  return {
    version: data.version,
    revision: data.revision,
    installed: cloneInstalledAgents(data.installed),
  };
}

function cloneInstalledAgent(agent: InstalledAgent): InstalledAgent {
  return {
    ...agent,
    args: [...agent.args],
    env: { ...agent.env },
  };
}

function cloneInstalledAgents(
  installed: Record<string, InstalledAgent>,
): Record<string, InstalledAgent> {
  return Object.fromEntries(
    Object.entries(installed).map(([key, agent]) => [key, cloneInstalledAgent(agent)]),
  );
}
