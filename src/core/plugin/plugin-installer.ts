import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs/promises'
import fsSync from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { OpenACPPlugin } from './types.js'

const execFileAsync = promisify(execFile)

/**
 * Import a package resolved from a specific directory (not the project root).
 *
 * We can't use bare `import('packageName')` because Node resolves from the
 * project root's node_modules. Plugins are installed to a separate directory
 * (~/.openacp/plugins/node_modules), so we manually resolve the ESM entry point
 * from the package's package.json and import by absolute file:// URL.
 */
export async function importFromDir(packageName: string, dir: string): Promise<any> {
  const pkgDir = path.join(dir, 'node_modules', ...packageName.split('/'))
  const pkgJsonPath = path.join(pkgDir, 'package.json')

  let pkgJson: Record<string, any>
  try {
    pkgJson = JSON.parse(await fs.readFile(pkgJsonPath, 'utf-8'))
  } catch (err) {
    throw new Error(`Cannot read package.json for "${packageName}" at ${pkgJsonPath}: ${(err as Error).message}`)
  }

  // Resolve entry: exports["."].import > main > index.js
  let entry: string
  const exportsMain = pkgJson.exports?.['.']
  if (typeof exportsMain === 'string') {
    entry = exportsMain
  } else if (exportsMain?.import) {
    entry = exportsMain.import
  } else {
    entry = pkgJson.main ?? 'index.js'
  }

  const entryPath = path.join(pkgDir, entry)
  try {
    await fs.access(entryPath)
  } catch {
    throw new Error(`Entry point "${entry}" not found for "${packageName}" at ${entryPath}`)
  }

  return import(pathToFileURL(entryPath).href)
}

/** Valid npm package name: optional @scope/, alphanumeric/hyphens/dots, optional @version */
const VALID_NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~>=<|-]+)?$/i;

export type PluginInstallErrorCode =
  | 'PLUGIN_PACKAGE_SPEC_INVALID'
  | 'PLUGIN_INSTALL_STATE_INVALID'
  | 'PLUGIN_STAGE_FAILED'
  | 'PLUGIN_CONTRACT_INVALID'
  | 'PLUGIN_INSTALL_HOOK_FAILED'
  | 'PLUGIN_ACTIVATION_FAILED'
  | 'PLUGIN_ROLLBACK_FAILED'
  | 'PLUGIN_INSTALL_BUSY'
  | 'PLUGIN_RECOVERY_FAILED'
  | 'PLUGIN_SNAPSHOT_FAILED'

export class PluginInstallError extends Error {
  constructor(readonly code: PluginInstallErrorCode, message: string) {
    super(message)
    this.name = 'PluginInstallError'
  }
}

/** Test-only fault used to model a process disappearing between durable phases. */
export class PluginInstallCrashSimulation extends Error {
  constructor(readonly phase: string) {
    super(`Simulated process crash at ${phase}`)
    this.name = 'PluginInstallCrashSimulation'
  }
}

export function parseNpmPackageSpec(spec: string): { packageName: string; spec: string } {
  if (!VALID_NPM_NAME.test(spec)) throw new PluginInstallError('PLUGIN_PACKAGE_SPEC_INVALID', 'Plugin package spec is invalid.')
  if (spec.startsWith('@')) {
    const slash = spec.indexOf('/')
    const versionAt = spec.indexOf('@', slash + 1)
    return { packageName: versionAt === -1 ? spec : spec.slice(0, versionAt), spec }
  }
  const versionAt = spec.lastIndexOf('@')
  return { packageName: versionAt > 0 ? spec.slice(0, versionAt) : spec, spec }
}

export function validateOpenACPPluginModule(
  module: unknown,
  manifest: Record<string, unknown>,
  packageName: string,
): OpenACPPlugin & { install: NonNullable<OpenACPPlugin['install']> } {
  const plugin = (module as { default?: unknown } | undefined)?.default as Partial<OpenACPPlugin> | undefined
  if (!plugin || typeof plugin !== 'object'
    || plugin.name !== packageName
    || manifest.name !== packageName
    || typeof manifest.version !== 'string'
    || plugin.version !== manifest.version
    || typeof plugin.setup !== 'function'
    || typeof plugin.install !== 'function') {
    throw new PluginInstallError(
      'PLUGIN_CONTRACT_INVALID',
      'Package is not an installable OpenACP plugin: default export, matching name/version, setup(), and explicit install() are required.',
    )
  }
  return plugin as OpenACPPlugin & { install: NonNullable<OpenACPPlugin['install']> }
}

export interface ActivationHandle {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface StagedNpmPlugin {
  packageName: string
  manifest: Record<string, any>
  plugin: OpenACPPlugin & { install: NonNullable<OpenACPPlugin['install']> }
  readonly stageDir: string
  readonly rollbackDir: string
  activationItems(): Promise<Array<{ name: string; hadLive: boolean; state: 'untouched' }>>
  activate(hooks?: PluginActivationHooks): Promise<ActivationHandle>
  discard(): Promise<void>
}

export interface PluginActivationHooks {
  beforeActivation(): Promise<void>
  beforeBackup(name: string): Promise<void>
  afterBackup(name: string): Promise<void>
  beforeActivate(name: string): Promise<void>
  afterActivate(name: string): Promise<void>
  afterPackagesActivated(): Promise<void>
}

type JournalPhase =
  | 'initialized' | 'staged' | 'snapshot-pending' | 'hook-pending' | 'hook-running' | 'hook-complete'
  | `backup:${string}` | `activate:${string}` | 'packages-activated'
  | 'registry-committing' | 'registry-committed' | 'committed'

interface PluginInstallJournal {
  version: 3
  transactionId: string
  pluginName: string
  phase: JournalPhase
  stageDir: string
  rollbackDir: string
  items: Array<{ name: string; hadLive: boolean; state: 'untouched' | 'live-backed-up-complete' | 'new-activated'; originalDigest?: string }>
  data: { directory: string; existed?: boolean; snapshotDir?: string; digest?: string; modeDigest?: string; hookStarted?: boolean }
  registry: {
    path: string
    existed: boolean
    contentBase64?: string
    mode: number
    commitEvidence?: { contentBase64: string; digest: string; mode: number }
  }
}

export interface PluginInstallLock {
  transactionId: string
  release(): void
}

export interface PluginTransactionTestHooks {
  copyTree?: (source: string, destination: string) => void
  crashAt?: (phase: string) => void
  deviceForPath?: (target: string) => number
  renamePath?: (source: string, destination: string) => void
  removePath?: (target: string) => void
  failPersistAt?: (phase: string) => void
  crashAfterSnapshotRename?: () => void
  rollbackBoundary?: (boundary: string) => void
}

const JOURNAL_FILE = 'plugin-install.journal.json'
const LOCK_FILE = 'plugin-install.lock'
const PACKAGE_ITEMS = ['node_modules', 'package.json', 'package-lock.json'] as const
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const mutationContext = new AsyncLocalStorage<{ instanceRoot: string; transactionId: string }>()

function assertDirectoryBoundary(target: string, label: string): void {
  const stat = fsSync.lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory() || fsSync.realpathSync(target) !== path.resolve(target)) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `${label} must be a real directory without symbolic-link ancestors.`)
  }
}

