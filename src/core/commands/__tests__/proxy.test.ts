import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../command-registry.js'
import { registerProxyCommand } from '../proxy.js'

function baseArgs() {
  return { raw: '', sessionId: null, channelId: 'test', userId: 'user', reply: vi.fn() }
}

describe('/proxy command', () => {
  it('returns a connector-neutral menu and applies agent routes with lifecycle notice', async () => {
    const registry = new CommandRegistry()
    const proxyService = {
      status: () => ({ diagnostics: [] }),
      listProfiles: () => [{ id: 'usa', name: 'USA', protocol: 'http', host: 'proxy.test', port: 8080, hasCredentials: true, failClosed: true }],
      resolve: () => ({ route: 'direct' }),
      getKnownScopes: () => ['agents.codex', 'agents.default', 'channels.telegram'],
      setRoute: vi.fn(async () => ({ activeAgentProcessesUnaffected: true })),
      clearRoute: vi.fn(async () => undefined),
      test: vi.fn(),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } })
    const menu = await registry.execute('/proxy', baseArgs())
    expect(menu.type).toBe('menu')
    const result = await registry.execute('/proxy set agents.codex profile:usa', baseArgs())
    expect(proxyService.setRoute).toHaveBeenCalledWith('agents.codex', 'profile:usa')
    expect(result).toMatchObject({ type: 'text' })
    expect((result as any).text).toContain('active sessions were not restarted')
    expect((await registry.execute('/proxy categories', baseArgs())).type).toBe('menu')
    expect((await registry.execute('/proxy category agents', baseArgs())).type).toBe('menu')
    expect((await registry.execute('/proxy scope agents.codex', baseArgs())).type).toBe('menu')
  })

  it('rejects every mutating command from a participant without capability', async () => {
    const registry = new CommandRegistry()
    const proxyService = { status: () => ({ diagnostics: [] }), listProfiles: () => [], setRoute: vi.fn(), deleteProfile: vi.fn() }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'member' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } })
    for (const command of ['/proxy set agents.codex direct', '/proxy import x /tmp/x', '/proxy delete-confirm x']) {
      const result = await registry.execute(command, baseArgs())
      expect(result).toMatchObject({ type: 'error' })
      expect((result as any).message).toContain('network:proxy:manage')
    }
    expect(proxyService.setRoute).not.toHaveBeenCalled(); expect(proxyService.deleteProfile).not.toHaveBeenCalled()
  })

  it('paginates large profile and category menus for connector callback limits', async () => {
    const registry = new CommandRegistry()
    const profiles = Array.from({ length: 10 }, (_, index) => ({
      id: `p${index}`, name: `Profile ${index}`, protocol: 'http', host: `p${index}.test`, port: 8080,
    }))
    const scopes = Array.from({ length: 10 }, (_, index) => `plugins.connector${index}`)
    const proxyService = {
      status: () => ({ diagnostics: [] }), listProfiles: () => profiles, getKnownScopes: () => scopes,
      resolve: (scope: string) => ({ scope, route: 'inherit' }),
    }
    registerProxyCommand(registry, { proxyService } as any)
    const firstProfiles = await registry.execute('/proxy profiles', baseArgs()) as any
    expect(firstProfiles.options).toHaveLength(10) // 8 profiles + Next + Back
    expect(firstProfiles.options.some((option: any) => option.command === '/proxy profiles 1')).toBe(true)
    const secondCategory = await registry.execute('/proxy category plugins 1', baseArgs()) as any
    expect(secondCategory.options.some((option: any) => option.command === '/proxy category plugins 0')).toBe(true)
    expect(secondCategory.options.some((option: any) => option.command === '/proxy scope plugins.connector9')).toBe(true)
  })

  it('supports a button-only global/scope journey with profile pages, clear, back, and cancel', async () => {
    const registry = new CommandRegistry()
    const profiles = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, protocol: 'http', host: `p${index}.test`, port: 8080 }))
    const proxyService = {
      status: () => ({ diagnostics: [] }), listProfiles: () => profiles,
      getProfile: (id: string) => profiles.find((profile) => profile.id === id),
      getKnownScopes: () => ['agents.codex'], resolve: (scope: string) => ({ scope, route: 'inherit' }),
      setRoute: vi.fn(async () => ({ activeAgentProcessesUnaffected: false })),
      clearRoute: vi.fn(async () => undefined), test: vi.fn(async () => ({ ok: true, status: 200 })),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const root = await registry.execute('/proxy', baseArgs()) as any
    const global = root.options.find((option: any) => option.label === 'Global default')
    const globalMenu = await registry.execute(global.command, baseArgs()) as any
    expect(globalMenu.options.some((option: any) => option.command === '/proxy scope global 1')).toBe(true)
    const page2 = await registry.execute('/proxy scope global 1', baseArgs()) as any
    expect(page2.options.some((option: any) => option.command === '/proxy scope global 0')).toBe(true)
    await registry.execute(page2.options.find((option: any) => option.label === 'Clear override').command, baseArgs())
    expect(proxyService.clearRoute).toHaveBeenCalledWith('global')
    expect(page2.options.find((option: any) => option.label === 'Back').command).toBe('/proxy status')
    const profileMenu = await registry.execute('/proxy profile p0', baseArgs()) as any
    const deleteMenu = await registry.execute(profileMenu.options.find((option: any) => option.label === 'Delete profile').command, baseArgs()) as any
    expect(deleteMenu.options.find((option: any) => option.label === 'Cancel').command).toBe('/proxy profiles')
  })
})
