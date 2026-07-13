import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PluginRegistry } from '../plugin-registry.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('PluginRegistry', () => {
  let tmpDir: string
  let registryPath: string
  let registry: PluginRegistry

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-registry-'))
    registryPath = path.join(tmpDir, 'registry.json')
    registry = new PluginRegistry(registryPath)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true })
    vi.restoreAllMocks()
  })

  describe('register', () => {
    it('registers a new plugin with auto-generated timestamps', () => {
      const before = new Date().toISOString()
      registry.register('my-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/path/to/settings',
        description: 'A test plugin',
      })
      const after = new Date().toISOString()

      const entry = registry.get('my-plugin')
      expect(entry).toBeDefined()
      expect(entry!.version).toBe('1.0.0')
      expect(entry!.source).toBe('npm')
      expect(entry!.enabled).toBe(true)
      expect(entry!.settingsPath).toBe('/path/to/settings')
      expect(entry!.description).toBe('A test plugin')
      expect(entry!.installedAt).toBeDefined()
      expect(entry!.updatedAt).toBeDefined()
      expect(entry!.installedAt >= before).toBe(true)
      expect(entry!.installedAt <= after).toBe(true)
      expect(entry!.installedAt).toBe(entry!.updatedAt)
    })
  })

  describe('remove', () => {
    it('removes existing plugin', () => {
      registry.register('my-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/path/to/settings',
      })
      expect(registry.get('my-plugin')).toBeDefined()

      registry.remove('my-plugin')
      expect(registry.get('my-plugin')).toBeUndefined()
    })

    it('no-ops for non-existent plugin', () => {
      // Should not throw
      registry.remove('non-existent')
      expect(registry.get('non-existent')).toBeUndefined()
    })
  })

  it('restores an exact entry after a failed install transaction', () => {
    registry.register('plugin', { version: '1.0.0', source: 'npm', enabled: true, settingsPath: '/settings' })
    const before = structuredClone(registry.get('plugin')!)
    registry.register('plugin', { version: '2.0.0', source: 'npm', enabled: true, settingsPath: '/settings' })
    registry.restore('plugin', before)
    expect(registry.get('plugin')).toEqual(before)
  })

  describe('setEnabled', () => {
    it('toggles enabled state and updates updatedAt', () => {
      registry.register('my-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/path/to/settings',
      })
      const originalUpdatedAt = registry.get('my-plugin')!.updatedAt

      // Small delay to ensure timestamp differs
      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.now() + 1000))

      registry.setEnabled('my-plugin', false)

      const entry = registry.get('my-plugin')
      expect(entry!.enabled).toBe(false)
      expect(entry!.updatedAt > originalUpdatedAt).toBe(true)

      vi.useRealTimers()
    })
  })

  describe('updateVersion', () => {
    it('updates version and updatedAt', () => {
      registry.register('my-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/path/to/settings',
      })
      const originalUpdatedAt = registry.get('my-plugin')!.updatedAt

      vi.useFakeTimers()
      vi.setSystemTime(new Date(Date.now() + 1000))

      registry.updateVersion('my-plugin', '2.0.0')

      const entry = registry.get('my-plugin')
      expect(entry!.version).toBe('2.0.0')
      expect(entry!.updatedAt > originalUpdatedAt).toBe(true)

      vi.useRealTimers()
    })
  })

  describe('list', () => {
    it('returns all registered plugins as Map', () => {
      registry.register('plugin-a', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/a',
      })
      registry.register('plugin-b', {
        version: '2.0.0',
        source: 'local',
        enabled: false,
        settingsPath: '/b',
      })

      const all = registry.list()
      expect(all).toBeInstanceOf(Map)
      expect(all.size).toBe(2)
      expect(all.has('plugin-a')).toBe(true)
      expect(all.has('plugin-b')).toBe(true)
    })
  })

  describe('listEnabled', () => {
    it('returns only enabled plugins', () => {
      registry.register('enabled-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/a',
      })
      registry.register('disabled-plugin', {
        version: '2.0.0',
        source: 'npm',
        enabled: false,
        settingsPath: '/b',
      })

      const enabled = registry.listEnabled()
      expect(enabled.size).toBe(1)
      expect(enabled.has('enabled-plugin')).toBe(true)
      expect(enabled.has('disabled-plugin')).toBe(false)
    })
  })

  describe('listBySource', () => {
    it('filters by source type', () => {
      registry.register('npm-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/a',
      })
      registry.register('local-plugin', {
        version: '1.0.0',
        source: 'local',
        enabled: true,
        settingsPath: '/b',
      })
      registry.register('builtin-plugin', {
        version: '1.0.0',
        source: 'builtin',
        enabled: true,
        settingsPath: '/c',
      })

      const npmPlugins = registry.listBySource('npm')
      expect(npmPlugins.size).toBe(1)
      expect(npmPlugins.has('npm-plugin')).toBe(true)

      const localPlugins = registry.listBySource('local')
      expect(localPlugins.size).toBe(1)
      expect(localPlugins.has('local-plugin')).toBe(true)

      const builtinPlugins = registry.listBySource('builtin')
      expect(builtinPlugins.size).toBe(1)
      expect(builtinPlugins.has('builtin-plugin')).toBe(true)
    })
  })

  describe('persistence', () => {
    it('serializes concurrent registry writers without losing independent mutations', async () => {
      const first = new PluginRegistry(registryPath)
      const second = new PluginRegistry(registryPath)
      await Promise.all([first.load(), second.load()])
      first.register('plugin-a', { version: '1.0.0', source: 'npm', enabled: true, settingsPath: '/a' })
      second.register('plugin-b', { version: '1.0.0', source: 'npm', enabled: true, settingsPath: '/b' })
      await Promise.all([first.save(), second.save()])

      const result = new PluginRegistry(registryPath)
      await result.load()
      expect([...result.list().keys()].sort()).toEqual(['plugin-a', 'plugin-b'])

      const enableWriter = new PluginRegistry(registryPath)
      const removeWriter = new PluginRegistry(registryPath)
      await Promise.all([enableWriter.load(), removeWriter.load()])
      enableWriter.setEnabled('plugin-a', false)
      removeWriter.remove('plugin-b')
      await Promise.all([enableWriter.save(), removeWriter.save()])
      await result.load()
      expect(result.get('plugin-a')?.enabled).toBe(false)
      expect(result.get('plugin-b')).toBeUndefined()
    })

    it('fails closed before a registry mutation when an install journal is corrupt', async () => {
      const guardedPath = path.join(tmpDir, 'plugins.json')
      fs.writeFileSync(path.join(tmpDir, 'plugin-install.journal.json'), '{"version":999}', { mode: 0o600 })
      const guarded = new PluginRegistry(guardedPath)
      guarded.register('must-not-persist', { version: '1.0.0', source: 'npm', enabled: true, settingsPath: '/x' })
      await expect(guarded.save()).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
      expect(fs.existsSync(guardedPath)).toBe(false)
    })

    it('readSnapshot never clears another pending mutation', async () => {
      registry.register('pending-plugin', { version: '1.0.0', source: 'npm', enabled: true, settingsPath: '/pending' })
      expect((await registry.readSnapshot()).has('pending-plugin')).toBe(false)
      await registry.save()
      const loaded = new PluginRegistry(registryPath)
      await loaded.load()
      expect(loaded.get('pending-plugin')).toBeDefined()
    })

    it('save and load round-trip', async () => {
      registry.register('my-plugin', {
        version: '1.0.0',
        source: 'npm',
        enabled: true,
        settingsPath: '/path/to/settings',
        description: 'Test',
      })

      await registry.save()

      const registry2 = new PluginRegistry(registryPath)
      await registry2.load()

      const entry = registry2.get('my-plugin')
      expect(entry).toBeDefined()
      expect(entry!.version).toBe('1.0.0')
      expect(entry!.source).toBe('npm')
      expect(entry!.enabled).toBe(true)
      expect(entry!.settingsPath).toBe('/path/to/settings')
      expect(entry!.description).toBe('Test')
      expect(fs.statSync(registryPath).mode & 0o777).toBe(0o600)
    })

    it('load with no file returns empty', async () => {
      const nonExistentPath = path.join(tmpDir, 'nonexistent', 'registry.json')
      const emptyRegistry = new PluginRegistry(nonExistentPath)
      await emptyRegistry.load()

      expect(emptyRegistry.list().size).toBe(0)
    })

    it('load with corrupted file returns empty', async () => {
      fs.writeFileSync(registryPath, 'not valid json {{{')

      const corruptedRegistry = new PluginRegistry(registryPath)
      await corruptedRegistry.load()

      expect(corruptedRegistry.list().size).toBe(0)
    })
  })
})
