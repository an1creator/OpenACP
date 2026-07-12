import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureJsonOutput, expectValidJsonError, expectValidJsonSuccess } from './helpers/json-test-utils.js'

const apiCall = vi.hoisted(() => vi.fn())
vi.mock('../../api-client.js', () => ({
  readApiPort: vi.fn().mockReturnValue(21420),
  apiCall,
}))

describe('proxy CLI automation contract', () => {
  beforeEach(() => apiCall.mockReset())

  it('preserves --name extracted as a global instance flag', async () => {
    apiCall.mockResolvedValue(new Response(JSON.stringify({ ok: true, profile: { id: 'usa', name: 'USA Squid' } }), { status: 200 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(
      ['import', 'usa', '--env-file', '/protected/proxy.env', '--json'],
      '/tmp/instance',
      'USA Squid',
    ))
    expect(result.exitCode).toBe(0)
    expectValidJsonSuccess(result.stdout)
    const request = apiCall.mock.calls[0][2] as RequestInit
    expect(JSON.parse(String(request.body))).toMatchObject({ id: 'usa', name: 'USA Squid' })
  })

  it('returns non-zero typed JSON when connectivity result is ok=false', async () => {
    apiCall.mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'connect ECONNREFUSED 127.0.0.1:9' }), { status: 200 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(['test', '--profile', 'bad', '--json'], '/tmp/instance'))
    expect(result.exitCode).toBe(1)
    const error = expectValidJsonError(result.stdout)
    expect(error).toMatchObject({ code: 'PROXY_TEST_FAILED' })
    expect(error.message).toContain('ECONNREFUSED')
  })

  it('returns actionable typed JSON for transactional route rejection', async () => {
    const telegramToken = '123456789:cli-test-secret-token'
    apiCall.mockResolvedValue(new Response(JSON.stringify({
      error: {
        code: 'PROXY_ROUTE_TEST_FAILED',
        message: `Proxy route test failed for channels.telegram; route was not changed: request to https://api.telegram.org/bot${telegramToken}/getMe failed`,
        statusCode: 400,
      },
    }), { status: 400 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(['set', 'channels.telegram', 'profile:bad', '--json'], '/tmp/instance'))
    expect(result.exitCode).toBe(1)
    const error = expectValidJsonError(result.stdout)
    expect(error).toMatchObject({ code: 'PROXY_ROUTE_TEST_FAILED' })
    expect(error.message).toContain('route was not changed')
    expect(error.message).toContain('api.telegram.org/bot<redacted>/getMe')
    expect(result.stdout).not.toContain(telegramToken)
    expect(result.stdout).not.toContain('/home/')
  })
})
