import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { SettingsAPI } from './types.js'
import type { ZodSchema } from 'zod'

const SETTINGS_LOCK_WAIT_MS = 30_000
const SETTINGS_UNKNOWN_LOCK_GRACE_MS = 750
const SETTINGS_UNVERIFIED_OWNER_STALE_MS = 2 * 60_000
const SETTINGS_CONFLICT_RETRIES = 3

interface SettingsSnapshot {
  data: Record<string, unknown>
  raw: string | null
  revision: string
}

interface SettingsLockMetadata {
  version?: 1
  pid: number
  owner: string
  acquiredAt: number
  processStartIdentity?: string | null
}

interface SettingsLock {
  release(): void
}

interface SettingsLockObservation { dev: number; ino: number; firstSeenAt: number }
interface SettingsLockInspection {
  reclaim: boolean
  stat?: fs.Stats
  observation?: SettingsLockObservation
}

class AtomicSettingsWriteError extends Error {
  constructor(readonly original: unknown, readonly replaced: boolean) {
    super(original instanceof Error ? original.message : 'Settings write failed', { cause: original })
    this.name = 'AtomicSettingsWriteError'
  }
}

class RetriableSettingsConflictError extends Error {
  constructor(readonly conflict: SettingsConflictError) {
    super(conflict.message, { cause: conflict })
    this.name = 'RetriableSettingsConflictError'
  }
}

/** Raised when settings changed after a transaction read its fresh snapshot. */
export class SettingsConflictError extends Error {
  constructor() {
    super('Plugin settings changed concurrently; the attempted write was not applied')
    this.name = 'SettingsConflictError'
  }
}

function secureSettingsDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
}

function secureSettingsTree(basePath: string, settingsPath: string, create: boolean): void {
  const target = path.dirname(settingsPath)
  const relative = path.relative(basePath, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Settings path escapes its base directory')
  // The security boundary starts at basePath itself, not only its descendants.
  secureSettingsDirectory(basePath)
  let current = basePath
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    if (create || fs.existsSync(current)) secureSettingsDirectory(current)
  }
}

function repairSettingsPermissions(settingsPath: string, basePath: string): void {
  if (!fs.existsSync(settingsPath)) return
  secureSettingsTree(basePath, settingsPath, false)
  fs.chmodSync(settingsPath, 0o600)
}

function settingsRevision(raw: string | null): string {
  return createHash('sha256')
    .update(raw === null ? 'missing\0' : `present\0${raw}`)
    .digest('hex')
}

function parseSettings(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function readSettingsSnapshot(settingsPath: string, basePath: string): SettingsSnapshot {
  secureSettingsDirectory(basePath)
  if (!fs.existsSync(settingsPath)) return { data: {}, raw: null, revision: settingsRevision(null) }
  repairSettingsPermissions(settingsPath, basePath)
  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { data: {}, raw: null, revision: settingsRevision(null) }
    }
    throw error
  }
  return { data: parseSettings(raw), raw, revision: settingsRevision(raw) }
}

function assertSettingsRevision(settingsPath: string, basePath: string, expectedRevision: string): void {
  const actual = readSettingsSnapshot(settingsPath, basePath).revision
  if (actual !== expectedRevision) throw new SettingsConflictError()
}

function fsyncDirectory(directory: string): void {
  try {
    const directoryFd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
  } catch { /* directory fsync is unsupported on some platforms */ }
}

/**
 * Replace the exact settings file content using a content-revision CAS.
 * A null replacement restores the precise prior state where no file existed.
 */