function assertInstanceBoundaries(instanceRoot: string): void {
  assertDirectoryBoundary(instanceRoot, 'Plugin instance root')
  const pluginsDir = path.join(instanceRoot, 'plugins')
  if (fsSync.existsSync(pluginsDir)) assertDirectoryBoundary(pluginsDir, 'Plugin package root')
}

function assertContainedPath(instanceRoot: string, target: string, label: string): void {
  const root = path.resolve(instanceRoot)
  const resolved = path.resolve(target)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `${label} escapes the trusted instance root.`)
  let current = root
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    if (!fsSync.existsSync(current)) break
    const stat = fsSync.lstatSync(current)
    if (stat.isSymbolicLink()) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `${label} contains a symbolic-link boundary.`)
    const real = fsSync.realpathSync(current)
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `${label} resolves outside the trusted instance root.`)
  }
}

function atomicJson(file: string, value: unknown): void {
  const directory = path.dirname(file)
  fsSync.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    fsSync.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    fsSync.chmodSync(temporary, 0o600)
    const fd = fsSync.openSync(temporary, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd)
    fsSync.renameSync(temporary, file); fsSync.chmodSync(file, 0o600)
    try { const dir = fsSync.openSync(directory, 'r'); fsSync.fsyncSync(dir); fsSync.closeSync(dir) } catch {}
  } finally { try { if (fsSync.existsSync(temporary)) fsSync.unlinkSync(temporary) } catch {} }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

export async function acquirePluginInstallLock(
  instanceRoot: string,
  options: { timeoutMs?: number; staleMs?: number; transactionId?: string } = {},
): Promise<PluginInstallLock> {
  const lockPath = path.join(instanceRoot, LOCK_FILE)
  const reclaimPrefix = `${LOCK_FILE}.reclaim-`
  const timeoutMs = options.timeoutMs ?? 5_000
  const staleMs = options.staleMs ?? 30_000
  const transactionId = options.transactionId ?? randomUUID()
  fsSync.mkdirSync(instanceRoot, { recursive: true, mode: 0o700 })
  const createOwnedLock = (): PluginInstallLock => {
    const fd = fsSync.openSync(lockPath, 'wx', 0o600)
    try {
      fsSync.writeFileSync(fd, JSON.stringify({ version: 1, transactionId, pid: process.pid, createdAt: Date.now() }))
      fsSync.fsyncSync(fd)
    } finally { fsSync.closeSync(fd) }
    fsSync.chmodSync(lockPath, 0o600)
    let released = false
    return { transactionId, release: () => {
      if (released) return
      released = true
      try {
        const owner = JSON.parse(fsSync.readFileSync(lockPath, 'utf8')) as { transactionId?: string }
        if (owner.transactionId === transactionId) fsSync.unlinkSync(lockPath)
      } catch { /* another owner or an already-removed lock must not be disturbed */ }
    } }
  }
  const started = Date.now()
  while (Date.now() - started <= timeoutMs) {
    try {
      const reclaims = fsSync.readdirSync(instanceRoot).filter((name) => name.startsWith(reclaimPrefix))
      for (const name of reclaims) {
        const ownerId = name.slice(reclaimPrefix.length)
        const reclaimPath = path.join(instanceRoot, name)
        const stat = fsSync.lstatSync(reclaimPath)
        if (!TRANSACTION_ID.test(ownerId) || stat.isSymbolicLink() || !stat.isFile() || stat.size > 4096) {
          throw new PluginInstallError('PLUGIN_INSTALL_BUSY', 'Malformed stale-lock reclaim evidence requires operator inspection.')
        }
        const owner = JSON.parse(fsSync.readFileSync(reclaimPath, 'utf8')) as { transactionId?: string; pid?: number; createdAt?: number }
        const reclaimable = owner.transactionId === ownerId && Number.isInteger(owner.pid) && Number.isFinite(owner.createdAt)
          && Date.now() - Number(owner.createdAt) > staleMs && !processAlive(Number(owner.pid))
        if (!reclaimable) throw new PluginInstallError('PLUGIN_INSTALL_BUSY', 'A plugin lock reclaim is active or cannot be proven stale.')
        // If no current owner exists, claim the lock before removing the durable
        // evidence. This completes a process that died after stale-lock rename.
        if (!fsSync.existsSync(lockPath)) {
          const lock = createOwnedLock()
          fsSync.unlinkSync(reclaimPath)
          return lock
        }
        fsSync.unlinkSync(reclaimPath)
      }
      return createOwnedLock()
    } catch (error) {
      if (error instanceof PluginInstallError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        const owner = JSON.parse(fsSync.readFileSync(lockPath, 'utf8')) as { transactionId?: string; pid?: number; createdAt?: number }
        const oldEnough = TRANSACTION_ID.test(owner.transactionId ?? '') && Number.isFinite(owner.createdAt) && Date.now() - Number(owner.createdAt) > staleMs
        const definitelyDead = Number.isInteger(owner.pid) && !processAlive(Number(owner.pid))
        if (oldEnough && definitelyDead) {
          const reclaimPath = path.join(instanceRoot, `${reclaimPrefix}${owner.transactionId}`)
          try {
            if (fsSync.existsSync(reclaimPath)) continue
            fsSync.renameSync(lockPath, reclaimPath)
            const renamed = JSON.parse(fsSync.readFileSync(reclaimPath, 'utf8')) as typeof owner
            if (renamed.transactionId !== owner.transactionId || renamed.pid !== owner.pid || renamed.createdAt !== owner.createdAt) {
              if (!fsSync.existsSync(lockPath)) fsSync.renameSync(reclaimPath, lockPath)
              continue
            }
          } catch (reclaimError) {
            if ((reclaimError as NodeJS.ErrnoException).code !== 'ENOENT') throw reclaimError
          }
          // The next loop validates and completes this durable reclaim. Leaving
          // it in place on failure is intentional and fail-closed.
          continue
        }
      } catch { /* malformed/unknown ownership is never removed automatically */ }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  throw new PluginInstallError('PLUGIN_INSTALL_BUSY', 'Another plugin package transaction owns the install lock; retry after it finishes.')
}

function treeRecords(root: string, excludeMarker = true): Array<{ path: string; mode: number; type: string; sha256?: string }> {
  if (!fsSync.existsSync(root)) return []
  const rootStat = fsSync.lstatSync(root)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new PluginInstallError('PLUGIN_SNAPSHOT_FAILED', 'Plugin data snapshot root must be a real directory.')
  const records: Array<{ path: string; mode: number; type: string; sha256?: string }> = []
  const walk = (directory: string, relative = ''): void => {
    for (const entry of fsSync.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludeMarker && !relative && entry.name === '.snapshot-complete.json') continue
      const childRelative = path.join(relative, entry.name)
      const child = path.join(directory, entry.name)
      const stat = fsSync.lstatSync(child)
      if (entry.isSymbolicLink()) throw new PluginInstallError('PLUGIN_SNAPSHOT_FAILED', 'Plugin data snapshot refuses symbolic links.')
      if (entry.isDirectory()) { records.push({ path: childRelative, mode: stat.mode & 0o777, type: 'directory' }); walk(child, childRelative) }
      else if (entry.isFile()) records.push({ path: childRelative, mode: stat.mode & 0o777, type: 'file', sha256: createHash('sha256').update(fsSync.readFileSync(child)).digest('hex') })
      else throw new PluginInstallError('PLUGIN_SNAPSHOT_FAILED', 'Plugin data snapshot contains an unsupported file type.')
    }
  }
  walk(root)
  return records
}

function treeDigest(root: string): string {
  return createHash('sha256').update(JSON.stringify({
    records: treeRecords(root).map(({ path: recordPath, type, sha256 }) => ({ path: recordPath, type, sha256 })),
  })).digest('hex')
}

function treeModeDigest(root: string, excludeMarker = false): string {
  const records = treeRecords(root, excludeMarker)
  return createHash('sha256').update(JSON.stringify({ rootMode: fsSync.lstatSync(root).mode & 0o777, records })).digest('hex')
}

function boundaryDigest(target: string): string {
  const records: Array<{ path: string; type: string; mode: number; sha256?: string; link?: string }> = []
  const walk = (current: string, relative: string): void => {
    const stat = fsSync.lstatSync(current)
    if (stat.isSymbolicLink()) records.push({ path: relative, type: 'symlink', mode: stat.mode & 0o777, link: fsSync.readlinkSync(current) })
    else if (stat.isFile()) records.push({ path: relative, type: 'file', mode: stat.mode & 0o777, sha256: createHash('sha256').update(fsSync.readFileSync(current)).digest('hex') })
    else if (stat.isDirectory()) {
      records.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 })
      for (const name of fsSync.readdirSync(current).sort()) walk(path.join(current, name), relative ? path.join(relative, name) : name)
    } else throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin package evidence contains an unsupported boundary type.')
  }
  walk(target, '')
  return createHash('sha256').update(JSON.stringify(records)).digest('hex')
}

