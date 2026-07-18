import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProxyService } from '../../network/proxy-service.js'
import { readResponseWithProgress } from '../agent-installer.js'

describe('binary download through real scoped transport', () => {
  const roots: string[] = []
  const servers: http.Server[] = []
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('consumes the node-fetch stream normalized by ProxyService and reports progress', async () => {
    const payload = Buffer.from('real-binary-archive-content')
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-length': payload.length })
      response.write(payload.subarray(0, 5))
      setImmediate(() => response.end(payload.subarray(5)))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-binary-fetch-')); roots.push(root)
    const connectivityTarget = `http://127.0.0.1:${address.port}/connectivity`
    const proxy = new ProxyService(root, undefined, undefined, async (fetcher) => {
      const check = await fetcher(connectivityTarget)
      try {
        if (!check.ok) throw new Error(`Connectivity check returned HTTP ${check.status}`)
      } finally {
        await check.arrayBuffer()
      }
    })
    await proxy.setRoute('services.agentRegistry', 'direct')
    const response = await proxy.createFetch('services.agentRegistry')(`http://127.0.0.1:${address.port}/agent.tar.gz`)
    expect(response.body?.getReader).toBeTypeOf('function')
    const onDownloadProgress = vi.fn(async () => {})
    const result = await readResponseWithProgress(response, payload.length, { onDownloadProgress } as any)
    expect(result).toEqual(payload)
    expect(onDownloadProgress).toHaveBeenLastCalledWith(100)
    const requestResponse = await proxy.createFetch('services.agentRegistry')(
      new Request(`http://127.0.0.1:${address.port}/agent.tar.gz`, { headers: { 'x-openacp-test': 'native-request' } }),
    )
    await expect(requestResponse.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer)
  })

  it('destroys Node streams and cancels Web streams when progress consumption fails', async () => {
    const destroy = vi.fn()
    const nodeBody = {
      async *[Symbol.asyncIterator]() { yield Buffer.from('x'); throw new Error('node stream failed') },
      destroy,
    }
    await expect(readResponseWithProgress({ body: nodeBody, arrayBuffer: async () => new ArrayBuffer(0) } as any, 1)).rejects.toThrow('node stream failed')
    expect(destroy).toHaveBeenCalled()

    const cancel = vi.fn()
    const webBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel })
    await expect(readResponseWithProgress({ body: webBody, arrayBuffer: async () => new ArrayBuffer(0) } as any, 1, {
      onDownloadProgress: async () => { throw new Error('progress failed') },
    } as any)).rejects.toThrow('progress failed')
    expect(cancel).toHaveBeenCalled()
  })
})
