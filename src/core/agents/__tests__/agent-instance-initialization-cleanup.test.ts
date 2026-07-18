import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  children: [] as any[],
  initialize: vi.fn(),
  newSession: vi.fn(),
  loadSession: vi.fn(),
  resumeSession: vi.fn(),
  killImpl: undefined as undefined | ((child: any, signal: string) => boolean),
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
      child.signalCode = null
      child.killed = false
      child.kill = vi.fn((signal: string) => {
        if (state.killImpl) return state.killImpl(child, signal)
        if (child.exitCode === null) {
          child.killed = true
          queueMicrotask(() => {
            child.signalCode = signal
            child.emit('exit', null, signal)
          })
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

import {
  AgentInstance,
  INITIALIZATION_SHUTDOWN_CLEANUP_BUDGET_MS,
} from '../agent-instance.js'
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
    state.killImpl = undefined
  })

  afterEach(async () => {
    state.killImpl = (child, signal) => {
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      })
      return true
    }
    await AgentInstance.shutdownInitializationCleanups()
    vi.useRealTimers()
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

  it('keeps concurrent destroy joined but permits a later retry after cleanup rejects', async () => {
    const instance = await AgentInstance.spawnSubprocess(agentDefinition, '/tmp')
    const terminalCleanup = vi.fn()
      .mockImplementationOnce(() => { throw new Error('terminal cleanup failed') })
      .mockImplementationOnce(() => undefined)
    ;(instance as any).terminalManager.destroyAll = terminalCleanup

    const first = instance.destroy()
    const concurrent = instance.destroy()
    await expect(first).rejects.toThrow('terminal cleanup failed')
    await expect(concurrent).rejects.toThrow('terminal cleanup failed')
    expect(terminalCleanup).toHaveBeenCalledOnce()
    expect(state.children[0].kill).not.toHaveBeenCalled()

    await expect(instance.destroy()).resolves.toBeUndefined()
    expect(terminalCleanup).toHaveBeenCalledTimes(2)
    expect(state.children[0].kill).toHaveBeenCalledOnce()
  })

  it('rejects when SIGTERM reports that no signal was sent', async () => {
    const instance = await AgentInstance.spawnSubprocess(agentDefinition, '/tmp')
    state.killImpl = () => false

    await expect(instance.destroy()).rejects.toThrow('Failed to send SIGTERM')
    expect(state.children[0].kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('rejects when SIGTERM throws and permits a later successful retry', async () => {
    const instance = await AgentInstance.spawnSubprocess(agentDefinition, '/tmp')
    state.killImpl = () => { throw new Error('signal denied') }

    await expect(instance.destroy()).rejects.toThrow('signal denied')

    state.killImpl = (child, signal) => {
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      })
      return true
    }
    await expect(instance.destroy()).resolves.toBeUndefined()
  })

  it('uses SIGKILL after the grace period and rejects until exit is observed', async () => {
    vi.useFakeTimers()
    const instance = await AgentInstance.spawnSubprocess(agentDefinition, '/tmp')
    state.killImpl = () => true

    const destroying = instance.destroy()
    const rejected = expect(destroying).rejects.toThrow('did not exit')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.children[0].kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
    expect(state.children[0].kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(5_000)
    await rejected
    vi.useRealTimers()
  })

  it('retains failed initialization cleanup and clears it after the bounded retry observes exit', async () => {
    vi.useFakeTimers()
    const original = new Error('initialize failed')
    state.initialize.mockRejectedValueOnce(original)
    state.killImpl = () => false

    await expect(AgentInstance.spawnSubprocess(agentDefinition, '/tmp')).rejects.toBe(original)
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toEqual({
      pending: 0,
      failed: 1,
      terminalFailed: 0,
      capacity: 32,
    })

    state.killImpl = (child, signal) => {
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      })
      return true
    }
    await vi.advanceTimersByTimeAsync(250)
    await vi.runAllTicks()
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toEqual({
      pending: 0,
      failed: 0,
      terminalFailed: 0,
      capacity: 32,
    })
  })

  it('marks repeated no-exit cleanup terminal-failed and makes a final shutdown attempt without dropping ownership', async () => {
    vi.useFakeTimers()
    state.initialize.mockRejectedValueOnce(new Error('initialize failed'))
    state.killImpl = () => false

    await expect(AgentInstance.spawnSubprocess(agentDefinition, '/tmp')).rejects.toThrow('initialize failed')
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(500)
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toEqual({
      pending: 0,
      failed: 1,
      terminalFailed: 1,
      capacity: 32,
    })

    await AgentInstance.shutdownInitializationCleanups()
    expect(state.children[0].kill).toHaveBeenCalledTimes(5)
    expect(state.children[0].kill).toHaveBeenLastCalledWith('SIGKILL')
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toMatchObject({
      failed: 1,
      terminalFailed: 1,
    })

    state.killImpl = (child, signal) => {
      queueMicrotask(() => {
        child.signalCode = signal
        child.emit('exit', null, signal)
      })
      return true
    }
    await AgentInstance.shutdownInitializationCleanups()
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toMatchObject({
      pending: 0,
      failed: 0,
      terminalFailed: 0,
    })
  })

  it('caps retained failed-initialization owners and rejects before spawning an unowned child', async () => {
    vi.useFakeTimers()
    state.initialize.mockRejectedValue(new Error('initialize failed'))
    state.killImpl = () => false

    for (let index = 0; index < 32; index += 1) {
      await expect(AgentInstance.spawnSubprocess(agentDefinition, '/tmp')).rejects.toThrow('initialize failed')
    }
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toMatchObject({
      pending: 0,
      failed: 32,
      capacity: 32,
    })
    expect(state.children).toHaveLength(32)

    await expect(AgentInstance.spawnSubprocess(agentDefinition, '/tmp')).rejects.toThrow(
      'Agent initialization is temporarily unavailable',
    )
    expect(state.children).toHaveLength(32)
  })

  it('bounds 32 hung shutdown cleanups by one global deadline and detaches exit waits', async () => {
    vi.useFakeTimers()
    state.initialize.mockRejectedValue(new Error('initialize failed'))
    state.killImpl = () => true

    const failures = Array.from({ length: 32 }, () =>
      AgentInstance.spawnSubprocess(agentDefinition, '/tmp').catch((error) => error),
    )
    await vi.advanceTimersByTimeAsync(15_000)
    await Promise.all(failures)
    expect(AgentInstance.getInitializationCleanupResourceStatus().failed).toBe(32)

    const startedAt = Date.now()
    const firstShutdown = AgentInstance.shutdownInitializationCleanups()
    const concurrentShutdown = AgentInstance.shutdownInitializationCleanups()
    await vi.advanceTimersByTimeAsync(INITIALIZATION_SHUTDOWN_CLEANUP_BUDGET_MS)
    await Promise.all([firstShutdown, concurrentShutdown])

    expect(Date.now() - startedAt).toBe(INITIALIZATION_SHUTDOWN_CLEANUP_BUDGET_MS)
    expect(AgentInstance.getInitializationCleanupResourceStatus()).toMatchObject({
      pending: 0,
      failed: 32,
      terminalFailed: 32,
      capacity: 32,
    })
    for (const child of state.children) {
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.stdout.destroyed).toBe(true)
      expect(child.stderr.destroyed).toBe(true)
    }
  })

  it('handles quick, throwing, hung, and already-exited children within the same shutdown budget', async () => {
    vi.useFakeTimers()
    state.initialize.mockRejectedValue(new Error('initialize failed'))
    state.killImpl = () => false
    const failures = Array.from({ length: 4 }, () =>
      AgentInstance.spawnSubprocess(agentDefinition, '/tmp').catch((error) => error),
    )
    await Promise.all(failures)

    const [quick, throwing, hung, alreadyExited] = state.children
    alreadyExited.signalCode = 'SIGTERM'
    state.killImpl = (child, signal) => {
      if (child === quick) {
        queueMicrotask(() => {
          child.signalCode = signal
          child.emit('exit', null, signal)
        })
        return true
      }
      if (child === throwing) throw new Error('signal denied')
      if (child === hung) return true
      return false
    }

    const shutdown = AgentInstance.shutdownInitializationCleanups()
    await vi.advanceTimersByTimeAsync(INITIALIZATION_SHUTDOWN_CLEANUP_BUDGET_MS)
    await shutdown

    expect(AgentInstance.getInitializationCleanupResourceStatus()).toMatchObject({
      pending: 0,
      failed: 2,
      terminalFailed: 2,
    })
    expect(quick.kill).toHaveBeenCalledWith('SIGTERM')
    expect(throwing.kill).toHaveBeenCalledWith('SIGTERM')
    expect(hung.kill).toHaveBeenCalledWith('SIGKILL')
    expect(alreadyExited.kill).toHaveBeenCalledTimes(1)
    expect(hung.listenerCount('exit')).toBe(0)
  })
})
