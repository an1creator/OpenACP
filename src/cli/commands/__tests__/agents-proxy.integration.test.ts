import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPlatformKey } from '../../../core/agents/agent-installer.js'
import { ProxyService } from '../../../core/network/proxy-service.js'
import { ProxyStoreCorruptError } from '../../../core/network/proxy-store.js'
import { cmdAgents } from '../agents.js'

describe('standalone agents CLI scoped transport', () => {
  let root: string | undefined
  let server: http.Server | undefined
  const originalUrl = process.env.OPENACP_AGENT_REGISTRY_URL
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (root) fs.rmSync(root, { recursive: true, force: true })
    if (originalUrl === undefined) delete process.env.OPENACP_AGENT_REGISTRY_URL
    else process.env.OPENACP_AGENT_REGISTRY_URL = originalUrl
    vi.restoreAllMocks()
  })

  it('refreshes and installs a binary through the configured real proxy, then persists its scope', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agents-cli-proxy-'))
    const archiveRoot = path.join(root, 'archive'); fs.mkdirSync(archiveRoot)
    fs.writeFileSync(path.join(archiveRoot, 'local-agent'), '#!/usr/bin/env sh\nexit 0\n', { mode: 0o755 })
    const archive = path.join(root, 'local-agent.tar.gz')
    execFileSync('tar', ['czf', archive, '-C', archiveRoot, 'local-agent'])
    const archiveBytes = fs.readFileSync(archive)
    const seen: string[] = []
    server = http.createServer((request, response) => {
      seen.push(request.url ?? '')
      if ((request.url ?? '').includes('registry.json')) {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ agents: [{
          id: 'local-binary', name: 'Local Binary', version: '1.0.0', description: 'integration',
          distribution: { binary: { [getPlatformKey()]: { archive: 'http://origin.invalid/local-agent.tar.gz', cmd: './local-agent' } } },
        }] }))
      } else {
        response.setHeader('content-length', archiveBytes.length); response.end(archiveBytes)
      }
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const proxy = new ProxyService(root)
    proxy.saveProfile({ id: 'cli', protocol: 'http', host: '127.0.0.1', port })
    await proxy.setRoute('services.agentRegistry', 'profile:cli')
    process.env.OPENACP_AGENT_REGISTRY_URL = 'http://registry.invalid/registry.json'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await cmdAgents(['refresh'], root)
    await cmdAgents(['install', 'local-binary'], root)
    expect(seen.some((url) => url.includes('registry.json'))).toBe(true)
    expect(seen.some((url) => url.includes('local-agent.tar.gz'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(root, 'agents.json'), 'utf8')).installed['local-binary']).toBeDefined()
    expect(new ProxyService(root).getKnownScopes()).toContain('agents.local-binary')
  })

  it('fails closed before registry access when the policy store is corrupt', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agents-cli-corrupt-'))
    fs.writeFileSync(path.join(root, 'proxy.json'), '{broken', { mode: 0o600 })
    await expect(cmdAgents(['refresh'], root)).rejects.toBeInstanceOf(ProxyStoreCorruptError)
  })
})
