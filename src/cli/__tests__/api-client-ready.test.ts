import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForApiReady } from '../api-client.js'

describe('daemon API readiness', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.unstubAllGlobals()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  function rootWithPort(port = 21420): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-api-ready-'))
    roots.push(root)
    fs.writeFileSync(path.join(root, 'api.port'), String(port))
    return root
  }

  it('requires a live health response from the expected instance', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok', instanceId: 'expected-instance',
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(waitForApiReady(rootWithPort(), 'expected-instance', 50, 1)).resolves.toBe(21420)
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:21420/api/v1/system/health',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('rejects a stale port served by another instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ok', instanceId: 'another-instance',
    }), { status: 200, headers: { 'content-type': 'application/json' } })))
    await expect(waitForApiReady(rootWithPort(), 'expected-instance', 10, 1)).resolves.toBeNull()
  })

  it('rejects a port file when no API is accepting requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    await expect(waitForApiReady(rootWithPort(), 'expected-instance', 10, 1)).resolves.toBeNull()
  })
})
