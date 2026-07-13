import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureJsonOutput, expectValidJsonError, expectValidJsonSuccess } from './helpers/json-test-utils.js'

const apiCall = vi.hoisted(() => vi.fn())
vi.mock('../../api-client.js', () => ({
  readApiPort: vi.fn().mockReturnValue(21420),
  apiCall,
}))

describe('proxy CLI automation contract', () => {
  let tempDir: string

  beforeEach(() => {
    apiCall.mockReset()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-proxy-cli-'))
  })

  afterEach(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  function fixture(name: string, value: string, mode = 0o600): string {
    const file = path.join(tempDir, name)
    fs.writeFileSync(file, value, { mode })
    fs.chmodSync(file, mode)
    return file
  }

  it('preserves --name extracted as a global instance flag', async () => {
    const envFile = fixture('proxy.env', 'HTTP_PROXY=http://proxy.test:8080\n')
    apiCall.mockResolvedValue(new Response(JSON.stringify({ ok: true, profile: { id: 'usa', name: 'USA Squid' } }), { status: 200 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(
      ['import', 'usa', '--env-file', envFile, '--json'],
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

  it('preserves stable proxy API conflict codes in JSON mode', async () => {
    apiCall.mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'PROXY_REVISION_CONFLICT', message: 'Proxy policy changed concurrently' },
    }), { status: 409 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(
      ['delete', 'old', '--expected-revision', '2', '--json'], '/tmp/instance',
    ))
    expect(result.exitCode).toBe(1)
    expect(expectValidJsonError(result.stdout)).toMatchObject({ code: 'PROXY_REVISION_CONFLICT' })
  })

  it('passes expected revision for route set and clear', async () => {
    apiCall.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const { cmdProxy } = await import('../proxy.js')
    await cmdProxy(['set', 'agents.codex', 'direct', '--expected-revision', '17'], '/tmp/instance')
    let request = apiCall.mock.calls[0][2] as RequestInit
    expect(JSON.parse(String(request.body))).toEqual({ route: 'direct', expectedRevision: 17 })

    apiCall.mockClear()
    await cmdProxy(['clear', 'agents.codex', '--expected-revision', '18'], '/tmp/instance')
    expect(apiCall.mock.calls[0][1]).toContain('expectedRevision=18')
  })

  it('renders status as human sections outside JSON mode without exposing credentials', async () => {
    apiCall.mockResolvedValue(new Response(JSON.stringify({
      profiles: [{ id: 'work', name: 'Work proxy', protocol: 'http', host: 'proxy.test', port: 8080, hasCredentials: true }],
      routing: { global: 'direct', routes: { 'agents.codex': 'profile:work' } },
      diagnostics: [{ scope: 'agents.codex', route: 'profile:work', resolvedFrom: 'agents.codex' }],
      environment: { compatibilityMode: false, daemonWideProxyActive: false },
    }), { status: 200 }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { cmdProxy } = await import('../proxy.js')
    await cmdProxy(['status'], '/tmp/instance')
    const output = log.mock.calls.map(([line]) => String(line)).join('\n')
    log.mockRestore()
    expect(output).toContain('Network proxy')
    expect(output).toContain('Proxy profiles')
    expect(output).toContain('Saved route overrides')
    expect(output).toContain('Effective routes')
    expect(output).toContain('Route overrides: 1')
    expect(output).toContain('Codex: Use profile “Work proxy”')
    expect(output).toContain('(source: Codex)')
    expect(output).toContain('http://proxy.test:8080')
    expect(output).not.toContain('agents.codex')
    expect(output).not.toContain('HTTP://')
    expect(output).toContain('credentials saved (hidden)')
    expect(output).not.toContain('password')
    expect(output.trim().startsWith('{')).toBe(false)
  })

  it('passes protected proxyUrl JSON as the exclusive endpoint representation', async () => {
    const file = fixture('url.json', JSON.stringify({ proxyUrl: 'socks5h://alice:secret@proxy.test:1080', name: 'Private' }))
    apiCall.mockResolvedValue(new Response(JSON.stringify({ ok: true, profile: { id: 'private', name: 'Private', hasCredentials: true } }), { status: 200 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(['create', 'private', '--from-json', file, '--json'], '/tmp/instance'))
    expect(result.exitCode).toBe(0)
    expectValidJsonSuccess(result.stdout)
    const body = JSON.parse(String((apiCall.mock.calls[0][2] as RequestInit).body))
    expect(body).toMatchObject({ id: 'private', proxyUrl: 'socks5h://alice:secret@proxy.test:1080' })
    expect(body.protocol).toBeUndefined()
    expect(result.stdout).not.toContain('secret')
  })

  it('rejects protected JSON that mixes proxyUrl and endpoint components', async () => {
    const file = fixture('mixed.json', JSON.stringify({ proxyUrl: 'http://proxy.test:8080', protocol: 'http', host: 'proxy.test', port: 8080 }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(['create', 'mixed', '--from-json', file, '--json'], '/tmp/instance'))
    expect(expectValidJsonError(result.stdout)).toMatchObject({ code: 'PROXY_INPUT_SCHEMA_INVALID' })
    expect(apiCall).not.toHaveBeenCalled()
  })

  it('rejects a 101-character profile name locally before any API call', async () => {
    const file = fixture('long-name.json', JSON.stringify({ name: 'x'.repeat(101), proxyUrl: 'http://proxy.test:8080' }))
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(['create', 'long-name', '--from-json', file, '--json'], '/tmp/instance'))
    expect(expectValidJsonError(result.stdout)).toMatchObject({ code: 'PROXY_INPUT_SCHEMA_INVALID' })
    expect(apiCall).not.toHaveBeenCalled()
  })

  it.each([
    ['insecure JSON mode', 'PROXY_INPUT_FILE_INSECURE', () => fixture('insecure.json', '{}', 0o644)],
    ['missing JSON file', 'PROXY_INPUT_FILE_NOT_FOUND', () => path.join(tempDir, 'missing.json')],
    ['invalid JSON syntax', 'PROXY_INPUT_JSON_INVALID', () => fixture('invalid.json', '{not-json')],
    ['invalid profile schema', 'PROXY_INPUT_SCHEMA_INVALID', () => fixture('schema.json', '{}')],
  ])('returns one typed JSON envelope for %s', async (_label, expectedCode, makeFile) => {
    const file = makeFile()
    const { cmdProxy } = await import('../proxy.js')
    const result = await captureJsonOutput(() => cmdProxy(
      ['test-candidate', 'acceptance-crud', '--from-json', file, '--json'], '/tmp/instance',
    ))
    expect(result.exitCode).toBe(1)
    expect(expectValidJsonError(result.stdout)).toMatchObject({ code: expectedCode })
    expect(result.stdout).not.toContain(file)
    expect(result.stdout).not.toContain('at ')
    expect(apiCall).not.toHaveBeenCalled()
  })

  it('types missing arguments and insecure env imports before any API call', async () => {
    const { cmdProxy } = await import('../proxy.js')
    const missing = await captureJsonOutput(() => cmdProxy(['delete', '--json'], '/tmp/instance'))
    expect(expectValidJsonError(missing.stdout)).toMatchObject({ code: 'PROXY_MISSING_ARGUMENT' })

    const envFile = fixture('insecure.env', 'HTTP_PROXY=http://proxy.test:8080\n', 0o644)
    const insecure = await captureJsonOutput(() => cmdProxy(
      ['import', 'x', '--env-file', envFile, '--json'], '/tmp/instance',
    ))
    expect(expectValidJsonError(insecure.stdout)).toMatchObject({ code: 'PROXY_INPUT_FILE_INSECURE' })
    expect(apiCall).not.toHaveBeenCalled()
  })
})
