import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Session } from '../session.js'
import { TypedEmitter } from '../../utils/typed-emitter.js'
import type { AgentEvent } from '../../types.js'

function mockAgentInstance(overrides?: { sessionId?: string }) {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>()
  return Object.assign(emitter, {
    sessionId: overrides?.sessionId ?? 'agent-sess-1',
    prompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: vi.fn(),
  }) as any
}

function createTestSession(agentInstance?: any, agentName?: string) {
  return new Session({
    channelId: 'telegram',
    agentName: agentName ?? 'claude',
    workingDirectory: '/workspace',
    agentInstance: agentInstance ?? mockAgentInstance(),
  })
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Session.switchAgent', () => {
  it('tracks firstAgent on creation', () => {
    const session = createTestSession(undefined, 'claude')
    expect(session.firstAgent).toBe('claude')
  })

  it('initializes agentSwitchHistory as empty array', () => {
    const session = createTestSession()
    expect(session.agentSwitchHistory).toEqual([])
  })

  it('adds switchHistory entry when switching', async () => {
    const oldAgent = mockAgentInstance({ sessionId: 'old-sess' })
    const session = createTestSession(oldAgent, 'claude')
    session.agentSessionId = 'old-sess'

    // Process a prompt to increment promptCount
    await session.enqueuePrompt('hello')

    const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
    await session.switchAgent('gemini', async () => newAgent)

    expect(session.agentSwitchHistory).toHaveLength(1)
    expect(session.agentSwitchHistory[0].agentName).toBe('claude')
    expect(session.agentSwitchHistory[0].agentSessionId).toBe('old-sess')
    expect(session.agentSwitchHistory[0].promptCount).toBe(1)
    expect(session.agentSwitchHistory[0].switchedAt).toBeTruthy()
  })

  it('updates agentName and agentSessionId after switch', async () => {
    const session = createTestSession(undefined, 'claude')
    const newAgent = mockAgentInstance({ sessionId: 'new-sess' })

    await session.switchAgent('gemini', async () => newAgent)

    expect(session.agentName).toBe('gemini')
    expect(session.agentSessionId).toBe('new-sess')
  })

  it('destroys old agent instance on switch', async () => {
    const oldAgent = mockAgentInstance()
    const session = createTestSession(oldAgent, 'claude')

    const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
    await session.switchAgent('gemini', async () => newAgent)

    expect(oldAgent.destroy).toHaveBeenCalled()
  })

  it('resets promptCount to 0 and saves old count in history', async () => {
    const oldAgent = mockAgentInstance()
    const session = createTestSession(oldAgent, 'claude')

    // Process two prompts
    await session.enqueuePrompt('hello')
    await session.enqueuePrompt('world')
    expect(session.promptCount).toBe(2)

    const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
    await session.switchAgent('gemini', async () => newAgent)

    expect(session.promptCount).toBe(0)
    expect(session.agentSwitchHistory[0].promptCount).toBe(2)
  })

  it('throws if switching to same agent', async () => {
    const session = createTestSession(undefined, 'claude')

    await expect(
      session.switchAgent('claude', async () => mockAgentInstance())
    ).rejects.toThrow('Already using claude')
  })

  it('firstAgent does not change after switching', async () => {
    const session = createTestSession(undefined, 'claude')

    await session.switchAgent('gemini', async () => mockAgentInstance({ sessionId: 'g-sess' }))

    expect(session.firstAgent).toBe('claude')
    expect(session.agentName).toBe('gemini')
  })

  describe('findLastSwitchEntry', () => {
    it('returns undefined when no history exists', () => {
      const session = createTestSession(undefined, 'claude')
      expect(session.findLastSwitchEntry('claude')).toBeUndefined()
    })

    it('finds correct entry by agent name', async () => {
      const session = createTestSession(
        mockAgentInstance({ sessionId: 'claude-sess' }),
        'claude'
      )
      session.agentSessionId = 'claude-sess'

      await session.switchAgent('gemini', async () =>
        mockAgentInstance({ sessionId: 'gemini-sess' })
      )

      const entry = session.findLastSwitchEntry('claude')
      expect(entry).toBeDefined()
      expect(entry!.agentName).toBe('claude')
      expect(entry!.agentSessionId).toBe('claude-sess')
    })

    it('returns undefined for agent not in history', async () => {
      const session = createTestSession(undefined, 'claude')
      await session.switchAgent('gemini', async () => mockAgentInstance({ sessionId: 'g' }))

      expect(session.findLastSwitchEntry('gpt')).toBeUndefined()
    })
  })

  describe('multiple switches A -> B -> C -> A', () => {
    it('tracks full history across multiple switches', async () => {
      const agentA = mockAgentInstance({ sessionId: 'a-sess' })
      const session = createTestSession(agentA, 'agentA')
      session.agentSessionId = 'a-sess'

      // A -> B
      await session.enqueuePrompt('prompt1')
      const agentB = mockAgentInstance({ sessionId: 'b-sess' })
      await session.switchAgent('agentB', async () => agentB)

      // B -> C
      await session.enqueuePrompt('prompt2')
      await session.enqueuePrompt('prompt3')
      const agentC = mockAgentInstance({ sessionId: 'c-sess' })
      await session.switchAgent('agentC', async () => agentC)

      // C -> A (back to original)
      await session.enqueuePrompt('prompt4')
      const agentA2 = mockAgentInstance({ sessionId: 'a-sess-2' })
      await session.switchAgent('agentA', async () => agentA2)

      expect(session.agentSwitchHistory).toHaveLength(3)

      // First entry: agentA with 1 prompt
      expect(session.agentSwitchHistory[0].agentName).toBe('agentA')
      expect(session.agentSwitchHistory[0].agentSessionId).toBe('a-sess')
      expect(session.agentSwitchHistory[0].promptCount).toBe(1)

      // Second entry: agentB with 2 prompts
      expect(session.agentSwitchHistory[1].agentName).toBe('agentB')
      expect(session.agentSwitchHistory[1].agentSessionId).toBe('b-sess')
      expect(session.agentSwitchHistory[1].promptCount).toBe(2)

      // Third entry: agentC with 1 prompt
      expect(session.agentSwitchHistory[2].agentName).toBe('agentC')
      expect(session.agentSwitchHistory[2].agentSessionId).toBe('c-sess')
      expect(session.agentSwitchHistory[2].promptCount).toBe(1)

      // Current agent is agentA again
      expect(session.agentName).toBe('agentA')
      expect(session.agentSessionId).toBe('a-sess-2')
      expect(session.promptCount).toBe(0)

      // firstAgent unchanged
      expect(session.firstAgent).toBe('agentA')

      // findLastSwitchEntry finds the most recent entry for agentA
      const lastA = session.findLastSwitchEntry('agentA')
      expect(lastA).toBeDefined()
      expect(lastA!.agentSessionId).toBe('a-sess')
    })
  })

  it('uses the new agent instance for subsequent prompts after switch', async () => {
    const oldAgent = mockAgentInstance()
    const session = createTestSession(oldAgent, 'claude')

    const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
    await session.switchAgent('gemini', async () => newAgent)

    await session.enqueuePrompt('hello after switch')

    expect(newAgent.prompt).toHaveBeenCalledWith('hello after switch', undefined)
    // Old agent should not receive the new prompt (only destroy was called)
    expect(oldAgent.prompt).not.toHaveBeenCalled()
  })

  it('destroys an unresponsive in-flight agent before creating the replacement', async () => {
    vi.useFakeTimers()
    try {
      let finishPrompt!: () => void
      const oldAgent = mockAgentInstance()
      oldAgent.prompt.mockImplementation(() => new Promise<void>((resolve) => { finishPrompt = resolve }))
      oldAgent.cancel.mockImplementation(() => new Promise<void>(() => {}))
      oldAgent.destroy.mockImplementation(async () => { finishPrompt() })
      const session = createTestSession(oldAgent, 'claude')
      const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
      const createNewAgent = vi.fn(async () => newAgent)

      const prompt = session.enqueuePrompt('in flight')
      await vi.waitFor(() => expect(oldAgent.prompt).toHaveBeenCalledOnce())
      const switching = session.switchAgent('gemini', createNewAgent)
      await Promise.resolve()

      expect(oldAgent.cancel).toHaveBeenCalledOnce()
      expect(oldAgent.destroy).not.toHaveBeenCalled()
      expect(createNewAgent).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      vi.useRealTimers()

      await Promise.all([prompt, switching])
      expect(oldAgent.destroy).toHaveBeenCalledOnce()
      expect(oldAgent.prompt).toHaveBeenCalledOnce()
      expect(createNewAgent).toHaveBeenCalledOnce()
      expect(session.agentInstance).toBe(newAgent)
    } finally {
      vi.useRealTimers()
    }
  })

  it('destroys an unresponsive auto-name agent before creating the replacement', async () => {
    vi.useFakeTimers()
    try {
      let finishAutoName!: () => void
      const oldAgent = mockAgentInstance()
      oldAgent.prompt
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => new Promise<void>((resolve) => { finishAutoName = resolve }))
      oldAgent.cancel.mockImplementation(() => new Promise<void>(() => {}))
      oldAgent.destroy.mockImplementation(async () => { finishAutoName() })
      const session = createTestSession(oldAgent, 'claude')
      const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
      const createNewAgent = vi.fn(async () => newAgent)

      const prompt = session.enqueuePrompt('name this session')
      await vi.waitFor(() => expect(oldAgent.prompt).toHaveBeenCalledTimes(2))
      const switching = session.switchAgent('gemini', createNewAgent)
      await Promise.resolve()

      expect(oldAgent.cancel).toHaveBeenCalledOnce()
      expect(oldAgent.destroy).not.toHaveBeenCalled()
      expect(createNewAgent).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      vi.useRealTimers()

      await Promise.all([prompt, switching])
      expect(oldAgent.destroy).toHaveBeenCalledOnce()
      expect(createNewAgent).toHaveBeenCalledOnce()
      expect(session.agentInstance).toBe(newAgent)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['success', 'fallback'] as const)(
    'discards an old auto-name %s that settles while switch teardown is pending',
    async (outcome) => {
      const autoStarted = deferred()
      const releaseAuto = deferred()
      const destroyStarted = deferred()
      const releaseDestroy = deferred()
      const oldAgent = mockAgentInstance({ sessionId: 'old-sess' })
      oldAgent.prompt.mockImplementation(async (text: string) => {
        if (!text.startsWith('Summarize this conversation')) return
        autoStarted.resolve()
        await releaseAuto.promise
        if (outcome === 'fallback') throw new Error('old auto-name failed')
        oldAgent.emit('agent_event', { type: 'text', content: 'Old Agent Title' })
      })
      oldAgent.destroy.mockImplementation(async () => {
        destroyStarted.resolve()
        await releaseDestroy.promise
      })
      const session = createTestSession(oldAgent, 'claude')
      const newAgent = mockAgentInstance({ sessionId: 'new-sess' })
      newAgent.prompt.mockImplementation(async (text: string) => {
        if (text.startsWith('Summarize this conversation')) {
          newAgent.emit('agent_event', { type: 'text', content: 'New Agent Title' })
        }
      })
      const createNewAgent = vi.fn(async () => newAgent)

      const prompt = session.enqueuePrompt('start old auto-name')
      await autoStarted.promise
      const switching = session.switchAgent('gemini', createNewAgent)
      await destroyStarted.promise
      expect(createNewAgent).not.toHaveBeenCalled()

      releaseAuto.resolve()
      await prompt
      expect(session.name).toBeUndefined()
      expect(session.nameSource).toBeUndefined()

      releaseDestroy.resolve()
      await switching
      expect(session.agentInstance).toBe(newAgent)
      expect(session.name).toBeUndefined()

      await session.enqueuePrompt('name with replacement')
      expect(session.name).toBe('New Agent Title')
      expect(session.nameSource).toBe('auto')
    },
  )

  it('allows a retained old agent to auto-name only on a new prompt after switch teardown fails', async () => {
    const autoStarted = deferred()
    const releaseAuto = deferred()
    const destroyStarted = deferred()
    const releaseDestroy = deferred()
    const oldAgent = mockAgentInstance({ sessionId: 'old-sess' })
    let autoAttempt = 0
    oldAgent.prompt.mockImplementation(async (text: string) => {
      if (!text.startsWith('Summarize this conversation')) return
      autoAttempt += 1
      if (autoAttempt === 1) {
        autoStarted.resolve()
        await releaseAuto.promise
        oldAgent.emit('agent_event', { type: 'text', content: 'Invalidated Old Title' })
      } else {
        oldAgent.emit('agent_event', { type: 'text', content: 'Retained Agent Retry' })
      }
    })
    oldAgent.destroy.mockImplementation(async () => {
      destroyStarted.resolve()
      await releaseDestroy.promise
      throw new Error('old process retained')
    })
    const session = createTestSession(oldAgent, 'claude')

    const prompt = session.enqueuePrompt('start retained-agent race')
    await autoStarted.promise
    const switching = session.switchAgent('gemini', async () => mockAgentInstance())
    await destroyStarted.promise
    releaseAuto.resolve()
    await prompt
    expect(session.name).toBeUndefined()

    releaseDestroy.resolve()
    await expect(switching).rejects.toThrow('old process retained')
    expect(session.agentInstance).toBe(oldAgent)
    expect(session.agentName).toBe('claude')

    await session.enqueuePrompt('retry naming on retained agent')
    expect(session.name).toBe('Retained Agent Retry')
    expect(session.nameSource).toBe('auto')
  })

  it('keeps old naming invalidated across a failed switch and explicit rollback', async () => {
    const autoStarted = deferred()
    const releaseAuto = deferred()
    const destroyStarted = deferred()
    const releaseDestroy = deferred()
    const oldAgent = mockAgentInstance({ sessionId: 'old-sess' })
    oldAgent.prompt.mockImplementation(async (text: string) => {
      if (!text.startsWith('Summarize this conversation')) return
      autoStarted.resolve()
      await releaseAuto.promise
      oldAgent.emit('agent_event', { type: 'text', content: 'Invalidated Before Rollback' })
    })
    oldAgent.destroy.mockImplementation(async () => {
      destroyStarted.resolve()
      await releaseDestroy.promise
    })
    const session = createTestSession(oldAgent, 'claude')

    const prompt = session.enqueuePrompt('start rollback race')
    await autoStarted.promise
    const switching = session.switchAgent('gemini', async () => {
      throw new Error('replacement startup failed')
    })
    await destroyStarted.promise
    releaseAuto.resolve()
    await prompt
    releaseDestroy.resolve()
    await expect(switching).rejects.toThrow('replacement startup failed')
    expect(session.name).toBeUndefined()

    const rollbackAgent = mockAgentInstance({ sessionId: 'rollback-sess' })
    rollbackAgent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith('Summarize this conversation')) {
        rollbackAgent.emit('agent_event', { type: 'text', content: 'Rollback Agent Title' })
      }
    })
    await session.restoreAgentAfterFailedSwitch('claude', async () => rollbackAgent)
    await session.enqueuePrompt('name after rollback')

    expect(session.agentInstance).toBe(rollbackAgent)
    expect(session.name).toBe('Rollback Agent Title')
    expect(session.nameSource).toBe('auto')
  })

  it('keeps naming ownership with the final agent across rapid sequential switches', async () => {
    const agentA = mockAgentInstance({ sessionId: 'a-sess' })
    const session = createTestSession(agentA, 'agentA')
    const agentB = mockAgentInstance({ sessionId: 'b-sess' })
    const agentC = mockAgentInstance({ sessionId: 'c-sess' })
    agentC.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith('Summarize this conversation')) {
        agentC.emit('agent_event', { type: 'text', content: 'Final Agent Title' })
      }
    })

    await session.switchAgent('agentB', async () => agentB)
    await session.switchAgent('agentC', async () => agentC)
    await session.enqueuePrompt('name final agent')

    expect(session.agentInstance).toBe(agentC)
    expect(session.name).toBe('Final Agent Title')
    expect(session.nameSource).toBe('auto')
  })
})
