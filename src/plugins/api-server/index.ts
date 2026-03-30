import type { OpenACPPlugin, InstallContext } from '../../core/plugin/types.js'
import type { OpenACPCore } from '../../core/core.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createChildLogger } from '../../core/utils/log.js'

const log = createChildLogger({ module: 'api-server' })

const DEFAULT_PORT_FILE = path.join(os.homedir(), '.openacp', 'api.port')
const DEFAULT_SECRET_FILE = path.join(os.homedir(), '.openacp', 'api-secret')
const DEFAULT_JWT_SECRET_FILE = path.join(os.homedir(), '.openacp', 'jwt-secret')
const DEFAULT_TOKENS_FILE = path.join(os.homedir(), '.openacp', 'tokens.json')

let cachedVersion: string | undefined
function getVersion(): string {
  if (cachedVersion) return cachedVersion
  try {
    const __filename = fileURLToPath(import.meta.url)
    const pkgPath = path.resolve(path.dirname(__filename), '../../../package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    cachedVersion = pkg.version ?? '0.0.0-dev'
  } catch {
    cachedVersion = '0.0.0-dev'
  }
  return cachedVersion!
}

function loadOrCreateSecret(secretFilePath: string): string {
  const dir = path.dirname(secretFilePath)
  fs.mkdirSync(dir, { recursive: true })

  try {
    const secret = fs.readFileSync(secretFilePath, 'utf-8').trim()
    if (secret) {
      // Warn if permissions too open
      try {
        const stat = fs.statSync(secretFilePath)
        const mode = stat.mode & 0o777
        if (mode & 0o077) {
          log.warn(
            { path: secretFilePath, mode: '0' + mode.toString(8) },
            'API secret file has insecure permissions (should be 0600). Run: chmod 600 %s',
            secretFilePath,
          )
        }
      } catch { /* stat failed */ }
      return secret
    }
  } catch { /* file doesn't exist */ }

  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(secretFilePath, secret, { mode: 0o600 })
  return secret
}

export interface ApiConfig {
  port: number
  host: string
}

function createApiServerPlugin(): OpenACPPlugin {
  let stopServer: (() => Promise<void>) | null = null

  return {
    name: '@openacp/api-server',
    version: '1.0.0',
    description: 'REST API + SSE streaming server (Fastify)',
    essential: false,
    permissions: ['services:register', 'kernel:access', 'events:read'],
    async install(ctx: InstallContext) {
      const { settings, legacyConfig, terminal } = ctx

      // Migrate from legacy config if present
      if (legacyConfig) {
        const apiCfg = legacyConfig.api as Record<string, unknown> | undefined
        if (apiCfg) {
          await settings.setAll({
            port: apiCfg.port ?? 21420,
            host: apiCfg.host ?? '127.0.0.1',
          })
          terminal.log.success('API server settings migrated from legacy config')
          return
        }
      }

      await settings.setAll({ port: 21420, host: '127.0.0.1' })
      terminal.log.success('API server defaults saved')
    },

    async configure(ctx: InstallContext) {
      const { terminal, settings } = ctx
      const current = await settings.getAll()

      const choice = await terminal.select({
        message: 'What to configure?',
        options: [
          { value: 'port', label: `Change port (current: ${current.port ?? 21420})` },
          { value: 'host', label: `Change host (current: ${current.host ?? '127.0.0.1'})` },
          { value: 'done', label: 'Done' },
        ],
      })

      if (choice === 'port') {
        const val = await terminal.text({
          message: 'API port:',
          defaultValue: String(current.port ?? 21420),
          validate: (v) => {
            const n = Number(v.trim())
            if (isNaN(n) || n < 1 || n > 65535) return 'Port must be 1-65535'
            return undefined
          },
        })
        await settings.set('port', Number(val.trim()))
        terminal.log.success('Port updated')
      } else if (choice === 'host') {
        const val = await terminal.text({
          message: 'API host:',
          defaultValue: (current.host as string) ?? '127.0.0.1',
        })
        await settings.set('host', val.trim())
        terminal.log.success('Host updated')
      }
    },

    async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
      if (opts.purge) {
        await ctx.settings.clear()
        ctx.terminal.log.success('API server settings cleared')
      }
    },

    async setup(ctx) {
      const config = ctx.pluginConfig as Record<string, unknown>
      const core = ctx.core as OpenACPCore

      const portFilePath = DEFAULT_PORT_FILE
      const secretFilePath = DEFAULT_SECRET_FILE

      const secret = loadOrCreateSecret(secretFilePath)
      const jwtSecret = loadOrCreateSecret(DEFAULT_JWT_SECRET_FILE)

      // Initialize TokenStore
      const { TokenStore } = await import('./auth/token-store.js')
      const tokenStore = new TokenStore(DEFAULT_TOKENS_FILE)
      await tokenStore.load()

      // Periodic cleanup of expired tokens (every hour)
      const cleanupInterval = setInterval(() => tokenStore.cleanup(), 60 * 60 * 1000)

      const apiConfig: ApiConfig = {
        port: (config.port as number) ?? 0,
        host: (config.host as string) ?? '127.0.0.1',
      }

      // Lazy-import Fastify server + routes + SSE to avoid loading at module level
      const { createApiServer } = await import('./server.js')
      const { createApiServerService } = await import('./service.js')
      const { SSEManager } = await import('./sse-manager.js')
      const { StaticServer } = await import('./static-server.js')
      const { sessionRoutesV1 } = await import('./routes/v1-sessions.js')
      const { systemRoutesV1 } = await import('./routes/v1-system.js')
      const { agentRoutesV1 } = await import('./routes/v1-agents.js')
      const { configRoutesV1 } = await import('./routes/v1-config.js')
      const { topicRoutesV1 } = await import('./routes/v1-topics.js')
      const { tunnelRoutesV1 } = await import('./routes/v1-tunnel.js')
      const { notifyRoutesV1 } = await import('./routes/v1-notify.js')
      const { commandRoutesV1 } = await import('./routes/v1-commands.js')
      const { authRoutesV1 } = await import('./routes/v1-auth.js')

      const startedAt = Date.now()
      const server = await createApiServer({
        port: apiConfig.port,
        host: apiConfig.host,
        getSecret: () => secret,
        getJwtSecret: () => jwtSecret,
        tokenStore,
      })

      // Get topic manager if telegram plugin is loaded
      let topicManager: any = undefined
      try {
        const telegramService = ctx.getService('telegram') as any
        topicManager = telegramService?.topicManager
      } catch { /* telegram not loaded */ }

      const routeDeps = { core, topicManager, startedAt, getVersion }

      // Register v1 routes (all authenticated via plugin-level onRequest hook)
      server.registerPlugin('/api/v1/sessions', (app) => sessionRoutesV1(app, routeDeps))
      server.registerPlugin('/api/v1/agents', (app) => agentRoutesV1(app, routeDeps))
      server.registerPlugin('/api/v1/config', (app) => configRoutesV1(app, routeDeps))
      server.registerPlugin('/api/v1/topics', (app) => topicRoutesV1(app, routeDeps))
      server.registerPlugin('/api/v1/tunnel', (app) => tunnelRoutesV1(app, routeDeps))
      server.registerPlugin('/api/v1/notify', (app) => notifyRoutesV1(app, routeDeps))
      server.registerPlugin('/api/v1/commands', (app) => commandRoutesV1(app, routeDeps))
      // Auth routes registered WITHOUT global auth — refresh needs to accept expired JWTs
      server.registerPlugin('/api/v1/auth', (app) => authRoutesV1(app, {
        tokenStore,
        getJwtSecret: () => jwtSecret,
        authPreHandler: server.authPreHandler,
      }), { auth: false })

      // System routes — health is unauthenticated, rest authenticated
      server.registerPlugin('/api/v1/system', (app) => systemRoutesV1(app, routeDeps), { auth: false })

      // SSE endpoint (legacy, will be superseded by SSE adapter in Plan 3)
      const sseManager = new SSEManager(
        core.eventBus,
        () => {
          const sessions = core.sessionManager.listSessions()
          return {
            active: sessions.filter((s) => s.status === 'active' || s.status === 'initializing').length,
            total: sessions.length,
          }
        },
        startedAt,
      )

      // Register SSE as authenticated Fastify route
      server.registerPlugin('/api/v1/events', async (app) => {
        app.get('/', async (request, reply) => {
          reply.hijack()
          const res = reply.raw
          sseManager.handleRequest(request.raw, res)
        })
      })

      // Backward compatibility: redirect old /api/* to /api/v1/*
      server.app.addHook('onRequest', async (request, reply) => {
        const url = request.url
        if (url.startsWith('/api/') && !url.startsWith('/api/v1/') && !url.startsWith('/api/docs')) {
          // Map old paths to new v1 paths
          const newUrl = url.replace('/api/', '/api/v1/')
          return reply.redirect(newUrl, 301)
        }
      })

      // Static file serving for UI dashboard
      const staticServer = new StaticServer()
      if (staticServer.isAvailable()) {
        server.app.addHook('onRequest', async (request, reply) => {
          // Only serve static files for non-API routes
          if (!request.url.startsWith('/api/')) {
            const served = staticServer.serve(request.raw, reply.raw)
            if (served) {
              reply.hijack()
            }
          }
        })
      }

      let actualPort = 0

      // Register ApiServerService for other plugins
      const service = createApiServerService(server, {
        getPort: () => actualPort,
        getBaseUrl: () => `http://127.0.0.1:${actualPort}`,
        getTunnelUrl: () => core.tunnelService?.getPublicUrl() ?? null,
      })
      ctx.registerService('api-server', service)

      // Start on system:ready
      ctx.on('system:ready', async () => {
        try {
          const addr = await server.start()
          actualPort = addr.port
          sseManager.setup()

          // Write port file
          const portDir = path.dirname(portFilePath)
          fs.mkdirSync(portDir, { recursive: true })
          fs.writeFileSync(portFilePath, String(actualPort))

          if (apiConfig.host !== '127.0.0.1' && apiConfig.host !== 'localhost') {
            log.warn('API server binding to non-localhost. Ensure api-secret file is secured.')
          }

          log.info({ host: apiConfig.host, port: actualPort }, 'API server listening')
        } catch (err) {
          log.error(`API server failed to start: ${err}`)
        }
      })

      stopServer = async () => {
        clearInterval(cleanupInterval)
        sseManager.stop()
        await tokenStore.save()
        try { fs.unlinkSync(portFilePath) } catch { /* ignore */ }
        await server.stop()
      }
    },

    async teardown() {
      if (stopServer) {
        await stopServer()
      }
    },
  }
}

export default createApiServerPlugin()
