import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../../utils/typed-emitter.js';
import { EventBus } from '../../event-bus.js';
import type { AgentEvent } from '../../types.js';
import type { AgentInstance } from '../../agents/agent-instance.js';
import { SessionFactory } from '../session-factory.js';
import { SessionLimitError, SessionManager } from '../session-manager.js';

function mockAgent(sessionId: string): AgentInstance {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>();
  return Object.assign(emitter, {
    sessionId,
    agentName: 'codex',
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    addAllowedPath: vi.fn(),
    onPermissionRequest: vi.fn(),
    initialSessionResponse: undefined,
    agentCapabilities: undefined,
  }) as unknown as AgentInstance;
}

function createFactory(manager: SessionManager, spawn = vi.fn()) {
  const agentManager = {
    spawn,
    resume: vi.fn(),
  };
  const factory = new SessionFactory(
    agentManager as any,
    manager,
    {} as any,
    new EventBus(),
  );
  return { factory, agentManager };
}

describe('SessionManager atomic session admission', () => {
  it('admits exactly the configured boundary under concurrent reservations', async () => {
    const manager = new SessionManager();
    manager.setSessionLimitProvider(() => 2);

    const results = await Promise.allSettled([
      manager.reserveSessionAdmission(),
      manager.reserveSessionAdmission(),
      manager.reserveSessionAdmission(),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: expect.any(SessionLimitError) });
    for (const result of results) {
      if (result.status === 'fulfilled') manager.releaseSessionAdmission(result.value);
    }
  });

  it('holds capacity before spawn across create and resume surfaces', async () => {
    const manager = new SessionManager();
    manager.setSessionLimitProvider(() => 1);
    let resolveSpawn!: (agent: AgentInstance) => void;
    const spawn = vi.fn(() => new Promise<AgentInstance>((resolve) => { resolveSpawn = resolve; }));
    const { factory, agentManager } = createFactory(manager, spawn);

    const creating = factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

    await expect(factory.create({
      channelId: 'telegram',
      agentName: 'codex',
      workingDirectory: '/tmp',
      existingSessionId: 'durable-session',
      resumeAgentSessionId: 'agent-session',
    })).rejects.toBeInstanceOf(SessionLimitError);
    expect(agentManager.resume).not.toHaveBeenCalled();

    resolveSpawn(mockAgent('created-agent'));
    await expect(creating).resolves.toBeDefined();
  });

  it('releases a failed initialization reservation for a later create', async () => {
    const manager = new SessionManager();
    manager.setSessionLimitProvider(() => 1);
    const spawn = vi.fn()
      .mockRejectedValueOnce(new Error('initialization failed'))
      .mockResolvedValueOnce(mockAgent('retry-agent'));
    const { factory } = createFactory(manager, spawn);

    await expect(factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    })).rejects.toThrow('initialization failed');

    await expect(factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    })).resolves.toBeDefined();
  });

  it('frees a committed slot at the cancellation terminal boundary', async () => {
    const manager = new SessionManager();
    manager.setSessionLimitProvider(() => 1);
    let nextAgent = 0;
    const spawn = vi.fn(() => Promise.resolve(mockAgent(`agent-${++nextAgent}`)));
    const { factory } = createFactory(manager, spawn);
    const session = await factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    });

    await expect(factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    })).rejects.toBeInstanceOf(SessionLimitError);

    await manager.cancelSession(session.id);

    await expect(factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    })).resolves.toBeDefined();
  });

  it('blocks error-session reactivation when another session owns the hot-reloaded cap', async () => {
    const manager = new SessionManager();
    let limit = 1;
    manager.setSessionLimitProvider(() => limit);
    const firstAgent = mockAgent('first-agent');
    const secondAgent = mockAgent('second-agent');
    const spawn = vi.fn()
      .mockResolvedValueOnce(firstAgent)
      .mockResolvedValueOnce(secondAgent);
    const { factory } = createFactory(manager, spawn);
    const errored = await factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    });
    errored.fail('retry later');

    const active = await factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    });
    active.activate();
    limit = 1;

    await expect(errored.acceptPrompt('retry')).rejects.toBeInstanceOf(SessionLimitError);
    expect(firstAgent.prompt).not.toHaveBeenCalled();
    expect(errored.status).toBe('error');
  });

  it('admits only one of two concurrent error-session reactivations after a limit reduction', async () => {
    const manager = new SessionManager();
    let limit = 2;
    manager.setSessionLimitProvider(() => limit);
    const firstAgent = mockAgent('first-agent');
    const secondAgent = mockAgent('second-agent');
    const { factory } = createFactory(
      manager,
      vi.fn().mockResolvedValueOnce(firstAgent).mockResolvedValueOnce(secondAgent),
    );
    const first = await factory.create({ channelId: 'api', agentName: 'codex', workingDirectory: '/tmp' });
    const second = await factory.create({ channelId: 'api', agentName: 'codex', workingDirectory: '/tmp' });
    first.fail('retry first');
    second.fail('retry second');
    limit = 1;

    const results = await Promise.allSettled([
      first.acceptPrompt('first retry'),
      second.acceptPrompt('second retry'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: expect.any(SessionLimitError),
    });
    await vi.waitFor(() => {
      expect(
        (firstAgent.prompt as ReturnType<typeof vi.fn>).mock.calls.length
        + (secondAgent.prompt as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBe(1);
    });
  });

  it('shares one reacquired slot across concurrent prompts to the same error session', async () => {
    const manager = new SessionManager();
    manager.setSessionLimitProvider(() => 1);
    const agent = mockAgent('shared-agent');
    const { factory } = createFactory(manager, vi.fn().mockResolvedValue(agent));
    const session = await factory.create({ channelId: 'api', agentName: 'codex', workingDirectory: '/tmp' });
    session.fail('retry');

    await expect(Promise.all([
      session.acceptPrompt('retry one'),
      session.acceptPrompt('retry two'),
    ])).resolves.toHaveLength(2);
    await expect(factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    })).rejects.toBeInstanceOf(SessionLimitError);
    await vi.waitFor(() => {
      const userPrompts = (agent.prompt as ReturnType<typeof vi.fn>).mock.calls
        .filter(([text]) => text === 'retry one' || text === 'retry two');
      expect(userPrompts).toHaveLength(2);
    });

    session.fail('failed again');
    await expect(factory.create({
      channelId: 'api',
      agentName: 'codex',
      workingDirectory: '/tmp',
    })).resolves.toBeDefined();
  });

  it('rechecks capacity before a queued prompt can reactivate after the preceding turn fails', async () => {
    const manager = new SessionManager();
    let limit = 1;
    manager.setSessionLimitProvider(() => limit);
    const agent = mockAgent('queued-agent');
    let rejectFirst!: (error: Error) => void;
    (agent.prompt as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValue({});
    const { factory } = createFactory(manager, vi.fn().mockResolvedValue(agent));
    const session = await factory.create({ channelId: 'api', agentName: 'codex', workingDirectory: '/tmp' });

    await session.acceptPrompt('first');
    await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledWith('first', undefined));
    await session.acceptPrompt('queued retry');
    expect(session.queueDepth).toBe(1);

    limit = 0;
    rejectFirst(new Error('first turn failed'));
    await vi.waitFor(() => expect(session.status).toBe('error'));
    await vi.waitFor(() => expect(session.queueDepth).toBe(0));
    expect((agent.prompt as ReturnType<typeof vi.fn>).mock.calls.some(
      ([text]) => text === 'queued retry',
    )).toBe(false);
  });
});
