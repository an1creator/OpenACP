import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nodeFetch = vi.hoisted(() => vi.fn())
const agentOptions = vi.hoisted(() => [] as Array<{ getProxyForUrl(target: string): string }>)

vi.mock('node-fetch', () => ({ default: nodeFetch }))
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    constructor(options: { getProxyForUrl(target: string): string }) { agentOptions.push(options) }
    destroy() {}
  },
}))

import { ProxyService, PROXY_ENV_KEYS } from '../../network/proxy-service.js'
import { SettingsManager } from '../../plugin/settings-manager.js'
import { telegramCheck } from '../checks/telegram.js'
import type { DoctorContext } from '../types.js'

const BOT_TOKEN = `123456789:${'A'.repeat(35)}`

function telegramResponse(input: RequestInfo | URL): Response {
  const url = String(input)
  if (url.endsWith('/getMe')) {
    return Response.json({ ok: true, result: { id: 42, username: 'test_bot' } })
  }
  if (url.endsWith('/getChatMember')) {
    return Response.json({ ok: true, result: { status: 'administrator' } })
  }
  return Response.json({ ok: true, result: { type: 'supergroup', is_forum: true, title: 'Test Group' } })
}

describe('Telegram doctor scoped transport', () => {
  let root: string
  const originalEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-proxy-'))
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    nodeFetch.mockReset().mockImplementation(async (input) => telegramResponse(input))
    agentOptions.length = 0
    await new SettingsManager(path.join(root, 'plugins', 'data')).updatePluginSettings('@openacp/telegram', {
      botToken: BOT_TOKEN,
      chatId: -1001234567890,
    })
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    for (const key of PROXY_ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key]
      else process.env[key] = originalEnv[key]
    }
    vi.unstubAllGlobals()
  })

  function context(service: ProxyService): DoctorContext {
    return {
      config: { channels: {}, agents: {}, defaultAgent: 'test' } as any,
      rawConfig: {}, configPath: path.join(root, 'config.json'), dataDir: root,
      sessionsPath: path.join(root, 'sessions.json'), pidPath: path.join(root, 'openacp.pid'),
      portFilePath: path.join(root, 'api.port'), pluginsDir: path.join(root, 'plugins'),
      logsDir: path.join(root, 'logs'), fetchForScope: (scope) => service.createFetch(scope),
    }
  }

  it.each(['direct', 'profile'] as const)('passes in a clean environment through the %s route', async (route) => {
    const forbiddenGlobalFetch = vi.fn().mockRejectedValue(new Error('unexpected global fetch'))
    vi.stubGlobal('fetch', forbiddenGlobalFetch)
    const service = new ProxyService(root)
    if (route === 'profile') {
      service.saveProfile({ id: 'usa', protocol: 'http', host: 'proxy.test', port: 8081, username: 'user', password: 'secret' })
      await service.setRoute('channels.telegram', 'profile:usa')
    } else {
      await service.setRoute('channels.telegram', 'direct')
    }

    const results = await telegramCheck.run(context(service))
    expect(results.every((result) => result.status === 'pass')).toBe(true)
    expect(nodeFetch).toHaveBeenCalledTimes(3)
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled()
    const selectedProxy = agentOptions[0]?.getProxyForUrl('https://api.telegram.org')
    if (route === 'profile') expect(selectedProxy).toContain('proxy.test:8081')
    else expect(selectedProxy).toBe('')
  })

  it('returns an actionable failure when the configured route cannot be resolved', async () => {
    const ctx = context(new ProxyService(root))
    ctx.fetchForScope = () => { throw new Error('Proxy profile "missing" does not exist') }
    const results = await telegramCheck.run(ctx)
    expect(results.at(-1)).toMatchObject({ status: 'fail' })
    expect(results.at(-1)?.message).toContain('Cannot initialize Telegram transport')
    expect(results.at(-1)?.message).toContain('missing')
  })

  it('redacts Telegram and proxy credentials from transport failures', async () => {
    const ctx = context(new ProxyService(root))
    const proxyPassword = 'proxy-password'
    ctx.fetchForScope = () => (async () => {
      throw new Error(
        `request to https://api.telegram.org/bot${BOT_TOKEN}/getMe via http://user:${proxyPassword}@proxy.test:8081?token=query-secret failed`,
      )
    }) as typeof fetch
    const results = await telegramCheck.run(ctx)
    const serialized = JSON.stringify(results)
    expect(serialized).toContain('api.telegram.org/bot<redacted>/getMe')
    expect(serialized).toContain('http://<redacted>@proxy.test:8081?token=<redacted>')
    expect(serialized).not.toContain(BOT_TOKEN)
    expect(serialized).not.toContain(proxyPassword)
    expect(serialized).not.toContain('query-secret')
  })
})
