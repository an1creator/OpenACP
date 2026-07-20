import { describe, it, expect } from 'vitest'
import { builtInPlugins } from '../index.js'

describe('Built-in plugin wrappers', () => {
  it('exports all 9 built-in plugins', () => {
    expect(builtInPlugins).toHaveLength(9)
  })

  it('all plugins have name, version, setup', () => {
    for (const plugin of builtInPlugins) {
      expect(typeof plugin.name).toBe('string')
      expect(plugin.name.startsWith('@openacp/')).toBe(true)
      expect(typeof plugin.version).toBe('string')
      expect(typeof plugin.setup).toBe('function')
    }
  })

  it('all plugins have permissions array', () => {
    for (const plugin of builtInPlugins) {
      expect(Array.isArray(plugin.permissions)).toBe(true)
    }
  })

  it('has expected plugin names', () => {
    const names = builtInPlugins.map(p => p.name)
    expect(names).toContain('@openacp/security')
    expect(names).toContain('@openacp/file-service')
    expect(names).toContain('@openacp/notifications')
    expect(names).toContain('@openacp/speech')
    expect(names).toContain('@openacp/context')
    expect(names).toContain('@openacp/tunnel')
    expect(names).toContain('@openacp/api-server')
    expect(names).toContain('@openacp/telegram')
    expect(names).toContain('@openacp/attachment-delivery')
  })

  it('adapter plugins depend on security and notifications', () => {
    const adapters = builtInPlugins.filter(p =>
      ['@openacp/telegram'].includes(p.name)
    )
    for (const adapter of adapters) {
      expect(adapter.pluginDependencies).toBeDefined()
      expect(adapter.pluginDependencies?.['@openacp/security']).toBeDefined()
      expect(adapter.pluginDependencies?.['@openacp/notifications']).toBeDefined()
    }
  })

  it('notifications depends on security', () => {
    const notif = builtInPlugins.find(p => p.name === '@openacp/notifications')
    expect(notif?.pluginDependencies?.['@openacp/security']).toBeDefined()
  })
})