function fsyncBoundary(target: string): void {
  const stat = fsSync.lstatSync(target)
  if (stat.isFile()) { const fd = fsSync.openSync(target, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd); return }
  if (stat.isSymbolicLink()) return
  for (const name of fsSync.readdirSync(target)) fsyncBoundary(path.join(target, name))
  try { const fd = fsSync.openSync(target, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) } catch {}
}

function fsyncDirectory(directory: string): void {
  try { const fd = fsSync.openSync(directory, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) } catch {}
}

function secureSnapshotTree(root: string): void {
  fsSync.chmodSync(root, 0o700)
  for (const record of treeRecords(root)) fsSync.chmodSync(path.join(root, record.path), record.type === 'directory' ? 0o700 : 0o600)
}

function fsyncTree(root: string): void {
  for (const record of treeRecords(root)) {
    const target = path.join(root, record.path)
    if (record.type === 'file') { const fd = fsSync.openSync(target, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) }
  }
  const directories = [root, ...treeRecords(root).filter((item) => item.type === 'directory').map((item) => path.join(root, item.path))].reverse()
  for (const directory of directories) { try { const fd = fsSync.openSync(directory, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) } catch {} }
}

function safeOwnedPath(candidate: string, parent: string, prefix: string, transactionId: string): boolean {
  const basename = path.basename(candidate)
  return path.dirname(candidate) === parent
    && (basename === `${prefix}${transactionId}`
      || basename === `${prefix}${transactionId}.pending`
      || basename === `${prefix}${transactionId}.complete`)
}

function copySnapshotContents(snapshot: string, destination: string): void {
  fsSync.mkdirSync(destination, { recursive: true })
  for (const entry of fsSync.readdirSync(snapshot, { withFileTypes: true })) {
    if (entry.name === '.snapshot-complete.json') continue
    fsSync.cpSync(path.join(snapshot, entry.name), path.join(destination, entry.name), { recursive: true, preserveTimestamps: true })
  }
  // cpSync mode preservation differs across Node versions and is affected by
  // process umask. Apply the verified snapshot modes explicitly after every
  // entry exists so the prepared rollback tree is deterministic.
  fsSync.chmodSync(destination, fsSync.lstatSync(snapshot).mode & 0o777)
  for (const record of treeRecords(snapshot)) {
    fsSync.chmodSync(path.join(destination, record.path), record.mode)
  }
}

function describeTreeMismatch(expectedRoot: string, actualRoot: string): string {
  try {
    const expectedRootMode = fsSync.lstatSync(expectedRoot).mode & 0o777
    const actualRootMode = fsSync.lstatSync(actualRoot).mode & 0o777
    if (expectedRootMode !== actualRootMode) return `root mode expected ${expectedRootMode.toString(8)}, actual ${actualRootMode.toString(8)}`
    const expected = treeRecords(expectedRoot)
    const actual = new Map(treeRecords(actualRoot).map((record) => [record.path, record]))
    for (const record of expected) {
      const copy = actual.get(record.path)
      if (!copy) return `missing relative record ${JSON.stringify(record.path)}`
      if (copy.type !== record.type) return `relative record ${JSON.stringify(record.path)} type mismatch`
      if (copy.mode !== record.mode) return `relative record ${JSON.stringify(record.path)} mode expected ${record.mode.toString(8)}, actual ${copy.mode.toString(8)}`
      if (copy.sha256 !== record.sha256) return `relative record ${JSON.stringify(record.path)} content digest mismatch`
      actual.delete(record.path)
    }
    const extra = actual.keys().next().value as string | undefined
    if (extra !== undefined) return `unexpected relative record ${JSON.stringify(extra)}`
  } catch { return 'tree comparison unavailable' }
  return 'aggregate digest mismatch without a record-level difference'
}

