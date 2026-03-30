import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'

export async function tunnelRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  app.get('/', async () => {
    const tunnel = core.tunnelService
    if (tunnel) {
      return {
        enabled: true,
        url: tunnel.getPublicUrl(),
        provider: core.configManager.get().tunnel.provider,
      }
    }
    return { enabled: false }
  })

  app.get('/list', async () => {
    const tunnel = core.tunnelService
    if (!tunnel) return []
    return tunnel.listTunnels()
  })

  app.post<{ Body: { port?: number; label?: string; sessionId?: string } }>('/', async (request, reply) => {
    const tunnel = core.tunnelService
    if (!tunnel) {
      return reply.status(400).send({
        error: { code: 'TUNNEL_NOT_ENABLED', message: 'Tunnel service is not enabled', statusCode: 400 },
      })
    }

    const { port, label, sessionId } = request.body ?? {}
    if (!port || typeof port !== 'number') {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'port is required and must be a number', statusCode: 400 },
      })
    }

    try {
      const entry = await tunnel.addTunnel(port, { label, sessionId })
      return entry
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'TUNNEL_ERROR', message: (err as Error).message, statusCode: 400 },
      })
    }
  })

  app.delete<{ Params: { port: string } }>('/:port', async (request, reply) => {
    const tunnel = core.tunnelService
    if (!tunnel) {
      return reply.status(400).send({
        error: { code: 'TUNNEL_NOT_ENABLED', message: 'Tunnel service is not enabled', statusCode: 400 },
      })
    }

    const port = parseInt(request.params.port, 10)
    try {
      await tunnel.stopTunnel(port)
      return { ok: true }
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'TUNNEL_ERROR', message: (err as Error).message, statusCode: 400 },
      })
    }
  })

  // DELETE / — stop all user tunnels
  app.delete('/', async (_request, reply) => {
    const tunnel = core.tunnelService
    if (!tunnel) {
      return reply.status(400).send({
        error: { code: 'TUNNEL_NOT_ENABLED', message: 'Tunnel service is not enabled', statusCode: 400 },
      })
    }
    const count = tunnel.listTunnels().length
    await tunnel.stopAllUser()
    return { ok: true, stopped: count }
  })
}
