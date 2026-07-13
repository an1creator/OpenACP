import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const nodeFetch = vi.hoisted(() => vi.fn())
const agentOptions = vi.hoisted(() => [] as Array<{ getProxyForUrl(target: string): string }>)
const ownershipRootRef = vi.hoisted(() => ({ value: '' }))

vi.mock('node-fetch', () => ({ default: nodeFetch }))
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    constructor(options: { getProxyForUrl(target: string): string }) { agentOptions.push(options) }
    destroy() {}
  },
}))
vi.mock('../../instance/instance-context.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getGlobalRoot: () => ownershipRootRef.value,
}))

import { ProxyService, PROXY_ENV_KEYS } from '../../network/proxy-service.js'
import { SettingsManager } from '../../plugin/settings-manager.js'
import { telegramCheck } from '../checks/telegram.js'
import type { DoctorContext } from '../types.js'
import { TelegramCommandOwnershipStore } from '../../../plugins/telegram/command-ownership-store.js'

const BOT_TOKEN = `123456789:${'A'.repeat(35)}`

function telegramResponse(input: RequestInfo | URL): Response {
  const url = String(input)
  if (url.endsWith('/getMe')) {
    return Response.json({ ok: true, result: { id: 42, username: 'test_bot' } })
  }
  if (url.endsWith('/getChatMember')) {
    return Response.json({ ok: true, result: { status: 'administrator' } })
  }
  if (url.endsWith('/getMyCommands')) {
    return Response.json({ ok: true, result: [{ command: 'proxy', description: 'Manage scoped proxy routing' }] })
  }
  return Response.json({ ok: true, result: { type: 'supergroup', is_forum: true, title: 'Test Group' } })
}

describe('Telegram doctor scoped transport', () => {
  let root: string
  const originalEnv = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-proxy-'))
    ownershipRootRef.value = path.join(root, 'global')
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
    const service = new ProxyService(root, undefined, undefined, async () => undefined)
    if (route === 'profile') {
      service.saveProfile({ id: 'usa', protocol: 'http', host: 'proxy.test', port: 8081, username: 'user', password: 'secret' })
      await service.setRoute('channels.telegram', 'profile:usa')
    } else {
      await service.setRoute('channels.telegram', 'direct')
    }

    const results = await telegramCheck.run(context(service))
    expect(results.every((result) => result.status === 'pass')).toBe(true)
    expect(nodeFetch).toHaveBeenCalledTimes(18)
    expect(forbiddenGlobalFetch).not.toHaveBeenCalled()
    const selectedProxy = agentOptions[0]?.getProxyForUrl('https://api.telegram.org')
    if (route === 'profile') expect(selectedProxy).toContain('proxy.test:8081')
    else expect(selectedProxy).toBe('')
  })

  it('warns when a stale chat-specific list hides /proxy from the default list', async () => {
    nodeFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.endsWith('/getMyCommands')) return telegramResponse(input)
      const scope = JSON.parse(String(init?.body)).scope as { type: string }
      if (scope.type === 'default') {
        return Response.json({ ok: true, result: [{ command: 'proxy', description: 'Manage proxy' }] })
      }
      if (scope.type === 'chat') {
        return Response.json({ ok: true, result: [{ command: 'help', description: 'Old help' }] })
      }
      return Response.json({ ok: true, result: [] })
    })
    const service = new ProxyService(root, undefined, undefined, async () => undefined)
    await service.setRoute('channels.telegram', 'direct')

    const results = await telegramCheck.run(context(service))

    expect(results).toContainEqual(expect.objectContaining({
      status: 'warn',
      message: expect.stringContaining('out of sync'),
    }))
    expect(results.at(-1)?.message).toContain('missing /proxy')
    expect(results.at(-1)?.message).toContain('Restart OpenACP')
  })

  it('warns without token or chat leakage when another instance owns command sync', async () => {
    const ownership = new TelegramCommandOwnershipStore(ownershipRootRef.value)
    await ownership.withLock(async ({ ledger }) => {
      ownership.claimOwner(ledger, '42', {
        instanceId: 'other-instance', instanceKey: '2'.repeat(64), hostId: 'a'.repeat(64), pid: process.pid,
      })
      ownership.save(ledger)
    })
    const service = new ProxyService(root, undefined, undefined, async () => undefined)
    await service.setRoute('channels.telegram', 'direct')

    const results = await telegramCheck.run(context(service))
    const warning = results.find((result) => result.message.includes('owned by another OpenACP instance'))
    expect(warning?.status).toBe('warn')
    expect(warning?.message).not.toContain(BOT_TOKEN)
    expect(warning?.message).not.toContain(String(-1001234567890))
  })

  it('warns accurately when only the Russian chat override hides /proxy', async () => {
    nodeFetch.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).endsWith('/getMyCommands')) return telegramResponse(input)
      const payload = JSON.parse(String(init?.body)) as { scope: { type: string }; language_code?: string }
      if (payload.scope.type === 'chat_administrators') return Response.json({ ok: true, result: [] })
      if (payload.scope.type === 'chat' && payload.language_code === 'ru') {
        return Response.json({ ok: true, result: [{ command: 'custom', description: 'Старая команда' }] })
      }
      return Response.json({ ok: true, result: [{ command: 'proxy', description: 'Manage proxy' }] })
    })
    const service = new ProxyService(root, undefined, undefined, async () => undefined)
    await service.setRoute('channels.telegram', 'direct')

    const results = await telegramCheck.run(context(service))

    expect(results.at(-1)).toMatchObject({ status: 'warn' })
    expect(results.at(-1)?.message).toContain('ru members')
    expect(results.at(-1)?.message).toContain('ru administrators')
    expect(results.at(-1)?.message).not.toContain('en members')
  })

  it('reports command-list inspection failures as actionable non-fatal warnings', async () => {
    nodeFetch.mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/getMyCommands')) throw new Error('temporary network failure')
      return telegramResponse(input)
    })
    const service = new ProxyService(root, undefined, undefined, async () => undefined)
    await service.setRoute('channels.telegram', 'direct')

    const results = await telegramCheck.run(context(service))

    expect(results.at(-1)).toMatchObject({ status: 'warn' })
    expect(results.at(-1)?.message).toContain('Cannot verify Telegram command menus')
    expect(results.at(-1)?.message).toContain('inspect Telegram connectivity logs')
    expect(results.some((result) => result.message === 'Bot is admin in group')).toBe(true)
  })

  it('returns an actionable failure when the configured route cannot be resolved', async () => {
    const ctx = context(new ProxyService(root, undefined, undefined, async () => undefined))
    ctx.fetchForScope = () => { throw new Error('Proxy profile "missing" does not exist') }
    const results = await telegramCheck.run(ctx)
    expect(results.at(-1)).toMatchObject({ status: 'fail' })
    expect(results.at(-1)?.message).toContain('Cannot initialize Telegram transport')
    expect(results.at(-1)?.message).toContain('missing')
  })

  it('redacts Telegram and proxy credentials from transport failures', async () => {
    const ctx = context(new ProxyService(root, undefined, undefined, async () => undefined))
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
