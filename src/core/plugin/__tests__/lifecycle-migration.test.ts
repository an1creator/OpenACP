import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { LifecycleManager } from '../lifecycle-manager.js'
import type { OpenACPPlugin, MigrateContext } from '../types.js'
import type { SettingsManager } from '../settings-manager.js'
import type { PluginRegistry, PluginEntry } from '../plugin-registry.js'

function makePlugin(name: string, opts?: Partial<OpenACPPlugin>): OpenACPPlugin {
  return {
    name,
    version: '1.0.0',
    permissions: [],
    setup: vi.fn().mockResolvedValue(undefined),
    teardown: vi.fn().mockResolvedValue(undefined),
    ...opts,
  }
}

function mockSettingsManager(settings: Record<string, Record<string, unknown>> = {}): SettingsManager {
  const stored: Record<string, Record<string, unknown>> = { ...settings }
  return {
    basePath: '/tmp/test',
    loadSettings: vi.fn(async (name: string) => stored[name] ?? {}),
    createAPI: vi.fn((name: string) => ({
      get: vi.fn(async (key: string) => (stored[name] ?? {})[key]),
      set: vi.fn(async (key: string, value: unknown) => {
        if (!stored[name]) stored[name] = {}
        stored[name][key] = value
      }),
      getAll: vi.fn(async () => stored[name] ?? {}),
      setAll: vi.fn(async (s: Record<string, unknown>) => { stored[name] = { ...s } }),
      delete: vi.fn(),
      clear: vi.fn(),
      has: vi.fn(),
    })),
    validateSettings: vi.fn(() => ({ valid: true })),
    getSettingsPath: vi.fn((name: string) => `/tmp/test/${name}/settings.json`),
    getPluginSettings: vi.fn(async (name: string) => stored[name] ?? {}),
    updatePluginSettings: vi.fn(),
  } as unknown as SettingsManager
}

function mockPluginRegistry(entries: Record<string, Partial<PluginEntry>> = {}): PluginRegistry {
  const data: Record<string, PluginEntry> = {}
  for (const [name, partial] of Object.entries(entries)) {
    data[name] = {
      version: '1.0.0',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'builtin',
      enabled: true,
      settingsPath: `/tmp/${name}/settings.json`,
      ...partial,
    }
  }
  return {
    get: vi.fn((name: string) => data[name]),
    list: vi.fn(() => new Map(Object.entries(data))),
    register: vi.fn(),
    remove: vi.fn(),
    restore: vi.fn((name: string, entry: PluginEntry | undefined) => {
      if (entry) data[name] = structuredClone(entry)
      else delete data[name]
    }),
    setEnabled: vi.fn((name: string, enabled: boolean) => {
      if (data[name]) data[name].enabled = enabled
    }),
    updateVersion: vi.fn((name: string, version: string) => {
      if (data[name]) data[name].version = version
    }),
    listEnabled: vi.fn(),
    listBySource: vi.fn(),
    load: vi.fn(),
    save: vi.fn(),
  } as unknown as PluginRegistry
}

