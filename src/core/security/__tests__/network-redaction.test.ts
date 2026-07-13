import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { redactNetworkSecrets, sanitizeNetworkLogValue, sanitizeProxyDebugNamespaces } from '../network-redaction.js'

describe('network credential redaction', () => {
  it('redacts Telegram bot credentials embedded in URL paths', () => {
    const token = '123456789:AAExampleSecret_123'
    const result = redactNetworkSecrets(`request to https://api.telegram.org/bot${token}/getMe failed`)
    expect(result).toBe('request to https://api.telegram.org/bot<redacted>/getMe failed')
    expect(result).not.toContain(token)
  })

  it('redacts URL userinfo while preserving the proxy host and target context', () => {
    const result = redactNetworkSecrets('connect http://proxy-user:proxy-pass@proxy.example:8080 failed')
    expect(result).toContain('http://<redacted>@proxy.example:8080')
    expect(result).not.toContain('proxy-user')
    expect(result).not.toContain('proxy-pass')
  })

  it('redacts common query credentials and preserves non-sensitive parameters', () => {
    const result = redactNetworkSecrets('https://example.test/hook?token=one&api_key=two&signature=three&limit=10')
    expect(result).toContain('token=<redacted>')
    expect(result).toContain('api_key=<redacted>')
    expect(result).toContain('signature=<redacted>')
    expect(result).toContain('limit=10')
    expect(result).not.toMatch(/\b(one|two|three)\b/)
  })

  it('redacts sensitive header strings and structured header objects', () => {
    const text = redactNetworkSecrets('Authorization: Bearer bearer-secret, X-API-Key=key-secret')
    expect(text).not.toContain('bearer-secret')
    expect(text).not.toContain('key-secret')
    const object = sanitizeNetworkLogValue({
      headers: { authorization: 'Bearer nested-secret', cookie: 'session=secret' },
      url: 'https://example.test/?access_token=query-secret',
    }) as any
    expect(JSON.stringify(object)).not.toContain('nested-secret')
    expect(JSON.stringify(object)).not.toContain('session=secret')
    expect(JSON.stringify(object)).not.toContain('query-secret')
  })

  it('removes only credential-risk proxy debug namespaces', () => {
    const result = sanitizeProxyDebugNamespaces('app:*,proxy-agent,https-proxy-agent:*')!
    expect(result).toContain('app:*')
    expect(result).toContain('-proxy-agent:*')
    expect(result).not.toMatch(/(?:^|,)proxy-agent(?:,|$)/)
  })

  it('does not emit proxy credentials from third-party DEBUG in a real subprocess', () => {
    const secret = 'subprocess-proxy-secret'
    const moduleUrl = new URL('../../network/proxy-service.ts', import.meta.url).href
    const script = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import debug from 'debug'; import { ProxyService } from ${JSON.stringify(moduleUrl)};
debug('app:visible')('unrelated-debug-marker');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'openacp-debug-')); const p=new ProxyService(root, undefined, undefined, async () => undefined);
p.saveProfile({id:'p',protocol:'http',host:'127.0.0.1',port:9,username:'u',password:${JSON.stringify(secret)}});
await p.setRoute('services.agentRegistry','profile:p'); try { await p.createFetch('services.agentRegistry')('http://example.invalid') } catch {}; fs.rmSync(root,{recursive:true,force:true});`
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
      encoding: 'utf8', env: { ...process.env, DEBUG: '*' },
    })
    expect(result.status).toBe(0)
    expect(`${result.stdout}${result.stderr}`).not.toContain(secret)
    expect(`${result.stdout}${result.stderr}`).not.toContain('proxy-agent')
    expect(`${result.stdout}${result.stderr}`).toContain('unrelated-debug-marker')
  })
})
