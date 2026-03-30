import type { FastifyInstance } from 'fastify'
import type { TokenStore } from '../auth/token-store.js'
import { signToken, verifyForRefresh } from '../auth/jwt.js'
import { isValidRole } from '../auth/roles.js'
import { AuthError, NotFoundError } from '../middleware/error-handler.js'
import { parseDuration } from '../auth/token-store.js'

export interface AuthRouteDeps {
  tokenStore: TokenStore
  getJwtSecret: () => string
}

export async function authRoutesV1(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  const { tokenStore, getJwtSecret } = deps

  // POST /tokens — generate new JWT (secret token only)
  app.post<{ Body: { role?: string; name?: string; expire?: string; scopes?: string[] } }>('/tokens', async (request, reply) => {
    if (request.auth.type !== 'secret') {
      throw new AuthError('FORBIDDEN', 'Only secret token can generate new tokens', 403)
    }

    const { role = 'admin', name = 'api-token', expire = '24h', scopes } = request.body ?? {}

    if (!isValidRole(role)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: `Invalid role: ${role}`, statusCode: 400 },
      })
    }

    const storedToken = tokenStore.create({ role, name, expire, scopes })

    const rfd = Math.floor(new Date(storedToken.refreshDeadline).getTime() / 1000)
    const accessToken = signToken(
      { sub: storedToken.id, role: storedToken.role, scopes: storedToken.scopes, rfd },
      getJwtSecret(),
      expire,
    )

    const expireMs = parseDuration(expire)

    return reply.status(201).send({
      accessToken,
      tokenId: storedToken.id,
      expiresAt: new Date(Date.now() + expireMs).toISOString(),
      refreshDeadline: storedToken.refreshDeadline,
    })
  })

  // GET /tokens — list active tokens
  app.get('/tokens', async () => {
    const tokens = tokenStore.list()
    return {
      tokens: tokens.map((t) => ({
        id: t.id,
        name: t.name,
        role: t.role,
        scopes: t.scopes,
        createdAt: t.createdAt,
        refreshDeadline: t.refreshDeadline,
        lastUsedAt: t.lastUsedAt,
      })),
    }
  })

  // DELETE /tokens/:id — revoke token
  app.delete<{ Params: { id: string } }>('/tokens/:id', async (request) => {
    const { id } = request.params
    const token = tokenStore.get(id)
    if (!token) {
      throw new NotFoundError('TOKEN_NOT_FOUND', `Token ${id} not found`)
    }
    tokenStore.revoke(id)
    return { success: true }
  })

  // POST /refresh — refresh JWT
  app.post('/refresh', async (request, reply) => {
    const authHeader = request.headers.authorization
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) {
      throw new AuthError('UNAUTHORIZED', 'Missing token')
    }

    let payload
    try {
      payload = verifyForRefresh(token, getJwtSecret())
    } catch {
      throw new AuthError('UNAUTHORIZED', 'Invalid token signature')
    }

    // Check revocation
    const storedToken = tokenStore.get(payload.sub)
    if (!storedToken || storedToken.revoked) {
      throw new AuthError('UNAUTHORIZED', 'Token revoked')
    }

    // Check refresh deadline
    if (Date.now() > payload.rfd * 1000) {
      throw new AuthError('UNAUTHORIZED', 'Refresh deadline passed, generate a new token')
    }

    const newToken = signToken(
      { sub: payload.sub, role: payload.role, scopes: payload.scopes, rfd: payload.rfd },
      getJwtSecret(),
      '24h',
    )

    return reply.send({
      accessToken: newToken,
      tokenId: payload.sub,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      refreshDeadline: storedToken.refreshDeadline,
    })
  })

  // GET /me — current auth info
  app.get('/me', async (request) => {
    return {
      type: request.auth.type,
      tokenId: request.auth.tokenId,
      role: request.auth.role,
      scopes: request.auth.scopes,
    }
  })
}
