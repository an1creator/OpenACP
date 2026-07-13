import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { RouteDeps } from './types.js'
import { requireScopes } from '../middleware/auth.js'
import { AuthError, BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from '../middleware/error-handler.js'
import { PROXY_CONNECTIVITY_TEST_URL, ProxyProfileExistsError, ProxyProfileNotFoundError, ProxyProfileTestError, ProxyRouteTestError, ProxyValidationError } from '../../../core/network/proxy-service.js'
import { ProxyRevisionConflictError, ProxyStoreCorruptError } from '../../../core/network/proxy-store.js'
import { hasScope } from '../auth/roles.js'
import { lookup } from 'node:dns/promises'
import net from 'node:net'

const SAFE_TEST_HOSTS = new Set([new URL(PROXY_CONNECTIVITY_TEST_URL).hostname, 'ifconfig.me', 'httpbin.org'])

const RouteSchema = z.string().refine(
  (value) => value === 'direct' || value === 'inherit' || /^profile:[a-z0-9][a-z0-9._-]{0,63}$/i.test(value),
  'Route must be direct, inherit, or profile:<id>',
)

const ProfileBaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
  // Canonical trim/non-empty/max validation lives in ProxyService so every
  // caller receives the stable PROXY_VALIDATION_ERROR contract.
  name: z.string().optional(),
  proxyUrl: z.string().min(1).max(8192).optional(),
  protocol: z.enum(['http', 'https', 'socks5', 'socks5h']).optional(),
  host: z.string().min(1).max(253).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  noProxy: z.array(z.string()).optional(),
  failClosed: z.boolean().optional(),
  clearCredentials: z.boolean().optional(),
})

function refineProfileInput(
  value: Partial<z.infer<typeof ProfileBaseSchema>>,
  ctx: z.RefinementCtx,
): void {
  const componentFields = [value.protocol, value.host, value.port, value.username, value.password, value.clearCredentials]
  if (value.proxyUrl !== undefined && componentFields.some((field) => field !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Use either proxyUrl or separate endpoint/credential fields, not both' })
  }
  if (value.proxyUrl === undefined && (!value.protocol || !value.host || value.port === undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Provide protocol, host, and port when proxyUrl is not used' })
  }
}

const ProfileSchema = ProfileBaseSchema.superRefine(refineProfileInput)

/** Redacted proxy management API. Credential input is write-only. */
export async function proxyRoutes(app: FastifyInstance, deps: RouteDeps): Promise<void> {
  const service = deps.core.proxyService

  app.get('/', { preHandler: requireScopes('config:read') }, async () => service.status())

  app.post('/profiles', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    let profile
    const body = ProfileBaseSchema.extend({ expectedRevision: z.number().int().nonnegative().optional() })
      .superRefine(refineProfileInput).parse(request.body)
    const { expectedRevision, ...input } = body
    try { profile = await service.createProfileSafely(input, expectedRevision) }
    catch (error) {
      if (error instanceof ProxyProfileTestError) throw new BadRequestError(error.code, error.message)
      throwProxyApiError(error)
    }
    return { ok: true, profile }
  })

  app.put('/profiles/:id', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    const { id } = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i) }).parse(request.params)
    const body = ProfileBaseSchema.omit({ id: true }).extend({ expectedRevision: z.number().int().nonnegative().optional() })
      .superRefine(refineProfileInput).parse(request.body)
    const { expectedRevision, ...input } = body
    try { return { ok: true, profile: await service.updateProfileSafely({ id, ...input }, expectedRevision) } }
    catch (error) {
      if (error instanceof ProxyProfileTestError) throw new BadRequestError(error.code, error.message)
      throwProxyApiError(error)
    }
  })

  app.post('/profiles/test-candidate', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    const body = ProfileBaseSchema.extend({ targetUrl: z.string().url().optional() })
      .superRefine(refineProfileInput).parse(request.body)
    if (body.targetUrl) await assertSafeTestTarget(body.targetUrl)
    const { targetUrl, ...input } = body
    try { return await service.testProfileCandidate(input, targetUrl) }
    catch (error) { throwProxyApiError(error) }
  })

  app.post('/profiles/import-env', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    const body = z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
      envFile: z.string().min(1),
      name: z.string().min(1).max(100).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
    }).parse(request.body)
    let profile
    try {
      profile = await service.importEnvFileSafely(body.id, body.envFile, body.name, body.expectedRevision)
    }
    catch (error) {
      if (error instanceof ProxyProfileTestError) throw new BadRequestError(error.code, error.message)
      throwProxyApiError(error)
    }
    return { ok: true, profile }
  })

  app.delete('/profiles/:id', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params)
    const { expectedRevision, reassign } = z.object({
      expectedRevision: z.coerce.number().int().nonnegative().optional(),
      reassign: RouteSchema.optional(),
    }).parse(request.query)
    try { return { ok: true, ...(await service.deleteProfileSafely(id, reassign as import('../../../core/network/proxy-types.js').ProxyRoute | undefined, expectedRevision)) } }
    catch (error) { throwProxyApiError(error) }
  })

  app.put('/routes/:scope', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    const { scope } = z.object({ scope: z.string().min(1).max(160) }).parse(request.params)
    const { route, expectedRevision } = z.object({ route: RouteSchema, expectedRevision: z.number().int().nonnegative().optional() }).parse(request.body)
    try {
      return { ok: true, change: await service.setRoute(scope, route as import('../../../core/network/proxy-types.js').ProxyRoute, expectedRevision) }
    } catch (error) {
      if (error instanceof ProxyRouteTestError) throw new BadRequestError(error.code, error.message)
      throwProxyApiError(error)
    }
  })

  app.delete('/routes/:scope', { preHandler: requireScopes('network:proxy:manage') }, async (request) => {
    const { scope } = z.object({ scope: z.string().min(1).max(160) }).parse(request.params)
    const { expectedRevision } = z.object({ expectedRevision: z.coerce.number().int().nonnegative().optional() }).parse(request.query)
    try { await service.clearRoute(scope, expectedRevision) } catch (error) { throwProxyApiError(error) }
    return { ok: true, resolution: service.resolve(scope) }
  })

  app.post('/test', { preHandler: requireScopes('config:read') }, async (request) => {
    const body = z.object({
      scope: z.string().optional(),
      profile: z.string().optional(),
      targetUrl: z.string().url().optional(),
    }).refine((value) => Boolean(value.scope) !== Boolean(value.profile), 'Specify exactly one of scope or profile').parse(request.body)
    if (body.targetUrl) {
      if (!hasScope(request.auth.scopes, 'network:proxy:manage')) throw new AuthError('FORBIDDEN', 'Custom proxy test targets require network:proxy:manage', 403)
      await assertSafeTestTarget(body.targetUrl)
    }
    let result
    try {
      result = body.profile
        ? await service.testProfile(body.profile, body.targetUrl)
        : await service.test(body.scope!, body.targetUrl)
    } catch (error) { throwProxyApiError(error) }
    return { ...result, target: body.profile ? { profile: body.profile } : { scope: body.scope } }
  })
}

