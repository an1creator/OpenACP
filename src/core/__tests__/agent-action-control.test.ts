import { describe, expect, it, vi } from "vitest";
import { OpenACPCore } from "../core.js";

const completed = {
  type: "agent_action_control" as const,
  action: "skills",
  status: "completed" as const,
  chunks: ["atcode", "figma:figma-use"],
};

function harness(options: {
  allowed?: boolean;
  withTargetBinding?: boolean;
  adapterId?: string;
  threadId?: string;
} = {}) {
  const adapterId = options.adapterId ?? "telegram";
  const threadId = options.threadId ?? "42";
  const session = {
    id: "session-1",
    isTerminating: false,
    channelId: adapterId,
    threadId,
    attachedAdapters: [adapterId, adapterId],
    threadIds: new Map([[adapterId, threadId]]),
    attachmentGeneration: 0,
    agentInstance: {},
    agentGeneration: 1,
    agentActionEpoch: 1,
    agentActionsSuspended: false,
    isAgentActionEpochCurrent(epoch: number) {
      return !this.isTerminating && !this.agentActionsSuspended && this.agentActionEpoch === epoch;
    },
    captureAttachmentLease(requestedAdapterId: string, requestedThreadId: string) {
      if (!this.attachedAdapters.includes(requestedAdapterId)) return null;
      if (this.threadIds.get(requestedAdapterId) !== requestedThreadId) return null;
      return { adapterId: requestedAdapterId, threadId: requestedThreadId, generation: this.attachmentGeneration };
    },
    isAttachmentLeaseCurrent(lease: { adapterId: string; threadId: string; generation: number }) {
      return this.attachedAdapters.includes(lease.adapterId)
        && this.threadIds.get(lease.adapterId) === lease.threadId
        && this.attachmentGeneration === lease.generation;
    },
    resolveAgentActionControl: vi.fn().mockReturnValue(completed),
  };
  const targetSend = vi.fn().mockResolvedValue(undefined);
  const bindTarget = vi.fn().mockImplementation((context: { target: unknown; isCurrent(): boolean }) => ({
    target: context.target,
    isCurrent: () => context.isCurrent(),
    sendPart: async (_response: typeof completed, part: string, index: number) => {
      if (!context.isCurrent()) return "stale" as const;
      await targetSend(context.target, part, index);
    },
  }));
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const adapter = {
    ...(options.withTargetBinding === false ? {} : { bindAgentActionControlTarget: bindTarget }),
    sendMessage,
  };
  const security = {
    checkAccess: vi.fn().mockResolvedValue(options.allowed === false
      ? { allowed: false, code: "UNAUTHORIZED_USER", reason: "Unauthorized user" }
      : { allowed: true }),
  };
  const middleware = { execute: vi.fn() };
  const sessionManager = {
    getSession: vi.fn().mockReturnValue(session),
    assertCurrentLiveSession: vi.fn(),
  };
  const core = Object.create(OpenACPCore.prototype) as OpenACPCore;
  Object.assign(core, {
    sessionManager,
    adapters: new Map([[adapterId, adapter]]),
    lifecycleManager: {
      serviceRegistry: { get: vi.fn((name: string) => name === "security" ? security : undefined) },
      middlewareChain: middleware,
    },
  });
  return { core, session, adapter, bindTarget, targetSend, sendMessage, security, middleware, sessionManager };
}