function validateJournal(instanceRoot: string, journal: PluginInstallJournal): void {
  assertInstanceBoundaries(instanceRoot)
  if (!journal || typeof journal !== 'object' || !journal.data || typeof journal.data !== 'object'
    || !journal.registry || typeof journal.registry !== 'object' || !Array.isArray(journal.items)
    || typeof journal.pluginName !== 'string' || typeof journal.transactionId !== 'string' || typeof journal.phase !== 'string') {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal structure is invalid.')
  }
  const exactKeys = (value: object, allowed: string[]): boolean => Object.keys(value).every((key) => allowed.includes(key)) && allowed.filter((key) => !['contentBase64', 'commitEvidence', 'existed', 'snapshotDir', 'digest', 'modeDigest', 'hookStarted', 'originalDigest'].includes(key)).every((key) => key in value)
  if (!exactKeys(journal, ['version', 'transactionId', 'pluginName', 'phase', 'stageDir', 'rollbackDir', 'items', 'data', 'registry'])
    || !exactKeys(journal.data, ['directory', 'existed', 'snapshotDir', 'digest', 'modeDigest', 'hookStarted'])
    || !exactKeys(journal.registry, ['path', 'existed', 'contentBase64', 'mode', 'commitEvidence'])
    || journal.items.some((item) => !item || typeof item !== 'object' || !exactKeys(item, ['name', 'hadLive', 'state', 'originalDigest']))) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal contains unknown or missing fields.')
  }
  const pluginsDir = path.join(instanceRoot, 'plugins')
  const validPhases = new Set<string>([
    'initialized', 'staged', 'snapshot-pending', 'hook-pending', 'hook-running', 'hook-complete', 'packages-activated',
    'registry-committing', 'registry-committed', 'committed',
    ...PACKAGE_ITEMS.flatMap((name) => [`backup:${name}`, `activate:${name}`]),
  ])
  let parsedName: { packageName: string; spec: string }
  try { parsedName = parseNpmPackageSpec(journal.pluginName) } catch { throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal package name is invalid.') }
  const expectedData = path.join(pluginsDir, 'data', ...journal.pluginName.split('/'))
  const itemNames = Array.isArray(journal.items) ? journal.items.map((item) => item?.name) : []
  const exactItems = itemNames.length === PACKAGE_ITEMS.length && new Set(itemNames).size === PACKAGE_ITEMS.length
    && PACKAGE_ITEMS.every((name) => itemNames.includes(name))
  if (journal.version !== 3 || !TRANSACTION_ID.test(journal.transactionId) || parsedName.packageName !== journal.pluginName || parsedName.spec !== journal.pluginName
    || !validPhases.has(journal.phase) || journal.registry.path !== path.join(instanceRoot, 'plugins.json')
    || journal.stageDir !== path.join(pluginsDir, `.stage-${journal.transactionId}`)
    || journal.rollbackDir !== path.join(pluginsDir, `.rollback-${journal.transactionId}`)
    || journal.data.directory !== expectedData || !exactItems) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal ownership validation failed.')
  }
  if (journal.items.some((item) => typeof item.hadLive !== 'boolean' || !['untouched', 'live-backed-up-complete', 'new-activated'].includes(item.state))) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal item state is invalid.')
  }
  if (journal.items.some((item) => item.hadLive ? !/^[0-9a-f]{64}$/.test(item.originalDigest ?? '') : item.originalDigest !== undefined)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction original package evidence is invalid.')
  if (typeof journal.registry.existed !== 'boolean' || !Number.isInteger(journal.registry.mode) || journal.registry.mode < 0 || journal.registry.mode > 0o777
    || (journal.registry.existed && typeof journal.registry.contentBase64 !== 'string')
    || (!journal.registry.existed && journal.registry.contentBase64 !== undefined)
    || (journal.registry.contentBase64 && Buffer.byteLength(journal.registry.contentBase64, 'base64') > 4 * 1024 * 1024)) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal registry snapshot is invalid.')
  }
  if (journal.registry.contentBase64 !== undefined && (!/^[A-Za-z0-9+/]*={0,2}$/.test(journal.registry.contentBase64)
    || Buffer.from(journal.registry.contentBase64, 'base64').toString('base64') !== journal.registry.contentBase64)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin registry snapshot encoding is invalid.')
  const committedPhase = journal.phase === 'registry-committed' || journal.phase === 'committed'
  const evidence = journal.registry.commitEvidence
  if (committedPhase !== Boolean(evidence)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin registry commit evidence is missing or present before its committed phase.')
  if (evidence) {
    if (!exactKeys(evidence, ['contentBase64', 'digest', 'mode'])
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(evidence.contentBase64)
      || Buffer.from(evidence.contentBase64, 'base64').toString('base64') !== evidence.contentBase64
      || Buffer.byteLength(evidence.contentBase64, 'base64') > 4 * 1024 * 1024
      || !/^[0-9a-f]{64}$/.test(evidence.digest)
      || createHash('sha256').update(Buffer.from(evidence.contentBase64, 'base64')).digest('hex') !== evidence.digest
      || !Number.isInteger(evidence.mode) || evidence.mode < 0 || evidence.mode > 0o777) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin registry commit evidence is invalid.')
    if (!fsSync.existsSync(journal.registry.path)
      || !fsSync.readFileSync(journal.registry.path).equals(Buffer.from(evidence.contentBase64, 'base64'))
      || (fsSync.statSync(journal.registry.path).mode & 0o777) !== evidence.mode) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Persisted plugin registry does not match committed evidence; cleanup is quarantined.')
  }
  const expectedSnapshot = path.join(pluginsDir, `.data-snapshot-${journal.transactionId}.complete`)
  if (journal.data.snapshotDir && journal.data.snapshotDir !== expectedSnapshot) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin data snapshot provenance validation failed.')
  }
  if (journal.data.existed !== undefined && typeof journal.data.existed !== 'boolean') throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin data snapshot state is invalid.')
  if (journal.data.existed === true && (journal.data.snapshotDir !== expectedSnapshot || !/^[0-9a-f]{64}$/.test(journal.data.digest ?? '') || !/^[0-9a-f]{64}$/.test(journal.data.modeDigest ?? ''))) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin data snapshot completion state is invalid.')
  }
  if (journal.data.existed === false && (journal.data.snapshotDir !== undefined || journal.data.digest !== undefined || journal.data.modeDigest !== undefined)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin data absence state is invalid.')
  for (const [target, label] of [
    [pluginsDir, 'Plugin package root'], [path.join(pluginsDir, 'data'), 'Plugin data root'],
    [expectedData, 'Plugin-owned data path'], [journal.stageDir, 'Plugin stage path'],
    [journal.rollbackDir, 'Plugin rollback path'], [path.join(pluginsDir, `.data-snapshot-${journal.transactionId}.pending`), 'Plugin pending snapshot'],
    [path.join(pluginsDir, `.data-snapshot-${journal.transactionId}.complete`), 'Plugin complete snapshot'],
    [journal.registry.path, 'Plugin registry path'],
  ] as Array<[string, string]>) assertContainedPath(instanceRoot, target, label)
  for (const name of PACKAGE_ITEMS) {
    assertContainedPath(instanceRoot, path.join(pluginsDir, name), `Live package boundary ${name}`)
    assertContainedPath(instanceRoot, path.join(journal.stageDir, name), `Staged package boundary ${name}`)
    assertContainedPath(instanceRoot, path.join(journal.rollbackDir, name), `Backup package boundary ${name}`)
  }
  validateJournalStateMachine(journal)
}

