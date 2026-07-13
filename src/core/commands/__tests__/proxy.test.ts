import { describe, expect, it, vi } from 'vitest'
import { CommandRegistry } from '../../command-registry.js'
import { clearProxyDraftsForChannel, PROXY_CAPABILITY_ERROR, registerProxyCommand } from '../proxy.js'
import { ProxyRevisionConflictError } from '../../network/proxy-store.js'
import { ProxyRouteTestError } from '../../network/proxy-service.js'

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
    expect((menu as any).title).toContain('Mode: Scoped routing')
    expect((menu as any).title).toContain('Default: Use host proxy settings')
    expect((menu as any).options.map((option: any) => option.label)).toEqual(['Routes', 'Proxy profiles', 'Test connections'])
    const result = await registry.execute('/proxy set agents.codex profile:usa', baseArgs())
    expect(proxyService.setRoute).toHaveBeenCalledWith('agents.codex', 'profile:usa', undefined)
    expect(result).toMatchObject({ type: 'menu' })
    expect((result as any).title).toContain('Existing sessions keep their current connection')
    expect(identity.getUserByIdentity).toHaveBeenCalledTimes(3) // one read gate, then read + mutation re-check
    expect((await registry.execute('/proxy categories', baseArgs())).type).toBe('menu')
    expect((await registry.execute('/proxy category agents', baseArgs())).type).toBe('menu')
    expect((await registry.execute('/proxy scope agents.codex', baseArgs())).type).toBe('menu')
  })

  it('rejects every read, diagnostic, test, and mutation from a participant without capability', async () => {
    const registry = new CommandRegistry()
    const proxyService = {
      status: vi.fn(() => ({ diagnostics: [] })),
      listProfiles: vi.fn(() => []),
      test: vi.fn(),
      setRoute: vi.fn(),
      deleteProfile: vi.fn(),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'member' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } })
    for (const command of [
      '/proxy', '/proxy status', '/proxy profiles', '/proxy routes', '/proxy diagnostics',
      '/proxy test agents.codex', '/proxy set agents.codex direct',
      '/proxy import x /tmp/x', '/proxy delete-confirm x',
    ]) {
      const result = await registry.execute(command, baseArgs())
      expect(result).toEqual({ type: 'error', message: PROXY_CAPABILITY_ERROR })
    }
    expect(proxyService.status).not.toHaveBeenCalled()
    expect(proxyService.listProfiles).not.toHaveBeenCalled()
    expect(proxyService.test).not.toHaveBeenCalled()
    expect(proxyService.setRoute).not.toHaveBeenCalled()
    expect(proxyService.deleteProfile).not.toHaveBeenCalled()
    expect(JSON.stringify(identity.getUserByIdentity.mock.calls)).not.toContain('proxy.test')
  })

  it('fails closed with the same typed response when the identity service is absent', async () => {
    const registry = new CommandRegistry()
    const proxyService = { status: vi.fn(), listProfiles: vi.fn(), test: vi.fn() }
    registerProxyCommand(registry, { proxyService } as any)

    for (const command of ['/proxy', '/proxy diagnostics', '/proxy test channels.telegram']) {
      await expect(registry.execute(command, baseArgs())).resolves.toEqual({
        type: 'error',
        message: PROXY_CAPABILITY_ERROR,
      })
    }
    expect(proxyService.status).not.toHaveBeenCalled()
    expect(proxyService.listProfiles).not.toHaveBeenCalled()
    expect(proxyService.test).not.toHaveBeenCalled()
  })

  it('converts identity lookup failures into the same safe response without leaking the error', async () => {
    const registry = new CommandRegistry()
    const proxyService = { status: vi.fn(), listProfiles: vi.fn(), test: vi.fn() }
    const identity = {
      getUserByIdentity: vi.fn().mockRejectedValue(new Error('lookup failed at proxy.internal with secret-value')),
    }
    registerProxyCommand(registry, {
      proxyService,
      lifecycleManager: { serviceRegistry: { get: () => identity } },
    } as any)

    const result = await registry.execute('/proxy diagnostics', baseArgs())
    expect(result).toEqual({ type: 'error', message: PROXY_CAPABILITY_ERROR })
    expect(JSON.stringify(result)).not.toContain('proxy.internal')
    expect(JSON.stringify(result)).not.toContain('secret-value')
    expect(proxyService.status).not.toHaveBeenCalled()
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
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const firstProfiles = await registry.execute('/proxy profiles', baseArgs()) as any
    expect(firstProfiles.options).toHaveLength(11) // Create + 8 profiles + Next + Back for authorized callers
    expect(firstProfiles.options.some((option: any) => option.command === '/proxy profiles 1')).toBe(true)
    const secondCategory = await registry.execute('/proxy category plugins 3 1', baseArgs()) as any
    expect(secondCategory.options.some((option: any) => option.command === '/proxy category plugins 3 0')).toBe(true)
    expect(secondCategory.options.some((option: any) => option.command === '/proxy scope plugins.connector9 3 0')).toBe(true)
  })

  it('keeps dynamic category and assignment pickers bounded with opaque callbacks', async () => {
    const registry = new CommandRegistry()
    const scopes = Array.from({ length: 151 }, (_, index) => `category-${String(index).padStart(3, '0')}-${'x'.repeat(44)}.connector-${'y'.repeat(48)}`)
    const profile = { id: `profile-${'p'.repeat(56)}`, name: 'Long ID profile', protocol: 'http', host: 'proxy.test', port: 8080 }
    const proxyService = {
      status: () => ({ revision: 37, diagnostics: [], routing: { global: 'inherit', routes: {} } }),
      listProfiles: () => [profile],
      getProfile: (id: string) => id === profile.id ? profile : undefined,
      getKnownScopes: () => scopes,
      resolve: (scope: string) => ({ scope, route: 'inherit', resolvedFrom: 'global' }),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)

    let categories = await registry.execute('/proxy categories 37 0', baseArgs()) as any
    let categoryPages = 0
    while (true) {
      categoryPages++
      expect(categories.options.length).toBeLessThanOrEqual(100)
      expect(categories.options.every((option: any) => Buffer.byteLength(option.command, 'utf8') <= 64)).toBe(true)
      const next = categories.options.find((option: any) => option.label === 'Next')
      if (!next) break
      const previousCommand = categories.options.find((option: any) => option.label === 'Previous')?.command
      categories = await registry.execute(next.command, baseArgs()) as any
      if (previousCommand) expect(categories.options.some((option: any) => option.label === 'Previous')).toBe(true)
    }
    expect(categoryPages).toBe(19)

    const categoryCommand = categories.options.find((option: any) => !['Previous', 'Back'].includes(option.label)).command
    const category = await registry.execute(categoryCommand, baseArgs()) as any
    expect(category.options.length).toBeLessThanOrEqual(100)
    expect(category.options.every((option: any) => Buffer.byteLength(option.command, 'utf8') <= 64)).toBe(true)
    expect(category.options.some((option: any) => option.label === 'Back')).toBe(true)
    const scope = await registry.execute(category.options[0].command, baseArgs()) as any
    expect(scope.options.every((option: any) => Buffer.byteLength(option.command, 'utf8') <= 64)).toBe(true)

    let assignment = await registry.execute(`/proxy assign ${profile.id}`, baseArgs()) as any
    let assignmentPages = 0
    while (true) {
      assignmentPages++
      expect(assignment.options.length).toBeLessThanOrEqual(100)
      expect(assignment.options.every((option: any) => Buffer.byteLength(option.command, 'utf8') <= 64)).toBe(true)
      const next = assignment.options.find((option: any) => option.label === 'Next')
      if (!next) break
      assignment = await registry.execute(next.command, baseArgs()) as any
    }
    expect(assignmentPages).toBe(19)
    const assignmentCategoryCommand = assignment.options.find((option: any) => !['Default for all traffic', 'Previous', 'Back to profile'].includes(option.label)).command
    const assignmentCategory = await registry.execute(assignmentCategoryCommand, baseArgs()) as any
    expect(assignmentCategory.options.every((option: any) => Buffer.byteLength(option.command, 'utf8') <= 64)).toBe(true)
    const confirmation = await registry.execute(assignmentCategory.options[0].command, baseArgs()) as any
    expect(Buffer.byteLength(confirmation.onYes, 'utf8')).toBeLessThanOrEqual(64)
    expect(Buffer.byteLength(confirmation.onNo, 'utf8')).toBeLessThanOrEqual(64)
  })

  it('summarizes and paginates long effective routes within connector limits', async () => {
    const registry = new CommandRegistry()
    const diagnostics = Array.from({ length: 40 }, (_, index) => ({
      scope: `plugins.connector-${index}-${'x'.repeat(90)}`,
      route: 'direct' as const,
      resolvedFrom: 'global',
      warning: `Capability note ${'w'.repeat(120)}`,
      childProcessSupport: 'not-applicable' as const,
    }))
    const proxyService = {
      status: () => ({ revision: 3, diagnostics, routing: { global: 'direct', routes: {} } }),
      listProfiles: () => [],
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)

    const overview = await registry.execute('/proxy routes', baseArgs()) as any
    expect(overview.title).toContain('Plugins: 40 connections')
    const detailCommand = overview.options.find((option: any) => option.label.startsWith('Plugins')).command
    let detail = await registry.execute(detailCommand, baseArgs()) as any
    let pages = 0
    while (true) {
      pages++
      expect(detail.title.length).toBeLessThan(3_900)
      expect(detail.options.every((option: any) => Buffer.byteLength(option.command, 'utf8') <= 64)).toBe(true)
      const next = detail.options.find((option: any) => option.label === 'Next')
      if (!next) break
      detail = await registry.execute(next.command, baseArgs()) as any
    }
    expect(pages).toBeGreaterThan(1)
  })

  it('keeps proxy policy unchanged and offers recovery when clear or delete preflight fails', async () => {
    const registry = new CommandRegistry()
    const profile = { id: 'old', name: 'Old proxy', protocol: 'http', host: 'old.test', port: 8080 }
    const clearRoute = vi.fn().mockRejectedValue(new ProxyRouteTestError('agents.codex', new Error('parent unavailable')))
    const deleteProfileSafely = vi.fn().mockRejectedValue(new ProxyRouteTestError('agents.codex', new Error('replacement unavailable')))
    const proxyService = {
      status: () => ({ revision: 7, diagnostics: [], routing: { global: 'inherit', routes: { 'agents.codex': 'profile:old' } } }),
      getProfile: (id: string) => id === 'old' ? profile : undefined,
      listProfiles: () => [profile],
      resolve: () => ({ route: 'profile:old', resolvedFrom: 'agents.codex' }),
      clearRoute, deleteProfileSafely,
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)

    const clear = await registry.execute('/proxy clear agents.codex 7', baseArgs()) as any
    expect(clear.title).toContain('kept its current override')
    expect(clear.title).toContain('No settings were changed')
    expect(clear.options.map((option: any) => option.label)).toEqual(['Retry parent route', 'Choose another route', 'Proxy home'])

    const deletion = await registry.execute('/proxy delete-confirm old 7 direct', baseArgs()) as any
    expect(deletion.title).toContain('was not deleted')
    expect(deletion.title).toContain('no traffic was changed')
    expect(deletion.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Retry deletion', command: '/proxy delete-confirm old 7 direct' }),
      expect.objectContaining({ label: 'Choose another replacement', command: '/proxy delete old 7 0' }),
    ]))
    expect(clearRoute).toHaveBeenCalledWith('agents.codex', 7)
    expect(deleteProfileSafely).toHaveBeenCalledWith('old', 'direct', 7)
  })

  it('summarizes and paginates large profile assignment and delete screens', async () => {
    const registry = new CommandRegistry()
    const profile = { id: 'shared', name: 'Shared proxy', protocol: 'http', host: 'shared.test', port: 8080 }
    const routes = Object.fromEntries(Array.from({ length: 35 }, (_, index) => [
      `plugins.connector-${index}-${'x'.repeat(80)}`,
      'profile:shared',
    ]))
    const proxyService = {
      status: () => ({ revision: 9, diagnostics: [], routing: { global: 'profile:shared', routes } }),
      getProfile: (id: string) => id === 'shared' ? profile : undefined,
      listProfiles: () => [profile],
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)

    const profileMenu = await registry.execute('/proxy profile shared', baseArgs()) as any
    expect(profileMenu.title).toContain('Assigned to: 36 traffic routes')
    expect(profileMenu.title.length).toBeLessThan(1_000)
    const assignmentCommand = profileMenu.options.find((option: any) => option.label === 'View current assignments').command
    const firstAssignments = await registry.execute(assignmentCommand, baseArgs()) as any
    expect(firstAssignments.title.length).toBeLessThan(3_900)
    expect(firstAssignments.options).toContainEqual(expect.objectContaining({ label: 'Next' }))

    const deletion = await registry.execute('/proxy delete shared 9 0', baseArgs()) as any
    expect(deletion.title).toContain('used by 36 traffic routes')
    expect(deletion.title.length).toBeLessThan(1_000)
    expect(deletion.options).toContainEqual(expect.objectContaining({ label: 'Review current assignments' }))
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
    const routing = await registry.execute(root.options.find((option: any) => option.label === 'Routes').command, baseArgs()) as any
    const global = routing.options.find((option: any) => option.label === 'Default for all traffic')
    const globalMenu = await registry.execute(global.command, baseArgs()) as any
    expect(globalMenu.options.some((option: any) => option.command === '/proxy scope global 4 1')).toBe(true)
    const page2 = await registry.execute('/proxy scope global 4 1', baseArgs()) as any
    expect(page2.options.some((option: any) => option.command === '/proxy scope global 4 0')).toBe(true)
    expect(page2.options.some((option: any) => option.label === 'Use parent route')).toBe(false)
    const agentScope = await registry.execute('/proxy scope agents.codex 4 0', baseArgs()) as any
    await registry.execute(agentScope.options.find((option: any) => option.label.startsWith('Use parent route')).command, baseArgs())
    expect(proxyService.clearRoute).toHaveBeenCalledWith('agents.codex', 4)
    expect(page2.options.find((option: any) => option.label === 'Back').command).toBe('/proxy routing')
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
    const protocolMenu = await registry.execute(named.options.find((option: any) => option.label === 'Enter details manually').command, owner) as any
    const hostPrompt = await registry.execute(protocolMenu.options.find((option: any) => option.label === 'HTTP').command, owner) as any
    const portMenu = await registry.execute(hostPrompt.command, {
      ...owner, interaction: { ...interaction, capturedInput: { value: 'proxy.example', sensitive: false } },
    }) as any
    const authMenu = await registry.execute(portMenu.options.find((option: any) => option.label === 'Suggested port: 8080').command, owner) as any
    const usernamePrompt = await registry.execute(authMenu.options.find((option: any) => option.label === 'Add credentials').command, owner) as any
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
    expect(selected.title).toContain('Credentials: Saved (hidden)')
    const review = await registry.execute(selected.options.find((option: any) => option.label === 'Edit profile').command, args) as any
    expect(review.options.map((option: any) => option.label)).toEqual(expect.arrayContaining([
      'Paste a different proxy URL', 'Edit endpoint manually', 'Replace credentials', 'Clear credentials',
    ]))
    const usernamePrompt = await registry.execute(review.options.find((option: any) => option.label === 'Replace credentials').command, args) as any
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

  it('separates saved override, effective route, and source with human labels', async () => {
    const registry = new CommandRegistry()
    const proxyService = {
      status: () => ({ revision: 6, diagnostics: [], routing: { global: 'direct', routes: { 'agents.default': 'profile:work' } } }),
      listProfiles: () => [{ id: 'work', name: 'Work proxy', protocol: 'http', host: 'proxy.test', port: 8080 }],
      getProfile: () => ({ id: 'work', name: 'Work proxy' }),
      resolve: () => ({ route: 'profile:work', resolvedFrom: 'agents.default' }),
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const scope = await registry.execute('/proxy scope agents.codex', baseArgs()) as any
    expect(scope.title).toContain('Saved override: None (uses parent route)')
    expect(scope.title).toContain('Effective route: Use profile “Work proxy”')
    expect(scope.title).toContain('Source: Coding agents default')
    expect(scope.title).not.toContain('agents.default')
    expect(scope.options).toContainEqual(expect.objectContaining({ label: 'Use parent route ✓' }))
  })

  it('assigns a selected profile without making the user rediscover it', async () => {
    const registry = new CommandRegistry()
    const profile = { id: 'work', name: 'Work proxy', protocol: 'http', host: 'proxy.test', port: 8080, hasCredentials: true, failClosed: true }
    const setRoute = vi.fn(async () => ({ activeAgentProcessesUnaffected: true }))
    const proxyService = {
      status: () => ({ revision: 8, diagnostics: [], routing: { global: 'direct', routes: {} } }),
      listProfiles: () => [profile], getProfile: (id: string) => id === 'work' ? profile : undefined,
      getKnownScopes: () => ['agents.default', 'agents.codex'],
      resolve: () => ({ route: 'direct', resolvedFrom: 'global' }), setRoute,
    }
    const identity = { getUserByIdentity: vi.fn().mockResolvedValue({ role: 'admin' }) }
    registerProxyCommand(registry, { proxyService, lifecycleManager: { serviceRegistry: { get: () => identity } } } as any)
    const start = await registry.execute('/proxy assign work', baseArgs()) as any
    expect(start.title).toContain('Assign “Work proxy”')
    const category = await registry.execute(start.options.find((option: any) => option.label === 'Coding agents').command, baseArgs()) as any
    const confirm = await registry.execute(category.options.find((option: any) => option.label === 'Codex').command, baseArgs()) as any
    expect(confirm).toMatchObject({ type: 'confirm' })
    const saved = await registry.execute(confirm.onYes, baseArgs()) as any
    expect(setRoute).toHaveBeenCalledWith('agents.codex', 'profile:work', 8)
    expect(saved.title).toContain('Codex now uses proxy profile “Work proxy”')
    expect(saved.options).toContainEqual(expect.objectContaining({ command: '/proxy profile work' }))
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
    const protocols = await registry.execute(named.options.find((option: any) => option.label === 'Enter details manually').command, args) as any
    const host = await registry.execute(protocols.options.find((option: any) => option.label === 'HTTP').command, args) as any
    const ports = await registry.execute(host.command, { ...args, interaction: { ...interaction, capturedInput: { value: 'proxy.test', sensitive: false } } }) as any
    const auth = await registry.execute(ports.options.find((option: any) => option.label === 'Suggested port: 8080').command, args) as any
    const username = await registry.execute(auth.options.find((option: any) => option.label === 'Add credentials').command, args) as any
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
    const username = await registry.execute(review.options.find((option: any) => option.label === 'Replace credentials').command, args) as any
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
    const staleSet = await registry.execute(scope.options.find((option: any) => option.label === 'Connect directly').command, baseArgs()) as any
    expect(staleSet.title).toContain('action was not applied')
    expect(setRoute).toHaveBeenCalledWith('agents.codex', 'direct', 11)
    const staleClear = await registry.execute(scope.options.find((option: any) => option.label.startsWith('Use parent route')).command, baseArgs()) as any
    expect(staleClear.options).toContainEqual(expect.objectContaining({ label: 'Refresh this screen' }))
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
    expect(stale.title).toContain('action was not applied')
    expect(deleteProfileSafely).toHaveBeenCalledWith('old', 'profile:p6', 21)
  })
})
