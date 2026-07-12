import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../command-registry.js'
import { clearProxyDraftsForChannel, registerProxyCommand } from '../proxy.js'
import { ProxyRevisionConflictError } from '../../network/proxy-store.js'

function baseArgs() {
  return { raw: '', sessionId: null, channelId: 'test', userId: 'user', reply: vi.fn() }
}

describe('/proxy command', () => {
  it('returns a connector-neutral menu and applies agent routes with lifecycle notice', async () => {
    const registry = new CommandRegistry()
    const proxyService = {
      status: () => ({ revision: 0, diagnostics: [] }),
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
    expect(proxyService.setRoute).toHaveBeenCalledWith('agents.codex', 'profile:usa', undefined)
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
      status: () => ({ revision: 3, diagnostics: [] }), listProfiles: () => profiles, getKnownScopes: () => scopes,
      resolve: (scope: string) => ({ scope, route: 'inherit' }),
    }
    registerProxyCommand(registry, { proxyService } as any)
    const firstProfiles = await registry.execute('/proxy profiles', baseArgs()) as any
    expect(firstProfiles.options).toHaveLength(10) // 8 profiles + Next + Back for read-only callers
    expect(firstProfiles.options.some((option: any) => option.command === '/proxy profiles 1')).toBe(true)
    const secondCategory = await registry.execute('/proxy category plugins 3 1', baseArgs()) as any
    expect(secondCategory.options.some((option: any) => option.command === '/proxy category plugins 3 0')).toBe(true)
    expect(secondCategory.options.some((option: any) => option.command === '/proxy scope plugins.connector9 3 0')).toBe(true)
  })

  it('supports a button-only global/scope journey with profile pages, clear, back, and cancel', async () => {
    const registry = new CommandRegistry()
    const profiles = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, protocol: 'http', host: `p${index}.test`, port: 8080 }))
    const proxyService = {
      status: () => ({ revision: 4, diagnostics: [], routing: { global: 'inherit', routes: {} } }), listProfiles: () => profiles,
      getProfile: (id: string) => profiles.find((profile) => profile.id === id),
      getKnownScopes: () => ['agents.codex'], resolve: (scope: string) => ({ scope, route: 'inherit' }),
      setRoute: vi.fn(async () => ({ activeAgentProcessesUnaffected: false })),
      clearRoute: vi.fn(async () => undefined), test: vi.fn(async () => ({ ok: true, status: 200 })),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const root = await registry.execute('/proxy', baseArgs()) as any
    const routing = await registry.execute(root.options.find((option: any) => option.label === 'Routing').command, baseArgs()) as any
    const global = routing.options.find((option: any) => option.label === 'Global default route')
    const globalMenu = await registry.execute(global.command, baseArgs()) as any
    expect(globalMenu.options.some((option: any) => option.command === '/proxy scope global 4 1')).toBe(true)
    const page2 = await registry.execute('/proxy scope global 4 1', baseArgs()) as any
    expect(page2.options.some((option: any) => option.command === '/proxy scope global 4 0')).toBe(true)
    await registry.execute(page2.options.find((option: any) => option.label === 'Clear override').command, baseArgs())
    expect(proxyService.clearRoute).toHaveBeenCalledWith('global', 4)
    expect(page2.options.find((option: any) => option.label === 'Back').command).toBe('/proxy status')
    const profileMenu = await registry.execute('/proxy profile p0', baseArgs()) as any
    const deleteMenu = await registry.execute(profileMenu.options.find((option: any) => option.label === 'Delete profile').command, baseArgs()) as any
    expect(deleteMenu.options.find((option: any) => option.label === 'Cancel').command).toBe('/proxy profiles')
  })

  it('completes a button-led manual create journey without rendering secrets', async () => {
    const registry = new CommandRegistry()
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    const proxyService = {
      status: () => ({ revision: 7, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      listProfiles: () => [],
      getProfile: () => undefined,
      testProfileCandidate: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      createProfileSafely: vi.fn(async (input: any) => ({ ...input, name: input.name ?? input.id, hasCredentials: true })),
    }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const interaction = { textInput: true, secureInput: 'delete-after-capture' as const }
    const owner = { ...baseArgs(), conversationId: 'chat:topic', interaction }
    const other = { ...baseArgs(), userId: 'other', conversationId: 'chat:topic', interaction }
    const start = await registry.execute('/proxy add', owner) as any
    expect(start).toMatchObject({ type: 'input', sensitive: false })
    const named = await registry.execute(start.command, {
      ...owner, interaction: { ...interaction, capturedInput: { value: 'Secure Profile', sensitive: false } },
    }) as any
    const draftId = start.command.split(' ')[2]
    const hijack = await registry.execute(`/proxy wizard-field ${draftId} password`, other) as any
    expect(hijack).toMatchObject({ type: 'error' })
    const protocolMenu = await registry.execute(named.options.find((option: any) => option.label === 'Manual endpoint setup').command, owner) as any
    const hostPrompt = await registry.execute(protocolMenu.options.find((option: any) => option.label === 'HTTP').command, owner) as any
    const portMenu = await registry.execute(hostPrompt.command, {
      ...owner, interaction: { ...interaction, capturedInput: { value: 'proxy.example', sensitive: false } },
    }) as any
    const authMenu = await registry.execute(portMenu.options.find((option: any) => option.label === 'Use default (8080)').command, owner) as any
    const usernamePrompt = await registry.execute(authMenu.options.find((option: any) => option.label === 'Use authentication').command, owner) as any
    const passwordPrompt = await registry.execute(usernamePrompt.command, {
      ...owner, interaction: { ...interaction, capturedInput: { value: 'alice', sensitive: true } },
    }) as any
    const exactPassword = '  super  secret  '
    const afterPassword = await registry.execute(passwordPrompt.command, {
      ...owner,
      interaction: { ...interaction, capturedInput: { value: exactPassword, sensitive: true } },
    }) as any
    expect(afterPassword.title).not.toContain('super')
    const tested = await registry.execute(`/proxy wizard-test ${draftId}`, owner) as any
    expect(tested.options.some((option: any) => option.label === 'Save profile')).toBe(true)
    await registry.execute(`/proxy wizard-save ${draftId}`, owner)
    expect(proxyService.createProfileSafely).toHaveBeenCalledWith(expect.objectContaining({
      id: 'secure-profile', name: 'Secure Profile', protocol: 'http', host: 'proxy.example', port: 8080,
      username: 'alice', password: exactPassword,
    }), 7)
    expect(identity.getUserByIdentity.mock.calls.length).toBeGreaterThanOrEqual(7)
  })

  it('uses update-only semantics and exposes endpoint and credential edit choices', async () => {
    const registry = new CommandRegistry()
    const profile = { id: 'existing', name: 'Existing', protocol: 'https', host: 'old.test', port: 8443, noProxy: [], failClosed: true, hasCredentials: true }
    const updateProfileSafely = vi.fn(async (input: any) => ({ ...profile, ...input }))
    const proxyService = {
      status: () => ({ revision: 9, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      listProfiles: () => [profile], getProfile: (id: string) => id === profile.id ? profile : undefined,
      testProfileCandidate: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
      updateProfileSafely, createProfileSafely: vi.fn(),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const args = { ...baseArgs(), interaction: { textInput: true, secureInput: 'delete-after-capture' as const } }
    const selected = await registry.execute('/proxy profile existing', args) as any
    const review = await registry.execute(selected.options.find((option: any) => option.label === 'Edit endpoint or credentials').command, args) as any
    expect(review.options.map((option: any) => option.label)).toEqual(expect.arrayContaining([
      'Replace with proxy URL', 'Set endpoint manually', 'Rotate credentials', 'Clear authentication',
    ]))
    const usernamePrompt = await registry.execute(review.options.find((option: any) => option.label === 'Rotate credentials').command, args) as any
    const passwordPrompt = await registry.execute(usernamePrompt.command, {
      ...args, interaction: { ...args.interaction, capturedInput: { value: 'new-user', sensitive: true } },
    }) as any
    const ready = await registry.execute(passwordPrompt.command, {
      ...args, interaction: { ...args.interaction, capturedInput: { value: 'new-pass', sensitive: true } },
    }) as any
    const tested = await registry.execute(ready.options.find((option: any) => option.label === 'Test candidate').command, args) as any
    await registry.execute(tested.options.find((option: any) => option.label === 'Save profile').command, args)
    expect(updateProfileSafely).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing', username: 'new-user', password: 'new-pass' }), 9)
    expect(proxyService.createProfileSafely).not.toHaveBeenCalled()
  })

  it('keeps a failed candidate in an editable retry menu', async () => {
    const registry = new CommandRegistry()
    const profile = { id: 'bad', name: 'Bad', protocol: 'http', host: 'bad.test', port: 8080, noProxy: [], failClosed: true }
    const proxyService = {
      status: () => ({ revision: 2, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      getProfile: () => profile, testProfileCandidate: vi.fn().mockResolvedValue({ ok: false, error: 'connection refused' }),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const args = { ...baseArgs(), interaction: { textInput: true, secureInput: 'delete-after-capture' as const } }
    const draft = await registry.execute('/proxy edit bad', args) as any
    const failed = await registry.execute(draft.options.find((option: any) => option.label === 'Test candidate').command, args) as any
    expect(failed).toMatchObject({ type: 'menu' })
    expect(failed.options.map((option: any) => option.label)).toEqual(['Retry test', 'Review and edit', 'Cancel'])
  })

  it('requires explicit no-auth choice instead of accepting the dash sentinel during create', async () => {
    const registry = new CommandRegistry()
    const proxyService = {
      status: () => ({ revision: 1, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      getProfile: () => undefined, testProfileCandidate: vi.fn(), createProfileSafely: vi.fn(),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const interaction = { textInput: true, secureInput: 'delete-after-capture' as const }
    const args = { ...baseArgs(), interaction }
    const start = await registry.execute('/proxy add', args) as any
    const named = await registry.execute(start.command, { ...args, interaction: { ...interaction, capturedInput: { value: 'Manual Auth', sensitive: false } } }) as any
    const protocols = await registry.execute(named.options.find((option: any) => option.label === 'Manual endpoint setup').command, args) as any
    const host = await registry.execute(protocols.options.find((option: any) => option.label === 'HTTP').command, args) as any
    const ports = await registry.execute(host.command, { ...args, interaction: { ...interaction, capturedInput: { value: 'proxy.test', sensitive: false } } }) as any
    const auth = await registry.execute(ports.options.find((option: any) => option.label === 'Use default (8080)').command, args) as any
    const username = await registry.execute(auth.options.find((option: any) => option.label === 'Use authentication').command, args) as any
    const invalid = await registry.execute(username.command, { ...args, interaction: { ...interaction, capturedInput: { value: '-', sensitive: true } } }) as any

    expect(invalid.title).toContain('sentinel is not supported')
    expect(invalid.options.map((option: any) => option.label)).toContain('Choose No authentication')
    expect(proxyService.testProfileCandidate).not.toHaveBeenCalled()
    expect(proxyService.createProfileSafely).not.toHaveBeenCalled()
  })

  it('does not accept an empty credential sentinel while rotating an existing profile', async () => {
    const registry = new CommandRegistry()
    const profile = { id: 'rotate', name: 'Rotate', protocol: 'http', host: 'proxy.test', port: 8080, noProxy: [], failClosed: true }
    const proxyService = {
      status: () => ({ revision: 2, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      getProfile: () => profile, updateProfileSafely: vi.fn(), testProfileCandidate: vi.fn(),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const interaction = { textInput: true, secureInput: 'delete-after-capture' as const }
    const args = { ...baseArgs(), interaction }
    const review = await registry.execute('/proxy edit rotate', args) as any
    const username = await registry.execute(review.options.find((option: any) => option.label === 'Rotate credentials').command, args) as any
    const password = await registry.execute(username.command, { ...args, interaction: { ...interaction, capturedInput: { value: 'new-user', sensitive: true } } }) as any
    const invalid = await registry.execute(password.command, { ...args, interaction: { ...interaction, capturedInput: { value: '-', sensitive: true } } }) as any

    expect(invalid.options.map((option: any) => option.label)).toContain('Clear authentication')
    expect(proxyService.testProfileCandidate).not.toHaveBeenCalled()
    expect(proxyService.updateProfileSafely).not.toHaveBeenCalled()
  })

  it('rejects a 101-character profile name before candidate testing or save', async () => {
    const registry = new CommandRegistry()
    const proxyService = {
      status: () => ({ revision: 1, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      testProfileCandidate: vi.fn(), createProfileSafely: vi.fn(),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const interaction = { textInput: true, secureInput: 'delete-after-capture' as const }
    const args = { ...baseArgs(), interaction }
    const start = await registry.execute('/proxy add', args) as any
    const invalid = await registry.execute(start.command, { ...args, interaction: { ...interaction, capturedInput: { value: 'x'.repeat(101), sensitive: false } } }) as any
    expect(invalid).toMatchObject({ type: 'error' })
    expect(invalid.message).toContain('1-100')
    expect(proxyService.testProfileCandidate).not.toHaveBeenCalled()
    expect(proxyService.createProfileSafely).not.toHaveBeenCalled()
  })

  it('falls back to protected CLI/API when a connector has no input guarantees', async () => {
    const registry = new CommandRegistry()
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, {
      proxyService: { status: () => ({ revision: 0, diagnostics: [] }) },
      lifecycleManager: { serviceRegistry: { get: () => identity } },
    } as any)
    const response = await registry.execute('/proxy add', baseArgs())
    expect(response).toMatchObject({ type: 'text' })
    expect((response as any).text).toContain('protected CLI/API')
  })

  it('clears connector-bound wizard drafts during adapter shutdown', async () => {
    const registry = new CommandRegistry()
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, {
      proxyService: { status: () => ({ revision: 0, diagnostics: [] }) },
      lifecycleManager: { serviceRegistry: { get: () => identity } },
    } as any)
    const args = { ...baseArgs(), channelId: 'telegram', conversationId: 'chat:topic', interaction: { textInput: true, secureInput: 'delete-after-capture' as const } }
    const start = await registry.execute('/proxy add', args) as any
    clearProxyDraftsForChannel('telegram')
    const expired = await registry.execute(start.command, args) as any
    expect(expired).toMatchObject({ type: 'error' })
    expect(expired.message).toContain('expired')
  })

  it('carries one base revision through route pages and rejects stale set/clear callbacks', async () => {
    const registry = new CommandRegistry()
    const profiles = Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, protocol: 'http', host: `p${index}.test`, port: 8080 }))
    const setRoute = vi.fn().mockRejectedValue(new ProxyRevisionConflictError(11, 12))
    const clearRoute = vi.fn().mockRejectedValue(new ProxyRevisionConflictError(11, 12))
    const proxyService = {
      status: () => ({ revision: 11, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      listProfiles: () => profiles, getKnownScopes: () => ['agents.codex'],
      resolve: () => ({ route: 'inherit' }), setRoute, clearRoute,
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)

    const scope = await registry.execute('/proxy scope agents.codex 11 0', baseArgs()) as any
    expect(scope.options.find((option: any) => option.label === 'Next profiles').command).toBe('/proxy scope agents.codex 11 1')
    const staleSet = await registry.execute(scope.options.find((option: any) => option.label === 'Direct').command, baseArgs()) as any
    expect(staleSet.title).toContain('No changes were made')
    expect(setRoute).toHaveBeenCalledWith('agents.codex', 'direct', 11)
    const staleClear = await registry.execute(scope.options.find((option: any) => option.label === 'Clear override').command, baseArgs()) as any
    expect(staleClear.options).toContainEqual(expect.objectContaining({ label: 'Refresh' }))
    expect(clearRoute).toHaveBeenCalledWith('agents.codex', 11)
  })

  it('keeps delete revision across replacement pages and rejects stale confirmation', async () => {
    const registry = new CommandRegistry()
    const target = { id: 'old', name: 'Old', protocol: 'http', host: 'old.test', port: 8080 }
    const alternatives = Array.from({ length: 14 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, protocol: 'http', host: `p${index}.test`, port: 8080 }))
    const deleteProfileSafely = vi.fn().mockRejectedValue(new ProxyRevisionConflictError(21, 22))
    const proxyService = {
      status: () => ({ revision: 21, diagnostics: [], routing: { global: 'profile:old', routes: {} } }),
      getProfile: (id: string) => id === 'old' ? target : alternatives.find((profile) => profile.id === id),
      listProfiles: () => [target, ...alternatives], deleteProfileSafely,
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)

    const first = await registry.execute('/proxy delete old 21 0', baseArgs()) as any
    expect(first.options.find((option: any) => option.label === 'Next replacements').command).toBe('/proxy delete old 21 1')
    const second = await registry.execute('/proxy delete old 21 1', baseArgs()) as any
    expect(second.options.find((option: any) => option.label === 'Previous replacements').command).toBe('/proxy delete old 21 0')
    expect(second.options.some((option: any) => option.command === '/proxy delete-confirm old 21 profile:p6')).toBe(true)
    const stale = await registry.execute('/proxy delete-confirm old 21 profile:p6', baseArgs()) as any
    expect(stale.title).toContain('No changes were made')
    expect(deleteProfileSafely).toHaveBeenCalledWith('old', 'profile:p6', 21)
  })
})
