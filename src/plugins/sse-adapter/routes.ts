import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import type { OpenACPCore } from '../../core/core.js'
import type { ConnectionManager } from './connection-manager.js'
import type { EventBuffer } from './event-buffer.js'
import { NotFoundError } from '../api-server/middleware/error-handler.js'
import { serializeConnected, serializeError } from './event-serializer.js'

export interface SSERouteDeps {
  connectionManager: ConnectionManager
  eventBuffer: EventBuffer
  core: OpenACPCore
}

export async function createSSERoutes(app: FastifyInstance, deps: SSERouteDeps): Promise<void> {
  const { connectionManager, eventBuffer, core } = deps

  // GET /sessions/:id/stream — SSE event stream
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>('/sessions/:id/stream', async (request: FastifyRequest, reply: FastifyReply) => {
    const id = decodeURIComponent((request.params as { id: string }).id)
    const session = core.sessionManager.getSession(id)
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session ${id} not found`)
    }

    reply.hijack()
    const res = reply.raw

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const tokenId = (request as any).auth?.tokenId ?? 'secret'
    const conn = connectionManager.addConnection(id, tokenId, res)

    res.write(serializeConnected(conn.id, id))

    // Replay missed events if reconnecting
    const lastEventId = request.headers['last-event-id'] as string | undefined
    if (lastEventId) {
      const missed = eventBuffer.getSince(id, lastEventId)
      if (missed === null) {
        res.write(serializeError('reconnect', 'EVENTS_LOST', { message: 'Some events were missed' }))
      } else {
        for (const event of missed) {
          res.write(event.data as string)
        }
      }
    }
  })

  // POST /sessions/:id/prompt — send message
  app.post<{ Params: { id: string }; Body: { prompt?: string; message?: string } }>('/sessions/:id/prompt', async (request, reply) => {
    const id = decodeURIComponent(request.params.id)
    const session = core.sessionManager.getSession(id)
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session ${id} not found`)
    }

    const prompt = request.body?.prompt ?? request.body?.message
    if (!prompt) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing prompt', statusCode: 400 },
      })
    }

    session.enqueuePrompt(prompt).catch(() => {})
    return { success: true, sessionId: id }
  })

  // POST /sessions/:id/permission — resolve permission
  app.post<{ Params: { id: string }; Body: { permissionId?: string; optionId?: string } }>('/sessions/:id/permission', async (request, reply) => {
    const id = decodeURIComponent(request.params.id)
    const session = core.sessionManager.getSession(id)
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session ${id} not found`)
    }

    const { permissionId, optionId } = request.body ?? {}
    if (!permissionId || !optionId) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing permissionId or optionId', statusCode: 400 },
      })
    }

    if (!session.permissionGate.isPending || session.permissionGate.requestId !== permissionId) {
      return reply.status(400).send({
        error: { code: 'NO_PENDING_PERMISSION', message: 'No matching pending permission request', statusCode: 400 },
      })
    }

    session.permissionGate.resolve(optionId)
    return { success: true }
  })

  // POST /sessions/:id/cancel — cancel session
  app.post<{ Params: { id: string } }>('/sessions/:id/cancel', async (request) => {
    const id = decodeURIComponent(request.params.id)
    const session = core.sessionManager.getSession(id)
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session ${id} not found`)
    }
    await core.sessionManager.cancelSession(id)
    return { success: true }
  })

  // POST /sessions/:id/command — execute command in session context
  app.post<{ Params: { id: string }; Body: { command?: string } }>('/sessions/:id/command', async (request, reply) => {
    const id = decodeURIComponent(request.params.id)
    const session = core.sessionManager.getSession(id)
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session ${id} not found`)
    }

    const { command } = request.body ?? {}
    if (!command) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing command', statusCode: 400 },
      })
    }

    const registry = core.lifecycleManager.serviceRegistry.get<any>('command-registry')
    if (!registry) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Command registry not available', statusCode: 503 },
      })
    }

    const result = await registry.execute(command, {
      raw: command,
      sessionId: id,
      channelId: 'sse',
      userId: (request as any).auth?.tokenId ?? 'secret',
      reply: async () => {},
    })
    return { result: result ?? { type: 'silent' } }
  })

  // GET /connections — list active SSE connections (admin only)
  app.get('/connections', async () => {
    const connections = connectionManager.listConnections()
    return {
      connections: connections.map((c) => ({
        id: c.id,
        sessionId: c.sessionId,
        tokenId: c.tokenId,
        connectedAt: c.connectedAt.toISOString(),
      })),
    }
  })
}
