import type { FastifyPluginAsync, preHandlerHookHandler } from 'fastify'
import type { ApiServerInstance } from './server.js'
import { requireScopes, requireRole } from './middleware/auth.js'

export interface ApiServerService {
  registerPlugin(prefix: string, plugin: FastifyPluginAsync, opts?: { auth?: boolean }): void
  authPreHandler: preHandlerHookHandler
  requireScopes(...scopes: string[]): preHandlerHookHandler
  requireRole(role: string): preHandlerHookHandler
  getPort(): number
  getBaseUrl(): string
  getTunnelUrl(): string | null
}

export function createApiServerService(
  server: ApiServerInstance,
  opts: {
    getPort: () => number
    getBaseUrl: () => string
    getTunnelUrl: () => string | null
  },
): ApiServerService {
  return {
    registerPlugin: server.registerPlugin.bind(server),
    authPreHandler: server.authPreHandler,
    requireScopes,
    requireRole,
    getPort: opts.getPort,
    getBaseUrl: opts.getBaseUrl,
    getTunnelUrl: opts.getTunnelUrl,
  }
}
