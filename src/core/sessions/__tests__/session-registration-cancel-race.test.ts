import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenACPCore } from '../../core.js';
import { EventBus } from '../../event-bus.js';
import { SessionFactory } from '../session-factory.js';
import { Session } from '../session.js';
import { SessionBridge } from '../session-bridge.js';
import {
  SessionManager,
  SessionRegistrationSupersededError,
} from '../session-manager.js';
import { TypedEmitter } from '../../utils/typed-emitter.js';
import type { AgentEvent, SessionRecord } from '../../types.js';
import { JsonFileSessionStore } from '../session-store.js';

function activeRecord(sessionId: string, status: SessionRecord['status'] = 'active'): SessionRecord {
  return {
    sessionId,
    agentSessionId: 'stored-agent',
    agentName: 'claude',
    workingDir: '/workspace',
    channelId: 'telegram',
    status,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    clientOverrides: {},
    platform: { topicId: 777 },
  };
}

function createDelayedStore() {
  const records = new Map<string, SessionRecord>();
  let delayCancellationSave = false;
  let delayNonterminalSave = false;
  let failCancellationSaveOnce = false;
  let failNonterminalSaveOnce = false;
  let releaseCancellationSave!: () => void;
  const cancellationSaveGate = new Promise<void>((resolve) => { releaseCancellationSave = resolve; });
  let releaseNonterminalSave!: () => void;
  const nonterminalSaveGate = new Promise<void>((resolve) => { releaseNonterminalSave = resolve; });
  const store = {
    save: vi.fn(async (record: SessionRecord) => {
      if (failCancellationSaveOnce && record.status === 'cancelled') {
        failCancellationSaveOnce = false;
        throw new Error('durable cancellation failed');
      }
      if (failNonterminalSaveOnce && record.status !== 'cancelled' && record.status !== 'finished') {
        failNonterminalSaveOnce = false;
        throw new Error('initial durable save failed');
      }
      if (delayCancellationSave && record.status === 'cancelled') {
        await cancellationSaveGate;
      }
      if (delayNonterminalSave && record.status !== 'cancelled') {
        await nonterminalSaveGate;
      }
      records.set(record.sessionId, structuredClone(record));
    }),
    flush: vi.fn(),
    get: vi.fn((sessionId: string) => records.get(sessionId)),
    findByPlatform: vi.fn((channelId: string, predicate: (platform: Record<string, unknown>) => boolean) => {
      return [...records.values()].find((record) => (
        record.channelId === channelId && predicate(record.platform ?? {})
      ));
    }),
    findByAgentSessionId: vi.fn(),
    findAssistant: vi.fn(),
    list: vi.fn(() => [...records.values()]),
    remove: vi.fn(async (sessionId: string) => { records.delete(sessionId); }),
  };
  return {
    store,
    records,
    delayCancellation: () => { delayCancellationSave = true; },
    releaseCancellation: () => releaseCancellationSave(),
    delayNonterminal: () => { delayNonterminalSave = true; },
    releaseNonterminal: () => releaseNonterminalSave(),
    failNextCancellation: () => { failCancellationSaveOnce = true; },
    failNextNonterminal: () => { failNonterminalSaveOnce = true; },
  };
}

function mockAgentInstance(sessionId = 'resumed-agent') {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>();
  return Object.assign(emitter, {
    sessionId,
    prompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: vi.fn(),
    addAllowedPath: vi.fn(),
    initialSessionResponse: undefined,
    agentCapabilities: undefined,
  }) as any;
}

async function bounded<T>(operation: Promise<T>, timeoutMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not settle at lifecycle boundary')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createCoreHarness(
  manager: SessionManager,
  store: ReturnType<typeof createDelayedStore>['store'],
  agentManager: Record<string, any>,
  adapter: Record<string, any> = {},
  options: { headless?: boolean } = {},
) {
  const eventBus = new EventBus();
  const factory = new SessionFactory(agentManager as any, manager, {} as any, eventBus);
  const core = Object.create(OpenACPCore.prototype) as OpenACPCore;
  core.adapters = options.headless ? new Map() : new Map([['telegram', adapter as any]]);
  (core as any).bridges = new Map();
  core.agentManager = agentManager as any;
  core.sessionManager = manager;
  core.sessionStore = store as any;
  core.eventBus = eventBus;
  core.sessionFactory = factory;
  (core as any).lifecycleManager = {
    middlewareChain: undefined,
    serviceRegistry: {
      get: vi.fn((name: string) => name === 'notifications'
        ? { notify: vi.fn(), notifyAll: vi.fn() }
        : undefined),
    },
  };
  const connect = vi.fn();
  const createBridge = vi.spyOn(core, 'createBridge').mockReturnValue({ connect } as any);
  factory.sessionStore = store as any;
  factory.createFullSession = (params) => core.createSession(params);
  return { core, factory, eventBus, createBridge, connect };
}

