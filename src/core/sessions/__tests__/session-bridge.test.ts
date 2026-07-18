import { describe, it, expect, vi, beforeEach } from "vitest";
import { SessionBridge } from "../session-bridge.js";
import { Session } from "../session.js";
import type { AgentInstance } from "../../agents/agent-instance.js";
import type { IChannelAdapter } from "../../channel.js";
import type { MessageTransformer } from "../../message-transformer.js";
import type { NotificationManager } from "../../../plugins/notifications/notification.js";
import { SessionManager } from "../session-manager.js";
import type { AgentEvent } from "../../types.js";
import { TypedEmitter } from "../../utils/typed-emitter.js";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hook } from '../../events.js';
import { JsonFileSessionStore } from '../session-store.js';

function createMockAgentInstance(): AgentInstance {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>();
  return Object.assign(emitter, {
    sessionId: "agent-session-1",
    agentName: "test-agent",
    prompt: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: vi.fn(),
  }) as unknown as AgentInstance;
}

function createMockAdapter(): IChannelAdapter {
  return {
    name: 'test',
    capabilities: { streaming: false, richFormatting: false, threads: false, reactions: false, fileUpload: false, voice: false },
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPermissionRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    sendSkillCommands: vi.fn().mockResolvedValue(undefined),
    cleanupSkillCommands: vi.fn().mockResolvedValue(undefined),
    renameSessionThread: vi.fn().mockResolvedValue(undefined),
    createSessionThread: vi.fn().mockResolvedValue("thread-1"),
    deleteSessionThread: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  } as unknown as IChannelAdapter;
}

function createMockDeps() {
  return {
    messageTransformer: {
      transform: vi.fn().mockReturnValue({ type: "text", text: "transformed" }),
    } as unknown as MessageTransformer,
    notificationManager: {
      notify: vi.fn().mockResolvedValue(undefined),
      notifyAll: vi.fn().mockResolvedValue(undefined),
    } as unknown as NotificationManager,
    sessionManager: {
      patchRecord: vi.fn().mockResolvedValue(undefined),
      updateSessionStatus: vi.fn().mockResolvedValue(undefined),
      getSessionRecord: vi.fn().mockReturnValue(undefined),
    } as unknown as SessionManager,
  };
}

function createSession(
  agentInstance?: AgentInstance,
): Session {
  return new Session({
    channelId: "test-channel",
    agentName: "test-agent",
    workingDirectory: "/tmp/test",
    agentInstance: agentInstance ?? createMockAgentInstance(),
  });
}

