import type { CommandRegistry } from '../command-registry.js'
import type { CommandResponse } from '../plugin/types.js'
import type { OpenACPCore } from '../core.js'
import type { ProxyRoute } from '../network/proxy-types.js'
import type { IdentityService } from '../../plugins/identity/types.js'
import { formatIdentityId, hasIdentityCapability } from '../../plugins/identity/types.js'
import type { CommandArgs } from '../plugin/types.js'

function routeLines(core: OpenACPCore): string {
  return core.proxyService.status().diagnostics
    .map((item) => `${item.scope}: ${item.route} (from ${item.resolvedFrom})${item.warning ? ` ⚠️ ${item.warning}` : ''}`)
    .join('\n')
}

/** Connector-neutral proxy command. Adapters render the returned menus in their native UI. */
export function registerProxyCommand(registry: CommandRegistry, _core: unknown): void {
  const core = _core as OpenACPCore
  registry.register({
    name: 'proxy',
    description: 'Manage scoped network proxy routes',
    usage: '[status|profiles|routes|scope|set|test]',
    category: 'system',
    handler: async (args) => {
      const [action, ...rest] = args.raw.trim().split(/\s+/).filter(Boolean)
      const mutations = new Set(['import', 'delete', 'delete-confirm', 'set', 'clear'])
      if (action && mutations.has(action) && !(await canManageProxy(core, args))) {
        return { type: 'error', message: 'This action requires network:proxy:manage capability.' }
      }
      if (!action || action === 'status') {
        return {
          type: 'menu',
          title: '🌐 Proxy routing',
          options: [
            { label: 'Profiles', command: '/proxy profiles' },
            { label: 'Global default', command: '/proxy scope global' },
            { label: 'Routing matrix', command: '/proxy routes' },
            { label: 'Routing categories', command: '/proxy categories' },
            { label: 'Test Telegram route', command: '/proxy test channels.telegram' },
            { label: 'Test Codex route', command: '/proxy test agents.codex' },
          ],
        } satisfies CommandResponse
      }
      if (action === 'profiles') {
        const profiles = core.proxyService.listProfiles()
        if (!profiles.length) return { type: 'text', text: 'No proxy profiles. Use `/proxy import <id> <absolute-0600-env-file>`.' } satisfies CommandResponse
        const page = Math.max(0, Number(rest[0] ?? 0) || 0); const start = page * 8
        return {
          type: 'menu',
          title: 'Proxy profiles',
          options: [...profiles.slice(start, start + 8).map((p) => ({
            label: `${p.name} (${p.protocol}://${p.host}:${p.port})`,
            command: `/proxy profile ${p.id}`,
          })), ...(page > 0 ? [{ label: 'Previous', command: `/proxy profiles ${page - 1}` }] : []), ...(start + 8 < profiles.length ? [{ label: 'Next', command: `/proxy profiles ${page + 1}` }] : []), { label: 'Back', command: '/proxy status' }],
        } satisfies CommandResponse
      }
      if (action === 'profile') {
        const id = rest[0]
        const profile = id ? core.proxyService.getProfile(id) : undefined
        if (!profile) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        return {
          type: 'menu',
          title: `${profile.name}: ${profile.protocol}://${profile.host}:${profile.port}\nCredentials: ${profile.hasCredentials ? 'configured' : 'none'} · failClosed: ${profile.failClosed}`,
          options: [
            { label: 'Test profile', command: `/proxy test-profile ${profile.id}` },
            { label: 'Replace from protected env file', command: `/proxy import-help ${profile.id}` },
            { label: 'Delete profile', command: `/proxy delete ${profile.id}` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'import-help') {
        return { type: 'text', text: `Use /proxy import ${rest[0] ?? '<id>'} <absolute-0600-env-file>. The file contents are never returned or logged.` } satisfies CommandResponse
      }
      if (action === 'import') {
        const [id, envFile] = rest
        if (!id || !envFile) return { type: 'error', message: 'Usage: /proxy import <id> <absolute-0600-env-file>' } satisfies CommandResponse
        const profile = await core.proxyService.importEnvFileSafely(id, envFile)
        return { type: 'text', text: `✅ Imported ${profile.name} (${profile.protocol}://${profile.host}:${profile.port}); credentials remain write-only.` } satisfies CommandResponse
      }
      if (action === 'test-profile') {
        const id = rest[0]
        if (!id) return { type: 'error', message: 'Usage: /proxy test-profile <id>' } satisfies CommandResponse
        const result = await core.proxyService.testProfile(id)
        return result.ok
          ? { type: 'text', text: `✅ Profile ${id} is reachable (HTTP ${result.status})` }
          : { type: 'error', message: `Profile ${id} failed: ${result.error ?? 'unknown error'}` }
      }
      if (action === 'delete') {
        const id = rest[0]
        if (!id || !core.proxyService.getProfile(id)) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        return {
          type: 'menu', title: `Delete proxy profile ${id}?`,
          options: [
            { label: 'Cancel', command: '/proxy profiles' },
            { label: 'Confirm delete', command: `/proxy delete-confirm ${id}` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'delete-confirm') {
        const id = rest[0]
        if (!id) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        await core.proxyService.deleteProfile(id)
        return { type: 'text', text: `✅ Deleted proxy profile ${id}.` } satisfies CommandResponse
      }
      if (action === 'routes') {
        return { type: 'text', text: routeLines(core) } satisfies CommandResponse
      }
      if (action === 'categories') {
        const categories = [...new Set(core.proxyService.getKnownScopes().map((s) => s.split('.')[0]))]
        return { type: 'menu', title: 'Proxy routing categories', options: [
          ...categories.map((category) => ({ label: category, command: `/proxy category ${category}` })),
          { label: 'Back', command: '/proxy status' },
        ] } satisfies CommandResponse
      }
      if (action === 'category') {
        const category = rest[0]
        const scopes = core.proxyService.getKnownScopes().filter((s) => s.startsWith(`${category}.`))
        if (!category || !scopes.length) return { type: 'error', message: 'Proxy category not found.' }
        const page = Math.max(0, Number(rest[1] ?? 0) || 0); const start = page * 8
        return { type: 'menu', title: `${category} routes`, options: [
          ...scopes.slice(start, start + 8).map((scope) => { const r = core.proxyService.resolve(scope); return { label: `${scope} → ${r.route}`, command: `/proxy scope ${scope}` } }),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy category ${category} ${page - 1}` }] : []),
          ...(start + 8 < scopes.length ? [{ label: 'Next', command: `/proxy category ${category} ${page + 1}` }] : []),
          { label: 'Back', command: '/proxy categories' },
        ] } satisfies CommandResponse
      }
      if (action === 'scope') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy scope <scope>' } satisfies CommandResponse
        const current = core.proxyService.resolve(scope)
        const profiles = core.proxyService.listProfiles()
        const page = Math.max(0, Number(rest[1] ?? 0) || 0); const start = page * 6
        return {
          type: 'menu',
          title: `${scope}: ${current.route}`,
          options: [
            { label: 'Direct', command: `/proxy set ${scope} direct` },
            { label: 'Inherit host', command: `/proxy set ${scope} inherit` },
            ...profiles.slice(start, start + 6).map((p) => ({ label: p.name, command: `/proxy set ${scope} profile:${p.id}` })),
            ...(page > 0 ? [{ label: 'Previous profiles', command: `/proxy scope ${scope} ${page - 1}` }] : []),
            ...(start + 6 < profiles.length ? [{ label: 'Next profiles', command: `/proxy scope ${scope} ${page + 1}` }] : []),
            { label: 'Clear override', command: `/proxy clear ${scope}` },
            { label: 'Test current route', command: `/proxy test ${scope}` },
            { label: 'Back', command: scope === 'global' ? '/proxy status' : `/proxy category ${scope.split('.')[0]}` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'set') {
        const [scope, route] = rest
        if (!scope || !route) return { type: 'error', message: 'Usage: /proxy set <scope> <direct|inherit|profile:id>' } satisfies CommandResponse
        const change = await core.proxyService.setRoute(scope, route as ProxyRoute)
        const note = change.activeAgentProcessesUnaffected
          ? '\nNew ACP processes will use this route; active sessions were not restarted. The idle warm pool was rebuilt.'
          : ''
        return { type: 'text', text: `✅ ${scope} → ${route}${note}` } satisfies CommandResponse
      }
      if (action === 'clear') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy clear <scope|global>' }
        await core.proxyService.clearRoute(scope)
        return { type: 'text', text: `✅ Cleared override for ${scope}. Effective route: ${core.proxyService.resolve(scope).route}` }
      }
      if (action === 'test') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy test <scope>' } satisfies CommandResponse
        const result = await core.proxyService.test(scope)
        return result.ok
          ? { type: 'text', text: `✅ ${scope}: proxy route is reachable (HTTP ${result.status})` }
          : { type: 'error', message: `Proxy test failed for ${scope}: ${result.error ?? 'unknown error'}` }
      }
      return { type: 'error', message: 'Use /proxy status, profiles, import, routes, scope, set, or test.' } satisfies CommandResponse
    },
  })
}

async function canManageProxy(core: OpenACPCore, args: CommandArgs): Promise<boolean> {
  const identity = core.lifecycleManager.serviceRegistry.get<IdentityService>('identity')
  if (!identity) return false
  const user = await identity.getUserByIdentity(formatIdentityId(args.channelId, args.userId))
  return Boolean(user && hasIdentityCapability(user.role, 'network:proxy:manage'))
}
