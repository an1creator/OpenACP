import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyService } from '../../core/network/proxy-service.js'
import { getUpdateNetwork } from '../version.js'

describe('CLI update scoped network', () => {
  let root: string | undefined
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }) })

  it('uses services.npmUpdate for both registry fetch and npm child env', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-update-proxy-'))
    const service = new ProxyService(root, undefined, undefined, async () => undefined)
    service.saveProfile({ id: 'updates', protocol: 'http', host: 'proxy.test', port: 8080, username: 'u', password: 'p' })
    await service.setRoute('services.npmUpdate', 'profile:updates')
    const network = getUpdateNetwork(root)
    expect(network.fetcher).toBeTypeOf('function')
    expect(network.environment?.HTTPS_PROXY).toContain('u:p@proxy.test:8080')
    expect(network.environment?.NO_PROXY).toContain('localhost')
  })
})