function validateJournalStateMachine(journal: PluginInstallJournal): void {
  const byName = new Map(journal.items.map((item) => [item.name, item]))
  const states = PACKAGE_ITEMS.map((name) => byName.get(name)!)
  const allUntouched = states.every((item) => item.state === 'untouched')
  const allActivated = states.every((item) => item.state === 'new-activated')
  const prePackage = new Set<JournalPhase>(['initialized', 'staged', 'snapshot-pending', 'hook-pending', 'hook-running', 'hook-complete'])

  let packageStateValid = true
  if (prePackage.has(journal.phase)) packageStateValid = allUntouched
  else if (journal.phase.startsWith('backup:') || journal.phase.startsWith('activate:')) {
    const [kind, name] = journal.phase.split(':') as ['backup' | 'activate', typeof PACKAGE_ITEMS[number]]
    const index = PACKAGE_ITEMS.indexOf(name)
    packageStateValid = index >= 0
      && states.slice(0, index).every((item) => item.state === 'new-activated')
      && states.slice(index + 1).every((item) => item.state === 'untouched')
    const current = states[index]
    if (packageStateValid && kind === 'backup') {
      packageStateValid = current.state === 'untouched' || (current.hadLive && current.state === 'live-backed-up-complete')
    } else if (packageStateValid) {
      packageStateValid = current.state === 'new-activated'
        || (current.hadLive ? current.state === 'live-backed-up-complete' : current.state === 'untouched')
    }
  } else if (['packages-activated', 'registry-committing', 'registry-committed', 'committed'].includes(journal.phase)) packageStateValid = allActivated
  if (!packageStateValid) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction phase and package item states are inconsistent.')

  const noSnapshotYet = journal.data.existed === undefined && journal.data.snapshotDir === undefined && journal.data.digest === undefined && journal.data.modeDigest === undefined
  const snapshotComplete = typeof journal.data.existed === 'boolean'
    && (journal.data.existed === false || (typeof journal.data.snapshotDir === 'string' && typeof journal.data.digest === 'string' && typeof journal.data.modeDigest === 'string'))
  const beforeSnapshot = ['initialized', 'staged', 'snapshot-pending'].includes(journal.phase)
  const beforeHook = journal.phase === 'hook-pending'
  const afterHookStart = !beforeSnapshot && !beforeHook
  const dataStateValid = (beforeSnapshot && noSnapshotYet && journal.data.hookStarted === undefined)
    || (beforeHook && snapshotComplete && journal.data.hookStarted !== true)
    || (afterHookStart && snapshotComplete && journal.data.hookStarted === true)
  if (!dataStateValid) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction phase and data snapshot state are inconsistent.')
}

function validateCompleteSnapshot(journal: PluginInstallJournal): string | undefined {
  if (journal.data.existed !== true) return undefined
  const snapshot = journal.data.snapshotDir
  if (!snapshot || !journal.data.digest || !journal.data.modeDigest || !fsSync.existsSync(snapshot)) return undefined
  let marker: { transactionId?: string; digest?: string; modeDigest?: string }
  try {
    marker = JSON.parse(fsSync.readFileSync(path.join(snapshot, '.snapshot-complete.json'), 'utf8'))
  } catch {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin data snapshot completion marker is unavailable; original data was not deleted.')
  }
  if (marker.transactionId !== journal.transactionId || marker.digest !== journal.data.digest || marker.modeDigest !== journal.data.modeDigest
    || treeDigest(snapshot) !== journal.data.digest || treeModeDigest(snapshot, true) !== journal.data.modeDigest) {
    throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin data snapshot integrity validation failed; original data was not deleted.')
  }
  return snapshot
}

function restoreJournal(instanceRoot: string, journal: PluginInstallJournal, boundary?: (name: string) => void): void {
  validateJournal(instanceRoot, journal)
  const completeSnapshot = validateCompleteSnapshot(journal)
  const pluginsDir = path.join(instanceRoot, 'plugins')
  for (const item of journal.items) {
    const live = path.join(pluginsDir, item.name)
    const backup = path.join(journal.rollbackDir, item.name)
    const staged = path.join(journal.stageDir, item.name)
    const activated = item.state === 'new-activated'
      || ((journal.phase === `activate:${item.name}` || journal.phase === 'packages-activated' || journal.phase === 'registry-committing')
        && fsSync.existsSync(live) && !fsSync.existsSync(staged) && (fsSync.existsSync(backup) || !item.hadLive))
    if (item.hadLive) {
      const expected = item.originalDigest!
      if (!fsSync.existsSync(live) || boundaryDigest(live) !== expected) {
        if (!fsSync.existsSync(backup) || boundaryDigest(backup) !== expected) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `Original package evidence is unavailable for ${item.name}; live state was not removed.`)
        const restoreTemp = path.join(pluginsDir, `.restore-${journal.transactionId}-${item.name}`)
        fsSync.rmSync(restoreTemp, { recursive: true, force: true })
        fsSync.cpSync(backup, restoreTemp, { recursive: true, preserveTimestamps: true, dereference: false })
        if (boundaryDigest(restoreTemp) !== expected) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `Prepared package restore did not verify for ${item.name}.`)
        fsyncBoundary(restoreTemp); boundary?.(`package:${item.name}:prepared`)
        fsSync.rmSync(live, { recursive: true, force: true }); boundary?.(`package:${item.name}:live-removed`)
        fsSync.renameSync(restoreTemp, live)
        try { const fd = fsSync.openSync(pluginsDir, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) } catch {}
        boundary?.(`package:${item.name}:restored`)
      }
      if (!fsSync.existsSync(live) || boundaryDigest(live) !== expected) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `Restored package verification failed for ${item.name}.`)
      boundary?.(`package:${item.name}:verified`)
    } else if (activated && fsSync.existsSync(live)) {
      fsSync.rmSync(live, { recursive: true, force: true }); fsyncDirectory(pluginsDir); boundary?.(`package:${item.name}:absent`)
    }
  }
  if (journal.data.existed === true) {
    const dataVerified = fsSync.existsSync(journal.data.directory)
      && treeDigest(journal.data.directory) === journal.data.digest
      && treeModeDigest(journal.data.directory) === journal.data.modeDigest
    if (!dataVerified) {
      if (!completeSnapshot) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Complete plugin data evidence is unavailable; live data was not removed.')
      const restoreTemp = path.join(pluginsDir, `.data-restore-${journal.transactionId}.pending`)
      fsSync.rmSync(restoreTemp, { recursive: true, force: true })
      copySnapshotContents(completeSnapshot, restoreTemp)
      if (treeDigest(restoreTemp) !== journal.data.digest || treeModeDigest(restoreTemp) !== journal.data.modeDigest) {
        throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `Prepared plugin data rollback verification failed: ${describeTreeMismatch(completeSnapshot, restoreTemp)}.`)
      }
      fsyncTree(restoreTemp); boundary?.('data:prepared')
      fsSync.rmSync(journal.data.directory, { recursive: true, force: true }); boundary?.('data:live-removed')
      fsSync.renameSync(restoreTemp, journal.data.directory)
      try { const fd = fsSync.openSync(path.dirname(journal.data.directory), 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) } catch {}
      boundary?.('data:restored')
    }
    if (!fsSync.existsSync(journal.data.directory) || treeDigest(journal.data.directory) !== journal.data.digest || treeModeDigest(journal.data.directory) !== journal.data.modeDigest) {
      const detail = completeSnapshot ? describeTreeMismatch(completeSnapshot, journal.data.directory) : 'durable snapshot unavailable'
      throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', `Plugin data rollback verification failed: ${detail}.`)
    }
    boundary?.('data:verified')
  } else if (journal.data.existed === false && journal.data.hookStarted === true) {
    fsSync.rmSync(journal.data.directory, { recursive: true, force: true }); fsyncDirectory(path.dirname(journal.data.directory)); boundary?.('data:absent')
  }
  if (journal.registry.existed && journal.registry.contentBase64 !== undefined) {
    const expected = Buffer.from(journal.registry.contentBase64, 'base64')
    const alreadyVerified = fsSync.existsSync(journal.registry.path)
      && fsSync.readFileSync(journal.registry.path).equals(expected)
      && (fsSync.statSync(journal.registry.path).mode & 0o777) === journal.registry.mode
    if (!alreadyVerified) {
    const tmp = `${journal.registry.path}.${journal.transactionId}.recovery`
    fsSync.rmSync(tmp, { force: true })
    try {
      fsSync.writeFileSync(tmp, expected, { flag: 'wx', mode: journal.registry.mode })
      const fd = fsSync.openSync(tmp, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd)
      fsSync.renameSync(tmp, journal.registry.path); fsSync.chmodSync(journal.registry.path, journal.registry.mode)
      try { const dir = fsSync.openSync(path.dirname(journal.registry.path), 'r'); fsSync.fsyncSync(dir); fsSync.closeSync(dir) } catch {}
    } finally { fsSync.rmSync(tmp, { force: true }) }
    boundary?.('registry:restored')
    }
    if (!fsSync.readFileSync(journal.registry.path).equals(expected) || (fsSync.statSync(journal.registry.path).mode & 0o777) !== journal.registry.mode) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin registry rollback verification failed.')
  } else if (journal.phase === 'registry-committing') { fsSync.rmSync(journal.registry.path, { force: true }); fsyncDirectory(path.dirname(journal.registry.path)) }
  else if (fsSync.existsSync(journal.registry.path)) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Unexpected registry appeared before its mutation boundary; it was not removed.')
  boundary?.('all:verified')
}

