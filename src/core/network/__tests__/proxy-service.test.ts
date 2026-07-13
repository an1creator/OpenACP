import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fetchMock = vi.hoisted(() => vi.fn(async () => ({ ok: true, status: 200 })))
const agentOptions = vi.hoisted(() => [] as Array<{ getProxyForUrl(target: string): string }>)

vi.mock('node-fetch', () => ({ default: fetchMock }))
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    constructor(options: { getProxyForUrl(target: string): string }) { agentOptions.push(options) }
  },
}))

import { ProxyProfileExistsError, ProxyProfileNotFoundError, ProxyService, ProxyValidationError, PROXY_ENV_KEYS } from '../proxy-service.js'

describe('ProxyService', () => {
  let root: string
  let service: ProxyService

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-proxy-'))
    service = new ProxyService(root)
    fetchMock.mockClear()
    agentOptions.length = 0
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('resolves exact route before category default before global', async () => {
    service.saveProfile({ id: 'usa', protocol: 'http', host: 'proxy.test', port: 8080 })
    await service.setRoute('global', 'direct')
    await service.setRoute('agents.default', 'profile:usa')
    expect(service.resolve('agents.cursor').route).toBe('profile:usa')
    expect(service.resolve('agents.cursor').resolvedFrom).toBe('agents.default')
    await service.setRoute('agents.cursor', 'inherit')
    expect(service.resolve('agents.cursor').route).toBe('inherit')
    expect(service.resolve('channels.discord').route).toBe('direct')
  })

  it('keeps services.speech durable and inherits services.default until explicitly routed', async () => {
    service.saveProfile({ id: 'speech', protocol: 'http', host: 'speech-proxy.test', port: 8080 })
    await service.setRoute('services.default', 'profile:speech')
    expect(service.getKnownScopes()).toContain('services.speech')
    expect(service.resolve('services.speech')).toMatchObject({ route: 'profile:speech', resolvedFrom: 'services.default' })
    await service.setRoute('services.speech', 'direct')
    expect(service.resolve('services.speech')).toMatchObject({ route: 'direct', resolvedFrom: 'services.speech' })
    expect(service.status().diagnostics.some((item) => item.scope === 'services.speech')).toBe(true)
  })

  it('keeps create/update existence semantics atomic across service instances', async () => {
    const other = new ProxyService(root)
    const input = { id: 'race', protocol: 'http' as const, host: 'proxy.test', port: 8080 }
    const results = await Promise.allSettled([
      service.createProfileSafely(input),
      other.createProfileSafely({ ...input, host: 'other.test' }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    expect(rejected?.reason).toBeInstanceOf(ProxyProfileExistsError)

    const deleteFirst = service.deleteProfileSafely('race')
    const queuedUpdate = service.updateProfileSafely({ ...input, host: 'must-not-resurrect.test' })
    await deleteFirst
    await expect(queuedUpdate).rejects.toBeInstanceOf(ProxyProfileNotFoundError)
    expect(service.getProfile('race')).toBeUndefined()
  })

  it('rejects overlong or whitespace-only profile names with a typed validation error before network or persistence', () => {
    expect(() => service.saveProfile({ id: 'long-name', name: 'x'.repeat(101), protocol: 'http', host: 'proxy.test', port: 8080 }))
      .toThrow(ProxyValidationError)
    expect(() => service.saveProfile({ id: 'blank-name', name: '   ', protocol: 'http', host: 'proxy.test', port: 8080 }))
      .toThrow(ProxyValidationError)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(service.listProfiles()).toEqual([])
  })

  it('scrubs every inherited proxy variable for direct agent routes', async () => {
    await service.setRoute('global', 'direct')
    const inherited = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, 'secret-proxy']))
    const env = service.buildAgentEnv('cursor', { ...inherited, PATH: '/bin', NODE_OPTIONS: '--trace-warnings --use-env-proxy' })
    for (const key of PROXY_ENV_KEYS) {
      if (key === 'NODE_USE_ENV_PROXY') expect(env[key]).toBe('0')
      else expect(env[key]).toBeUndefined()
    }
    expect(env.PATH).toBe('/bin')
    expect(env.NODE_OPTIONS).toBe('--trace-warnings')
  })

  it('uses an explicit direct transport even when the daemon has proxy env', async () => {
    const previous = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://daemon-wide-proxy:8080'
    try {
      await service.setRoute('channels.telegram', 'direct')
      await service.createFetch('channels.telegram')('https://api.telegram.org')
      expect(agentOptions.at(-1)?.getProxyForUrl('https://api.telegram.org')).toBe('')
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = previous
    }
  })

  it('injects standards-based HTTP child env without exposing credentials in status', async () => {
    service = new ProxyService(root, undefined, new Set(['--use-env-proxy']))
    service.saveProfile({ id: 'usa', protocol: 'https', host: 'proxy.test', port: 8443, username: 'alice', password: 'topsecret' })
    await service.setRoute('agents.codex', 'profile:usa')
    const env = service.buildAgentEnv('codex', { PATH: '/bin' })
    expect(env.HTTP_PROXY).toContain('alice:topsecret@proxy.test:8443')
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY)
    expect(env.NODE_OPTIONS).toContain('--use-env-proxy')
    const serialized = JSON.stringify(service.status())
    expect(serialized).not.toContain('topsecret')
    expect(serialized).not.toContain('alice:topsecret')
    expect(serialized).toContain('"hasCredentials":true')
  })

  it.each([
    { runtime: 'Node 20', flags: new Set<string>(), expectsNodeOption: false },
    { runtime: 'Node 24', flags: new Set(['--use-env-proxy']), expectsNodeOption: true },
  ])('builds safe HTTP proxy child env for $runtime capability', async ({ flags, expectsNodeOption }) => {
    service = new ProxyService(root, undefined, flags)
    service.saveProfile({ id: 'compat', protocol: 'http', host: 'proxy.test', port: 8080 })
    await service.setRoute('agents.codex', 'profile:compat')
    const env = service.buildAgentEnv('codex', { PATH: process.env.PATH ?? '', NODE_OPTIONS: '--trace-warnings' })

    expect(env.HTTP_PROXY).toBe('http://proxy.test:8080/')
    expect(env.HTTPS_PROXY).toBe(env.HTTP_PROXY)
    expect(env.NODE_USE_ENV_PROXY).toBe('1')
    expect(env.NODE_OPTIONS).toContain('--trace-warnings')
    expect(env.NODE_OPTIONS?.includes('--use-env-proxy')).toBe(expectsNodeOption)

    if (!expectsNodeOption) {
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
        env: { ...process.env, ...env },
      })
      expect(child.status).toBe(0)
      expect(child.stderr.toString()).toBe('')
    }
  })

  it('uses the current Node runtime capability by default', async () => {
    service.saveProfile({ id: 'runtime', protocol: 'http', host: 'proxy.test', port: 8080 })
    await service.setRoute('agents.codex', 'profile:runtime')
    const env = service.buildAgentEnv('codex', {})
    expect(env.HTTP_PROXY).toBe('http://proxy.test:8080/')
    expect(env.NODE_OPTIONS?.includes('--use-env-proxy') ?? false).toBe(
      process.allowedNodeEnvironmentFlags.has('--use-env-proxy'),
    )
  })

  it.each(['http', 'https', 'socks5', 'socks5h'] as const)('builds a real proxy-agent transport for %s', async (protocol) => {
    service.saveProfile({ id: 'route', protocol, host: 'proxy.test', port: 9000, username: 'u', password: 'p' })
    await service.createFetch('channels.telegram', 'profile:route')('https://example.test')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(agentOptions[0].getProxyForUrl('https://example.test')).toBe(`${protocol}://u:p@proxy.test:9000${protocol.startsWith('socks') ? '' : '/'}`)
  })

  it('accepts a write-only proxy URL with encoded credentials and IPv6 for candidate tests', async () => {
    const result = await service.testProfileCandidate({
      id: 'url-candidate',
      proxyUrl: 'socks5h://alice:pa%3Ass%40word@[2001:db8::9]:1080',
    })
    expect(result).toEqual({ ok: true, status: 200 })
    expect(agentOptions.at(-1)?.getProxyForUrl('https://example.test')).toBe(
      'socks5h://alice:pa%3Ass%40word@[2001:db8::9]:1080',
    )
    expect(JSON.stringify(service.status())).not.toContain('pa:ss@word')
  })

  it('accepts an explicit default port and clears old credentials when replacement URL has no auth', async () => {
    service.saveProfile({ id: 'replace', protocol: 'http', host: 'old.test', port: 8080, username: 'old', password: 'secret' })
    const updated = await service.updateProfileSafely({ id: 'replace', proxyUrl: 'http://new.test:80' })
    expect(updated).toMatchObject({ host: 'new.test', port: 80, hasCredentials: false })
    await service.setRoute('agents.codex', 'profile:replace')
    expect(service.buildAgentEnv('codex', {}).HTTP_PROXY).toBe('http://new.test/')
  })

  it.each([
    'http://proxy.test',
    'http://proxy.test:8080/private',
    'http://proxy.test:8080?token=value',
    'ftp://proxy.test:21',
    'http://proxy.test:8080\nignored',
  ])('rejects unsafe or incomplete proxy URL input without echoing it: %s', (proxyUrl) => {
    expect(() => service.parseProxyUrlInput(proxyUrl)).toThrow()
    try { service.parseProxyUrlInput(proxyUrl) } catch (error) {
      expect((error as Error).message).not.toContain(proxyUrl)
    }
  })

  it('honors profile noProxy without affecting unrelated process traffic', async () => {
    service.saveProfile({ id: 'scoped', protocol: 'http', host: 'proxy.test', port: 8080, noProxy: ['localhost', '*.internal.test'] })
    await service.createFetch('channels.telegram', 'profile:scoped')('https://example.test')
    expect(agentOptions[0].getProxyForUrl('http://localhost:21420/health')).toBe('')
    expect(agentOptions[0].getProxyForUrl('https://api.internal.test')).toBe('')
    expect(agentOptions[0].getProxyForUrl('https://api.telegram.org')).toContain('proxy.test')
  })

  it('reuses a scoped transport and replaces it after route mutation', async () => {
    service.saveProfile({ id: 'one', protocol: 'http', host: 'one.test', port: 8080 })
    service.saveProfile({ id: 'two', protocol: 'http', host: 'two.test', port: 8080 })
    await service.setRoute('channels.telegram', 'profile:one')
    expect(service.createFetch('channels.telegram')).toBe(service.createFetch('channels.telegram'))
    await service.setRoute('channels.telegram', 'profile:two')
    expect(service.createFetch('channels.telegram')).not.toBe(service.createFetch('channels.telegram', 'profile:one'))
  })

  it('reports SOCKS child-process capability gap instead of promising support', async () => {
    service.saveProfile({ id: 'tor', protocol: 'socks5h', host: '127.0.0.1', port: 1080 })
    await service.setRoute('agents.codex', 'profile:tor')
    const diagnostic = service.status().diagnostics.find((item) => item.scope === 'agents.codex')
    expect(diagnostic?.childProcessSupport).toBe('best-effort-socks-env')
    expect(diagnostic?.warning).toContain('ALL_PROXY')
  })

  it('persists secrets in a mode-0600 file separate from routes', async () => {
    service.saveProfile({ id: 'private', protocol: 'http', host: 'proxy.test', port: 8080, password: 'hidden' })
    await service.setRoute('channels.telegram', 'profile:private')
    const secrets = path.join(root, 'proxy-secrets.json')
    const config = path.join(root, 'proxy.json')
    expect(fs.statSync(secrets).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(secrets, 'utf8')).toContain('hidden')
    expect(fs.readFileSync(config, 'utf8')).not.toContain('hidden')
  })

  it('imports a protected env file without retaining the source path', () => {
    const envFile = path.join(root, 'legacy.env')
    fs.writeFileSync(envFile, 'HTTPS_PROXY=http://user:pass@proxy.test:8081\nNO_PROXY=localhost,127.0.0.1\n', { mode: 0o600 })
    const profile = service.importEnvFile('legacy', envFile)
    expect(profile).toMatchObject({ id: 'legacy', protocol: 'http', host: 'proxy.test', port: 8081, hasCredentials: true })
    expect(JSON.stringify(service.status())).not.toContain('pass')
    expect(fs.readFileSync(path.join(root, 'proxy.json'), 'utf8')).not.toContain(envFile)
  })

  it('imports bracketed IPv6 proxy URLs without double brackets', async () => {
    const envFile = path.join(root, 'ipv6.env')
    fs.writeFileSync(envFile, 'HTTPS_PROXY=http://user:pass@[2001:db8::7]:8081\n', { mode: 0o600 })
    expect(service.importEnvFile('ipv6env', envFile).host).toBe('2001:db8::7')
    await service.setRoute('agents.codex', 'profile:ipv6env')
    expect(service.buildAgentEnv('codex', {}).HTTPS_PROXY).toBe('http://user:pass@[2001:db8::7]:8081/')
  })

  it('uses the same durable scope grammar at runtime and in the store', () => {
    const longScope = `plugins.${'long_segment_'.repeat(8)}flow`
    expect(longScope.length).toBeGreaterThan(64)
    service.registerScope(longScope)
    expect(new ProxyService(root).getKnownScopes()).toContain(longScope)
  })

  it('rejects an insecure env file', () => {
    const envFile = path.join(root, 'open.env')
    fs.writeFileSync(envFile, 'HTTPS_PROXY=http://proxy.test:8081\n', { mode: 0o644 })
    fs.chmodSync(envFile, 0o644)
    expect(() => service.importEnvFile('legacy', envFile)).toThrow('mode 0600')
  })

  it('rolls back channel routing when its connectivity tester fails', async () => {
    service.saveProfile({ id: 'bad', protocol: 'http', host: 'bad.test', port: 8080 })
    await service.setRoute('channels.telegram', 'direct')
    service.registerRouteTester('channels.telegram', async () => { throw new Error('unreachable') })
    const changed = vi.fn()
    service.onRouteChanged(changed)
    await expect(service.setRoute('channels.telegram', 'profile:bad')).rejects.toThrow('unreachable')
    expect(service.resolve('channels.telegram').route).toBe('direct')
    expect(changed).not.toHaveBeenCalled()
  })

  it('redacts Telegram path tokens from transactional route errors', async () => {
    const token = '123456789:AARealBotSecret_123'
    service.saveProfile({ id: 'bad', protocol: 'http', host: 'bad.test', port: 8080 })
    await service.setRoute('channels.telegram', 'direct')
    service.registerRouteTester('channels.telegram', async () => {
      throw new Error(`request to https://api.telegram.org/bot${token}/getMe failed`)
    })
    await expect(service.setRoute('channels.telegram', 'profile:bad')).rejects.toThrow(
      'https://api.telegram.org/bot<redacted>/getMe',
    )
    try { await service.setRoute('channels.telegram', 'profile:bad') } catch (error) {
      expect((error as Error).message).not.toContain(token)
    }
    expect(service.resolve('channels.telegram').route).toBe('direct')
  })

  it('tests category/global changes before they can affect a protected channel', async () => {
    await service.setRoute('global', 'direct')
    service.registerRouteTester('channels.telegram', async () => { throw new Error('telegram unavailable') })
    await expect(service.setRoute('channels.default', 'inherit')).rejects.toThrow('telegram unavailable')
    expect(service.resolve('channels.telegram').route).toBe('direct')
    await expect(service.setRoute('global', 'inherit')).rejects.toThrow('telegram unavailable')
    expect(service.resolve('channels.telegram').route).toBe('direct')
  })

  it('rolls back an in-use profile edit when the channel connectivity test fails', async () => {
    service.saveProfile({ id: 'live', protocol: 'http', host: 'good.test', port: 8080, password: 'old' })
    await service.setRoute('channels.telegram', 'profile:live')
    service.registerRouteTester('channels.telegram', async () => { throw new Error('candidate failed') })
    await expect(service.saveProfileSafely({ id: 'live', protocol: 'http', host: 'bad.test', port: 8080, password: 'new' })).rejects.toThrow('candidate failed')
    expect(service.getProfile('live')?.host).toBe('good.test')
    const env = service.buildAgentEnv('codex', {})
    expect(JSON.stringify(service.status())).not.toContain('new')
    expect(env).toBeDefined()
  })

  it('signals agent route changes for warm-pool invalidation without touching active processes', async () => {
    const listener = vi.fn()
    service.onRouteChanged(listener)
    const result = await service.setRoute('agents.codex', 'direct')
    expect(listener).toHaveBeenCalledWith('agents.codex', 'direct')
    expect(result).toMatchObject({ warmPoolInvalidated: true, activeAgentProcessesUnaffected: true })
  })

  it('serializes concurrent mutations without losing either route', async () => {
    await Promise.all([
      service.setRoute('agents.codex', 'direct'),
      service.setRoute('channels.telegram', 'direct'),
    ])
    expect(service.status().routing.routes).toMatchObject({ 'agents.codex': 'direct', 'channels.telegram': 'direct' })
  })

  it('keeps a saved fetch facade valid after route and profile rotation', async () => {
    service.saveProfile({ id: 'live', protocol: 'http', host: 'one.test', port: 8080, username: 'u', password: 'p' })
    await service.setRoute('channels.telegram', 'profile:live')
    const saved = service.createFetch('channels.telegram')
    await saved('https://example.test')
    expect(agentOptions.at(-1)?.getProxyForUrl('https://example.test')).toContain('one.test')
    const generation = service.getPolicyGeneration()
    await service.setRoute('agents.codex', 'profile:live')
    await service.saveProfileSafely({ id: 'live', protocol: 'http', host: 'two.test', port: 8080 })
    expect(service.getPolicyGeneration()).toBeGreaterThan(generation)
    expect(service.createFetch('channels.telegram')).toBe(saved)
    await saved('https://example.test')
    expect(agentOptions.at(-1)?.getProxyForUrl('https://example.test')).toContain('two.test')
  })

  it('persists route scopes across a service restart', async () => {
    service.registerScope('plugins.custom.flow')
    await service.setRoute('plugins.custom.flow', 'direct')
    const restarted = new ProxyService(root)
    expect(restarted.getKnownScopes()).toContain('plugins.custom.flow')
    expect(restarted.resolve('plugins.custom.flow').route).toBe('direct')
  })

  it('persists dynamically registered scopes even before they receive a route', () => {
    service.registerScope('plugins.disabled.connector')
    service.registerRouteTester('channels.future', async () => {})
    const restarted = new ProxyService(root)
    expect(restarted.getKnownScopes()).toEqual(expect.arrayContaining([
      'plugins.disabled.connector',
      'channels.future',
    ]))
  })

  it('clears global with typed reset semantics', async () => {
    await service.setRoute('global', 'direct')
    await service.clearRoute('global')
    expect(service.resolve('global').route).toBe('inherit')
  })

  it('validates canonical hosts and SOCKS/import edge cases', async () => {
    expect(() => service.saveProfile({ id: 'bad', protocol: 'http', host: 'user@host/path', port: 8080 })).toThrow('DNS name')
    expect(() => service.saveProfile({ id: 'bad', protocol: 'http', host: '::1', port: 8080 })).toThrow('bracketed')
    expect(service.saveProfile({ id: 'v6', protocol: 'http', host: '[2001:db8::1]', port: 8080 }).host).toBe('2001:db8::1')
    service.saveProfile({ id: 'v6env', protocol: 'http', host: '[2001:db8::2]', port: 8080 })
    await service.setRoute('agents.codex', 'profile:v6env')
    expect(service.buildChildEnv('agents.codex', {}).HTTP_PROXY).toContain('://[2001:db8::2]:8080')
    expect(service.buildChildEnv('agents.codex', {}).HTTP_PROXY).not.toContain('[[')
    const envFile = path.join(root, 'socks.env')
    fs.writeFileSync(envFile, 'ALL_PROXY=socks5h://proxy.test\n', { mode: 0o600 })
    expect(service.importEnvFile('socks', envFile).port).toBe(1080)
    fs.writeFileSync(envFile, 'HTTP_PROXY=http://one.test:8080\nHTTPS_PROXY=http://two.test:8080\n', { mode: 0o600 })
    expect(() => service.importEnvFile('split', envFile)).toThrow('differ')
  })
})
