import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { systemRoutes } from '../routes/health.js'
import type { RouteDeps } from '../routes/types.js'

describe('system health routes', () => {
  let app: FastifyInstance

  beforeEach(async () => {
    app = Fastify()
    app.decorateRequest('auth', null, [])
    app.addHook('onRequest', async (request) => {
      request.auth = { type: 'secret', role: 'admin', scopes: ['*'] }
    })
  })

  afterEach(async () => {
    await app.close()
  })

  it('uses the merged session summary for both active and total counts', async () => {
    const listAllSessions = vi.fn().mockReturnValue([
      { id: 'live-only', status: 'active' },
      { id: 'initializing', status: 'initializing' },
      { id: 'historical', status: 'finished' },
    ])
    const deps = {
      core: {
        sessionManager: { listAllSessions },
        adapters: new Map([['telegram', {}]]),
        tunnelService: undefined,
      },
      startedAt: Date.now() - 1000,
      getVersion: () => 'test-version',
      instanceId: 'test-instance',
    } as unknown as RouteDeps

    await app.register(async (instance) => systemRoutes(instance, deps), {
      prefix: '/api/v1/system',
    })
    await app.ready()

    const response = await app.inject({ method: 'GET', url: '/api/v1/system/health/details' })
    expect(response.statusCode).toBe(200)
    expect(response.json().sessions).toEqual({ active: 2, total: 3 })
    expect(listAllSessions).toHaveBeenCalledOnce()
  })
})
