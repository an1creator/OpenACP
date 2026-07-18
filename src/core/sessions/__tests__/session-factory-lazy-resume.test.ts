import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Session } from '../session.js'
import { SessionFactory } from '../session-factory.js'
import { SessionManager } from '../session-manager.js'
import { JsonFileSessionStore } from '../session-store.js'
import type { AgentInstance } from '../../agents/agent-instance.js'
import type { ConfigOption, SessionRecord } from '../../types.js'
import { MiddlewareChain } from '../../plugin/middleware-chain.js'

function mockAgentInstance(): AgentInstance {
  return {
    sessionId: 'agent-sess-1',
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn().mockResolvedValue({ configOptions: [], legacyAcknowledged: true }),
    onPermissionRequest: vi.fn(),
    initialSessionResponse: undefined,
    agentCapabilities: undefined,
    addAllowedPath: vi.fn(),
    middlewareChain: undefined,
  } as unknown as AgentInstance
}

const MODE_OPTIONS: ConfigOption['options'] = [
  { value: 'normal', name: 'Normal' },
  { value: 'bypassPermissions', name: 'Bypass Permissions' },
]

/**
 * Builds a Session whose configOptions are pre-populated to simulate what happens
 * after the agent spawns and reports its defaults via applySpawnResponse.
 */
function buildResumedSession(agentInst: AgentInstance, agentDefaultMode: string): Session {
  const session = new Session({
    id: 'sess-resume',
    channelId: 'telegram',
    agentName: 'claude',
    workingDirectory: '/tmp',
    agentInstance: agentInst,
  })
  session.setInitialConfigOptions([
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: agentDefaultMode,
      options: MODE_OPTIONS,
    },
  ])
  return session
}