function atomicSettingsContentWrite(
  settingsPath: string,
  basePath: string,
  content: string | null,
  expectedRevision: string,
): string {
  const directory = path.dirname(settingsPath)
  secureSettingsTree(basePath, settingsPath, true)

  if (content === null) {
    assertSettingsRevision(settingsPath, basePath, expectedRevision)
    if (!fs.existsSync(settingsPath)) return settingsRevision(null)
    let replaced = false
    try {
      fs.unlinkSync(settingsPath)
      replaced = true
      fsyncDirectory(directory)
      return settingsRevision(null)
    } catch (error) {
      throw new AtomicSettingsWriteError(error, replaced)
    }
  }

  const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`
  let replaced = false
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' })
    fs.chmodSync(temporary, 0o600)
    const fd = fs.openSync(temporary, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    assertSettingsRevision(settingsPath, basePath, expectedRevision)
    fs.renameSync(temporary, settingsPath)
    replaced = true
    fs.chmodSync(settingsPath, 0o600)
    fsyncDirectory(directory)
    return settingsRevision(content)
  } catch (error) {
    if (error instanceof SettingsConflictError) throw error
    throw new AtomicSettingsWriteError(error, replaced)
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* best effort cleanup */ }
  }
}

function serializeSettings(data: Record<string, unknown>): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

function processLiveness(pid: number): 'alive' | 'dead' | 'inaccessible' {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'inaccessible'
  }
}

/** Boot-local process identity used to distinguish a live process from PID reuse. */
function readProcessStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
      const endOfCommand = stat.lastIndexOf(') ')
      if (endOfCommand < 0) return null
      // The suffix starts at field 3 (state); process starttime is field 22.
      const ticks = stat.slice(endOfCommand + 2).trim().split(/\s+/)[19]
      return /^\d+$/.test(ticks ?? '') ? `linux:${ticks}` : null
    } catch { return null }
  }
  if (process.platform === 'win32') return null
  try {
    const started = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).trim()
    return started ? `${process.platform}:${started}` : null
  } catch { return null }
}

function readLockMetadata(lockPath: string): SettingsLockMetadata | undefined {
  try {
    const lockStat = fs.lstatSync(lockPath)
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return undefined
    const noFollow = fs.constants.O_NOFOLLOW ?? 0
    const directoryOnly = fs.constants.O_DIRECTORY ?? 0
    const lockFd = fs.openSync(lockPath, fs.constants.O_RDONLY | directoryOnly | noFollow)
    try {
      const opened = fs.fstatSync(lockFd)
      if (!opened.isDirectory() || opened.dev !== lockStat.dev || opened.ino !== lockStat.ino) return undefined
      fs.fchmodSync(lockFd, 0o700)
    } finally { fs.closeSync(lockFd) }

    const ownerPath = path.join(lockPath, 'owner.json')
    const ownerStat = fs.lstatSync(ownerPath)
    if (!ownerStat.isFile() || ownerStat.isSymbolicLink()) return undefined
    const fd = fs.openSync(ownerPath, fs.constants.O_RDONLY | noFollow)
    let raw: string
    try {
      const opened = fs.fstatSync(fd)
      if (!opened.isFile() || opened.dev !== ownerStat.dev || opened.ino !== ownerStat.ino) return undefined
      fs.fchmodSync(fd, 0o600)
      raw = fs.readFileSync(fd, 'utf-8')
    } finally { fs.closeSync(fd) }
    const parsed = JSON.parse(raw) as Partial<SettingsLockMetadata>
    if (!Number.isSafeInteger(parsed.pid) || typeof parsed.owner !== 'string' || !Number.isFinite(parsed.acquiredAt)) return undefined
    if (parsed.processStartIdentity !== undefined && parsed.processStartIdentity !== null && typeof parsed.processStartIdentity !== 'string') return undefined
    return parsed as SettingsLockMetadata
  } catch {
    return undefined
  }
}

function inspectSettingsLock(
  lockPath: string,
  now: number,
  previousObservation?: SettingsLockObservation,
): SettingsLockInspection {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(lockPath)
  } catch {
    return { reclaim: false }
  }
  // A lock-path symlink is never followed. Renaming/removing the link itself is
  // safe, so it does not need the unknown-owner grace period.
  if (stat.isSymbolicLink()) return { reclaim: true, stat }

  const metadata = readLockMetadata(lockPath)
  if (metadata) {
    const liveness = processLiveness(metadata.pid)
    if (liveness === 'dead') return { reclaim: true, stat }
    const actualIdentity = readProcessStartIdentity(metadata.pid)
    if (metadata.processStartIdentity && actualIdentity) {
      // A live PID with different start identity is a reused PID, not the owner.
      return { reclaim: metadata.processStartIdentity !== actualIdentity, stat }
    }
    // Legacy metadata and inaccessible process identity may still describe a
    // legitimate long-running transaction. Only recover when both the recorded
    // acquisition and the directory entry have been quiet for a conservative
    // bounded interval. Exact matching identity above is never age-reclaimed.
    // A future timestamp is not trusted to make the lock immortal; mtime still
    // provides a bounded, filesystem-observed age.
    const acquiredAt = metadata.acquiredAt > now ? stat.mtimeMs : metadata.acquiredAt
    const lastOwnerActivity = Math.max(acquiredAt, stat.mtimeMs)
    return { reclaim: now - lastOwnerActivity >= SETTINGS_UNVERIFIED_OWNER_STALE_MS, stat }
  }

  // Missing or malformed metadata can be the brief mkdir -> owner.json window.
  // Observe the same inode for a short grace, then recover without the full lock
  // wait. Metadata-present but unverifiable live owners use the longer interval
  // above so a cross-version transaction is not stolen after 750ms.
  const sameEntry = previousObservation?.dev === stat.dev && previousObservation.ino === stat.ino
  const observation = sameEntry
    ? previousObservation
    : { dev: stat.dev, ino: stat.ino, firstSeenAt: now }
  const oldOnDisk = now - stat.mtimeMs >= SETTINGS_UNKNOWN_LOCK_GRACE_MS
  return {
    reclaim: oldOnDisk || now - observation.firstSeenAt >= SETTINGS_UNKNOWN_LOCK_GRACE_MS,
    stat,
    observation,
  }
}

function reclaimStaleLock(lockPath: string, expected: fs.Stats): boolean {
  const reclaimed = `${lockPath}.stale.${process.pid}.${randomUUID()}`
  try {
    const current = fs.lstatSync(lockPath)
    if (current.dev !== expected.dev || current.ino !== expected.ino) return false
    fs.renameSync(lockPath, reclaimed)
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
  try { fs.rmSync(reclaimed, { recursive: true, force: true }) } catch { /* abandoned tombstones are harmless */ }
  return true
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function acquireSettingsLock(settingsPath: string, basePath: string): Promise<SettingsLock> {
  secureSettingsTree(basePath, settingsPath, true)
  const lockPath = `${settingsPath}.lock`
  const startedAt = Date.now()
  let unknownObservation: SettingsLockObservation | undefined

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 })
      fs.chmodSync(lockPath, 0o700)
      const owner = randomUUID()
      const metadata: SettingsLockMetadata = {
        version: 1,
        pid: process.pid,
        owner,
        acquiredAt: Date.now(),
        processStartIdentity: readProcessStartIdentity(process.pid),
      }
      const ownerPath = path.join(lockPath, 'owner.json')
      try {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0
        const ownerFd = fs.openSync(
          ownerPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollow,
          0o600,
        )
        try {
          fs.writeFileSync(ownerFd, `${JSON.stringify(metadata)}\n`)
          fs.fchmodSync(ownerFd, 0o600)
          fs.fsyncSync(ownerFd)
        } finally { fs.closeSync(ownerFd) }
      } catch (error) {
        try { fs.rmSync(lockPath, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
        throw error
      }

      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          const current = readLockMetadata(lockPath)
          if (current?.owner !== owner || current.pid !== process.pid || current.processStartIdentity !== metadata.processStartIdentity) return
          const releasedPath = `${lockPath}.released.${process.pid}.${randomUUID()}`
          try {
            fs.renameSync(lockPath, releasedPath)
            fs.rmSync(releasedPath, { recursive: true, force: true })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        },
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const inspection = inspectSettingsLock(lockPath, Date.now(), unknownObservation)
      unknownObservation = inspection.observation
      if (!inspection.stat) {
        if (Date.now() - startedAt >= SETTINGS_LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for plugin settings lock: ${path.basename(path.dirname(settingsPath))}`)
        }
        await delay(10 + Math.floor(Math.random() * 20))
        continue
      }
      if (inspection.reclaim && reclaimStaleLock(lockPath, inspection.stat)) {
        unknownObservation = undefined
        continue
      }
      if (Date.now() - startedAt >= SETTINGS_LOCK_WAIT_MS) {
        throw new Error(`Timed out waiting for plugin settings lock: ${path.basename(path.dirname(settingsPath))}`)
      }
      await delay(10 + Math.floor(Math.random() * 20))
    }
  }
}

