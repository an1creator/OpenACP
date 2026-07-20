import { createHash } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import { z } from 'zod'
import type { AttachmentDeliveryReceipt, AttachmentDeliveryTarget } from '../../core/types.js'

export const ATTACHMENT_DELIVERY_PROTOCOL_VERSION = 1
export const DEFAULT_ATTACHMENT_DELIVERY_MAX_BYTES = 50 * 1024 * 1024
export const DEFAULT_ATTACHMENT_DELIVERY_TIMEOUT_MS = 60_000

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/
const SAFE_ADAPTER_ID = /^[A-Za-z0-9._-]{1,100}$/
const MIME_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/
const SHA256 = /^[a-f0-9]{64}$/
const FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'cf-connecting-ip',
  'cf-ray',
] as const

const TargetSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().regex(SAFE_SESSION_ID),
  adapterId: z.string().regex(SAFE_ADAPTER_ID),
  bindingGeneration: z.string().min(1).max(200),
}).strict()

const RouteKindSchema = z.enum(['explicit_session', 'agent_session', 'default_assistant'])

const ResolveBodySchema = z.object({
  explicitSessionId: z.string().regex(SAFE_SESSION_ID).optional(),
  agentSessionId: z.string().min(1).max(300).optional(),
  expectedWorkingDirectory: z.string().min(1).max(4096).optional(),
  allowDefaultAssistantFallback: z.boolean().optional(),
}).strict().refine(
  (value) => Boolean(value.explicitSessionId) || Boolean(value.agentSessionId),
  'explicitSessionId or agentSessionId is required',
)

const MetadataSchema = z.object({
  schemaVersion: z.literal(1),
  deliveryId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  target: TargetSchema,
  fileName: z.string().min(1).max(255).refine(isSafeFileName, 'Invalid fileName'),
  mimeType: z.string().min(3).max(200).regex(MIME_TYPE),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256),
  caption: z.string().max(1024).optional(),
}).strict()

export interface AttachmentDeliveryServiceErrorShape {
  code: AttachmentDeliveryErrorCode
  retryable: boolean
  safeMessage: string
  httpStatus?: number
}

export type AttachmentDeliveryErrorCode =
  | 'target_unavailable'
  | 'target_stale'
  | 'target_mismatch'
  | 'unsupported_channel'
  | 'file_invalid'
  | 'hash_mismatch'
  | 'payload_too_large'
  | 'delivery_id_conflict'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'provider_rejected'
  | 'rate_limited'
  | 'internal_error'

export interface AttachmentDeliveryRouteService {
  resolveTarget(input: {
    explicitSessionId?: string
    agentSessionId?: string
    expectedWorkingDirectory?: string
    allowDefaultAssistantFallback?: boolean
  }): Promise<
    | {
        status: 'resolved'
        routeKind: 'explicit_session' | 'agent_session' | 'default_assistant'
        target: AttachmentDeliveryTarget
      }
    | { status: 'target_unavailable'; code: string; retryable: false; safeMessage: string }
  >
  deliver(input: {
    schemaVersion: 1
    deliveryId: string
    target: AttachmentDeliveryTarget
    fileName: string
    mimeType: string
    size: number
    sha256: string
    data: Buffer
    caption?: string
    signal: AbortSignal
  }): Promise<AttachmentDeliveryReceipt>
  health(): Promise<{
    status: 'ok' | 'unavailable'
    protocolVersion: 1
    serviceLoaded: boolean
    fileServiceAvailable: boolean
    maxFileSize: number
    adapters: Array<{
      adapterId: string
      available: boolean
      acknowledgedReceipt: boolean
      fileUpload: boolean
    }>
  }>
}

export interface AttachmentDeliveryRouteOptions {
  service: AttachmentDeliveryRouteService
  requireScope: preHandlerHookHandler
  maxFileSize?: number
  timeoutMs?: number
}

function isSafeFileName(value: string): boolean {
  if (value === '.' || value === '..') return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  return !/[\u0000-\u001f\u007f]/u.test(value)
}

function loopbackAddress(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '')
  return normalized === '127.0.0.1' || normalized === '::1'
}

/**
 * Rejects requests that did not originate from the local host.
 *
 * OpenACP tunnels proxy the shared API listener from a local child process, so
 * checking the socket address alone is insufficient. Forwarding headers and an
 * external Host value are rejected as additional proof that the request crossed
 * an HTTP proxy boundary.
 */