describe('SessionFactory lazy resume — configOptions re-application', () => {
  let tmpDir: string
  let store: JsonFileSessionStore
  let sessionManager: SessionManager
  let factory: SessionFactory

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-sf-resume-'))
    store = new JsonFileSessionStore(path.join(tmpDir, 'sessions.json'), 30)
    sessionManager = new SessionManager(store)

    factory = new SessionFactory(
      null as any,
      sessionManager,
      null as any,
      null as any,
    )
    factory.sessionStore = store
  })

  afterEach(() => {
    store.destroy()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('calls setConfigOption for each persisted configOption that differs from agent defaults on getOrResume', async () => {
    const persistedRecord: SessionRecord = {
      sessionId: 'sess-resume',
      agentSessionId: 'agent-uuid',
      agentName: 'claude',
      workingDir: '/tmp',
      channelId: 'telegram',
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      platform: { topicId: 777 },
      acpState: {
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'bypassPermissions',
            options: MODE_OPTIONS,
          },
        ],
      },
    }
    await store.save(persistedRecord)

    // Agent spawns fresh and reports default mode = 'normal'
    const agentInst = mockAgentInstance()
    const resumedSession = buildResumedSession(agentInst, 'normal')
    factory.createFullSession = vi.fn().mockImplementation(async () => {
      sessionManager.registerSession(resumedSession)
      await resumedSession.setConfigOption('mode', { type: 'select', value: 'bypassPermissions' })
      return resumedSession
    })

    const result = await factory.getOrResume('telegram', '777')

    expect(result).toBe(resumedSession)
    expect(agentInst.setConfigOption).toHaveBeenCalledWith('mode', { type: 'select', value: 'bypassPermissions' })
  })

  it('does NOT call setConfigOption when persisted value matches agent-reported value', async () => {
    const persistedRecord: SessionRecord = {
      sessionId: 'sess-resume-2',
      agentSessionId: 'agent-uuid-2',
      agentName: 'claude',
      workingDir: '/tmp',
      channelId: 'telegram',
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      platform: { topicId: 888 },
      acpState: {
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'normal',
            options: MODE_OPTIONS,
          },
        ],
      },
    }
    await store.save(persistedRecord)

    // Agent resumes with the same value — no re-apply needed
    const agentInst = mockAgentInstance()
    const resumedSession = buildResumedSession(agentInst, 'normal')
    resumedSession.id = 'sess-resume-2'
    factory.createFullSession = vi.fn().mockImplementation(async () => {
      sessionManager.registerSession(resumedSession)
      return resumedSession
    })

    const result = await factory.getOrResume('telegram', '888')

    expect(result).toBe(resumedSession)
    expect(agentInst.setConfigOption).not.toHaveBeenCalled()
  })

  it('calls setConfigOption for each persisted configOption that differs from agent defaults on getOrResumeById', async () => {
    const persistedRecord: SessionRecord = {
      sessionId: 'sess-resume-byid',
      agentSessionId: 'agent-uuid-byid',
      agentName: 'claude',
      workingDir: '/tmp',
      channelId: 'telegram',
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      platform: { topicId: 999 },
      acpState: {
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'bypassPermissions',
            options: MODE_OPTIONS,
          },
        ],
      },
    }
    await store.save(persistedRecord)

    const agentInst = mockAgentInstance()
    const resumedSession = buildResumedSession(agentInst, 'normal')
    resumedSession.id = 'sess-resume-byid'
    factory.createFullSession = vi.fn().mockImplementation(async () => {
      sessionManager.registerSession(resumedSession)
      await resumedSession.setConfigOption('mode', { type: 'select', value: 'bypassPermissions' })
      return resumedSession
    })

    const result = await factory.getOrResumeById('sess-resume-byid')

    expect(result).toBe(resumedSession)
    expect(agentInst.setConfigOption).toHaveBeenCalledWith('mode', { type: 'select', value: 'bypassPermissions' })
  })

  it('returns null when cancellation wins while best-effort config hydration later rejects', async () => {
    const persistedRecord: SessionRecord = {
      sessionId: 'sess-resume-cancel-hydration',
      agentSessionId: 'agent-uuid-cancel-hydration',
      agentName: 'claude',
      workingDir: '/tmp',
      channelId: 'telegram',
      status: 'active',
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      platform: { topicId: 1000 },
      acpState: {
        configOptions: [
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'bypassPermissions',
            options: MODE_OPTIONS,
          },
        ],
      },
    }
    await store.save(persistedRecord)

    let rejectConfig!: (error: Error) => void
    const delayedConfig = new Promise<never>((_, reject) => { rejectConfig = reject })
    const agentInst = mockAgentInstance()
    agentInst.setConfigOption = vi.fn().mockReturnValue(delayedConfig)
    const resumedSession = buildResumedSession(agentInst, 'normal')
    resumedSession.id = persistedRecord.sessionId
    factory.createFullSession = vi.fn().mockImplementation(async () => {
      sessionManager.registerSession(resumedSession)
      await resumedSession.setConfigOption('mode', { type: 'select', value: 'bypassPermissions' })
      return resumedSession
    })

    const resume = factory.getOrResumeById(persistedRecord.sessionId)
    await vi.waitFor(() => expect(agentInst.setConfigOption).toHaveBeenCalledOnce())
    await sessionManager.cancelSession(persistedRecord.sessionId)
    rejectConfig(new Error('late config hydration failure'))

    await expect(resume).resolves.toBeNull()
    expect(sessionManager.getSession(persistedRecord.sessionId)).toBeUndefined()
    expect(agentInst.destroy).toHaveBeenCalledOnce()
  })

  it('keeps the live value when the agent rejects a persisted preference', async () => {
    const persistedMode: ConfigOption = {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select',
      currentValue: 'bypassPermissions', options: MODE_OPTIONS,
    }
    const record: SessionRecord = {
      sessionId: 'truthful-config', agentSessionId: 'old-agent', agentName: 'claude',
      workingDir: '/tmp', channelId: 'telegram', status: 'active',
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      platform: { topicId: 1200 }, acpState: { configOptions: [persistedMode] },
    }
    await store.save(record)
    const agent = mockAgentInstance()
    agent.initialSessionResponse = { configOptions: [{ ...persistedMode, currentValue: 'normal' }] }
    agent.setConfigOption = vi.fn().mockRejectedValue(new Error('rejected'))
    const localFactory = new SessionFactory(
      { resume: vi.fn().mockResolvedValue(agent) } as any,
      sessionManager,
      null as any,
      { emit: vi.fn() } as any,
    )
    localFactory.sessionStore = store

    const session = await localFactory.create({
      channelId: record.channelId,
      agentName: record.agentName,
      workingDirectory: record.workingDir,
      resumeAgentSessionId: record.agentSessionId,
      existingSessionId: record.sessionId,
    })

    expect(agent.setConfigOption).toHaveBeenCalledOnce()
    expect(session.getConfigValue('mode')).toBe('normal')
    expect(session.toAcpStateSnapshot().configOptions?.[0]).toMatchObject({ currentValue: 'normal' })
    await sessionManager.discardSession(session)
  })

  it('uses the fail-closed config path during restore without starting a duplicate agent RPC', async () => {
    const persistedMode: ConfigOption = {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select',
      currentValue: 'bypassPermissions', options: MODE_OPTIONS,
    }
    const record: SessionRecord = {
      sessionId: 'policy-blocked-restore', agentSessionId: 'old-agent', agentName: 'claude',
      workingDir: '/tmp', channelId: 'telegram', status: 'active',
      createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(),
      platform: { topicId: 1201 }, acpState: { configOptions: [persistedMode] },
    }
    await store.save(record)
    const agent = mockAgentInstance()
    agent.initialSessionResponse = { configOptions: [{ ...persistedMode, currentValue: 'normal' }] }
    const chain = new MiddlewareChain()
    chain.add('config:beforeChange', 'restore-policy', { handler: vi.fn().mockResolvedValue(null) })
    const localFactory = new SessionFactory(
      { resume: vi.fn().mockResolvedValue(agent) } as any,
      sessionManager,
      null as any,
      { emit: vi.fn() } as any,
    )
    localFactory.sessionStore = store
    localFactory.middlewareChain = chain

    const session = await localFactory.create({
      channelId: record.channelId,
      agentName: record.agentName,
      workingDirectory: record.workingDir,
      resumeAgentSessionId: record.agentSessionId,
      existingSessionId: record.sessionId,
    })

    expect(agent.setConfigOption).not.toHaveBeenCalled()
    expect(session.getConfigValue('mode')).toBe('normal')
    expect(session.toAcpStateSnapshot().configOptions?.[0]).toMatchObject({ currentValue: 'normal' })
    await sessionManager.discardSession(session)
  })

  it('hydrates durable metadata before the initial resume commit and preserves it across another restart', async () => {
    const createdAt = '2025-01-02T03:04:05.000Z'
    const persistedMode: ConfigOption = {
      id: 'mode', name: 'Mode', category: 'mode', type: 'select',
      currentValue: 'bypassPermissions', options: MODE_OPTIONS,
    }
    const persistedRecord: SessionRecord = {
      sessionId: 'sess-metadata',
      agentSessionId: 'old-agent-id',
      agentName: 'claude',
      workingDir: '/tmp',
      channelId: 'telegram',
      status: 'active',
      createdAt,
      lastActiveAt: '2026-07-17T00:00:00.000Z',
      platform: { topicId: 1234 },
      platforms: { telegram: { topicId: 1234 } },
      attachedAdapters: ['telegram'],
      clientOverrides: { bypassPermissions: true },
      firstAgent: 'codex',
      currentPromptCount: 17,
      agentSwitchHistory: [{
        agentName: 'codex', agentSessionId: 'codex-old',
        switchedAt: '2026-07-16T00:00:00.000Z', promptCount: 11,
      }],
      acpState: { configOptions: [persistedMode] },
    }
    await store.save(persistedRecord)
    store.flush()

    const makeFactory = (manager: SessionManager, activeStore: JsonFileSessionStore, newAgentId: string) => {
      const agent = mockAgentInstance()
      agent.sessionId = newAgentId
      agent.initialSessionResponse = {
        configOptions: [{ ...persistedMode, currentValue: 'normal' }],
      }
      const localFactory = new SessionFactory(
        { resume: vi.fn().mockResolvedValue(agent) } as any,
        manager,
        null as any,
        { emit: vi.fn() } as any,
      )
      localFactory.sessionStore = activeStore
      return { localFactory, agent }
    }

    const first = makeFactory(sessionManager, store, 'fresh-agent-id')
    const resumed = await first.localFactory.create({
      channelId: persistedRecord.channelId,
      agentName: persistedRecord.agentName,
      workingDirectory: persistedRecord.workingDir,
      resumeAgentSessionId: persistedRecord.agentSessionId,
      existingSessionId: persistedRecord.sessionId,
    })
    expect(resumed.createdAt.toISOString()).toBe(createdAt)
    expect(resumed.firstAgent).toBe('codex')
    expect(resumed.promptCount).toBe(17)
    expect(resumed.clientOverrides).toEqual({ bypassPermissions: true })
    expect(resumed.getConfigValue('mode')).toBe('bypassPermissions')

    await sessionManager.patchRecord(resumed.id, {
      sessionId: resumed.id,
      agentSessionId: resumed.agentSessionId,
      agentName: resumed.agentName,
      workingDir: resumed.workingDirectory,
      channelId: resumed.channelId,
      status: resumed.status,
      createdAt: resumed.createdAt.toISOString(),
      lastActiveAt: new Date().toISOString(),
      platform: persistedRecord.platform,
      platforms: persistedRecord.platforms,
      firstAgent: resumed.firstAgent,
      currentPromptCount: resumed.promptCount,
      agentSwitchHistory: resumed.agentSwitchHistory,
      clientOverrides: resumed.clientOverrides,
      attachedAdapters: resumed.attachedAdapters,
      acpState: resumed.toAcpStateSnapshot(),
    }, { immediate: true, expectedSession: resumed })
    expect(store.get(resumed.id)).toMatchObject({
      agentSessionId: 'fresh-agent-id',
      createdAt,
      firstAgent: 'codex',
      currentPromptCount: 17,
      clientOverrides: { bypassPermissions: true },
      acpState: { configOptions: [expect.objectContaining({ currentValue: 'bypassPermissions' })] },
    })
    await sessionManager.discardSession(resumed)
    store.destroy()

    store = new JsonFileSessionStore(path.join(tmpDir, 'sessions.json'), 30)
    const restartedManager = new SessionManager(store)
    const second = makeFactory(restartedManager, store, 'second-agent-id')
    const restarted = await second.localFactory.create({
      channelId: persistedRecord.channelId,
      agentName: persistedRecord.agentName,
      workingDirectory: persistedRecord.workingDir,
      resumeAgentSessionId: 'fresh-agent-id',
      existingSessionId: persistedRecord.sessionId,
    })
    expect(restarted.createdAt.toISOString()).toBe(createdAt)
    expect(restarted.promptCount).toBe(17)
    expect(restarted.agentSwitchHistory).toEqual(persistedRecord.agentSwitchHistory)
    expect(restarted.getConfigValue('mode')).toBe('bypassPermissions')
    await restartedManager.discardSession(restarted)
  })
})
