import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyService } from '../proxy-service.js'

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as { port: number }).port
}

describe('scoped transport retirement', () => {
  const servers: http.Server[] = []
  let root: string | undefined
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('does not interrupt a Telegram stream when an unrelated agent route changes', async () => {
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    const origin = http.createServer(async (_request, response) => {
      response.writeHead(200); response.write('telegram-')
      await gate; response.end('alive')
    }); servers.push(origin)
    const port = await listen(origin)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-transport-life-'))
    const proxy = new ProxyService(root)
    await proxy.setRoute('channels.telegram', 'direct')
    await proxy.setRoute('agents.cursor', 'direct')
    const response = await proxy.createFetch('channels.telegram')(`http://127.0.0.1:${port}/updates`)
    await proxy.setRoute('agents.cursor', 'inherit')
    finish()
    await expect(response.text()).resolves.toBe('telegram-alive')
  })

  it('retires an in-use Telegram profile after the body completes and uses the rotated profile next', async () => {
    let finishOld!: () => void
    const oldGate = new Promise<void>((resolve) => { finishOld = resolve })
    const oldProxy = http.createServer(async (_request, response) => {
      response.writeHead(200); response.write('old-'); await oldGate; response.end('complete')
    })
    const newProxy = http.createServer((_request, response) => { response.end('new') })
    servers.push(oldProxy, newProxy)
    const oldPort = await listen(oldProxy); const newPort = await listen(newProxy)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-profile-life-'))
    const proxy = new ProxyService(root)
    proxy.saveProfile({ id: 'telegram', protocol: 'http', host: '127.0.0.1', port: oldPort })
    await proxy.setRoute('channels.telegram', 'profile:telegram')
    const fetchTelegram = proxy.createFetch('channels.telegram')
    const oldResponse = await fetchTelegram('http://telegram.invalid/getUpdates')
    await proxy.saveProfileSafely({ id: 'telegram', protocol: 'http', host: '127.0.0.1', port: newPort })
    const next = await fetchTelegram('http://telegram.invalid/getMe')
    await expect(next.text()).resolves.toBe('new')
    finishOld()
    await expect(oldResponse.text()).resolves.toBe('old-complete')
  })

  it('bounds an abandoned response lease after its transport is retired', async () => {
    const oldProxy = http.createServer((_request, response) => {
      response.writeHead(200); response.write('partial-')
    })
    const newProxy = http.createServer((_request, response) => { response.end('new') })
    servers.push(oldProxy, newProxy)
    const oldPort = await listen(oldProxy); const newPort = await listen(newProxy)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-profile-abandoned-'))
    const proxy = new ProxyService(root, 50)
    proxy.saveProfile({ id: 'telegram', protocol: 'http', host: '127.0.0.1', port: oldPort })
    await proxy.setRoute('channels.telegram', 'profile:telegram')
    const fetchTelegram = proxy.createFetch('channels.telegram')
    const abandoned = await fetchTelegram('http://telegram.invalid/getUpdates')
    await proxy.saveProfileSafely({ id: 'telegram', protocol: 'http', host: '127.0.0.1', port: newPort })
    await expect(abandoned.text()).rejects.toThrow('maximum lease')
    await expect((await fetchTelegram('http://telegram.invalid/getMe')).text()).resolves.toBe('new')
  })

  it('rejects Web stream request bodies instead of serializing them', async () => {
    const received: string[] = []
    const upstream = http.createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      received.push(Buffer.concat(chunks).toString('utf8'))
      response.end('ok')
    })
    servers.push(upstream)
    const port = await listen(upstream)
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-request-body-'))
    const proxy = new ProxyService(root)
    proxy.saveProfile({ id: 'body', protocol: 'http', host: '127.0.0.1', port })
    await proxy.setRoute('services.agentRegistry', 'profile:body')
    const fetchRegistry = proxy.createFetch('services.agentRegistry')

    const webStream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('must-not-stringify')); controller.close() },
    })
    await expect(fetchRegistry('http://registry.invalid/stream', {
      method: 'POST', body: webStream as unknown as BodyInit,
    })).rejects.toThrow('Web ReadableStream request bodies are not supported')
    expect(received).toEqual([])

    const response = await fetchRegistry('http://registry.invalid/text', { method: 'POST', body: 'exact-bytes' })
    await response.text()
    expect(received).toEqual(['exact-bytes'])
    expect(received).not.toContain('[object ReadableStream]')
  })
})
