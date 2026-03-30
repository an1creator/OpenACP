import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'

export async function notifyRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  app.post<{ Body: { message?: string } }>('/', async (request, reply) => {
    const { message } = request.body ?? {}

    if (!message) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing message', statusCode: 400 },
      })
    }

    await core.notificationManager.notifyAll({
      sessionId: 'system',
      type: 'completed',
      summary: message,
    })
    return { ok: true }
  })
}
