import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'
import { requireScopes, requireRole } from '../middleware/auth.js'

export async function systemRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core, startedAt, getVersion } = deps

  // Health is unauthenticated (used for discovery)
  app.get('/health', async () => {
    const activeSessions = core.sessionManager.listSessions()
    const allRecords = core.sessionManager.listRecords()
    const mem = process.memoryUsage()
    const tunnel = core.tunnelService

    return {
      status: 'ok',
      uptime: Date.now() - startedAt,
      version: getVersion(),
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      sessions: {
        active: activeSessions.filter((s) => s.status === 'active' || s.status === 'initializing').length,
        total: allRecords.length,
      },
      adapters: Array.from(core.adapters.keys()),
      tunnel: tunnel ? { enabled: true, url: tunnel.getPublicUrl() } : { enabled: false },
    }
  })

  app.get('/version', { preHandler: requireScopes('system:health') }, async () => ({ version: getVersion() }))

  app.post('/restart', { preHandler: requireRole('admin') }, async (_request, reply) => {
    if (!core.requestRestart) {
      return reply.status(501).send({
        error: { code: 'NOT_AVAILABLE', message: 'Restart not available', statusCode: 501 },
      })
    }
    setImmediate(() => core.requestRestart!())
    return { ok: true, message: 'Restarting...' }
  })

  app.get('/adapters', { preHandler: requireScopes('system:health') }, async () => {
    const adapters = Array.from(core.adapters.entries()).map(([name]) => ({
      name,
      type: 'built-in' as const,
    }))
    return { adapters }
  })
}
