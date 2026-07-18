import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Session } from '../session.js'
import type { AgentInstance } from '../../agents/agent-instance.js'
import type { AgentCapabilities, ConfigOption } from '../../types.js'
import { MiddlewareChain } from '../../plugin/middleware-chain.js'

function mockAgentInstance() {
  return {
    sessionId: 'agent-sess-1',
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue({ configOptions: [] }),
    onPermissionRequest: vi.fn(),
  } as unknown as AgentInstance
}

describe('Session ACP state', () => {
  let session: Session

  beforeEach(() => {
    session = new Session({
      id: 'test-session',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/tmp',
      agentInstance: mockAgentInstance(),
    })
  })

  it('initializes with empty configOptions', () => {
    expect(session.configOptions).toEqual([])
  })

  it('initializes with undefined agentCapabilities', () => {
    expect(session.agentCapabilities).toBeUndefined()
  })

  it('setInitialConfigOptions stores config options', () => {
    const configOptions: ConfigOption[] = [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'code',
        options: [
          { value: 'code', name: 'Code' },
          { value: 'architect', name: 'Architect' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'sonnet',
        options: [{ value: 'sonnet', name: 'Sonnet' }],
      },
    ]

    session.setInitialConfigOptions(configOptions)

    expect(session.configOptions).toHaveLength(2)
    expect(session.getConfigValue('mode')).toBe('code')
    expect(session.getConfigValue('model')).toBe('sonnet')
  })

  it('getConfigByCategory returns option by category', () => {
    const configOptions: ConfigOption[] = [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'code',
        options: [{ value: 'code', name: 'Code' }],
      },
    ]
    session.setInitialConfigOptions(configOptions)

    const modeOption = session.getConfigByCategory('mode')
    expect(modeOption).toBeDefined()
    expect(modeOption?.currentValue).toBe('code')
  })

  it('updateConfigOptions replaces options', async () => {
    const opts: ConfigOption[] = [
      {
        id: 'thought',
        name: 'Thinking',
        type: 'boolean',
        currentValue: true,
      },
    ]
    await session.updateConfigOptions(opts)
    expect(session.configOptions).toEqual(opts)
  })

  it('setAgentCapabilities stores capabilities', () => {
    session.setAgentCapabilities({ name: 'claude', loadSession: true } as AgentCapabilities)
    expect(session.agentCapabilities?.name).toBe('claude')
  })

  it('toAcpStateSnapshot returns configOptions and agentCapabilities', () => {
    const configOptions: ConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'sonnet',
        options: [{ value: 'sonnet', name: 'Sonnet' }],
      },
    ]
    session.setInitialConfigOptions(configOptions)
    session.setAgentCapabilities({ name: 'claude' } as AgentCapabilities)

    const snapshot = session.toAcpStateSnapshot()
    expect(snapshot.configOptions).toHaveLength(1)
    expect(snapshot.agentCapabilities?.name).toBe('claude')
  })

  it('toAcpStateSnapshot omits configOptions when empty', () => {
    const snapshot = session.toAcpStateSnapshot()
    expect(snapshot.configOptions).toBeUndefined()
    expect(snapshot.agentCapabilities).toBeUndefined()
  })

  it('getConfigOption returns option by id', () => {
    const configOptions: ConfigOption[] = [
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'sonnet',
        options: [{ value: 'sonnet', name: 'Sonnet' }],
      },
    ]
    session.setInitialConfigOptions(configOptions)

    expect(session.getConfigOption('model')).toBeDefined()
    expect(session.getConfigOption('nonexistent')).toBeUndefined()
  })

  it('clientOverrides starts empty', () => {
    expect(session.clientOverrides).toEqual({})
    expect(session.clientOverrides.bypassPermissions).toBeUndefined()
  })
})