describe('LifecycleManager — Migration Support', () => {
  it('quarantines community plugins on startup recovery failure while built-ins continue', async () => {
    const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-startup-recovery-'))
    try {
      fs.writeFileSync(path.join(instanceRoot, 'plugin-install.journal.json'), '{}', { mode: 0o600 })
      const builtin = makePlugin('builtin-plugin')
      const community = makePlugin('community-plugin')
      const registry = mockPluginRegistry({
        'builtin-plugin': { source: 'builtin' },
        'community-plugin': { source: 'npm' },
      })
      const events: Array<{ event: string; payload: any }> = []
      const mgr = new LifecycleManager({
        instanceRoot, pluginRegistry: registry,
        eventBus: { on() {}, off() {}, emit(event: string, payload: unknown) { events.push({ event, payload }) } },
      })

      await mgr.boot([builtin, community])

      expect(builtin.setup).toHaveBeenCalledOnce()
      expect(community.setup).not.toHaveBeenCalled()
      expect(mgr.failedPlugins).toContain('community-plugin')
      expect(events.some((entry) => entry.payload?.code === 'PLUGIN_RECOVERY_FAILED')).toBe(true)
    } finally { fs.rmSync(instanceRoot, { recursive: true, force: true }) }
  })

  it('calls migrate() when version mismatch detected', async () => {
    const migrateFn = vi.fn(async (_ctx: MigrateContext, _old: unknown, _oldVer: string) => ({ migrated: true }))
    const plugin = makePlugin('test-plugin', {
      version: '2.0.0',
      migrate: migrateFn,
    })

    const registry = mockPluginRegistry({ 'test-plugin': { version: '1.0.0' } })
    const settingsMgr = mockSettingsManager({ 'test-plugin': { oldKey: 'oldValue' } })

    const mgr = new LifecycleManager({
      pluginRegistry: registry,
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(migrateFn).toHaveBeenCalledOnce()
    expect(migrateFn).toHaveBeenCalledWith(
      expect.objectContaining({ pluginName: 'test-plugin' }),
      { oldKey: 'oldValue' },
      '1.0.0',
    )
    expect(registry.updateVersion).toHaveBeenCalledWith('test-plugin', '2.0.0')
    expect(registry.save).toHaveBeenCalled()
    expect(plugin.setup).toHaveBeenCalled()
  })

  it('skips migrate() when no version mismatch', async () => {
    const migrateFn = vi.fn()
    const plugin = makePlugin('test-plugin', {
      version: '1.0.0',
      migrate: migrateFn,
    })

    const registry = mockPluginRegistry({ 'test-plugin': { version: '1.0.0' } })
    const settingsMgr = mockSettingsManager()

    const mgr = new LifecycleManager({
      pluginRegistry: registry,
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(migrateFn).not.toHaveBeenCalled()
    expect(plugin.setup).toHaveBeenCalled()
  })

  it('skips migrate() when plugin not in registry', async () => {
    const migrateFn = vi.fn()
    const plugin = makePlugin('unknown-plugin', {
      version: '2.0.0',
      migrate: migrateFn,
    })

    const registry = mockPluginRegistry({})
    const settingsMgr = mockSettingsManager()

    const mgr = new LifecycleManager({
      pluginRegistry: registry,
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(migrateFn).not.toHaveBeenCalled()
    expect(plugin.setup).toHaveBeenCalled()
  })

  it('restores old settings and the exact registry entry when migrate() throws', async () => {
    const migrateFn = vi.fn(async (ctx: MigrateContext) => {
      await ctx.settings.set('partiallyWritten', true)
      throw new Error('migration exploded')
    })
    const plugin = makePlugin('test-plugin', {
      version: '2.0.0',
      migrate: migrateFn,
    })

    const registry = mockPluginRegistry({ 'test-plugin': { version: '1.0.0' } })
    const settingsMgr = mockSettingsManager({ 'test-plugin': { stable: 'old' } })

    const mgr = new LifecycleManager({
      pluginRegistry: registry,
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(migrateFn).toHaveBeenCalled()
    expect(plugin.setup).not.toHaveBeenCalled()
    expect(mgr.loadedPlugins).not.toContain('test-plugin')
    expect(mgr.failedPlugins).toContain('test-plugin')
    expect(registry.restore).toHaveBeenCalledWith('test-plugin', expect.objectContaining({ version: '1.0.0', enabled: true }))
    expect(registry.setEnabled).not.toHaveBeenCalled()
    expect(registry.save).toHaveBeenCalled()
    expect(await settingsMgr.loadSettings('test-plugin')).toEqual({ stable: 'old' })
  })

  it('restores the exact registry entry and settings when the commit save fails', async () => {
    const plugin = makePlugin('save-failure-plugin', {
      version: '2.0.0',
      migrate: vi.fn(async () => ({ migrated: true })),
    })
    const registry = mockPluginRegistry({
      'save-failure-plugin': {
        version: '1.0.0', enabled: true,
        installedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
        description: 'exact metadata',
      },
    })
    ;(registry.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('commit save failed')).mockResolvedValueOnce(undefined)
    const settingsMgr = mockSettingsManager({ 'save-failure-plugin': { stable: 'old' } })

    const mgr = new LifecycleManager({ pluginRegistry: registry, settingsManager: settingsMgr })
    await mgr.boot([plugin])

    expect(plugin.setup).not.toHaveBeenCalled()
    expect(registry.get('save-failure-plugin')).toEqual(expect.objectContaining({
      version: '1.0.0', enabled: true,
      installedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z',
      description: 'exact metadata',
    }))
    expect(await settingsMgr.loadSettings('save-failure-plugin')).toEqual({ stable: 'old' })
    expect(registry.save).toHaveBeenCalledTimes(2)
  })

  it('retains a durable quarantine when rollback registry persistence fails', async () => {
    const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-migration-quarantine-'))
    try {
      const plugin = makePlugin('rollback-failure-plugin', {
        version: '2.0.0',
        migrate: vi.fn(async () => { throw new Error('migration failed') }),
      })
      const registry = mockPluginRegistry({ 'rollback-failure-plugin': { version: '1.0.0', source: 'npm' } })
      ;(registry.save as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('rollback save failed'))
      const settingsMgr = mockSettingsManager({ 'rollback-failure-plugin': { stable: 'old' } })
      const events: Array<{ event: string; payload: any }> = []
      const mgr = new LifecycleManager({
        instanceRoot, pluginRegistry: registry, settingsManager: settingsMgr,
        eventBus: { on() {}, off() {}, emit(event: string, payload: unknown) { events.push({ event, payload }) } },
      })

      await mgr.boot([plugin])

      expect(plugin.setup).not.toHaveBeenCalled()
      expect(registry.get('rollback-failure-plugin')).toEqual(expect.objectContaining({ version: '1.0.0', enabled: true }))
      expect(events.some((entry) => entry.payload?.code === 'PLUGIN_MIGRATION_ROLLBACK_FAILED')).toBe(true)
      expect(fs.readdirSync(path.join(instanceRoot, 'plugin-migration-quarantine'))).toHaveLength(1)
      const afterRestart = makePlugin('rollback-failure-plugin')
      const restarted = new LifecycleManager({ instanceRoot, pluginRegistry: registry, settingsManager: settingsMgr })
      await restarted.boot([afterRestart])
      expect(afterRestart.setup).not.toHaveBeenCalled()
    } finally { fs.rmSync(instanceRoot, { recursive: true, force: true }) }
  })

  it('reads pluginConfig from settings.json instead of config.json', async () => {
    const plugin = makePlugin('test-plugin', {
      setup: vi.fn(async (ctx) => {
        expect(ctx.pluginConfig).toEqual({ fromSettings: true })
      }),
    })

    const settingsMgr = mockSettingsManager({ 'test-plugin': { fromSettings: true } })

    const mgr = new LifecycleManager({
      settingsManager: settingsMgr,
      config: { get: () => ({ speech: { fromConfig: true } }) } as any,
    })
    await mgr.boot([plugin])

    expect(plugin.setup).toHaveBeenCalled()
  })

  it('skips disabled plugins (setup not called)', async () => {
    const plugin = makePlugin('disabled-plugin')
    const emitEvents: Array<{ event: string; payload: unknown }> = []

    const registry = mockPluginRegistry({ 'disabled-plugin': { enabled: false } })

    const mgr = new LifecycleManager({
      pluginRegistry: registry,
      eventBus: {
        on() {},
        off() {},
        emit(event: string, payload: unknown) { emitEvents.push({ event, payload }) },
      },
    })
    await mgr.boot([plugin])

    expect(plugin.setup).not.toHaveBeenCalled()
    expect(mgr.loadedPlugins).not.toContain('disabled-plugin')
    expect(emitEvents.some(e => e.event === 'plugin:disabled')).toBe(true)
  })
})

describe('LifecycleManager — Settings Validation', () => {
  it('skips plugin when settingsSchema validation fails (setup not called)', async () => {
    const schema = z.object({
      apiKey: z.string().min(1),
      port: z.number().int().positive(),
    })

    const plugin = makePlugin('validated-plugin', {
      settingsSchema: schema,
    })

    // Invalid settings: missing apiKey, port is a string
    const settingsMgr = mockSettingsManager({ 'validated-plugin': { port: 'not-a-number' } })
    // Make validateSettings actually validate against the schema
    ;(settingsMgr.validateSettings as ReturnType<typeof vi.fn>).mockImplementation(
      (_name: string, settings: unknown, s?: z.ZodSchema) => {
        if (!s) return { valid: true }
        const result = s.safeParse(settings)
        if (result.success) return { valid: true }
        return {
          valid: false,
          errors: result.error.issues.map(
            (e) => `${e.path.map(String).join('.')}: ${e.message}`,
          ),
        }
      },
    )

    const emitEvents: Array<{ event: string; payload: unknown }> = []

    const mgr = new LifecycleManager({
      settingsManager: settingsMgr,
      eventBus: {
        on() {},
        off() {},
        emit(event: string, payload: unknown) { emitEvents.push({ event, payload }) },
      },
    })
    await mgr.boot([plugin])

    expect(plugin.setup).not.toHaveBeenCalled()
    expect(mgr.loadedPlugins).not.toContain('validated-plugin')
    expect(mgr.failedPlugins).toContain('validated-plugin')
    expect(emitEvents.some(e => e.event === 'plugin:failed')).toBe(true)
  })

  it('proceeds with setup when settingsSchema validation passes', async () => {
    const schema = z.object({
      apiKey: z.string().min(1),
      port: z.number().int().positive(),
    })

    const plugin = makePlugin('validated-plugin', {
      settingsSchema: schema,
    })

    const settingsMgr = mockSettingsManager({ 'validated-plugin': { apiKey: 'abc123', port: 8080 } })
    ;(settingsMgr.validateSettings as ReturnType<typeof vi.fn>).mockImplementation(
      (_name: string, settings: unknown, s?: z.ZodSchema) => {
        if (!s) return { valid: true }
        const result = s.safeParse(settings)
        if (result.success) return { valid: true }
        return {
          valid: false,
          errors: result.error.issues.map(
            (e) => `${e.path.map(String).join('.')}: ${e.message}`,
          ),
        }
      },
    )

    const mgr = new LifecycleManager({
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(plugin.setup).toHaveBeenCalled()
    expect(mgr.loadedPlugins).toContain('validated-plugin')
  })

  it('skips validation when plugin has no settingsSchema', async () => {
    const plugin = makePlugin('no-schema-plugin')

    const settingsMgr = mockSettingsManager({ 'no-schema-plugin': { anything: 'goes' } })

    const mgr = new LifecycleManager({
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(settingsMgr.validateSettings).not.toHaveBeenCalled()
    expect(plugin.setup).toHaveBeenCalled()
    expect(mgr.loadedPlugins).toContain('no-schema-plugin')
  })

  it('skips validation when no settingsManager is available', async () => {
    const schema = z.object({ key: z.string() })
    const plugin = makePlugin('no-mgr-plugin', { settingsSchema: schema })

    const mgr = new LifecycleManager({})
    await mgr.boot([plugin])

    expect(plugin.setup).toHaveBeenCalled()
    expect(mgr.loadedPlugins).toContain('no-mgr-plugin')
  })

  it('validates settings after migration completes', async () => {
    const schema = z.object({
      apiKey: z.string().min(1),
    })

    const migrateFn = vi.fn(async (_ctx: MigrateContext, _old: unknown, _oldVer: string) => ({
      apiKey: '', // Returns invalid settings after migration
    }))

    const plugin = makePlugin('migrate-validate-plugin', {
      version: '2.0.0',
      migrate: migrateFn,
      settingsSchema: schema,
    })

    const registry = mockPluginRegistry({ 'migrate-validate-plugin': { version: '1.0.0' } })
    const settingsMgr = mockSettingsManager({ 'migrate-validate-plugin': { apiKey: 'old-valid-key' } })
    ;(settingsMgr.validateSettings as ReturnType<typeof vi.fn>).mockImplementation(
      (_name: string, settings: unknown, s?: z.ZodSchema) => {
        if (!s) return { valid: true }
        const result = s.safeParse(settings)
        if (result.success) return { valid: true }
        return {
          valid: false,
          errors: result.error.issues.map(
            (e) => `${e.path.map(String).join('.')}: ${e.message}`,
          ),
        }
      },
    )

    const mgr = new LifecycleManager({
      pluginRegistry: registry,
      settingsManager: settingsMgr,
    })
    await mgr.boot([plugin])

    expect(migrateFn).toHaveBeenCalled()
    expect(plugin.setup).not.toHaveBeenCalled()
    expect(mgr.failedPlugins).toContain('migrate-validate-plugin')
    expect(registry.restore).toHaveBeenCalledWith('migrate-validate-plugin', expect.objectContaining({ version: '1.0.0' }))
    expect(await settingsMgr.loadSettings('migrate-validate-plugin')).toEqual({ apiKey: 'old-valid-key' })
  })
})
