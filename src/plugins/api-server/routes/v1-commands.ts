import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'
import type { CommandRegistry } from '../../../core/command-registry.js'
import { requireScopes } from '../middleware/auth.js'

export async function commandRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  // Get command registry from service registry
  const getCommandRegistry = (): CommandRegistry | undefined => {
    return core.lifecycleManager.serviceRegistry.get<CommandRegistry>('command-registry')
  }

  // GET / — list all registered commands
  app.get('/', { preHandler: requireScopes('commands:execute') }, async (_request, reply) => {
    const registry = getCommandRegistry()
    if (!registry) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Command registry not available', statusCode: 503 },
      })
    }
    const commands = registry.getAll()
    return {
      commands: commands.map((cmd: any) => ({
        name: cmd.name,
        description: cmd.description,
        usage: cmd.usage,
        category: cmd.category,
        pluginName: cmd.pluginName,
      })),
    }
  })

  // POST /execute — execute a command
  app.post<{ Body: { command?: string; sessionId?: string } }>('/execute', { preHandler: requireScopes('commands:execute') }, async (request, reply) => {
    const registry = getCommandRegistry()
    if (!registry) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Command registry not available', statusCode: 503 },
      })
    }

    const { command, sessionId } = request.body ?? {}

    if (!command) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing command', statusCode: 400 },
      })
    }

    const result = await registry.execute(command, {
      raw: command,
      sessionId: sessionId ?? null,
      channelId: 'api',
      userId: request.auth?.tokenId ?? 'secret',
      reply: async () => {},
    })
    return { result: result ?? { type: 'silent' } }
  })
}
