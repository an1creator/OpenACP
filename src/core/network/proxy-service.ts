import { ProxyAgent } from 'proxy-agent'
import nodeFetch, { type RequestInit as NodeFetchInit } from 'node-fetch'
import type {
  ProxyProfile,
  ProxyProfileInput,
  ProxyRoute,
  ProxyRouteChangeResult,
  ProxyRouteResolution,
  ProxyStatus,
} from './proxy-types.js'
import { PROXY_PROTOCOLS } from './proxy-types.js'
import { ProxyStore } from './proxy-store.js'
import { ProxyRevisionConflictError, ProxyStoreCorruptError, isProxyScope, type SecretRecord, type StoredProxyConfig } from './proxy-store.js'
import fs from 'node:fs'
import { redactNetworkSecrets, sanitizeProxyDebugNamespaces } from '../security/network-redaction.js'
import net from 'node:net'
import { Readable } from 'node:stream'
import debug from 'debug'

// proxy-agent uses the `debug` package directly and bypasses pino hooks. Remove
// only credential-risk proxy namespaces while preserving unrelated diagnostics.
const enabledDebug = debug.disable()
debug.enable(sanitizeProxyDebugNamespaces(enabledDebug) ?? '')

const PROXY_ENV_KEYS = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'NODE_USE_ENV_PROXY',
] as const

type RouteTester = (fetcher: typeof fetch) => Promise<void>
type RouteChangedListener = (scope: string, route: ProxyRoute) => void | Promise<void>
type ManagedFetch = typeof fetch & { destroy?: () => void }
interface TransportEntry {
  key: string
  fetcher: ManagedFetch
  active: number
  retired: boolean
  destroyed: boolean
  leases: Set<(reason: Error) => void>
  retirementTimer?: ReturnType<typeof setTimeout>
}

export class ProxyValidationError extends Error {
  constructor(message: string, readonly code: string = 'PROXY_VALIDATION_ERROR') { super(message); this.name = 'ProxyValidationError' }
}
export class ProxyUnknownScopeError extends ProxyValidationError {
  constructor(scope: string) { super(`Proxy scope "${scope}" is not registered`, 'PROXY_UNKNOWN_SCOPE') }
}
export class ProxyProfileInUseError extends ProxyValidationError {
  constructor(id: string) { super(`Proxy profile "${id}" is still used by routing`, 'PROXY_PROFILE_IN_USE') }
}

export class ProxyRouteTestError extends Error {
  readonly code = 'PROXY_ROUTE_TEST_FAILED'
  constructor(scope: string, cause: unknown) {
    const reason = safeError(cause).message
    super(`Proxy route test failed for ${scope}; route was not changed: ${reason}`)
    this.name = 'ProxyRouteTestError'
  }
}

export class ProxyProfileTestError extends Error {
  readonly code = 'PROXY_PROFILE_TEST_FAILED'
  constructor(profileId: string, cause: unknown) {
    const reason = safeError(cause).message
    super(`Proxy profile test failed for ${profileId}; profile was not changed: ${reason}`)
    this.name = 'ProxyProfileTestError'
  }
}

function validateId(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value)) throw new ProxyValidationError(`Invalid ${label}: ${value}`)
}

