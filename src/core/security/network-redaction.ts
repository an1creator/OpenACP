const SENSITIVE_QUERY_KEYS = [
  'access_token', 'access-token', 'token', 'api_key', 'api-key', 'apikey', 'key',
  'secret', 'password', 'passwd', 'auth', 'authorization', 'signature', 'sig',
  'bot_token', 'bot-token',
].join('|')

const UNSAFE_PROXY_DEBUG = /^\*?(?:proxy-agent|proxy|https-proxy-agent|http-proxy-agent|socks-proxy-agent)(?::|\*|$)/i
const PROXY_DEBUG_EXCLUSIONS = [
  '-proxy', '-proxy:*', '-proxy-agent', '-proxy-agent:*',
  '-https-proxy-agent', '-https-proxy-agent:*',
  '-http-proxy-agent', '-http-proxy-agent:*',
  '-socks-proxy-agent', '-socks-proxy-agent:*',
]

/** Remove third-party proxy debug namespaces that may print credential URLs outside pino. */
export function sanitizeProxyDebugNamespaces(value: string | undefined): string | undefined {
  if (!value) return value
  const entries = value.split(',').map((item) => item.trim()).filter(Boolean)
  const safeEntries = entries.filter((item) => item.startsWith('-') || !UNSAFE_PROXY_DEBUG.test(item))
  if (safeEntries.some((item) => !item.startsWith('-') && item.includes('*'))) {
    for (const exclusion of PROXY_DEBUG_EXCLUSIONS) if (!safeEntries.includes(exclusion)) safeEntries.push(exclusion)
  }
  const safe = safeEntries.join(',')
  return safe || undefined
}

const SENSITIVE_OBJECT_KEYS = new Set([
  'authorization', 'proxyauthorization', 'xapikey', 'apikey', 'token',
  'xgoogapikey', 'xauthtoken', 'xtelegrambottoken', 'authentication',
  'accesstoken', 'password', 'passwd', 'secret', 'bottoken', 'cookie', 'setcookie',
])

/** Redact credentials embedded in network error messages while retaining host/path context. */
export function redactNetworkSecrets(input: string): string {
  return input
    // Telegram embeds the bot credential in the URL path, not query/userinfo.
    .replace(/(https?:\/\/api\.telegram\.org\/bot)[^/?#\s]+/gi, '$1<redacted>')
    .replace(/(\/bot)[0-9]+:[A-Za-z0-9_-]+/g, '$1<redacted>')
    // Standard URL userinfo: scheme://user:password@host.
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi, '$1<redacted>@')
    // Common query-string credentials.
    .replace(new RegExp(`([?&](?:${SENSITIVE_QUERY_KEYS})=)[^&#\\s]*`, 'gi'), '$1<redacted>')
    // Header-like text, including Bearer/Basic credentials.
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:Bearer|Basic)\s+[^\s,;}"']+/gi, '$1: <redacted>')
    .replace(/\b(x-api-key|api-key|cookie|set-cookie)\s*[:=]\s*[^\r\n,;}]+/gi, '$1: <redacted>')
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveObjectKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return SENSITIVE_OBJECT_KEYS.has(normalized)
    || /(?:token|secret|password|passwd|apikey|authorization|cookie)$/.test(normalized)
}

/** Recursively sanitize structured logger arguments, including Error message/stack. */
export function sanitizeNetworkLogValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (typeof value === 'string') return redactNetworkSecrets(value)
  if (value instanceof Error) {
    const sanitized = new Error(redactNetworkSecrets(value.message))
    sanitized.name = value.name
    if (value.stack) sanitized.stack = redactNetworkSecrets(value.stack)
    for (const [key, nested] of Object.entries(value)) {
      ;(sanitized as unknown as Record<string, unknown>)[key] = isSensitiveObjectKey(key)
        ? '<redacted>'
        : sanitizeNetworkLogValue(nested, seen)
    }
    return sanitized
  }
  if (!value || typeof value !== 'object') return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || value instanceof Date) return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const result: unknown[] = []
    seen.set(value, result)
    for (const item of value) result.push(sanitizeNetworkLogValue(item, seen))
    return result
  }
  const result: Record<string, unknown> = {}
  seen.set(value, result)
  for (const [key, nested] of Object.entries(value)) {
    result[key] = isSensitiveObjectKey(key)
      ? '<redacted>'
      : sanitizeNetworkLogValue(nested, seen)
  }
  return result
}
