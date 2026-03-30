import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'
import { NotFoundError } from '../middleware/error-handler.js'
import { requireScopes } from '../middleware/auth.js'
import { createChildLogger } from '../../../core/utils/log.js'

const log = createChildLogger({ module: 'api-server' })

export async function sessionRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  // GET / — list sessions
  app.get('/', { preHandler: requireScopes('sessions:read') }, async () => {
    const sessions = core.sessionManager.listSessions()
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        agent: s.agentName,
        status: s.status,
        name: s.name ?? null,
        workspace: s.workingDirectory,
        createdAt: s.createdAt.toISOString(),
        dangerousMode: s.dangerousMode,
        queueDepth: s.queueDepth,
        promptRunning: s.promptRunning,
        lastActiveAt: core.sessionManager.getSessionRecord(s.id)?.lastActiveAt ?? null,
      })),
    }
  })

  // GET /:id — session detail
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireScopes('sessions:read') }, async (request) => {
    const { id } = request.params
    const session = core.sessionManager.getSession(decodeURIComponent(id))
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session "${id}" not found`)
    }
    return {
      session: {
        id: session.id,
        agent: session.agentName,
        status: session.status,
        name: session.name ?? null,
        workspace: session.workingDirectory,
        createdAt: session.createdAt.toISOString(),
        dangerousMode: session.dangerousMode,
        queueDepth: session.queueDepth,
        promptRunning: session.promptRunning,
        threadId: session.threadId,
        channelId: session.channelId,
        agentSessionId: session.agentSessionId,
      },
    }
  })

  // POST / — create session
  app.post<{ Body: { agent?: string; workspace?: string; channel?: string } }>('/', { preHandler: requireScopes('sessions:write') }, async (request, reply) => {
    const { agent, workspace, channel } = request.body ?? {}

    // Check max concurrent sessions
    const config = core.configManager.get()
    const activeSessions = core.sessionManager
      .listSessions()
      .filter((s) => s.status === 'active' || s.status === 'initializing')
    if (activeSessions.length >= config.security.maxConcurrentSessions) {
      return reply.status(429).send({
        error: {
          code: 'SESSION_LIMIT',
          message: `Max concurrent sessions (${config.security.maxConcurrentSessions}) reached. Cancel a session first.`,
          statusCode: 429,
        },
      })
    }

    // Resolve adapter
    let adapterId: string | null = null
    let adapter: any = null

    if (channel) {
      if (!core.adapters.has(channel)) {
        const available = Array.from(core.adapters.keys()).join(', ') || 'none'
        return reply.status(400).send({
          error: {
            code: 'ADAPTER_NOT_FOUND',
            message: `Adapter '${channel}' is not connected. Available: ${available}`,
            statusCode: 400,
          },
        })
      }
      adapterId = channel
      adapter = core.adapters.get(channel) ?? null
    } else {
      const firstEntry = core.adapters.entries().next().value
      if (firstEntry) {
        ;[adapterId, adapter] = firstEntry
      }
    }

    const channelId = adapterId ?? 'api'
    const resolvedAgent = agent || config.defaultAgent
    const agentDef = core.agentCatalog.resolve(resolvedAgent)
    const resolvedWorkspace = core.configManager.resolveWorkspace(workspace || agentDef?.workingDirectory)

    const session = await core.createSession({
      channelId,
      agentName: resolvedAgent,
      workingDirectory: resolvedWorkspace,
      createThread: !!adapter,
      initialName: `🔄 ${resolvedAgent} — New Session`,
    })

    // If no adapter wired events (headless), auto-approve permissions
    if (!adapter) {
      session.agentInstance.onPermissionRequest = async (permReq) => {
        const allowOption = permReq.options.find((o) => o.isAllow)
        log.debug(
          { sessionId: session.id, permissionId: permReq.id, option: allowOption?.id },
          'Auto-approving permission for API session',
        )
        return allowOption?.id ?? permReq.options[0]?.id ?? ''
      }
    }

    // Warmup in background
    session.warmup().catch((err) =>
      log.warn({ err, sessionId: session.id }, 'API session warmup failed'),
    )

    return reply.status(200).send({
      sessionId: session.id,
      agent: session.agentName,
      status: session.status,
      workspace: session.workingDirectory,
    })
  })

  // POST /adopt — adopt external session
  app.post<{ Body: { agent?: string; agentSessionId?: string; cwd?: string; channel?: string } }>('/adopt', { preHandler: requireScopes('sessions:write') }, async (request, reply) => {
    const { agent, agentSessionId, cwd, channel } = request.body ?? {}

    if (!agent || !agentSessionId) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Missing required fields: agent, agentSessionId',
          statusCode: 400,
        },
      })
    }

    const result = await core.adoptSession(agent, agentSessionId, cwd ?? process.cwd(), channel)

    if (result.ok) {
      return result
    } else {
      const status = result.error === 'session_limit' ? 429 : result.error === 'agent_not_supported' ? 400 : 500
      return reply.status(status).send(result)
    }
  })

  // POST /:id/prompt — enqueue prompt
  app.post<{ Params: { id: string }; Body: { prompt?: string } }>('/:id/prompt', { preHandler: requireScopes('sessions:prompt') }, async (request, reply) => {
    const session = core.sessionManager.getSession(decodeURIComponent(request.params.id))
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session "${request.params.id}" not found`)
    }

    if (session.status === 'cancelled' || session.status === 'finished' || session.status === 'error') {
      return reply.status(400).send({
        error: { code: 'SESSION_INACTIVE', message: `Session is ${session.status}`, statusCode: 400 },
      })
    }

    const prompt = request.body?.prompt
    if (!prompt) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing prompt', statusCode: 400 },
      })
    }

    session.enqueuePrompt(prompt).catch(() => {})
    return { ok: true, sessionId: session.id, queueDepth: session.queueDepth }
  })

  // POST /:id/permission — resolve permission
  app.post<{ Params: { id: string }; Body: { permissionId?: string; optionId?: string } }>('/:id/permission', { preHandler: requireScopes('sessions:permission') }, async (request, reply) => {
    const session = core.sessionManager.getSession(decodeURIComponent(request.params.id))
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session "${request.params.id}" not found`)
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
    return { ok: true }
  })

  // PATCH /:id/dangerous — toggle dangerous mode
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/:id/dangerous', { preHandler: requireScopes('sessions:write') }, async (request, reply) => {
    const session = core.sessionManager.getSession(decodeURIComponent(request.params.id))
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session "${request.params.id}" not found`)
    }

    const { enabled } = request.body ?? {}
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing enabled boolean', statusCode: 400 },
      })
    }

    session.dangerousMode = enabled
    await core.sessionManager.patchRecord(session.id, { dangerousMode: enabled })
    return { ok: true, dangerousMode: enabled }
  })

  // POST /:id/archive — archive session
  app.post<{ Params: { id: string } }>('/:id/archive', { preHandler: requireScopes('sessions:write') }, async (request, reply) => {
    const result = await core.archiveSession(decodeURIComponent(request.params.id))
    if (result.ok) {
      return result
    } else {
      return reply.status(400).send(result)
    }
  })

  // DELETE /:id — cancel session
  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireScopes('sessions:write') }, async (request) => {
    const sessionId = decodeURIComponent(request.params.id)
    const session = core.sessionManager.getSession(sessionId)
    if (!session) {
      throw new NotFoundError('SESSION_NOT_FOUND', `Session "${sessionId}" not found`)
    }
    await core.sessionManager.cancelSession(sessionId)
    return { ok: true }
  })
}