describe('Session.setConfigOption legacy fallback (empty configOptions response)', () => {
  const initialOptions: ConfigOption[] = [
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'code',
      options: [
        { value: 'code', name: 'Code' },
        { value: 'architect', name: 'Architect' },
      ],
    },
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'sonnet',
      options: [
        { value: 'sonnet', name: 'Sonnet' },
        { value: 'opus', name: 'Opus' },
      ],
    },
  ]

  let session: Session
  let agent: ReturnType<typeof mockAgentInstance>

  beforeEach(() => {
    agent = mockAgentInstance()
    session = new Session({
      id: 'test-session',
      channelId: 'telegram',
      agentName: 'gemini',
      workingDirectory: '/tmp',
      agentInstance: agent,
    })
    session.setInitialConfigOptions(initialOptions)
  })

  it('updates currentValue after a successful legacy acknowledgement', async () => {
    // Simulate legacy agent (e.g. Gemini) returning empty configOptions
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [], legacyAcknowledged: true })

    await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    expect(session.getConfigValue('mode')).toBe('architect')
  })

  it('preserves other options when updating one optimistically', async () => {
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [], legacyAcknowledged: true })

    await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    // model option should be unchanged
    expect(session.getConfigValue('model')).toBe('sonnet')
    expect(session.configOptions).toHaveLength(2)
  })

  it('uses full response configOptions when agent returns them (non-legacy)', async () => {
    const updatedOptions: ConfigOption[] = [
      { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'architect', options: [] },
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [] },
    ]
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: updatedOptions })

    await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    // Should use the full response, including model change returned by agent
    expect(session.configOptions).toEqual(updatedOptions)
    expect(session.getConfigValue('model')).toBe('opus')
  })

  it('treats an official empty configOptions array as authoritative acknowledgement', async () => {
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [] })

    const outcome = await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    expect(outcome).toMatchObject({ acknowledged: true, authoritative: true })
    expect(outcome.effective).toBeUndefined()
    expect(session.configOptions).toEqual([])
  })

  it('does not touch boolean options when updating a select option optimistically', async () => {
    const withBoolean: ConfigOption[] = [
      ...initialOptions,
      { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: true },
    ]
    session.setInitialConfigOptions(withBoolean)
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [], legacyAcknowledged: true })

    await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    const verboseOpt = session.getConfigOption('verbose')
    expect(verboseOpt?.type).toBe('boolean')
    if (verboseOpt?.type === 'boolean') {
      expect(verboseOpt.currentValue).toBe(true)
    }
  })

  it('model currentValue updated optimistically when agent returns empty configOptions', async () => {
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [], legacyAcknowledged: true })

    await session.setConfigOption('model', { type: 'select', value: 'opus' })

    expect(session.getConfigValue('model')).toBe('opus')
    expect(session.getConfigValue('mode')).toBe('code') // mode unchanged
  })
})

