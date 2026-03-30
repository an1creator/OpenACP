import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'
import { getAgentCapabilities } from '../../../core/agents/agent-registry.js'

export async function agentRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  app.get('/', async () => {
    const agents = core.agentManager.getAvailableAgents()
    const defaultAgent = core.configManager.get().defaultAgent
    const agentsWithCaps = agents.map((a) => ({
      ...a,
      capabilities: getAgentCapabilities(a.name),
    }))
    return { agents: agentsWithCaps, default: defaultAgent }
  })
}