export async function requireAttachmentDeliveryLoopback(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const remoteAddress = request.raw.socket.remoteAddress
  const hostname = request.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const localHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
  const forwarded = FORWARDED_HEADERS.some((name) => request.headers[name] !== undefined)
  if (!loopbackAddress(remoteAddress) || !localHost || forwarded) {
    reply.status(403).send({
      status: 'error',
      code: 'target_unavailable',
      retryable: false,
      safeMessage: 'Attachment delivery is available only from the local host.',
    })
  }
}

function statusForCode(code: AttachmentDeliveryErrorCode): number {
  switch (code) {
    case 'file_invalid':
    case 'hash_mismatch': return 400
    case 'payload_too_large': return 413
    case 'target_unavailable': return 404
    case 'target_stale':
    case 'target_mismatch':
    case 'delivery_id_conflict': return 409
    case 'rate_limited': return 429
    case 'provider_timeout': return 504
    case 'unsupported_channel': return 422
    case 'provider_unavailable': return 503
    case 'provider_rejected': return 502
    case 'internal_error': return 500
  }
}

function safeError(error: unknown): AttachmentDeliveryServiceErrorShape {
  if (error && typeof error === 'object') {
    const candidate = error as Partial<AttachmentDeliveryServiceErrorShape>
    const knownCodes = new Set<AttachmentDeliveryErrorCode>([
      'target_unavailable', 'target_stale', 'target_mismatch', 'unsupported_channel',
      'file_invalid', 'hash_mismatch', 'payload_too_large', 'delivery_id_conflict',
      'provider_unavailable', 'provider_timeout', 'provider_rejected', 'rate_limited',
      'internal_error',
    ])
    if (candidate.code && knownCodes.has(candidate.code as AttachmentDeliveryErrorCode)) {
      return {
        code: candidate.code as AttachmentDeliveryErrorCode,
        retryable: candidate.retryable === true,
        safeMessage: typeof candidate.safeMessage === 'string' && candidate.safeMessage.length <= 500
          ? candidate.safeMessage
          : 'Attachment delivery failed.',
        ...(typeof candidate.httpStatus === 'number'
          && Number.isInteger(candidate.httpStatus)
          && candidate.httpStatus >= 400
          && candidate.httpStatus <= 599
          ? { httpStatus: candidate.httpStatus }
          : {}),
      }
    }
  }
  return { code: 'internal_error', retryable: false, safeMessage: 'Attachment delivery failed.' }
}

function sendError(reply: FastifyReply, error: AttachmentDeliveryServiceErrorShape): FastifyReply {
  const { httpStatus, ...body } = error
  return reply.status(httpStatus ?? statusForCode(error.code)).send({ status: 'error', ...body })
}

function validationError(reply: FastifyReply, code: 'file_invalid' | 'hash_mismatch' | 'payload_too_large', safeMessage: string): FastifyReply {
  return sendError(reply, { code, retryable: false, safeMessage })
}