describe('Session.setConfigOption policy and lifecycle ordering', () => {
  const oldOption: ConfigOption = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'code',
    options: [
      { value: 'code', name: 'Code' },
      { value: 'architect', name: 'Architect' },
    ],
  }
  const newOption: ConfigOption = { ...oldOption, currentValue: 'architect' }

  function setup() {
    const agent = mockAgentInstance()
    const session = new Session({
      id: 'config-policy-session',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/tmp',
      agentInstance: agent,
    })
    session.setInitialConfigOptions([oldOption])
    return { agent, session }
  }

  it('blocks before RPC and preserves effective state when policy returns null', async () => {
    const { agent, session } = setup()
    const chain = new MiddlewareChain()
    chain.add('config:beforeChange', 'policy', { handler: vi.fn().mockResolvedValue(null) })
    session.middlewareChain = chain

    const outcome = await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    expect(agent.setConfigOption).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ acknowledged: false, authoritative: false, reason: 'blocked' })
    expect(outcome.message).toBe('Configuration change was blocked by policy.')
    expect(session.getConfigValue('mode')).toBe('code')
    expect(session.toAcpStateSnapshot().configOptions?.[0]).toMatchObject({ currentValue: 'code' })
  })

  it('fails closed before RPC when policy throws', async () => {
    const { agent, session } = setup()
    const chain = new MiddlewareChain()
    const errorHandler = vi.fn()
    chain.setErrorHandler(errorHandler)
    chain.add('config:beforeChange', 'broken-policy', {
      handler: vi.fn().mockRejectedValue(new Error('secret plugin diagnostic')),
    })
    session.middlewareChain = chain

    const outcome = await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    expect(errorHandler).toHaveBeenCalledOnce()
    expect(agent.setConfigOption).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ acknowledged: false, reason: 'blocked' })
    expect(outcome.message).not.toContain('secret plugin diagnostic')
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('runs policy before RPC and reports the authoritative effective value to the after hook', async () => {
    const { agent, session } = setup()
    const order: string[] = []
    vi.mocked(agent.setConfigOption).mockImplementationOnce(async () => {
      order.push('rpc')
      return { configOptions: [newOption] }
    })
    const chain = new MiddlewareChain()
    const afterPayload = vi.fn()
    chain.add('config:beforeChange', 'policy', {
      handler: async (payload: unknown, next: () => Promise<unknown>) => {
        order.push('before')
        return next()
      },
    })
    chain.add('config:afterChange', 'observer', {
      handler: async (payload: unknown) => {
        order.push('after')
        afterPayload(payload)
        return payload
      },
    })
    session.middlewareChain = chain

    const outcome = await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    expect(order).toEqual(['before', 'rpc', 'after'])
    expect(outcome).toMatchObject({ acknowledged: true, authoritative: true })
    expect(outcome.effective).toMatchObject({ currentValue: 'architect' })
    expect(session.getConfigValue('mode')).toBe('architect')
    expect(afterPayload).toHaveBeenCalledWith(expect.objectContaining({
      configId: 'mode',
      oldValue: 'code',
      requestedValue: 'architect',
      newValue: 'architect',
      acknowledged: true,
      authoritative: true,
    }))
  })

  it('leaves local state unchanged and skips after hook when agent RPC rejects', async () => {
    const { agent, session } = setup()
    vi.mocked(agent.setConfigOption).mockRejectedValueOnce(new Error('agent rejected request'))
    const chain = new MiddlewareChain()
    const after = vi.fn()
    chain.add('config:beforeChange', 'policy', {
      handler: async (_payload: unknown, next: () => Promise<unknown>) => next(),
    })
    chain.add('config:afterChange', 'observer', { handler: after })
    session.middlewareChain = chain

    await expect(session.setConfigOption('mode', { type: 'select', value: 'architect' }))
      .rejects.toThrow('agent rejected request')
    expect(session.getConfigValue('mode')).toBe('code')
    expect(after).not.toHaveBeenCalled()
  })

  it('keeps an acknowledged change when the observational after hook throws', async () => {
    const { agent, session } = setup()
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [newOption] })
    const chain = new MiddlewareChain()
    const errorHandler = vi.fn()
    chain.setErrorHandler(errorHandler)
    chain.add('config:afterChange', 'broken-observer', {
      handler: vi.fn().mockRejectedValue(new Error('observer failed')),
    })
    session.middlewareChain = chain

    const outcome = await session.setConfigOption('mode', { type: 'select', value: 'architect' })

    expect(outcome).toMatchObject({ acknowledged: true, authoritative: true })
    expect(session.getConfigValue('mode')).toBe('architect')
    await vi.waitFor(() => expect(errorHandler).toHaveBeenCalledOnce())
  })

  it('does not start RPC when termination wins while the before hook is pending', async () => {
    const { agent, session } = setup()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const entered = vi.fn()
    const chain = new MiddlewareChain()
    chain.add('config:beforeChange', 'slow-policy', {
      handler: async (payload: unknown) => {
        entered()
        await held
        return payload
      },
    })
    session.middlewareChain = chain

    const changing = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce())
    session.beginTermination()
    release()

    await expect(changing).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    expect(agent.setConfigOption).not.toHaveBeenCalled()
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('does not apply a stale acknowledgement when the agent switches during RPC', async () => {
    const { agent, session } = setup()
    let resolveRpc!: (value: { configOptions: ConfigOption[] }) => void
    const heldRpc = new Promise<{ configOptions: ConfigOption[] }>((resolve) => { resolveRpc = resolve })
    vi.mocked(agent.setConfigOption).mockReturnValueOnce(heldRpc as any)

    const changing = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    const queued = session.setConfigOption('mode', { type: 'select', value: 'code' })
    await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledOnce())

    const replacement = mockAgentInstance()
    replacement.initialSessionResponse = { configOptions: [oldOption] }
    await session.switchAgent('gemini', async () => replacement)
    await expect(queued).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    resolveRpc({ configOptions: [newOption] })

    await expect(changing).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    expect(agent.setConfigOption).toHaveBeenCalledOnce()
    expect(replacement.setConfigOption).not.toHaveBeenCalled()
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('serializes same-generation changes in arrival order and returns stable snapshots', async () => {
    const { agent, session } = setup()
    let resolveFirst!: (value: { configOptions: ConfigOption[] }) => void
    const firstRpc = new Promise<{ configOptions: ConfigOption[] }>((resolve) => { resolveFirst = resolve })
    const codeOption = { ...oldOption, currentValue: 'code' }
    vi.mocked(agent.setConfigOption)
      .mockReturnValueOnce(firstRpc as any)
      .mockResolvedValueOnce({ configOptions: [codeOption] })

    const architect = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    const code = session.setConfigOption('mode', { type: 'select', value: 'code' })
    await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledTimes(1))
    resolveFirst({ configOptions: [newOption] })

    const [architectOutcome, codeOutcome] = await Promise.all([architect, code])
    expect(agent.setConfigOption).toHaveBeenNthCalledWith(1, 'mode', { type: 'select', value: 'architect' })
    expect(agent.setConfigOption).toHaveBeenNthCalledWith(2, 'mode', { type: 'select', value: 'code' })
    expect(architectOutcome.configOptions[0]).toMatchObject({ currentValue: 'architect' })
    expect(codeOutcome.configOptions[0]).toMatchObject({ currentValue: 'code' })
    expect(codeOutcome.revision).toBeGreaterThan(architectOutcome.revision)
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('continues FIFO processing when the first policy blocks or RPC rejects', async () => {
    const { agent, session } = setup()
    const chain = new MiddlewareChain()
    chain.add('config:beforeChange', 'policy', {
      handler: async (payload: any, next: (value?: unknown) => Promise<unknown>) => (
        payload.newValue === 'architect' ? null : next()
      ),
    })
    session.middlewareChain = chain
    vi.mocked(agent.setConfigOption).mockResolvedValueOnce({ configOptions: [{ ...oldOption, currentValue: 'code' }] })

    const blocked = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    const allowed = session.setConfigOption('mode', { type: 'select', value: 'code' })
    await expect(blocked).resolves.toMatchObject({ acknowledged: false, reason: 'blocked' })
    await expect(allowed).resolves.toMatchObject({ acknowledged: true })
    expect(agent.setConfigOption).toHaveBeenCalledOnce()

    session.middlewareChain = undefined
    vi.mocked(agent.setConfigOption)
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce({ configOptions: [newOption] })
    const failed = session.setConfigOption('mode', { type: 'select', value: 'code' })
    const afterFailure = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    await expect(failed).rejects.toThrow('first failed')
    await expect(afterFailure).resolves.toMatchObject({ acknowledged: true })
    expect(session.getConfigValue('mode')).toBe('architect')
  })

  it('invalidates queued changes immediately when termination wins', async () => {
    const { agent, session } = setup()
    let resolveFirst!: (value: { configOptions: ConfigOption[] }) => void
    vi.mocked(agent.setConfigOption).mockReturnValueOnce(
      new Promise((resolve) => { resolveFirst = resolve }) as any,
    )
    const active = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    const queued = session.setConfigOption('mode', { type: 'select', value: 'code' })
    await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledOnce())

    session.beginTermination()
    await expect(queued).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    expect(agent.setConfigOption).toHaveBeenCalledOnce()
    resolveFirst({ configOptions: [newOption] })
    await expect(active).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('releases an active never-settling RPC caller when termination wins', async () => {
    const { agent, session } = setup()
    vi.mocked(agent.setConfigOption).mockReturnValueOnce(new Promise(() => {}) as any)
    const active = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledOnce())

    session.beginTermination()
    await expect(active).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('observes a late RPC rejection after invalidation without changing state', async () => {
    const { agent, session } = setup()
    let rejectRpc!: (error: Error) => void
    vi.mocked(agent.setConfigOption).mockReturnValueOnce(
      new Promise((_resolve, reject) => { rejectRpc = reject }) as any,
    )
    const active = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledOnce())
    session.beginTermination()
    await expect(active).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })

    rejectRpc(new Error('late transport rejection'))
    await Promise.resolve()
    await Promise.resolve()
    expect(session.getConfigValue('mode')).toBe('code')
  })

  it('releases an active old RPC and lets the replacement generation mutate config', async () => {
    const { agent, session } = setup()
    vi.mocked(agent.setConfigOption).mockReturnValueOnce(new Promise(() => {}) as any)
    const active = session.setConfigOption('mode', { type: 'select', value: 'architect' })
    await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledOnce())
    const replacement = mockAgentInstance()
    replacement.initialSessionResponse = { configOptions: [oldOption] }
    vi.mocked(replacement.setConfigOption).mockResolvedValueOnce({ configOptions: [newOption] })

    await session.switchAgent('gemini', async () => replacement)
    await expect(active).resolves.toMatchObject({ acknowledged: false, reason: 'superseded' })
    await expect(session.setConfigOption('mode', { type: 'select', value: 'architect' }))
      .resolves.toMatchObject({ acknowledged: true })
    expect(replacement.setConfigOption).toHaveBeenCalledOnce()
    expect(session.getConfigValue('mode')).toBe('architect')
  })

  it('bounds queue wait without starting a timed-out RPC', async () => {
    vi.useFakeTimers()
    try {
      const { agent, session } = setup()
      let resolveFirst!: (value: { configOptions: ConfigOption[] }) => void
      vi.mocked(agent.setConfigOption).mockReturnValueOnce(
        new Promise((resolve) => { resolveFirst = resolve }) as any,
      )
      const active = session.setConfigOption('mode', { type: 'select', value: 'architect' })
      await vi.advanceTimersByTimeAsync(0)
      expect(agent.setConfigOption).toHaveBeenCalledOnce()
      const queued = session.setConfigOption('mode', { type: 'select', value: 'code' })

      await vi.advanceTimersByTimeAsync(30_000)
      await expect(queued).resolves.toMatchObject({ acknowledged: false, reason: 'queue_timeout' })
      expect(agent.setConfigOption).toHaveBeenCalledOnce()
      resolveFirst({ configOptions: [newOption] })
      await expect(active).resolves.toMatchObject({ acknowledged: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
