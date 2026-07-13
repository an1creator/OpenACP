import fs from 'node:fs'
import path from 'node:path'
import { pluginMutationLockHeld, withPluginMutationLock } from './plugin-installer.js'

/**
 * Persisted metadata about an installed plugin.
 *
 * This is the registry's view of a plugin — install state, version, source.
 * Distinct from `OpenACPPlugin` which is the runtime instance with setup/teardown hooks.
 */
export interface PluginEntry {
  version: string
  installedAt: string
  updatedAt: string
  /** How the plugin was installed: bundled with core, from npm, or from a local path */
  source: 'builtin' | 'npm' | 'local'
  enabled: boolean
  settingsPath: string
  description?: string
}

type RegisterInput = Omit<PluginEntry, 'installedAt' | 'updatedAt'>

interface RegistryData {
  installed: Record<string, PluginEntry>
}

/**
 * Tracks which plugins are installed, their versions, and enabled state.
 * Persisted as JSON at `~/.openacp/plugins/registry.json`.
 *
 * Used by LifecycleManager to detect version changes (triggering migration)
 * and to skip disabled plugins at boot time.
 */
export class PluginRegistry {
  private data: RegistryData = { installed: {} }
  private pending: Array<
    | { type: 'restore'; name: string; entry?: PluginEntry }
    | { type: 'remove'; name: string }
    | { type: 'enabled'; name: string; enabled: boolean; updatedAt: string }
    | { type: 'version'; name: string; version: string; updatedAt: string }
  > = []

  constructor(private registryPath: string) {}

  /** Return all installed plugins as a Map. */
  list(): Map<string, PluginEntry> {
    return new Map(Object.entries(this.data.installed))
  }

  /** Look up a plugin by name. Returns undefined if not installed. */
  get(name: string): PluginEntry | undefined {
    return this.data.installed[name]
  }

  /** Record a newly installed plugin. Timestamps are set automatically. */
  register(name: string, entry: RegisterInput): void {
    const now = new Date().toISOString()
    const complete = { ...entry, installedAt: now, updatedAt: now }
    this.data.installed[name] = complete
    this.pending.push({ type: 'restore', name, entry: structuredClone(complete) })
  }

  /** Restore an exact pre-transaction entry, including its original timestamps. */
  restore(name: string, entry: PluginEntry | undefined): void {
    if (entry) this.data.installed[name] = structuredClone(entry)
    else delete this.data.installed[name]
    this.pending.push({ type: 'restore', name, entry: entry ? structuredClone(entry) : undefined })
  }

  /** Remove a plugin from the registry. */
  remove(name: string): void {
    delete this.data.installed[name]
    this.pending.push({ type: 'remove', name })
  }

  /** Enable or disable a plugin. Disabled plugins are skipped at boot. */
  setEnabled(name: string, enabled: boolean): void {
    const entry = this.data.installed[name]
    if (!entry) return
    entry.enabled = enabled
    entry.updatedAt = new Date().toISOString()
    this.pending.push({ type: 'enabled', name, enabled, updatedAt: entry.updatedAt })
  }

  /** Update the stored version (called after successful migration). */
  updateVersion(name: string, version: string): void {
    const entry = this.data.installed[name]
    if (!entry) return
    entry.version = version
    entry.updatedAt = new Date().toISOString()
    this.pending.push({ type: 'version', name, version, updatedAt: entry.updatedAt })
  }

  /** Return only enabled plugins. */
  listEnabled(): Map<string, PluginEntry> {
    return new Map(Object.entries(this.data.installed).filter(([, e]) => e.enabled))
  }

  /** Filter plugins by installation source. */
  listBySource(source: PluginEntry['source']): Map<string, PluginEntry> {
    return new Map(Object.entries(this.data.installed).filter(([, e]) => e.source === source))
  }

  /** Load registry data from disk. Silently starts empty if file doesn't exist. */
  async load(): Promise<void> {
    this.loadDisk(true)
  }

  /** Read an independent disk snapshot without changing in-memory data or pending writes. */
  async readSnapshot(): Promise<Map<string, PluginEntry>> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryPath, 'utf-8')) as RegistryData
      if (parsed && parsed.installed && typeof parsed.installed === 'object') {
        return new Map(Object.entries(structuredClone(parsed.installed)))
      }
    } catch { /* absent/corrupt snapshots are reported as empty without mutating this writer */ }
    return new Map()
  }

  private loadDisk(clearPending: boolean): void {
    try {
      const content = fs.readFileSync(this.registryPath, 'utf-8')
      const parsed = JSON.parse(content)
      if (parsed && typeof parsed.installed === 'object') {
        this.data = parsed
      }
    } catch {
      this.data = { installed: {} }
    }
    if (clearPending) this.pending = []
  }

  private replayPending(operations: typeof this.pending): void {
    for (const operation of operations) {
      if (operation.type === 'restore') {
        if (operation.entry) this.data.installed[operation.name] = structuredClone(operation.entry)
        else delete this.data.installed[operation.name]
      } else if (operation.type === 'remove') delete this.data.installed[operation.name]
      else if (operation.type === 'enabled' && this.data.installed[operation.name]) Object.assign(this.data.installed[operation.name], { enabled: operation.enabled, updatedAt: operation.updatedAt })
      else if (operation.type === 'version' && this.data.installed[operation.name]) Object.assign(this.data.installed[operation.name], { version: operation.version, updatedAt: operation.updatedAt })
    }
  }

  /** Persist registry data to disk. */
  async save(): Promise<void> {
    const instanceRoot = path.dirname(this.registryPath)
    if (!pluginMutationLockHeld(instanceRoot)) {
      await withPluginMutationLock(instanceRoot, async () => {
        const operations = [...this.pending]
        this.loadDisk(false)
        this.replayPending(operations)
        await this.saveUnlocked()
        this.pending = this.pending.slice(operations.length)
      })
      return
    }
    await this.saveUnlocked()
    this.pending = []
  }

  /** Exact bytes that save() will persist for the current replayed state. */
  serializeCurrent(): Buffer {
    return Buffer.from(`${JSON.stringify(this.data, null, 2)}\n`)
  }

  private async saveUnlocked(): Promise<void> {
    const dir = path.dirname(this.registryPath)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temporary = `${this.registryPath}.${process.pid}.${Date.now()}.tmp`
    try {
      fs.writeFileSync(temporary, this.serializeCurrent(), { mode: 0o600, flag: 'wx' })
      const fd = fs.openSync(temporary, 'r'); fs.fsyncSync(fd); fs.closeSync(fd)
      fs.renameSync(temporary, this.registryPath)
      fs.chmodSync(this.registryPath, 0o600)
      try { const directoryFd = fs.openSync(dir, 'r'); fs.fsyncSync(directoryFd); fs.closeSync(directoryFd) } catch {}
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {}
    }
  }
}
