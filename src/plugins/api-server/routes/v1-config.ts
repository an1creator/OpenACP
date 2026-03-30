import type { FastifyInstance } from 'fastify'
import type { RouteDeps } from './types.js'

const SENSITIVE_KEYS = ['botToken', 'token', 'apiKey', 'secret', 'password', 'webhookSecret']

function redactConfig(config: unknown): unknown {
  const redacted = structuredClone(config)
  redactDeep(redacted as Record<string, unknown>)
  return redacted
}

function redactDeep(obj: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.includes(key) && typeof value === 'string') {
      obj[key] = '***'
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') redactDeep(item as Record<string, unknown>)
      }
    } else if (value && typeof value === 'object') {
      redactDeep(value as Record<string, unknown>)
    }
  }
}

export async function configRoutesV1(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const { core } = deps

  // GET /editable — safe fields with metadata
  app.get('/editable', async () => {
    const { getSafeFields, resolveOptions, getConfigValue } = await import('../../../core/config/config-registry.js')
    const config = core.configManager.get()
    const safeFields = getSafeFields()

    const fields = safeFields.map((def) => ({
      path: def.path,
      displayName: def.displayName,
      group: def.group,
      type: def.type,
      options: resolveOptions(def, config),
      value: getConfigValue(config, def.path),
      hotReload: def.hotReload,
    }))

    return { fields }
  })

  // GET / — full config (redacted)
  app.get('/', async () => {
    const config = core.configManager.get()
    return { config: redactConfig(config) }
  })

  // PATCH / — update config field
  app.patch<{ Body: { path?: string; value?: unknown } }>('/', async (request, reply) => {
    const { path: configPath, value } = request.body ?? {}

    if (!configPath) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Missing path', statusCode: 400 },
      })
    }

    // Block prototype pollution
    const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
    const parts = configPath.split('.')
    if (parts.some((p) => BLOCKED_KEYS.has(p))) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: 'Invalid config path', statusCode: 400 },
      })
    }

    // Enforce safe-fields scope
    const { getFieldDef } = await import('../../../core/config/config-registry.js')
    const fieldDef = getFieldDef(configPath)
    if (!fieldDef || fieldDef.scope !== 'safe') {
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'This config field cannot be modified via the API', statusCode: 403 },
      })
    }

    // Pre-validate by cloning config and applying the change
    const currentConfig = core.configManager.get()
    const cloned = structuredClone(currentConfig) as Record<string, unknown>
    let target: Record<string, unknown> = cloned
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]
      if (target[part] && typeof target[part] === 'object' && !Array.isArray(target[part])) {
        target = target[part] as Record<string, unknown>
      } else if (target[part] === undefined || target[part] === null) {
        target[part] = {}
        target = target[part] as Record<string, unknown>
      } else {
        return reply.status(400).send({
          error: { code: 'BAD_REQUEST', message: 'Invalid config path', statusCode: 400 },
        })
      }
    }

    const lastKey = parts[parts.length - 1]
    target[lastKey] = value

    const { ConfigSchema } = await import('../../../core/config/config.js')
    const result = ConfigSchema.safeParse(cloned)
    if (!result.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Validation failed',
          statusCode: 400,
          details: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      })
    }

    // Convert dot-path to nested object for save
    const updates: Record<string, unknown> = {}
    let updateTarget = updates
    for (let i = 0; i < parts.length - 1; i++) {
      updateTarget[parts[i]] = {}
      updateTarget = updateTarget[parts[i]] as Record<string, unknown>
    }
    updateTarget[lastKey] = value

    await core.configManager.save(updates, configPath)

    const { isHotReloadable } = await import('../../../core/config/config-registry.js')
    const needsRestart = !isHotReloadable(configPath)

    return { ok: true, needsRestart, config: redactConfig(core.configManager.get()) }
  })
}