function throwProxyApiError(error: unknown): never {
  if (error instanceof ProxyRevisionConflictError) throw new ConflictError(error.code, error.message)
  if (error instanceof ProxyRouteTestError) throw new BadRequestError(error.code, error.message)
  if (error instanceof ProxyProfileExistsError) throw new ConflictError(error.code, `${error.message}; use PUT to update it`)
  if (error instanceof ProxyStoreCorruptError) throw new ServiceUnavailableError(error.code, error.message)
  if (error instanceof ProxyProfileNotFoundError) throw new NotFoundError(error.code, error.message)
  if (error instanceof ProxyValidationError) throw new BadRequestError(error.code, error.message)
  throw error
}

async function assertSafeTestTarget(raw: string): Promise<void> {
  const url = new URL(raw)
  if (url.protocol !== 'https:' || url.username || url.password) throw new BadRequestError('PROXY_TEST_TARGET_INVALID', 'Custom test target must be an HTTPS URL without credentials')
  if (!SAFE_TEST_HOSTS.has(url.hostname.toLowerCase())) throw new BadRequestError('PROXY_TEST_TARGET_BLOCKED', 'Custom test target host is not in the approved diagnostic allowlist')
  let addresses: Array<{ address: string }>
  try { addresses = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }) }
  catch { throw new BadRequestError('PROXY_TEST_TARGET_INVALID', 'Custom test target could not be resolved') }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new BadRequestError('PROXY_TEST_TARGET_BLOCKED', 'Custom test target resolves to a private, loopback, link-local, or metadata address')
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 10 || a === 127 || a === 0 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51)
      || (a === 203 && b === 0)
  }
  const value = address.toLowerCase()
  if (value.startsWith('::ffff:') && net.isIP(value.slice(7)) === 4) return isPrivateAddress(value.slice(7))
  return value === '::1' || value === '::' || value.startsWith('fe8') || value.startsWith('fe9')
    || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('fc')
    || value.startsWith('fd') || value.startsWith('ff') || value.startsWith('2001:db8:')
}
