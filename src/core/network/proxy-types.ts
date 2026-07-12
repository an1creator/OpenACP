export const PROXY_PROTOCOLS = ['http', 'https', 'socks5', 'socks5h'] as const
export type ProxyProtocol = typeof PROXY_PROTOCOLS[number]

export type ProxyRoute = 'direct' | 'inherit' | `profile:${string}`

export interface ProxyProfileInput {
  id: string
  name?: string
  /** Write-only shorthand; mutually exclusive with endpoint/credential fields. */
  proxyUrl?: string
  protocol?: ProxyProtocol
  host?: string
  port?: number
  username?: string
  password?: string
  /** Explicitly remove an existing credential record. */
  clearCredentials?: boolean
  noProxy?: string[]
  failClosed?: boolean
}

/** Persisted and API-safe profile. Credentials are deliberately absent. */
export interface ProxyProfile {
  id: string
  name: string
  protocol: ProxyProtocol
  host: string
  port: number
  noProxy: string[]
  failClosed: boolean
  hasCredentials: boolean
}

export interface ProxyRoutingConfig {
  global: ProxyRoute
  routes: Record<string, ProxyRoute>
}

export interface ProxyStatus {
  revision: number
  profiles: ProxyProfile[]
  routing: ProxyRoutingConfig
  scopes: string[]
  diagnostics: Array<{
    scope: string
    route: ProxyRoute
    resolvedFrom: string
    childProcessSupport: 'native-env' | 'best-effort-socks-env' | 'not-applicable'
    warning?: string
  }>
  environment: {
    daemonWideProxyActive: boolean
    compatibilityMode: boolean
    variables: string[]
    message: string
  }
}

export interface ProxyRouteResolution {
  scope: string
  route: ProxyRoute
  resolvedFrom: string
  profile?: ProxyProfile
}

export interface ProxyRouteChangeResult {
  scope: string
  route: ProxyRoute
  warmPoolInvalidated: boolean
  activeAgentProcessesUnaffected: boolean
}
