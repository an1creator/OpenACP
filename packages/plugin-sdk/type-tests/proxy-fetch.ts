import type { ScopedFetch, ScopedRequestBody } from '../src/proxy-types.js'

declare const scopedFetch: ScopedFetch

void scopedFetch('https://example.test/text', { method: 'POST', body: 'payload' })
void scopedFetch(new URL('https://example.test/form'), {
  method: 'POST',
  body: new URLSearchParams({ key: 'value' }),
})
void scopedFetch('https://example.test/blob', { method: 'POST', body: new Blob(['bytes']) })
void scopedFetch('https://example.test/form-data', { method: 'POST', body: new FormData() })

const webStream = new ReadableStream<Uint8Array>()
// @ts-expect-error Web ReadableStream request bodies are intentionally not in the scoped transport contract.
void scopedFetch('https://example.test/stream', { method: 'POST', body: webStream })

// @ts-expect-error Arbitrary objects must not be stringified as request bodies.
const invalidBody: ScopedRequestBody = { payload: true }
void invalidBody
