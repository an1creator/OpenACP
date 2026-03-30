import Fastify, { type FastifyInstance, type FastifyPluginAsync, type preHandlerHookHandler } from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifySwagger from '@fastify/swagger'
import fastifySwaggerUi from '@fastify/swagger-ui'
import fastifyRateLimit from '@fastify/rate-limit'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { globalErrorHandler } from './middleware/error-handler.js'
import { createAuthPreHandler } from './middleware/auth.js'

export interface ApiServerOptions {
  port: number
  host: string
  getSecret: () => string
  getJwtSecret?: () => string
  tokenStore?: import('./auth/token-store.js').TokenStore
  logger?: boolean
}

export interface ApiServerInstance {
  app: FastifyInstance
  authPreHandler: preHandlerHookHandler
  start(): Promise<{ port: number; host: string }>
  stop(): Promise<void>
  registerPlugin(prefix: string, plugin: FastifyPluginAsync, opts?: { auth?: boolean }): void
}

export async function createApiServer(options: ApiServerOptions): Promise<ApiServerInstance> {
  const app = Fastify({ logger: options.logger ?? false })

  // Zod validation
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  // Plugins
  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyRateLimit, { max: 100, timeWindow: '1 minute' })
  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'OpenACP API', version: '1.0.0', description: 'OpenACP REST API' },
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  })
  await app.register(fastifySwaggerUi, { routePrefix: '/api/docs' })

  // Global error handler
  app.setErrorHandler(globalErrorHandler)

  // Auth pre-handler (supports secret token + optional JWT)
  const authPreHandler = createAuthPreHandler(options.getSecret, options.getJwtSecret, options.tokenStore)

  // Decorate request with auth object
  app.decorateRequest('auth', undefined as any)

  // System routes are registered via index.ts (v1-system.ts) — not here
  // This avoids duplicate route registration

  return {
    app,
    authPreHandler,

    registerPlugin(prefix: string, plugin: FastifyPluginAsync, opts?: { auth?: boolean }) {
      const wrappedPlugin: FastifyPluginAsync = async (pluginApp, _opts) => {
        if (opts?.auth !== false) {
          pluginApp.addHook('onRequest', authPreHandler)
        }
        await plugin(pluginApp, _opts)
      }
      app.register(wrappedPlugin, { prefix })
    },

    async start() {
      await app.ready()
      const address = await app.listen({ port: options.port, host: options.host })
      const url = new URL(address)
      return { port: Number(url.port), host: url.hostname }
    },

    async stop() {
      await app.close()
    },
  }
}
