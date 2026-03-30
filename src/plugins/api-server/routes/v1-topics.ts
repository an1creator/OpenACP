import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'

export async function topicRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  if (!deps.topicManager) return

  const topicManager = deps.topicManager

  // GET / — list topics
  app.get<{ Querystring: { status?: string } }>('/', async (request) => {
    const statusParam = request.query.status
    const filter = statusParam ? { statuses: statusParam.split(',') } : undefined
    const topics = topicManager.listTopics(filter)
    return { topics }
  })

  // POST /cleanup — cleanup topics
  app.post<{ Body: { statuses?: string[] } }>('/cleanup', async (request) => {
    const statuses = request.body?.statuses
    const result = await topicManager.cleanup(statuses)
    return result
  })

  // DELETE /:sessionId — delete topic
  app.delete<{ Params: { sessionId: string }; Querystring: { force?: string } }>('/:sessionId', async (request, reply) => {
    const sessionId = decodeURIComponent(request.params.sessionId)
    const force = request.query.force === 'true'
    const result = await topicManager.deleteTopic(sessionId, force ? { confirmed: true } : undefined)

    if (result.ok) {
      return result
    } else if (result.needsConfirmation) {
      return reply.status(409).send({
        error: 'Session is active',
        needsConfirmation: true,
        session: result.session,
      })
    } else if (result.error === 'Cannot delete system topic') {
      return reply.status(403).send({ error: result.error })
    } else {
      return reply.status(404).send({ error: result.error ?? 'Not found' })
    }
  })
}