/** Result of validating plugin settings against a Zod schema. */
export interface ValidationResult {
  valid: boolean
  errors?: string[]
}

/** A settings snapshot and optional in-process side effect committed as one transaction. */
export interface PluginSettingsMutation<T> {
  settings: Record<string, unknown>
  result: T
  /** Runs only after the new settings snapshot has been persisted. */
  apply?: () => void | Promise<void>
  /** Restores any partially-applied side effect when apply fails. */
  rollback?: () => void | Promise<void>
}

/**
 * Manages per-plugin settings files.
 *
 * Each plugin's settings are stored at `<basePath>/<pluginName>/settings.json`.
 * The basePath is typically `~/.openacp/plugins/`.
 * Settings are distinct from plugin storage (kv.json) — settings are user-facing
 * configuration, while storage is internal plugin state.
 */
export class SettingsManager {
  private static readonly mutationTails = new Map<string, Promise<void>>()

  constructor(private basePath: string) {
    secureSettingsDirectory(basePath)
  }

  /** Returns the base path for all plugin settings directories. */
  getBasePath(): string {
    return this.basePath
  }

  /** Create a SettingsAPI instance scoped to a specific plugin. */
  createAPI(pluginName: string): SettingsAPI {
    return new SettingsAPIImpl(this, pluginName)
  }

