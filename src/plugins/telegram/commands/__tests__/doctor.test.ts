import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot, Context } from 'grammy'
import type { OpenACPCore } from '../../../../core/index.js'

const doctorMocks = vi.hoisted(() => {
  const state = {
    options: [] as unknown[],
    runAll: vi.fn(),
    DoctorEngine: undefined as unknown as ReturnType<typeof vi.fn>,
  }
  state.DoctorEngine = vi.fn(function DoctorEngineMock(options: unknown) {
    state.options.push(options)
    return { runAll: state.runAll }
  })
  return state
})

vi.mock('../../../../core/doctor/index.js', () => ({
  DoctorEngine: doctorMocks.DoctorEngine,
}))

import { renderReport } from '../doctor.js'

const instanceRoot = '/tmp/openacp-test/.openacp'

function makeCore(): OpenACPCore {
  return {
    instanceContext: { root: instanceRoot },
  } as OpenACPCore
}

function makeReport(pendingFixes: unknown[] = []) {
  return {
    categories: [
      { name: 'Config', results: [{ status: 'pass' as const, message: 'Config valid' }] },
    ],
    pendingFixes,
    summary: { passed: 1, warnings: 0, failed: 0, fixed: 0 },
  }
}

function makeCtx(): Context {
  return {
    chat: { id: 123 },
    reply: vi.fn().mockResolvedValue({ message_id: 456 }),
    api: { editMessageText: vi.fn().mockResolvedValue(undefined) },
  } as unknown as Context
}

describe('Telegram doctor command', () => {
  beforeEach(() => {
    doctorMocks.options = []
    doctorMocks.DoctorEngine.mockClear()
    doctorMocks.runAll.mockReset()
  })

  it('passes the active instance root to DoctorEngine', async () => {
    doctorMocks.runAll.mockResolvedValue(makeReport())
    const { handleDoctor } = await import('../doctor.js')

    await handleDoctor(makeCtx(), makeCore())

    expect(doctorMocks.DoctorEngine).toHaveBeenCalledWith({ dataDir: instanceRoot })
  })

  it('uses the active instance root when rerunning after a doctor fix', async () => {
    const fix = vi.fn().mockResolvedValue({ success: true, message: 'fixed' })
    doctorMocks.runAll
      .mockResolvedValueOnce(makeReport([{ message: 'Missing config', fix }]))
      .mockResolvedValueOnce(makeReport())

    const { handleDoctor, setupDoctorCallbacks } = await import('../doctor.js')
    const handlers: Array<{ pattern: RegExp | string; handler: (ctx: Context) => Promise<void> }> = []
    const bot = {
      callbackQuery: (pattern: RegExp | string, handler: (ctx: Context) => Promise<void>) => {
        handlers.push({ pattern, handler })
      },
    }

    await handleDoctor(makeCtx(), makeCore())
    setupDoctorCallbacks(bot as unknown as Bot, makeCore())

    const fixHandler = handlers.find(({ pattern }) => pattern instanceof RegExp)
    expect(fixHandler).toBeDefined()

    await fixHandler!.handler({
      callbackQuery: {
        data: 'm:doctor:fix:0',
        message: { chat: { id: 123 }, message_id: 456 },
      },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      editMessageText: vi.fn().mockResolvedValue(undefined),
    } as unknown as Context)

    expect(fix).toHaveBeenCalledOnce()
    expect(doctorMocks.options).toEqual([
      { dataDir: instanceRoot },
      { dataDir: instanceRoot },
    ])
  })
})

describe('Telegram doctor report UX', () => {
  it('shows outcome and issues first, compacts passes, and provides recovery navigation', () => {
    const { text, keyboard } = renderReport({
      categories: [
        { name: 'Config', results: [{ status: 'pass', message: 'Configuration valid' }] },
        { name: 'Speech-to-text', results: [{ status: 'warn', message: 'Local setup needs Python 3' }] },
        { name: 'Network proxy', results: [{ status: 'fail', message: 'Policy file needs recovery' }] },
      ],
      summary: { passed: 1, warnings: 1, failed: 1, fixed: 0 },
      pendingFixes: [],
    })
    expect(text.split('\n').slice(0, 3).join(' ')).toContain('1 failure needs attention')
    expect(text).toContain('1 passed · 1 warning · 1 failure')
    expect(text.indexOf('Network proxy')).toBeLessThan(text.indexOf('✅ 1 passed'))
    expect(text).not.toContain('Configuration valid')
    const buttons = (keyboard as any).inline_keyboard.flat()
    expect(buttons).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Run again', callback_data: 'm:doctor' }),
      expect.objectContaining({ text: 'Speech-to-text settings', callback_data: 'c/@settings:/speech' }),
      expect.objectContaining({ text: 'Network proxy settings', callback_data: 'c/@settings:/proxy' }),
    ]))
    expect(buttons.every((button: any) => Buffer.byteLength(button.callback_data, 'utf8') <= 64)).toBe(true)
  })

  it('caps report text below the Telegram message limit', () => {
    const { text } = renderReport({
      categories: [{ name: 'Long issue', results: [{ status: 'fail', message: 'x'.repeat(5_000) }] }],
      summary: { passed: 0, warnings: 0, failed: 1, fixed: 0 }, pendingFixes: [],
    })
    expect(text.length).toBeLessThan(4_096)
    expect(text).toContain('Output shortened')
  })

  it('truncates adversarial HTML as complete entities with balanced formatting', () => {
    const { text } = renderReport({
      categories: [{
        name: '<&>'.repeat(2_000),
        results: [{ status: 'fail', message: '&<😀>'.repeat(2_000) }],
      }],
      summary: { passed: 0, warnings: 0, failed: 1, fixed: 0 }, pendingFixes: [],
    })

    expect(text.length).toBeLessThan(4_096)
    expect(text).toContain('Output shortened')
    expect(text).not.toMatch(/&(?!amp;|lt;|gt;)/)
    expect((text.match(/<b>/g) ?? []).length).toBe((text.match(/<\/b>/g) ?? []).length)
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/)
  })
})
