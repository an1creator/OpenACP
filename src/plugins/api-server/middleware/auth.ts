import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { AuthError } from './error-handler.js'
import { verifyToken } from '../auth/jwt.js'
import { getRoleScopes, hasScope } from '../auth/roles.js'
import type { TokenStore } from '../auth/token-store.js'

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
 * Create auth pre-handler supporting both secret token and JWT auth.
 * When jwtSecret or tokenStore are not provided, only secret token auth works (Plan 1 stub mode).
 */
export function createAuthPreHandler(
  getSecret: () => string,
  getJwtSecret?: () => string,
  tokenStore?: TokenStore,
): preHandlerHookHandler {
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

    // JWT verification (requires jwtSecret and tokenStore)
    if (getJwtSecret && tokenStore) {
      try {
        const payload = verifyToken(token, getJwtSecret())

        // Check if token is revoked
        const storedToken = tokenStore.get(payload.sub)
        if (!storedToken || storedToken.revoked) {
          throw new AuthError('UNAUTHORIZED', 'Token revoked')
        }

        // Update last used
        tokenStore.updateLastUsed(payload.sub)

        // Resolve scopes: use token override or role defaults
        const scopes = payload.scopes ?? getRoleScopes(payload.role)

        request.auth = {
          type: 'jwt',
          tokenId: payload.sub,
          role: payload.role,
          scopes,
        }
        return
      } catch (err) {
        if (err instanceof AuthError) throw err
        // Fall through to error below
      }
    }

    throw new AuthError('UNAUTHORIZED', 'Invalid authentication token')
  }
}

export function requireScopes(...scopes: string[]): preHandlerHookHandler {
  return async function scopeCheck(request: FastifyRequest, _reply: FastifyReply) {
    const { scopes: userScopes } = request.auth
    for (const scope of scopes) {
      if (!hasScope(userScopes, scope)) {
        throw new AuthError('FORBIDDEN', `Missing scope: ${scope}`, 403)
      }
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
