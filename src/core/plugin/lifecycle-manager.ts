import { resolveLoadOrder } from './plugin-loader.js'
import { ServiceRegistry } from './service-registry.js'
import { MiddlewareChain } from './middleware-chain.js'
import { ErrorTracker } from './error-tracker.js'
import { createPluginContext } from './plugin-context.js'
import type { OpenACPPlugin, EventBus, Logger, MigrateContext } from './types.js'
import type { SettingsManager } from './settings-manager.js'
import type { PluginRegistry } from './plugin-registry.js'
import { BusEvent } from '../events.js'
import { recoverPluginInstallTransaction, PluginInstallError } from './plugin-installer.js'
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

const SETUP_TIMEOUT_MS = 30_000   // plugin.setup() must complete within 30s
const TEARDOWN_TIMEOUT_MS = 10_000 // plugin.teardown() must complete within 10s

function migrationGuardPath(instanceRoot: string, pluginName: string): string {
  return path.join(instanceRoot, 'plugin-migration-quarantine', `${createHash('sha256').update(pluginName).digest('hex')}.json`)
}

function writeMigrationGuard(instanceRoot: string, pluginName: string, fromVersion: string, toVersion: string): string {
  const guardPath = migrationGuardPath(instanceRoot, pluginName)
  const directory = path.dirname(guardPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700)
  const temporary = `${guardPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, pluginName, fromVersion, toVersion, createdAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    const fd = fs.openSync(temporary, 'r'); fs.fsyncSync(fd); fs.closeSync(fd)
    fs.renameSync(temporary, guardPath); fs.chmodSync(guardPath, 0o600)
    try { const dir = fs.openSync(directory, 'r'); fs.fsyncSync(dir); fs.closeSync(dir) } catch {}
  } finally { try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch {} }
  return guardPath
}

/** Wraps a promise with a timeout; rejects if the promise doesn't settle in `ms` milliseconds. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms)
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      ;(timer as NodeJS.Timeout).unref()
    }
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/**
 * Extracts a plugin's config from the global ConfigManager.
 * Tries the new `plugins.builtin['<name>'].config` format first,
 * then falls back to legacy config paths for backward compatibility.
 */
function resolvePluginConfig(pluginName: string, configManager: unknown): Record<string, unknown> {
  try {
    const allConfig = (configManager as any)?.get?.() ?? {}
    // Try new format: plugins.builtin['@openacp/speech'].config
    const pluginEntry = allConfig.plugins?.builtin?.[pluginName]
    if (pluginEntry?.config && Object.keys(pluginEntry.config).length > 0) {
      return pluginEntry.config
    }
    // @deprecated Legacy config path mapping — kept for backward compat with pre-plugin configs.
    // New plugins should use plugins.builtin['<name>'].config format. Remove when all users have migrated.
    const legacyMap: Record<string, string> = {
      '@openacp/security': 'security',
      '@openacp/speech': 'speech',
      '@openacp/tunnel': 'tunnel',
      '@openacp/usage': 'usage',
      '@openacp/file-service': 'files',
      '@openacp/api-server': 'api',
      '@openacp/telegram': 'channels.telegram',
      '@openacp/discord-adapter': 'channels.discord',
      '@openacp/slack-adapter': 'channels.slack',
    }
    const legacyKey = legacyMap[pluginName]
    if (legacyKey) {
      const parts = legacyKey.split('.')
      let obj: any = allConfig
      for (const p of parts) obj = obj?.[p]
      if (obj && typeof obj === 'object') return { ...obj }
    }
  } catch {
    // Gracefully degrade — return empty config
  }
  return {}
}

/** Options for constructing a LifecycleManager. All fields are optional with sensible defaults. */
export interface LifecycleManagerOpts {
  serviceRegistry?: ServiceRegistry
  middlewareChain?: MiddlewareChain
  errorTracker?: ErrorTracker
  eventBus?: EventBus & {
    on(event: string, handler: (...args: unknown[]) => void): void
    off(event: string, handler: (...args: unknown[]) => void): void
    emit(event: string, payload: unknown): void
  }
  storagePath?: string
  sessions?: unknown
  config?: unknown
  core?: unknown
  log?: Logger
  settingsManager?: SettingsManager
  pluginRegistry?: PluginRegistry
  /** Root directory for this OpenACP instance (default: ~/.openacp) */
  instanceRoot?: string
}

/**
 * Orchestrates plugin boot, teardown, and hot-reload.
 *
 * Boot sequence:
 * 1. Topological sort by `pluginDependencies` — ensures a plugin's deps are ready first
 * 2. Version migration if registry version != plugin version
 * 3. Settings validation against Zod schema
 * 4. Create scoped PluginContext, call `plugin.setup(ctx)` with timeout
 *
 * Error isolation: if a plugin's setup() fails, it is marked as failed and skipped.
 * Any plugin that depends on a failed plugin is also skipped (cascade failure).
 * Other independent plugins continue booting normally.
 *
 * Shutdown calls teardown() in reverse boot order — dependencies are torn down last.
 */
export class LifecycleManager {
  readonly serviceRegistry: ServiceRegistry
  readonly middlewareChain: MiddlewareChain
  readonly errorTracker: ErrorTracker

  private eventBus: LifecycleManagerOpts['eventBus']
  private storagePath: string
  private sessions: unknown
  private config: unknown
  private core: unknown
  private log: Logger | undefined
  settingsManager: SettingsManager | undefined
  private pluginRegistry: PluginRegistry | undefined
  private _instanceRoot: string | undefined
  private installRecoveryChecked = false
  private communityRecoveryError: string | undefined

  private contexts = new Map<string, ReturnType<typeof createPluginContext>>()
  private loadOrder: OpenACPPlugin[] = []
  private _loaded = new Set<string>()
  private _failed = new Set<string>()

  /** Names of plugins that successfully completed setup(). */
  get loadedPlugins(): string[] {
    return [...this._loaded]
  }

  /** Names of plugins whose setup() threw an error. These plugins are skipped but don't crash the system. */
  get failedPlugins(): string[] {
    return [...this._failed]
  }

  /** The PluginRegistry tracking installed and enabled plugin state. */
  get registry(): PluginRegistry | undefined {
    return this.pluginRegistry
  }

  /** Plugin definitions currently in load order (loaded + failed). */
  get plugins(): OpenACPPlugin[] {
    return [...this.loadOrder]
  }

  /** Root directory of this OpenACP instance (e.g. ~/.openacp). */
  get instanceRoot(): string | undefined {
    return this._instanceRoot
  }

  constructor(opts?: LifecycleManagerOpts) {
    this.serviceRegistry = opts?.serviceRegistry ?? new ServiceRegistry()
    this.middlewareChain = opts?.middlewareChain ?? new MiddlewareChain()
    this.errorTracker = opts?.errorTracker ?? new ErrorTracker()
    this.eventBus = opts?.eventBus ?? {
      on() {},
      off() {},
      emit() {},
    }
    this.storagePath = opts?.storagePath ?? '/tmp/openacp-plugins'
    this.sessions = opts?.sessions ?? {}
    this.config = opts?.config ?? {}
    this.core = opts?.core
    this.log = opts?.log
    this.settingsManager = opts?.settingsManager
    this.pluginRegistry = opts?.pluginRegistry
    this._instanceRoot = opts?.instanceRoot
  }

  private getPluginLogger(pluginName: string): Logger {
    if (this.log && typeof (this.log as any).child === 'function') {
      return (this.log as any).child({ plugin: pluginName })
    }
    return this.log ?? { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this } } as Logger
  }

  /**
   * Boot a set of plugins in dependency order.
   *
   * Can be called multiple times (e.g., core plugins first, then dev plugins later).
   * Already-loaded plugins are included in dependency resolution but not re-booted.
   */
  async boot(plugins: OpenACPPlugin[]): Promise<void> {
    if (!this.installRecoveryChecked && this._instanceRoot && this.pluginRegistry) {
      this.installRecoveryChecked = true
      try {
        await recoverPluginInstallTransaction(this._instanceRoot)
        await this.pluginRegistry.load()
      } catch (error) {
        const code = error instanceof PluginInstallError ? error.code : 'PLUGIN_RECOVERY_FAILED'
        this.communityRecoveryError = `${code}: Community plugin transaction recovery did not complete; community plugins are quarantined until recovery succeeds.`
        this.log?.error(this.communityRecoveryError)
      }
    }

    // Resolve load order via topological sort.
    // resolveLoadOrder will skip plugins whose dependencies are missing entirely
    // (not present in the input list). But we also need to handle runtime setup failures.
    // Include already-loaded plugins so dependency checks pass for late-booted plugins
    // (e.g., dev plugins booted after core plugins).
    const newNames = new Set(plugins.map(p => p.name))
    const allForResolution = [...this.loadOrder.filter(p => !newNames.has(p.name)), ...plugins]

    let sorted: OpenACPPlugin[]
    try {
      sorted = resolveLoadOrder(allForResolution)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.log?.error(`Plugin dependency resolution failed: ${error.message}`)
      for (const p of plugins) {
        this._failed.add(p.name)
      }
      return
    }

    // Only boot new plugins (already-loaded ones were included just for dependency resolution)
    sorted = sorted.filter(p => newNames.has(p.name))

    // Append to existing loadOrder (don't overwrite — hot-reload boots single plugins)
    for (const p of sorted) {
      if (!this.loadOrder.some(existing => existing.name === p.name)) {
        this.loadOrder.push(p)
      } else {
        // Replace in-place (hot-reload case: plugin was unloaded then re-booted)
        const idx = this.loadOrder.findIndex(existing => existing.name === p.name)
        this.loadOrder[idx] = p
      }
    }

    for (const plugin of sorted) {
      // Check if any required dependency failed at runtime
      if (plugin.pluginDependencies) {
        const depFailed = Object.keys(plugin.pluginDependencies).some(
          (dep) => this._failed.has(dep),
        )
        if (depFailed) {
          this._failed.add(plugin.name)
          continue
        }
      }

      // Check if disabled in registry
      const registryEntry = this.pluginRegistry?.get(plugin.name)
      if (registryEntry && registryEntry.source !== 'builtin' && this.communityRecoveryError) {
        this._failed.add(plugin.name)
        this.eventBus?.emit(BusEvent.PLUGIN_FAILED, { name: plugin.name, code: 'PLUGIN_RECOVERY_FAILED', error: this.communityRecoveryError })
        continue
      }
      if (this._instanceRoot && fs.existsSync(migrationGuardPath(this._instanceRoot, plugin.name))) {
        const status = `PLUGIN_MIGRATION_ROLLBACK_FAILED: ${plugin.name} has a durable migration quarantine marker. Repair or restore its settings and registry entry, then remove the marker before re-enabling it.`
        this._failed.add(plugin.name)
        this.getPluginLogger(plugin.name).error(status)
        this.eventBus?.emit(BusEvent.PLUGIN_FAILED, { name: plugin.name, code: 'PLUGIN_MIGRATION_ROLLBACK_FAILED', error: status })
        continue
      }
      if (registryEntry && registryEntry.enabled === false) {
        this.eventBus?.emit(BusEvent.PLUGIN_DISABLED, { name: plugin.name })
        continue
      }

      // Check version mismatch → migrate
      if (registryEntry && plugin.migrate && registryEntry.version !== plugin.version && this.settingsManager) {
        const oldSettings = structuredClone(await this.settingsManager.loadSettings(plugin.name))
        const oldRegistryEntry = structuredClone(registryEntry)
        const migrationGuard = this._instanceRoot
          ? writeMigrationGuard(this._instanceRoot, plugin.name, registryEntry.version, plugin.version)
          : undefined
        try {
          const pluginLog = this.getPluginLogger(plugin.name)
          const migrateCtx: MigrateContext = {
            pluginName: plugin.name,
            settings: this.settingsManager.createAPI(plugin.name),
            log: pluginLog,
          }
          const newSettings = await withTimeout(
            plugin.migrate(migrateCtx, oldSettings, registryEntry.version),
            SETUP_TIMEOUT_MS,
            `${plugin.name}.migrate()`,
          )
          const migratedSettings = newSettings && typeof newSettings === 'object'
            ? newSettings as Record<string, unknown>
            : await migrateCtx.settings.getAll()
          if (plugin.settingsSchema) {
            const validation = this.settingsManager.validateSettings(plugin.name, migratedSettings, plugin.settingsSchema)
            if (!validation.valid) throw new Error(`migrated settings invalid: ${validation.errors?.join('; ')}`)
          }
          await migrateCtx.settings.setAll(migratedSettings)
          this.pluginRegistry!.updateVersion(plugin.name, plugin.version)
          await this.pluginRegistry!.save()
          if (migrationGuard) fs.rmSync(migrationGuard, { force: true })
        } catch {
          let settingsRestored = true
          try { await this.settingsManager.createAPI(plugin.name).setAll(oldSettings) } catch { settingsRestored = false }
          this.pluginRegistry!.restore(plugin.name, oldRegistryEntry)
          let registryRestored = true
          try { await this.pluginRegistry!.save() } catch { registryRestored = false }
          if (settingsRestored && registryRestored && migrationGuard) fs.rmSync(migrationGuard, { force: true })
          this._failed.add(plugin.name)
          const rollbackComplete = settingsRestored && registryRestored
          const code = rollbackComplete ? 'PLUGIN_MIGRATION_FAILED' : 'PLUGIN_MIGRATION_ROLLBACK_FAILED'
          const recovery = rollbackComplete
            ? 'the exact previous registry entry and settings were restored'
            : 'rollback persistence was incomplete and the durable migration quarantine remains in place'
          const status = `${code}: ${plugin.name} migration ${oldRegistryEntry.version} → ${plugin.version} failed; ${recovery}. Fix the migration/settings before retrying.`
          this.getPluginLogger(plugin.name).error(status)
          this.eventBus?.emit(BusEvent.PLUGIN_FAILED, { name: plugin.name, code, error: status })
          continue
        }
      }

      // Resolve config: prefer settings.json, fallback to legacy
      let pluginConfig: Record<string, unknown>
      if (this.settingsManager) {
        pluginConfig = await this.settingsManager.loadSettings(plugin.name)
        const settingsPath = this.settingsManager.getSettingsPath(plugin.name)
        this.getPluginLogger(plugin.name).debug(`Settings loaded from ${settingsPath}: ${Object.keys(pluginConfig).length} keys`)
        if (Object.keys(pluginConfig).length === 0) {
          pluginConfig = resolvePluginConfig(plugin.name, this.config)
        }
      } else {
        pluginConfig = resolvePluginConfig(plugin.name, this.config)
        this.getPluginLogger(plugin.name).debug('No settingsManager, using legacy config')
      }

      // Validate settings against schema if plugin provides one
      if (plugin.settingsSchema && this.settingsManager) {
        const validation = this.settingsManager.validateSettings(plugin.name, pluginConfig, plugin.settingsSchema)
        if (!validation.valid) {
          this._failed.add(plugin.name)
          this.getPluginLogger(plugin.name).error(`Settings validation failed: ${validation.errors?.join('; ')}`)
          this.eventBus?.emit(BusEvent.PLUGIN_FAILED, { name: plugin.name, error: `Settings validation failed: ${validation.errors?.join('; ')}` })
          continue
        }
      }

      // Create context for this plugin
      const ctx = createPluginContext({
        pluginName: plugin.name,
        pluginConfig,
        permissions: plugin.permissions ?? [],
        serviceRegistry: this.serviceRegistry,
        middlewareChain: this.middlewareChain,
        errorTracker: this.errorTracker,
        eventBus: this.eventBus!,
        storagePath: `${this.storagePath}/${plugin.name}`,
        sessions: this.sessions,
        config: this.config,
        core: this.core,
        log: this.log,
        instanceRoot: this._instanceRoot,
      })

      try {
        await withTimeout(plugin.setup(ctx), SETUP_TIMEOUT_MS, `${plugin.name}.setup()`)
        this.contexts.set(plugin.name, ctx)
        this._loaded.add(plugin.name)
        this.eventBus?.emit(BusEvent.PLUGIN_LOADED, { name: plugin.name, version: plugin.version })
      } catch (err) {
        this._failed.add(plugin.name)
        ctx.cleanup()
        console.error(`[lifecycle] Plugin ${plugin.name} setup() FAILED:`, err)
        this.getPluginLogger(plugin.name).error(`setup() failed: ${err}`)
        this.eventBus?.emit(BusEvent.PLUGIN_FAILED, { name: plugin.name, error: String(err) })
      }
    }
  }

  /**
   * Unload a single plugin: call teardown(), clean up its context
   * (listeners, middleware, services), and remove from tracked state.
   * Used for hot-reload: unload → rebuild → re-boot.
   */
  async unloadPlugin(name: string): Promise<void> {
    if (!this._loaded.has(name)) return

    const plugin = this.loadOrder.find(p => p.name === name)

    if (plugin?.teardown) {
      try {
        await withTimeout(plugin.teardown(), TEARDOWN_TIMEOUT_MS, `${name}.teardown()`)
      } catch {
        // Swallow teardown errors
      }
    }

    const ctx = this.contexts.get(name)
    if (ctx) {
      ctx.cleanup()
      this.contexts.delete(name)
    }

    this._loaded.delete(name)
    this._failed.delete(name)
    this.loadOrder = this.loadOrder.filter(p => p.name !== name)

    this.eventBus?.emit(BusEvent.PLUGIN_UNLOADED, { name })
  }

  /**
   * Gracefully shut down all loaded plugins.
   * Teardown runs in reverse boot order so that dependencies outlive their dependents.
   */
  async shutdown(): Promise<void> {
    // Teardown in reverse load order
    const reversed = [...this.loadOrder].reverse()

    for (const plugin of reversed) {
      if (!this._loaded.has(plugin.name)) continue

      if (plugin.teardown) {
        try {
          await withTimeout(plugin.teardown(), TEARDOWN_TIMEOUT_MS, `${plugin.name}.teardown()`)
        } catch {
          // Swallow teardown errors — graceful shutdown
        }
      }

      // Clean up the context
      const ctx = this.contexts.get(plugin.name)
      if (ctx) {
        ctx.cleanup()
        this.contexts.delete(plugin.name)
      }

      this.eventBus?.emit(BusEvent.PLUGIN_UNLOADED, { name: plugin.name })
    }

    this._loaded.clear()
    this.loadOrder = []
  }
}
