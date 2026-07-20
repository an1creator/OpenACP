import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsManager } from '../core/plugin/settings-manager.js'
import { PluginRegistry } from '../core/plugin/plugin-registry.js'
import { ensureAttachmentDeliveryBuiltinRegistration } from '../main.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('attachment delivery built-in registration', () => {
  it('adds the built-in once without replacing existing registry entries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openacp-attachment-registration-'))
    temporaryDirectories.push(root)
    const settingsManager = new SettingsManager(path.join(root, 'settings'))
    const registryPath = path.join(root, 'plugins', 'registry.json')
    const registry = new PluginRegistry(registryPath)
    await registry.load()
    registry.register('@example/existing', {
      version: '9.8.7',
      source: 'local',
      enabled: false,
      settingsPath: '/preserved/settings.json',
      description: 'Preserve this entry',
    })
    await registry.save()

    expect(await ensureAttachmentDeliveryBuiltinRegistration(settingsManager, registry)).toBe(true)
    const reloaded = new PluginRegistry(registryPath)
    await reloaded.load()
    expect(reloaded.get('@example/existing')).toMatchObject({
      version: '9.8.7',
      source: 'local',
      enabled: false,
      settingsPath: '/preserved/settings.json',
    })
    expect(reloaded.get('@openacp/attachment-delivery')).toMatchObject({
      version: '1.0.0',
      source: 'builtin',
      enabled: true,
      settingsPath: settingsManager.getSettingsPath('@openacp/attachment-delivery'),
    })
    expect(await ensureAttachmentDeliveryBuiltinRegistration(settingsManager, reloaded)).toBe(false)
  })
})
