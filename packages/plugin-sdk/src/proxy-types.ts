export type ProxyProtocol = 'http' | 'https' | 'socks5' | 'socks5h'
export type ProxyRoute = 'direct' | 'inherit' | `profile:${string}`

export interface ProxyProfileInput {
  id: string
  name?: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  noProxy?: string[]
  failClosed?: boolean
}

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

export interface ProxyStatus {
  revision: number
  profiles: ProxyProfile[]
  routing: { global: ProxyRoute; routes: Record<string, ProxyRoute> }
  scopes: string[]
  diagnostics: Array<Record<string, unknown>>
  environment: {
    daemonWideProxyActive: boolean
    compatibilityMode: boolean
    variables: string[]
    message: string
  }
}

/** Request bodies guaranteed by OpenACP's scoped node-fetch transport. */
export type ScopedRequestBody = string | URLSearchParams | Blob | FormData

export type ScopedRequestInit = Omit<RequestInit, 'body' | 'window'> & {
  body?: ScopedRequestBody | null
}

/** Structural service type returned by `ctx.getService<ProxyService>('proxy')`. */
export type ScopedFetch = (
  input: string | URL,
  init?: ScopedRequestInit,
) => Promise<Response>

export interface ProxyService {
  registerScope(scope: string): () => void
  resolve(scope: string): ProxyRouteResolution
  createFetch(scope: string): ScopedFetch
  status(): ProxyStatus
}
