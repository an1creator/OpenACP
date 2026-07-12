import type { FastifyInstance } from 'fastify';
import type { RouteDeps } from './types.js';
import { NameParamSchema } from '../schemas/common.js';
import { NotFoundError } from '../middleware/error-handler.js';
import { requireScopes } from '../middleware/auth.js';
import { getAgentCapabilities } from '../../../core/agents/agent-registry.js';

/** Preserve env key visibility for diagnostics without exposing credential-bearing values. */
export function redactAgentEnv<T extends { env?: Record<string, string> }>(agent: T): T {
  if (!agent.env) return agent;
  return {
    ...agent,
    env: Object.fromEntries(Object.keys(agent.env).map((key) => [key, '***'])),
  };
}

/**
 * Agent catalog routes under `/api/v1/agents`.
 *
 * Routes: list all (`GET /`), reload from disk (`POST /reload`), get one (`GET /:name`).
 * Requires `agents:read` for reads and `agents:write` for the reload mutation.
 */
export async function agentRoutes(
  app: FastifyInstance,
  deps: RouteDeps,
): Promise<void> {
  function loadAndListAgents() {
    // Re-read agents.json so newly CLI-installed agents are visible without a server restart.
    // The file is tiny so per-request I/O is negligible in a local environment.
    deps.core.agentCatalog.load();
    const agents = deps.core.agentManager.getAvailableAgents();
    const defaultAgent = deps.core.configManager.get().defaultAgent;
    const agentsWithCaps = agents.map((a) => ({
      ...redactAgentEnv(a),
      capabilities: getAgentCapabilities(a.name),
    }));
    return { agents: agentsWithCaps, default: defaultAgent };
  }

  // GET /agents — list all available agents
  app.get('/', { preHandler: requireScopes('agents:read') }, async () => {
    return loadAndListAgents();
  });

  // POST /agents/reload — explicitly reload agent catalog from disk
  app.post('/reload', { preHandler: requireScopes('agents:write') }, async () => {
    return { ...loadAndListAgents(), reloaded: true };
  });

  // GET /agents/:name — get a single agent by name
  app.get('/:name', { preHandler: requireScopes('agents:read') }, async (request) => {
    const { name } = NameParamSchema.parse(request.params);
    const agent = deps.core.agentCatalog.getInstalledAgent(name);
    if (!agent) {
      throw new NotFoundError('AGENT_NOT_FOUND', `Agent "${name}" not found`);
    }
    return {
      ...redactAgentEnv(agent),
      key: name,
      capabilities: getAgentCapabilities(name),
    };
  });
}
