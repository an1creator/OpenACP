import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sessionRoutes } from '../routes/sessions.js';
import { globalErrorHandler } from '../middleware/error-handler.js';
import type { RouteDeps } from '../routes/types.js';
import { SessionLimitError, SessionManager } from '../../../core/sessions/session-manager.js';
import { Session } from '../../../core/sessions/session.js';
import { ElicitationGate } from '../../../core/sessions/elicitation-gate.js';
import { TypedEmitter } from '../../../core/utils/typed-emitter.js';
import { apiMessagePrincipal, apiPlatformUserId } from '../routes/prompt-response.js';

function createMockSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    agentName: 'claude',
    status: 'active',
    name: 'Test Session',
    workingDirectory: '/tmp/test',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    clientOverrides: { bypassPermissions: false },
    queueDepth: 0,
    queueItems: [],
    promptRunning: false,
    threadId: 'thread-1',
    channelId: 'api',
    agentSessionId: 'agent-sess-1',
    configOptions: [],
    agentCapabilities: undefined,
    agentInstance: {
      onPermissionRequest: null,
    },
    permissionGate: {
      isPending: false,
      requestId: null,
      resolve: vi.fn(),
    },
    elicitationGate: new ElicitationGate(),
    enqueuePrompt: vi.fn().mockResolvedValue(undefined),
    abortPrompt: vi.fn().mockResolvedValue(undefined),
    setName: vi.fn((name: string) => name.replace(/\s+/g, ' ').trim().slice(0, 200)),
    ...overrides,
  };
}

function createMockDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  const mockSession = createMockSession();

  const sessionManager = {
    listSessions: vi.fn().mockReturnValue([mockSession]),
    listAllSessions: vi.fn().mockReturnValue([
      {
        id: 'sess-1',
        agent: 'claude',
        status: 'active',
        name: 'Test Session',
        workspace: '/tmp/test',
        channelId: 'api',
        createdAt: '2026-01-01T00:00:00Z',
        lastActiveAt: '2026-01-01T00:00:00Z',
        dangerousMode: false,
        queueDepth: 0,
        promptRunning: false,
        configOptions: undefined,
        capabilities: null,
        isLive: true,
      },
    ]),
    getSession: vi.fn().mockReturnValue(mockSession),
    getSessionRecord: vi.fn().mockReturnValue({ lastActiveAt: '2026-01-01T00:00:00Z' }),
    cancelSession: vi.fn().mockResolvedValue({
      sessionId: 'sess-1',
      cancelled: true,
      previousStatus: 'initializing',
      status: 'cancelled',
      alreadyTerminal: false,
    }),
    patchRecord: vi.fn().mockResolvedValue(undefined),
  };

  return {
    core: {
      sessionManager,
      configManager: {
        get: vi.fn().mockReturnValue({
          defaultAgent: 'claude',
          security: { maxConcurrentSessions: 5 },
        }),
        resolveWorkspace: vi.fn().mockReturnValue('/tmp/test'),
      },
      agentCatalog: {
        resolve: vi.fn().mockReturnValue({ workingDirectory: '/tmp/test' }),
      },
      adapters: new Map(),
      createSession: vi.fn().mockResolvedValue(mockSession),
      adoptSession: vi.fn().mockResolvedValue({ ok: true, sessionId: 'sess-1' }),
      archiveSession: vi.fn().mockResolvedValue({ ok: true }),
      // Delegates to sessionManager.getSession so tests can control both via one mock
      getOrResumeSessionById: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(sessionManager.getSession(id))
      ),
      agentManager: {
        getAvailableAgents: vi.fn().mockReturnValue([]),
      },
      eventBus: { emit: vi.fn() },
      handleMessageInSession: vi.fn().mockResolvedValue({
        status: 'accepted',
        turnId: 'test-turn',
        queueDepth: 0,
      }),
    } as any,
    topicManager: undefined,
    startedAt: Date.now(),
    getVersion: () => '1.0.0',
    ...overrides,
  };
}