describe("OpenACPCore agent action control contract", () => {
  it("delivers a completed local response without middleware or prompt admission", async () => {
    const state = harness();

    const response = await state.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "/SKILLS",
    });

    expect(response).toEqual({
      type: "agent_action_control_delivery", action: "skills",
      status: "completed", deliveredParts: 2, totalParts: 2,
    });
    expect(state.security.checkAccess).toHaveBeenCalledWith({ userId: "7" });
    expect(state.session.resolveAgentActionControl).toHaveBeenCalledWith("/SKILLS", 1);
    expect(state.bindTarget).toHaveBeenCalledOnce();
    expect(state.bindTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.objectContaining({
          sessionId: "session-1", adapterId: "telegram", threadId: "42",
          attachmentGeneration: 0, agentGeneration: 1, actionEpoch: 1,
        }),
      }),
    );
    expect(state.targetSend.mock.calls.map(([, part]) => part)).toEqual(completed.chunks);
    expect(state.middleware.execute).not.toHaveBeenCalled();
    expect(state.sendMessage).not.toHaveBeenCalled();
  });

  it("drops before data when an adapter has no immutable target binding", async () => {
    const state = harness({ withTargetBinding: false });

    const result = await state.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "skills",
    });

    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "dropped", deliveredParts: 0, totalParts: 2,
      reason: "target-binding-unavailable",
    });
  });

  it("rejects stale ownership and unauthorized principals before resolving metadata", async () => {
    const wrongThread = harness();
    expect(await wrongThread.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "other",
      userId: "7", actionName: "skills",
    })).toBeNull();
    expect(wrongThread.session.resolveAgentActionControl).not.toHaveBeenCalled();
    expect(wrongThread.security.checkAccess).not.toHaveBeenCalled();

    const unauthorized = harness({ allowed: false });
    expect(await unauthorized.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "8", actionName: "skills",
    })).toBeNull();
    expect(unauthorized.session.resolveAgentActionControl).not.toHaveBeenCalled();
    expect(unauthorized.bindTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["session replacement", (state: ReturnType<typeof harness>) => {
      state.sessionManager.getSession.mockReturnValue({ id: "session-1" });
    }],
    ["agent generation", (state: ReturnType<typeof harness>) => {
      state.session.agentGeneration += 1;
    }],
    ["agent instance", (state: ReturnType<typeof harness>) => {
      state.session.agentInstance = {};
    }],
    ["action suspension", (state: ReturnType<typeof harness>) => {
      state.session.agentActionsSuspended = true;
      state.session.agentActionEpoch += 1;
    }],
    ["adapter replacement", (state: ReturnType<typeof harness>) => {
      state.core.adapters.set("telegram", { sendMessage: vi.fn() } as any);
    }],
    ["attachment detach", (state: ReturnType<typeof harness>) => {
      state.session.attachedAdapters = [];
      state.session.attachmentGeneration += 1;
    }],
    ["thread remap", (state: ReturnType<typeof harness>) => {
      state.session.threadIds.set("telegram", "99");
      state.session.attachmentGeneration += 1;
    }],
  ])("revalidates %s after the awaited security decision", async (_label, mutate) => {
    let release!: (value: { allowed: true }) => void;
    const state = harness();
    state.security.checkAccess.mockReturnValue(new Promise((resolve) => { release = resolve; }));

    const pending = state.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "skills",
    });
    await vi.waitFor(() => expect(state.security.checkAccess).toHaveBeenCalledOnce());
    mutate(state);
    release({ allowed: true });

    expect(await pending).toBeNull();
    expect(state.session.resolveAgentActionControl).not.toHaveBeenCalled();
    expect(state.bindTarget).not.toHaveBeenCalled();
  });

  it.each(["detach", "remap", "replace", "suspend"] as const)(
    "keeps the first target-bound part on the old target and stops after %s",
    async (mode) => {
      const state = harness();
      state.targetSend.mockImplementationOnce(async () => {
        if (mode === "detach") {
          state.session.attachedAdapters = [];
          state.session.attachmentGeneration += 1;
        } else if (mode === "remap") {
          state.session.threadIds.set("telegram", "99");
          state.session.attachmentGeneration += 1;
        } else if (mode === "replace") {
          state.core.adapters.set("telegram", { sendMessage: vi.fn() } as any);
        } else {
          state.session.agentActionsSuspended = true;
          state.session.agentActionEpoch += 1;
        }
      });

      const result = await state.core.handleAgentActionControl({
        sessionId: "session-1", adapterId: "telegram", threadId: "42",
        userId: "7", actionName: "skills",
      });

      expect(state.targetSend).toHaveBeenCalledTimes(1);
      expect(state.targetSend.mock.calls[0]?.[0]).toMatchObject({ threadId: "42" });
      expect(state.sendMessage).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        status: "partial", deliveredParts: 1, totalParts: 2, reason: "stale-target",
      });
    },
  );

  it("reports connector failure before and during multipart delivery", async () => {
    const failed = harness();
    failed.targetSend.mockRejectedValueOnce(new Error("connector unavailable"));
    expect(await failed.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "skills",
    })).toMatchObject({
      status: "failed", deliveredParts: 0, totalParts: 2, reason: "connector-error",
    });

    const partial = harness();
    partial.targetSend
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("connector unavailable"));
    expect(await partial.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "skills",
    })).toMatchObject({
      status: "partial", deliveredParts: 1, totalParts: 2, reason: "connector-error",
    });
  });

  it.each(["switch", "termination"] as const)(
    "drops a queued local response after %s invalidates its action epoch",
    async (mode) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const state = harness();
      const delivered = vi.fn().mockResolvedValue(undefined);
      state.bindTarget.mockImplementation((context) => ({
        target: context.target,
        isCurrent: () => context.isCurrent(),
        sendPart: async (_response: typeof completed, part: string, index: number) => {
          await gate;
          if (!context.isCurrent()) return "stale" as const;
          await delivered(part, index);
        },
      }));

      const pending = state.core.handleAgentActionControl({
        sessionId: "session-1", adapterId: "telegram", threadId: "42",
        userId: "7", actionName: "skills",
      });
      await vi.waitFor(() => expect(state.bindTarget).toHaveBeenCalledOnce());
      state.session.agentActionsSuspended = true;
      state.session.agentActionEpoch += 1;
      if (mode === "termination") state.session.isTerminating = true;
      release();

      expect(await pending).toMatchObject({
        status: "dropped", deliveredParts: 0, reason: "stale-target",
      });
      expect(delivered).not.toHaveBeenCalled();
    },
  );

  it("binds authorization to linked JWT users and master-secret principals", async () => {
    const linked = harness({ adapterId: "api", threadId: "stream" });
    await linked.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "api", threadId: "stream",
      userId: "token-1", actionName: "skills",
      principal: { type: "api", credential: "jwt", tokenId: "token-1", linkedUserId: "user-1" },
    });
    expect(linked.security.checkAccess).toHaveBeenCalledWith({ userId: "user-1" });

    const master = harness({ adapterId: "api", threadId: "stream" });
    await master.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "api", threadId: "stream",
      userId: "api-master", actionName: "skills",
      principal: { type: "api", credential: "secret" },
    });
    expect(master.security.checkAccess).toHaveBeenCalledWith(
      { userId: "api-master" }, { skipUserAllowlist: true },
    );
  });

  it("rejects a principal whose connector or JWT identity does not match the request", async () => {
    const connector = harness();
    expect(await connector.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "skills",
      principal: { type: "connector", channelId: "telegram", userId: "8" },
    })).toBeNull();
    expect(connector.security.checkAccess).not.toHaveBeenCalled();

    const jwt = harness({ adapterId: "api", threadId: "stream" });
    expect(await jwt.core.handleAgentActionControl({
      sessionId: "session-1", adapterId: "api", threadId: "stream",
      userId: "token-1", actionName: "skills",
      principal: { type: "api", credential: "jwt", tokenId: "token-2" },
    })).toBeNull();
    expect(jwt.security.checkAccess).not.toHaveBeenCalled();
  });

  it("uses only the live in-memory session and never calls lazy resume", async () => {
    const state = harness();
    state.sessionManager.getSession.mockReturnValue(undefined);
    const lazyResume = vi.fn();
    Object.assign(state.core, { sessionFactory: { getOrResume: lazyResume } });

    expect(await state.core.handleAgentActionControl({
      sessionId: "missing", adapterId: "telegram", threadId: "42",
      userId: "7", actionName: "skills",
    })).toBeNull();
    expect(lazyResume).not.toHaveBeenCalled();
  });
});
