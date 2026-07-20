import type { CheckResult, DoctorCheck } from '../types.js'
import { apiCall, readApiPort } from '../../../cli/api-client.js'

interface AttachmentDeliveryHealthResponse {
  status?: string
  protocolVersion?: number
  serviceLoaded?: boolean
  fileServiceAvailable?: boolean
  maxFileSize?: number
  adapters?: Array<{
    adapterId?: string
    available?: boolean
    acknowledgedReceipt?: boolean
    fileUpload?: boolean
  }>
}

/** Verifies the running daemon's acknowledged attachment-delivery service. */
export const attachmentDeliveryCheck: DoctorCheck = {
  name: 'Attachment delivery',
  order: 83,
  async run(ctx): Promise<CheckResult[]> {
    const port = readApiPort(ctx.portFilePath)
    if (port === null) {
      return [{
        status: 'warn',
        message: 'Attachment delivery runtime check skipped because the daemon API is not running',
      }]
    }

    try {
      const response = await apiCall(port, '/api/v1/attachment-delivery/v1/health', {
        signal: AbortSignal.timeout(5_000),
      }, ctx.dataDir)
      if (!response.ok) {
        return [{
          status: 'fail',
          message: `Attachment delivery health endpoint returned HTTP ${response.status}`,
        }]
      }

      const health = await response.json() as AttachmentDeliveryHealthResponse
      if (
        health.protocolVersion !== 1
        || health.serviceLoaded !== true
        || health.fileServiceAvailable !== true
      ) {
        return [{ status: 'fail', message: 'Attachment delivery service is not ready' }]
      }

      const acknowledged = health.adapters?.filter((adapter) =>
        adapter.available === true
        && adapter.acknowledgedReceipt === true
        && adapter.fileUpload === true,
      ) ?? []
      if (acknowledged.length === 0) {
        return [{
          status: 'warn',
          message: 'Attachment delivery service and file staging are ready, but no connected adapter supports acknowledged file delivery',
        }]
      }

      if (health.status !== 'ok') {
        return [{ status: 'fail', message: 'Attachment delivery service reported an inconsistent adapter state' }]
      }

      const names = acknowledged
        .map((adapter) => adapter.adapterId)
        .filter((name): name is string => typeof name === 'string')
      return [{
        status: 'pass',
        message: `Attachment delivery ready (protocol v1; adapters: ${names.join(', ')})`,
      }]
    } catch {
      return [{ status: 'fail', message: 'Attachment delivery health request failed' }]
    }
  },
}
