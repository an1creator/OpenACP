import { describe, expect, it, vi } from 'vitest'
import { Session } from '../session.js'
import { TypedEmitter } from '../../utils/typed-emitter.js'
import type { AgentEvent } from '../../types.js'

function createAgent() {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>()
  return Object.assign(emitter, {
    sessionId: 'shared-agent-session',
    prompt: vi.fn(),
    cancel: vi.fn(),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: vi.fn(),
  }) as any
}

function createSession(agentInstance: any): Session {
  const session = new Session({
    channelId: 'telegram',
    agentName: 'codex',
    workingDirectory: '/workspace',
    agentInstance,
  })
  session.name = 'skip-auto-name'
  return session
}

describe('Session cancellation generations', () => {
  it('sends a new ACP cancellation when the previous generation never settles', async () => {
    vi.useFakeTimers()
    try {
      const promptResolvers: Array<() => void> = []
      const agent = createAgent()
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => {
        promptResolvers.push(resolve)
      }))
      agent.cancel
        .mockImplementationOnce(() => new Promise<void>(() => {}))
        .mockResolvedValueOnce(undefined)
      const session = createSession(agent)

      const firstPrompt = session.enqueuePrompt('first')
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1))
      const secondPrompt = session.enqueuePrompt('second')
      const firstCancel = session.abortPrompt()
      await vi.waitFor(() => expect(agent.cancel).toHaveBeenCalledTimes(1))

      promptResolvers[0]()
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2))
      await firstCancel

      const secondCancel = session.abortPrompt()
      await vi.waitFor(() => expect(agent.cancel).toHaveBeenCalledTimes(2))
      promptResolvers[1]()

      await Promise.all([firstPrompt, secondPrompt, secondCancel])
      expect(agent.cancel).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares settled cancellation within a generation and replaces it for the next one', async () => {
    const promptResolvers: Array<() => void> = []
    const agent = createAgent()
    agent.prompt.mockImplementation(() => new Promise<void>((resolve) => {
      promptResolvers.push(resolve)
    }))
    agent.cancel.mockResolvedValue(undefined)
    const session = createSession(agent)

    const firstPrompt = session.enqueuePrompt('first ignores cancellation')
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce())
    const secondPrompt = session.enqueuePrompt('second ignores cancellation')
    const firstCancel = session.abortPrompt()
    await vi.waitFor(() => expect(agent.cancel).toHaveBeenCalledOnce())
    await Promise.resolve()
    await Promise.resolve()

    const repeatedCancel = session.abortPrompt()
    await Promise.resolve()
    expect(agent.cancel).toHaveBeenCalledOnce()

    promptResolvers[0]()
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2))
    await Promise.all([firstPrompt, firstCancel, repeatedCancel])

    const secondCancel = session.abortPrompt()
    await vi.waitFor(() => expect(agent.cancel).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    const terminalDestroy = session.destroy()
    await Promise.resolve()
    expect(agent.cancel).toHaveBeenCalledTimes(2)

    promptResolvers[1]()
    await Promise.all([secondPrompt, secondCancel, terminalDestroy])
    expect(agent.cancel).toHaveBeenCalledTimes(2)
    expect(agent.destroy).toHaveBeenCalledOnce()
  })

  it('does not let a late prior settlement clear the current generation operation', async () => {
    vi.useFakeTimers()
    try {
      let rejectFirstCancel!: (error: Error) => void
      let settleSecondCancel!: () => void
      const promptResolvers: Array<() => void> = []
      const agent = createAgent()
      agent.prompt.mockImplementation(() => new Promise<void>((resolve) => {
        promptResolvers.push(resolve)
      }))
      agent.cancel
        .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectFirstCancel = reject }))
        .mockImplementationOnce(() => new Promise<void>((resolve) => { settleSecondCancel = resolve }))
      const session = createSession(agent)

      const firstPrompt = session.enqueuePrompt('first')
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(1))
      const secondPrompt = session.enqueuePrompt('second')
      const firstCancel = session.abortPrompt()
      await vi.waitFor(() => expect(agent.cancel).toHaveBeenCalledTimes(1))

      promptResolvers[0]()
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledTimes(2))
      await firstCancel

      const secondCancel = session.abortPrompt()
      await vi.waitFor(() => expect(agent.cancel).toHaveBeenCalledTimes(2))
      rejectFirstCancel(new Error('late cancellation failure'))
      await Promise.resolve()
      await Promise.resolve()

      const repeatedSecondCancel = session.abortPrompt()
      const terminalDestroy = session.destroy()
      await Promise.resolve()
      expect(agent.cancel).toHaveBeenCalledTimes(2)

      settleSecondCancel()
      promptResolvers[1]()
      await Promise.all([
        firstPrompt,
        secondPrompt,
        secondCancel,
        repeatedSecondCancel,
        terminalDestroy,
      ])
      expect(agent.cancel).toHaveBeenCalledTimes(2)
      expect(agent.destroy).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
