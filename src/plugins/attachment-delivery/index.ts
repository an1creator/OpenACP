import path from 'node:path'
import { z } from 'zod'
import type { OpenACPCore } from '../../core/core.js'
import { AttachmentDeliveryService } from '../../core/attachment-delivery/index.js'
import type { FileServiceInterface, OpenACPPlugin } from '../../core/plugin/types.js'
import type { ApiServerService } from '../api-server/service.js'
import {
  attachmentDeliveryRoutes,
  DEFAULT_ATTACHMENT_DELIVERY_MAX_BYTES,
  DEFAULT_ATTACHMENT_DELIVERY_TIMEOUT_MS,
} from './routes.js'

const DEFAULT_TARGET_TTL_MS = 5 * 60_000

const SettingsSchema = z.object({
  maxFileSizeBytes: z.number().int().positive().max(DEFAULT_ATTACHMENT_DELIVERY_MAX_BYTES).default(
    DEFAULT_ATTACHMENT_DELIVERY_MAX_BYTES,
  ),
  deliveryTimeoutMs: z.number().int().positive().max(5 * 60_000).default(
    DEFAULT_ATTACHMENT_DELIVERY_TIMEOUT_MS,
  ),
  targetTtlMs: z.number().int().positive().max(60 * 60_000).default(DEFAULT_TARGET_TTL_MS),
})

type AttachmentDeliverySettings = z.infer<typeof SettingsSchema>

function createAttachmentDeliveryPlugin(): OpenACPPlugin {
  let service: AttachmentDeliveryService | null = null

  return {
    name: '@openacp/attachment-delivery',
    version: '1.0.0',
    description: 'Authenticated local attachment delivery with provider acknowledgements',
    essential: false,
    pluginDependencies: {
      '@openacp/file-service': '^1.0.0',
      '@openacp/api-server': '^1.0.0',
    },
    permissions: ['services:register', 'services:use', 'storage:read', 'kernel:access'],
    settingsSchema: SettingsSchema,

    async setup(ctx) {
      const config = ctx.pluginConfig as AttachmentDeliverySettings
      const core = ctx.core as OpenACPCore
      const fileService = ctx.getService<FileServiceInterface>('file-service')
      const apiServer = ctx.getService<ApiServerService>('api-server')
      if (!fileService) throw new Error('Attachment delivery requires the file-service plugin')
      if (!apiServer) throw new Error('Attachment delivery requires the api-server plugin')

      const dataDir = ctx.storage.getDataDir()
      service = new AttachmentDeliveryService({
        sessionManager: core.sessionManager,
        adapters: core.adapters,
        fileService,
        journalPath: path.join(dataDir, 'delivery-journal.json'),
        resolveDefaultAssistant: () => core.assistantManager.get('telegram'),
      }, {
        maxFileSizeBytes: config.maxFileSizeBytes,
        deliveryTimeoutMs: config.deliveryTimeoutMs,
        targetTtlMs: config.targetTtlMs,
      })

      ctx.registerService('attachment-delivery', service)
      apiServer.registerPlugin('/api/v1/attachment-delivery/v1', async (app) => {
        await attachmentDeliveryRoutes(app, {
          service: service!,
          requireScope: apiServer.requireScopes('attachments:send'),
          maxFileSize: config.maxFileSizeBytes,
          timeoutMs: config.deliveryTimeoutMs,
        })
      })
      ctx.log.info('Attachment delivery service ready')
    },

    async teardown() {
      const activeService = service
      service = null
      if (activeService) await activeService.close()
    },
  }
}

export default createAttachmentDeliveryPlugin()
