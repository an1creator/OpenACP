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
    expect(missing.statusCode).toBe(400)
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
})
