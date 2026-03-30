import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { discoverRunningInstances } from '../instance-discovery.js'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'

describe('instance-discovery', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'discovery-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns empty array when no instances registered', async () => {
    const registryPath = join(tmpDir, 'instances.json')
    await writeFile(registryPath, JSON.stringify({ version: 1, instances: {} }))

    const instances = await discoverRunningInstances(registryPath)
    expect(instances).toHaveLength(0)
  })

  it('returns empty when registry file missing', async () => {
    const instances = await discoverRunningInstances(join(tmpDir, 'nonexistent.json'))
    expect(instances).toHaveLength(0)
  })

  it('discovers a running instance with api.port file', async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith('/api/v1/system/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok' }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port

    try {
      const instanceRoot = join(tmpDir, 'instance1')
      await mkdir(instanceRoot, { recursive: true })
      await writeFile(join(instanceRoot, 'api.port'), String(port))
      await writeFile(join(instanceRoot, 'config.json'), JSON.stringify({ instanceName: 'Test Instance' }))

      const registryPath = join(tmpDir, 'instances.json')
      await writeFile(registryPath, JSON.stringify({
        version: 1,
        instances: { test: { id: 'test', root: instanceRoot } },
      }))

      const instances = await discoverRunningInstances(registryPath)
      expect(instances).toHaveLength(1)
      expect(instances[0].id).toBe('test')
      expect(instances[0].name).toBe('Test Instance')
      expect(instances[0].port).toBe(port)
      expect(instances[0].running).toBe(true)
    } finally {
      server.close()
    }
  })

  it('skips instances without api.port file', async () => {
    const instanceRoot = join(tmpDir, 'stopped-instance')
    await mkdir(instanceRoot, { recursive: true })

    const registryPath = join(tmpDir, 'instances.json')
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      instances: { stopped: { id: 'stopped', root: instanceRoot } },
    }))

    const instances = await discoverRunningInstances(registryPath)
    expect(instances).toHaveLength(0)
  })

  it('skips instances with api.port but failing health check', async () => {
    const instanceRoot = join(tmpDir, 'bad-instance')
    await mkdir(instanceRoot, { recursive: true })
    await writeFile(join(instanceRoot, 'api.port'), '99999') // non-existent port

    const registryPath = join(tmpDir, 'instances.json')
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      instances: { bad: { id: 'bad', root: instanceRoot } },
    }))

    const instances = await discoverRunningInstances(registryPath)
    expect(instances).toHaveLength(0)
  })
})
