import { describe, expect, it, vi } from 'vitest'
import type { Context } from 'grammy'
import type { OpenACPCore } from '../../../../core/index.js'
import {
  contextualCommandCallback,
  decodeCommandCallback,
  settingsCommandCallback,
} from '../../callback-navigation.js'
import { handleSettings } from '../settings.js'

describe('Telegram Settings menu', () => {
  it('nests proxy and speech management through generic connector command callbacks', async () => {
    const reply = vi.fn().mockResolvedValue(undefined)
    const ctx = { reply } as unknown as Context
    const core = {
      configManager: { get: vi.fn().mockReturnValue({}) },
    } as unknown as OpenACPCore

    await handleSettings(ctx, core)

    const [, options] = reply.mock.calls[0]
    const buttons = options.reply_markup.inline_keyboard.flat() as Array<{
      text: string
      callback_data: string
    }>
    expect(buttons).toContainEqual({
      text: '🌐 Network proxy',
      callback_data: 'c/@settings:/proxy',
    })
    expect(buttons).toContainEqual({
      text: '🎙 Speech-to-text',
      callback_data: 'c/@settings:/speech',
    })
    expect(buttons.at(-1)).toEqual({
      text: '◀️ Back to Menu',
      callback_data: 's:back',
    })
    expect(buttons.some((button) => button.callback_data === 'c//proxy')).toBe(false)
    expect(buttons.slice(0, 2).map((button) => button.text)).toEqual(['🎙 Speech-to-text', '🌐 Network proxy'])
  })

  it('decodes only the allow-listed Settings return envelope', () => {
    expect(decodeCommandCallback(settingsCommandCallback('/proxy'))).toEqual({
      command: '/proxy',
      returnTarget: 'settings',
    })
    expect(decodeCommandCallback(settingsCommandCallback('/speech'))).toEqual({
      command: '/speech',
      returnTarget: 'settings',
    })
    expect(decodeCommandCallback('c//proxy')).toEqual({ command: '/proxy' })
    expect(decodeCommandCallback('c/@main:/proxy')).toEqual({ command: '@main:/proxy' })
    expect(contextualCommandCallback(`/proxy ${'x'.repeat(60)}`, 'settings')).toBeUndefined()
  })
})
