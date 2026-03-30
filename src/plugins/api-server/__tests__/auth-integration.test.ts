import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { createAuthPreHandler } from '../middleware/auth.js'
import { TokenStore } from '../auth/token-store.js'
import { signToken } from '../auth/jwt.js'
import { authRoutesV1 } from '../routes/v1-auth.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SECRET = 'a'.repeat(64)
const JWT_SECRET = 'jwt-test-secret-for-integration'

describe('auth middleware integration', () => {
  let app: FastifyInstance
  let tokenStore: TokenStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'auth-int-'))
    tokenStore = new TokenStore(join(tmpDir, 'tokens.json'))
    await tokenStore.load()

    app = Fastify()
    app.decorateRequest('auth', undefined as any)

    const authPreHandler = createAuthPreHandler(() => SECRET, () => JWT_SECRET, tokenStore)

    // Test route that requires auth
    app.get('/test', { preHandler: authPreHandler }, async (req) => ({ auth: req.auth }))

    // Auth routes (without global auth for refresh)
    await app.register(
      (sub) => authRoutesV1(sub, { tokenStore, getJwtSecret: () => JWT_SECRET, authPreHandler }),
      { prefix: '/api/v1/auth' },
    )

    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    await rm(tmpDir, { recursive: true, force: true })
  })

  // === Auth Middleware ===

  it('authenticates with secret token', async () => {
    const res = await app.inject({
      method: 'GET', url: '/test',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.auth.type).toBe('secret')
    expect(body.auth.scopes).toEqual(['*'])
  })

  it('authenticates with valid JWT', async () => {
    const stored = tokenStore.create({ role: 'operator', name: 'test', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'operator', rfd }, JWT_SECRET, '24h')

    const res = await app.inject({
      method: 'GET', url: '/test',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.auth.type).toBe('jwt')
    expect(body.auth.role).toBe('operator')
    expect(body.auth.tokenId).toBe(stored.id)
  })

  it('rejects revoked JWT', async () => {
    const stored = tokenStore.create({ role: 'admin', name: 'revoke-test', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'admin', rfd }, JWT_SECRET, '24h')
    tokenStore.revoke(stored.id)

    const res = await app.inject({
      method: 'GET', url: '/test',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects request with no token', async () => {
    const res = await app.inject({ method: 'GET', url: '/test' })
    expect(res.statusCode).toBe(401)
  })

  it('accepts token from query param', async () => {
    const res = await app.inject({ method: 'GET', url: `/test?token=${SECRET}` })
    expect(res.statusCode).toBe(200)
  })

  it('resolves scope overrides from JWT', async () => {
    const stored = tokenStore.create({ role: 'viewer', name: 'scoped', expire: '24h', scopes: ['sessions:read'] })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'viewer', scopes: ['sessions:read'], rfd }, JWT_SECRET, '24h')

    const res = await app.inject({
      method: 'GET', url: '/test',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.auth.scopes).toEqual(['sessions:read'])
  })

  // === Token Generation ===

  it('generates JWT with secret token', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/tokens',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      payload: { role: 'operator', name: 'gen-test', expire: '1h' },
    })
    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.accessToken).toBeDefined()
    expect(body.tokenId).toMatch(/^tok_/)
    expect(body.refreshDeadline).toBeDefined()
  })

  it('rejects token generation with JWT (not secret)', async () => {
    const stored = tokenStore.create({ role: 'admin', name: 'jwt-gen', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'admin', rfd }, JWT_SECRET, '24h')

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/tokens',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      payload: { role: 'viewer', name: 'should-fail', expire: '1h' },
    })
    expect(res.statusCode).toBe(403)
  })

  // === Token Refresh ===

  it('refreshes a valid (non-expired) JWT', async () => {
    const stored = tokenStore.create({ role: 'operator', name: 'refresh-test', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'operator', rfd }, JWT_SECRET, '24h')

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.accessToken).toBeDefined()
    expect(body.tokenId).toBe(stored.id)
  })

  it('refreshes an expired JWT within refresh deadline', async () => {
    const stored = tokenStore.create({ role: 'admin', name: 'expired-refresh', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)

    // Craft an expired token (exp in the past, but rfd in the future)
    const jwt = signToken({ sub: stored.id, role: 'admin', rfd }, JWT_SECRET, '1h')
    const parts = jwt.split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    payload.exp = Math.floor(Date.now() / 1000) - 60 // expired 1 minute ago
    const newBody = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${newBody}`).digest('base64url')
    const expiredJwt = `${parts[0]}.${newBody}.${sig}`

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${expiredJwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.accessToken).toBeDefined()
    expect(body.tokenId).toBe(stored.id)
  })

  it('rejects refresh for revoked token', async () => {
    const stored = tokenStore.create({ role: 'admin', name: 'revoked-refresh', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'admin', rfd }, JWT_SECRET, '24h')
    tokenStore.revoke(stored.id)

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects refresh past refresh deadline', async () => {
    const stored = tokenStore.create({ role: 'admin', name: 'past-deadline', expire: '24h' })
    // Set rfd to the past
    const pastRfd = Math.floor(Date.now() / 1000) - 3600
    const jwt = signToken({ sub: stored.id, role: 'admin', rfd: pastRfd }, JWT_SECRET, '24h')

    const res = await app.inject({
      method: 'POST', url: '/api/v1/auth/refresh',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(401)
  })

  // === /me ===

  it('GET /me returns auth info for secret token', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${SECRET}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.type).toBe('secret')
    expect(body.role).toBe('admin')
  })

  it('GET /me returns auth info for JWT', async () => {
    const stored = tokenStore.create({ role: 'viewer', name: 'me-test', expire: '24h' })
    const rfd = Math.floor(new Date(stored.refreshDeadline).getTime() / 1000)
    const jwt = signToken({ sub: stored.id, role: 'viewer', rfd }, JWT_SECRET, '24h')

    const res = await app.inject({
      method: 'GET', url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body)
    expect(body.type).toBe('jwt')
    expect(body.role).toBe('viewer')
  })
})
