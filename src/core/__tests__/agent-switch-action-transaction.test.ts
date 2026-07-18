import { describe, expect, it, vi } from "vitest";
import { AgentSwitchHandler } from "../agent-switch-handler.js";
import { Session } from "../sessions/session.js";
import { TypedEmitter } from "../utils/typed-emitter.js";
import type { AgentCommand, AgentEvent } from "../types.js";

const reviewCommand: AgentCommand = {
  name: "review", description: "Review",
  action: { key: "review", invocation: "/ReViEw", handling: "agent", acceptsInput: false },
};

function agent(sessionId: string, commands: AgentCommand[] = []) {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>();
  return Object.assign(emitter, {
    sessionId,
    latestCommands: commands,
    latestSkillNames: [],
    skillInventoryReady: true,
    skillDiscoveryStrategy: null,
    initialSessionResponse: undefined,
    agentCapabilities: undefined,
    promptCapabilities: {},
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: vi.fn(),
    onElicitationRequest: vi.fn(),
  }) as any;
}

function adapter() {
  return {
    cleanupAgentActionState: vi.fn().mockResolvedValue(undefined),
    cleanupSessionState: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function setup(options: { telegram?: any; sse?: any } = {}) {
  const oldAgent = agent("old", [reviewCommand]);
  const session = new Session({
    channelId: "telegram", agentName: "claude", workingDirectory: "/workspace",
    agentInstance: oldAgent,
  });
  session.agentSessionId = "old";
  session.attachedAdapters = ["telegram", "sse", "telegram"];
  session.threadIds.set("telegram", "42");
  session.threadIds.set("sse", "stream-1");
  const telegram = options.telegram ?? adapter();
  const sse = options.sse ?? adapter();
  const connect = vi.fn();
  const spawn = vi.fn().mockResolvedValue(agent("new", []));
  const resume = vi.fn().mockResolvedValue(agent("rollback", [reviewCommand]));
  const sessionManager = {
    getSession: vi.fn().mockImplementation((id: string) => id === session.id ? session : undefined),
    assertCurrentLiveSession: vi.fn(),
    patchRecord: vi.fn().mockResolvedValue(undefined),
  };
  const adapters = new Map([["telegram", telegram], ["sse", sse]]);
  const createBridge = vi.fn().mockReturnValue({ connect });
  const disconnectSessionBridges = vi.fn().mockReturnValue(2);
  const eventBus = { emit: vi.fn() };
  const handler = new AgentSwitchHandler({
    sessionManager: sessionManager as any,
    agentManager: {
      getAgent: vi.fn().mockReturnValue({ name: "gemini" }), spawn, resume,
    } as any,
    configManager: { get: vi.fn().mockReturnValue({ workspace: { security: { allowedPaths: [] } } }) } as any,
    eventBus: eventBus as any,
    adapters,
    createBridge,
    disconnectSessionBridges,
    getMiddlewareChain: () => undefined,
    getService: () => undefined,
  });
  return {
    handler, session, oldAgent, telegram, sse, spawn, resume, connect,
    sessionManager, adapters, createBridge, disconnectSessionBridges, eventBus,
  };
}

describe("agent switch action-state transaction", () => {
  it("cleans every unique attached adapter before spawning and reconnects each once", async () => {
    const state = setup();
    const initialActionEpoch = state.session.agentActionEpoch;

    await state.handler.switch(state.session.id, "gemini");

    expect(state.telegram.cleanupAgentActionState).toHaveBeenCalledOnce();
    expect(state.telegram.cleanupSessionState).toHaveBeenCalledOnce();
    expect(state.sse.cleanupAgentActionState).toHaveBeenCalledOnce();
    expect(state.sse.cleanupSessionState).toHaveBeenCalledOnce();
    expect(state.telegram.cleanupSessionState.mock.invocationCallOrder[0])
      .toBeLessThan(state.spawn.mock.invocationCallOrder[0]);
    expect(state.sse.cleanupSessionState.mock.invocationCallOrder[0])
      .toBeLessThan(state.spawn.mock.invocationCallOrder[0]);
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.session.agentActionsSuspended).toBe(false);
    expect(state.session.agentActionEpoch).toBeGreaterThan(initialActionEpoch);
    expect(state.session.isAgentActionEpochCurrent(initialActionEpoch)).toBe(false);
  });

  it("keeps old actions unavailable throughout a long replacement spawn", async () => {
    let release!: (value: any) => void;
    const spawnPending = new Promise((resolve) => { release = resolve; });
    const state = setup();
    state.spawn.mockReturnValue(spawnPending);

    const switching = state.handler.switch(state.session.id, "gemini");
    await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
    expect(state.session.latestCommands).toEqual([]);
    expect(state.session.resolveAgentActionControl("review")).toBeNull();

    release(agent("new", []));
    await switching;
  });

  it("attempts all cleanup, restores the old snapshot, and reconnects without spawning on partial failure", async () => {
    const telegram = adapter();
    telegram.cleanupAgentActionState.mockRejectedValue(new Error("telegram cleanup failed"));
    const state = setup({ telegram });

    await expect(state.handler.switch(state.session.id, "gemini"))
      .rejects.toThrow("Failed to clean adapter state before agent switch");

    expect(state.telegram.cleanupSessionState).toHaveBeenCalledOnce();
    expect(state.sse.cleanupAgentActionState).toHaveBeenCalledOnce();
    expect(state.sse.cleanupSessionState).toHaveBeenCalledOnce();
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.session.latestCommands).toEqual([reviewCommand]);
    expect(state.connect).toHaveBeenCalledTimes(2);
  });

  it("reconnects the rollback snapshot on a post-cleanup spawn failure", async () => {
    const state = setup();
    const initialActionEpoch = state.session.agentActionEpoch;
    state.spawn.mockRejectedValue(new Error("spawn failed"));

    await expect(state.handler.switch(state.session.id, "gemini")).rejects.toThrow("spawn failed");

    expect(state.resume).toHaveBeenCalledWith("claude", "/workspace", "old");
    expect(state.session.agentName).toBe("claude");
    expect(state.session.latestCommands).toEqual([reviewCommand]);
    expect(state.connect).toHaveBeenCalledTimes(2);
    expect(state.session.agentActionsSuspended).toBe(false);
    expect(state.session.agentActionEpoch).toBeGreaterThan(initialActionEpoch);
    expect(state.session.isAgentActionEpochCurrent(initialActionEpoch)).toBe(false);
  });

  it("advances the action epoch across rapid sequential switches", async () => {
    const state = setup();
    const initialEpoch = state.session.agentActionEpoch;

    await state.handler.switch(state.session.id, "gemini");
    const firstSwitchEpoch = state.session.agentActionEpoch;
    state.spawn.mockResolvedValue(agent("third", []));
    await state.handler.switch(state.session.id, "codex");

    expect(firstSwitchEpoch).toBeGreaterThan(initialEpoch);
    expect(state.session.agentActionEpoch).toBeGreaterThan(firstSwitchEpoch);
    expect(state.session.agentActionsSuspended).toBe(false);
    expect(state.session.isAgentActionEpochCurrent(firstSwitchEpoch)).toBe(false);
  });

  it("never reconnects an adapter detached during a long spawn", async () => {
    let release!: (value: any) => void;
    const state = setup();
    state.spawn.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const switching = state.handler.switch(state.session.id, "gemini");
    await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledOnce());
    state.session.detachAdapterBinding("sse");
    release(agent("new", []));
    await switching;

    expect(state.session.attachedAdapters).toEqual(["telegram", "telegram"]);
    expect(state.createBridge).toHaveBeenCalledTimes(1);
    expect(state.createBridge.mock.calls[0]?.[2]).toBe("telegram");
  });

  it("never reconnects an adapter detached during rollback", async () => {
    let releaseRollback!: (value: any) => void;
    const state = setup();
    state.spawn.mockRejectedValue(new Error("spawn failed"));
    state.resume.mockReturnValue(new Promise((resolve) => { releaseRollback = resolve; }));

    const switching = state.handler.switch(state.session.id, "gemini");
    await vi.waitFor(() => expect(state.resume).toHaveBeenCalledOnce());
    state.session.detachAdapterBinding("sse");
    releaseRollback(agent("rollback", [reviewCommand]));
    await expect(switching).rejects.toThrow("spawn failed");

    expect(state.createBridge).toHaveBeenCalledTimes(1);
    expect(state.createBridge.mock.calls[0]?.[2]).toBe("telegram");
  });

  it("revalidates every attachment between reconnects", async () => {
    const state = setup();
    state.createBridge.mockImplementation((_session, _adapter, adapterId) => ({
      connect: () => {
        state.connect();
        if (adapterId === "telegram") state.session.detachAdapterBinding("sse");
      },
    }));

    await state.handler.switch(state.session.id, "gemini");

    expect(state.createBridge).toHaveBeenCalledTimes(1);
    expect(state.session.attachedAdapters).not.toContain("sse");
  });

  it("treats an expected but missing adapter as a switch failure", async () => {
    const state = setup();
    state.adapters.delete("sse");

    await expect(state.handler.switch(state.session.id, "gemini"))
      .rejects.toThrow("Failed to clean adapter state before agent switch");

    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.session.agentName).toBe("claude");
    expect(state.createBridge).toHaveBeenCalledTimes(1);
  });

  it.each(["reject", "throw"])("rolls runtime and durable identity back when persistence %s", async (mode) => {
    const state = setup();
    const provisionalRuntime = agent("new", []);
    state.spawn.mockResolvedValue(provisionalRuntime);
    if (mode === "reject") {
      state.sessionManager.patchRecord.mockRejectedValueOnce(new Error("persist failed"));
    } else {
      state.sessionManager.patchRecord.mockImplementationOnce(() => {
        throw new Error("persist failed");
      });
    }

    await expect(state.handler.switch(state.session.id, "gemini")).rejects.toThrow("persist failed");

    expect(state.session.agentName).toBe("claude");
    expect(state.session.latestCommands).toEqual([reviewCommand]);
    expect(provisionalRuntime.destroy).toHaveBeenCalledOnce();
    expect(state.sessionManager.patchRecord).toHaveBeenLastCalledWith(
      state.session.id,
      expect.objectContaining({ agentName: "claude", agentSessionId: "rollback" }),
      { expectedSession: state.session },
    );
    expect(state.createBridge).toHaveBeenCalledTimes(4);
  });

  it("terminates the provisional runtime when durable rollback also fails", async () => {
    const state = setup();
    state.sessionManager.patchRecord.mockRejectedValue(new Error("storage unavailable"));

    await expect(state.handler.switch(state.session.id, "gemini"))
      .rejects.toThrow("Agent switch failed and rollback failed");

    expect(state.session.status).toBe("error");
    expect(state.session.isTerminating).toBe(true);
    expect(state.disconnectSessionBridges).toHaveBeenCalledTimes(3);
    expect(state.eventBus.emit.mock.calls.some(([, payload]) => payload?.status === "succeeded"))
      .toBe(false);
  });
});
