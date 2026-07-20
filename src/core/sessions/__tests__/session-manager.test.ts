import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { SessionManager } from '../session-manager.js'
import { Session } from '../session.js'
import { SessionFactory } from '../session-factory.js'
import type { SessionStore } from '../session-store.js'
import { JsonFileSessionStore } from '../session-store.js'
import type { SessionRecord } from '../../types.js'
import { TypedEmitter } from '../../utils/typed-emitter.js'

function mockAgentInstance(sessionId = 'agent-sess-1') {
  const emitter = new TypedEmitter()
  return Object.assign(emitter, {
    sessionId,
    prompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onSessionUpdate: vi.fn(),
    onPermissionRequest: vi.fn(),
  }) as any
}

function createSession(overrides: Partial<{ id: string; channelId: string; threadId: string; agentName: string; agentSessionId: string }> = {}): Session {
  const session = new Session({
    id: overrides.id,
    channelId: overrides.channelId || 'telegram',
    agentName: overrides.agentName || 'claude',
    workingDirectory: '/workspace',
    agentInstance: mockAgentInstance(overrides.agentSessionId),
  })
  if (overrides.threadId) session.threadId = overrides.threadId
  if (overrides.agentSessionId) session.agentSessionId = overrides.agentSessionId
  return session
}

function mockStore(): SessionStore {
  const records = new Map<string, SessionRecord>()
  return {
    save: vi.fn(async (record: SessionRecord) => { records.set(record.sessionId, record) }),
    get: vi.fn((id: string) => records.get(id)),
    findByPlatform: vi.fn((channelId: string, pred: (p: any) => boolean) => {
      for (const r of records.values()) {
        if (r.channelId === channelId && pred(r.platform)) return r
      }
      return undefined
    }),
    findByAgentSessionId: vi.fn((agentSessionId: string) => {
      for (const r of records.values()) {
        if (r.agentSessionId === agentSessionId) return r
      }
      return undefined
    }),
    list: vi.fn((channelId?: string) => {
      const all = Array.from(records.values())
      if (channelId) return all.filter(r => r.channelId === channelId)
      return all
    }),
    remove: vi.fn(async (id: string) => { records.delete(id) }),
    flush: vi.fn(),
    findAssistant: vi.fn().mockReturnValue(undefined),
  } as unknown as SessionStore
}