describe("SessionBridge", () => {
  let agent: AgentInstance;
  let session: Session;
  let adapter: IChannelAdapter;
  let deps: ReturnType<typeof createMockDeps>;
  let bridge: SessionBridge;

  beforeEach(() => {
    agent = createMockAgentInstance();
    session = createSession(agent);
    adapter = createMockAdapter();
    deps = createMockDeps();
    bridge = new SessionBridge(session, adapter, deps);
  });

  describe("connect()", () => {
    it("wires agentInstance agent_event emitter to session events", () => {
      bridge.connect();

      // Trigger agent event via the callback
      const event: AgentEvent = { type: "text", content: "hello" };
      agent.emit('agent_event', event);

      // Should have been transformed and sent to adapter
      expect(deps.messageTransformer.transform).toHaveBeenCalledWith(
        event,
        expect.objectContaining({ id: session.id }),
      );
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        session.id,
        { type: "text", text: "transformed" },
      );
    });

    it("routes text/thought/tool_call/tool_update/plan/usage to adapter.sendMessage", () => {
      bridge.connect();

      const eventTypes: AgentEvent["type"][] = [
        "text",
        "thought",
        "plan",
        "usage",
      ];

      for (const type of eventTypes) {
        let event: AgentEvent;
        if (type === "text" || type === "thought") {
          event = { type, content: "test" };
        } else if (type === "plan") {
          event = { type, entries: [] };
        } else {
          event = { type: "usage", tokensUsed: 100 };
        }
        agent.emit('agent_event', event);
      }

      expect(adapter.sendMessage).toHaveBeenCalledTimes(4);
    });

    it("routes commands_update to adapter.sendSkillCommands", () => {
      bridge.connect();

      const commands = [{ name: "/test", description: "test", input: undefined }];
      agent.emit('agent_event', { type: "commands_update", commands });

      expect(adapter.sendSkillCommands).toHaveBeenCalledWith(
        session.id,
        commands,
      );
    });

    it("replays a safe command snapshot published before Session construction", () => {
      const commands = [{ name: "skills", description: "List available skills." }];
      Object.assign(agent, {
        latestCommands: commands,
        latestSkillNames: ["atcode"],
        skillInventoryReady: true,
        skillDiscoveryStrategy: "dollar-prefixed",
      });
      session = createSession(agent);
      bridge = new SessionBridge(session, adapter, deps);

      bridge.connect();

      expect(session.latestSkillNames).toEqual(["atcode"]);
      expect(adapter.sendSkillCommands).toHaveBeenCalledWith(session.id, commands);
    });

    it("clears stale connector commands when a resumed agent has no fresh snapshot", () => {
      bridge.connect();

      expect(adapter.sendSkillCommands).toHaveBeenCalledWith(session.id, []);
    });

    it("handles session_end: finish session + cleanup + notify", async () => {
      bridge.connect();
      session.activate();

      agent.emit('agent_event', { type: "session_end", reason: "done" });

      expect(session.status).toBe("finished");
      await vi.waitFor(() => {
        expect(adapter.cleanupSkillCommands).toHaveBeenCalledWith(session.id);
        expect(adapter.sendMessage).toHaveBeenCalled();
        expect(deps.notificationManager.notify).toHaveBeenCalledWith(
          session.channelId,
          expect.objectContaining({ type: "completed" }),
        );
      });
    });

    it("handles error: update status + cleanup + notify", () => {
      bridge.connect();
      session.activate();

      agent.emit('agent_event', { type: "error", message: "crash" });

      expect(session.status).toBe("error");
      expect(adapter.cleanupSkillCommands).toHaveBeenCalledWith(session.id);
      expect(deps.notificationManager.notify).toHaveBeenCalledWith(
        session.channelId,
        expect.objectContaining({ type: "error" }),
      );
    });

    it('keeps the session active and routes a visible warning when STT falls back to audio', async () => {
      const speech = {
        isSTTAvailable: vi.fn().mockReturnValue(true),
        transcribe: vi.fn().mockRejectedValue(new Error('runtime <unavailable>')),
      } as any;
      session = new Session({
        channelId: 'telegram', agentName: 'test-agent', workingDirectory: '/tmp/test',
        agentInstance: agent, speechService: speech,
      });
      session.name = 'skip-auto-name';
      bridge = new SessionBridge(session, adapter, deps);
      bridge.connect();
      const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue(Buffer.from('ogg audio'));
      const attachment = {
        type: 'audio' as const, filePath: '/tmp/voice.ogg', fileName: 'voice.ogg',
        mimeType: 'audio/ogg', size: 1000,
      };

      try {
        await session.enqueuePrompt('[Audio: voice.ogg]', [attachment]);

        expect(agent.prompt).toHaveBeenCalledWith('[Audio: voice.ogg]', [attachment]);
        expect(session.status).toBe('active');
        expect(deps.messageTransformer.transform).toHaveBeenCalledWith(expect.objectContaining({
          type: 'system_message',
          message: expect.stringContaining('Voice transcription failed'),
        }));
        expect(adapter.sendMessage).toHaveBeenCalled();
        expect(adapter.cleanupSkillCommands).not.toHaveBeenCalled();
        expect(deps.notificationManager.notify).not.toHaveBeenCalled();
      } finally {
        readFileSpy.mockRestore();
      }
    });
  });

  describe("terminal delivery barrier", () => {
    function createTerminalHarness(options?: {
      rejectSecondSend?: boolean;
      middleware?: any;
      secondSend?: Promise<void>;
      secondCleanup?: Promise<void>;
      notification?: Promise<void>;
    }) {
      const records = new Map<string, any>();
      const store = {
        save: vi.fn(async (record: any) => { records.set(record.sessionId, structuredClone(record)); }),
        flush: vi.fn(),
        get: vi.fn((id: string) => records.get(id)),
        findByPlatform: vi.fn(),
        findByAgentSessionId: vi.fn(),
        findAssistant: vi.fn(),
        list: vi.fn(() => [...records.values()]),
        remove: vi.fn(async (id: string) => { records.delete(id); }),
      };
      const manager = new SessionManager(store as any);
      const agent = createMockAgentInstance();
      const session = createSession(agent);
      session.activate();
      manager.registerSession(session);
      void store.save({
        sessionId: session.id,
        agentSessionId: agent.sessionId,
        agentName: session.agentName,
        workingDir: session.workingDirectory,
        channelId: session.channelId,
        status: 'active',
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: new Date().toISOString(),
        clientOverrides: {},
        platform: {},
      });

      const firstAdapter = createMockAdapter();
      const secondAdapter = createMockAdapter();
      Object.defineProperty(firstAdapter, 'name', { value: 'first' });
      Object.defineProperty(secondAdapter, 'name', { value: 'second' });
      if (options?.rejectSecondSend) {
        vi.mocked(secondAdapter.sendMessage).mockRejectedValue(new Error('adapter failed'));
      }
      if (options?.secondSend) {
        vi.mocked(secondAdapter.sendMessage).mockReturnValue(options.secondSend);
      }
      if (options?.secondCleanup) {
        vi.mocked(secondAdapter.cleanupSkillCommands!).mockReturnValue(options.secondCleanup);
      }
      const eventBus = { emit: vi.fn() };
      const notifications = {
        notify: vi.fn().mockImplementation(() => options?.notification ?? Promise.resolve()),
        notifyAll: vi.fn().mockResolvedValue(undefined),
      };
      const bridgeDeps = {
        messageTransformer: {
          transform: vi.fn().mockReturnValue({ type: 'session_end', text: 'complete' }),
        } as any,
        notificationManager: notifications as any,
        sessionManager: manager,
        eventBus: eventBus as any,
        middlewareChain: options?.middleware,
      };
      const firstBridge = new SessionBridge(session, firstAdapter, bridgeDeps, 'first');
      const secondBridge = new SessionBridge(session, secondAdapter, bridgeDeps, 'second');
      const registry = new Map([
        ['first', firstBridge],
        ['second', secondBridge],
      ]);
      manager.setSessionResourceCleanup(() => {
        for (const owned of registry.values()) owned.disconnect();
        registry.clear();
      });
      firstBridge.connect();
      secondBridge.connect();
      return {
        agent, session, manager, store, firstAdapter, secondAdapter,
        firstBridge, secondBridge, registry, eventBus, notifications,
      };
    }

    it("delivers once to every connected bridge after async outgoing middleware, then clears ownership", async () => {
      let releaseOutgoing!: () => void;
      const outgoingGate = new Promise<void>((resolve) => { releaseOutgoing = resolve; });
      const middleware = {
        execute: vi.fn(async (hook: string, payload: any) => {
          if (hook === Hook.MESSAGE_OUTGOING) await outgoingGate;
          return payload;
        }),
      };
      const harness = createTerminalHarness({ middleware });

      harness.agent.emit('agent_event', { type: 'session_end', reason: 'done' });
      await vi.waitFor(() => expect(
        middleware.execute.mock.calls.filter(([hook]: [string]) => hook === Hook.MESSAGE_OUTGOING),
      ).toHaveLength(2));
      expect(harness.registry.size).toBe(2);
      expect(harness.firstAdapter.sendMessage).not.toHaveBeenCalled();
      expect(harness.secondAdapter.sendMessage).not.toHaveBeenCalled();

      releaseOutgoing();
      await vi.waitFor(() => expect(harness.registry.size).toBe(0));
      expect(harness.firstAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.secondAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.notifications.notify).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(harness.agent.destroy).toHaveBeenCalledOnce());
      expect(harness.manager.getSession(harness.session.id)).toBeUndefined();
      expect(harness.store.get(harness.session.id)).toMatchObject({ status: 'finished' });

      harness.agent.emit('agent_event', { type: 'session_end', reason: 'duplicate' });
      await Promise.resolve();
      expect(harness.firstAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.secondAdapter.sendMessage).toHaveBeenCalledTimes(1);
    });

    it("keeps cleanup bounded when one terminal adapter send rejects", async () => {
      const harness = createTerminalHarness({ rejectSecondSend: true });
      harness.agent.emit('agent_event', { type: 'session_end', reason: 'done' });

      await vi.waitFor(() => expect(harness.registry.size).toBe(0));
      expect(harness.firstAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.secondAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.session.status).toBe('finished');
    });

    it("preserves the finished winner when cancellation races async final delivery", async () => {
      let releaseOutgoing!: () => void;
      const outgoingGate = new Promise<void>((resolve) => { releaseOutgoing = resolve; });
      const middleware = {
        execute: vi.fn(async (hook: string, payload: any) => {
          if (hook === Hook.MESSAGE_OUTGOING) await outgoingGate;
          return payload;
        }),
      };
      const harness = createTerminalHarness({ middleware });
      harness.agent.emit('agent_event', { type: 'session_end', reason: 'done' });
      await vi.waitFor(() => expect(harness.session.status).toBe('finished'));
      await vi.waitFor(() => expect(
        middleware.execute.mock.calls.filter(([hook]: [string]) => hook === Hook.MESSAGE_OUTGOING),
      ).toHaveLength(2));

      const cancelling = harness.manager.cancelSession(harness.session.id);
      expect(harness.registry.size).toBe(2);
      releaseOutgoing();
      const result = await cancelling;

      expect(result).toMatchObject({ status: 'finished', alreadyTerminal: true });
      expect(harness.firstAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.secondAdapter.sendMessage).toHaveBeenCalledTimes(1);
      expect(harness.registry.size).toBe(0);
    });

    it.each(['middleware', 'cleanup', 'send', 'notification'] as const)(
      'bounds a never-settling terminal %s step and clears both bridge owners',
      async (step) => {
        vi.useFakeTimers();
        try {
          const never = new Promise<void>(() => {});
          let outgoingCalls = 0;
          const middleware = step === 'middleware'
            ? {
                execute: vi.fn(async (hook: string, payload: any) => {
                  if (hook === Hook.MESSAGE_OUTGOING && outgoingCalls++ === 1) await never;
                  return payload;
                }),
              }
            : undefined;
          const harness = createTerminalHarness({
            middleware,
            secondCleanup: step === 'cleanup' ? never : undefined,
            secondSend: step === 'send' ? never : undefined,
            notification: step === 'notification' ? never : undefined,
          });
          harness.agent.emit('agent_event', { type: 'session_end', reason: 'done' });
          await vi.advanceTimersByTimeAsync(0);
          expect(harness.registry.size).toBeGreaterThan(0);

          await vi.advanceTimersByTimeAsync(5000);
          await Promise.resolve();
          expect(harness.registry.size).toBe(0);
          expect(harness.session.terminalDeliveryFailure).toContain('Terminal');
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("keeps cancel bounded when one bridge send never settles", async () => {
      vi.useFakeTimers();
      try {
        const never = new Promise<void>(() => {});
        const harness = createTerminalHarness({ secondSend: never });
        harness.agent.emit('agent_event', { type: 'session_end', reason: 'done' });
        await vi.advanceTimersByTimeAsync(0);
        expect(harness.secondAdapter.sendMessage).toHaveBeenCalledOnce();

        const cancelling = harness.manager.cancelSession(harness.session.id);
        await vi.advanceTimersByTimeAsync(5000);
        const result = await cancelling;
        expect(result).toMatchObject({
          status: 'finished',
          cleanupPending: false,
          warning: expect.stringContaining('final channel delivery did not complete'),
        });
        expect(harness.registry.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shutdown aborts pending final middleware without later send or notification", async () => {
      let releaseOutgoing!: () => void;
      const outgoingGate = new Promise<void>((resolve) => { releaseOutgoing = resolve; });
      const middleware = {
        execute: vi.fn(async (hook: string, payload: any) => {
          if (hook === Hook.MESSAGE_OUTGOING) await outgoingGate;
          return payload;
        }),
      };
      const harness = createTerminalHarness({ middleware });
      harness.agent.emit('agent_event', { type: 'session_end', reason: 'done' });
      await vi.waitFor(() => expect(
        middleware.execute.mock.calls.filter(([hook]: [string]) => hook === Hook.MESSAGE_OUTGOING),
      ).toHaveLength(2));

      await harness.manager.shutdownAll();
      expect(harness.registry.size).toBe(0);
      releaseOutgoing();
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.firstAdapter.sendMessage).not.toHaveBeenCalled();
      expect(harness.secondAdapter.sendMessage).not.toHaveBeenCalled();
      expect(harness.notifications.notify).not.toHaveBeenCalled();
    });

    it("does not start a deferred terminal adapter send after immediate disconnect", async () => {
      const harness = createTerminalHarness();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const generation = harness.session.beginTerminalDelivery('done');
        expect(generation).not.toBeNull();
        const pending = (harness.firstBridge as any).awaitTerminalStep(
          'adapter send',
          generation,
          () => harness.firstAdapter.sendMessage(harness.session.id, { type: 'session_end', text: 'done' }),
        ) as Promise<void>;
        const observed = pending.then(
          () => ({ status: 'fulfilled' as const, error: undefined }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

        harness.firstBridge.disconnect();
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.firstAdapter.sendMessage).not.toHaveBeenCalled();
        const outcome = await observed;
        expect(outcome.status).toBe('rejected');
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toContain('superseded');
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
        harness.secondBridge.disconnect();
      }
    });

    it("does not start a deferred terminal notification after immediate shutdown", async () => {
      const harness = createTerminalHarness();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const generation = harness.session.beginTerminalDelivery('done');
        expect(generation).not.toBeNull();
        const pending = (harness.firstBridge as any).awaitTerminalStep(
          'notification',
          generation,
          () => harness.notifications.notify(harness.session.channelId, {
            sessionId: harness.session.id,
            type: 'completed',
          }),
        ) as Promise<void>;
        const observed = pending.then(
          () => ({ status: 'fulfilled' as const, error: undefined }),
          (error: unknown) => ({ status: 'rejected' as const, error }),
        );

        const shuttingDown = harness.manager.shutdownAll();
        await Promise.resolve();
        await Promise.resolve();

        expect(harness.notifications.notify).not.toHaveBeenCalled();
        const outcome = await observed;
        expect(outcome.status).toBe('rejected');
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toContain('superseded');
        await shuttingDown;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(harness.registry.size).toBe(0);
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it("aborts an ENOSPC final-delivery generation and lets later cancel durably finish cleanup", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-terminal-barrier-enospc-'));
      const filePath = path.join(tmpDir, 'sessions.json');
      const store = new JsonFileSessionStore(filePath, 30);
      try {
        const manager = new SessionManager(store);
        const agent = createMockAgentInstance();
        const session = createSession(agent);
        session.activate();
        manager.registerSession(session);
        await store.save({
          sessionId: session.id,
          agentSessionId: agent.sessionId,
          agentName: session.agentName,
          workingDir: session.workingDirectory,
          channelId: session.channelId,
          status: 'active',
          createdAt: session.createdAt.toISOString(),
          lastActiveAt: new Date().toISOString(),
          clientOverrides: {},
          platform: {},
        });
        store.flush();
        const adapter = createMockAdapter();
        const deps = {
          messageTransformer: { transform: vi.fn().mockReturnValue({ type: 'session_end', text: 'done' }) } as any,
          notificationManager: { notify: vi.fn().mockResolvedValue(undefined) } as any,
          sessionManager: manager,
        };
        const bridge = new SessionBridge(session, adapter, deps);
        const registry = new Map([['bridge', bridge]]);
        manager.setSessionResourceCleanup(() => {
          for (const owned of registry.values()) owned.disconnect();
          registry.clear();
        });
        bridge.connect();
        const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
          throw new Error('ENOSPC final durability');
        });

        agent.emit('agent_event', { type: 'session_end', reason: 'done' });
        await vi.waitFor(() => expect(registry.size).toBe(0));
        write.mockRestore();
        expect(session.status).toBe('finished');
        expect(store.get(session.id)?.status).toBe('finished');
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('active');
        expect(adapter.sendMessage).not.toHaveBeenCalled();

        agent.emit('agent_event', { type: 'session_end', reason: 'duplicate' });
        const result = await manager.cancelSession(session.id);
        expect(result).toMatchObject({
          status: 'finished',
          warning: expect.stringContaining('final channel delivery did not complete'),
        });
        expect(JSON.parse(fs.readFileSync(filePath, 'utf8')).sessions[session.id].status).toBe('finished');
        expect(registry.size).toBe(0);
        expect(adapter.sendMessage).not.toHaveBeenCalled();
      } finally {
        store.destroy();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("permission flow", () => {
    it("sets up permissionGate and sends UI to adapter", async () => {
      bridge.connect();

      const request = {
        id: "req-1",
        description: "Allow?",
        options: [{ id: "yes", label: "Allow", isAllow: true }],
      };

      // Trigger permission request — resolve it immediately
      const resultPromise = agent.onPermissionRequest(request);

      expect(adapter.sendPermissionRequest).toHaveBeenCalledWith(
        session.id,
        request,
      );
      expect(session.permissionGate.isPending).toBe(true);

      // Resolve the permission
      session.permissionGate.resolve("yes");
      const result = await resultPromise;
      expect(result).toBe("yes");
    });
  });

  describe("lifecycle events", () => {
    it("persists status changes via sessionManager.patchRecord", () => {
      bridge.connect();
      session.activate();

      expect(deps.sessionManager.patchRecord).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ status: "active" }),
        { expectedSession: session },
      );
    });

    it("renames thread on named event", async () => {
      bridge.connect();
      session.activate();

      session.emit("named", "My Topic");

      await vi.waitFor(() => {
        expect(adapter.renameSessionThread).toHaveBeenCalledWith(
          session.id,
          "My Topic",
        );
      });
    });

    it("persists name on named event", async () => {
      bridge.connect();
      session.activate();

      session.emit("named", "My Topic");

      await vi.waitFor(() => {
        expect(deps.sessionManager.patchRecord).toHaveBeenCalledWith(
          session.id,
          expect.objectContaining({ name: "My Topic" }),
          { expectedSession: session },
        );
      });
    });
  });

  describe("disconnect()", () => {
    it.each([
      { label: 'text', event: { type: 'text', content: 'late' } as AgentEvent },
      { label: 'config', event: { type: 'config_option_update', options: [] } as AgentEvent },
      { label: 'image', event: { type: 'image_content', data: 'aGVsbG8=', mimeType: 'image/png' } as AgentEvent },
    ])('drops $label continuation when cancellation disconnects during beforeEvent middleware', async ({ event }) => {
      let release!: (value: unknown) => void
      const gate = new Promise((resolve) => { release = resolve })
      const execute = vi.fn().mockImplementation(async (_hook, payload) => {
        await gate
        return payload
      })
      const eventBus = { emit: vi.fn() }
      const fileService = {
        extensionFromMime: vi.fn().mockReturnValue('.png'),
        saveFile: vi.fn().mockResolvedValue({ fileName: 'late.png' }),
      }
      ;(deps as any).middlewareChain = { execute }
      ;(deps as any).eventBus = eventBus
      ;(deps as any).fileService = fileService
      bridge = new SessionBridge(session, adapter, deps as any)
      bridge.connect()

      session.emit('agent_event', event)
      await vi.waitFor(() => expect(execute).toHaveBeenCalled())
      bridge.disconnect()
      release(undefined)
      await Promise.resolve()
      await Promise.resolve()

      expect(deps.messageTransformer.transform).not.toHaveBeenCalled()
      expect(adapter.sendMessage).not.toHaveBeenCalled()
      expect(fileService.saveFile).not.toHaveBeenCalled()
      expect(deps.sessionManager.patchRecord).not.toHaveBeenCalled()
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it("removes all listeners — no more events routed", () => {
      bridge.connect();
      bridge.disconnect();

      // Events should no longer be routed
      const event: AgentEvent = { type: "text", content: "hello" };
      session.emit("agent_event", event);

      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("auto-disconnects on terminal status (finished)", async () => {
      bridge.connect();
      session.activate();
      session.finish("done");

      // Wait for microtask (disconnect is queued)
      await Promise.resolve();

      vi.mocked(adapter.sendMessage).mockClear();

      session.emit("agent_event", { type: "text", content: "after" });
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });

    it("does not forward ordinary events after cancelled becomes terminal", async () => {
      bridge.connect();
      session.activate();
      session.markCancelled();

      await Promise.resolve();

      vi.mocked(adapter.sendMessage).mockClear();

      session.emit("agent_event", { type: "text", content: "after" });
      expect(adapter.sendMessage).not.toHaveBeenCalled();
    });
  });
});
