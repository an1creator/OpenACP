import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requireScopes } from '../../api-server/middleware/auth.js'
import {
  attachmentDeliveryRoutes,
  type AttachmentDeliveryRouteService,
} from '../routes.js'

const apps: Array<ReturnType<typeof Fastify>> = []

function service(): AttachmentDeliveryRouteService {
  return {
    resolveTarget: vi.fn(async () => ({
      status: 'resolved' as const,
      target: {
        schemaVersion: 1 as const,
        sessionId: 'session-1',
        adapterId: 'telegram',
        bindingGeneration: 'generation-1',
      },
    })),
    deliver: vi.fn(async (input) => ({
      status: 'provider_accepted' as const,
      deliveryId: input.deliveryId,
      providerMessageId: '12345',
      adapterId: 'telegram',
      acceptedAt: '2026-07-20T00:00:00.000Z',
    })),
    health: vi.fn(async () => ({
      status: 'ok' as const,
      protocolVersion: 1 as const,
      serviceLoaded: true,
      fileServiceAvailable: true,
      maxFileSize: 1024,
      adapters: [{
        adapterId: 'telegram',
        available: true,
        acknowledgedReceipt: true,
        fileUpload: true,
      }],
    })),
  }
}

async function appFor(deliveryService: AttachmentDeliveryRouteService) {
  const app = Fastify()
  apps.push(app)
  app.decorateRequest('auth', null, [])
  app.addHook('onRequest', async (request) => {
    const scopes = String(request.headers['x-test-scopes'] ?? '').split(',').filter(Boolean)
    request.auth = { type: 'jwt', tokenId: 'test-token', role: 'operator', scopes }
  })
  await app.register(async (scope) => {
    await attachmentDeliveryRoutes(scope, {
      service: deliveryService,
      requireScope: requireScopes('attachments:send'),
      maxFileSize: 1024,
      timeoutMs: 1_000,
    })
  }, { prefix: '/api/v1/attachment-delivery/v1' })
  await app.ready()
  return app
}

function multipart(metadata: Record<string, unknown>, data: Buffer, options?: { fileName?: string; mimeType?: string }) {
  const boundary = 'openacp-attachment-boundary'
  const prefix = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${options?.fileName ?? metadata.fileName}"`,
    `Content-Type: ${options?.mimeType ?? metadata.mimeType}`,
    '',
    '',
  ].join('\r\n'))
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([prefix, data, suffix]),
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-test-scopes': 'attachments:send',
      host: '127.0.0.1',
    },
  }
}

function metadata(data: Buffer) {
  return {
    schemaVersion: 1,
    deliveryId: 'delivery-1',
    target: {
      schemaVersion: 1,
      sessionId: 'session-1',
      adapterId: 'telegram',
      bindingGeneration: 'generation-1',
    },
    fileName: 'memory.md',
    mimeType: 'text/markdown',
    size: data.length,
    sha256: 'a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447',
    caption: 'Saved memory',
  }
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('attachment delivery routes', () => {
  it('resolves a secret-free immutable target for a scoped local caller', async () => {
    const deliveryService = service()
    const app = await appFor(deliveryService)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attachment-delivery/v1/resolve',
      headers: { 'x-test-scopes': 'attachments:send', host: 'localhost' },
      payload: { agentSessionId: 'agent-session-1', expectedWorkingDirectory: '/workspace' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'resolved',
      target: {
        schemaVersion: 1,
        sessionId: 'session-1',
        adapterId: 'telegram',
        bindingGeneration: 'generation-1',
      },
    })
  })

  it('rejects a caller without attachments:send', async () => {
    const deliveryService = service()
    const app = await appFor(deliveryService)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/attachment-delivery/v1/health',
      headers: { host: 'localhost' },
    })
    expect(response.statusCode).toBe(403)
    expect(deliveryService.health).not.toHaveBeenCalled()
  })

  it('rejects tunneled forwarding evidence before invoking the service', async () => {
    const deliveryService = service()
    const app = await appFor(deliveryService)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/attachment-delivery/v1/health',
      headers: {
        host: 'public-tunnel.example',
        'x-forwarded-for': '203.0.113.10',
        'x-test-scopes': 'attachments:send',
      },
    })
    expect(response.statusCode).toBe(403)
    expect(response.json()).toEqual({
      status: 'error',
      code: 'target_unavailable',
      retryable: false,
      safeMessage: 'Attachment delivery is available only from the local host.',
    })
    expect(deliveryService.health).not.toHaveBeenCalled()
  })

  it('health never invokes delivery', async () => {
    const deliveryService = service()
    const app = await appFor(deliveryService)
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/attachment-delivery/v1/health',
      headers: { 'x-test-scopes': 'attachments:send', host: '127.0.0.1' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ status: 'ok', protocolVersion: 1 })
    expect(deliveryService.health).toHaveBeenCalledOnce()
    expect(deliveryService.deliver).not.toHaveBeenCalled()
  })

  it('validates multipart content and returns the provider receipt', async () => {
    const data = Buffer.from('hello world\n')
    const deliveryService = service()
    const app = await appFor(deliveryService)
    const body = multipart(metadata(data), data)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attachment-delivery/v1/deliver',
      headers: body.headers,
      payload: body.payload,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      status: 'provider_accepted',
      deliveryId: 'delivery-1',
      providerMessageId: '12345',
      adapterId: 'telegram',
      acceptedAt: '2026-07-20T00:00:00.000Z',
    })
    expect(deliveryService.deliver).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'delivery-1',
      data,
      sha256: metadata(data).sha256,
      signal: expect.any(AbortSignal),
    }))
  })

  it('rejects a hash mismatch before delivery', async () => {
    const data = Buffer.from('hello world\n')
    const deliveryService = service()
    const app = await appFor(deliveryService)
    const invalid = { ...metadata(data), sha256: '0'.repeat(64) }
    const body = multipart(invalid, data)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/attachment-delivery/v1/deliver',
      headers: body.headers,
      payload: body.payload,
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ status: 'error', code: 'hash_mismatch' })
    expect(deliveryService.deliver).not.toHaveBeenCalled()
  })
})
