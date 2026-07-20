import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentDeliveryService } from '../../../core/attachment-delivery/index.js'
import type { IChannelAdapter } from '../../../core/channel.js'
import type { Session } from '../../../core/sessions/session.js'
import type { SessionManager } from '../../../core/sessions/session-manager.js'
import type { AttachmentDeliveryRequest } from '../../../core/types.js'
import { FileService } from '../../file-service/file-service.js'
import { requireScopes } from '../../api-server/middleware/auth.js'
import { attachmentDeliveryRoutes } from '../routes.js'

const apps: Array<ReturnType<typeof Fastify>> = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function multipart(metadata: Record<string, unknown>, data: Buffer) {
  const boundary = 'openacp-integration-boundary'
  const prefix = Buffer.from([
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${String(metadata.fileName)}"`,
    `Content-Type: ${String(metadata.mimeType)}`,
    '',
    '',
  ].join('\r\n'))
  return {
    payload: Buffer.concat([prefix, data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

describe('attachment delivery API integration', () => {
  it('resolves the canonical default Assistant and returns its provider receipt', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'openacp-attachment-integration-'))
    temporaryDirectories.push(root)
    const lease = Object.freeze({ adapterId: 'telegram', threadId: 'topic-42', generation: 7 })
    const session = {
      id: 'session-1',
      agentSessionId: 'agent-session-1',
      workingDirectory: '/workspace',
      channelId: 'telegram',
      threadId: 'topic-42',
      threadIds: new Map([['telegram', 'topic-42']]),
      status: 'active',
      isAssistant: true,
      isTerminating: false,
      archiving: false,
      agentGeneration: 1,
      captureAttachmentLease: vi.fn(() => lease),
      isAttachmentLeaseCurrent: vi.fn((candidate) => candidate === lease),
    } as unknown as Session
    const sessionManager = {
      getSession: vi.fn((id: string) => id === session.id ? session : undefined),
      getSessionByAgentSessionId: vi.fn((id: string) => id === session.agentSessionId ? session : undefined),
      getCurrentLiveSessionsByAgentSessionId: vi.fn(
        () => [],
      ),
      isCurrentLiveSession: vi.fn((candidate: Session) => candidate === session),
    } as unknown as SessionManager
    const providerDelivery = vi.fn(async (request: AttachmentDeliveryRequest) => {
      expect(request.targetBinding.threadId).toBe('topic-42')
      expect(request.targetBinding.isCurrent()).toBe(true)
      return {
        status: 'provider_accepted' as const,
        deliveryId: request.deliveryId,
        providerMessageId: 'telegram-message-8675309',
        adapterId: 'telegram',
        acceptedAt: '2026-07-20T12:00:00.000Z',
      }
    })
    const adapter = {
      name: 'telegram',
      capabilities: {
        streaming: true,
        richFormatting: true,
        threads: true,
        reactions: true,
        fileUpload: true,
        voice: true,
      },
      deliverAttachment: providerDelivery,
    } as unknown as IChannelAdapter
    const deliveryService = new AttachmentDeliveryService({
      sessionManager,
      adapters: new Map([['telegram', adapter]]),
      fileService: new FileService(path.join(root, 'files')),
      journalPath: path.join(root, 'journal', 'deliveries.json'),
      resolveDefaultAssistant: () => session,
    }, {
      targetSecret: Buffer.alloc(32, 7),
      deliveryTimeoutMs: 1_000,
    })

    const app = Fastify()
    apps.push(app)
    app.decorateRequest('auth', null, [])
    app.addHook('onRequest', async (request) => {
      request.auth = {
        type: 'jwt',
        tokenId: 'operator-token',
        role: 'operator',
        scopes: ['attachments:send'],
      }
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

    try {
      const resolved = await app.inject({
        method: 'POST',
        url: '/api/v1/attachment-delivery/v1/resolve',
        headers: { host: '127.0.0.1' },
        payload: {
          agentSessionId: 'missing-agent-session',
          expectedWorkingDirectory: '/workspace',
          allowDefaultAssistantFallback: true,
        },
      })
      expect(resolved.statusCode).toBe(200)
      expect(resolved.json().routeKind).toBe('default_assistant')
      const target = resolved.json().target
      expect(target).toMatchObject({ sessionId: 'session-1', adapterId: 'telegram' })
      expect(target).not.toHaveProperty('threadId')

      const data = Buffer.from('operator acceptance artifact\n')
      const metadata = {
        schemaVersion: 1,
        deliveryId: 'acceptance-delivery-1',
        target,
        fileName: 'acceptance.txt',
        mimeType: 'text/plain',
        size: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      }
      const body = multipart(metadata, data)
      const delivered = await app.inject({
        method: 'POST',
        url: '/api/v1/attachment-delivery/v1/deliver',
        headers: { host: 'localhost', 'content-type': body.contentType },
        payload: body.payload,
      })

      expect(delivered.statusCode).toBe(200)
      expect(delivered.json()).toEqual({
        status: 'provider_accepted',
        deliveryId: 'acceptance-delivery-1',
        providerMessageId: 'telegram-message-8675309',
        adapterId: 'telegram',
        acceptedAt: '2026-07-20T12:00:00.000Z',
      })
      expect(providerDelivery).toHaveBeenCalledOnce()
    } finally {
      await deliveryService.close()
    }
  })
})
