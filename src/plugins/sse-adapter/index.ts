import type { OpenACPPlugin } from '../../core/plugin/types.js'
import type { OpenACPCore } from '../../core/core.js'
import type { ApiServerService } from '../api-server/service.js'

function createSSEAdapterPlugin(): OpenACPPlugin {
  let adapter: { stop(): Promise<void> } | null = null

  return {
    name: '@openacp/sse-adapter',
    version: '1.0.0',
    description: 'SSE-based messaging adapter for app clients',
    essential: false,
    permissions: ['services:register', 'kernel:access', 'events:read'],

    async setup(ctx) {
      const core = ctx.core as OpenACPCore

      const { SSEAdapter } = await import('./adapter.js')
      const { ConnectionManager } = await import('./connection-manager.js')
      const { EventBuffer } = await import('./event-buffer.js')
      const { createSSERoutes } = await import('./routes.js')

      const connectionManager = new ConnectionManager()
      const eventBuffer = new EventBuffer(100)
      const sseAdapter = new SSEAdapter(connectionManager, eventBuffer)

      // Register as adapter in core
      core.registerAdapter('sse', sseAdapter)

      // Register routes into API server (if available)
      try {
        const apiService = ctx.getService<ApiServerService>('api-server')
        if (apiService) {
          apiService.registerPlugin('/api/v1/sse', (app) =>
            createSSERoutes(app, { connectionManager, eventBuffer, core }),
          )
        }
      } catch {
        ctx.log.warn('API server service not available — SSE routes not registered')
      }

      await sseAdapter.start()
      adapter = sseAdapter

      ctx.log.info('SSE adapter started')
    },

    async teardown() {
      if (adapter) {
        await adapter.stop()
      }
    },
  }
}

export default createSSEAdapterPlugin()
