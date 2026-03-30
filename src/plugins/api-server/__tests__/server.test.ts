import { describe, it, expect, afterEach } from 'vitest'
import { createApiServer, type ApiServerInstance } from '../server.js'

describe('createApiServer', () => {
  let server: ApiServerInstance | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('creates a Fastify instance', async () => {
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => 'test-secret' })
    expect(server.app).toBeDefined()
    expect(typeof server.app.printRoutes).toBe('function')
  })

  it('starts and listens on a port', async () => {
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => 'test-secret' })
    const address = await server.start()
    expect(address.port).toBeGreaterThan(0)
  })

  it('registers health endpoint without auth', async () => {
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => 'test-secret' })
    await server.start()

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/system/health',
    })

    expect(response.statusCode).toBe(200)
    const body = JSON.parse(response.body)
    expect(body.status).toBe('ok')
    expect(body.uptime).toBeGreaterThanOrEqual(0)
    expect(body.memory).toBeDefined()
  })

  it('returns 401 on version endpoint without token', async () => {
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => 'test-secret' })
    await server.start()

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/system/version',
    })

    expect(response.statusCode).toBe(401)
  })

  it('allows version endpoint with valid secret token', async () => {
    const secret = 'my-test-secret-token'
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => secret })
    await server.start()

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/system/version',
      headers: { authorization: `Bearer ${secret}` },
    })

    expect(response.statusCode).toBe(200)
  })

  it('registerPlugin adds authenticated routes', async () => {
    const secret = 'test-secret-abc'
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => secret })

    server.registerPlugin('/api/test', async (app) => {
      app.get('/hello', async () => ({ message: 'hi' }))
    })

    await server.start()

    // Without auth — should 401
    const noAuth = await server.app.inject({ method: 'GET', url: '/api/test/hello' })
    expect(noAuth.statusCode).toBe(401)

    // With auth — should 200
    const withAuth = await server.app.inject({
      method: 'GET',
      url: '/api/test/hello',
      headers: { authorization: `Bearer ${secret}` },
    })
    expect(withAuth.statusCode).toBe(200)
    expect(JSON.parse(withAuth.body).message).toBe('hi')
  })

  it('registerPlugin with auth=false skips auth', async () => {
    server = await createApiServer({ port: 0, host: '127.0.0.1', getSecret: () => 'secret' })

    server.registerPlugin('/api/public', async (app) => {
      app.get('/open', async () => ({ public: true }))
    }, { auth: false })

    await server.start()

    const response = await server.app.inject({ method: 'GET', url: '/api/public/open' })
    expect(response.statusCode).toBe(200)
    expect(JSON.parse(response.body).public).toBe(true)
  })
})
