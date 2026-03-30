import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'
import { getAgentCapabilities } from '../../../core/agents/agent-registry.js'
import { requireScopes } from '../middleware/auth.js'

export async function agentRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  app.get('/', { preHandler: requireScopes('agents:read') }, async () => {
    const agents = core.agentManager.getAvailableAgents()
    const defaultAgent = core.configManager.get().defaultAgent
    const agentsWithCaps = agents.map((a) => ({
      ...a,
      capabilities: getAgentCapabilities(a.name),
    }))
    return { agents: agentsWithCaps, default: defaultAgent }
  })
}