describe('session routes', () => {
  let app: FastifyInstance;
  let deps: RouteDeps;

  beforeEach(async () => {
    app = Fastify();
    app.setErrorHandler(globalErrorHandler);
    // Mock auth: decorate request with admin-level auth so scope checks pass
    app.decorateRequest('auth', null, []);
    app.addHook('onRequest', async (request) => {
      const testAuth = request.headers['x-test-auth'];
      const jwt = typeof testAuth === 'string' ? /^jwt:([^:]+)(?::(.+))?$/.exec(testAuth) : null;
      request.auth = jwt
        ? { type: 'jwt', tokenId: jwt[1], userId: jwt[2], role: 'admin', scopes: ['*'] }
        : { type: 'secret', role: 'admin', scopes: ['*'] };
    });
    deps = createMockDeps();
    await app.register(
      async (instance) => {
        await sessionRoutes(instance, deps);
      },
      { prefix: '/api/v1/sessions' },
    );
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/v1/sessions', () => {
    it('returns list of sessions with isLive and lastActiveAt', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe('sess-1');
      expect(body.sessions[0].agent).toBe('claude');
      expect(body.sessions[0].status).toBe('active');
      expect(body.sessions[0].isLive).toBe(true);
      expect(body.sessions[0].lastActiveAt).toBe('2026-01-01T00:00:00Z');
      expect(body.sessions[0].channelId).toBe('api');
    });

    it('returns historical (non-live) sessions', async () => {
      (deps.core.sessionManager.listAllSessions as any).mockReturnValue([
        {
          id: 'old-sess',
          agent: 'claude',
          status: 'cancelled',
          name: 'Old Session',
          workspace: '/tmp/old',
          channelId: 'telegram',
          createdAt: '2026-01-01T00:00:00Z',
          lastActiveAt: '2026-01-02T00:00:00Z',
          dangerousMode: false,
          queueDepth: 0,
          promptRunning: false,
          configOptions: undefined,
          capabilities: null,
          isLive: false,
        },
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sessions[0].id).toBe('old-sess');
      expect(body.sessions[0].status).toBe('cancelled');
      expect(body.sessions[0].isLive).toBe(false);
      expect(body.sessions[0].lastActiveAt).toBe('2026-01-02T00:00:00Z');
    });
  });

  describe('GET /api/v1/sessions/:sessionId', () => {
    it('returns session details', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/sess-1',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.session.id).toBe('sess-1');
      expect(body.session.agent).toBe('claude');
    });

    it('returns 404 for unknown session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(null);
      (deps.core.sessionManager.getSessionRecord as any).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/unknown',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('POST /api/v1/sessions', () => {
    it('creates a new session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { agent: 'claude' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.sessionId).toBe('sess-1');
      expect(deps.core.createSession).toHaveBeenCalled();
    });

    it('returns 429 when max sessions reached', async () => {
      (deps.core.createSession as any).mockRejectedValueOnce(new SessionLimitError(1));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: {},
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: {
          code: 'SESSION_LIMIT',
          message: 'Maximum concurrent sessions reached (1)',
          statusCode: 429,
        },
      });
    });

    it('returns 400 for invalid adapter', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { channel: 'nonexistent' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('creates headless API session when no channel is provided, even if adapters are registered', async () => {
      // Simulate a Telegram adapter being registered
      (deps.core.adapters as Map<string, any>).set('telegram', {} as any);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { agent: 'claude' },
      });

      expect(response.statusCode).toBe(200);
      expect(deps.core.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'api', createThread: false }),
      );
    });

    it('creates adapter session when explicit channel is provided', async () => {
      const mockAdapter = {} as any;
      (deps.core.adapters as Map<string, any>).set('telegram', mockAdapter);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions',
        payload: { agent: 'claude', channel: 'telegram' },
      });

      expect(response.statusCode).toBe(200);
      expect(deps.core.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ channelId: 'telegram', createThread: true }),
      );
    });
  });

  describe('GET /api/v1/sessions/:sessionId/queue', () => {
    it('reads a live queue without invoking lazy resume', async () => {
      const session = createMockSession({
        queueItems: [{ userPrompt: 'second', turnId: 'turn-2' }],
        queueDepth: 1,
        promptRunning: true,
      });
      (deps.core.sessionManager.getSession as any).mockReturnValue(session);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/sess-1/queue',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        pending: [{ userPrompt: 'second', turnId: 'turn-2' }],
        processing: true,
        queueDepth: 1,
        status: 'active',
        isLive: true,
      });
      expect(deps.core.getOrResumeSessionById).not.toHaveBeenCalled();
    });

    it('returns a truthful empty terminal snapshot without spawning ACP', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(undefined);
      (deps.core.sessionManager.getSessionRecord as any).mockReturnValue({
        sessionId: 'finished-session',
        status: 'finished',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/finished-session/queue',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        pending: [],
        processing: false,
        queueDepth: 0,
        status: 'finished',
        isLive: false,
      });
      expect(deps.core.getOrResumeSessionById).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown durable and live session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(undefined);
      (deps.core.sessionManager.getSessionRecord as any).mockReturnValue(undefined);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/missing/queue',
      });

      expect(response.statusCode).toBe(404);
      expect(deps.core.getOrResumeSessionById).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/v1/sessions/adopt', () => {
    it('adopts an existing agent session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/adopt',
        payload: { agent: 'claude', agentSessionId: 'ext-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
    });

    it('validates required fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/adopt',
        payload: { agent: '' },
      });

      // Zod validation will reject empty string (min 1)
      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST /api/v1/sessions/:sessionId/prompt', () => {
    it('accepts a prompt and preserves the transport turn id', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/prompt',
        payload: { prompt: 'Hello!' },
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body).toMatchObject({
        ok: true,
        accepted: true,
        status: 'accepted',
        sessionId: 'sess-1',
        queueDepth: 0,
      });
      expect(body.turnId).toBe('test-turn');
      expect(deps.core.handleMessageInSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'sess-1' }),
        expect.objectContaining({ text: 'Hello!' }),
        expect.any(Object),
        expect.objectContaining({
          principal: { type: 'api', credential: 'secret' },
        }),
      );
    });

    it.each([
      {
        code: 'MESSAGE_BLOCKED',
        reason: 'Message was blocked by ingress policy.',
        statusCode: 403,
      },
      {
        code: 'SESSION_LIMIT',
        reason: 'Concurrent session limit reached.',
        statusCode: 429,
      },
    ])('returns a typed $statusCode response for $code', async ({ code, reason, statusCode }) => {
      (deps.core.handleMessageInSession as any).mockResolvedValueOnce({
        status: 'blocked',
        turnId: 'blocked-turn',
        code,
        reason,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/prompt',
        payload: { prompt: 'Hello!' },
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({
        error: { code, message: reason, statusCode },
      });
    });

    it('returns 404 for unknown session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(null);

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/unknown/prompt',
        payload: { prompt: 'Hello!' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for terminated session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({ status: 'cancelled' }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/prompt',
        payload: { prompt: 'Hello!' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('lets a live error session reacquire capacity and returns standard SESSION_LIMIT at the cap', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({ status: 'error' }),
      );
      (deps.core.handleMessageInSession as any).mockRejectedValueOnce(new SessionLimitError(1));

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/prompt',
        payload: { prompt: 'Retry the failed turn' },
      });

      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({
        error: {
          code: 'SESSION_LIMIT',
          message: 'Maximum concurrent sessions reached (1)',
          statusCode: 429,
        },
      });
      expect(deps.core.handleMessageInSession).toHaveBeenCalledOnce();
    });
  });

  describe('POST /api/v1/sessions/:sessionId/permission', () => {
    it('resolves a pending permission', async () => {
      const mockResolve = vi.fn();
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({
          permissionGate: {
            isPending: true,
            requestId: 'perm-1',
            resolve: mockResolve,
          },
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/permission',
        payload: { permissionId: 'perm-1', optionId: 'allow' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockResolve).toHaveBeenCalledWith('allow');
    });

    it('returns 400 when no matching permission', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/permission',
        payload: { permissionId: 'wrong-id', optionId: 'allow' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('aborts current turn and enqueues feedback when feedback provided', async () => {
      const mockAbortPrompt = vi.fn().mockResolvedValue(undefined);
      const mockEnqueuePrompt = vi.fn().mockResolvedValue('turn-1');
      const mockResolve = vi.fn();
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({
          permissionGate: { isPending: true, requestId: 'perm-1', resolve: mockResolve },
          abortPrompt: mockAbortPrompt,
          enqueuePrompt: mockEnqueuePrompt,
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/permission',
        payload: { permissionId: 'perm-1', optionId: 'deny', feedback: 'Please use a different approach' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockResolve).toHaveBeenCalledWith('deny');
      expect(mockAbortPrompt).toHaveBeenCalled();
      expect(mockEnqueuePrompt).toHaveBeenCalledWith(
        'Please use a different approach',
        undefined,
        { sourceAdapterId: 'api' },
      );
      // abort must complete before enqueue (sequential, not concurrent)
      const abortOrder = mockAbortPrompt.mock.invocationCallOrder[0];
      const enqueueOrder = mockEnqueuePrompt.mock.invocationCallOrder[0];
      expect(abortOrder).toBeLessThan(enqueueOrder);
    });

    it('does not abort or enqueue when no feedback provided', async () => {
      const mockAbortPrompt = vi.fn().mockResolvedValue(undefined);
      const mockEnqueuePrompt = vi.fn().mockResolvedValue('turn-1');
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({
          permissionGate: { isPending: true, requestId: 'perm-1', resolve: vi.fn() },
          abortPrompt: mockAbortPrompt,
          enqueuePrompt: mockEnqueuePrompt,
        }),
      );

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/permission',
        payload: { permissionId: 'perm-1', optionId: 'allow' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockAbortPrompt).not.toHaveBeenCalled();
      expect(mockEnqueuePrompt).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/v1/sessions/:sessionId', () => {
    it('returns the normalized manual name selected by core', async () => {
      const setName = vi.fn().mockReturnValue('Normalized Manual Name');
      (deps.core.sessionManager.getSession as any).mockReturnValue(createMockSession({ setName }));

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/sessions/sess-1',
        payload: { name: '  Normalized\nManual Name  ' },
      });

      expect(response.statusCode).toBe(200);
      expect(setName).toHaveBeenCalledWith('  Normalized\nManual Name  ', 'manual');
      expect(JSON.parse(response.body)).toMatchObject({
        ok: true,
        name: 'Normalized Manual Name',
      });
    });

    it.each([51, 200])('accepts a manual name containing %i characters', async (length) => {
      const name = 'M'.repeat(length);
      const setName = vi.fn().mockReturnValue(name);
      (deps.core.sessionManager.getSession as any).mockReturnValue(createMockSession({ setName }));

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/sessions/sess-1',
        payload: { name },
      });

      expect(response.statusCode).toBe(200);
      expect(setName).toHaveBeenCalledWith(name, 'manual');
      expect(JSON.parse(response.body)).toMatchObject({ ok: true, name });
    });

    it('rejects a manual name exceeding 200 characters', async () => {
      const setName = vi.fn();
      (deps.core.sessionManager.getSession as any).mockReturnValue(createMockSession({ setName }));

      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/sessions/sess-1',
        payload: { name: 'M'.repeat(201) },
      });

      expect(response.statusCode).toBe(400);
      expect(setName).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /api/v1/sessions/:sessionId/dangerous', () => {
    it('toggles bypass permissions', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/sessions/sess-1/dangerous',
        payload: { enabled: true },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.dangerousMode).toBe(true);
    });
  });

  describe('POST /api/v1/sessions/:sessionId/archive', () => {
    it('archives a session', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/archive',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.ok).toBe(true);
    });

    it('returns 400 on archive failure', async () => {
      (deps.core.archiveSession as any).mockResolvedValue({
        ok: false,
        error: 'Not supported',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/archive',
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/v1/sessions/:sessionId/config', () => {
    it('returns configOptions and clientOverrides', async () => {
      const configOptions = [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'code',
          options: [{ value: 'code', label: 'Code' }, { value: 'architect', label: 'Architect' }],
        },
      ];
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({
          configOptions,
          clientOverrides: { bypassPermissions: true },
        }),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/sess-1/config',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.configOptions).toEqual(configOptions);
      expect(body.clientOverrides).toEqual({ bypassPermissions: true });
    });

    it('returns 404 for unknown session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(null);
      (deps.core.sessionManager.getSessionRecord as any).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/unknown/config',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /api/v1/sessions/:sessionId/config/:configId', () => {
    it('sets config option and returns full state', async () => {
      const updatedConfigOptions = [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'architect',
          options: [{ value: 'code', label: 'Code' }, { value: 'architect', label: 'Architect' }],
        },
      ];
      const mockSessionSetConfigOption = vi.fn().mockResolvedValue({
        acknowledged: true,
        authoritative: true,
        effective: updatedConfigOptions[0],
      });
      const session = createMockSession({
        configOptions: updatedConfigOptions,
        clientOverrides: { bypassPermissions: false },
        setConfigOption: mockSessionSetConfigOption,
        toAcpStateSnapshot: vi.fn().mockReturnValue({ configOptions: updatedConfigOptions }),
      });
      // Make setConfigOption update configOptions on the session
      mockSessionSetConfigOption.mockImplementation(async () => {
        session.configOptions = updatedConfigOptions;
        return {
          acknowledged: true,
          authoritative: true,
          effective: updatedConfigOptions[0],
          revision: 1,
          configOptions: structuredClone(updatedConfigOptions),
        };
      });
      (deps.core.sessionManager.getSession as any).mockReturnValue(session);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/sessions/sess-1/config/mode',
        payload: { value: 'architect' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.configOptions).toEqual(updatedConfigOptions);
      expect(body.clientOverrides).toEqual({ bypassPermissions: false });
      expect(mockSessionSetConfigOption).toHaveBeenCalledWith('mode', { type: 'select', value: 'architect' });
      expect(deps.core.sessionManager.patchRecord).toHaveBeenCalled();
    });

    it('returns and persists each concurrent mutation by its FIFO revision', async () => {
      const original = {
        id: 'mode', name: 'Mode', category: 'mode', type: 'select' as const, currentValue: 'code',
        options: [{ value: 'code', name: 'Code' }, { value: 'architect', name: 'Architect' }],
      };
      const architect = { ...original, currentValue: 'architect' };
      const code = { ...original, currentValue: 'code' };
      let resolveFirst!: (value: { configOptions: Array<typeof architect> }) => void;
      const agent = Object.assign(new TypedEmitter(), {
        sessionId: 'agent-config-fifo',
        prompt: vi.fn().mockResolvedValue({ stopReason: 'end_turn' }),
        cancel: vi.fn().mockResolvedValue(undefined),
        destroy: vi.fn().mockResolvedValue(undefined),
        setConfigOption: vi.fn()
          .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
          .mockResolvedValueOnce({ configOptions: [code] }),
        onPermissionRequest: vi.fn(),
      }) as any;
      const session = new Session({
        id: 'sess-1', channelId: 'api', agentName: 'claude', workingDirectory: '/tmp/test', agentInstance: agent,
      });
      session.setInitialConfigOptions([original]);
      session.clientOverrides = { bypassPermissions: false };
      (deps.core.sessionManager.getSession as any).mockReturnValue(session);
      let persisted: unknown = undefined;
      (deps.core.sessionManager.patchRecord as any).mockImplementation(async (_id: string, patch: any, options: any) => {
        if (options.expectedConfigRevision === session.configRevision) persisted = patch.acpState?.configOptions;
      });

      const first = app.inject({
        method: 'PUT', url: '/api/v1/sessions/sess-1/config/mode', payload: { value: 'architect' },
      });
      const second = app.inject({
        method: 'PUT', url: '/api/v1/sessions/sess-1/config/mode', payload: { value: 'code' },
      });
      await vi.waitFor(() => expect(agent.setConfigOption).toHaveBeenCalledOnce());
      resolveFirst({ configOptions: [architect] });
      const [firstResponse, secondResponse] = await Promise.all([first, second]);

      expect(firstResponse.statusCode).toBe(200);
      expect(secondResponse.statusCode).toBe(200);
      expect(firstResponse.json().configOptions[0]).toMatchObject({ currentValue: 'architect' });
      expect(secondResponse.json().configOptions[0]).toMatchObject({ currentValue: 'code' });
      expect(session.getConfigValue('mode')).toBe('code');
      expect(persisted).toEqual([code]);
      const patchCalls = (deps.core.sessionManager.patchRecord as any).mock.calls;
      expect(patchCalls[0][2].expectedConfigRevision).toBeLessThan(patchCalls[1][2].expectedConfigRevision);
    });

    it('returns a bounded rejection and does not persist when the agent did not acknowledge the change', async () => {
      const originalConfigOptions = [
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'code',
          options: [{ value: 'code', label: 'Code' }, { value: 'architect', label: 'Architect' }],
        },
      ];
      const session = createMockSession({
        configOptions: originalConfigOptions,
        setConfigOption: vi.fn().mockResolvedValue({
          acknowledged: false,
          authoritative: false,
          effective: originalConfigOptions[0],
          reason: 'blocked',
          message: 'Configuration change was blocked by policy.',
        }),
      });
      (deps.core.sessionManager.getSession as any).mockReturnValue(session);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/sessions/sess-1/config/mode',
        payload: { value: 'architect' },
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body)).toMatchObject({
        error: { code: 'CONFIG_CHANGE_REJECTED', message: 'Configuration change was blocked by policy.' },
      });
      expect(session.configOptions).toEqual(originalConfigOptions);
      expect(deps.core.sessionManager.patchRecord).not.toHaveBeenCalled();
    });

    it('returns 404 for unknown session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(null);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/sessions/unknown/config/mode',
        payload: { value: 'code' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/v1/sessions/:sessionId/config/overrides', () => {
    it('returns clientOverrides', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(
        createMockSession({ clientOverrides: { bypassPermissions: true } }),
      );

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/sess-1/config/overrides',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.clientOverrides).toEqual({ bypassPermissions: true });
    });

    it('returns 404 for unknown session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(null);
      (deps.core.sessionManager.getSessionRecord as any).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/unknown/config/overrides',
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('PUT /api/v1/sessions/:sessionId/config/overrides', () => {
    it('sets bypassPermissions and persists', async () => {
      const session = createMockSession({ clientOverrides: { bypassPermissions: false } });
      (deps.core.sessionManager.getSession as any).mockReturnValue(session);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/sessions/sess-1/config/overrides',
        payload: { bypassPermissions: true },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.clientOverrides).toEqual({ bypassPermissions: true });
      expect(session.clientOverrides.bypassPermissions).toBe(true);
      expect(deps.core.sessionManager.patchRecord).toHaveBeenCalledWith('sess-1', {
        clientOverrides: { bypassPermissions: true },
      });
    });

    it('merges overrides instead of replacing entirely', async () => {
      const session = createMockSession({ clientOverrides: { bypassPermissions: true } });
      (deps.core.sessionManager.getSession as any).mockReturnValue(session);

      // Send an empty body (no bypassPermissions key) — should not clear existing value
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/sessions/sess-1/config/overrides',
        payload: {},
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // bypassPermissions should still be true since we didn't send it
      expect(body.clientOverrides.bypassPermissions).toBe(true);
    });

    it('returns 404 for unknown session', async () => {
      (deps.core.sessionManager.getSession as any).mockReturnValue(null);

      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/sessions/unknown/config/overrides',
        payload: { bypassPermissions: true },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('ACP form elicitation routes', () => {
    const formRequest = {
      id: 'input-1',
      sessionId: 'sess-1',
      turnId: 'turn-1',
      mode: 'form' as const,
      message: 'Choose',
      requestedSchema: {
        type: 'object' as const,
        properties: { answer: { type: 'string' as const, enum: ['yes', 'no'] } },
        required: ['answer'],
      },
      owner: { adapterId: 'api', userId: 'api-master', apiCredential: 'secret' as const },
    };

    it('lists sanitized pending requests and accepts a valid response without echoing content', async () => {
      const session = deps.core.sessionManager.getSession('sess-1') as any;
      const pending = session.elicitationGate.request(formRequest);

      const list = await app.inject({ method: 'GET', url: '/api/v1/sessions/sess-1/elicitation' });
      expect(list.statusCode).toBe(200);
      expect(list.json().requests).toEqual([
        expect.objectContaining({ id: 'input-1', message: 'Choose' }),
      ]);
      expect(list.json().requests[0].owner).toBeUndefined();

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/elicitation/input-1',
        payload: { action: 'accept', content: { answer: 'yes' } },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, requestId: 'input-1', action: 'accept' });
      expect(response.body).not.toContain('yes');
      await expect(pending).resolves.toEqual({ action: 'accept', content: { answer: 'yes' } });
    });

    it('polls only requests owned by the authenticated principal', async () => {
      const session = deps.core.sessionManager.getSession('sess-1') as any;
      const pending = session.elicitationGate.request({
        ...formRequest,
        id: 'owned-poll',
        owner: {
          adapterId: 'api',
          userId: 'owner-token',
          canonicalUserId: 'owner-user',
          apiCredential: 'jwt' as const,
          apiTokenId: 'owner-token',
        },
      });

      const attacker = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/sess-1/elicitation',
        headers: { 'x-test-auth': 'jwt:attacker-token:attacker-user' },
      });
      expect(attacker.statusCode).toBe(200);
      expect(attacker.json()).toEqual({ requests: [] });

      const owner = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions/sess-1/elicitation',
        headers: { 'x-test-auth': 'jwt:peer-token:owner-user' },
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json().requests).toEqual([
        expect.objectContaining({ id: 'owned-poll', message: 'Choose' }),
      ]);
      expect(owner.json().requests[0].owner).toBeUndefined();
      session.elicitationGate.cancel('owned-poll');
      await expect(pending).resolves.toEqual({ action: 'cancel' });
    });

    it('keeps the request pending after invalid content and rejects a duplicate response', async () => {
      const session = deps.core.sessionManager.getSession('sess-1') as any;
      const pending = session.elicitationGate.request({ ...formRequest, id: 'input-2' });

      const invalid = await app.inject({
        method: 'POST',
        url: '/api/v1/sessions/sess-1/elicitation/input-2',
        payload: { action: 'accept', content: { answer: 'invalid' } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(session.elicitationGate.get('input-2')).toBeDefined();

      const decline = await app.inject({
        method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/input-2', payload: { action: 'decline' },
      });
      expect(decline.statusCode).toBe(200);
      await expect(pending).resolves.toEqual({ action: 'decline' });

      const duplicate = await app.inject({
        method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/input-2', payload: { action: 'cancel' },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it.each(['accept', 'decline', 'cancel'] as const)(
      'rejects a different JWT before the %s action can settle the request',
      async (action) => {
        const session = deps.core.sessionManager.getSession('sess-1') as any;
        const id = `owned-${action}`;
        const pending = session.elicitationGate.request({
          ...formRequest,
          id,
          owner: {
            adapterId: 'api',
            userId: 'token-owner',
            canonicalUserId: 'user-owner',
            apiCredential: 'jwt' as const,
            apiTokenId: 'token-owner',
          },
        });
        const payload = action === 'accept'
          ? { action, content: { answer: 'yes' } }
          : { action };

        const rejected = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/sess-1/elicitation/${id}`,
          headers: { 'x-test-auth': 'jwt:token-attacker:user-attacker' },
          payload,
        });
        expect(rejected.statusCode).toBe(403);
        expect(session.elicitationGate.get(id)).toBeDefined();

        const accepted = await app.inject({
          method: 'POST',
          url: `/api/v1/sessions/sess-1/elicitation/${id}`,
          headers: { 'x-test-auth': 'jwt:token-peer:user-owner' },
          payload,
        });
        expect(accepted.statusCode).toBe(200);
        expect(accepted.body).not.toContain('yes');
        await expect(pending).resolves.toEqual(payload);
      },
    );

    it('allows only the same token for an unlinked JWT, with master secret as explicit override', async () => {
      const session = deps.core.sessionManager.getSession('sess-1') as any;
      const sameTokenPending = session.elicitationGate.request({
        ...formRequest,
        id: 'unlinked-same-token',
        owner: { adapterId: 'api', userId: 'token-owner', apiCredential: 'jwt' as const, apiTokenId: 'token-owner' },
      });
      const wrongToken = await app.inject({
        method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/unlinked-same-token',
        headers: { 'x-test-auth': 'jwt:token-other' }, payload: { action: 'cancel' },
      });
      expect(wrongToken.statusCode).toBe(403);
      const sameToken = await app.inject({
        method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/unlinked-same-token',
        headers: { 'x-test-auth': 'jwt:token-owner' }, payload: { action: 'cancel' },
      });
      expect(sameToken.statusCode).toBe(200);
      await expect(sameTokenPending).resolves.toEqual({ action: 'cancel' });

      const masterPending = session.elicitationGate.request({
        ...formRequest,
        id: 'master-override',
        owner: { adapterId: 'api', userId: 'token-owner', apiCredential: 'jwt' as const, apiTokenId: 'token-owner' },
      });
      const master = await app.inject({
        method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/master-override',
        payload: { action: 'decline' },
      });
      expect(master.statusCode).toBe(200);
      await expect(masterPending).resolves.toEqual({ action: 'decline' });
    });

    it('does not let an unrelated JWT win a concurrent response race', async () => {
      const session = deps.core.sessionManager.getSession('sess-1') as any;
      const pending = session.elicitationGate.request({
        ...formRequest,
        id: 'owned-race',
        owner: {
          adapterId: 'api',
          userId: 'token-owner',
          canonicalUserId: 'user-owner',
          apiCredential: 'jwt' as const,
          apiTokenId: 'token-owner',
        },
      });
      const [attacker, owner] = await Promise.all([
        app.inject({
          method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/owned-race',
          headers: { 'x-test-auth': 'jwt:token-attacker:user-attacker' }, payload: { action: 'cancel' },
        }),
        app.inject({
          method: 'POST', url: '/api/v1/sessions/sess-1/elicitation/owned-race',
          headers: { 'x-test-auth': 'jwt:token-owner:user-owner' },
          payload: { action: 'accept', content: { answer: 'yes' } },
        }),
      ]);
      expect(attacker.statusCode).toBe(403);
      expect(owner.statusCode).toBe(200);
      await expect(pending).resolves.toEqual({ action: 'accept', content: { answer: 'yes' } });
    });
  });

  describe('DELETE /api/v1/sessions/:sessionId', () => {
    it('cancels a session', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/sessions/sess-1',
      });

      expect(response.statusCode).toBe(200);
      expect(deps.core.sessionManager.cancelSession).toHaveBeenCalledWith(
        'sess-1',
      );
      expect(response.json()).toEqual({
        ok: true,
        sessionId: 'sess-1',
        cancelled: true,
        previousStatus: 'initializing',
        status: 'cancelled',
        alreadyTerminal: false,
      });
    });

    it('returns 404 for unknown session', async () => {
      const notFound = Object.assign(new Error('not found'), { code: 'SESSION_NOT_FOUND' });
      (deps.core.sessionManager.cancelSession as any).mockRejectedValue(notFound);

      const response = await app.inject({
        method: 'DELETE',
        url: '/api/v1/sessions/unknown',
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns bounded cleanupPending and reuses the same ACP teardown on retry', async () => {
      vi.useFakeTimers();
      try {
        let finishDestroy!: () => void;
        const agent = Object.assign(new TypedEmitter(), {
          sessionId: 'agent-bounded',
          prompt: vi.fn(() => new Promise<void>(() => {})),
          cancel: vi.fn(() => new Promise<void>(() => {})),
          destroy: vi.fn(() => new Promise<void>((resolve) => { finishDestroy = resolve; })),
          onPermissionRequest: vi.fn(),
        }) as any;
        const session = new Session({
          id: 'bounded-http',
          channelId: 'api',
          agentName: 'claude',
          workingDirectory: '/tmp/test',
          agentInstance: agent,
        });
        session.name = 'skip-autoname';
        const manager = new SessionManager(null);
        manager.registerSession(session);
        deps.core.sessionManager = manager as any;

        const prompt = session.enqueuePrompt('never settles');
        await vi.waitFor(() => expect(agent.prompt).toHaveBeenCalledOnce());
        const firstResponse = app.inject({
          method: 'DELETE',
          url: '/api/v1/sessions/bounded-http',
        });

        await vi.advanceTimersByTimeAsync(9_000);
        const first = await firstResponse;
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({
          ok: true,
          sessionId: 'bounded-http',
          cancelled: true,
          cleanupPending: true,
        });
        expect(agent.cancel).toHaveBeenCalledOnce();
        expect(agent.destroy).toHaveBeenCalledOnce();

        finishDestroy();
        const retryResponse = app.inject({
          method: 'DELETE',
          url: '/api/v1/sessions/bounded-http',
        });
        await vi.advanceTimersByTimeAsync(1_000);
        const retry = await retryResponse;
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toMatchObject({
          cancelled: false,
          alreadyTerminal: true,
          cleanupPending: false,
        });
        expect(agent.cancel).toHaveBeenCalledOnce();
        expect(agent.destroy).toHaveBeenCalledOnce();
        expect(manager.getSession(session.id)).toBeUndefined();

        await prompt;
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('API prompt principal mapping', () => {
  it('maps the master secret without inventing a connector identity', () => {
    const request = { auth: { type: 'secret', role: 'admin', scopes: ['*'] } } as any;
    expect(apiMessagePrincipal(request)).toEqual({ type: 'api', credential: 'secret' });
    expect(apiPlatformUserId(request)).toBe('api-master');
  });

  it.each([
    [{ type: 'jwt', tokenId: 'token-1', role: 'operator', scopes: ['sessions:prompt'] }, undefined],
    [{ type: 'jwt', tokenId: 'token-1', userId: 'user-1', role: 'operator', scopes: ['sessions:prompt'] }, 'user-1'],
  ])('maps linked and unlinked JWT identity explicitly', (auth, linkedUserId) => {
    const request = { auth } as any;
    expect(apiMessagePrincipal(request)).toEqual({
      type: 'api',
      credential: 'jwt',
      tokenId: 'token-1',
      linkedUserId,
    });
    expect(apiPlatformUserId(request)).toBe('token-1');
  });
});
