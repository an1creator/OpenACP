import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyService } from '../../../core/network/proxy-service.js'
import { GroqSTT } from '../providers/groq.js'

describe('Groq STT scoped transport', () => {
  let root: string | undefined
  let server: http.Server | undefined
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('sends Groq fetches through an exact services.speech route using real ProxyService', async () => {
    const seen: Array<{ url: string; authorization?: string }> = []
    server = http.createServer((request, response) => {
      seen.push({ url: request.url ?? '', authorization: request.headers.authorization })
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ text: 'through speech proxy', language: 'en', duration: 1 }))
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-groq-proxy-'))
    const proxy = new ProxyService(root, undefined, undefined, async () => undefined)
    proxy.saveProfile({ id: 'speech', protocol: 'http', host: '127.0.0.1', port })
    await proxy.setRoute('services.default', 'direct')
    await proxy.setRoute('services.speech', 'profile:speech')
    const provider = new GroqSTT(
      'gsk_integration', 'whisper-large-v3-turbo',
      proxy.createFetch('services.speech'), () => proxy.createFetch('services.speech'),
      'http://groq.invalid/openai/v1/audio/transcriptions',
    )

    await expect(provider.transcribe(Buffer.from('audio'), 'audio/wav')).resolves.toMatchObject({ text: 'through speech proxy' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      url: 'http://groq.invalid/openai/v1/audio/transcriptions',
      authorization: 'Bearer gsk_integration',
    })
  })
})
