import { describe, expect, it, vi } from 'vitest'
import { handleInstall } from '../agents.js'

describe('Telegram agent install proxy scope', () => {
  it('registers the newly installed agent scope immediately', async () => {
    const registerScope = vi.fn()
    const core = {
      agentCatalog: { install: vi.fn(async (_name: string, progress: any) => {
        await progress.onSuccess('Future Agent')
        return { ok: true, agentKey: 'future-agent' }
      }) },
      proxyService: { registerScope },
    }
    const ctx = {
      message: { text: '/install future-agent' },
      reply: vi.fn(async () => ({ chat: { id: 1 }, message_id: 2 })),
      api: { editMessageText: vi.fn(async () => undefined) },
    }
    await handleInstall(ctx as any, core as any)
    expect(registerScope).toHaveBeenCalledWith('agents.future-agent')
  })
})
