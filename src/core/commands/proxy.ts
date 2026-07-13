import type { CommandRegistry } from '../command-registry.js'
import type { CommandResponse } from '../plugin/types.js'
import type { OpenACPCore } from '../core.js'
import type { ProxyRoute, ProxyStatus } from '../network/proxy-types.js'
import type { ProxyProfileInput, ProxyProtocol } from '../network/proxy-types.js'
import { PROXY_PROTOCOLS } from '../network/proxy-types.js'
import { createHash, randomUUID } from 'node:crypto'
import type { IdentityService } from '../../plugins/identity/types.js'
import { formatIdentityId, hasIdentityCapability } from '../../plugins/identity/types.js'
import type { CommandArgs } from '../plugin/types.js'
import { ProxyRevisionConflictError } from '../network/proxy-store.js'
import { ProxyProfileExistsError, ProxyProfileNotFoundError, ProxyRouteTestError, ProxyValidationError } from '../network/proxy-service.js'
import { proxyCategoryLabel, proxyRouteSourceLabel, proxyScopeLabel } from '../network/proxy-labels.js'

interface ProxyDraft {
  id: string
  owner: string
  mode: 'add' | 'edit'
  baseRevision: number
  expiresAt: number
  input: Partial<ProxyProfileInput>
  hadCredentials: boolean
  tested: boolean
}

const DRAFT_TTL_MS = 10 * 60_000
const drafts = new Map<string, ProxyDraft>()

/** Remove connector-bound wizard state during adapter shutdown/restart. */
export function clearProxyDraftsForChannel(channelId: string): void {
  const prefix = `${channelId}:`
  for (const [id, draft] of drafts) if (draft.owner.startsWith(prefix)) drafts.delete(id)
}

function storeDraft(draft: ProxyDraft): void {
  for (const [id, current] of drafts) if (current.expiresAt <= Date.now()) drafts.delete(id)
  while (drafts.size >= 500) {
    const oldest = drafts.keys().next().value
    if (!oldest) break
    drafts.delete(oldest)
  }
  drafts.set(draft.id, draft)
}

function interactionOwner(args: CommandArgs): string {
  return `${args.channelId}:${args.userId}:${args.conversationId ?? args.sessionId ?? 'global'}`
}

function getDraft(id: string | undefined, args: CommandArgs): ProxyDraft | undefined {
  if (!id) return undefined
  const draft = drafts.get(id)
  if (!draft || draft.owner !== interactionOwner(args) || draft.expiresAt <= Date.now()) {
    if (draft?.expiresAt && draft.expiresAt <= Date.now()) drafts.delete(id)
    return undefined
  }
  draft.expiresAt = Date.now() + DRAFT_TTL_MS
  return draft
}

function inputResponse(draft: ProxyDraft, field: string, prompt: string, args: CommandArgs, sensitive = false): CommandResponse {
  const fallback = sensitive
    ? 'This connector cannot safely capture credentials. Use `openacp proxy import <id> --env-file <0600-file>` on the host.'
    : 'This connector has no interactive text-input support. Start profile creation from a protected CLI/API client.'
  if (!args.interaction?.textInput || (sensitive && args.interaction.secureInput === 'none')) {
    if (!args.interaction?.textInput) drafts.delete(draft.id)
    return { type: 'text', text: fallback }
  }
  return {
    type: 'input',
    prompt,
    command: `/proxy wizard-input ${draft.id} ${field}`,
    sensitive,
    expiresInMs: DRAFT_TTL_MS,
    fallback,
  }
}

function candidateFromDraft(draft: ProxyDraft): ProxyProfileInput | undefined {
  const input = draft.input
  if (!input.id || !input.protocol || !input.host || !input.port) return undefined
  return input as ProxyProfileInput
}

function slugBase(label: string): string {
  const slug = label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return slug || 'proxy'
}

function uniqueProfileId(core: OpenACPCore, label: string): string {
  const base = slugBase(label)
  if (!core.proxyService.getProfile(base)) return base
  for (let suffix = 2; suffix < 10_000; suffix++) {
    const candidate = `${base.slice(0, 63 - String(suffix).length - 1)}-${suffix}`
    if (!core.proxyService.getProfile(candidate)) return candidate
  }
  throw new Error('Unable to generate a unique proxy profile ID')
}