function cleanJournalArtifacts(instanceRoot: string, journal: PluginInstallJournal, removePath = (target: string) => fsSync.rmSync(target, { recursive: true, force: true })): void {
  validateJournal(instanceRoot, journal)
  const pluginsDir = path.join(instanceRoot, 'plugins')
  const pendingSnapshot = path.join(pluginsDir, `.data-snapshot-${journal.transactionId}.pending`)
  const completeSnapshot = path.join(pluginsDir, `.data-snapshot-${journal.transactionId}.complete`)
  const restorePaths = PACKAGE_ITEMS.map((name) => path.join(pluginsDir, `.restore-${journal.transactionId}-${name}`))
  const dataRestore = path.join(pluginsDir, `.data-restore-${journal.transactionId}.pending`)
  for (const owned of [journal.stageDir, journal.rollbackDir, journal.data.snapshotDir, pendingSnapshot, completeSnapshot, ...restorePaths, dataRestore]) if (owned) removePath(owned)
  removePath(`${journal.registry.path}.${journal.transactionId}.recovery`)
  removePath(path.join(instanceRoot, JOURNAL_FILE))
  fsyncDirectory(pluginsDir)
  fsyncDirectory(instanceRoot)
}

function recoverLocked(instanceRoot: string): void {
  assertInstanceBoundaries(instanceRoot)
  const journalPath = path.join(instanceRoot, JOURNAL_FILE)
  if (!fsSync.existsSync(journalPath)) return
  let journal: PluginInstallJournal
  try {
    if (fsSync.lstatSync(journalPath).isSymbolicLink() || fsSync.statSync(journalPath).size > MAX_JOURNAL_BYTES) throw new Error('invalid journal file')
    journal = JSON.parse(fsSync.readFileSync(journalPath, 'utf8')) as PluginInstallJournal
  }
  catch { throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal is unreadable; community plugins remain quarantined.') }
  validateJournal(instanceRoot, journal)
  if (journal.phase !== 'registry-committed' && journal.phase !== 'committed') restoreJournal(instanceRoot, journal)
  cleanJournalArtifacts(instanceRoot, journal)
}

export async function recoverPluginInstallTransaction(instanceRoot: string, options: { timeoutMs?: number; staleMs?: number } = {}): Promise<void> {
  const lock = await acquirePluginInstallLock(instanceRoot, options)
  try { recoverLocked(instanceRoot) } finally { lock.release() }
}

export function pluginMutationLockHeld(instanceRoot: string): boolean {
  return mutationContext.getStore()?.instanceRoot === instanceRoot
}

export async function withHeldPluginMutationLock<T>(instanceRoot: string, lock: PluginInstallLock, callback: () => Promise<T>): Promise<T> {
  return mutationContext.run({ instanceRoot, transactionId: lock.transactionId }, callback)
}

export async function withPluginMutationLock<T>(instanceRoot: string, callback: () => Promise<T>): Promise<T> {
  if (pluginMutationLockHeld(instanceRoot)) return callback()
  const lock = await acquirePluginInstallLock(instanceRoot)
  try {
    recoverLocked(instanceRoot)
    return await withHeldPluginMutationLock(instanceRoot, lock, callback)
  } finally { lock.release() }
}

export class PluginInstallJournalController {
  private journal?: PluginInstallJournal
  private readonly journalPath: string
  readonly transactionId: string

  constructor(private instanceRoot: string, private lock: PluginInstallLock, private hooks: PluginTransactionTestHooks = {}) {
    this.transactionId = lock.transactionId
    this.journalPath = path.join(instanceRoot, JOURNAL_FILE)
  }

  recoverExisting(): void { recoverLocked(this.instanceRoot) }

  initialize(pluginName: string, dataDirectory: string, registryPath: string): void {
    if (this.journal) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal is already initialized.')
    const pluginsDir = path.join(this.instanceRoot, 'plugins')
    assertInstanceBoundaries(this.instanceRoot)
    const expectedData = path.join(pluginsDir, 'data', ...pluginName.split('/'))
    if (dataDirectory !== expectedData || registryPath !== path.join(this.instanceRoot, 'plugins.json')) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction intent paths are invalid.')
    const existed = fsSync.existsSync(registryPath)
    this.journal = {
      version: 3, transactionId: this.transactionId, pluginName, phase: 'initialized',
      stageDir: path.join(pluginsDir, `.stage-${this.transactionId}`),
      rollbackDir: path.join(pluginsDir, `.rollback-${this.transactionId}`),
      items: PACKAGE_ITEMS.map((name) => {
        const live = path.join(pluginsDir, name)
        const hadLive = fsSync.existsSync(live)
        return { name, hadLive, state: 'untouched' as const, originalDigest: hadLive ? boundaryDigest(live) : undefined }
      }),
      data: { directory: dataDirectory },
      registry: { path: registryPath, existed, contentBase64: existed ? fsSync.readFileSync(registryPath).toString('base64') : undefined, mode: existed ? fsSync.statSync(registryPath).mode & 0o777 : 0o600 },
    }
    validateJournal(this.instanceRoot, this.journal)
    this.persist()
    this.hooks.crashAt?.('initialized')
  }

  snapshotData(directory: string): { directory: string; existed: boolean; snapshotDir?: string; digest?: string; modeDigest?: string } {
    if (!this.journal || this.journal.data.directory !== directory) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction was not prepared for this data directory.')
    validateJournal(this.instanceRoot, this.journal)
    if (!fsSync.existsSync(directory)) {
      const result = { directory, existed: false as const }
      this.journal.data = result; this.transition('hook-pending'); return result
    }
    const pluginsDir = path.join(this.instanceRoot, 'plugins')
    const pending = path.join(pluginsDir, `.data-snapshot-${this.transactionId}.pending`)
    const complete = path.join(pluginsDir, `.data-snapshot-${this.transactionId}.complete`)
    let result: { directory: string; existed: true; snapshotDir: string; digest: string; modeDigest: string }
    try {
      fsSync.rmSync(pending, { recursive: true, force: true }); fsSync.rmSync(complete, { recursive: true, force: true })
      ;(this.hooks.copyTree ?? ((source, destination) => fsSync.cpSync(source, destination, { recursive: true, preserveTimestamps: true })))(directory, pending)
      const digest = treeDigest(directory)
      if (treeDigest(pending) !== digest) throw new PluginInstallError('PLUGIN_SNAPSHOT_FAILED', 'Plugin data snapshot verification failed.')
      secureSnapshotTree(pending)
      const modeDigest = treeModeDigest(pending, true)
      atomicJson(path.join(pending, '.snapshot-complete.json'), { version: 1, transactionId: this.transactionId, digest, modeDigest })
      fsyncTree(pending)
      const deviceForPath = this.hooks.deviceForPath ?? ((target: string) => fsSync.statSync(target).dev)
      if (deviceForPath(pluginsDir) !== deviceForPath(pending)) throw new PluginInstallError('PLUGIN_SNAPSHOT_FAILED', 'Plugin transaction paths must share one filesystem.')
      fsSync.renameSync(pending, complete)
      try { const fd = fsSync.openSync(pluginsDir, 'r'); fsSync.fsyncSync(fd); fsSync.closeSync(fd) } catch {}
      this.hooks.crashAfterSnapshotRename?.()
      result = { directory, existed: true, snapshotDir: complete, digest, modeDigest }
    } catch (error) {
      if (error instanceof PluginInstallCrashSimulation) throw error
      fsSync.rmSync(pending, { recursive: true, force: true }); fsSync.rmSync(complete, { recursive: true, force: true })
      if (error instanceof PluginInstallError) throw error
      throw new PluginInstallError('PLUGIN_SNAPSHOT_FAILED', 'Plugin data snapshot could not be completed; original data was not changed.')
    }
    this.journal.data = result
    try { this.transition('hook-pending') }
    catch (error) {
      if (error instanceof PluginInstallCrashSimulation) throw error
      fsSync.rmSync(complete, { recursive: true, force: true })
      throw error
    }
    return result
  }

  async prepare(pluginName: string, staged: StagedNpmPlugin, dataDirectory: string, registryPath: string): Promise<PluginActivationHooks> {
    const pluginsDir = path.join(this.instanceRoot, 'plugins')
    const deviceForPath = this.hooks.deviceForPath ?? ((target: string) => fsSync.statSync(target).dev)
    if (deviceForPath(pluginsDir) !== deviceForPath(staged.stageDir)) throw new PluginInstallError('PLUGIN_STAGE_FAILED', 'Plugin transaction paths must share one filesystem.')
    if (!this.journal) this.initialize(pluginName, dataDirectory, registryPath)
    const journal = this.journal!
    if (journal.pluginName !== pluginName || journal.stageDir !== staged.stageDir || journal.rollbackDir !== staged.rollbackDir) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Staged plugin does not match durable transaction intent.')
    this.transition('staged')
    this.transition('snapshot-pending')
    return {
      beforeActivation: async () => {},
      beforeBackup: async (name) => this.transition(`backup:${name}`),
      afterBackup: async (name) => {
        const item = this.journal!.items.find((entry) => entry.name === name)!
        if (item.hadLive) item.state = 'live-backed-up-complete'
        this.persist()
      },
      beforeActivate: async (name) => this.transition(`activate:${name}`),
      afterActivate: async (name) => {
        const item = this.journal!.items.find((entry) => entry.name === name)!
        item.state = 'new-activated'; this.persist()
      },
      afterPackagesActivated: async () => this.transition('packages-activated'),
    }
  }

  transition(phase: JournalPhase): void {
    if (!this.journal) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Plugin transaction journal was not prepared.')
    const previous = this.journal.phase
    const previousHookStarted = this.journal.data.hookStarted
    this.journal.phase = phase
    if (phase === 'hook-running') this.journal.data.hookStarted = true
    try { this.hooks.failPersistAt?.(phase); this.persist() }
    catch (error) { this.journal.phase = previous; this.journal.data.hookStarted = previousHookStarted; throw error }
    this.hooks.crashAt?.(phase)
  }

  markRegistryCommitted(expectedContent: Buffer, expectedMode: number): void {
    if (!this.journal || this.journal.phase !== 'registry-committing') throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Registry commit marker requires the registry-committing phase.')
    const actual = fsSync.readFileSync(this.journal.registry.path)
    const actualMode = fsSync.statSync(this.journal.registry.path).mode & 0o777
    if (!actual.equals(expectedContent) || actualMode !== expectedMode) throw new PluginInstallError('PLUGIN_RECOVERY_FAILED', 'Persisted registry does not match the intended committed state.')
    const previousPhase = this.journal.phase
    this.journal.registry.commitEvidence = {
      contentBase64: expectedContent.toString('base64'),
      digest: createHash('sha256').update(expectedContent).digest('hex'),
      mode: expectedMode,
    }
    this.journal.phase = 'registry-committed'
    try { this.hooks.failPersistAt?.('registry-committed'); this.persist() }
    catch (error) {
      this.journal.phase = previousPhase
      delete this.journal.registry.commitEvidence
      throw error
    }
    this.hooks.crashAt?.('registry-committed')
  }

  rollback(): void {
    if (!this.journal) return
    if (this.journal.phase === 'registry-committed' || this.journal.phase === 'committed') {
      cleanJournalArtifacts(this.instanceRoot, this.journal, this.hooks.removePath); this.journal = undefined; return
    }
    restoreJournal(this.instanceRoot, this.journal, this.hooks.rollbackBoundary)
    cleanJournalArtifacts(this.instanceRoot, this.journal, this.hooks.removePath); this.journal = undefined
  }

  commit(): boolean {
    try { this.transition('committed') }
    catch (error) { if (error instanceof PluginInstallCrashSimulation) throw error; return false }
    try {
      cleanJournalArtifacts(this.instanceRoot, this.journal!, this.hooks.removePath); this.journal = undefined
      return true
    } catch (error) { if (error instanceof PluginInstallCrashSimulation) throw error; return false }
  }

  get isCommitted(): boolean { return this.journal?.phase === 'registry-committed' || this.journal?.phase === 'committed' }

  release(): void { this.lock.release() }
  private persist(): void {
    validateJournal(this.instanceRoot, this.journal!)
    atomicJson(this.journalPath, this.journal)
  }
}

async function pathExists(file: string): Promise<boolean> {
  try { await fs.access(file); return true } catch { return false }
}

/** Stage and validate a complete plugin tree before any live package state changes. */
export async function stageNpmPlugin(
  packageSpec: string,
  pluginsDir: string,
  childEnv?: Record<string, string>,
  options: { runNpm?: (stageDir: string, packageSpec: string) => Promise<void>; transactionId?: string; renamePath?: (source: string, destination: string) => void } = {},
): Promise<StagedNpmPlugin> {
  const { packageName } = parseNpmPackageSpec(packageSpec)
  await fs.mkdir(pluginsDir, { recursive: true })
  const liveManifest = path.join(pluginsDir, 'package.json')
  const liveModules = path.join(pluginsDir, 'node_modules')
  if (await pathExists(liveModules) && !await pathExists(liveManifest)) {
    throw new PluginInstallError('PLUGIN_INSTALL_STATE_INVALID', 'Plugin directory has node_modules without package.json; no changes were made.')
  }
  const transactionId = options.transactionId ?? randomUUID()
  const stageDir = path.join(pluginsDir, `.stage-${transactionId}`)
  const rollbackDir = path.join(pluginsDir, `.rollback-${transactionId}`)
  await fs.mkdir(stageDir, { recursive: true })
  try {
    for (const name of ['package.json', 'package-lock.json']) {
      const source = path.join(pluginsDir, name)
      if (await pathExists(source)) await fs.copyFile(source, path.join(stageDir, name))
    }
    if (!await pathExists(path.join(stageDir, 'package.json'))) {
      await fs.writeFile(path.join(stageDir, 'package.json'), '{"private":true}\n', { mode: 0o600 })
    }
    try {
      if (options.runNpm) await options.runNpm(stageDir, packageSpec)
      else await execFileAsync('npm', ['install', packageSpec, '--prefix', stageDir, '--save', '--ignore-scripts'], {
        timeout: 60_000, env: childEnv,
      })
    } catch {
      throw new PluginInstallError('PLUGIN_STAGE_FAILED', 'npm could not stage the plugin package; live plugins were not changed.')
    }
    const packagePath = path.join(stageDir, 'node_modules', ...packageName.split('/'), 'package.json')
    let manifest: Record<string, any>
    try { manifest = JSON.parse(await fs.readFile(packagePath, 'utf8')) }
    catch { throw new PluginInstallError('PLUGIN_CONTRACT_INVALID', 'Staged plugin package metadata is unavailable or invalid.') }
    let module: unknown
    try { module = await importFromDir(packageName, stageDir) }
    catch { throw new PluginInstallError('PLUGIN_CONTRACT_INVALID', 'Staged plugin entry point could not be loaded.') }
    const plugin = validateOpenACPPluginModule(module, manifest, packageName)
    let activated = false
    let finished = false

    const rollback = async (): Promise<void> => {
      if (finished) return
      for (const name of ['node_modules', 'package.json', 'package-lock.json']) {
        const live = path.join(pluginsDir, name)
        const backup = path.join(rollbackDir, name)
        if (await pathExists(live)) await fs.rm(live, { recursive: true, force: true })
        if (await pathExists(backup)) await fs.rename(backup, live)
      }
      finished = true
      await fs.rm(rollbackDir, { recursive: true, force: true })
      await fs.rm(stageDir, { recursive: true, force: true })
    }

    return {
      packageName, manifest, plugin, stageDir, rollbackDir,
      activationItems: async () => Promise.all(PACKAGE_ITEMS.map(async (name) => ({ name, hadLive: await pathExists(path.join(pluginsDir, name)), state: 'untouched' as const }))),
      discard: async () => {
        if (activated) await rollback()
        else await fs.rm(stageDir, { recursive: true, force: true })
      },
      activate: async (hooks) => {
        if (activated) throw new PluginInstallError('PLUGIN_ACTIVATION_FAILED', 'Staged plugin was already activated.')
        await fs.mkdir(rollbackDir, { recursive: true })
        try {
          const roots = [pluginsDir, stageDir, rollbackDir]
          for (const root of roots) assertDirectoryBoundary(root, 'Plugin activation boundary')
          const devices = roots.map((root) => fsSync.statSync(root).dev)
          if (new Set(devices).size !== 1) throw new PluginInstallError('PLUGIN_ACTIVATION_FAILED', 'Plugin activation boundaries must share one filesystem.')
          for (const name of PACKAGE_ITEMS) {
            const live = path.join(pluginsDir, name)
            const stagedItem = path.join(stageDir, name)
            const backup = path.join(rollbackDir, name)
            if (fsSync.existsSync(backup)) throw new PluginInstallError('PLUGIN_ACTIVATION_FAILED', 'Plugin rollback boundary must be empty before activation.')
            for (const boundary of [live, stagedItem]) {
              if (!fsSync.existsSync(boundary)) continue
              const stat = fsSync.lstatSync(boundary)
              if (stat.isSymbolicLink() || stat.dev !== devices[0]) throw new PluginInstallError('PLUGIN_ACTIVATION_FAILED', 'Plugin activation boundary is a symlink or crosses filesystems.')
              if (fsSync.realpathSync(path.dirname(boundary)) !== path.resolve(path.dirname(boundary))) throw new PluginInstallError('PLUGIN_ACTIVATION_FAILED', 'Plugin activation boundary has a symbolic-link ancestor.')
            }
          }
          await hooks?.beforeActivation()
          for (const name of ['node_modules', 'package.json', 'package-lock.json']) {
            const live = path.join(pluginsDir, name)
            const staged = path.join(stageDir, name)
            const backup = path.join(rollbackDir, name)
            await hooks?.beforeBackup(name)
            if (await pathExists(live)) {
              if (options.renamePath) options.renamePath(live, backup); else await fs.rename(live, backup)
            }
            await hooks?.afterBackup(name)
            await hooks?.beforeActivate(name)
            if (await pathExists(staged)) {
              if (options.renamePath) options.renamePath(staged, live); else await fs.rename(staged, live)
            }
            await hooks?.afterActivate(name)
          }
          activated = true
          await hooks?.afterPackagesActivated()
        } catch (error) {
          if (error instanceof PluginInstallCrashSimulation || hooks) throw error
          await rollback()
          throw new PluginInstallError('PLUGIN_ACTIVATION_FAILED', 'Plugin activation failed; previous packages were restored.')
        }
        return {
          rollback,
          commit: async () => {
            if (finished) return
            finished = true
            await Promise.allSettled([
              fs.rm(rollbackDir, { recursive: true, force: true }),
              fs.rm(stageDir, { recursive: true, force: true }),
            ])
          },
        }
      },
    }
  } catch (error) {
    await fs.rm(stageDir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Install an npm package to the isolated plugins directory and return the loaded module.
 *
 * Plugins are installed to `~/.openacp/plugins/` (separate from the project's node_modules)
 * to avoid version conflicts with core dependencies. Uses `--ignore-scripts` for security.
 * Tries to import first (already installed case) before running npm install.
 */
export async function installNpmPlugin(packageName: string, pluginsDir?: string, childEnv?: Record<string, string>): Promise<any> {
  if (!VALID_NPM_NAME.test(packageName)) {
    throw new Error(`Invalid package name: "${packageName}". Must be a valid npm package name.`);
  }

  const dir = pluginsDir!

  // Try import from plugins dir first — already installed
  try {
    return await importFromDir(packageName, dir)
  } catch {
    // Runtime npm mutation can race loaded code and registry state. Installation
    // must use the journaled CLI transaction and take effect after restart.
  }
  void childEnv
  throw new PluginInstallError(
    'PLUGIN_INSTALL_STATE_INVALID',
    `Runtime package installation is not safe while OpenACP may be loaded. Run "openacp plugin install ${packageName}" and restart OpenACP.`,
  )
}
