import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { AuthError } from './error-handler.js'

declare module 'fastify' {
  interface FastifyRequest {
    auth: {
      type: 'secret' | 'jwt'
      tokenId?: string
      role: string
      scopes: string[]
    }
  }
}

/**
 * Create auth pre-handler. Stub version — only supports secret token auth.
 * Will be extended with JWT support in Plan 2.
 */
export function createAuthPreHandler(getSecret: () => string): preHandlerHookHandler {
  return async function authPreHandler(request: FastifyRequest, _reply: FastifyReply) {
    const authHeader = request.headers.authorization
    const queryToken = (request.query as Record<string, string>)?.token
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryToken

    if (!token) {
      throw new AuthError('UNAUTHORIZED', 'Missing authentication token')
    }

    const secret = getSecret()

    // Secret token check (timing-safe)
    if (token.length === secret.length && token.length > 0) {
      try {
        const tokenBuf = Buffer.from(token)
        const secretBuf = Buffer.from(secret)
        if (timingSafeEqual(tokenBuf, secretBuf)) {
          request.auth = { type: 'secret', role: 'admin', scopes: ['*'] }
          return
        }
      } catch {
        // Buffer comparison failed
      }
    }

    // JWT check — stub for Plan 2. For now, reject non-secret tokens.
    throw new AuthError('UNAUTHORIZED', 'Invalid authentication token')
  }
}

export function requireScopes(...scopes: string[]): preHandlerHookHandler {
  return async function scopeCheck(request: FastifyRequest, _reply: FastifyReply) {
    const { scopes: userScopes } = request.auth
    if (userScopes.includes('*')) return

    const missing = scopes.filter((s) => !userScopes.includes(s))
    if (missing.length > 0) {
      throw new AuthError('FORBIDDEN', `Missing scopes: ${missing.join(', ')}`, 403)
    }
  }
}

export function requireRole(role: string): preHandlerHookHandler {
  const roleHierarchy: Record<string, number> = { viewer: 0, operator: 1, admin: 2 }

  return async function roleCheck(request: FastifyRequest, _reply: FastifyReply) {
    const userLevel = roleHierarchy[request.auth.role] ?? -1
    const requiredLevel = roleHierarchy[role] ?? 999

    if (userLevel < requiredLevel) {
      throw new AuthError('FORBIDDEN', `Requires ${role} role`, 403)
    }
  }
}
