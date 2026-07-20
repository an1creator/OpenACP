import { beforeEach, describe, expect, it, vi } from 'vitest'

const readApiPort = vi.fn()
const apiCall = vi.fn()

vi.mock('../../../cli/api-client.js', () => ({ readApiPort, apiCall }))

function context() {
  return {
    portFilePath: '/instance/api.port',
    dataDir: '/instance',
  } as any
}

describe('attachment delivery doctor check', () => {
  beforeEach(() => {
    readApiPort.mockReset()
    apiCall.mockReset()
  })

  it('reports the acknowledged adapter without sending a file', async () => {
    readApiPort.mockReturnValue(21420)
    apiCall.mockResolvedValue(new Response(JSON.stringify({
      status: 'ok',
      protocolVersion: 1,
      serviceLoaded: true,
      fileServiceAvailable: true,
      maxFileSize: 1024,
      adapters: [{
        adapterId: 'telegram',
        available: true,
        acknowledgedReceipt: true,
        fileUpload: true,
      }],
    }), { status: 200 }))

    const { attachmentDeliveryCheck } = await import('../checks/attachment-delivery.js')
    await expect(attachmentDeliveryCheck.run(context())).resolves.toEqual([{
      status: 'pass',
      message: 'Attachment delivery ready (protocol v1; adapters: telegram)',
    }])
    expect(apiCall).toHaveBeenCalledWith(
      21420,
      '/api/v1/attachment-delivery/v1/health',
      expect.not.objectContaining({ method: 'POST' }),
      '/instance',
    )
  })

  it('warns when the daemon is offline', async () => {
    readApiPort.mockReturnValue(null)
    const { attachmentDeliveryCheck } = await import('../checks/attachment-delivery.js')
    const [result] = await attachmentDeliveryCheck.run(context())
    expect(result?.status).toBe('warn')
    expect(apiCall).not.toHaveBeenCalled()
  })

  it('warns when file staging is ready but no acknowledged adapter is connected', async () => {
    readApiPort.mockReturnValue(21420)
    apiCall.mockResolvedValue(new Response(JSON.stringify({
      status: 'unavailable',
      protocolVersion: 1,
      serviceLoaded: true,
      fileServiceAvailable: true,
      maxFileSize: 1024,
      adapters: [],
    }), { status: 200 }))
    const { attachmentDeliveryCheck } = await import('../checks/attachment-delivery.js')
    await expect(attachmentDeliveryCheck.run(context())).resolves.toEqual([{
      status: 'warn',
      message: 'Attachment delivery service and file staging are ready, but no connected adapter supports acknowledged file delivery',
    }])
    expect(apiCall).toHaveBeenCalledOnce()
  })

  it('fails on an unavailable runtime service without exposing the response body', async () => {
    readApiPort.mockReturnValue(21420)
    apiCall.mockResolvedValue(new Response('provider token secret', { status: 503 }))
    const { attachmentDeliveryCheck } = await import('../checks/attachment-delivery.js')
    await expect(attachmentDeliveryCheck.run(context())).resolves.toEqual([{
      status: 'fail',
      message: 'Attachment delivery health endpoint returned HTTP 503',
    }])
  })
})