function canonicalHost(input: string): string {
  if (!input || /[\u0000-\u001f\u007f\s/@?#]/.test(input)) throw new ProxyValidationError('Proxy host must be a DNS name, IPv4, or bracketed IPv6 without URL components')
  if (input.includes(':')) {
    if (!(input.startsWith('[') && input.endsWith(']')) || net.isIP(input.slice(1, -1)) !== 6) throw new ProxyValidationError('IPv6 proxy hosts must be bracketed and must not include a port')
    return input.slice(1, -1).toLowerCase()
  }
  if (net.isIP(input) === 4) return input
  const host = input.toLowerCase().replace(/\.$/, '')
  if (host.length > 253 || !host.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) throw new ProxyValidationError('Invalid proxy DNS host')
  return host
}

function categoryDefault(scope: string): string | undefined {
  const dot = scope.indexOf('.')
  return dot > 0 ? `${scope.slice(0, dot)}.default` : undefined
}

function routeProfileId(route: ProxyRoute): string | undefined {
  return route.startsWith('profile:') ? route.slice('profile:'.length) : undefined
}

function proxyUrl(profile: ProxyProfile, secret?: { username?: string; password?: string }): string {
  const host = net.isIP(profile.host) === 6 ? `[${profile.host}]` : profile.host
  const url = new URL(`${profile.protocol}://${host}:${profile.port}`)
  const username = secret?.username
  if (username) url.username = username
  if (secret?.password) url.password = secret.password
  return url.toString()
}

function shouldBypassProxy(target: string, noProxy: string[]): boolean {
  const url = new URL(target)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const hostAndPort = `${net.isIP(host) === 6 ? `[${host}]` : host}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  return noProxy.some((raw) => {
    const pattern = raw.trim().toLowerCase()
    if (!pattern) return false
    if (pattern === '*') return true
    if (pattern.replace(/^\[|\]$/g, '') === host) return true
    if ((pattern.startsWith('[') && pattern.includes(']:')) || (pattern.includes(':') && net.isIP(pattern) !== 6)) return hostAndPort === pattern
    const normalized = pattern.startsWith('*.') ? pattern.slice(1) : pattern
    return host === normalized.replace(/^\./, '') || (normalized.startsWith('.') && host.endsWith(normalized))
  })
}

function safeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'Proxy request failed'
  return new Error(redactNetworkSecrets(message))
}

/** Scoped network policy. It never mutates process.env or a global fetch dispatcher. */
export class ProxyService {
  private readonly store: ProxyStore
  private readonly scopes = new Set([
    'channels.default', 'channels.telegram',
    'agents.default', 'agents.codex', 'agents.cursor',
    'services.default', 'services.npmUpdate', 'services.agentRegistry',
    'services.pluginInstaller', 'services.speechDownloads',
    'plugins.default',
  ])
  private readonly testers = new Map<string, RouteTester>()
  private readonly listeners = new Set<RouteChangedListener>()
  private readonly transports = new Map<string, TransportEntry>()
  private readonly facades = new Map<string, typeof fetch>()
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private policyGeneration = 0
  private readonly maxTransports = 128

  constructor(instanceRoot: string, private readonly retiredLeaseTimeoutMs = 5 * 60_000) {
    this.store = new ProxyStore(instanceRoot)
    try {
      const config = this.store.load()
      for (const scope of [...config.persistedScopes, ...Object.keys(config.routing.routes)]) this.scopes.add(scope)
    } catch { /* consumers fail closed when they resolve; doctor reports corruption */ }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(operation, operation)
    this.mutationQueue = next.then(() => undefined, () => undefined)
    return next
  }

  getPolicyGeneration(): number { return this.policyGeneration }
  private invalidatePolicyBeforeCommit(config: StoredProxyConfig, affectedProfile?: string, changedScope?: string): boolean {
    const agentAffected = changedScope === 'global' || changedScope === 'agents.default' || Boolean(changedScope?.startsWith('agents.'))
      || Boolean(affectedProfile && Object.entries(config.routing.routes).some(([scope, route]) => scope.startsWith('agents.') && route === `profile:${affectedProfile}`))
      || Boolean(affectedProfile && config.routing.global === `profile:${affectedProfile}`)
    if (agentAffected) this.policyGeneration++
    return agentAffected
  }

  registerScope(scope: string): () => void {
    if (!isProxyScope(scope)) throw new ProxyValidationError(`Invalid proxy scope: ${scope}`)
    this.scopes.add(scope)
    this.persistScope(scope)
    return () => this.scopes.delete(scope)
  }

  registerRouteTester(scope: string, tester: RouteTester): () => void {
    this.registerScope(scope)
    this.testers.set(scope, tester)
    return () => this.testers.delete(scope)
  }

  /**
   * Scope discovery is part of the durable policy schema, not only an in-memory
   * UI concern. Persisting registrations lets an operator configure a plugin or
   * agent while it is temporarily disabled and keeps the category list stable
   * across daemon restarts.
   */
  private persistScope(scope: string): void {
    const config = this.store.load()
    if (config.persistedScopes.includes(scope)) return
    config.persistedScopes = [...config.persistedScopes, scope].sort()
    this.store.commit(config, this.store.getSecrets(), config.revision)
  }

  onRouteChanged(listener: RouteChangedListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  listProfiles(): ProxyProfile[] {
    return this.store.load().profiles.map((profile) => ({ ...profile }))
  }

  getProfile(id: string): ProxyProfile | undefined {
    return this.listProfiles().find((profile) => profile.id === id)
  }

  saveProfile(input: ProxyProfileInput): ProxyProfile {
    const config = this.store.load(); const secrets = this.store.getSecrets()
    const { profile, nextSecrets } = this.buildProfile(input, config, secrets)
    const affectedScopes = this.scopesUsingProfile(config, input.id)
    this.invalidatePolicyBeforeCommit(config, input.id)
    config.profiles = [...config.profiles.filter((p) => p.id !== profile.id), profile]
    config.persistedScopes = [...new Set([...config.persistedScopes, ...Object.keys(config.routing.routes)])]
    this.store.commit(config, nextSecrets, config.revision)
    this.retireScopes(affectedScopes)
    return profile
  }

  private buildProfile(input: ProxyProfileInput, config: StoredProxyConfig, secrets: Record<string, SecretRecord>): { profile: ProxyProfile; nextSecrets: Record<string, SecretRecord> } {
    validateId(input.id, 'profile id')
    if (!PROXY_PROTOCOLS.includes(input.protocol)) throw new ProxyValidationError(`Unsupported proxy protocol: ${input.protocol}`)
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new ProxyValidationError('Proxy port must be between 1 and 65535')
    const host = canonicalHost(input.host)
    const existing = config.profiles.find((p) => p.id === input.id)
    const nextSecrets = structuredClone(secrets)
    if (input.username !== undefined || input.password !== undefined) nextSecrets[input.id] = { username: input.username ?? nextSecrets[input.id]?.username, password: input.password ?? nextSecrets[input.id]?.password }
    const secret = nextSecrets[input.id]
    return { profile: {
      id: input.id, name: input.name ?? existing?.name ?? input.id, protocol: input.protocol, host, port: input.port,
      noProxy: input.noProxy ?? existing?.noProxy ?? ['localhost', '127.0.0.1', '::1'], failClosed: input.failClosed ?? existing?.failClosed ?? true,
      hasCredentials: Boolean(secret?.username || secret?.password),
    }, nextSecrets }
  }

  async saveProfileSafely(input: ProxyProfileInput, expectedRevision?: number): Promise<ProxyProfile> {
    return this.serialize(async () => {
    const config = this.store.load(); const secrets = this.store.getSecrets()
    if (expectedRevision !== undefined && config.revision !== expectedRevision) throw new ProxyRevisionConflictError(expectedRevision, config.revision)
    const { profile: candidate, nextSecrets } = this.buildProfile(input, config, secrets)
    const affectedScopes = this.scopesUsingProfile(config, input.id)
    const candidateSecret = nextSecrets[input.id]
    // Test the candidate entirely in memory. The active profile and Telegram
    // transport remain untouched until all protected scopes accept it.
    for (const [scope, tester] of this.testers) {
      if (this.resolve(scope).profile?.id === input.id) {
        const fetcher = this.createProfileFetch(candidate, candidateSecret)
        try {
          await tester(fetcher)
        } catch (error) {
          throw new ProxyProfileTestError(input.id, error)
        } finally {
          fetcher.destroy?.()
        }
      }
    }
    this.invalidatePolicyBeforeCommit(config, input.id)
    config.profiles = [...config.profiles.filter((p) => p.id !== candidate.id), candidate]
    const saved = this.store.commit(config, nextSecrets, config.revision).profiles.find((p) => p.id === candidate.id)!
    this.retireScopes(affectedScopes)
    return saved
    })
  }

  /** Import a conventional proxy env file without ever returning or logging its credential URL. */
  importEnvFile(id: string, envFile: string, name?: string): ProxyProfile {
    return this.saveProfile(this.parseEnvFile(id, envFile, name))
  }

  private parseEnvFile(id: string, envFile: string, name?: string): ProxyProfileInput {
    const stat = fs.statSync(envFile)
    if (!stat.isFile()) throw new Error('Proxy env path is not a file')
    if ((stat.mode & 0o077) !== 0) throw new Error('Proxy env file must have mode 0600')
    const values: Record<string, string> = {}
    for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
      if (!match) continue
      let value = match[2].trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
      values[match[1]] = value
    }
    const httpUrl = values.HTTP_PROXY ?? values.http_proxy
    const httpsUrl = values.HTTPS_PROXY ?? values.https_proxy
    if (httpUrl && httpsUrl && httpUrl !== httpsUrl) throw new ProxyValidationError('HTTP_PROXY and HTTPS_PROXY differ; use one canonical proxy URL or create separate profiles')
    const rawUrl = httpsUrl ?? httpUrl ?? values.ALL_PROXY ?? values.all_proxy
    if (!rawUrl) throw new Error('No proxy URL found in env file')
    let url: URL
    try { url = new URL(rawUrl) } catch { throw new ProxyValidationError('Proxy env contains an invalid URL') }
    const protocol = url.protocol.slice(0, -1)
    if (!PROXY_PROTOCOLS.includes(protocol as typeof PROXY_PROTOCOLS[number])) throw new ProxyValidationError(`Unsupported proxy protocol: ${protocol}`)
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new ProxyValidationError('Proxy URL must not contain path, query, or fragment')
    const noProxy = values.NO_PROXY ?? values.no_proxy
    return {
      id,
      name,
      protocol: protocol as ProxyProfile['protocol'],
      // WHATWG URL keeps IPv6 hostnames bracketed. Preserve that canonical
      // input form here; buildProfile performs the single host normalization.
      host: url.hostname,
      port: Number(url.port || (protocol.startsWith('socks') ? 1080 : protocol === 'https' ? 443 : 80)),
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      noProxy: noProxy ? noProxy.split(',').map((item) => item.trim()).filter(Boolean) : undefined,
    }
  }

  async importEnvFileSafely(id: string, envFile: string, name?: string, expectedRevision?: number): Promise<ProxyProfile> {
    return this.saveProfileSafely(this.parseEnvFile(id, envFile, name), expectedRevision)
  }

  async deleteProfile(id: string, expectedRevision?: number): Promise<void> {
    return this.serialize(async () => {
    const config = this.store.load(); const secrets = this.store.getSecrets()
    if (expectedRevision !== undefined && config.revision !== expectedRevision) throw new ProxyRevisionConflictError(expectedRevision, config.revision)
    if (!config.profiles.some((p) => p.id === id)) throw new ProxyValidationError(`Proxy profile "${id}" does not exist`)
    if (Object.values(config.routing.routes).includes(`profile:${id}`) || config.routing.global === `profile:${id}`) throw new ProxyProfileInUseError(id)
    config.profiles = config.profiles.filter((p) => p.id !== id); delete secrets[id]
    this.store.commit(config, secrets, config.revision)
    })
  }

  resolve(scope: string, routeOverride?: ProxyRoute): ProxyRouteResolution {
    const config = this.store.load()
    return this.resolveFromConfig(scope, config, routeOverride)
  }

  private resolveFromConfig(scope: string, config: ReturnType<ProxyStore['load']>, routeOverride?: ProxyRoute): ProxyRouteResolution {
    const exact = routeOverride ?? config.routing.routes[scope]
    const category = categoryDefault(scope)
    const route = exact ?? (category ? config.routing.routes[category] : undefined) ?? config.routing.global
    const resolvedFrom = routeOverride ? 'candidate' : exact ? scope : category && config.routing.routes[category] ? category : 'global'
    const id = routeProfileId(route)
    const profile = id ? config.profiles.find((item) => item.id === id) : undefined
    if (id && !profile) throw new Error(`Proxy profile "${id}" does not exist`)
    return { scope, route, resolvedFrom, profile }
  }

  async setRoute(scope: string, route: ProxyRoute, expectedRevision?: number): Promise<ProxyRouteChangeResult> {
    return this.serialize(async () => {
    if (scope !== 'global' && !this.getKnownScopes().includes(scope)) throw new ProxyUnknownScopeError(scope)
    this.validateRoute(route)
    const config = this.store.load()
    if (expectedRevision !== undefined && config.revision !== expectedRevision) throw new ProxyRevisionConflictError(expectedRevision, config.revision)
    const candidate = structuredClone(config)
    if (scope === 'global') candidate.routing.global = route
    else candidate.routing.routes[scope] = route
    const affectedScopes = this.changedResolutionScopes(config, candidate)
    try {
      await this.testCandidateRoutes(config, candidate)
    } catch (error) {
      throw new ProxyRouteTestError(scope, error)
    }
    const affectsAgents = this.invalidatePolicyBeforeCommit(config, undefined, scope)
    candidate.persistedScopes = [...new Set([...candidate.persistedScopes, ...(scope === 'global' ? [] : [scope])])]
    this.store.commit(candidate, this.store.getSecrets(), config.revision)
    this.retireScopes(affectedScopes)
    for (const listener of this.listeners) await listener(scope, route)
    return {
      scope,
      route,
      warmPoolInvalidated: affectsAgents,
      activeAgentProcessesUnaffected: affectsAgents,
    }
    })
  }

  async clearRoute(scope: string, expectedRevision?: number): Promise<void> {
    return this.serialize(async () => {
    const config = this.store.load()
    if (expectedRevision !== undefined && config.revision !== expectedRevision) throw new ProxyRevisionConflictError(expectedRevision, config.revision)
    const candidate = structuredClone(config)
    if (scope === 'global') candidate.routing.global = 'inherit'
    else {
      if (!this.getKnownScopes().includes(scope)) throw new ProxyUnknownScopeError(scope)
      delete candidate.routing.routes[scope]
    }
    const affectedScopes = this.changedResolutionScopes(config, candidate)
    try {
      await this.testCandidateRoutes(config, candidate)
    } catch (error) {
      throw new ProxyRouteTestError(scope, error)
    }
    this.invalidatePolicyBeforeCommit(config, undefined, scope)
    this.store.commit(candidate, this.store.getSecrets(), config.revision)
    this.retireScopes(affectedScopes)
    for (const listener of this.listeners) await listener(scope, this.resolve(scope).route)
    })
  }

  getKnownScopes(): string[] {
    const config = this.store.load()
    return [...new Set([...this.scopes, ...config.persistedScopes, ...Object.keys(config.routing.routes)])].sort()
  }

  createFetch(scope: string, routeOverride?: ProxyRoute): typeof fetch {
    if (routeOverride) return this.createTransport(scope, routeOverride)
    if (!this.getKnownScopes().includes(scope)) throw new ProxyUnknownScopeError(scope)
    const existing = this.facades.get(scope)
    if (existing) return existing
    const facade = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const entry = this.acquireTransport(scope)
      try {
        const response = await entry.fetcher(input, init)
        return this.releaseWithResponse(response, entry)
      } catch (error) {
        this.releaseTransport(entry)
        throw error
      }
    }) as typeof fetch
    this.facades.set(scope, facade)
    return facade
  }

  private createTransport(scope: string, routeOverride?: ProxyRoute): ManagedFetch {
    const resolution = this.resolve(scope, routeOverride)
    const cacheKey = JSON.stringify({
      route: resolution.route,
      profile: resolution.profile,
      inherited: resolution.route === 'inherit'
        ? [process.env.HTTP_PROXY, process.env.HTTPS_PROXY, process.env.ALL_PROXY, process.env.NO_PROXY]
        : undefined,
    })
    if (!routeOverride) {
      const cached = this.transports.get(scope)
      if (cached?.key === cacheKey) return cached.fetcher
    }
    if (resolution.route === 'direct') {
      const fetcher = this.createDirectFetch()
      if (!routeOverride) this.cacheTransport(scope, cacheKey, fetcher)
      return fetcher
    }
    let agent: ProxyAgent
    if (resolution.route === 'inherit') {
      const hasInheritedProxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy
      if (!hasInheritedProxy) {
        const fetcher = this.createDirectFetch()
        if (!routeOverride) this.cacheTransport(scope, cacheKey, fetcher)
        return fetcher
      }
      // ProxyAgent's default resolver honors the host's HTTP(S)_PROXY and NO_PROXY.
      agent = new ProxyAgent()
    } else if (resolution.profile) {
      const fetcher = this.createProfileFetch(resolution.profile, this.store.getSecret(resolution.profile.id))
      if (!routeOverride) this.cacheTransport(scope, cacheKey, fetcher)
      return fetcher
    } else {
      return globalThis.fetch.bind(globalThis)
    }
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const response = await fetchThroughAgent(input, init, agent)
        return normalizeResponse(response)
      } catch (error) {
        if (resolution.profile?.failClosed !== false) throw safeError(error)
        return globalThis.fetch(input, init)
      }
    }) as ManagedFetch
    fetcher.destroy = () => agent.destroy?.()
    if (!routeOverride) this.cacheTransport(scope, cacheKey, fetcher)
    return fetcher
  }

  private cacheTransport(scope: string, key: string, fetcher: ManagedFetch): void {
    const old = this.transports.get(scope)
    if (old && old.fetcher !== fetcher) this.retireTransport(old)
    this.transports.set(scope, { key, fetcher, active: 0, retired: false, destroyed: false, leases: new Set() })
    while (this.transports.size > this.maxTransports) {
      const oldest = this.transports.keys().next().value as string | undefined
      if (!oldest) break
      const entry = this.transports.get(oldest)
      if (entry) this.retireTransport(entry)
      this.transports.delete(oldest)
    }
  }

  buildAgentEnv(agentName: string, inherited: Record<string, string>): Record<string, string> {
    return this.buildChildEnv(`agents.${agentName}`, inherited)
  }

  buildChildEnv(scope: string, inherited: Record<string, string>): Record<string, string> {
    const resolution = this.resolve(scope)
    const env = { ...inherited }
    if (env.DEBUG) {
      const safeDebug = sanitizeProxyDebugNamespaces(env.DEBUG)
      if (safeDebug) env.DEBUG = safeDebug
      else delete env.DEBUG
    }
    if (resolution.route === 'inherit') return env
    for (const key of PROXY_ENV_KEYS) delete env[key]
    // Remove only the proxy-specific flag from NODE_OPTIONS while preserving unrelated flags.
    if (env.NODE_OPTIONS) {
      env.NODE_OPTIONS = env.NODE_OPTIONS.split(/\s+/).filter((flag) => flag !== '--use-env-proxy').join(' ')
      if (!env.NODE_OPTIONS) delete env.NODE_OPTIONS
    }
    if (resolution.route === 'direct') {
      // Explicit false sentinel prevents Node-based wrappers from treating a
      // daemon-wide NODE_USE_ENV_PROXY=1 as inherited policy.
      env.NODE_USE_ENV_PROXY = '0'
      return env
    }
    const profile = resolution.profile!
    const url = proxyUrl(profile, this.store.getSecret(profile.id))
    const noProxy = profile.noProxy.join(',')
    if (profile.protocol === 'http' || profile.protocol === 'https') {
      env.HTTP_PROXY = env.http_proxy = url
      env.HTTPS_PROXY = env.https_proxy = url
      env.NODE_USE_ENV_PROXY = '1'
      if (process.allowedNodeEnvironmentFlags.has('--use-env-proxy')) {
        env.NODE_OPTIONS = [env.NODE_OPTIONS, '--use-env-proxy'].filter(Boolean).join(' ')
      }
    } else {
      // SOCKS is standards-based via ALL_PROXY but support is agent-specific.
      // Diagnostics explicitly report this as best-effort; it is never presented as guaranteed.
      env.ALL_PROXY = env.all_proxy = url
    }
    env.NO_PROXY = env.no_proxy = noProxy
    return env
  }

  async test(scope: string, targetUrl = 'https://api.ipify.org?format=json'): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!this.getKnownScopes().includes(scope)) throw new ProxyUnknownScopeError(scope)
    let response: Response | undefined
    try {
      response = await this.createFetch(scope)(targetUrl, { signal: AbortSignal.timeout(10_000) })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? redactNetworkSecrets(error.message) : 'Proxy test failed' }
    } finally { try { await response?.body?.cancel() } catch {} }
  }

  async testProfile(id: string, targetUrl?: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!this.getProfile(id)) return { ok: false, error: `Proxy profile "${id}" does not exist` }
    let fetcher: ManagedFetch | undefined; let response: Response | undefined
    try {
      fetcher = this.createTransport('services.proxyTest', `profile:${id}`)
      response = await fetcher(targetUrl ?? 'https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(10_000),
      })
      return { ok: response.ok, status: response.status }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? redactNetworkSecrets(error.message) : 'Proxy test failed' }
    } finally { try { await response?.body?.cancel() } catch {}; fetcher?.destroy?.() }
  }

  status(): ProxyStatus {
    const config = this.store.load()
    const scopes = this.getKnownScopes()
    const daemonVariables = PROXY_ENV_KEYS.filter((key) => {
      const value = process.env[key]
      return !['NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'].includes(key) && value !== undefined && value !== ''
    })
    return {
      revision: config.revision,
      profiles: this.listProfiles(),
      routing: config.routing,
      scopes,
      diagnostics: scopes.map((scope) => {
        const resolution = this.resolve(scope)
        const child = scope.startsWith('agents.') || scope.startsWith('services.')
        const socks = child && Boolean(resolution.profile?.protocol.startsWith('socks'))
        return {
          scope,
          route: resolution.route,
          resolvedFrom: resolution.resolvedFrom,
          childProcessSupport: child ? (socks ? 'best-effort-socks-env' : 'native-env') : 'not-applicable',
          warning: socks ? 'SOCKS support depends on the child process honoring ALL_PROXY; npm and arbitrary ACP clients may require HTTP/HTTPS profiles.' : undefined,
        }
      }),
      environment: {
        daemonWideProxyActive: daemonVariables.length > 0,
        compatibilityMode: daemonVariables.length > 0,
        variables: daemonVariables,
        message: daemonVariables.length > 0
          ? 'Daemon-wide proxy environment is active. Scoped direct transports remain isolated, but category isolation is in compatibility mode until legacy wrapper/drop-in proxy injection is removed.'
          : 'No daemon-wide proxy environment detected; native scoped routing is authoritative.',
      },
    }
  }

  private validateRoute(route: ProxyRoute): void {
    if (route === 'direct' || route === 'inherit') return
    const id = routeProfileId(route)
    if (!id || !this.getProfile(id)) throw new ProxyValidationError(`Proxy profile "${id ?? route}" does not exist`)
  }

  private async testCandidateRoutes(
    current: ReturnType<ProxyStore['load']>,
    candidate: ReturnType<ProxyStore['load']>,
  ): Promise<void> {
    for (const [scope, tester] of this.testers) {
      const before = this.resolveFromConfig(scope, current)
      const after = this.resolveFromConfig(scope, candidate)
      if (before.route !== after.route || before.profile?.id !== after.profile?.id) {
        // Candidate route is passed explicitly; persistence happens only after this succeeds.
        const fetcher = this.createTransport(scope, after.route)
        try { await tester(fetcher) } finally { fetcher.destroy?.() }
      }
    }
  }

  private createProfileFetch(
    profile: ProxyProfile,
    secret?: { username?: string; password?: string },
  ): ManagedFetch {
    const url = proxyUrl(profile, secret)
    const agent = new ProxyAgent({
      getProxyForUrl: (target) => shouldBypassProxy(target, profile.noProxy) ? '' : url,
    })
    const directFallback = profile.failClosed === false ? this.createDirectFetch() : undefined
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      try {
        const response = await fetchThroughAgent(input, init, agent)
        return normalizeResponse(response)
      } catch (error) {
        if (profile.failClosed !== false) throw safeError(error)
        return directFallback!(input, init)
      }
    }) as ManagedFetch
    fetcher.destroy = () => {
      agent.destroy?.()
      directFallback?.destroy?.()
    }
    return fetcher
  }

  /** Direct transport that ignores daemon-wide env proxy flags without global mutation. */
  private createDirectFetch(): ManagedFetch {
    const agent = new ProxyAgent({ getProxyForUrl: () => '' })
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetchThroughAgent(input, init, agent)
      return normalizeResponse(response)
    }) as ManagedFetch
    fetcher.destroy = () => agent.destroy?.()
    return fetcher
  }

  private acquireTransport(scope: string): TransportEntry {
    this.createTransport(scope)
    const entry = this.transports.get(scope)!
    entry.active++
    return entry
  }

  private releaseTransport(entry: TransportEntry): void {
    entry.active = Math.max(0, entry.active - 1)
    if (entry.retired && entry.active === 0) this.destroyTransport(entry)
  }

  private retireTransport(entry: TransportEntry): void {
    entry.retired = true
    if (entry.active === 0) { this.destroyTransport(entry); return }
    if (!entry.retirementTimer) {
      entry.retirementTimer = setTimeout(() => {
        const reason = new Error('Retired proxy transport response exceeded its maximum lease')
        for (const abort of [...entry.leases]) abort(reason)
        this.destroyTransport(entry)
      }, this.retiredLeaseTimeoutMs)
      entry.retirementTimer.unref?.()
    }
  }

  private destroyTransport(entry: TransportEntry): void {
    if (entry.destroyed) return
    entry.destroyed = true
    if (entry.retirementTimer) clearTimeout(entry.retirementTimer)
    entry.fetcher.destroy?.()
  }

  private retireScopes(scopes: Iterable<string>): void {
    for (const scope of scopes) {
      const entry = this.transports.get(scope)
      if (!entry) continue
      this.transports.delete(scope)
      this.retireTransport(entry)
    }
  }

  private scopesUsingProfile(config: StoredProxyConfig, profileId: string): string[] {
    return this.allScopes(config).filter((scope) => this.resolveFromConfig(scope, config).profile?.id === profileId)
  }

  private changedResolutionScopes(before: StoredProxyConfig, after: StoredProxyConfig): string[] {
    return this.allScopes(before, after).filter((scope) => {
      const a = this.resolveFromConfig(scope, before); const b = this.resolveFromConfig(scope, after)
      return JSON.stringify([a.route, a.profile]) !== JSON.stringify([b.route, b.profile])
    })
  }

  private allScopes(...configs: StoredProxyConfig[]): string[] {
    return [...new Set([...this.scopes, ...configs.flatMap((config) => [...config.persistedScopes, ...Object.keys(config.routing.routes)])])]
  }

  private releaseWithResponse(response: Response, entry: TransportEntry): Response {
    const release = () => this.releaseTransport(entry)
    if (!response.body) { release(); return response }
    const reader = response.body.getReader(); let released = false
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined
    const done = () => {
      if (!released) {
        released = true
        entry.leases.delete(abort)
        release()
      }
    }
    const abort = (reason: Error) => {
      if (released) return
      try { bodyController?.error(reason) } catch {}
      void reader.cancel(reason).then(done, done)
    }
    entry.leases.add(abort)
    if (entry.destroyed) abort(new Error('Retired proxy transport response exceeded its maximum lease'))
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller },
      async pull(controller) {
        try {
          const chunk = await reader.read()
          if (chunk.done) { done(); controller.close() } else controller.enqueue(chunk.value)
        } catch (error) { done(); controller.error(error) }
      },
      async cancel(reason) { try { await reader.cancel(reason) } finally { done() } },
    })
    return copyResponse(response, body)
  }
}

function normalizeResponse(response: import('node-fetch').Response): Response {
  if (response instanceof Response) return response
  const body = response.body
    ? Readable.toWeb(response.body as unknown as Readable) as ReadableStream<Uint8Array>
    : null
  return copyResponse(response as unknown as Response, body)
}

async function fetchThroughAgent(input: RequestInfo | URL, init: RequestInit | undefined, agent: ProxyAgent): Promise<import('node-fetch').Response> {
  if (typeof ReadableStream !== 'undefined' && init?.body instanceof ReadableStream) {
    throw new ProxyValidationError('Web ReadableStream request bodies are not supported by scoped fetch; use string, URLSearchParams, Blob, or FormData')
  }
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const inherited: NodeFetchInit = {
      method: input.method,
      headers: Object.fromEntries(input.headers.entries()),
      redirect: input.redirect,
      signal: input.signal as NodeFetchInit['signal'],
    }
    if (!init?.body && input.method !== 'GET' && input.method !== 'HEAD') inherited.body = Buffer.from(await input.clone().arrayBuffer())
    return nodeFetch(input.url, { ...inherited, ...(init as NodeFetchInit), agent })
  }
  return nodeFetch(input as any, { ...(init as NodeFetchInit), agent })
}

function copyResponse(response: Response, body: ReadableStream<Uint8Array> | null): Response {
  const noBody = response.status === 101 || response.status === 204 || response.status === 205 || response.status === 304
  const copy = new Response(noBody ? null : body, { status: response.status, statusText: response.statusText, headers: response.headers })
  for (const key of ['url', 'redirected', 'type'] as const) {
    try { Object.defineProperty(copy, key, { value: response[key], configurable: true }) } catch {}
  }
  return copy
}

export { PROXY_ENV_KEYS }
