import type { CommandRegistry } from '../command-registry.js'
import type { CommandResponse } from '../plugin/types.js'
import type { OpenACPCore } from '../core.js'
import type { ProxyRoute } from '../network/proxy-types.js'
import type { ProxyProfileInput, ProxyProtocol } from '../network/proxy-types.js'
import { PROXY_PROTOCOLS } from '../network/proxy-types.js'
import { randomUUID } from 'node:crypto'
import type { IdentityService } from '../../plugins/identity/types.js'
import { formatIdentityId, hasIdentityCapability } from '../../plugins/identity/types.js'
import type { CommandArgs } from '../plugin/types.js'
import { ProxyRevisionConflictError } from '../network/proxy-store.js'
import { ProxyProfileExistsError, ProxyProfileNotFoundError, ProxyValidationError } from '../network/proxy-service.js'

interface ProxyDraft {
  id: string
  owner: string
  mode: 'add' | 'edit'
  baseRevision: number
  expiresAt: number
  input: Partial<ProxyProfileInput>
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
  return { type: 'menu', title: 'Profiles › Create new proxy profile — step 2/6\nChoose the upstream proxy protocol.', options: [
    ...PROXY_PROTOCOLS.map((protocol) => ({ label: protocol.toUpperCase(), command: `/proxy wizard-protocol ${draft.id} ${protocol}` })),
    { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
  ] }
}

function createPortMenu(draft: ProxyDraft): CommandResponse {
  const defaultPort = draft.input.protocol?.startsWith('socks') ? 1080 : draft.input.protocol === 'https' ? 443 : 8080
  return { type: 'menu', title: `Profiles › ${draft.mode === 'add' ? 'Create new proxy profile — step 4/6' : `Edit ${draft.input.name ?? draft.input.id} — endpoint port`}\nChoose a port for ${draft.input.protocol}://${draft.input.host}.`, options: [
    { label: `Use default (${defaultPort})`, command: `/proxy wizard-default-port ${draft.id} ${defaultPort}` },
    { label: 'Enter another port', command: `/proxy wizard-field ${draft.id} port` },
    { label: 'Back', command: `/proxy wizard-field ${draft.id} host` },
    { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
  ] }
}

function createAuthMenu(draft: ProxyDraft): CommandResponse {
  return { type: 'menu', title: 'Profiles › Create new proxy profile — step 5/6\nDoes this proxy require username/password authentication?', options: [
    { label: 'No authentication', command: `/proxy wizard-auth ${draft.id} no` },
    { label: 'Use authentication', command: `/proxy wizard-auth ${draft.id} yes` },
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
      { label: `Retry ${field}`, command: `/proxy wizard-field ${draft.id} ${field}` },
      ...(field === 'password' ? [{ label: 'Restart credential entry', command: `/proxy wizard-field ${draft.id} username` }] : []),
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
      `Credentials: ${input.clearCredentials ? (draft.mode === 'add' ? 'none' : 'will be cleared') : input.username !== undefined || input.password !== undefined ? 'will be updated (write-only)' : 'unchanged/none'}`,
      `NO_PROXY: ${input.noProxy?.join(', ') || 'localhost, 127.0.0.1, ::1'}`,
      `Fail closed: ${input.failClosed ?? true} · Tested: ${draft.tested ? 'yes' : 'no'}`,
    ].join('\n'),
    options: [
      ...(ready ? [{ label: 'Test candidate', command: `/proxy wizard-test ${draft.id}` }] : []),
      ...(ready && draft.tested ? [{ label: 'Save profile', command: `/proxy wizard-save ${draft.id}` }] : []),
      { label: 'Edit name', command: `/proxy wizard-field ${draft.id} name` },
      { label: 'Replace with proxy URL', command: `/proxy wizard-field ${draft.id} proxyUrl` },
      { label: 'Set endpoint manually', command: `/proxy wizard-protocols ${draft.id}` },
      { label: 'Rotate credentials', command: `/proxy wizard-field ${draft.id} username` },
      { label: 'Clear authentication', command: `/proxy wizard-clear-credentials ${draft.id}` },
      ...(draft.mode === 'add' ? [{ label: 'Advanced: manual ID', command: `/proxy wizard-field ${draft.id} id` }] : []),
      { label: 'Advanced: NO_PROXY', command: `/proxy wizard-field ${draft.id} noProxy` },
      { label: `Advanced: fail closed ${input.failClosed ?? true}`, command: `/proxy wizard-fail-closed ${draft.id} ${(input.failClosed ?? true) ? 'false' : 'true'}` },
      { label: 'Cancel', command: `/proxy wizard-cancel ${draft.id}` },
    ],
  }
}

function routeLines(core: OpenACPCore): string {
  return core.proxyService.status().diagnostics
    .map((item) => `${item.scope}: ${item.route} (from ${item.resolvedFrom})${item.warning ? ` ⚠️ ${item.warning}` : ''}`)
    .join('\n')
}

function parsedRevision(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function stalePolicyResponse(reopen: string): CommandResponse {
  return {
    type: 'menu',
    title: '⚠️ Proxy policy changed since this menu was opened. No changes were made.',
    options: [{ label: 'Refresh', command: reopen }, { label: 'Proxy menu', command: '/proxy status' }],
  }
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
      const mutations = new Set([
        'add', 'edit', 'import', 'delete', 'delete-confirm', 'set', 'clear',
        'wizard-field', 'wizard-input', 'wizard-protocols', 'wizard-protocol',
        'wizard-fail-closed', 'wizard-clear-credentials', 'wizard-test',
        'wizard-save', 'wizard-cancel', 'wizard-create-mode', 'wizard-default-port', 'wizard-auth',
        'wizard-review',
      ])
      if (action && mutations.has(action) && !(await canManageProxy(core, args))) {
        return { type: 'error', message: 'This action requires network:proxy:manage capability.' }
      }
      if (!action || action === 'status') {
        return {
          type: 'menu',
          title: '🌐 Proxy management',
          options: [
            { label: 'Profiles', command: '/proxy profiles' },
            { label: 'Routing', command: '/proxy routing' },
            { label: 'Diagnostics', command: '/proxy diagnostics' },
            { label: 'Help', command: '/proxy help' },
          ],
        } satisfies CommandResponse
      }
      if (action === 'routing') {
        const revision = core.proxyService.status().revision
        return { type: 'menu', title: 'Proxy management › Routing', options: [
          { label: 'Global default route', command: `/proxy scope global ${revision} 0` },
          { label: 'Routes by category', command: `/proxy categories ${revision}` },
          { label: 'Routing matrix', command: '/proxy routes' },
          { label: 'Back', command: '/proxy status' },
        ] }
      }
      if (action === 'diagnostics') {
        return { type: 'menu', title: 'Proxy management › Diagnostics', options: [
          { label: 'Test Telegram transport', command: '/proxy test channels.telegram' },
          { label: 'Test Codex transport', command: '/proxy test agents.codex' },
          { label: 'Refresh status', command: '/proxy routes' },
          { label: 'Back', command: '/proxy status' },
        ] }
      }
      if (action === 'help') {
        return { type: 'text', text: 'Profiles contain proxy endpoints and optional write-only credentials. Routes assign profiles to channels, ACP agents, or services. Create a profile first, test it, save it, then assign it under Routing.' }
      }
      if (action === 'profiles') {
        const profiles = core.proxyService.listProfiles()
        const canManage = await canManageProxy(core, args)
        if (!profiles.length) return canManage
          ? { type: 'menu', title: 'Proxy management › Profiles\nNo proxy profiles configured.', options: [{ label: 'Create profile', command: '/proxy add' }, { label: 'Back', command: '/proxy status' }] } satisfies CommandResponse
          : { type: 'text', text: 'No proxy profiles configured.' } satisfies CommandResponse
        const page = Math.max(0, Number(rest[0] ?? 0) || 0); const start = page * 8
        return {
          type: 'menu',
          title: 'Proxy management › Profiles',
          options: [...(canManage ? [{ label: 'Create profile', command: '/proxy add' }] : []), ...profiles.slice(start, start + 8).map((p) => ({
            label: `${p.name} (${p.protocol}://${p.host}:${p.port})`,
            command: `/proxy profile ${p.id}`,
          })), ...(page > 0 ? [{ label: 'Previous', command: `/proxy profiles ${page - 1}` }] : []), ...(start + 8 < profiles.length ? [{ label: 'Next', command: `/proxy profiles ${page + 1}` }] : []), { label: 'Back', command: '/proxy status' }],
        } satisfies CommandResponse
      }
      if (action === 'add') {
        const draft: ProxyDraft = {
          id: randomUUID(), owner: interactionOwner(args), mode: 'add',
          baseRevision: core.proxyService.status().revision,
          expiresAt: Date.now() + DRAFT_TTL_MS,
          input: { failClosed: true }, tested: false,
        }
        storeDraft(draft)
        return inputResponse(draft, 'name', 'Profiles › Create new proxy profile — step 1/6\nEnter a human-readable profile name (for example “US office proxy”). A unique technical ID will be generated automatically.', args)
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
          id: 'Advanced: enter a canonical profile ID (letters, numbers, dot, underscore, dash; max 64). This is normally generated from the name.',
          name: 'Enter a human-readable profile name.',
          proxyUrl: 'Profiles › Create new proxy profile — Quick setup\nPaste the full proxy URL including an explicit port. This reply is treated as sensitive and deleted before parsing.',
          host: 'Profiles › Create new proxy profile — step 3/6\nEnter the proxy DNS name, IPv4 address, or bracketed IPv6 address without scheme or port.',
          port: 'Enter proxy port (1-65535).', username: 'Enter username. The message will be deleted before use.',
          password: 'Enter password. The message will be deleted before use.',
          noProxy: 'Enter comma-separated NO_PROXY hosts (use - for an empty list).',
        }
        if (!field || !prompts[field]) return { type: 'error', message: 'Unknown profile field.' }
        return inputResponse(draft, field, prompts[field], args, field === 'username' || field === 'password' || field === 'proxyUrl')
      }
      if (action === 'wizard-create-mode') {
        const draft = getDraft(rest[0], args)
        if (!draft || draft.mode !== 'add') return { type: 'error', message: 'Create draft expired or unauthorized.' }
        if (rest[1] === 'quick') return inputResponse(draft, 'proxyUrl', 'Profiles › Create new proxy profile — Quick setup\nPaste http://, https://, socks5://, or socks5h:// URL with an explicit port. Credentials may be included and stay write-only.', args, true)
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
            return { type: 'menu', title: `Profiles › Create new proxy profile — step 2/6\nName: ${draft.input.name}\nGenerated ID: ${draft.input.id}\nChoose setup mode.`, options: [
              { label: 'Quick: paste proxy URL', command: `/proxy wizard-create-mode ${draft.id} quick` },
              { label: 'Manual endpoint setup', command: `/proxy wizard-create-mode ${draft.id} manual` },
              { label: 'Advanced: change ID', command: `/proxy wizard-field ${draft.id} id` },
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
        return inputResponse(draft, 'host', `Profiles › ${draft.mode === 'add' ? 'Create new proxy profile — step 3/6' : `Edit ${draft.input.name ?? draft.input.id} — endpoint host`}\nEnter the proxy DNS name, IPv4 address, or bracketed IPv6 address without scheme or port.`, args)
      }
      if (action === 'wizard-review') {
        const draft = getDraft(rest[0], args)
        if (!draft) return { type: 'error', message: 'Draft expired or unauthorized.' }
        return draftPreview(draft)
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
          title: `❌ Candidate test failed: ${result.error ?? 'unknown error'}\nNo profile was saved and no active route changed.`,
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
        if (!draft.tested) return { type: 'error', message: 'Test the candidate successfully before saving.' }
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
        return { type: 'menu', title: `✅ Saved ${profile.name} (${profile.protocol}://${profile.host}:${profile.port}). Credentials remain write-only.`, options: [{ label: 'Open profile', command: `/proxy profile ${profile.id}` }, { label: 'Profiles', command: '/proxy profiles' }] }
      }
      if (action === 'wizard-cancel') {
        const draft = getDraft(rest[0], args)
        if (draft) drafts.delete(draft.id)
        return { type: 'text', text: 'Proxy profile draft discarded.' }
      }
      if (action === 'profile') {
        const id = rest[0]
        const profile = id ? core.proxyService.getProfile(id) : undefined
        if (!profile) return { type: 'error', message: 'Profile not found.' } satisfies CommandResponse
        const canManage = await canManageProxy(core, args)
        const revision = core.proxyService.status().revision
        return {
          type: 'menu',
          title: `${profile.name}: ${profile.protocol}://${profile.host}:${profile.port}\nCredentials: ${profile.hasCredentials ? 'configured' : 'none'} · failClosed: ${profile.failClosed}`,
          options: [
            { label: 'Test current profile', command: `/proxy test-profile ${profile.id}` },
            ...(canManage ? [
              { label: 'Edit endpoint or credentials', command: `/proxy edit ${profile.id}` },
              { label: 'Replace from protected env file', command: `/proxy import-help ${profile.id}` },
              { label: 'Delete profile', command: `/proxy delete ${profile.id} ${revision} 0` },
            ] : []),
            { label: 'Back to profiles', command: '/proxy profiles' },
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
            title: `Profile ${id} is used by ${usedBy.join(', ')}. Choose one route for atomic reassignment and deletion.`,
            options: [
              { label: 'Cancel', command: `/proxy profile ${id}` },
              { label: 'Reassign to direct', command: `/proxy delete-confirm ${id} ${baseRevision} direct` },
              { label: 'Reassign to inherit', command: `/proxy delete-confirm ${id} ${baseRevision} inherit` },
              ...alternatives.slice(start, start + 6).map((profile) => ({ label: `Reassign to ${profile.name}`, command: `/proxy delete-confirm ${id} ${baseRevision} profile:${profile.id}` })),
              ...(page > 0 ? [{ label: 'Previous replacements', command: `/proxy delete ${id} ${baseRevision} ${page - 1}` }] : []),
              ...(start + 6 < alternatives.length ? [{ label: 'Next replacements', command: `/proxy delete ${id} ${baseRevision} ${page + 1}` }] : []),
            ],
          }
        }
        return {
          type: 'menu', title: `Delete proxy profile ${id}?`,
          options: [
            { label: 'Cancel', command: '/proxy profiles' },
            { label: 'Confirm delete', command: `/proxy delete-confirm ${id} ${baseRevision}` },
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
          throw error
        }
        return { type: 'text', text: `✅ Deleted proxy profile ${id}.${result.reassignedScopes.length ? ` Reassigned: ${result.reassignedScopes.join(', ')}.` : ''}` } satisfies CommandResponse
      }
      if (action === 'routes') {
        return { type: 'text', text: routeLines(core) } satisfies CommandResponse
      }
      if (action === 'categories') {
        const baseRevision = parsedRevision(rest[0]) ?? core.proxyService.status().revision
        const categories = [...new Set(core.proxyService.getKnownScopes().map((s) => s.split('.')[0]))]
        return { type: 'menu', title: 'Proxy routing categories', options: [
          ...categories.map((category) => ({ label: category, command: `/proxy category ${category} ${baseRevision} 0` })),
          { label: 'Back', command: '/proxy status' },
        ] } satisfies CommandResponse
      }
      if (action === 'category') {
        const category = rest[0]
        const scopes = core.proxyService.getKnownScopes().filter((s) => s.startsWith(`${category}.`))
        if (!category || !scopes.length) return { type: 'error', message: 'Proxy category not found.' }
        const baseRevision = parsedRevision(rest[1]) ?? core.proxyService.status().revision
        const page = Math.max(0, Number(rest[2] ?? 0) || 0); const start = page * 8
        return { type: 'menu', title: `${category} routes`, options: [
          ...scopes.slice(start, start + 8).map((scope) => { const r = core.proxyService.resolve(scope); return { label: `${scope} → ${r.route}`, command: `/proxy scope ${scope} ${baseRevision} 0` } }),
          ...(page > 0 ? [{ label: 'Previous', command: `/proxy category ${category} ${baseRevision} ${page - 1}` }] : []),
          ...(start + 8 < scopes.length ? [{ label: 'Next', command: `/proxy category ${category} ${baseRevision} ${page + 1}` }] : []),
          { label: 'Back', command: `/proxy categories ${baseRevision}` },
        ] } satisfies CommandResponse
      }
      if (action === 'scope') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy scope <scope>' } satisfies CommandResponse
        const current = core.proxyService.resolve(scope)
        const profiles = core.proxyService.listProfiles()
        const baseRevision = parsedRevision(rest[1]) ?? core.proxyService.status().revision
        const page = Math.max(0, Number(rest[2] ?? 0) || 0); const start = page * 6
        return {
          type: 'menu',
          title: `${scope}: ${current.route}`,
          options: [
            { label: 'Direct', command: `/proxy set ${scope} direct ${baseRevision}` },
            { label: 'Inherit host', command: `/proxy set ${scope} inherit ${baseRevision}` },
            ...profiles.slice(start, start + 6).map((p) => ({ label: p.name, command: `/proxy set ${scope} profile:${p.id} ${baseRevision}` })),
            ...(page > 0 ? [{ label: 'Previous profiles', command: `/proxy scope ${scope} ${baseRevision} ${page - 1}` }] : []),
            ...(start + 6 < profiles.length ? [{ label: 'Next profiles', command: `/proxy scope ${scope} ${baseRevision} ${page + 1}` }] : []),
            { label: 'Clear override', command: `/proxy clear ${scope} ${baseRevision}` },
            { label: 'Test current route', command: `/proxy test ${scope}` },
            { label: 'Back', command: scope === 'global' ? '/proxy status' : `/proxy category ${scope.split('.')[0]} ${baseRevision} 0` },
          ],
        } satisfies CommandResponse
      }
      if (action === 'set') {
        const [scope, route, revisionRaw] = rest
        if (!scope || !route) return { type: 'error', message: 'Usage: /proxy set <scope> <direct|inherit|profile:id>' } satisfies CommandResponse
        let change
        try { change = await core.proxyService.setRoute(scope, route as ProxyRoute, parsedRevision(revisionRaw)) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy scope ${scope}`)
          throw error
        }
        const note = change.activeAgentProcessesUnaffected
          ? '\nNew ACP processes will use this route; active sessions were not restarted. The idle warm pool was rebuilt.'
          : ''
        return { type: 'text', text: `✅ ${scope} → ${route}${note}` } satisfies CommandResponse
      }
      if (action === 'clear') {
        const scope = rest[0]
        if (!scope) return { type: 'error', message: 'Usage: /proxy clear <scope|global>' }
        try { await core.proxyService.clearRoute(scope, parsedRevision(rest[1])) }
        catch (error) {
          if (error instanceof ProxyRevisionConflictError) return stalePolicyResponse(`/proxy scope ${scope}`)
          throw error
        }
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
  const identity = core.lifecycleManager?.serviceRegistry?.get<IdentityService>('identity')
  if (!identity) return false
  const user = await identity.getUserByIdentity(formatIdentityId(args.channelId, args.userId))
  return Boolean(user && hasIdentityCapability(user.role, 'network:proxy:manage'))
}
