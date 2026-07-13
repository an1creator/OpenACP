import { describe, expect, it, vi } from 'vitest'
import { RegistryClient } from '../registry-client.js'

describe('RegistryClient', () => {
  it('uses the packaged catalog without any network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const client = new RegistryClient()
    expect(await client.getRegistry()).toEqual({
      version: 1,
      generatedAt: '2026-07-13T00:00:00.000Z',
      pluginCount: 0,
      plugins: [],
      categories: [],
    })
    expect(await client.search('anything')).toEqual([])
    expect(await client.resolve('anything')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('can clear and deterministically reload the packaged catalog', async () => {
    const client = new RegistryClient()
    const first = await client.getRegistry()
    client.clearCache()
    expect(await client.getRegistry()).toEqual(first)
  })
})