function createProtocolMenu(draft: ProxyDraft): CommandResponse {
  return { type: 'menu', title: 'Create proxy profile — step 2 of 6\nChoose the protocol used by your proxy provider.', options: [
    ...PROXY_PROTOCOLS.map((protocol) => ({ label: protocol.toUpperCase(), command: `/proxy wizard-protocol ${draft.id} ${protocol}` })),
    { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
  ] }
}

function createPortMenu(draft: ProxyDraft): CommandResponse {
  const defaultPort = draft.input.protocol?.startsWith('socks') ? 1080 : draft.input.protocol === 'https' ? 443 : 8080
  return { type: 'menu', title: `${draft.mode === 'add' ? 'Create proxy profile — step 4 of 6' : `Edit ${draft.input.name ?? draft.input.id} › Port`}\nChoose the port for ${draft.input.protocol}://${draft.input.host}.`, options: [
    { label: `Suggested port: ${defaultPort}`, command: `/proxy wizard-default-port ${draft.id} ${defaultPort}` },
    { label: 'Enter a different port', command: `/proxy wizard-field ${draft.id} port` },
    { label: 'Back', command: `/proxy wizard-field ${draft.id} host` },
    { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
  ] }
}

function createAuthMenu(draft: ProxyDraft): CommandResponse {
  return { type: 'menu', title: 'Create proxy profile — step 5 of 6\nDoes the proxy provider require a username and password?', options: [
    { label: 'No credentials', command: `/proxy wizard-auth ${draft.id} no` },
    { label: 'Add credentials', command: `/proxy wizard-auth ${draft.id} yes` },
    { label: 'Back', command: `/proxy wizard-field ${draft.id} port` },
    { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
  ] }
}

function invalidCredentialResponse(draft: ProxyDraft, field: 'username' | 'password'): CommandResponse {
  const explicitNoAuth = draft.mode === 'add'
    ? { label: 'Choose No authentication', command: `/proxy wizard-auth ${draft.id} no` }
    : { label: 'Clear authentication', command: `/proxy wizard-clear-credentials ${draft.id}` }
  return {
    type: 'menu',
    title: `Authentication ${field} must be non-empty. The “-” sentinel is not supported; choose the explicit no-authentication action instead.`,
    options: [
      { label: `Enter ${field} again`, command: `/proxy wizard-field ${draft.id} ${field}` },
      ...(field === 'password' ? [{ label: 'Re-enter both credentials', command: `/proxy wizard-field ${draft.id} username` }] : []),
      explicitNoAuth,
      { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
    ],
  }
}

function draftPreview(draft: ProxyDraft): CommandResponse {
  const input = draft.input
  const ready = Boolean(candidateFromDraft(draft))
  return {
    type: 'menu',
    title: [
      `Profiles › ${draft.mode === 'add' ? 'Create new proxy profile — review' : `Edit ${input.name ?? input.id} — review`}`,
      `ID: ${input.id ?? '—'} · Name: ${input.name ?? '—'}`,
      `Endpoint: ${input.protocol ?? '—'}://${input.host ?? '—'}:${input.port ?? '—'}`,
      `Credentials: ${input.clearCredentials ? (draft.mode === 'add' ? 'None' : 'Will be cleared') : input.username !== undefined || input.password !== undefined ? 'Will be replaced (hidden)' : draft.hadCredentials ? 'Saved (hidden), unchanged' : 'None'}`,
      `Bypass list: ${input.noProxy?.join(', ') || 'localhost, 127.0.0.1, ::1'}`,
      `If unavailable: ${(input.failClosed ?? true) ? 'Block the connection' : 'Allow a direct fallback'} · Connection test: ${draft.tested ? 'Passed' : 'Required'}`,
    ].join('\n'),
    options: [
      ...(ready ? [{ label: 'Test candidate', command: `/proxy wizard-test ${draft.id}` }] : []),
      ...(ready && draft.tested ? [{ label: 'Save profile', command: `/proxy wizard-save ${draft.id}` }] : []),
      { label: 'Edit name', command: `/proxy wizard-field ${draft.id} name` },
      { label: 'Paste a different proxy URL', command: `/proxy wizard-field ${draft.id} proxyUrl` },
      { label: 'Edit endpoint manually', command: `/proxy wizard-protocols ${draft.id}` },
      { label: 'Replace credentials', command: `/proxy wizard-field ${draft.id} username` },
      ...((draft.hadCredentials || input.username !== undefined || input.password !== undefined) && !input.clearCredentials ? [{ label: 'Clear credentials', command: `/proxy wizard-clear-credentials ${draft.id}` }] : []),
      { label: 'Advanced options', command: `/proxy wizard-advanced ${draft.id}` },
      { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
    ],
  }
}

function scopeLabel(scope: string): string {
  return proxyScopeLabel(scope)
}

function categoryLabel(category: string): string {
  return proxyCategoryLabel(category)
}

interface TrafficCategory {
  id: string
  key: string
  scopes: string[]
}

function stableNavigationKey(value: string): string {
  return createHash('sha256').update(value).digest('base64url').slice(0, 10)
}

function knownTrafficCategories(core: OpenACPCore): TrafficCategory[] {
  const grouped = new Map<string, string[]>()
  for (const scope of core.proxyService.getKnownScopes()) {
    const category = scope.split('.')[0]
    if (!category) continue
    grouped.set(category, [...(grouped.get(category) ?? []), scope])
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, scopes]) => ({ id, key: stableNavigationKey(`category:${id}`), scopes: scopes.sort() }))
}

function resolveUniqueByKey<T>(items: T[], key: string | undefined, value: (item: T) => string): T | undefined {
  if (!key) return undefined
  const matches = items.filter((item) => stableNavigationKey(value(item)) === key)
  return matches.length === 1 ? matches[0] : undefined
}

function resolveScopeKey(core: OpenACPCore, key: string | undefined): string | undefined {
  return resolveUniqueByKey(['global', ...core.proxyService.getKnownScopes()], key, (scope) => `scope:${scope}`)
}

function resolveProfileKey(core: OpenACPCore, key: string | undefined): ReturnType<OpenACPCore['proxyService']['getProfile']> {
  return resolveUniqueByKey(core.proxyService.listProfiles(), key, (profile) => `profile:${profile.id}`)
}

function routeLabel(core: OpenACPCore, route: ProxyRoute): string {
  if (route === 'direct') return 'Connect directly'
  if (route === 'inherit') return 'Use host proxy settings'
  const id = route.slice('profile:'.length)
  return `Use profile “${core.proxyService.getProfile?.(id)?.name ?? id}”`
}

function resolvedFromLabel(scope: string): string {
  const label = proxyRouteSourceLabel(scope)
  return label === 'Global default' ? 'the global default' : label
}

function proxyHome(core: OpenACPCore, status: Partial<ProxyStatus>): CommandResponse {
  const profiles = core.proxyService.listProfiles()
  const routing = status.routing ?? { global: 'inherit' as ProxyRoute, routes: {} }
  const customRoutes = Object.keys(routing.routes).length
  const compatibility = status.environment?.compatibilityMode || status.environment?.daemonWideProxyActive
  return {
    type: 'menu',
    title: [
      '🌐 Network proxy',
      `Mode: ${compatibility ? 'Compatibility mode (running daemon has proxy variables)' : 'Scoped routing'}`,
      `Default: ${routeLabel(core, routing.global)}`,
      `Profiles: ${profiles.length} · Route overrides: ${customRoutes}`,
      'Routes override the default connection only for selected traffic.',
      profiles.length ? 'Next: choose what traffic should use each profile.' : 'Next: create and test a proxy profile, then assign it to traffic.',
    ].join('\n'),
    options: [
      { label: 'Routes', command: '/proxy routing' },
      { label: 'Proxy profiles', command: '/proxy profiles' },
      { label: 'Test connections', command: '/proxy diagnostics' },
    ],
  }
}

type RouteDiagnostic = ProxyStatus['diagnostics'][number]

function routeCategories(core: OpenACPCore): Array<{ id: string; label: string; diagnostics: RouteDiagnostic[] }> {
  const grouped = new Map<string, RouteDiagnostic[]>()
  for (const diagnostic of core.proxyService.status().diagnostics) {
    const category = diagnostic.scope.split('.')[0] || 'other'
    grouped.set(category, [...(grouped.get(category) ?? []), diagnostic])
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, diagnostics]) => ({ id, label: categoryLabel(id), diagnostics }))
}

function routeCategorySummary(category: { label: string; diagnostics: RouteDiagnostic[] }): string {
  const direct = category.diagnostics.filter((item) => item.route === 'direct').length
  const host = category.diagnostics.filter((item) => item.route === 'inherit').length
  const profiles = category.diagnostics.length - direct - host
  const parts = [
    profiles ? `${profiles} via saved profile${profiles === 1 ? '' : 's'}` : '',
    direct ? `${direct} direct` : '',
    host ? `${host} using host settings` : '',
  ].filter(Boolean)
  return `${category.label}: ${category.diagnostics.length} connection${category.diagnostics.length === 1 ? '' : 's'} · ${parts.join(' · ')}`
}

function routeDetailPages(core: OpenACPCore, diagnostics: RouteDiagnostic[]): string[][] {
  const lines = diagnostics.map((item) => [
    `${scopeLabel(item.scope)}: ${routeLabel(core, item.route)}`,
    `  Source: ${resolvedFromLabel(item.resolvedFrom)}`,
    ...(item.warning ? [`  Warning: ${item.warning}`] : []),
  ].join('\n'))
  const pages: string[][] = [[]]
  for (const line of lines) {
    const current = pages.at(-1)!
    if (current.length && [...current, line].join('\n').length > 3_200) pages.push([line])
    else current.push(line)
  }
  return pages
}

function routeTestFailureReason(error: ProxyRouteTestError): string {
  return error.message.replace(/^Proxy route test failed for [^;]+; route was not changed:\s*/i, '')
}

function parsedRevision(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function stalePolicyResponse(reopen: string): CommandResponse {
  return {
    type: 'menu',
    title: 'Proxy settings changed after this screen was opened. Your action was not applied.',
    options: [{ label: 'Refresh this screen', command: reopen }, { label: 'Proxy home', command: '/proxy status' }],
  }
}

export const PROXY_CAPABILITY_ERROR = 'Administrator permission is required to manage network proxy settings.'

function proxyCapabilityError(): CommandResponse {
  return { type: 'error', message: PROXY_CAPABILITY_ERROR }
}

/** Connector-neutral proxy command. Adapters render the returned menus in their native UI. */
export function registerProxyCommand(registry: CommandRegistry, _core: unknown): void {
  const core = _core as OpenACPCore
  registry.register({
    name: 'proxy',
    description: 'Configure network proxy',
    usage: '[status|profiles|routes|scope|set|test]',
    category: 'system',
    handler: async (args) => {
      const [action, ...rest] = args.raw.trim().split(/\s+/).filter(Boolean)
      const mutations = new Set([
        'add', 'edit', 'import', 'delete', 'delete-confirm', 'set', 'setk', 'clear', 'cleark', 'assign-confirm', 'ack',
        'wizard-field', 'wizard-input', 'wizard-protocols', 'wizard-protocol',
        'wizard-fail-closed', 'wizard-clear-credentials', 'wizard-test',
        'wizard-save', 'wizard-cancel', 'wizard-create-mode', 'wizard-default-port', 'wizard-auth',
        'wizard-review', 'wizard-advanced',
      ])
      // Authorize before reading status, profiles, routes, diagnostics, or test results.
      if (!(await canManageProxy(core, args))) return proxyCapabilityError()
      // Mutations deliberately re-check at execution time so cached menu access cannot authorize a write.
      if (action && mutations.has(action) && !(await canManageProxy(core, args))) {
        return proxyCapabilityError()
      }
      if (!action || action === 'status') {
        return proxyHome(core, core.proxyService.status())
      }
      if (action === 'routing') {
        const revision = core.proxyService.status().revision
        return { type: 'menu', title: 'Network proxy › Routes\nSet a default, then override only the traffic that needs a different connection.', options: [
          { label: 'Default for all traffic', command: `/proxy scope global ${revision} 0` },
          { label: 'Choose traffic category', command: `/proxy categories ${revision}` },
          { label: 'View effective routes', command: '/proxy routes' },
          { label: 'Back', command: '/proxy status' },
        ] }
      }
      if (action === 'diagnostics') {
        return { type: 'menu', title: 'Network proxy › Test connections\nThese checks verify external connectivity through each effective route. They do not test Telegram, Codex, or Groq service health and do not change settings.', options: [
          { label: 'Test Telegram route', command: '/proxy test channels.telegram' },
          { label: 'Test Codex route', command: '/proxy test agents.codex' },
          { label: 'Test Groq transcription route', command: '/proxy test services.speech' },
          { label: 'Test speech model-download route', command: '/proxy test services.speechDownloads' },
          { label: 'Back', command: '/proxy status' },
        ] }
      }
      if (action === 'help') {
        return { type: 'menu', title: 'A proxy profile stores an endpoint and optional hidden credentials. A route chooses whether traffic connects directly, uses the host proxy environment, or uses a saved profile.\n\nStart with Proxy profiles: create one, test it, and save it. Then open Routes to assign it. “Use parent route” removes an override; “Use host proxy settings” is an explicit route.', options: [{ label: 'Create a profile', command: '/proxy add' }, { label: 'Open routes', command: '/proxy routing' }, { label: 'Back', command: '/proxy status' }] }
      }
      if (action === 'profiles') {
        const profiles = core.proxyService.listProfiles()
        const canManage = await canManageProxy(core, args)
        if (!profiles.length) return canManage
          ? { type: 'menu', title: 'Network proxy › Proxy profiles\nNo profiles yet. A profile stores one proxy endpoint and optional hidden credentials.', options: [{ label: 'Create a proxy profile', command: '/proxy add' }, { label: 'Back', command: '/proxy status' }] } satisfies CommandResponse
          : { type: 'text', text: 'No proxy profiles configured.' } satisfies CommandResponse
        const page = Math.max(0, Number(rest[0] ?? 0) || 0); const start = page * 8
        return {
          type: 'menu',
          title: `Network proxy › Proxy profiles\n${profiles.length} saved. Credentials are always hidden.`,
          options: [...(canManage ? [{ label: 'Create a proxy profile', command: '/proxy add' }] : []), ...profiles.slice(start, start + 8).map((p) => ({
            label: `${p.name} · ${p.protocol.toUpperCase()} · ${p.hasCredentials ? 'Credentials saved' : 'No credentials'}`,
            command: `/proxy profile ${p.id}`,
          })), ...(page > 0 ? [{ label: 'Previous', command: `/proxy profiles ${page - 1}` }] : []), ...(start + 8 < profiles.length ? [{ label: 'Next', command: `/proxy profiles ${page + 1}` }] : []), { label: 'Back', command: '/proxy status' }],
        } satisfies CommandResponse
      }
      if (action === 'add') {
        const draft: ProxyDraft = {
          id: randomUUID(), owner: interactionOwner(args), mode: 'add',
          baseRevision: core.proxyService.status().revision,
          expiresAt: Date.now() + DRAFT_TTL_MS,
          input: { failClosed: true }, hadCredentials: false, tested: false,
        }
        storeDraft(draft)
        return inputResponse(draft, 'name', 'Create proxy profile — step 1 of 6\nEnter a short name you will recognize, for example “US office”. A technical ID will be created automatically.', args)
      }
      if (action === 'edit') {
        const profile = core.proxyService.getProfile(rest[0] ?? '')
        if (!profile) return { type: 'error', message: 'Profile not found.' }
        const draft: ProxyDraft = {
          id: randomUUID(), owner: interactionOwner(args), mode: 'edit',
          baseRevision: core.proxyService.status().revision,
          expiresAt: Date.now() + DRAFT_TTL_MS,
          input: {
            id: profile.id, name: profile.name, protocol: profile.protocol,
            host: profile.host, port: profile.port, noProxy: [...profile.noProxy],
            failClosed: profile.failClosed,
          },
          hadCredentials: profile.hasCredentials,
          tested: false,
        }
        storeDraft(draft)
        return draftPreview(draft)
      }
      if (action === 'wizard-field') {
        const draft = getDraft(rest[0], args)
        const field = rest[1]
        if (!draft) return { type: 'error', message: 'Draft expired or belongs to another user/conversation. Start again.' }
        const prompts: Record<string, string> = {
          id: 'Enter the technical profile ID: up to 64 letters, numbers, dots, underscores, or dashes. Most users can keep the generated ID.',
          name: 'Enter a short profile name you will recognize.',
          proxyUrl: 'Quick setup\nPaste the full proxy URL with an explicit port, for example socks5://user:password@proxy.example:1080. The connector removes this message before parsing; the URL and credentials are never shown again.',
          host: 'Create proxy profile — step 3 of 6\nEnter only the proxy hostname or IP address, without a protocol or port. Example: proxy.example.',
          port: 'Enter proxy port (1-65535).', username: 'Enter username. The message will be deleted before use.',
          password: 'Enter password. The message will be deleted before use.',
          noProxy: 'Enter hosts that should bypass this proxy, separated by commas. Example: localhost,127.0.0.1,.internal.example. Send - for no bypass entries.',
        }
        if (!field || !prompts[field]) return { type: 'error', message: 'Unknown profile field.' }
        return inputResponse(draft, field, prompts[field], args, field === 'username' || field === 'password' || field === 'proxyUrl')
      }
      if (action === 'wizard-create-mode') {
        const draft = getDraft(rest[0], args)
        if (!draft || draft.mode !== 'add') return { type: 'error', message: 'Create draft expired or unauthorized.' }
        if (rest[1] === 'quick') return inputResponse(draft, 'proxyUrl', 'Quick setup\nPaste an http://, https://, socks5://, or socks5h:// URL with an explicit port. Credentials may be included; the connector removes the message and the value remains hidden.', args, true)
        if (rest[1] === 'manual') return createProtocolMenu(draft)
        return { type: 'error', message: 'Unknown create mode.' }
      }
      if (action === 'wizard-input') {
        const draft = getDraft(rest[0], args)
        const field = rest[1]
        const captured = args.interaction?.capturedInput
        const value = captured?.value ?? rest.slice(2).join(' ').trim()
        if (!draft) return { type: 'error', message: 'Draft expired or belongs to another user/conversation. Start again.' }
        if (!field) return { type: 'error', message: 'A value is required.' }
        if ((field === 'username' || field === 'password') && (value.length === 0 || value === '-')) {
          return invalidCredentialResponse(draft, field)
        }
        if (value.length === 0) return { type: 'error', message: 'A value is required.' }
        if (field === 'id') {
          if (draft.mode !== 'add') return { type: 'error', message: 'Profile ID cannot be changed.' }
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) return { type: 'error', message: 'Profile ID must start with a letter or number and contain only letters, numbers, dot, underscore, or dash (maximum 64).' }
          if (core.proxyService.getProfile(value)) return { type: 'error', message: `Profile ${value} already exists. Use Edit instead.` }
          draft.input.id = value
        } else if (field === 'name') {
          const name = value.trim()
          if (!name || name.length > 100) return { type: 'error', message: 'Profile name must contain 1-100 non-whitespace characters.' }
          draft.input.name = name
          if (draft.mode === 'add' && !draft.input.id) {
            draft.input.id = uniqueProfileId(core, draft.input.name)
            draft.tested = false
            return { type: 'menu', title: `Create proxy profile — step 2 of 6\nName: ${draft.input.name}\nChoose the easiest setup method.`, options: [
              { label: 'Paste a proxy URL', command: `/proxy wizard-create-mode ${draft.id} quick` },
              { label: 'Enter details manually', command: `/proxy wizard-create-mode ${draft.id} manual` },
              { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
            ] }
          }
        } else if (field === 'proxyUrl') {
          if (!captured?.sensitive) return { type: 'error', message: 'Secure input is required for a proxy URL.' }
          let parsed
          try { parsed = core.proxyService.parseProxyUrlInput(value) }
          catch (error) {
            if (!(error instanceof ProxyValidationError)) throw error
            return {
              type: 'menu', title: `Proxy URL was not accepted: ${error.message}\nThe value was discarded and was not saved.`,
              options: [
                { label: 'Paste another URL', command: `/proxy wizard-field ${draft.id} proxyUrl` },
                { label: 'Use manual setup', command: `/proxy wizard-protocols ${draft.id}` },
                { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
              ],
            }
          }
          delete draft.input.proxyUrl
          Object.assign(draft.input, parsed)
          draft.tested = false
          return draftPreview(draft)
        } else if (field === 'host') {
          draft.input.host = value.trim()
          draft.tested = false
          return createPortMenu(draft)
        }
        else if (field === 'port') {
          const port = Number(value)
          if (!Number.isInteger(port) || port < 1 || port > 65535) return { type: 'error', message: 'Port must be an integer from 1 to 65535.' }
          draft.input.port = port
          if (draft.mode === 'add') { draft.tested = false; return createAuthMenu(draft) }
        } else if (field === 'username') {
          if (!captured?.sensitive) return { type: 'error', message: 'Secure input is required for credentials.' }
          draft.input.username = value
          draft.input.clearCredentials = false
          draft.tested = false
          return inputResponse(draft, 'password', 'Enter the proxy password. The message will be deleted before use.', args, true)
        } else if (field === 'password') {
          if (!captured?.sensitive) return { type: 'error', message: 'Secure input is required for credentials.' }
          draft.input.password = value
          draft.input.clearCredentials = false
        } else if (field === 'noProxy') {
          draft.input.noProxy = value === '-' ? [] : value.split(',').map((item) => item.trim()).filter(Boolean)
        } else return { type: 'error', message: 'Unknown profile field.' }
        draft.tested = false
        return draftPreview(draft)
      }
      if (action === 'wizard-default-port') {
        const draft = getDraft(rest[0], args)
        const port = Number(rest[1])
        if (!draft || !Number.isInteger(port)) return { type: 'error', message: 'Draft expired or port is invalid.' }
        draft.input.port = port; draft.tested = false
        return draft.mode === 'add' ? createAuthMenu(draft) : draftPreview(draft)
      }
      if (action === 'wizard-auth') {
        const draft = getDraft(rest[0], args)
        if (!draft || draft.mode !== 'add') return { type: 'error', message: 'Create draft expired or unauthorized.' }
        if (rest[1] === 'no') {
          delete draft.input.username; delete draft.input.password
          draft.input.clearCredentials = true; draft.tested = false
          return draftPreview(draft)
        }
        if (rest[1] === 'yes') return inputResponse(draft, 'username', 'Profiles › Create new proxy profile — step 6/6\nEnter the proxy username.', args, true)
        return { type: 'error', message: 'Unknown authentication choice.' }
      }
      if (action === 'wizard-protocols') {
        const draft = getDraft(rest[0], args)
        if (!draft) return { type: 'error', message: 'Draft expired or unauthorized.' }
        return { type: 'menu', title: 'Select proxy protocol', options: [
          ...PROXY_PROTOCOLS.map((protocol) => ({ label: protocol, command: `/proxy wizard-protocol ${draft.id} ${protocol}` })),
          { label: 'Back to review', command: `/proxy wizard-review ${draft.id}` },
          { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
        ] }
      }
      if (action === 'wizard-protocol') {
        const draft = getDraft(rest[0], args)
        const protocol = rest[1] as ProxyProtocol
        if (!draft || !PROXY_PROTOCOLS.includes(protocol)) return { type: 'error', message: 'Draft expired or protocol is invalid.' }
        draft.input.protocol = protocol; draft.tested = false
        return inputResponse(draft, 'host', `${draft.mode === 'add' ? 'Create proxy profile — step 3 of 6' : `Edit ${draft.input.name ?? draft.input.id} › Host`}\nEnter only the proxy hostname or IP address, without a protocol or port. Example: proxy.example.`, args)
      }
      if (action === 'wizard-review') {
        const draft = getDraft(rest[0], args)
        if (!draft) return { type: 'error', message: 'Draft expired or unauthorized.' }
        return draftPreview(draft)
      }
      if (action === 'wizard-advanced') {
        const draft = getDraft(rest[0], args)
        if (!draft) return { type: 'error', message: 'This draft expired or belongs to another conversation. Start again.' }
        const failClosed = draft.input.failClosed ?? true
        return {
          type: 'menu',
          title: `Proxy profile › Advanced options\nTechnical ID: ${draft.input.id ?? 'Not set'}\nBypass list: ${draft.input.noProxy?.join(', ') || 'localhost, 127.0.0.1, ::1'}\nIf the proxy is unavailable: ${failClosed ? 'Block the connection' : 'Allow a direct fallback'}`,
          options: [
            ...(draft.mode === 'add' ? [{ label: 'Change technical ID', command: `/proxy wizard-field ${draft.id} id` }] : []),
            { label: 'Edit bypass list', command: `/proxy wizard-field ${draft.id} noProxy` },
            { label: failClosed ? 'Allow direct fallback' : 'Block if unavailable', command: `/proxy wizard-fail-closed ${draft.id} ${failClosed ? 'false' : 'true'}` },
            { label: 'Back to review', command: `/proxy wizard-review ${draft.id}` },
            { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
          ],
        }
      }
      if (action === 'wizard-fail-closed') {
        const draft = getDraft(rest[0], args)
        if (!draft) return { type: 'error', message: 'Draft expired or unauthorized.' }
        draft.input.failClosed = rest[1] === 'true'; draft.tested = false
        return draftPreview(draft)
      }
      if (action === 'wizard-clear-credentials') {
        const draft = getDraft(rest[0], args)
        if (!draft) return { type: 'error', message: 'Draft expired or unauthorized.' }
        delete draft.input.username; delete draft.input.password
        draft.input.clearCredentials = true; draft.tested = false
        return draftPreview(draft)
      }
      if (action === 'wizard-test') {
        const draft = getDraft(rest[0], args)
        const candidate = draft && candidateFromDraft(draft)
        if (!draft || !candidate) return { type: 'error', message: 'Draft expired or required fields are incomplete.' }
        let result
        try { result = await core.proxyService.testProfileCandidate(candidate) }
        catch (error) {
          result = { ok: false, error: error instanceof ProxyValidationError ? error.message : 'Candidate validation failed' }
        }
        draft.tested = result.ok
        if (!result.ok) return {
          type: 'menu',
          title: `Connection test failed: ${result.error ?? 'No reason was returned.'}\nThe profile was not saved and current traffic was not changed. Check the endpoint or credentials, then try again.`,
          options: [
            { label: 'Retry test', command: `/proxy wizard-test ${draft.id}` },
            { label: 'Review and edit', command: `/proxy wizard-review ${draft.id}` },
            { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
          ],
        }
        return draftPreview(draft)
      }
      if (action === 'wizard-save') {
        const draft = getDraft(rest[0], args)
        const candidate = draft && candidateFromDraft(draft)
        if (!draft || !candidate) return { type: 'error', message: 'Draft expired or required fields are incomplete.' }
        if (!draft.tested) return { type: 'error', message: 'Test the connection successfully before saving this profile.' }
        let profile
        try {
          profile = draft.mode === 'add'
            ? await core.proxyService.createProfileSafely(candidate, draft.baseRevision)
            : await core.proxyService.updateProfileSafely(candidate, draft.baseRevision)
        } catch (error) {
          if (error instanceof ProxyProfileExistsError) return {
            type: 'menu',
            title: `⚠️ Profile ID ${candidate.id} was claimed while this draft was open. Nothing was overwritten.`,
            options: [
              { label: 'Choose another ID', command: `/proxy wizard-field ${draft.id} id` },
              { label: 'Profiles', command: '/proxy profiles' },
              { label: 'Cancel draft', command: `/proxy wizard-cancel ${draft.id}` },
            ],
          }
          if (error instanceof ProxyProfileNotFoundError) return {
            type: 'menu', title: '⚠️ This profile was deleted while the edit draft was open. Nothing was recreated.',
            options: [{ label: 'Profiles', command: '/proxy profiles' }, { label: 'Discard draft', command: `/proxy wizard-cancel ${draft.id}` }],
          }
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse('/proxy profiles')
          throw error
        }
        drafts.delete(draft.id)
        return { type: 'menu', title: `Proxy profile “${profile.name}” was tested and saved. Credentials remain hidden. Assign this profile to traffic when you are ready.`, options: [{ label: 'Assign this profile', command: `/proxy assign ${profile.id}` }, { label: 'Open profile', command: `/proxy profile ${profile.id}` }, { label: 'All profiles', command: '/proxy profiles' }] }
      }
      if (action === 'wizard-cancel') {
        const draft = getDraft(rest[0], args)
        if (draft) drafts.delete(draft.id)
        return { type: 'menu', title: 'Proxy profile draft discarded. No settings were changed.', options: [{ label: 'Proxy profiles', command: '/proxy profiles' }, { label: 'Proxy home', command: '/proxy status' }] }
      }
      if (action === 'profile' || action === 'pk') {
        const profile = action === 'pk' ? resolveProfileKey(core, rest[0]) : rest[0] ? core.proxyService.getProfile(rest[0]) : undefined
        const id = profile?.id
        if (!profile) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        const canManage = await canManageProxy(core, args)
        const status = core.proxyService.status()
        const revision = status.revision
        const assigned = [
          ...(status.routing?.global === `profile:${profile.id}` ? ['Default for all traffic'] : []),
          ...Object.entries(status.routing?.routes ?? {}).filter(([, route]) => route === `profile:${profile.id}`).map(([scope]) => scopeLabel(scope)),
        ]
        return {
          type: 'menu',
          title: `Proxy profile › ${profile.name}\nEndpoint: ${profile.protocol}://${profile.host}:${profile.port}\nCredentials: ${profile.hasCredentials ? 'Saved (hidden)' : 'None'}\nAssigned to: ${assigned.length ? `${assigned.length} traffic route${assigned.length === 1 ? '' : 's'}` : 'Nothing yet'}\nIf unavailable: ${profile.failClosed ? 'Block the connection' : 'Allow a direct fallback'}`,
          options: [
            { label: 'Test connection', command: `/proxy test-profile ${profile.id}` },
            ...(assigned.length ? [{ label: 'View current assignments', command: `/proxy profile-assignments ${profile.id} 0` }] : []),
            ...(canManage ? [
              { label: 'Assign this profile', command: `/proxy assign ${profile.id}` },
              { label: 'Edit profile', command: `/proxy edit ${profile.id}` },
              { label: 'Delete profile', command: `/proxy delete ${profile.id} ${revision} 0` },
            ] : []),
            { label: 'Back to profiles', command: '/proxy profiles' },
          ],
        } satisfies CommandResponse
      }
      if (action === 'profile-assignments') {
        const id = rest[0]
        const profile = id ? core.proxyService.getProfile(id) : undefined
        if (!profile) return { type: 'error', message: 'Profile not found.' }
        const status = core.proxyService.status()
        const assigned = [
          ...(status.routing?.global === `profile:${id}` ? ['Default for all traffic'] : []),
          ...Object.entries(status.routing?.routes ?? {}).filter(([, route]) => route === `profile:${id}`).map(([scope]) => scopeLabel(scope)),
        ]
        const page = Math.max(0, Math.min(Math.max(0, Math.ceil(assigned.length / 8) - 1), Number(rest[1] ?? 0) || 0))
        const start = page * 8
        return {
          type: 'menu',
          title: `Proxy profile › ${profile.name} › Current assignments\n${assigned.length ? assigned.slice(start, start + 8).map((label) => `• ${label}`).join('\n') : 'This profile is no longer assigned to traffic.'}`,
          options: [
            ...(page > 0 ? [{ label: 'Previous', command: `/proxy profile-assignments ${id} ${page - 1}` }] : []),
            ...(start + 8 < assigned.length ? [{ label: 'Next', command: `/proxy profile-assignments ${id} ${page + 1}` }] : []),
            { label: 'Back to profile', command: `/proxy profile ${id}` },
          ],
        }
      }
      if (action === 'import-help') {
        return { type: 'menu', title: `Importing replaces this profile from a protected host file. The file must be an absolute path to a mode-0600 env file; its contents and credentials are never displayed or logged.\n\nCommand: /proxy import ${rest[0] ?? '<id>'} <absolute-0600-env-file>`, options: [{ label: 'Back to profile', command: `/proxy profile ${rest[0] ?? ''}` }] } satisfies CommandResponse
      }
      if (action === 'import') {
        const [id, envFile] = rest
        if (!id || !envFile) return { type: 'error', message: 'Usage: /proxy import <id> <absolute-0600-env-file>' } satisfies CommandResponse
        const profile = await core.proxyService.importEnvFileSafely(id, envFile)
        return { type: 'menu', title: `Imported and tested proxy profile “${profile.name}”. Credentials remain hidden.`, options: [{ label: 'Assign this profile', command: `/proxy assign ${profile.id}` }, { label: 'Open profile', command: `/proxy profile ${profile.id}` }] } satisfies CommandResponse
      }
      if (action === 'test-profile') {
        const id = rest[0]
        if (!id) return { type: 'error', message: 'Usage: /proxy test-profile <id>' } satisfies CommandResponse
        const result = await core.proxyService.testProfile(id)
        return result.ok
          ? { type: 'menu', title: `Connection test passed for “${core.proxyService.getProfile(id)?.name ?? id}” (HTTP ${result.status}).`, options: [{ label: 'Back to profile', command: `/proxy profile ${id}` }, { label: 'Assign this profile', command: `/proxy assign ${id}` }] }
          : { type: 'menu', title: `Connection test failed for “${core.proxyService.getProfile(id)?.name ?? id}”: ${result.error ?? 'No reason was returned.'}\nNo settings were changed. Check the endpoint or credentials, then try again.`, options: [{ label: 'Retry test', command: `/proxy test-profile ${id}` }, { label: 'Edit profile', command: `/proxy edit ${id}` }, { label: 'Back to profile', command: `/proxy profile ${id}` }] }
      }
      if (action === 'assign') {
        const id = rest[0]
        const profile = id ? core.proxyService.getProfile(id) : undefined
        if (!profile) return { type: 'error', message: 'Proxy profile not found. Open Proxy profiles and choose another one.' }
        const status = core.proxyService.status()
        const categories = knownTrafficCategories(core)
        const page = Math.max(0, Math.min(Math.max(0, Math.ceil(categories.length / 8) - 1), Number(rest[1] ?? 0) || 0))
        const start = page * 8
        const profileKey = stableNavigationKey(`profile:${profile.id}`)
        return { type: 'menu', title: `Assign “${profile.name}”\nChoose which traffic should use this profile. The route is tested before it changes.`, options: [
          { label: 'Default for all traffic', command: `/proxy ask ${profileKey} ${stableNavigationKey('scope:global')} ${status.revision}` },
          ...categories.slice(start, start + 8).map((category) => ({ label: categoryLabel(category.id), command: `/proxy ak ${profileKey} ${category.key} ${status.revision} 0` })),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy ap ${profileKey} ${page - 1}` }] : []),
          ...(start + 8 < categories.length ? [{ label: 'Next', command: `/proxy ap ${profileKey} ${page + 1}` }] : []),
          { label: 'Back to profile', command: `/proxy pk ${profileKey}` },
        ] }
      }
      if (action === 'ap') {
        const profile = resolveProfileKey(core, rest[0])
        if (!profile) return { type: 'error', message: 'That proxy profile is no longer available. Open Proxy profiles and choose another one.' }
        return registry.execute(`/proxy assign ${profile.id} ${rest[1] ?? 0}`, args)
      }
      if (action === 'ak') {
        const profile = resolveProfileKey(core, rest[0])
        const category = resolveUniqueByKey(knownTrafficCategories(core), rest[1], (candidate) => `category:${candidate.id}`)
        const revision = parsedRevision(rest[2]) ?? core.proxyService.status().revision
        if (!profile || !category) return { type: 'error', message: 'That profile or traffic category is no longer available. Start the assignment again.' }
        const page = Math.max(0, Math.min(Math.max(0, Math.ceil(category.scopes.length / 8) - 1), Number(rest[3] ?? 0) || 0))
        const start = page * 8
        const profileKey = stableNavigationKey(`profile:${profile.id}`)
        return { type: 'menu', title: `Assign “${profile.name}” › ${categoryLabel(category.id)}\nChoose one traffic route.`, options: [
          ...category.scopes.slice(start, start + 8).map((scope) => ({ label: scopeLabel(scope), command: `/proxy ask ${profileKey} ${stableNavigationKey(`scope:${scope}`)} ${revision}` })),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy ak ${profileKey} ${category.key} ${revision} ${page - 1}` }] : []),
          ...(start + 8 < category.scopes.length ? [{ label: 'Next', command: `/proxy ak ${profileKey} ${category.key} ${revision} ${page + 1}` }] : []),
          { label: 'Back', command: `/proxy ap ${profileKey} 0` },
        ] }
      }
      if (action === 'ask') {
        const profile = resolveProfileKey(core, rest[0])
        const scope = resolveScopeKey(core, rest[1])
        const revision = parsedRevision(rest[2])
        if (!profile || !scope || revision === undefined) return { type: 'error', message: 'This assignment screen expired. Open the profile and try again.' }
        const current = core.proxyService.resolve(scope)
        const profileKey = stableNavigationKey(`profile:${profile.id}`)
        const scopeKey = stableNavigationKey(`scope:${scope}`)
        return { type: 'confirm', question: `Assign “${profile.name}” to ${scopeLabel(scope)}?\nCurrent effective route: ${routeLabel(core, current.route)}\nThe new route will be tested before it is saved.`, onYes: `/proxy ack ${profileKey} ${scopeKey} ${revision}`, onNo: `/proxy ap ${profileKey} 0` }
      }
      if (action === 'ack') {
        const profile = resolveProfileKey(core, rest[0])
        const scope = resolveScopeKey(core, rest[1])
        const revision = parsedRevision(rest[2])
        if (!profile || !scope || revision === undefined) return { type: 'error', message: 'This assignment expired. No settings were changed.' }
        try { await core.proxyService.setRoute(scope, `profile:${profile.id}`, revision) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy ap ${stableNavigationKey(`profile:${profile.id}`)} 0`)
          if (error instanceof ProxyRouteTestError) return { type: 'menu', title: `The route test failed, so ${scopeLabel(scope)} was not changed. ${routeTestFailureReason(error)}`, options: [{ label: 'Retry assignment', command: `/proxy ask ${stableNavigationKey(`profile:${profile.id}`)} ${stableNavigationKey(`scope:${scope}`)} ${revision}` }, { label: 'Back to profile', command: `/proxy pk ${stableNavigationKey(`profile:${profile.id}`)}` }] }
          throw error
        }
        return { type: 'menu', title: `${scopeLabel(scope)} now uses proxy profile “${profile.name}”. Existing coding-agent sessions keep their current connection; new sessions use the updated route.`, options: [{ label: 'Test effective route', command: `/proxy testk ${stableNavigationKey(`scope:${scope}`)}` }, { label: 'Back to profile', command: `/proxy profile ${profile.id}` }, { label: 'Assign elsewhere', command: `/proxy assign ${profile.id}` }] }
      }
      if (action === 'assign-category') {
        const [id, category, revisionRaw, pageRaw] = rest
        const profile = id ? core.proxyService.getProfile(id) : undefined
        const scopes = category ? core.proxyService.getKnownScopes().filter((scope) => scope.startsWith(`${category}.`)) : []
        if (!profile || !category || !scopes.length) return { type: 'error', message: 'That profile or traffic category is no longer available. Start the assignment again.' }
        const revision = parsedRevision(revisionRaw) ?? core.proxyService.status().revision
        const page = Math.max(0, Number(pageRaw ?? 0) || 0); const start = page * 8
        return { type: 'menu', title: `Assign “${profile.name}” › ${categoryLabel(category)}\nChoose one traffic route.`, options: [
          ...scopes.slice(start, start + 8).map((scope) => ({ label: scopeLabel(scope), command: `/proxy assign-scope ${id} ${scope} ${revision}` })),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy assign-category ${id} ${category} ${revision} ${page - 1}` }] : []),
          ...(start + 8 < scopes.length ? [{ label: 'Next', command: `/proxy assign-category ${id} ${category} ${revision} ${page + 1}` }] : []),
          { label: 'Back', command: `/proxy assign ${id}` },
        ] }
      }
      if (action === 'assign-scope') {
        const [id, scope, revisionRaw] = rest
        const profile = id ? core.proxyService.getProfile(id) : undefined
        const revision = parsedRevision(revisionRaw)
        if (!profile || !scope || revision === undefined) return { type: 'error', message: 'This assignment screen expired. Open the profile and try again.' }
        const current = core.proxyService.resolve(scope)
        return { type: 'confirm', question: `Assign “${profile.name}” to ${scopeLabel(scope)}?\nCurrent effective route: ${routeLabel(core, current.route)}\nThe new route will be tested before it is saved.`, onYes: `/proxy assign-confirm ${id} ${scope} ${revision}`, onNo: `/proxy assign ${id}` }
      }
      if (action === 'assign-confirm') {
        const [id, scope, revisionRaw] = rest
        const profile = id ? core.proxyService.getProfile(id) : undefined
        const revision = parsedRevision(revisionRaw)
        if (!profile || !scope || revision === undefined) return { type: 'error', message: 'This assignment expired. No settings were changed.' }
        try { await core.proxyService.setRoute(scope, `profile:${id}`, revision) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy assign ${id}`)
          if (error instanceof ProxyRouteTestError) return { type: 'menu', title: `The route test failed, so ${scopeLabel(scope)} was not changed. ${error.message.replace(/^Proxy route test failed for [^;]+; route was not changed:\s*/i, '')}`, options: [{ label: 'Retry assignment', command: `/proxy assign-scope ${id} ${scope} ${revision}` }, { label: 'Edit profile', command: `/proxy edit ${id}` }, { label: 'Back to profile', command: `/proxy profile ${id}` }] }
          throw error
        }
        return { type: 'menu', title: `${scopeLabel(scope)} now uses proxy profile “${profile.name}”. Existing coding-agent sessions keep their current connection; new sessions use the updated route.`, options: [{ label: 'Test effective route', command: `/proxy test ${scope}` }, { label: 'Back to profile', command: `/proxy profile ${id}` }, { label: 'Assign elsewhere', command: `/proxy assign ${id}` }] }
      }
      if (action === 'delete') {
        const id = rest[0]
        if (!id || !core.proxyService.getProfile(id)) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        const status = core.proxyService.status()
        const baseRevision = parsedRevision(rest[1]) ?? status.revision
        const page = Math.max(0, Number(rest[2] ?? 0) || 0)
        const routing = status.routing ?? { global: 'inherit' as ProxyRoute, routes: {} }
        const usedBy = [
          ...(routing.global === `profile:${id}` ? ['global'] : []),
          ...Object.entries(routing.routes).filter(([, route]) => route === `profile:${id}`).map(([scope]) => scope),
        ]
        if (usedBy.length) {
          const alternatives = core.proxyService.listProfiles().filter((profile) => profile.id !== id)
          const start = page * 6
          return {
            type: 'menu',
            title: `Delete “${core.proxyService.getProfile(id)?.name ?? id}”?\nIt is currently used by ${usedBy.length} traffic route${usedBy.length === 1 ? '' : 's'}. Choose where that traffic should go; reassignment and deletion happen together.`,
            options: [
              { label: 'Cancel', command: `/proxy profile ${id}` },
              { label: 'Review current assignments', command: `/proxy profile-assignments ${id} 0` },
              { label: 'Move traffic to Direct', command: `/proxy delete-confirm ${id} ${baseRevision} direct` },
              { label: 'Move to host proxy settings', command: `/proxy delete-confirm ${id} ${baseRevision} inherit` },
              ...alternatives.slice(start, start + 6).map((profile) => ({ label: `Move to ${profile.name}`, command: `/proxy delete-confirm ${id} ${baseRevision} profile:${profile.id}` })),
              ...(page > 0 ? [{ label: 'Previous replacements', command: `/proxy delete ${id} ${baseRevision} ${page - 1}` }] : []),
              ...(start + 6 < alternatives.length ? [{ label: 'Next replacements', command: `/proxy delete ${id} ${baseRevision} ${page + 1}` }] : []),
            ],
          }
        }
        return {
          type: 'menu', title: `Delete proxy profile “${core.proxyService.getProfile(id)?.name ?? id}”?\nThis removes the saved endpoint and credentials. It is not assigned to any traffic.`,
          options: [
            { label: 'Cancel', command: '/proxy profiles' },
            { label: 'Delete permanently', command: `/proxy delete-confirm ${id} ${baseRevision}` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'delete-confirm') {
        const id = rest[0]
        if (!id) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        const expectedRevision = parsedRevision(rest[1])
        if (expectedRevision === undefined) return { type: 'error', message: 'Delete confirmation expired. Reopen the profile.' }
        const route = rest[2] as ProxyRoute | undefined
        let result
        try { result = await core.proxyService.deleteProfileSafely(id, route, expectedRevision) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy profile ${id}`)
          if (error instanceof ProxyRouteTestError) return {
            type: 'menu',
            title: `The replacement route test failed, so “${core.proxyService.getProfile(id)?.name ?? id}” was not deleted and no traffic was changed. ${routeTestFailureReason(error)}`,
            options: [
              { label: 'Retry deletion', command: `/proxy delete-confirm ${id} ${expectedRevision}${route ? ` ${route}` : ''}` },
              { label: 'Choose another replacement', command: `/proxy delete ${id} ${expectedRevision} 0` },
              { label: 'Back to profile', command: `/proxy profile ${id}` },
            ],
          }
          throw error
        }
        return { type: 'menu', title: `Proxy profile deleted.${result.reassignedScopes.length ? ` ${result.reassignedScopes.length} traffic route${result.reassignedScopes.length === 1 ? '' : 's'} reassigned.` : ''}`, options: [{ label: 'Proxy profiles', command: '/proxy profiles' }, { label: 'View routes', command: '/proxy routing' }] } satisfies CommandResponse
      }
      if (action === 'routes') {
        const categories = routeCategories(core)
        if (!categories.length) return { type: 'menu', title: 'Network proxy › Effective routes\nNo registered traffic routes.', options: [{ label: 'Edit routes', command: '/proxy routing' }, { label: 'Back', command: '/proxy status' }] }
        const page = Math.max(0, Math.min(Math.ceil(categories.length / 8) - 1, Number(rest[0] ?? 0) || 0))
        const start = page * 8
        const visible = categories.slice(start, start + 8)
        return {
          type: 'menu',
          title: `Network proxy › Effective routes\n${visible.map(routeCategorySummary).join('\n')}`,
          options: [
            ...visible.map((category, index) => ({ label: `${category.label} · ${category.diagnostics.length}`, command: `/proxy routes-category ${start + index} 0` })),
            ...(page > 0 ? [{ label: 'Previous', command: `/proxy routes ${page - 1}` }] : []),
            ...(start + 8 < categories.length ? [{ label: 'Next', command: `/proxy routes ${page + 1}` }] : []),
            { label: 'Edit routes', command: '/proxy routing' },
            { label: 'Back', command: '/proxy status' },
          ],
        } satisfies CommandResponse
      }
      if (action === 'routes-category') {
        const categories = routeCategories(core)
        const categoryIndex = Number(rest[0])
        const category = Number.isSafeInteger(categoryIndex) ? categories[categoryIndex] : undefined
        if (!category) return { type: 'menu', title: 'The route list changed while this screen was open.', options: [{ label: 'Refresh routes', command: '/proxy routes' }, { label: 'Proxy home', command: '/proxy status' }] }
        const pages = routeDetailPages(core, category.diagnostics)
        const page = Math.max(0, Math.min(pages.length - 1, Number(rest[1] ?? 0) || 0))
        return {
          type: 'menu',
          title: `Network proxy › Effective routes › ${category.label}\n${pages[page].join('\n')}`,
          options: [
            ...(page > 0 ? [{ label: 'Previous', command: `/proxy routes-category ${categoryIndex} ${page - 1}` }] : []),
            ...(page + 1 < pages.length ? [{ label: 'Next', command: `/proxy routes-category ${categoryIndex} ${page + 1}` }] : []),
            { label: 'Back to categories', command: `/proxy routes ${Math.floor(categoryIndex / 8)}` },
            { label: 'Edit routes', command: '/proxy routing' },
          ],
        } satisfies CommandResponse
      }
      if (action === 'categories') {
        const baseRevision = parsedRevision(rest[0]) ?? core.proxyService.status().revision
        const categories = knownTrafficCategories(core)
        const page = Math.max(0, Math.min(Math.max(0, Math.ceil(categories.length / 8) - 1), Number(rest[1] ?? 0) || 0))
        const start = page * 8
        return { type: 'menu', title: 'Network proxy › Traffic categories\nChoose the kind of traffic you want to route.', options: [
          ...categories.slice(start, start + 8).map((category) => ({ label: categoryLabel(category.id), command: `/proxy ck ${category.key} ${baseRevision} 0` })),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy categories ${baseRevision} ${page - 1}` }] : []),
          ...(start + 8 < categories.length ? [{ label: 'Next', command: `/proxy categories ${baseRevision} ${page + 1}` }] : []),
          { label: 'Back', command: '/proxy routing' },
        ] } satisfies CommandResponse
      }
      if (action === 'ck') {
        const categories = knownTrafficCategories(core)
        const category = resolveUniqueByKey(categories, rest[0], (candidate) => `category:${candidate.id}`)
        if (!category) return { type: 'menu', title: 'The traffic category list changed while this screen was open.', options: [{ label: 'Refresh categories', command: '/proxy categories' }, { label: 'Proxy home', command: '/proxy status' }] }
        const baseRevision = parsedRevision(rest[1]) ?? core.proxyService.status().revision
        const page = Math.max(0, Math.min(Math.max(0, Math.ceil(category.scopes.length / 8) - 1), Number(rest[2] ?? 0) || 0))
        const start = page * 8
        return { type: 'menu', title: `Network proxy › ${categoryLabel(category.id)}\nChoose a connection to review or change.`, options: [
          ...category.scopes.slice(start, start + 8).map((scope) => { const route = core.proxyService.resolve(scope); return { label: `${scopeLabel(scope)} · ${routeLabel(core, route.route)}`, command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${baseRevision} 0` } }),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy ck ${category.key} ${baseRevision} ${page - 1}` }] : []),
          ...(start + 8 < category.scopes.length ? [{ label: 'Next', command: `/proxy ck ${category.key} ${baseRevision} ${page + 1}` }] : []),
          { label: 'Back', command: `/proxy categories ${baseRevision} ${Math.floor(categories.indexOf(category) / 8)}` },
        ] } satisfies CommandResponse
      }
      if (action === 'category') {
        const category = rest[0]
        const scopes = core.proxyService.getKnownScopes().filter((s) => s.startsWith(`${category}.`))
        if (!category || !scopes.length) return { type: 'error', message: 'Proxy category not found.' }
        const baseRevision = parsedRevision(rest[1]) ?? core.proxyService.status().revision
        const page = Math.max(0, Number(rest[2] ?? 0) || 0); const start = page * 8
        return { type: 'menu', title: `Network proxy › ${categoryLabel(category)}\nChoose a connection to review or change.`, options: [
          ...scopes.slice(start, start + 8).map((scope) => { const r = core.proxyService.resolve(scope); return { label: `${scopeLabel(scope)} · ${routeLabel(core, r.route)}`, command: `/proxy scope ${scope} ${baseRevision} 0` } }),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy category ${category} ${baseRevision} ${page - 1}` }] : []),
          ...(start + 8 < scopes.length ? [{ label: 'Next', command: `/proxy category ${category} ${baseRevision} ${page + 1}` }] : []),
          { label: 'Back', command: `/proxy categories ${baseRevision}` },
        ] } satisfies CommandResponse
      }
      if (action === 'scope') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy scope <scope>' } satisfies CommandResponse
        const current = core.proxyService.resolve(scope)
        const status = core.proxyService.status()
        const savedRoute = scope === 'global'
          ? status.routing?.global ?? 'inherit'
          : status.routing?.routes?.[scope]
        const profiles = core.proxyService.listProfiles()
        const baseRevision = parsedRevision(rest[1]) ?? status.revision
        const page = Math.max(0, Number(rest[2] ?? 0) || 0); const start = page * 6
        return {
          type: 'menu',
          title: [
            `Network proxy › ${scopeLabel(scope)}`,
            `Saved override: ${savedRoute ? routeLabel(core, savedRoute) : 'None (uses parent route)'}`,
            `Effective route: ${routeLabel(core, current.route)}`,
            `Source: ${resolvedFromLabel(current.resolvedFrom ?? 'global')}`,
          ].join('\n'),
          options: [
            { label: `Connect directly${savedRoute === 'direct' ? ' ✓' : ''}`, command: `/proxy set ${scope} direct ${baseRevision}` },
            { label: `Use host proxy settings${savedRoute === 'inherit' ? ' ✓' : ''}`, command: `/proxy set ${scope} inherit ${baseRevision}` },
            ...profiles.slice(start, start + 6).map((p) => ({ label: `Use ${p.name}${savedRoute === `profile:${p.id}` ? ' ✓' : ''}`, command: `/proxy set ${scope} profile:${p.id} ${baseRevision}` })),
            ...(page > 0 ? [{ label: 'Previous profiles', command: `/proxy scope ${scope} ${baseRevision} ${page - 1}` }] : []),
            ...(start + 6 < profiles.length ? [{ label: 'Next profiles', command: `/proxy scope ${scope} ${baseRevision} ${page + 1}` }] : []),
            ...(scope === 'global' ? [] : [{ label: `Use parent route${savedRoute === undefined ? ' ✓' : ''}`, command: `/proxy clear ${scope} ${baseRevision}` }]),
            { label: 'Test effective route', command: `/proxy test ${scope}` },
            { label: 'Back', command: scope === 'global' ? '/proxy routing' : `/proxy category ${scope.split('.')[0]} ${baseRevision} 0` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'sk') {
        const scope = resolveScopeKey(core, rest[0])
        if (!scope) return { type: 'menu', title: 'This traffic route is no longer available.', options: [{ label: 'Refresh categories', command: '/proxy categories' }, { label: 'Proxy home', command: '/proxy status' }] }
        const current = core.proxyService.resolve(scope)
        const status = core.proxyService.status()
        const savedRoute = scope === 'global' ? status.routing?.global ?? 'inherit' : status.routing?.routes?.[scope]
        const profiles = core.proxyService.listProfiles()
        const baseRevision = parsedRevision(rest[1]) ?? status.revision
        const page = Math.max(0, Math.min(Math.max(0, Math.ceil(profiles.length / 6) - 1), Number(rest[2] ?? 0) || 0))
        const start = page * 6
        const scopeKey = stableNavigationKey(`scope:${scope}`)
        const category = knownTrafficCategories(core).find((candidate) => candidate.scopes.includes(scope))
        return {
          type: 'menu',
          title: [
            `Network proxy › ${scopeLabel(scope)}`,
            `Saved override: ${savedRoute ? routeLabel(core, savedRoute) : 'None (uses parent route)'}`,
            `Effective route: ${routeLabel(core, current.route)}`,
            `Source: ${resolvedFromLabel(current.resolvedFrom ?? 'global')}`,
          ].join('\n'),
          options: [
            { label: `Connect directly${savedRoute === 'direct' ? ' ✓' : ''}`, command: `/proxy setk ${scopeKey} d ${baseRevision}` },
            { label: `Use host proxy settings${savedRoute === 'inherit' ? ' ✓' : ''}`, command: `/proxy setk ${scopeKey} i ${baseRevision}` },
            ...profiles.slice(start, start + 6).map((profile) => ({ label: `Use ${profile.name}${savedRoute === `profile:${profile.id}` ? ' ✓' : ''}`, command: `/proxy setk ${scopeKey} ${stableNavigationKey(`profile:${profile.id}`)} ${baseRevision}` })),
            ...(page > 0 ? [{ label: 'Previous profiles', command: `/proxy sk ${scopeKey} ${baseRevision} ${page - 1}` }] : []),
            ...(start + 6 < profiles.length ? [{ label: 'Next profiles', command: `/proxy sk ${scopeKey} ${baseRevision} ${page + 1}` }] : []),
            ...(scope === 'global' ? [] : [{ label: `Use parent route${savedRoute === undefined ? ' ✓' : ''}`, command: `/proxy cleark ${scopeKey} ${baseRevision}` }]),
            { label: 'Test effective route', command: `/proxy testk ${scopeKey}` },
            { label: 'Back', command: scope === 'global' || !category ? '/proxy routing' : `/proxy ck ${category.key} ${baseRevision} 0` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'setk') {
        const scope = resolveScopeKey(core, rest[0])
        const profile = rest[1] !== 'd' && rest[1] !== 'i' ? resolveProfileKey(core, rest[1]) : undefined
        const route: ProxyRoute | undefined = rest[1] === 'd' ? 'direct' : rest[1] === 'i' ? 'inherit' : profile ? `profile:${profile.id}` : undefined
        if (!scope || !route) return { type: 'error', message: 'This route screen expired. Refresh the traffic categories and try again.' }
        try { await core.proxyService.setRoute(scope, route, parsedRevision(rest[2])) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0`)
          if (error instanceof ProxyRouteTestError) return { type: 'menu', title: `The route test failed, so ${scopeLabel(scope)} was not changed. ${routeTestFailureReason(error)}`, options: [{ label: 'Retry', command: `/proxy setk ${stableNavigationKey(`scope:${scope}`)} ${rest[1]} ${rest[2] ?? ''}`.trim() }, { label: 'Choose another route', command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0` }, { label: 'Proxy home', command: '/proxy status' }] }
          throw error
        }
        return { type: 'menu', title: `${scopeLabel(scope)} now uses: ${routeLabel(core, route)}.${scope.startsWith('agents.') ? '\nNew coding-agent processes will use this route. Existing sessions keep their current connection and were not restarted.' : ''}`, options: [{ label: 'Test effective route', command: `/proxy testk ${stableNavigationKey(`scope:${scope}`)}` }, { label: 'Back to this route', command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0` }, { label: 'View all routes', command: '/proxy routes' }] } satisfies CommandResponse
      }
      if (action === 'cleark') {
        const scope = resolveScopeKey(core, rest[0])
        if (!scope) return { type: 'error', message: 'This route screen expired. Refresh the traffic categories and try again.' }
        try { await core.proxyService.clearRoute(scope, parsedRevision(rest[1])) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0`)
          if (error instanceof ProxyRouteTestError) return { type: 'menu', title: `The parent route test failed, so ${scopeLabel(scope)} kept its current override. ${routeTestFailureReason(error)}\nNo settings were changed.`, options: [{ label: 'Retry parent route', command: `/proxy cleark ${stableNavigationKey(`scope:${scope}`)} ${rest[1] ?? ''}`.trim() }, { label: 'Choose another route', command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0` }] }
          throw error
        }
        const resolved = core.proxyService.resolve(scope)
        return { type: 'menu', title: `${scopeLabel(scope)} now uses its parent route.\nEffective route: ${routeLabel(core, resolved.route)}\nSource: ${resolvedFromLabel(resolved.resolvedFrom ?? 'global')}`, options: [{ label: 'Test effective route', command: `/proxy testk ${stableNavigationKey(`scope:${scope}`)}` }, { label: 'Back to this route', command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0` }] }
      }
      if (action === 'testk') {
        const scope = resolveScopeKey(core, rest[0])
        if (!scope) return { type: 'error', message: 'This traffic route is no longer available.' }
        const result = await core.proxyService.test(scope)
        return result.ok
          ? { type: 'menu', title: `${scopeLabel(scope)} connection test passed (HTTP ${result.status}).\nEffective route: ${routeLabel(core, core.proxyService.resolve(scope).route)}`, options: [{ label: 'Back to this route', command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0` }, { label: 'Test another connection', command: '/proxy diagnostics' }] }
          : { type: 'menu', title: `${scopeLabel(scope)} connection test failed: ${result.error ?? 'No reason was returned.'}\nNo settings were changed. Review the effective route or proxy profile, then try again.`, options: [{ label: 'Retry test', command: `/proxy testk ${stableNavigationKey(`scope:${scope}`)}` }, { label: 'Change route', command: `/proxy sk ${stableNavigationKey(`scope:${scope}`)} ${core.proxyService.status().revision} 0` }, { label: 'Test another connection', command: '/proxy diagnostics' }] }
      }
      if (action === 'set') {
        const [scope, route, revisionRaw] = rest
        if (!scope || !route) return { type: 'error', message: 'Usage: /proxy set <scope> <direct|inherit|profile:id>' } satisfies CommandResponse
        let change
        try { change = await core.proxyService.setRoute(scope, route as ProxyRoute, parsedRevision(revisionRaw)) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy scope ${scope}`)
          if (error instanceof ProxyRouteTestError) return { type: 'menu', title: `The route test failed, so ${scopeLabel(scope)} was not changed. ${error.message.replace(/^Proxy route test failed for [^;]+; route was not changed:\s*/i, '')}`, options: [{ label: 'Retry', command: `/proxy set ${scope} ${route} ${revisionRaw ?? ''}`.trim() }, { label: 'Choose another route', command: `/proxy scope ${scope}` }, { label: 'Proxy home', command: '/proxy status' }] }
          throw error
        }
        const note = change.activeAgentProcessesUnaffected
          ? '\nNew coding-agent processes will use this route. Existing sessions keep their current connection and were not restarted.'
          : ''
        return { type: 'menu', title: `${scopeLabel(scope)} now uses: ${routeLabel(core, route as ProxyRoute)}.${note}`, options: [{ label: 'Test effective route', command: `/proxy test ${scope}` }, { label: 'Back to this route', command: `/proxy scope ${scope}` }, { label: 'View all routes', command: '/proxy routes' }] } satisfies CommandResponse
      }
      if (action === 'clear') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy clear <scope|global>' }
        try { await core.proxyService.clearRoute(scope, parsedRevision(rest[1])) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy scope ${scope}`)
          if (error instanceof ProxyRouteTestError) return {
            type: 'menu',
            title: `The parent route test failed, so ${scopeLabel(scope)} kept its current override. ${routeTestFailureReason(error)}\nNo settings were changed.`,
            options: [
              { label: 'Retry parent route', command: `/proxy clear ${scope}${rest[1] ? ` ${rest[1]}` : ''}` },
              { label: 'Choose another route', command: `/proxy scope ${scope}` },
              { label: 'Proxy home', command: '/proxy status' },
            ],
          }
          throw error
        }
        const resolved = core.proxyService.resolve(scope)
        return { type: 'menu', title: `${scopeLabel(scope)} now uses its parent route.\nEffective route: ${routeLabel(core, resolved.route)}\nSource: ${resolvedFromLabel(resolved.resolvedFrom ?? 'global')}`, options: [{ label: 'Test effective route', command: `/proxy test ${scope}` }, { label: 'Back to this route', command: `/proxy scope ${scope}` }] }
      }
      if (action === 'test') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy test <scope>' } satisfies CommandResponse
        const result = await core.proxyService.test(scope)
        return result.ok
          ? { type: 'menu', title: `${scopeLabel(scope)} connection test passed (HTTP ${result.status}).\nEffective route: ${routeLabel(core, core.proxyService.resolve(scope).route)}`, options: [{ label: 'Back to this route', command: `/proxy scope ${scope}` }, { label: 'Test another connection', command: '/proxy diagnostics' }] }
          : { type: 'menu', title: `${scopeLabel(scope)} connection test failed: ${result.error ?? 'No reason was returned.'}\nNo settings were changed. Review the effective route or proxy profile, then try again.`, options: [{ label: 'Retry test', command: `/proxy test ${scope}` }, { label: 'Change route', command: `/proxy scope ${scope}` }, { label: 'Test another connection', command: '/proxy diagnostics' }] }
      }
      return { type: 'error', message: 'Unknown proxy action. Use /proxy to open the menu.' } satisfies CommandResponse
    },
  })
}

async function canManageProxy(core: OpenACPCore, args: CommandArgs): Promise<boolean> {
  const identity = core.lifecycleManager?.serviceRegistry?.get<IdentityService>('identity')
  if (!identity) return false
  try {
    const user = await identity.getUserByIdentity(formatIdentityId(args.channelId, args.userId))
    return Boolean(user && hasIdentityCapability(user.role, 'network:proxy:manage'))
  } catch {
    return false
  }
}