describe('SessionManager', () => {
  let manager: SessionManager
  let store: SessionStore

  beforeEach(() => {
    store = mockStore()
    manager = new SessionManager(store)
  })

  describe('registerSession()', () => {
    it('adds session to in-memory map', () => {
      const session = createSession({ id: 'test-1' })
      manager.registerSession(session)
      expect(manager.getSession('test-1')).toBe(session)
    })

    it('rejects and cleans a duplicate id without overwriting the live owner', async () => {
      const s1 = createSession({ id: 'test-1' })
      const s2 = createSession({ id: 'test-1' })
      manager.registerSession(s1)
      expect(() => manager.registerSession(s2)).toThrow(
        expect.objectContaining({ code: 'SESSION_REGISTRATION_SUPERSEDED' }),
      )
      expect(manager.getSession('test-1')).toBe(s1)
      await vi.waitFor(() => expect(s2.agentInstance.destroy).toHaveBeenCalledOnce())
      expect(s1.agentInstance.destroy).not.toHaveBeenCalled()
    })
  })

  describe('global closing fence', () => {
    it.each(['shutdownAll', 'destroyAll'] as const)(
      'invalidates pending registrations synchronously on %s and rejects late candidates',
      async (method) => {
        const lease = manager.beginSessionRegistration('late-session')
        const closing = manager[method]()
        expect(lease.invalidated).toBe(true)

        const late = createSession({ id: 'late-session' })
        expect(() => manager.registerSession(late, lease)).toThrow(
          expect.objectContaining({ code: 'SESSION_REGISTRATION_SUPERSEDED' }),
        )
        expect(() => manager.beginSessionRegistration('new-session')).toThrow(
          expect.objectContaining({ code: 'SESSION_REGISTRATION_SUPERSEDED' }),
        )
        await closing
        await vi.waitFor(() => expect(late.agentInstance.destroy).toHaveBeenCalledOnce())
      },
    )

    it('shares repeated shutdown calls without flushing twice', async () => {
      await Promise.all([manager.shutdownAll(), manager.shutdownAll()])
      expect(store.flush).toHaveBeenCalledOnce()
    })
  })

  describe('getSession()', () => {
    it('returns undefined for unknown id', () => {
      expect(manager.getSession('unknown')).toBeUndefined()
    })
  })

  describe('getSessionByThread()', () => {
    it('finds session by channelId and threadId', () => {
      const session = createSession({ channelId: 'telegram', threadId: '123' })
      manager.registerSession(session)

      const found = manager.getSessionByThread('telegram', '123')
      expect(found).toBe(session)
    })

    it('returns undefined when no match', () => {
      const session = createSession({ channelId: 'telegram', threadId: '123' })
      manager.registerSession(session)

      expect(manager.getSessionByThread('telegram', '999')).toBeUndefined()
      expect(manager.getSessionByThread('discord', '123')).toBeUndefined()
    })
  })

  describe('getSessionByAgentSessionId()', () => {
    it('finds session by agent session id', () => {
      const session = createSession({ agentSessionId: 'agent-abc' })
      manager.registerSession(session)

      const found = manager.getSessionByAgentSessionId('agent-abc')
      expect(found).toBe(session)
    })

    it('returns undefined for unknown agent session id', () => {
      expect(manager.getSessionByAgentSessionId('unknown')).toBeUndefined()
    })
  })

  describe('getCurrentLiveSessionsByAgentSessionId()', () => {
    it('returns every current owner including assistant sessions, but excludes terminating matches', () => {
      const primary = createSession({ id: 'primary', agentSessionId: 'shared-agent' })
      const assistant = createSession({ id: 'assistant', agentSessionId: 'shared-agent' })
      assistant.isAssistant = true
      const terminating = createSession({ id: 'terminating', agentSessionId: 'shared-agent' })
      manager.registerSession(primary)
      manager.registerSession(assistant)
      manager.registerSession(terminating)
      terminating.beginTermination()

      expect(manager.getCurrentLiveSessionsByAgentSessionId('shared-agent')).toEqual([
        primary,
        assistant,
      ])
      expect(manager.getCurrentLiveSessionsByAgentSessionId('unknown')).toEqual([])
    })
  })

  describe('getRecordByAgentSessionId()', () => {
    it('delegates to store.findByAgentSessionId', () => {
      manager.getRecordByAgentSessionId('agent-123')
      expect(store.findByAgentSessionId).toHaveBeenCalledWith('agent-123')
    })
  })

  describe('getRecordByThread()', () => {
    it('delegates to store.findByPlatform with topicId predicate', () => {
      manager.getRecordByThread('telegram', '456')
      expect(store.findByPlatform).toHaveBeenCalledWith('telegram', expect.any(Function))
    })
  })

  describe('patchRecord()', () => {
    it('merges patch with existing record', async () => {
      const record: SessionRecord = {
        sessionId: 'sess-1',
        agentSessionId: 'agent-1',
        agentName: 'claude',
        workingDir: '/workspace',
        channelId: 'telegram',
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      }
      await store.save(record)

      await manager.patchRecord('sess-1', { status: 'finished' })
      expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-1',
        status: 'finished',
      }))
    })

    it('saves full record when no existing record but patch has sessionId', async () => {
      await manager.patchRecord('new-sess', {
        sessionId: 'new-sess',
        agentSessionId: 'agent-2',
        agentName: 'claude',
        workingDir: '/ws',
        channelId: 'tg',
        status: 'initializing',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      })
      expect(store.save).toHaveBeenCalled()
    })

    it('does nothing when no record exists and patch has no sessionId', async () => {
      const saveCalls = (store.save as any).mock.calls.length
      await manager.patchRecord('nonexistent', { status: 'active' })
      expect((store.save as any).mock.calls.length).toBe(saveCalls)
    })

    it('does nothing when no store', async () => {
      const noStoreManager = new SessionManager(null)
      // Should not throw
      await noStoreManager.patchRecord('any', { status: 'active' })
    })
  })

  describe('cancelSession()', () => {
    it('aborts prompt and marks session cancelled', async () => {
      const session = createSession({ id: 'sess-cancel' })
      session.activate()
      manager.registerSession(session)
      // Save record to store so patchRecord works
      await store.save({
        sessionId: 'sess-cancel',
        agentSessionId: 'a1',
        agentName: 'claude',
        workingDir: '/ws',
        channelId: 'tg',
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      })

      await manager.cancelSession('sess-cancel')

      // No active turn context — agent.cancel is not called when cancelling an idle session
      expect(session.agentInstance.cancel).not.toHaveBeenCalled()
      expect(session.status).toBe('cancelled')
    })

    it('updates store record status to cancelled', async () => {
      const session = createSession({ id: 'sess-cancel-2' })
      session.activate()
      manager.registerSession(session)
      await store.save({
        sessionId: 'sess-cancel-2',
        agentSessionId: 'a2',
        agentName: 'claude',
        workingDir: '/ws',
        channelId: 'tg',
        status: 'active',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      })

      await manager.cancelSession('sess-cancel-2')

      expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: 'sess-cancel-2',
        status: 'cancelled',
      }), { immediate: true })
    })

    it('returns a typed failure for an unknown session', async () => {
      await expect(manager.cancelSession('nonexistent')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      })
    })

    it('does not destroy on a failed terminal flush and retries from durable active state', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-cancel-flush-'))
      const filePath = path.join(tmpDir, 'sessions.json')
      const realStore = new JsonFileSessionStore(filePath, 30)
      const realManager = new SessionManager(realStore)
      const session = createSession({ id: 'flush-retry' })
      realManager.registerSession(session)
      await realStore.save({
        sessionId: session.id, agentSessionId: 'agent-flush', agentName: 'claude',
        workingDir: '/ws', channelId: 'telegram', status: 'active',
        createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        clientOverrides: {}, platform: {},
      })
      realStore.flush()

      const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('ENOSPC terminal flush')
      })
      await expect(realManager.cancelSession(session.id)).rejects.toThrow('ENOSPC terminal flush')
      write.mockRestore()
      expect(realStore.get(session.id)?.status).toBe('active')
      expect(session.agentInstance.destroy).not.toHaveBeenCalled()
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('active')

      const result = await realManager.cancelSession(session.id)
      expect(result).toMatchObject({ status: 'cancelled', cleanupPending: false })
      expect(session.agentInstance.destroy).toHaveBeenCalledOnce()
      expect(realStore.get(session.id)?.status).toBe('cancelled')
      realStore.destroy()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it.each(['finished', 'cancelled'] as const)(
      'flushes an accepted debounced %s state before agent teardown',
      async (terminalStatus) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `openacp-${terminalStatus}-flush-`))
        const filePath = path.join(tmpDir, 'sessions.json')
        const realStore = new JsonFileSessionStore(filePath, 30)
        const realManager = new SessionManager(realStore)
        const session = createSession({ id: `pending-${terminalStatus}` })
        session.activate()
        realManager.registerSession(session)
        const record: SessionRecord = {
          sessionId: session.id, agentSessionId: 'agent-pending', agentName: 'claude',
          workingDir: '/ws', channelId: 'telegram', status: 'active',
          createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
          clientOverrides: {}, platform: {},
        }
        await realStore.save(record)
        realStore.flush()

        if (terminalStatus === 'finished') session.finish('done')
        else session.markCancelled()
        await realStore.save({ ...record, status: terminalStatus })
        let statusObservedDuringDestroy: string | undefined
        vi.mocked(session.agentInstance.destroy).mockImplementation(async () => {
          statusObservedDuringDestroy = JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status
        })

        const result = await realManager.cancelSession(session.id)
        expect(result).toMatchObject({ status: terminalStatus, alreadyTerminal: true })
        expect(statusObservedDuringDestroy).toBe(terminalStatus)
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe(terminalStatus)

        realStore.destroy()
        const reloaded = new JsonFileSessionStore(filePath, 30)
        expect(reloaded.get(session.id)?.status).toBe(terminalStatus)
        reloaded.destroy()
        fs.rmSync(tmpDir, { recursive: true, force: true })
      },
    )

    it('keeps a debounced terminal winner retryable when its forced flush hits ENOSPC', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-pending-terminal-retry-'))
      const filePath = path.join(tmpDir, 'sessions.json')
      const realStore = new JsonFileSessionStore(filePath, 30)
      const realManager = new SessionManager(realStore)
      const session = createSession({ id: 'pending-terminal-retry' })
      session.activate()
      realManager.registerSession(session)
      const record: SessionRecord = {
        sessionId: session.id, agentSessionId: 'agent-pending', agentName: 'claude',
        workingDir: '/ws', channelId: 'telegram', status: 'active',
        createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        clientOverrides: {}, platform: {},
      }
      await realStore.save(record)
      realStore.flush()
      session.finish('done')
      await realStore.save({ ...record, status: 'finished' })

      const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('ENOSPC pending terminal')
      })
      await expect(realManager.cancelSession(session.id)).rejects.toThrow('ENOSPC pending terminal')
      write.mockRestore()
      expect(realStore.get(session.id)?.status).toBe('finished')
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('active')
      expect(session.agentInstance.destroy).not.toHaveBeenCalled()

      const retry = await realManager.cancelSession(session.id)
      expect(retry).toMatchObject({ status: 'finished', alreadyTerminal: true })
      expect(session.agentInstance.destroy).toHaveBeenCalledOnce()
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('finished')
      realStore.destroy()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('cancels a freshly-created initializing session', async () => {
      const session = createSession({ id: 'sess-initializing' })
      manager.registerSession(session)
      await store.save({
        sessionId: session.id,
        agentSessionId: 'a-init',
        agentName: 'claude',
        workingDir: '/ws',
        channelId: 'api',
        status: 'initializing',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      })

      const result = await manager.cancelSession(session.id)

      expect(result).toEqual({
        sessionId: session.id,
        cancelled: true,
        previousStatus: 'initializing',
        status: 'cancelled',
        alreadyTerminal: false,
        cleanupPending: false,
      })
      expect(session.status).toBe('cancelled')
      expect(session.agentInstance.destroy).toHaveBeenCalledOnce()
    })

    it('shares one cancellation operation across concurrent callers', async () => {
      const session = createSession({ id: 'sess-race' })
      session.activate()
      let releaseDestroy!: () => void
      session.agentInstance.destroy = vi.fn(() => new Promise<void>((resolve) => { releaseDestroy = resolve }))
      manager.registerSession(session)
      await store.save({
        sessionId: session.id, agentSessionId: 'a-race', agentName: 'claude',
        workingDir: '/ws', channelId: 'api', status: 'active',
        createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
        clientOverrides: {}, platform: {},
      })

      const first = manager.cancelSession(session.id)
      await vi.waitFor(() => expect(session.agentInstance.destroy).toHaveBeenCalledOnce())
      const second = manager.cancelSession(session.id)
      releaseDestroy()

      const [a, b] = await Promise.all([first, second])
      expect(a).toEqual(b)
      expect(a).toMatchObject({ cancelled: true, previousStatus: 'active', status: 'cancelled' })
      expect(session.agentInstance.destroy).toHaveBeenCalledOnce()
    })

    it('removes cancelled session from in-memory map', async () => {
      const session = createSession({ id: 'sess-cancel-mem' })
      session.activate()
      manager.registerSession(session)

      expect(manager.listSessions()).toHaveLength(1)
      await manager.cancelSession('sess-cancel-mem')
      expect(manager.listSessions()).toHaveLength(0)
      expect(manager.getSession('sess-cancel-mem')).toBeUndefined()
    })

    it('bounds store-less cancellation idempotency by TTL and returns 404 after expiry', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
      try {
        const noStoreManager = new SessionManager(null)
        const session = createSession({ id: 'ephemeral-terminal' })
        session.activate()
        noStoreManager.registerSession(session)

        const first = await noStoreManager.cancelSession(session.id)
        const immediateRetry = await noStoreManager.cancelSession(session.id)
        expect(first).toMatchObject({ cancelled: true, status: 'cancelled' })
        expect(immediateRetry).toMatchObject({
          cancelled: false,
          alreadyTerminal: true,
          status: 'cancelled',
        })

        await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1)
        await expect(noStoreManager.cancelSession(session.id)).rejects.toMatchObject({
          code: 'SESSION_NOT_FOUND',
        })
      } finally {
        vi.useRealTimers()
      }
    })

    it('caps high-cardinality store-less tombstones and evicts the oldest truthfully', async () => {
      const noStoreManager = new SessionManager(null)
      const internal = noStoreManager as any
      for (let index = 0; index < 1_100; index++) {
        internal.rememberTerminalCancellationStatus(`terminal-${index}`, 'cancelled')
      }

      expect(internal.terminalCancellationStatuses.size).toBe(1_024)
      await expect(noStoreManager.cancelSession('terminal-0')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      })
      await expect(noStoreManager.cancelSession('terminal-1099')).resolves.toMatchObject({
        alreadyTerminal: true,
        status: 'cancelled',
      })
    })

    it('uses store-backed terminal truth and returns 404 after record TTL cleanup', async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-terminal-ttl-'))
      const filePath = path.join(tmpDir, 'sessions.json')
      const realStore = new JsonFileSessionStore(filePath, 1)
      const realManager = new SessionManager(realStore)
      const session = createSession({ id: 'durable-expiring-terminal' })
      session.activate()
      realManager.registerSession(session)
      await realStore.save({
        sessionId: session.id,
        agentSessionId: 'agent-expiring',
        agentName: 'claude',
        workingDir: '/ws',
        channelId: 'api',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActiveAt: '2026-01-01T00:00:00.000Z',
        clientOverrides: {},
        platform: {},
      })

      await realManager.cancelSession(session.id)
      expect(realStore.get(session.id)?.status).toBe('cancelled')
      ;(realStore as any).cleanup()
      expect(realStore.get(session.id)).toBeUndefined()
      await expect(realManager.cancelSession(session.id)).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      })

      realStore.destroy()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it('completes cleanup even if abortPrompt throws', async () => {
      const session = createSession({ id: 'sess-dead-agent' })
      session.activate()
      session.agentInstance.cancel = vi.fn().mockRejectedValue(new Error('agent dead'))
      manager.registerSession(session)

      await manager.cancelSession('sess-dead-agent')

      expect(session.status).toBe('cancelled')
      expect(manager.getSession('sess-dead-agent')).toBeUndefined()
    })

    it('does not re-save if already cancelled', async () => {
      await store.save({
        sessionId: 'already-cancelled',
        agentSessionId: 'a3',
        agentName: 'claude',
        workingDir: '/ws',
        channelId: 'tg',
        status: 'cancelled',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      })
      const callCount = (store.save as any).mock.calls.length

      const result = await manager.cancelSession('already-cancelled')

      // save was not called again since already cancelled
      expect((store.save as any).mock.calls.length).toBe(callCount)
      expect(result).toMatchObject({ cancelled: false, alreadyTerminal: true, status: 'cancelled' })
    })

    it('persists cancellation before failed destroy and retries cleanup idempotently', async () => {
      const session = createSession({ id: 'durable-cancel' })
      session.activate()
      session.agentInstance.destroy = vi.fn()
        .mockRejectedValueOnce(new Error('cleanup via http://user:secret@proxy.test failed'))
        .mockResolvedValueOnce(undefined)
      manager.registerSession(session)
      await store.save({
        sessionId: session.id, agentSessionId: 'durable-agent', agentName: 'claude',
        workingDir: '/ws', channelId: 'api', status: 'active', createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(), clientOverrides: {}, platform: {},
      })
      await store.save({
        sessionId: 'unrelated', agentSessionId: 'other-agent', agentName: 'claude',
        workingDir: '/other', channelId: 'api', status: 'active', createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(), clientOverrides: {}, platform: {},
      })

      const first = await manager.cancelSession(session.id)
      expect(first).toMatchObject({ cancelled: true, status: 'cancelled', cleanupPending: true })
      expect(store.get(session.id)?.status).toBe('cancelled')
      expect(store.save).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, status: 'cancelled' }),
        { immediate: true },
      )
      expect(manager.getSession(session.id)).toBe(session)
      expect(store.get('unrelated')?.status).toBe('active')

      const restarted = new SessionManager(store)
      const factory = new SessionFactory({} as any, restarted, (() => ({})) as any, new TypedEmitter() as any)
      factory.sessionStore = store
      factory.createFullSession = vi.fn()
      await expect(factory.getOrResumeById(session.id)).resolves.toBeNull()
      expect(factory.createFullSession).not.toHaveBeenCalled()

      const second = await manager.cancelSession(session.id)
      expect(second).toMatchObject({ cancelled: false, alreadyTerminal: true, status: 'cancelled', cleanupPending: false })
      expect(session.agentInstance.destroy).toHaveBeenCalledTimes(2)
      expect(manager.getSession(session.id)).toBeUndefined()
      expect(store.get('unrelated')?.status).toBe('active')
    })

    it('bounds cancellation while sharing never-settling ACP teardown across callers and retries', async () => {
      vi.useFakeTimers()
      try {
        let finishDestroy!: () => void
        const session = createSession({ id: 'bounded-cancel' })
        session.name = 'skip-autoname'
        session.agentInstance.prompt = vi.fn(() => new Promise<void>(() => {}))
        session.agentInstance.cancel = vi.fn(() => new Promise<void>(() => {}))
        session.agentInstance.destroy = vi.fn(() => new Promise<void>((resolve) => { finishDestroy = resolve }))
        manager.registerSession(session)
        await store.save({
          sessionId: session.id, agentSessionId: 'bounded-agent', agentName: 'claude',
          workingDir: '/ws', channelId: 'api', status: 'active', createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(), clientOverrides: {}, platform: {},
        })

        const prompt = session.enqueuePrompt('never settles')
        await vi.waitFor(() => expect(session.agentInstance.prompt).toHaveBeenCalledOnce())
        const first = manager.cancelSession(session.id)
        const concurrent = manager.cancelSession(session.id)

        await vi.advanceTimersByTimeAsync(5_000)
        expect(session.agentInstance.cancel).toHaveBeenCalledOnce()
        expect(session.agentInstance.destroy).toHaveBeenCalledOnce()

        await vi.advanceTimersByTimeAsync(4_000)
        const [firstResult, concurrentResult] = await Promise.all([first, concurrent])
        expect(firstResult).toEqual(concurrentResult)
        expect(firstResult).toMatchObject({
          cancelled: true,
          status: 'cancelled',
          cleanupPending: true,
        })
        expect(manager.getSession(session.id)).toBe(session)

        // A retry observes the same Session.destroy promise. It must not issue a
        // second cancel or process destroy while the first teardown is unresolved.
        const retry = manager.cancelSession(session.id)
        finishDestroy()
        await vi.advanceTimersByTimeAsync(1_000)
        const retryResult = await retry
        expect(retryResult).toMatchObject({
          cancelled: false,
          alreadyTerminal: true,
          cleanupPending: false,
        })
        expect(session.agentInstance.cancel).toHaveBeenCalledOnce()
        expect(session.agentInstance.destroy).toHaveBeenCalledOnce()
        expect(manager.getSession(session.id)).toBeUndefined()

        // Once forced process teardown completes, terminal queue callers settle;
        // the late ACP promise remains observed and cannot drain or reopen.
        await prompt
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('listSessions()', () => {
    it('returns all sessions when no filter', () => {
      const s1 = createSession({ channelId: 'telegram' })
      const s2 = createSession({ channelId: 'discord' })
      manager.registerSession(s1)
      manager.registerSession(s2)

      expect(manager.listSessions()).toHaveLength(2)
    })

    it('filters by channelId', () => {
      const s1 = createSession({ channelId: 'telegram' })
      const s2 = createSession({ channelId: 'discord' })
      manager.registerSession(s1)
      manager.registerSession(s2)

      const result = manager.listSessions('telegram')
      expect(result).toHaveLength(1)
      expect(result[0].channelId).toBe('telegram')
    })

    it('returns empty array when no sessions', () => {
      expect(manager.listSessions()).toEqual([])
    })
  })

  describe('listRecords()', () => {
    it('returns all records from store', async () => {
      await store.save({
        sessionId: 'r1', agentSessionId: 'a1', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'active',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })
      await store.save({
        sessionId: 'r2', agentSessionId: 'a2', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'finished',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })

      expect(manager.listRecords()).toHaveLength(2)
    })

    it('filters by statuses', async () => {
      await store.save({
        sessionId: 'r1', agentSessionId: 'a1', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'active',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })
      await store.save({
        sessionId: 'r2', agentSessionId: 'a2', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'finished',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })

      const result = manager.listRecords({ statuses: ['active'] })
      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('active')
    })

    it('returns empty when no store', () => {
      const noStoreManager = new SessionManager(null)
      expect(noStoreManager.listRecords()).toEqual([])
    })
  })

  describe('removeRecord()', () => {
    it('removes record from store', async () => {
      await store.save({
        sessionId: 'to-remove', agentSessionId: 'a1', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'finished',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })

      await manager.removeRecord('to-remove')
      expect(store.remove).toHaveBeenCalledWith('to-remove')
    })

    it('does nothing when no store', async () => {
      const noStoreManager = new SessionManager(null)
      await noStoreManager.removeRecord('any') // should not throw
    })
  })

  describe('destroyAll()', () => {
    it('marks all sessions as finished and destroys them', async () => {
      const s1 = createSession({ id: 'ds-1' })
      const s2 = createSession({ id: 'ds-2' })
      manager.registerSession(s1)
      manager.registerSession(s2)

      // Save records
      await store.save({
        sessionId: 'ds-1', agentSessionId: 'a1', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'active',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })
      await store.save({
        sessionId: 'ds-2', agentSessionId: 'a2', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'active',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })

      await manager.destroyAll()

      expect(s1.agentInstance.destroy).toHaveBeenCalled()
      expect(s2.agentInstance.destroy).toHaveBeenCalled()
      expect(manager.listSessions()).toHaveLength(0)
    })

    it('works with no sessions registered', async () => {
      await manager.destroyAll() // should not throw
    })
  })

  describe('getSessionRecord()', () => {
    it('delegates to store.get', async () => {
      await store.save({
        sessionId: 'rec-1', agentSessionId: 'a1', agentName: 'claude',
        workingDir: '/ws', channelId: 'tg', status: 'active',
        createdAt: '', lastActiveAt: '', clientOverrides: {}, platform: {},
      })

      const record = manager.getSessionRecord('rec-1')
      expect(record?.sessionId).toBe('rec-1')
    })

    it('returns undefined when no store', () => {
      const noStoreManager = new SessionManager(null)
      expect(noStoreManager.getSessionRecord('any')).toBeUndefined()
    })
  })

  describe('assistant session filtering', () => {
    it('listSessions excludes assistant sessions', () => {
      const manager = new SessionManager(null);
      const regularSession = new Session({
        channelId: 'telegram',
        agentName: 'claude-code',
        workingDirectory: '/tmp',
        agentInstance: mockAgentInstance(),
      });
      const assistantSession = new Session({
        channelId: 'telegram',
        agentName: 'claude-code',
        workingDirectory: '/tmp',
        agentInstance: mockAgentInstance(),
        isAssistant: true,
      });
      manager.registerSession(regularSession);
      manager.registerSession(assistantSession);

      const result = manager.listSessions();
      expect(result).toContain(regularSession);
      expect(result).not.toContain(assistantSession);
    });

    it('listAllSessions excludes assistant records', async () => {
      const tmpPath = path.join(os.tmpdir(), `test-store-${Date.now()}.json`);
      const store = new JsonFileSessionStore(tmpPath, 30);
      const manager = new SessionManager(store);

      await store.save({
        sessionId: 'regular-1',
        agentSessionId: 'a1',
        agentName: 'claude-code',
        workingDir: '/tmp',
        channelId: 'telegram',
        status: 'finished',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        platform: {},
      });
      await store.save({
        sessionId: 'assistant-1',
        agentSessionId: 'a2',
        agentName: 'claude-code',
        workingDir: '/tmp',
        channelId: 'telegram',
        status: 'finished',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        isAssistant: true,
        platform: {},
      });

      const summaries = manager.listAllSessions();
      expect(summaries.some(s => s.id === 'regular-1')).toBe(true);
      expect(summaries.some(s => s.id === 'assistant-1')).toBe(false);
      store.flush();
      store.destroy();
      fs.unlinkSync(tmpPath);
    });

    it('listRecords excludes assistant records', async () => {
      const tmpPath = path.join(os.tmpdir(), `test-store-${Date.now()}.json`);
      const store = new JsonFileSessionStore(tmpPath, 30);
      const manager = new SessionManager(store);

      await store.save({
        sessionId: 'regular-1',
        agentSessionId: 'a1',
        agentName: 'claude-code',
        workingDir: '/tmp',
        channelId: 'telegram',
        status: 'finished',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        platform: {},
      });
      await store.save({
        sessionId: 'assistant-1',
        agentSessionId: 'a2',
        agentName: 'claude-code',
        workingDir: '/tmp',
        channelId: 'telegram',
        status: 'finished',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        isAssistant: true,
        platform: {},
      });

      const records = manager.listRecords();
      expect(records.some(r => r.sessionId === 'regular-1')).toBe(true);
      expect(records.some(r => r.sessionId === 'assistant-1')).toBe(false);
      store.flush();
      store.destroy();
      fs.unlinkSync(tmpPath);
    });
  });

  describe('listAllSessions', () => {
  it('returns live session with isLive=true and runtime fields', () => {
    const manager = new SessionManager(null)
    const session = createSession({ id: 'sess-1', channelId: 'telegram' })
    session.activate()
    manager.registerSession(session)

    const summaries = manager.listAllSessions()

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'sess-1',
      agent: 'claude',
      status: 'active',
      channelId: 'telegram',
      workspace: '/workspace',
      isLive: true,
      promptRunning: false,
      queueDepth: 0,
    })
  })

  it('returns historical session (store only) with isLive=false and zero runtime fields', async () => {
    const store = mockStore()
    const manager = new SessionManager(store)

    await store.save({
      sessionId: 'old-sess',
      agentSessionId: 'agent-old',
      agentName: 'gemini',
      workingDir: '/old',
      channelId: 'telegram',
      status: 'cancelled',
      createdAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-02T00:00:00Z',
      name: 'Old Session',
      platform: {},
    })

    const summaries = manager.listAllSessions()

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'old-sess',
      agent: 'gemini',
      status: 'cancelled',
      name: 'Old Session',
      workspace: '/old',
      lastActiveAt: '2026-01-02T00:00:00Z',
      dangerousMode: false,
      queueDepth: 0,
      promptRunning: false,
      capabilities: null,
      isLive: false,
    })
    expect(summaries[0].configOptions).toBeUndefined()
  })

  it('overlays live data onto store record when session is in memory', async () => {
    const store = mockStore()
    const manager = new SessionManager(store)
    const session = createSession({ id: 'live-sess', channelId: 'telegram' })
    session.activate()
    manager.registerSession(session)

    await store.save({
      sessionId: 'live-sess',
      agentSessionId: 'agent-live',
      agentName: 'claude',
      workingDir: '/workspace',
      channelId: 'telegram',
      status: 'active',
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: '2026-04-03T10:00:00Z',
      platform: {},
    })

    const summaries = manager.listAllSessions()

    expect(summaries).toHaveLength(1)
    expect(summaries[0].isLive).toBe(true)
    expect(summaries[0].id).toBe('live-sess')
    // lastActiveAt comes from store record
    expect(summaries[0].lastActiveAt).toBe('2026-04-03T10:00:00Z')
  })

  it('reports a durable terminal winner as non-live while stale cleanup remains in memory', async () => {
    const store = mockStore()
    const manager = new SessionManager(store)
    const session = createSession({ id: 'terminal-winner', channelId: 'telegram' })
    session.activate()
    manager.registerSession(session)
    await store.save({
      sessionId: session.id,
      agentSessionId: 'agent-terminal',
      agentName: 'claude',
      workingDir: '/workspace',
      channelId: 'telegram',
      status: 'finished',
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: '2026-07-18T00:00:00Z',
      platform: {},
    })

    expect(manager.listAllSessions()).toEqual([
      expect.objectContaining({
        id: session.id,
        status: 'finished',
        isLive: false,
        queueDepth: 0,
        promptRunning: false,
      }),
    ])
  })

  it('returns both live and historical when mixed', async () => {
    const store = mockStore()
    const manager = new SessionManager(store)

    // Live session registered in memory AND store
    const live = createSession({ id: 'live-sess', channelId: 'telegram' })
    live.activate()
    manager.registerSession(live)
    await store.save({
      sessionId: 'live-sess',
      agentSessionId: 'agent-live',
      agentName: 'claude',
      workingDir: '/workspace',
      channelId: 'telegram',
      status: 'active',
      createdAt: live.createdAt.toISOString(),
      lastActiveAt: '2026-04-03T10:00:00Z',
      platform: {},
    })

    // Historical session only in store
    await store.save({
      sessionId: 'old-sess',
      agentSessionId: 'agent-old',
      agentName: 'gemini',
      workingDir: '/old',
      channelId: 'telegram',
      status: 'cancelled',
      createdAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-02T00:00:00Z',
      platform: {},
    })

    const summaries = manager.listAllSessions()

    expect(summaries).toHaveLength(2)
    const liveResult = summaries.find(s => s.id === 'live-sess')!
    const histResult = summaries.find(s => s.id === 'old-sess')!
    expect(liveResult.isLive).toBe(true)
    expect(histResult.isLive).toBe(false)
    // No duplicates
    expect(summaries.filter(s => s.id === 'live-sess')).toHaveLength(1)
  })

  it('includes a live session that does not yet have a store record', () => {
    const store = mockStore()
    const manager = new SessionManager(store)
    const live = createSession({ id: 'live-without-record', channelId: 'api' })
    live.activate()
    manager.registerSession(live)

    const summaries = manager.listAllSessions()

    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      id: 'live-without-record',
      status: 'active',
      isLive: true,
      lastActiveAt: null,
    })
  })

  it('falls back to live-only when no store', () => {
    const manager = new SessionManager(null)
    const session = createSession({ id: 'sess-1', channelId: 'telegram' })
    session.activate()
    manager.registerSession(session)

    const summaries = manager.listAllSessions()

    expect(summaries).toHaveLength(1)
    expect(summaries[0].isLive).toBe(true)
    expect(summaries[0].id).toBe('sess-1')
  })

  it('filters by channelId', async () => {
    const store = mockStore()
    const manager = new SessionManager(store)

    await store.save({
      sessionId: 'tg-sess',
      agentSessionId: 'a1',
      agentName: 'claude',
      workingDir: '/w',
      channelId: 'telegram',
      status: 'cancelled',
      createdAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-01T00:00:00Z',
      platform: {},
    })
    await store.save({
      sessionId: 'api-sess',
      agentSessionId: 'a2',
      agentName: 'claude',
      workingDir: '/w',
      channelId: 'api',
      status: 'finished',
      createdAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-01T00:00:00Z',
      platform: {},
    })

    const summaries = manager.listAllSessions('telegram')

    expect(summaries).toHaveLength(1)
    expect(summaries[0].id).toBe('tg-sess')
  })

  it('historical session with acpState returns configOptions and capabilities', async () => {
    const store = mockStore()
    const manager = new SessionManager(store)
    const configOptions = [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select' as const, currentValue: 'auto', options: [] }]

    await store.save({
      sessionId: 'sess-acp',
      agentSessionId: 'agent-acp',
      agentName: 'claude',
      workingDir: '/w',
      channelId: 'api',
      status: 'finished',
      createdAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-01T00:00:00Z',
      platform: {},
      acpState: { configOptions },
    })

    const summaries = manager.listAllSessions()

    expect(summaries[0].configOptions).toEqual(configOptions)
  })
  })
})
