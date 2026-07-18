import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  children: [] as any[],
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
}))

vi.mock('node:child_process', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  return {
    execFileSync: vi.fn().mockReturnValue('/bin/fake-agent\n'),
    spawn: vi.fn(() => {
      const child = new EventEmitter() as any
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.exitCode = null
      child.killed = false
      child.kill = vi.fn((signal: string) => {
        if (child.exitCode === null) {
          child.killed = true
          child.exitCode = 0
          queueMicrotask(() => child.emit('exit', 0, signal))
        }
        return true
      })
      state.children.push(child)
      queueMicrotask(() => child.emit('spawn'))
      return child
    }),
  }
})

vi.mock('@agentclientprotocol/sdk', () => ({
  PROTOCOL_VERSION: 1,
  ndJsonStream: vi.fn().mockReturnValue({}),
  ClientSideConnection: class {
    closed = Promise.resolve()
    initialize = state.initialize
    newSession = state.newSession
    loadSession = state.loadSession
    resumeSession = state.resumeSession
  },
}))

import { AgentInstance } from '../agent-instance.js'
import type { AgentDefinition } from '../../types.js'

const agentDefinition: AgentDefinition = {
  name: 'test-agent',
  command: 'fake-agent',
  args: [],
  env: {},
}

describe('AgentInstance initialization cleanup', () => {
  beforeEach(() => {
    state.children.length = 0
    state.initialize.mockReset().mockResolvedValue({
      protocolVersion: 1,
      agentCapabilities: {},
    })
    state.newSession.mockReset().mockResolvedValue({ sessionId: 'new-session' })
    state.loadSession.mockReset().mockResolvedValue({})
    state.resumeSession.mockReset().mockResolvedValue({})
  })

  it('destroys the acquired subprocess exactly once when initialize rejects', async () => {
    const original = new Error('initialize failed')
    state.initialize.mockRejectedValueOnce(original)

    await expect(AgentInstance.spawnSubprocess(agentDefinition, '/tmp')).rejects.toBe(original)
    expect(state.children).toHaveLength(1)
    expect(state.children[0].kill).toHaveBeenCalledOnce()
    expect(state.children[0].kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('destroys the initialized subprocess exactly once when newSession rejects', async () => {
    const original = new Error('newSession failed')
    state.newSession.mockRejectedValueOnce(original)

    await expect(AgentInstance.spawn(agentDefinition, '/tmp')).rejects.toBe(original)
    expect(state.children).toHaveLength(1)
    expect(state.children[0].kill).toHaveBeenCalledOnce()
  })

  it('destroys once and preserves the fallback error when load and fallback newSession both reject', async () => {
    state.initialize.mockResolvedValueOnce({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    })
    state.loadSession.mockRejectedValueOnce(new Error('load failed'))
    const fallback = new Error('fallback newSession failed')
    state.newSession.mockRejectedValueOnce(fallback)

    await expect(AgentInstance.resume(agentDefinition, '/tmp', 'old-session')).rejects.toBe(fallback)
    expect(state.loadSession).toHaveBeenCalledOnce()
    expect(state.newSession).toHaveBeenCalledOnce()
    expect(state.children).toHaveLength(1)
    expect(state.children[0].kill).toHaveBeenCalledOnce()
  })
})