  /** Load a fresh plugin settings snapshot. Returns empty object if the file doesn't exist. */
  async loadSettings(pluginName: string): Promise<Record<string, unknown>> {
    return cloneSettings(readSettingsSnapshot(this.getSettingsPath(pluginName), this.basePath).data)
  }

  /** Validate settings against a Zod schema. Returns valid if no schema is provided. */
  validateSettings(
    _pluginName: string,
    settings: unknown,
    schema?: ZodSchema,
  ): ValidationResult {
    if (!schema) return { valid: true }
    const result = schema.safeParse(settings)
    if (result.success) return { valid: true }
    return {
      valid: false,
      errors: result.error.issues.map(
        (e) => `${e.path.map(String).join('.')}: ${e.message}`,
      ),
    }
  }

  /** Resolve the absolute path to a plugin's settings.json file. */
  getSettingsPath(pluginName: string): string {
    return path.join(this.basePath, pluginName, 'settings.json')
  }

  async getPluginSettings(pluginName: string): Promise<Record<string, unknown>> {
    return this.loadSettings(pluginName)
  }

  /**
   * Serialize a read/prepare/persist/apply transaction for one plugin.
   *
   * The transaction holds both an in-process queue and a filesystem lock. Its
   * prepare callback receives a fresh disk snapshot. Persistence uses a content
   * revision CAS; a pre-commit conflict is retried from a new snapshot, while an
   * exhausted conflict aborts without applying the runtime side effect. Apply
   * failures restore the exact previous file content and invoke runtime rollback
   * before releasing the cross-process lock.
   */
  async transactPluginSettings<T>(
    pluginName: string,
    prepare: (current: Record<string, unknown>) => PluginSettingsMutation<T> | Promise<PluginSettingsMutation<T>>,
  ): Promise<T> {
    const settingsPath = this.getSettingsPath(pluginName)
    return SettingsManager.serialize(path.resolve(settingsPath), async () => {
      let lastConflict: SettingsConflictError | undefined
      for (let attempt = 0; attempt < SETTINGS_CONFLICT_RETRIES; attempt += 1) {
        try {
          return await this.transactOnce(settingsPath, prepare)
        } catch (error) {
          if (!(error instanceof RetriableSettingsConflictError)) throw error
          lastConflict = error.conflict
        }
      }
      throw lastConflict ?? new SettingsConflictError()
    })
  }

