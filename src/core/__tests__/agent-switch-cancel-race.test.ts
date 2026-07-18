import { describe, expect, it, vi } from 'vitest';
import { AgentSwitchHandler } from '../agent-switch-handler.js';
import { Session } from '../sessions/session.js';
import { SessionManager } from '../sessions/session-manager.js';
import { TypedEmitter } from '../utils/typed-emitter.js';
import type { AgentEvent, SessionRecord } from '../types.js';

function mockAgentInstance(sessionId: string) {
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

describe('AgentSwitchHandler — terminal cancel boundary', () => {
  it('does not resurrect a cancelled session when delayed replacement creation settles', async () => {
    const records = new Map<string, SessionRecord>();
    let delayCancellationSave = false;
    let releaseCancellationSave!: () => void;
    const cancellationSaveGate = new Promise<void>((resolve) => { releaseCancellationSave = resolve; });
    const store = {
      save: vi.fn(async (record: SessionRecord) => {
        if (delayCancellationSave && record.status === 'cancelled') {
          await cancellationSaveGate;
        }
        records.set(record.sessionId, structuredClone(record));
      }),
      flush: vi.fn(),
      get: vi.fn((sessionId: string) => records.get(sessionId)),
      findByPlatform: vi.fn(),
      findByAgentSessionId: vi.fn(),
      findAssistant: vi.fn(),
      list: vi.fn(() => [...records.values()]),
      remove: vi.fn(async (sessionId: string) => { records.delete(sessionId); }),
    };
    const sessionManager = new SessionManager(store as any);
    const oldAgent = mockAgentInstance('old-agent');
    const newAgent = mockAgentInstance('new-agent');
    const session = new Session({
      id: 'switch-cancel-race',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: oldAgent,
    });
    session.agentSessionId = oldAgent.sessionId;
    session.activate();
    sessionManager.registerSession(session);
    await store.save({
      sessionId: session.id,
      agentSessionId: oldAgent.sessionId,
      agentName: session.agentName,
      workingDir: session.workingDirectory,
      channelId: session.channelId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: new Date().toISOString(),
      clientOverrides: {},
      platform: {},
    });

    let releaseSpawn!: (agent: any) => void;
    const delayedSpawn = new Promise<any>((resolve) => { releaseSpawn = resolve; });
    const agentManager = {
      getAgent: vi.fn().mockReturnValue({ name: 'gemini' }),
      spawn: vi.fn().mockReturnValue(delayedSpawn),
      resume: vi.fn(),
    };
    const bridge = { connect: vi.fn(), disconnect: vi.fn() };
    const createBridge = vi.fn().mockReturnValue({ connect: vi.fn(), disconnect: vi.fn() });
    const bridges = new Map([[`telegram:${session.id}`, bridge as any]]);
    const eventBus = { emit: vi.fn() };
    const patchRecord = vi.spyOn(sessionManager, 'patchRecord');
    const handler = new AgentSwitchHandler({
      sessionManager,
      agentManager: agentManager as any,
      configManager: { get: vi.fn().mockReturnValue({ workspace: { security: { allowedPaths: [] } } }) } as any,
      eventBus: eventBus as any,
      adapters: new Map([['telegram', {
        sendSkillCommands: vi.fn().mockResolvedValue(undefined),
        cleanupSessionState: vi.fn().mockResolvedValue(undefined),
      } as any]]),
      createBridge,
      disconnectSessionBridges: vi.fn().mockImplementation(() => {
        const key = `telegram:${session.id}`;
        const current = bridges.get(key);
        if (!current) return 0;
        bridges.delete(key);
        current.disconnect();
        return 1;
      }),
      getMiddlewareChain: vi.fn().mockReturnValue(undefined),
      getService: vi.fn().mockReturnValue(undefined),
    });

    const switchOutcome = handler.switch(session.id, 'gemini').then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => expect(agentManager.spawn).toHaveBeenCalledOnce());
    expect(oldAgent.destroy).toHaveBeenCalledOnce();

    // Hold durable cancellation I/O open. beginTermination() must stop switch
    // immediately, before cancellation reaches destroy() or removes the session.
    delayCancellationSave = true;
    const cancelling = sessionManager.cancelSession(session.id);
    await vi.waitFor(() => expect(session.isTerminating).toBe(true));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      switchOutcome,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('switch did not stop at terminal boundary')), 250);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error).toMatchObject({ code: 'SESSION_TERMINATING' });
    }
    expect(sessionManager.getSession(session.id)).toBe(session);
    expect(oldAgent.destroy).toHaveBeenCalledOnce();
    expect(createBridge).not.toHaveBeenCalled();
    expect(patchRecord).not.toHaveBeenCalled();
    expect(agentManager.resume).not.toHaveBeenCalled();
    expect(records.get(session.id)).toMatchObject({
      status: 'active',
      agentName: 'claude',
      agentSessionId: 'old-agent',
    });

    releaseCancellationSave();
    const cancelResult = await cancelling;
    expect(cancelResult).toMatchObject({ status: 'cancelled', cleanupPending: false });
    expect(sessionManager.getSession(session.id)).toBeUndefined();
    expect(records.get(session.id)).toMatchObject({
      status: 'cancelled',
      agentName: 'claude',
      agentSessionId: 'old-agent',
    });
    expect(eventBus.emit.mock.calls.some(([, payload]) =>
      payload?.status === 'succeeded' || payload?.status === 'failed')).toBe(false);

    releaseSpawn(newAgent);
    await vi.waitFor(() => expect(newAgent.destroy).toHaveBeenCalledOnce());
    expect(session.agentInstance).toBe(oldAgent);
    expect(createBridge).not.toHaveBeenCalled();
    expect(patchRecord).not.toHaveBeenCalled();
    expect(newAgent.destroy).toHaveBeenCalledOnce();
  });

  it('removes a just-reconnected bridge when cancel wins during switch persistence', async () => {
    const records = new Map<string, SessionRecord>();
    let blockSwitchSave = false;
    let releaseSwitchSave!: () => void;
    const switchSaveGate = new Promise<void>((resolve) => { releaseSwitchSave = resolve; });
    const store = {
      save: vi.fn(async (record: SessionRecord) => {
        if (blockSwitchSave && record.agentName === 'gemini' && record.status !== 'cancelled') {
          await switchSaveGate;
        }
        records.set(record.sessionId, structuredClone(record));
      }),
      flush: vi.fn(),
      get: vi.fn((sessionId: string) => records.get(sessionId)),
      findByPlatform: vi.fn(),
      findByAgentSessionId: vi.fn(),
      findAssistant: vi.fn(),
      list: vi.fn(() => [...records.values()]),
      remove: vi.fn(async (sessionId: string) => { records.delete(sessionId); }),
    };
    const sessionManager = new SessionManager(store as any);
    const oldAgent = mockAgentInstance('old-reconnect-agent');
    const newAgent = mockAgentInstance('new-reconnect-agent');
    const session = new Session({
      id: 'switch-reconnect-cancel-race',
      channelId: 'telegram',
      agentName: 'claude',
      workingDirectory: '/workspace',
      agentInstance: oldAgent,
    });
    session.agentSessionId = oldAgent.sessionId;
    session.activate();
    sessionManager.registerSession(session);
    await store.save({
      sessionId: session.id,
      agentSessionId: oldAgent.sessionId,
      agentName: session.agentName,
      workingDir: session.workingDirectory,
      channelId: session.channelId,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: new Date().toISOString(),
      clientOverrides: {},
      platform: {},
    });

    const oldBridge = { connect: vi.fn(), disconnect: vi.fn() };
    const reconnectedBridge = { connect: vi.fn(), disconnect: vi.fn() };
    const bridgeKey = `telegram:${session.id}`;
    const bridges = new Map<string, typeof oldBridge | typeof reconnectedBridge>([
      [bridgeKey, oldBridge],
    ]);
    const disconnectSessionBridges = vi.fn().mockImplementation(() => {
      const bridge = bridges.get(bridgeKey);
      if (!bridge) return 0;
      bridges.delete(bridgeKey);
      bridge.disconnect();
      return 1;
    });
    sessionManager.setSessionResourceCleanup(() => {
      disconnectSessionBridges(session.id);
    });
    const createBridge = vi.fn().mockImplementation(() => {
      bridges.set(bridgeKey, reconnectedBridge);
      return reconnectedBridge;
    });
    const eventBus = { emit: vi.fn() };
    const handler = new AgentSwitchHandler({
      sessionManager,
      agentManager: {
        getAgent: vi.fn().mockReturnValue({ name: 'gemini' }),
        spawn: vi.fn().mockResolvedValue(newAgent),
        resume: vi.fn(),
      } as any,
      configManager: { get: vi.fn().mockReturnValue({ workspace: { security: { allowedPaths: [] } } }) } as any,
      eventBus: eventBus as any,
      adapters: new Map([['telegram', {
        sendSkillCommands: vi.fn().mockResolvedValue(undefined),
        cleanupSessionState: vi.fn().mockResolvedValue(undefined),
      } as any]]),
      createBridge,
      disconnectSessionBridges,
      getMiddlewareChain: vi.fn().mockReturnValue(undefined),
      getService: vi.fn().mockReturnValue(undefined),
    });

    blockSwitchSave = true;
    const switching = handler.switch(session.id, 'gemini').then(
      (value) => ({ status: 'resolved' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    await vi.waitFor(() => {
      expect(createBridge).toHaveBeenCalledOnce();
      expect(reconnectedBridge.connect).toHaveBeenCalledOnce();
      expect(store.save.mock.calls.some(([record]) => record.agentName === 'gemini')).toBe(true);
    });
    expect(bridges.size).toBe(1);
    expect(bridges.get(bridgeKey)).toBe(reconnectedBridge);

    const cancelling = sessionManager.cancelSession(session.id);
    expect(session.isTerminating).toBe(true);
    expect(bridges.size).toBe(0);
    expect(oldBridge.disconnect).toHaveBeenCalledOnce();
    expect(reconnectedBridge.disconnect).toHaveBeenCalledOnce();

    releaseSwitchSave();
    const [switchResult, cancelResult] = await Promise.all([switching, cancelling]);
    expect(switchResult.status).toBe('rejected');
    if (switchResult.status === 'rejected') {
      expect(switchResult.error).toMatchObject({ code: 'SESSION_TERMINATING' });
    }
    expect(cancelResult).toMatchObject({ status: 'cancelled', cleanupPending: false });
    expect(bridges.size).toBe(0);
    expect(oldBridge.disconnect).toHaveBeenCalledOnce();
    expect(reconnectedBridge.connect).toHaveBeenCalledOnce();
    expect(reconnectedBridge.disconnect).toHaveBeenCalledOnce();
    expect(oldAgent.destroy).toHaveBeenCalledOnce();
    expect(newAgent.destroy).toHaveBeenCalledOnce();
    expect(records.get(session.id)).toMatchObject({
      status: 'cancelled',
      agentName: 'gemini',
      agentSessionId: 'new-reconnect-agent',
    });
    expect(eventBus.emit.mock.calls.some(([, payload]) =>
      payload?.status === 'succeeded' || payload?.status === 'failed')).toBe(false);
  });
});
