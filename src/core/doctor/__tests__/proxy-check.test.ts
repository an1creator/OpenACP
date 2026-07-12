import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { proxyCheck } from '../checks/proxy.js'
import { PROXY_ENV_KEYS } from '../../network/proxy-service.js'

describe('proxy doctor check', () => {
  const original = Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]))
  afterEach(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
  })

  it('warns without exposing values when daemon-wide proxy env is active', async () => {
    process.env.HTTP_PROXY = 'http://user:secret@proxy.invalid:8080'
    const [result] = await proxyCheck.run({} as any)
    expect(result.status).toBe('warn')
    expect(result.message).toContain('HTTP_PROXY')
    expect(result.message).not.toContain('secret')
  })

  it('treats NODE_USE_ENV_PROXY=0 as disabled', async () => {
    for (const key of PROXY_ENV_KEYS) delete process.env[key]
    process.env.NODE_USE_ENV_PROXY = '0'
    const [result] = await proxyCheck.run({} as any)
    expect(result.status).toBe('pass')
  })

  it('reports a corrupt policy store as fail-closed without replacing it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-proxy-'))
    const config = path.join(root, 'proxy.json')
    fs.writeFileSync(config, '{broken', { mode: 0o600 })
    try {
      const [result] = await proxyCheck.run({ dataDir: root } as any)
      expect(result.status).toBe('fail')
      expect(result.message).toContain('fail-closed')
      expect(fs.readFileSync(config, 'utf8')).toBe('{broken')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