  /** Merge updates into existing settings (shallow merge). */
  async updatePluginSettings(pluginName: string, updates: Record<string, unknown>): Promise<void> {
    await this.transactPluginSettings(pluginName, (current) => ({
      settings: { ...current, ...updates },
      result: undefined,
    }))
  }

  private async transactOnce<T>(
    settingsPath: string,
    prepare: (current: Record<string, unknown>) => PluginSettingsMutation<T> | Promise<PluginSettingsMutation<T>>,
  ): Promise<T> {
    const lock = await acquireSettingsLock(settingsPath, this.basePath)
    try {
      const previous = readSettingsSnapshot(settingsPath, this.basePath)
      const plan = await prepare(cloneSettings(previous.data))
      const next = cloneSettings(plan.settings)
      const nextContent = serializeSettings(next)
      const nextRevision = settingsRevision(nextContent)

      try {
        atomicSettingsContentWrite(settingsPath, this.basePath, nextContent, previous.revision)
      } catch (error) {
        if (error instanceof SettingsConflictError) throw new RetriableSettingsConflictError(error)
        if (error instanceof AtomicSettingsWriteError && error.replaced) {
          try {
            atomicSettingsContentWrite(settingsPath, this.basePath, previous.raw, nextRevision)
          } catch (restoreError) {
            throw new AggregateError([error.original, restoreError], 'Settings persistence failed and the previous snapshot could not be restored')
          }
        }
        throw error instanceof AtomicSettingsWriteError ? error.original : error
      }

      try {
        await plan.apply?.()
      } catch (error) {
        const rollbackErrors: unknown[] = [error]
        try { await plan.rollback?.() } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        try {
          atomicSettingsContentWrite(settingsPath, this.basePath, previous.raw, nextRevision)
        } catch (restoreError) {
          rollbackErrors.push(restoreError instanceof AtomicSettingsWriteError ? restoreError.original : restoreError)
        }
        if (rollbackErrors.length > 1) throw new AggregateError(rollbackErrors, 'Settings runtime apply failed and rollback was incomplete')
        throw error
      }

      return plan.result
    } finally {
      lock.release()
    }
  }

  private static async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.mutationTails.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.mutationTails.get(key) === tail) this.mutationTails.delete(key)
    }
  }
}

function cloneSettings(settings: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(settings)) as Record<string, unknown>
}

/** File-backed implementation of SettingsAPI for a single plugin. */
class SettingsAPIImpl implements SettingsAPI {
  constructor(private manager: SettingsManager, private pluginName: string) {}

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const data = await this.manager.loadSettings(this.pluginName)
    return data[key] as T | undefined
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    await this.manager.transactPluginSettings(this.pluginName, (current) => ({
      settings: { ...current, [key]: value },
      result: undefined,
    }))
  }

  async getAll(): Promise<Record<string, unknown>> {
    return this.manager.loadSettings(this.pluginName)
  }

  async setAll(settings: Record<string, unknown>): Promise<void> {
    await this.manager.transactPluginSettings(this.pluginName, () => ({
      settings: { ...settings },
      result: undefined,
    }))
  }

  async delete(key: string): Promise<void> {
    await this.manager.transactPluginSettings(this.pluginName, (current) => {
      const next = { ...current }
      delete next[key]
      return { settings: next, result: undefined }
    })
  }

  async clear(): Promise<void> {
    await this.manager.transactPluginSettings(this.pluginName, () => ({ settings: {}, result: undefined }))
  }

  async has(key: string): Promise<boolean> {
    const data = await this.manager.loadSettings(this.pluginName)
    return key in data
  }
}