describe('persisted-only resume cancellation registration lease', () => {
  it('keeps a single pending/live owner and cleans lease-less duplicate candidates', async () => {
    const { store, records } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('exclusive-owner'));

    const ownerLease = manager.beginSessionRegistration('exclusive-owner');
    expect(() => manager.beginSessionRegistration('exclusive-owner'))
      .toThrow(SessionRegistrationSupersededError);

    const duplicateAgent = mockAgentInstance('duplicate-agent');
    const duplicate = new Session({
      id: 'exclusive-owner',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: duplicateAgent,
    });
    expect(() => manager.registerSession(duplicate)).toThrow(SessionRegistrationSupersededError);
    await vi.waitFor(() => expect(duplicateAgent.destroy).toHaveBeenCalledOnce());

    const ownerAgent = mockAgentInstance('owner-agent');
    const owner = new Session({
      id: 'exclusive-owner',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: ownerAgent,
    });
    manager.registerSession(owner, ownerLease);
    expect(manager.getSession(owner.id)).toBe(owner);
    expect(() => manager.beginSessionRegistration(owner.id))
      .toThrow(SessionRegistrationSupersededError);

    await manager.cancelSession(owner.id);
    expect(ownerAgent.destroy).toHaveBeenCalledOnce();
    expect(duplicateAgent.destroy).toHaveBeenCalledOnce();
    expect(manager.isCurrentLiveSession(owner)).toBe(false);
    expect(manager.getSession(owner.id)).toBeUndefined();
    expect(records.get(owner.id)?.status).toBe('cancelled');
    expect(() => manager.beginSessionRegistration(owner.id))
      .toThrow(SessionRegistrationSupersededError);
  });

  it('allows independent registration owners for different session IDs', () => {
    const manager = new SessionManager(null);
    const first = manager.beginSessionRegistration('registration-a');
    const second = manager.beginSessionRegistration('registration-b');

    expect(first.invalidated).toBe(false);
    expect(second.invalidated).toBe(false);
    expect(first.generation).not.toBe(second.generation);
    manager.releaseSessionRegistration(first);
    manager.releaseSessionRegistration(second);
  });

  it('acquires the existing-ID owner before connector thread side effects', async () => {
    const { store } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('connector-owner'));
    let releaseThread!: (threadId: string) => void;
    const thread = new Promise<string>((resolve) => { releaseThread = resolve; });
    const adapter = { createSessionThread: vi.fn().mockReturnValue(thread) };
    const agent = mockAgentInstance('connector-agent');
    const agentManager = {
      resume: vi.fn().mockResolvedValue(agent),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { core, createBridge, connect } = createCoreHarness(manager, store, agentManager, adapter);
    const params = {
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      existingSessionId: 'connector-owner',
      resumeAgentSessionId: 'stored-agent',
      createThread: true,
    } as const;

    const owner = core.createSession(params);
    await vi.waitFor(() => expect(adapter.createSessionThread).toHaveBeenCalledOnce());
    await expect(core.createSession(params)).rejects.toMatchObject({
      code: 'SESSION_REGISTRATION_SUPERSEDED',
    });
    expect(adapter.createSessionThread).toHaveBeenCalledOnce();
    expect(agentManager.resume).not.toHaveBeenCalled();

    releaseThread('1001');
    const session = await owner;
    expect(manager.getSession(session.id)).toBe(session);
    expect(agentManager.resume).toHaveBeenCalledOnce();
    expect(createBridge).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it('singleflights thread and ID lazy-resume paths for the same stored session', async () => {
    const { store } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('cross-path-owner'));
    const agent = mockAgentInstance('cross-path-agent');
    let releaseResume!: (value: any) => void;
    const delayedResume = new Promise<any>((resolve) => { releaseResume = resolve; });
    const agentManager = {
      resume: vi.fn().mockReturnValue(delayedResume),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { factory, createBridge } = createCoreHarness(manager, store, agentManager);

    const byThread = factory.getOrResume('telegram', '777');
    await vi.waitFor(() => expect(agentManager.resume).toHaveBeenCalledOnce());
    const byId = factory.getOrResumeById('cross-path-owner');
    await expect(byId).resolves.toBeNull();
    expect(agentManager.resume).toHaveBeenCalledOnce();

    releaseResume(agent);
    const winner = await byThread;
    expect(winner?.id).toBe('cross-path-owner');
    expect(manager.getSession('cross-path-owner')).toBe(winner);
    expect(createBridge).toHaveBeenCalledOnce();
  });

  it('discards a registered agent after initial persistence failure and allows a clean retry', async () => {
    const { store, failNextNonterminal } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('durability-retry', 'finished'));
    const firstAgent = mockAgentInstance('first-durability-agent');
    const retryAgent = mockAgentInstance('retry-durability-agent');
    const agentManager = {
      resume: vi.fn()
        .mockResolvedValueOnce(firstAgent)
        .mockResolvedValueOnce(retryAgent),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { core, createBridge } = createCoreHarness(manager, store, agentManager);
    const params = {
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      existingSessionId: 'durability-retry',
      resumeAgentSessionId: 'stored-agent',
    } as const;

    failNextNonterminal();
    await expect(core.createSession(params)).rejects.toThrow('initial durable save failed');
    expect(manager.getSession('durability-retry')).toBeUndefined();
    expect(firstAgent.destroy).toHaveBeenCalledOnce();
    expect(createBridge).not.toHaveBeenCalled();

    const retry = await core.createSession(params);
    expect(manager.getSession(retry.id)).toBe(retry);
    expect(retry.agentInstance).toBe(retryAgent);
    expect(agentManager.resume).toHaveBeenCalledTimes(2);
    expect(createBridge).toHaveBeenCalledOnce();
    expect(firstAgent.destroy).toHaveBeenCalledOnce();
  });

  it('invalidates the old generation, shares concurrent cancel, and permits a later genuinely new lifecycle', async () => {
    const { store, records, delayCancellation, releaseCancellation } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('lease-race'));
    const lease = manager.beginSessionRegistration('lease-race');

    delayCancellation();
    const first = manager.cancelSession('lease-race');
    const concurrent = manager.cancelSession('lease-race');
    await bounded(lease.invalidation);

    expect(lease.invalidated).toBe(true);
    expect(() => manager.beginSessionRegistration('lease-race')).toThrow(SessionRegistrationSupersededError);
    expect(records.get('lease-race')?.status).toBe('active');

    releaseCancellation();
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult).toEqual(concurrentResult);
    expect(firstResult).toMatchObject({ status: 'cancelled', alreadyTerminal: false });
    expect(store.save.mock.calls.filter(([record]) => record.status === 'cancelled')).toHaveLength(1);
    expect(() => manager.beginSessionRegistration('lease-race')).toThrow(SessionRegistrationSupersededError);

    // The in-memory tombstone is bounded. Removing the terminal record represents
    // an intentional new lifecycle and allows a fresh, independent generation.
    await manager.removeRecord('lease-race');
    const fresh = manager.beginSessionRegistration('lease-race');
    expect(fresh.invalidated).toBe(false);
    expect(fresh.generation).not.toBe(lease.generation);
    manager.releaseSessionRegistration(fresh);
  });

  it('keeps the existing finished-session resume contract', async () => {
    const { store } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('finished-resume', 'finished'));

    const lease = manager.beginSessionRegistration('finished-resume');
    expect(lease.invalidated).toBe(false);
    manager.releaseSessionRegistration(lease);
  });

  it('reopens finished exactly once only for the current registered identity and lease', async () => {
    const { store, records } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('one-shot-finished', 'finished'));
    const lease = manager.beginSessionRegistration('one-shot-finished');
    const agent = mockAgentInstance('new-agent');
    const session = new Session({
      id: 'one-shot-finished',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: agent,
    });
    manager.registerSession(session, lease);

    await manager.patchRecord(session.id, {
      status: 'initializing',
      agentSessionId: 'new-agent',
    }, { expectedSession: session, registrationLease: lease });
    expect(records.get(session.id)).toMatchObject({
      status: 'initializing',
      agentSessionId: 'new-agent',
    });

    // Even while the lease remains pending, its finished-reopen authority has
    // already been consumed and cannot be replayed for another terminal record.
    await store.save({ ...records.get(session.id)!, status: 'finished', agentSessionId: 'terminal-again' });
    await expect(manager.patchRecord(session.id, {
      status: 'initializing',
      agentSessionId: 'replayed-agent',
    }, { expectedSession: session, registrationLease: lease }))
      .rejects.toBeInstanceOf(SessionRegistrationSupersededError);
    expect(records.get(session.id)).toMatchObject({ status: 'finished', agentSessionId: 'terminal-again' });

    manager.releaseSessionRegistration(lease);
    await expect(manager.patchRecord(session.id, {
      status: 'initializing',
      agentSessionId: 'released-agent',
    }, { expectedSession: session, registrationLease: lease }))
      .rejects.toBeInstanceOf(SessionRegistrationSupersededError);
    await manager.discardSession(session);
    expect(agent.destroy).toHaveBeenCalledOnce();
  });

  it('keeps finished and cancelled immutable to ordinary durable patches', async () => {
    const { store, records } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save({ ...activeRecord('plain-finished', 'finished'), name: 'terminal-name' });
    await store.save(activeRecord('plain-cancelled', 'cancelled'));

    await manager.patchRecord('plain-finished', { status: 'active', name: 'stale-name' });
    await manager.patchRecord('plain-cancelled', { status: 'initializing', agentSessionId: 'stale-agent' });

    expect(records.get('plain-finished')).toMatchObject({ status: 'finished', name: 'terminal-name' });
    expect(records.get('plain-cancelled')).toMatchObject({ status: 'cancelled', agentSessionId: 'stored-agent' });
    expect(() => manager.beginSessionRegistration('plain-cancelled'))
      .toThrow(SessionRegistrationSupersededError);
  });

  it('checks finished-reopen authority after queued mutations so concurrent cancel wins', async () => {
    const { store, records, delayNonterminal, releaseNonterminal } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('finished-cancel-race', 'finished'));
    const lease = manager.beginSessionRegistration('finished-cancel-race');
    const agent = mockAgentInstance('losing-reopen-agent');
    const session = new Session({
      id: 'finished-cancel-race',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: agent,
    });
    manager.registerSession(session, lease);

    delayNonterminal();
    const queuedBefore = manager.patchRecord(session.id, { name: 'queued-before-reopen' });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
    const reopen = manager.patchRecord(session.id, {
      status: 'initializing',
      agentSessionId: 'losing-reopen-agent',
    }, { expectedSession: session, registrationLease: lease });
    const cancelling = manager.cancelSession(session.id);
    expect(lease.invalidated).toBe(true);
    expect(session.isTerminating).toBe(true);

    releaseNonterminal();
    await queuedBefore;
    await expect(reopen).rejects.toBeInstanceOf(SessionRegistrationSupersededError);
    const result = await cancelling;

    expect(result).toMatchObject({ status: 'finished', alreadyTerminal: true, cancelled: false });
    expect(records.get(session.id)).toMatchObject({
      status: 'finished',
      agentSessionId: 'stored-agent',
      name: 'queued-before-reopen',
    });
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(agent.destroy).toHaveBeenCalledOnce();
  });

  it('durably reopens finished through Core and resumes the new agent ID on the next restart', async () => {
    const { store, records } = createDelayedStore();
    await store.save({ ...activeRecord('finished-e2e', 'finished'), name: 'Persisted session' });

    const firstManager = new SessionManager(store as any);
    const firstAgent = mockAgentInstance('new-agent-session');
    const firstAgentManager = {
      resume: vi.fn().mockResolvedValue(firstAgent),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const firstRelease = vi.spyOn(firstManager, 'releaseSessionRegistration');
    const { factory: firstFactory } = createCoreHarness(
      firstManager,
      store,
      firstAgentManager,
      {},
      { headless: true },
    );

    const firstSession = await firstFactory.getOrResumeById('finished-e2e');
    expect(firstSession).not.toBeNull();
    await vi.waitFor(() => expect(records.get('finished-e2e')?.status).toBe('active'));
    expect(firstAgentManager.resume).toHaveBeenCalledWith(
      'claude',
      '/workspace',
      'stored-agent',
      [],
    );
    expect(records.get('finished-e2e')).toMatchObject({
      status: 'active',
      agentSessionId: 'new-agent-session',
      agentName: 'claude',
      workingDir: '/workspace',
      channelId: 'telegram',
      name: 'Persisted session',
    });
    expect(store.save.mock.calls
      .map(([record]) => record as SessionRecord)
      .filter((record) => record.sessionId === 'finished-e2e')
      .map((record) => record.status))
      .toEqual(['finished', 'initializing', 'active']);
    expect(firstRelease).toHaveBeenCalledOnce();

    // A new manager represents the next daemon start. It must resume the ID
    // written by the successful reopen, never the original terminal ID.
    const secondManager = new SessionManager(store as any);
    const secondAgent = mockAgentInstance('next-agent-session');
    const secondAgentManager = {
      resume: vi.fn().mockResolvedValue(secondAgent),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const secondRelease = vi.spyOn(secondManager, 'releaseSessionRegistration');
    const { factory: secondFactory } = createCoreHarness(
      secondManager,
      store,
      secondAgentManager,
      {},
      { headless: true },
    );
    const secondSession = await secondFactory.getOrResumeById('finished-e2e');
    expect(secondSession).not.toBeNull();
    await vi.waitFor(() => expect(records.get('finished-e2e')?.agentSessionId).toBe('next-agent-session'));
    await vi.waitFor(() => expect(records.get('finished-e2e')?.status).toBe('active'));
    expect(secondAgentManager.resume).toHaveBeenCalledWith(
      'claude',
      '/workspace',
      'new-agent-session',
      [],
    );
    expect(secondRelease).toHaveBeenCalledOnce();

    await firstSession!.destroy();
    await secondSession!.destroy();
    expect(firstAgent.destroy).toHaveBeenCalledOnce();
    expect(secondAgent.destroy).toHaveBeenCalledOnce();
  });

  it('bounds Core creation and destroys a late agent without register, patch, or bridge resurrection', async () => {
    const { store, records, delayCancellation, releaseCancellation } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('core-resume-race'));

    const lateAgent = mockAgentInstance();
    let releaseResume!: (agent: any) => void;
    const delayedResume = new Promise<any>((resolve) => { releaseResume = resolve; });
    const agentManager = {
      resume: vi.fn().mockReturnValue(delayedResume),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const eventBus = new EventBus();
    const sessionCreated = vi.fn();
    eventBus.on('session:created', sessionCreated);
    const factory = new SessionFactory(
      agentManager as any,
      manager,
      {} as any,
      eventBus,
    );
    const core = Object.create(OpenACPCore.prototype) as OpenACPCore;
    core.adapters = new Map([['telegram', {} as any]]);
    (core as any).bridges = new Map();
    core.agentManager = agentManager as any;
    core.sessionManager = manager;
    core.sessionStore = store as any;
    core.eventBus = eventBus;
    core.sessionFactory = factory;
    const bridge = vi.spyOn(core, 'createBridge');
    const register = vi.spyOn(manager, 'registerSession');
    const patchRecord = vi.spyOn(manager, 'patchRecord');

    const creation = core.createSession({
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      existingSessionId: 'core-resume-race',
      resumeAgentSessionId: 'stored-agent',
    }).then(
      (session) => ({ status: 'resolved' as const, session }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => expect(agentManager.resume).toHaveBeenCalledOnce());

    delayCancellation();
    const cancelling = manager.cancelSession('core-resume-race');
    const result = await bounded(creation);
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toMatchObject({ code: 'SESSION_REGISTRATION_SUPERSEDED' });
    }
    expect(records.get('core-resume-race')?.status).toBe('active');
    expect(manager.getSession('core-resume-race')).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(patchRecord).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();
    expect(sessionCreated).not.toHaveBeenCalled();

    releaseResume(lateAgent);
    await vi.waitFor(() => expect(lateAgent.destroy).toHaveBeenCalledOnce());
    expect(agentManager.spawn).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(patchRecord).not.toHaveBeenCalled();
    expect(bridge).not.toHaveBeenCalled();

    releaseCancellation();
    await cancelling;
    expect(records.get('core-resume-race')).toMatchObject({
      status: 'cancelled',
      agentName: 'claude',
      agentSessionId: 'stored-agent',
    });
    expect(lateAgent.destroy).toHaveBeenCalledOnce();
  });

  it('serializes an in-flight initial patch before terminal cancellation and never connects a bridge', async () => {
    const { store, records, delayNonterminal, releaseNonterminal } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('patch-cancel-race'));

    const agent = mockAgentInstance();
    const agentManager = {
      resume: vi.fn().mockResolvedValue(agent),
      spawn: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const eventBus = new EventBus();
    const factory = new SessionFactory(
      agentManager as any,
      manager,
      {} as any,
      eventBus,
    );
    const core = Object.create(OpenACPCore.prototype) as OpenACPCore;
    core.adapters = new Map([['telegram', {} as any]]);
    (core as any).bridges = new Map();
    core.agentManager = agentManager as any;
    core.sessionManager = manager;
    core.sessionStore = store as any;
    core.eventBus = eventBus;
    core.sessionFactory = factory;
    const bridge = vi.spyOn(core, 'createBridge');

    delayNonterminal();
    const creation = core.createSession({
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      existingSessionId: 'patch-cancel-race',
      resumeAgentSessionId: 'stored-agent',
    }).then(
      (session) => ({ status: 'resolved' as const, session }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );

    await vi.waitFor(() => {
      expect(manager.getSession('patch-cancel-race')).toBeDefined();
      expect(store.save).toHaveBeenCalledTimes(2);
    });
    const cancelling = manager.cancelSession('patch-cancel-race');
    expect(manager.getSession('patch-cancel-race')?.isTerminating).toBe(true);

    releaseNonterminal();
    const [creationResult, cancellationResult] = await bounded(
      Promise.all([creation, cancelling]),
    );

    expect(creationResult.status).toBe('rejected');
    if (creationResult.status === 'rejected') {
      expect(creationResult.error).toMatchObject({ code: 'SESSION_TERMINATING' });
    }
    expect(cancellationResult).toMatchObject({ status: 'cancelled', cleanupPending: false });
    expect(records.get('patch-cancel-race')?.status).toBe('cancelled');
    expect(store.save.mock.calls.map(([record]) => record.status)).toEqual([
      'active',
      'initializing',
      'cancelled',
    ]);
    expect(manager.getSession('patch-cancel-race')).toBeUndefined();
    expect(bridge).not.toHaveBeenCalled();
    expect(agent.destroy).toHaveBeenCalledOnce();
  });

  it('clears only the transient cancellation block after a failed durable save and invalidates retry generations', async () => {
    const { store, records, failNextCancellation } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('cancel-save-retry'));
    const oldLease = manager.beginSessionRegistration('cancel-save-retry');

    failNextCancellation();
    await expect(manager.cancelSession('cancel-save-retry')).rejects.toThrow('durable cancellation failed');
    expect(oldLease.invalidated).toBe(true);
    expect(records.get('cancel-save-retry')?.status).toBe('active');

    // Persistence failed, so a non-live record may start a new attempt. The old
    // lease remains invalid forever and the retry invalidates the new generation.
    const retryLease = manager.beginSessionRegistration('cancel-save-retry');
    const retry = manager.cancelSession('cancel-save-retry');
    await bounded(retryLease.invalidation);
    const result = await retry;

    expect(result).toMatchObject({ status: 'cancelled', alreadyTerminal: false });
    expect(retryLease.invalidated).toBe(true);
    expect(records.get('cancel-save-retry')?.status).toBe('cancelled');
    expect(() => manager.beginSessionRegistration('cancel-save-retry'))
      .toThrow(SessionRegistrationSupersededError);
  });

  it('lets cancellation fence a delayed session_end middleware continuation', async () => {
    const { store, records, delayCancellation, releaseCancellation } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('cancel-wins-session-end'));
    const agent = mockAgentInstance('cancel-winner-agent');
    const session = new Session({
      id: 'cancel-wins-session-end',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: agent,
    });
    session.activate();
    manager.registerSession(session);

    let releaseMiddleware!: () => void;
    const middlewareGate = new Promise<void>((resolve) => { releaseMiddleware = resolve; });
    const middlewareChain = {
      execute: vi.fn(async (_hook: unknown, payload: unknown) => {
        await middlewareGate;
        return payload;
      }),
    };
    const adapter = {
      name: 'telegram',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cleanupSkillCommands: vi.fn().mockResolvedValue(undefined),
    };
    const notificationManager = { notify: vi.fn() };
    const bridge = new SessionBridge(session, adapter as any, {
      messageTransformer: { transform: vi.fn().mockReturnValue({ type: 'session_end', text: 'done' }) } as any,
      notificationManager: notificationManager as any,
      sessionManager: manager,
      middlewareChain: middlewareChain as any,
    });
    const disconnect = vi.spyOn(bridge, 'disconnect');
    let bridgeOwned = true;
    manager.setSessionResourceCleanup(() => {
      if (!bridgeOwned) return;
      bridgeOwned = false;
      bridge.disconnect();
    });
    bridge.connect();

    agent.emit('agent_event', { type: 'session_end', reason: 'done' });
    await vi.waitFor(() => expect(middlewareChain.execute).toHaveBeenCalledOnce());
    delayCancellation();
    const cancelling = manager.cancelSession(session.id);
    expect(session.isTerminating).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();

    releaseMiddleware();
    await Promise.resolve();
    expect(session.status).toBe('active');
    expect(notificationManager.notify).not.toHaveBeenCalled();
    expect(adapter.sendMessage).not.toHaveBeenCalled();

    releaseCancellation();
    const result = await cancelling;
    expect(result).toMatchObject({ status: 'cancelled', alreadyTerminal: false });
    expect(records.get(session.id)?.status).toBe('cancelled');
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(agent.destroy).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('drops a delayed headless name event from an old agent generation while the replacement still works', async () => {
    const { store, records } = createDelayedStore();
    const manager = new SessionManager(store as any);
    const oldAgent = mockAgentInstance('headless-old-agent');
    const newAgent = mockAgentInstance('headless-new-agent');
    const agentManager = {
      spawn: vi.fn().mockResolvedValue(oldAgent),
      resume: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { core, eventBus } = createCoreHarness(
      manager,
      store,
      agentManager,
      {},
      { headless: true },
    );
    let releaseOldEvent!: () => void;
    const oldEventGate = new Promise<void>((resolve) => { releaseOldEvent = resolve; });
    let beforeEventCalls = 0;
    (core as any).lifecycleManager.middlewareChain = {
      execute: vi.fn(async (hook: string, payload: unknown) => {
        if (hook === 'agent:beforeEvent' && beforeEventCalls++ === 0) await oldEventGate;
        return payload;
      }),
    };
    const observed = vi.fn();
    eventBus.on('agent:event', observed);
    const session = await core.createSession({
      channelId: 'api',
      agentName: 'claude',
      workingDirectory: '/workspace',
    });

    oldAgent.emit('agent_event', { type: 'session_info_update', title: 'stale title' });
    await vi.waitFor(() => expect(beforeEventCalls).toBe(1));
    session.agentInstance = newAgent;
    session.agentSessionId = newAgent.sessionId;
    releaseOldEvent();
    await Promise.resolve();
    await Promise.resolve();
    expect(session.name).toBeUndefined();
    expect(records.get(session.id)?.name).toBeUndefined();
    expect(observed).not.toHaveBeenCalled();

    newAgent.emit('agent_event', { type: 'session_info_update', title: 'current title' });
    await vi.waitFor(() => expect(observed).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(records.get(session.id)?.name).toBe('current title'));
    expect(session.name).toBe('current title');
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: session.id,
      event: expect.objectContaining({ title: 'current title' }),
    }));
    await session.destroy();
  });

  it('drops a gated headless ordinary/name continuation after cancellation teardown', async () => {
    const { store, records } = createDelayedStore();
    const manager = new SessionManager(store as any);
    const agent = mockAgentInstance('headless-cancel-agent');
    const agentManager = {
      spawn: vi.fn().mockResolvedValue(agent),
      resume: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { core, eventBus } = createCoreHarness(
      manager,
      store,
      agentManager,
      {},
      { headless: true },
    );
    let releaseEvent!: () => void;
    const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    const middleware = {
      execute: vi.fn(async (_hook: string, payload: unknown) => {
        await eventGate;
        return payload;
      }),
    };
    (core as any).lifecycleManager.middlewareChain = middleware;
    const observed = vi.fn();
    eventBus.on('agent:event', observed);
    const session = await core.createSession({
      channelId: 'api',
      agentName: 'claude',
      workingDirectory: '/workspace',
    });
    session.activate();

    agent.emit('agent_event', { type: 'session_info_update', title: 'must not persist' });
    await vi.waitFor(() => expect(middleware.execute).toHaveBeenCalledOnce());
    const cancelled = await manager.cancelSession(session.id);
    releaseEvent();
    await Promise.resolve();
    await Promise.resolve();

    expect(cancelled.status).toBe('cancelled');
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(records.get(session.id)).toMatchObject({ status: 'cancelled' });
    expect(records.get(session.id)?.name).toBeUndefined();
    expect(observed).not.toHaveBeenCalled();
  });

  it('observes headless terminal ENOSPC and lets cancel retry durability without a false completion event', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-headless-enospc-'));
    const filePath = path.join(tmpDir, 'sessions.json');
    const store = new JsonFileSessionStore(filePath, 30);
    const manager = new SessionManager(store);
    const agent = mockAgentInstance('headless-enospc-agent');
    const agentManager = {
      spawn: vi.fn().mockResolvedValue(agent),
      resume: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { core, eventBus } = createCoreHarness(
      manager,
      store as any,
      agentManager,
      {},
      { headless: true },
    );
    const observed = vi.fn();
    eventBus.on('agent:event', observed);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const session = await core.createSession({
        channelId: 'api',
        agentName: 'claude',
        workingDirectory: '/workspace',
      });
      session.activate();
      await vi.waitFor(() => expect(store.get(session.id)?.status).toBe('active'));
      store.flush();
      const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
        throw new Error('ENOSPC headless terminal');
      });

      agent.emit('agent_event', { type: 'session_end', reason: 'done' });
      await vi.waitFor(() => expect(write).toHaveBeenCalled());
      await new Promise<void>((resolve) => setImmediate(resolve));
      write.mockRestore();
      expect(unhandled).toEqual([]);
      expect(observed).not.toHaveBeenCalled();
      expect(store.get(session.id)?.status).toBe('finished');
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('active');

      const result = await manager.cancelSession(session.id);
      expect(result).toMatchObject({ status: 'finished', cleanupPending: false });
      expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('finished');
      expect(observed).not.toHaveBeenCalled();
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
      store.destroy();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('drops a delayed headless session_end when shutdown crosses the lifecycle fence', async () => {
    const { store, records } = createDelayedStore();
    const manager = new SessionManager(store as any);
    const agent = mockAgentInstance('headless-shutdown-agent');
    const agentManager = {
      spawn: vi.fn().mockResolvedValue(agent),
      resume: vi.fn(),
      getAgent: vi.fn().mockReturnValue({ name: 'claude' }),
    };
    const { core, eventBus } = createCoreHarness(
      manager,
      store,
      agentManager,
      {},
      { headless: true },
    );
    let releaseEvent!: () => void;
    const eventGate = new Promise<void>((resolve) => { releaseEvent = resolve; });
    const middleware = {
      execute: vi.fn(async (_hook: string, payload: unknown) => {
        await eventGate;
        return payload;
      }),
    };
    (core as any).lifecycleManager.middlewareChain = middleware;
    const observed = vi.fn();
    eventBus.on('agent:event', observed);
    const session = await core.createSession({
      channelId: 'api',
      agentName: 'claude',
      workingDirectory: '/workspace',
    });
    session.activate();

    agent.emit('agent_event', { type: 'session_end', reason: 'late' });
    await vi.waitFor(() => expect(middleware.execute).toHaveBeenCalledOnce());
    await manager.shutdownAll();
    releaseEvent();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.status).toBe('active');
    expect(records.get(session.id)?.status).toBe('finished');
    expect(observed).not.toHaveBeenCalled();
  });

  it('preserves a synchronous session_end winner while its durable patch is delayed', async () => {
    const { store, records, delayNonterminal, releaseNonterminal } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('finish-wins-cancel'));
    const agent = mockAgentInstance('finish-winner-agent');
    const session = new Session({
      id: 'finish-wins-cancel',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: agent,
    });
    session.activate();
    manager.registerSession(session);
    const adapter = {
      name: 'telegram',
      sendMessage: vi.fn().mockResolvedValue(undefined),
      cleanupSkillCommands: vi.fn().mockResolvedValue(undefined),
    };
    const notificationManager = { notify: vi.fn() };
    const bridge = new SessionBridge(session, adapter as any, {
      messageTransformer: { transform: vi.fn().mockReturnValue({ type: 'session_end', text: 'done' }) } as any,
      notificationManager: notificationManager as any,
      sessionManager: manager,
    });
    const disconnect = vi.spyOn(bridge, 'disconnect');
    let bridgeOwned = true;
    manager.setSessionResourceCleanup(() => {
      if (!bridgeOwned) return;
      bridgeOwned = false;
      bridge.disconnect();
    });
    bridge.connect();

    delayNonterminal();
    agent.emit('agent_event', { type: 'session_end', reason: 'done' });
    expect(session.status).toBe('finished');
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
    const cancelling = manager.cancelSession(session.id);
    expect(session.isTerminating).toBe(true);
    expect(disconnect).not.toHaveBeenCalled();

    releaseNonterminal();
    const result = await cancelling;
    expect(result).toMatchObject({
      status: 'finished',
      previousStatus: 'finished',
      alreadyTerminal: true,
      cancelled: false,
    });
    expect(records.get(session.id)?.status).toBe('finished');
    expect(manager.getSession(session.id)).toBeUndefined();
    expect(agent.destroy).toHaveBeenCalledOnce();
    expect(notificationManager.notify).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('keeps a terminal durable winner through queued status and metadata patches', async () => {
    const { store, records, delayNonterminal, releaseNonterminal } = createDelayedStore();
    const manager = new SessionManager(store as any);
    await store.save(activeRecord('terminal-policy'));

    delayNonterminal();
    const before = manager.patchRecord('terminal-policy', { status: 'active', name: 'before' });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledTimes(2));
    const cancelling = manager.cancelSession('terminal-policy');
    const after = manager.patchRecord('terminal-policy', { status: 'active', name: 'after' });
    releaseNonterminal();
    await Promise.all([before, cancelling, after]);

    expect(records.get('terminal-policy')).toMatchObject({ status: 'cancelled', name: 'before' });
    await manager.patchRecord('terminal-policy', { name: 'metadata-only' });
    expect(records.get('terminal-policy')).toMatchObject({ status: 'cancelled', name: 'metadata-only' });
    await manager.patchRecord('terminal-policy', { status: 'finished', name: 'terminal-conflict' });
    expect(records.get('terminal-policy')).toMatchObject({ status: 'cancelled', name: 'metadata-only' });
    await manager.patchRecord('terminal-policy', { status: 'active' });
    expect(records.get('terminal-policy')?.status).toBe('cancelled');
  });

  it('does not serialize durable mutations across different session IDs', async () => {
    const records = new Map<string, SessionRecord>([
      ['blocked-id', activeRecord('blocked-id')],
      ['free-id', activeRecord('free-id')],
    ]);
    let releaseBlocked!: () => void;
    const blockedGate = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    const store = {
      get: vi.fn((id: string) => records.get(id)),
      save: vi.fn(async (record: SessionRecord) => {
        if (record.sessionId === 'blocked-id' && record.name === 'blocked') await blockedGate;
        records.set(record.sessionId, structuredClone(record));
      }),
      flush: vi.fn(),
      remove: vi.fn(),
      list: vi.fn(() => [...records.values()]),
      findByPlatform: vi.fn(),
      findByAgentSessionId: vi.fn(),
      findAssistant: vi.fn(),
    };
    const manager = new SessionManager(store as any);

    const blocked = manager.patchRecord('blocked-id', { name: 'blocked' });
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledOnce());
    await bounded(manager.patchRecord('free-id', { name: 'free' }));
    expect(records.get('free-id')?.name).toBe('free');

    releaseBlocked();
    await blocked;
    expect(records.get('blocked-id')?.name).toBe('blocked');
  });
});
