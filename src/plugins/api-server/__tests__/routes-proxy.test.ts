import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyService } from '../../../core/network/proxy-service.js'
import { proxyRoutes } from '../routes/proxy.js'
import { globalErrorHandler } from '../middleware/error-handler.js'

describe('proxy API routes', () => {
  let root: string
  let app: ReturnType<typeof Fastify>
  let service: ProxyService
  let authScopes: string[]

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-proxy-api-'))
    app = Fastify()
    app.setErrorHandler(globalErrorHandler)
    service = new ProxyService(root)
    authScopes = ['*']
    app.decorateRequest('auth', null)
    app.addHook('onRequest', async (request) => {
      request.auth = { type: 'jwt', role: 'viewer', scopes: authScopes }
    })
    await app.register(async (scope) => proxyRoutes(scope, {
      core: { proxyService: service } as any,
      startedAt: Date.now(), getVersion: () => 'test', instanceId: 'test',
    }), { prefix: '/api/v1/proxy' })
  })

  afterEach(async () => {
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates a profile write-only and returns redacted status', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/v1/proxy/profiles',
      payload: { id: 'usa', protocol: 'http', host: 'proxy.test', port: 8080, username: 'user', password: 'secret' },
    })
    expect(create.statusCode).toBe(200)
    expect(create.body).not.toContain('secret')
    const status = await app.inject({ method: 'GET', url: '/api/v1/proxy' })
    expect(status.statusCode).toBe(200)
    expect(status.body).not.toContain('secret')
    expect(status.json().profiles[0]).toMatchObject({ id: 'usa', hasCredentials: true })
    const duplicate = await app.inject({
      method: 'POST', url: '/api/v1/proxy/profiles',
      payload: { id: 'usa', protocol: 'http', host: 'other.test', port: 8081 },
    })
    expect(duplicate.statusCode).toBe(409)
    expect(duplicate.json().error.code).toBe('PROXY_PROFILE_EXISTS')
  })

  it('accepts write-only proxyUrl input and rejects mixed endpoint representations', async () => {
    const create = await app.inject({
      method: 'POST', url: '/api/v1/proxy/profiles',
      payload: { id: 'url-profile', name: 'URL profile', proxyUrl: 'http://alice:pa%3Ass@proxy.test:8080' },
    })
    expect(create.statusCode).toBe(200)
    expect(create.json().profile).toMatchObject({ id: 'url-profile', host: 'proxy.test', port: 8080, hasCredentials: true })
    expect(create.body).not.toContain('alice')
    expect(create.body).not.toContain('pa%3Ass')

    const mixed = await app.inject({
      method: 'POST', url: '/api/v1/proxy/profiles',
      payload: { id: 'mixed', proxyUrl: 'http://proxy.test:8080', protocol: 'http', host: 'proxy.test', port: 8080 },
    })
    expect(mixed.statusCode).toBe(400)
    expect(service.getProfile('mixed')).toBeUndefined()
  })

  it('returns typed proxy validation for a 101-character name without saving', async () => {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/proxy/profiles',
      payload: { id: 'long-name', name: 'x'.repeat(101), proxyUrl: 'http://proxy.test:8080' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PROXY_VALIDATION_ERROR')
    expect(service.getProfile('long-name')).toBeUndefined()
  })

  it('serializes concurrent create-only requests so exactly one returns PROFILE_EXISTS', async () => {
    const payload = { id: 'race', protocol: 'http', host: 'proxy.test', port: 8080 }
    const responses = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/proxy/profiles', payload }),
      app.inject({ method: 'POST', url: '/api/v1/proxy/profiles', payload: { ...payload, host: 'other.test' } }),
    ])
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409])
    expect(responses.find((response) => response.statusCode === 409)?.json().error.code).toBe('PROXY_PROFILE_EXISTS')
    expect(service.listProfiles().filter((profile) => profile.id === 'race')).toHaveLength(1)
  })

  it('does not let a queued PUT resurrect a profile deleted first', async () => {
    await service.createProfileSafely({ id: 'gone', protocol: 'http', host: 'proxy.test', port: 8080 })
    const deleted = app.inject({ method: 'DELETE', url: '/api/v1/proxy/profiles/gone' })
    const updated = app.inject({
      method: 'PUT', url: '/api/v1/proxy/profiles/gone',
      payload: { protocol: 'http', host: 'resurrect.test', port: 8081 },
    })
    const [deleteResponse, updateResponse] = await Promise.all([deleted, updated])
    expect(deleteResponse.statusCode).toBe(200)
    expect(updateResponse.statusCode).toBe(404)
    expect(updateResponse.json().error.code).toBe('PROXY_PROFILE_NOT_FOUND')
    expect(service.getProfile('gone')).toBeUndefined()
  })

  it('sets exact/category routes and exposes the resolved matrix', async () => {
    await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/agents.default', payload: { route: 'direct' } })
    await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/agents.codex', payload: { route: 'inherit' } })
    const status = await app.inject({ method: 'GET', url: '/api/v1/proxy' })
    const body = status.json()
    expect(body.routing.routes).toMatchObject({ 'agents.default': 'direct', 'agents.codex': 'inherit' })
    expect(body.diagnostics.find((item: any) => item.scope === 'agents.codex').route).toBe('inherit')
  })

  it('validates route values', async () => {
    const response = await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/agents.codex', payload: { route: 'maybe' } })
    expect(response.statusCode).toBe(400)
  })

  it('returns a typed actionable error and preserves the old channel route', async () => {
    const telegramToken = '123456789:api-test-secret-token'
    await app.inject({ method: 'POST', url: '/api/v1/proxy/profiles', payload: { id: 'bad', protocol: 'http', host: '127.0.0.1', port: 9 } })
    await service.setRoute('channels.telegram', 'direct')
    service.registerRouteTester('channels.telegram', async () => {
      throw new Error(`request to https://api.telegram.org/bot${telegramToken}/getMe failed`)
    })
    const response = await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/channels.telegram', payload: { route: 'profile:bad' } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error).toMatchObject({ code: 'PROXY_ROUTE_TEST_FAILED' })
    expect(response.json().error.message).toContain('route was not changed')
    expect(response.json().error.message).toContain('api.telegram.org/bot<redacted>/getMe')
    expect(response.body).not.toContain(telegramToken)
    expect(service.resolve('channels.telegram').route).toBe('direct')
  })

  it('returns typed 400 errors for invalid domains, missing profiles, and unknown scopes', async () => {
    const badHost = await app.inject({ method: 'POST', url: '/api/v1/proxy/profiles', payload: { id: 'bad', protocol: 'http', host: 'user@host/path', port: 8080 } })
    expect(badHost.statusCode).toBe(400)
    expect(badHost.json().error.code).toBe('PROXY_VALIDATION_ERROR')
    const missing = await app.inject({ method: 'DELETE', url: '/api/v1/proxy/profiles/missing' })
    expect(missing.statusCode).toBe(404)
    expect(missing.json().error.code).toBe('PROXY_PROFILE_NOT_FOUND')
    const unknown = await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/plugins.unknown.flow', payload: { route: 'direct' } })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error.code).toBe('PROXY_UNKNOWN_SCOPE')
  })

  it('blocks private custom test targets before transport dispatch', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/proxy/test', payload: { scope: 'channels.telegram', targetUrl: 'https://127.0.0.1/internal' } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PROXY_TEST_TARGET_BLOCKED')
  })

  it('blocks public but unapproved custom diagnostic hosts', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/proxy/test', payload: { scope: 'channels.telegram', targetUrl: 'https://example.com/' } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PROXY_TEST_TARGET_BLOCKED')
  })

  it('allows read-only status and fixed tests but denies every proxy mutation and custom target', async () => {
    authScopes = ['config:read']
    vi.spyOn(service, 'test').mockResolvedValueOnce({ ok: true, status: 200 })
    expect((await app.inject({ method: 'GET', url: '/api/v1/proxy' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'POST', url: '/api/v1/proxy/test', payload: { scope: 'channels.telegram' } })).statusCode).toBe(200)
    const attempts = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/proxy/profiles', payload: { id: 'x', protocol: 'http', host: 'proxy.test', port: 8080 } }),
      app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/agents.codex', payload: { route: 'direct' } }),
      app.inject({ method: 'DELETE', url: '/api/v1/proxy/routes/agents.codex' }),
      app.inject({ method: 'POST', url: '/api/v1/proxy/test', payload: { scope: 'channels.telegram', targetUrl: 'https://example.com' } }),
    ])
    expect(attempts.every((response) => response.statusCode === 403)).toBe(true)
    expect(service.status().routing.routes).toEqual({})
  })

  it('returns a typed 400 when a test references an unregistered scope', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/proxy/test', payload: { scope: 'plugins.not-installed' } })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.code).toBe('PROXY_UNKNOWN_SCOPE')
  })

  it('returns 409 for stale revision CAS writes', async () => {
    const status = await app.inject({ method: 'GET', url: '/api/v1/proxy' })
    const revision = status.json().revision
    await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/agents.codex', payload: { route: 'direct', expectedRevision: revision } })
    const stale = await app.inject({ method: 'PUT', url: '/api/v1/proxy/routes/agents.cursor', payload: { route: 'direct', expectedRevision: revision } })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('PROXY_REVISION_CONFLICT')
  })

  it('updates profiles, tests unsaved candidates, and atomically reassigns on delete', async () => {
    await service.saveProfileSafely({ id: 'old', protocol: 'http', host: 'old.test', port: 8080, password: 'write-only' })
    await service.saveProfileSafely({ id: 'next', protocol: 'https', host: 'next.test', port: 8443 })
    await service.setRoute('agents.codex', 'profile:old')

    const update = await app.inject({
      method: 'PUT', url: '/api/v1/proxy/profiles/old',
      payload: { protocol: 'http', host: 'updated.test', port: 8081, clearCredentials: true },
    })
    expect(update.statusCode).toBe(200)
    expect(update.body).not.toContain('write-only')
    expect(update.json().profile).toMatchObject({ id: 'old', host: 'updated.test', hasCredentials: false })

    vi.spyOn(service, 'testProfileCandidate').mockResolvedValueOnce({ ok: true, status: 204 })
    const candidate = await app.inject({
      method: 'POST', url: '/api/v1/proxy/profiles/test-candidate',
      payload: { id: 'draft', protocol: 'socks5h', host: 'draft.test', port: 1080, password: 'never-return' },
    })
    expect(candidate.statusCode).toBe(200)
    expect(candidate.json()).toEqual({ ok: true, status: 204 })
    expect(candidate.body).not.toContain('never-return')

    const deleted = await app.inject({
      method: 'DELETE', url: '/api/v1/proxy/profiles/old?reassign=profile%3Anext',
    })
    expect(deleted.statusCode).toBe(200)
    expect(deleted.json().reassignedScopes).toContain('agents.codex')
    expect(service.resolve('agents.codex').route).toBe('profile:next')
    expect(service.getProfile('old')).toBeUndefined()
  })
})