/** Registers the authenticated, loopback-only attachment delivery protocol. */
export async function attachmentDeliveryRoutes(
  app: FastifyInstance,
  options: AttachmentDeliveryRouteOptions,
): Promise<void> {
  const maxFileSize = options.maxFileSize ?? DEFAULT_ATTACHMENT_DELIVERY_MAX_BYTES
  const timeoutMs = options.timeoutMs ?? DEFAULT_ATTACHMENT_DELIVERY_TIMEOUT_MS

  await app.register(fastifyMultipart, {
    limits: {
      files: 1,
      fields: 1,
      parts: 2,
      fileSize: maxFileSize,
      fieldNameSize: 32,
      fieldSize: 32 * 1024,
      headerPairs: 32,
    },
  })

  const preHandler = [requireAttachmentDeliveryLoopback, options.requireScope]

  app.post('/resolve', { preHandler, bodyLimit: 64 * 1024 }, async (request, reply) => {
    const parsed = ResolveBodySchema.safeParse(request.body)
    if (!parsed.success) return validationError(reply, 'file_invalid', 'Attachment target request is invalid.')
    try {
      const result = await options.service.resolveTarget(parsed.data)
      if (result.status === 'target_unavailable') {
        return reply.send({
          status: 'target_unavailable',
          code: result.code,
          retryable: false,
          safeMessage: result.safeMessage,
        })
      }
      const target = TargetSchema.parse(result.target)
      const routeKind = RouteKindSchema.parse(result.routeKind)
      return reply.send({ status: 'resolved', routeKind, target })
    } catch (error) {
      return sendError(reply, safeError(error))
    }
  })

  app.get('/health', { preHandler }, async (_request, reply) => {
    try {
      const health = await options.service.health()
      return reply.send({
        status: health.status,
        protocolVersion: ATTACHMENT_DELIVERY_PROTOCOL_VERSION,
        serviceLoaded: health.serviceLoaded === true,
        fileServiceAvailable: health.fileServiceAvailable === true,
        maxFileSize: Math.min(health.maxFileSize, maxFileSize),
        adapters: health.adapters.map((adapter) => ({
          adapterId: adapter.adapterId,
          available: adapter.available === true,
          acknowledgedReceipt: adapter.acknowledgedReceipt === true,
          fileUpload: adapter.fileUpload === true,
        })),
      })
    } catch (error) {
      return sendError(reply, safeError(error))
    }
  })

  app.post('/deliver', {
    preHandler,
    bodyLimit: maxFileSize + 64 * 1024,
  }, async (request, reply) => {
    let metadataText: string | undefined
    let upload: { filename: string; mimetype: string; data: Buffer; truncated: boolean } | undefined

    try {
      for await (const part of request.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || upload) {
            return validationError(reply, 'file_invalid', 'Multipart body must contain exactly one file part.')
          }
          const data = await part.toBuffer()
          upload = {
            filename: part.filename,
            mimetype: part.mimetype,
            data,
            truncated: part.file.truncated,
          }
        } else {
          if (part.fieldname !== 'metadata' || metadataText !== undefined || typeof part.value !== 'string') {
            return validationError(reply, 'file_invalid', 'Multipart body must contain exactly one metadata field.')
          }
          metadataText = part.value
        }
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT') {
        return validationError(reply, 'payload_too_large', 'Attachment payload exceeds the configured limit.')
      }
      return validationError(reply, 'file_invalid', 'Multipart attachment payload is invalid.')
    }

    if (!metadataText || !upload) {
      return validationError(reply, 'file_invalid', 'Multipart body requires metadata and one file.')
    }

    let rawMetadata: unknown
    try {
      rawMetadata = JSON.parse(metadataText)
    } catch {
      return validationError(reply, 'file_invalid', 'Attachment metadata is invalid JSON.')
    }
    const metadataResult = MetadataSchema.safeParse(rawMetadata)
    if (!metadataResult.success) return validationError(reply, 'file_invalid', 'Attachment metadata is invalid.')
    const metadata = metadataResult.data

    if (metadata.size > maxFileSize || upload.truncated || upload.data.length > maxFileSize) {
      return validationError(reply, 'payload_too_large', 'Attachment payload exceeds the configured limit.')
    }
    if (upload.filename !== metadata.fileName || upload.mimetype !== metadata.mimeType || upload.data.length !== metadata.size) {
      return validationError(reply, 'file_invalid', 'Uploaded file does not match its metadata.')
    }
    const actualSha256 = createHash('sha256').update(upload.data).digest('hex')
    if (actualSha256 !== metadata.sha256) {
      return validationError(reply, 'hash_mismatch', 'Uploaded file hash does not match its metadata.')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('attachment delivery timeout')), timeoutMs)
    timer.unref?.()
    request.raw.once('aborted', () => controller.abort(new Error('request aborted')))

    try {
      const receipt = await options.service.deliver({
        schemaVersion: 1,
        deliveryId: metadata.deliveryId,
        target: metadata.target,
        fileName: metadata.fileName,
        mimeType: metadata.mimeType,
        size: metadata.size,
        sha256: metadata.sha256,
        data: upload.data,
        ...(metadata.caption !== undefined ? { caption: metadata.caption } : {}),
        signal: controller.signal,
      })
      if (!receipt.providerMessageId || receipt.status !== 'provider_accepted') {
        return sendError(reply, {
          code: 'provider_rejected',
          retryable: false,
          safeMessage: 'Attachment provider did not acknowledge delivery.',
        })
      }
      return reply.send({
        status: 'provider_accepted',
        deliveryId: receipt.deliveryId,
        providerMessageId: receipt.providerMessageId,
        adapterId: receipt.adapterId,
        acceptedAt: receipt.acceptedAt,
      })
    } catch (error) {
      if (controller.signal.aborted) {
        return sendError(reply, {
          code: 'provider_timeout',
          retryable: true,
          safeMessage: 'Attachment provider timed out.',
        })
      }
      return sendError(reply, safeError(error))
    } finally {
      clearTimeout(timer)
    }
  })
}
