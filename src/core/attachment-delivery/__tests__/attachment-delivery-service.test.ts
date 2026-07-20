import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IChannelAdapter } from "../../channel.js";
import type { AttachmentDeliveryRequest, AttachmentDeliveryTarget } from "../../types.js";
import { AttachmentDeliveryService } from "../attachment-delivery-service.js";
import { AttachmentDeliveryError } from "../errors.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function deliveryInput(target: AttachmentDeliveryTarget, data = Buffer.from("attachment"), deliveryId = "delivery-1") {
  return {
    schemaVersion: 1 as const,
    deliveryId,
    target,
    fileName: "memory.md",
    mimeType: "text/markdown",
    size: data.length,
    sha256: digest(data),
    caption: "Saved memory",
    data,
  };
}

function harness(root: string, options?: {
  deliver?: (request: AttachmentDeliveryRequest) => Promise<any>;
  isOperational?: () => boolean;
  fileUpload?: boolean;
  canonicalDefault?: boolean;
  assistantSession?: boolean;
}) {
  let live = true;
  let generation = 1;
  const session = {
    id: "session-1",
    channelId: "telegram",
    workingDirectory: "/workspace",
    agentSessionId: "agent-thread-1",
    status: "active",
    isAssistant: options?.assistantSession ?? options?.canonicalDefault ?? false,
    isTerminating: false,
    archiving: false,
    agentGeneration: 1,
    threadId: "42",
    threadIds: new Map([["telegram", "42"]]),
    captureAttachmentLease(adapterId: string, threadId: string) {
      return adapterId === "telegram" && threadId === this.threadIds.get(adapterId)
        ? { adapterId, threadId, generation }
        : null;
    },
    isAttachmentLeaseCurrent(lease: { adapterId: string; threadId: string; generation: number }) {
      return lease.adapterId === "telegram"
        && lease.threadId === this.threadIds.get("telegram")
        && lease.generation === generation;
    },
  };
  let currentSession = session;
  const manager = {
    getSession: vi.fn((id: string) => id === currentSession.id && live ? currentSession : undefined),
    getSessionByAgentSessionId: vi.fn(
      (id: string) => id === currentSession.agentSessionId && live ? currentSession : undefined,
    ),
    getCurrentLiveSessionsByAgentSessionId: vi.fn(
      (id: string) => id === currentSession.agentSessionId && live ? [currentSession] : [],
    ),
    isCurrentLiveSession: vi.fn(
      (candidate: unknown) => live && candidate === currentSession && !currentSession.isTerminating,
    ),
  };
  const defaultDeliver = vi.fn(async (request: AttachmentDeliveryRequest) => ({
    status: "provider_accepted" as const,
    deliveryId: request.deliveryId,
    providerMessageId: "telegram-message-9",
    adapterId: "telegram",
    acceptedAt: "2026-07-20T12:00:00.000Z",
  }));
  const deliverAttachment = options?.deliver ? vi.fn(options.deliver) : defaultDeliver;
  const adapter = {
    name: "telegram",
    capabilities: {
      streaming: true, richFormatting: true, threads: true,
      reactions: true, fileUpload: options?.fileUpload ?? true, voice: true,
    },
    deliverAttachment,
    ...(options?.isOperational ? { isOperational: options.isOperational } : {}),
  } as unknown as IChannelAdapter;
  const saveFile = vi.fn(async (_sessionId: string, fileName: string, data: Buffer, mimeType: string) => ({
    type: "file" as const,
    filePath: path.join(root, "staged", fileName),
    fileName,
    mimeType,
    size: data.length,
  }));
  const removeStagedFile = vi.fn(async () => undefined);
  let defaultAssistant: typeof session | null = options?.canonicalDefault ? session : null;
  const resolveDefaultAssistant = vi.fn(() => defaultAssistant);
  const adapters = new Map<string, IChannelAdapter>([["telegram", adapter]]);
  const service = new AttachmentDeliveryService({
    sessionManager: manager as any,
    adapters,
    fileService: { saveFile },
    journalPath: path.join(root, "receipts.json"),
    removeStagedFile,
    resolveDefaultAssistant,
  }, {
    targetSecret: Buffer.alloc(32, 7),
    now: () => Date.UTC(2026, 6, 20, 12),
    deliveryTimeoutMs: 100,
  });
  return {
    service,
    session,
    manager,
    adapter,
    deliverAttachment,
    saveFile,
    removeStagedFile,
    resolveDefaultAssistant,
    adapters,
    setLive(value: boolean) { live = value; },
    setCurrentSession(value: typeof session) { currentSession = value; },
    setDefaultAssistant(value: typeof session | null) { defaultAssistant = value; },
    replaceSessionAndDefaultWithEquivalent() {
      const replacement = {
        ...session,
        threadIds: new Map(session.threadIds),
      };
      currentSession = replacement;
      defaultAssistant = replacement;
      return replacement;
    },
    replaceAdapterWithEquivalent() {
      const replacement = {
        ...adapter,
        capabilities: { ...adapter.capabilities },
      } as IChannelAdapter;
      adapters.set("telegram", replacement);
      return replacement;
    },
    archive() { session.archiving = true; },
    replaceAgentWithSameId() { session.agentGeneration++; },
    rebind(threadId = "84") {
      generation++;
      session.threadId = threadId;
      session.threadIds.set("telegram", threadId);
    },
  };
}

describe("AttachmentDeliveryService", () => {
  let root: string;
  const services: AttachmentDeliveryService[] = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-attachment-delivery-"));
  });

  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.close()));
    fs.rmSync(root, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("resolves only the exact live agent session and delivers through an immutable private binding", async () => {
    const state = harness(root);
    services.push(state.service);

    const resolved = await state.service.resolveTarget({
      agentSessionId: "agent-thread-1",
      expectedWorkingDirectory: "/workspace",
    });
    expect(resolved.status).toBe("resolved");
    if (resolved.status !== "resolved") throw new Error("target was not resolved");
    expect(resolved.routeKind).toBe("agent_session");
    expect(JSON.stringify(resolved.target)).not.toContain("42");

    // Simulate the mutable object produced by route deserialization.
    const routeTarget = structuredClone(resolved.target);
    const receipt = await state.service.deliver(deliveryInput(routeTarget));

    expect(receipt.providerMessageId).toBe("telegram-message-9");
    expect(state.saveFile).toHaveBeenCalledWith("session-1", "memory.md", expect.any(Buffer), "text/markdown");
    const adapterRequest = state.deliverAttachment.mock.calls[0][0] as AttachmentDeliveryRequest;
    expect(adapterRequest.targetBinding.threadId).toBe("42");
    expect(adapterRequest.targetBinding.isCurrent()).toBe(true);
    expect(adapterRequest.targetBinding.target).not.toBe(routeTarget);
    expect(Object.isFrozen(adapterRequest.targetBinding)).toBe(true);
    expect(Object.isFrozen(adapterRequest.targetBinding.target)).toBe(true);
    expect(() => {
      (adapterRequest.targetBinding.target as { sessionId: string }).sessionId = "tampered";
    }).toThrow(TypeError);
    expect(routeTarget.sessionId).toBe("session-1");
    expect(state.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("never falls back when an explicit session is stale or mismatched", async () => {
    const state = harness(root);
    services.push(state.service);

    await expect(state.service.resolveTarget({
      explicitSessionId: "missing",
      agentSessionId: "agent-thread-1",
      allowDefaultAssistantFallback: true,
    })).rejects.toMatchObject({ code: "target_stale" });
    await expect(state.service.resolveTarget({
      explicitSessionId: "session-1",
      agentSessionId: "other-agent",
      allowDefaultAssistantFallback: true,
    })).rejects.toMatchObject({ code: "target_mismatch" });
    expect(state.manager.getCurrentLiveSessionsByAgentSessionId).not.toHaveBeenCalled();
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
  });

  it("reports explicit precedence and never consults the canonical Assistant", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);

    const resolved = await state.service.resolveTarget({
      explicitSessionId: "session-1",
      allowDefaultAssistantFallback: true,
    });

    expect(resolved).toMatchObject({ status: "resolved", routeKind: "explicit_session" });
    expect(state.manager.getCurrentLiveSessionsByAgentSessionId).not.toHaveBeenCalled();
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
  });

  it("prefers a unique exact agent match over an enabled default fallback", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);

    const resolved = await state.service.resolveTarget({
      agentSessionId: "agent-thread-1",
      allowDefaultAssistantFallback: true,
    });

    expect(resolved).toMatchObject({ status: "resolved", routeKind: "agent_session" });
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
  });

  it("uses the canonical default Assistant only for an opted-in zero-match lookup", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);

    const resolved = await state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      expectedWorkingDirectory: "/workspace",
      allowDefaultAssistantFallback: true,
    });
    expect(resolved).toMatchObject({ status: "resolved", routeKind: "default_assistant" });
    if (resolved.status !== "resolved") throw new Error("default Assistant was not resolved");
    expect(resolved.target).not.toHaveProperty("threadId");

    const receipt = await state.service.deliver(deliveryInput(resolved.target));
    expect(receipt).toMatchObject({
      status: "provider_accepted",
      providerMessageId: "telegram-message-9",
    });
    expect(state.deliverAttachment).toHaveBeenCalledOnce();
  });

  it("does not use the default Assistant without opt-in and rejects flag-only requests", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);

    await expect(state.service.resolveTarget({ agentSessionId: "missing-agent-session" }))
      .resolves.toMatchObject({ status: "target_unavailable" });
    await expect(state.service.resolveTarget({ allowDefaultAssistantFallback: true }))
      .rejects.toMatchObject({ code: "target_mismatch" });
    await expect(state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      allowDefaultAssistantFallback: "true",
    } as any)).rejects.toMatchObject({ code: "target_mismatch" });
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
  });

  it("treats a non-Assistant canonical resolver result as unavailable", async () => {
    const state = harness(root, { canonicalDefault: true, assistantSession: false });
    services.push(state.service);

    await expect(state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      allowDefaultAssistantFallback: true,
    })).resolves.toMatchObject({ status: "target_unavailable" });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it.each(["null", "stale", "finished", "cancelled"] as const)(
    "returns nonfatal unavailable for a %s canonical Assistant",
    async (condition) => {
      const state = harness(path.join(root, condition), { canonicalDefault: true });
      services.push(state.service);
      if (condition === "null") state.setDefaultAssistant(null);
      if (condition === "stale") state.setCurrentSession({ ...state.session });
      if (condition === "finished" || condition === "cancelled") state.session.status = condition;

      await expect(state.service.resolveTarget({
        agentSessionId: "missing-agent-session",
        allowDefaultAssistantFallback: true,
      })).resolves.toEqual({
        status: "target_unavailable",
        code: "assistant_not_found",
        retryable: false,
        safeMessage: "No active OpenACP target is available.",
      });
      expect(state.saveFile).not.toHaveBeenCalled();
      expect(state.deliverAttachment).not.toHaveBeenCalled();
    },
  );

  it("keeps the workspace guard for the canonical default Assistant", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);

    await expect(state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      expectedWorkingDirectory: "/different-workspace",
      allowDefaultAssistantFallback: true,
    })).rejects.toMatchObject({ code: "target_mismatch" });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("returns the nonfatal unavailable result without session heuristics", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);

    expect(await state.service.resolveTarget({ agentSessionId: "unknown" })).toEqual({
      status: "target_unavailable",
      code: "assistant_not_found",
      retryable: false,
      safeMessage: "No active OpenACP target is available.",
    });
    expect(state.manager.getSession).not.toHaveBeenCalled();
  });

  it("returns unavailable for an ambiguous agent-session identity without provider I/O", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);
    const duplicate = {
      ...state.session,
      id: "session-2",
      threadIds: new Map([["telegram", "84"]]),
      threadId: "84",
    };
    state.manager.getCurrentLiveSessionsByAgentSessionId.mockReturnValueOnce([
      state.session,
      duplicate,
    ] as any);
    state.manager.isCurrentLiveSession.mockImplementation(
      (candidate: unknown) => candidate === state.session || candidate === duplicate,
    );

    await expect(state.service.resolveTarget({
      agentSessionId: "agent-thread-1",
      allowDefaultAssistantFallback: true,
    })).resolves.toEqual({
      status: "target_unavailable",
      code: "assistant_not_found",
      retryable: false,
      safeMessage: "No active OpenACP target is available.",
    });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
  });

  it("invalidates a default-Assistant target when canonical ownership changes", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      allowDefaultAssistantFallback: true,
    });
    if (resolved.status !== "resolved") throw new Error("default Assistant was not resolved");
    state.setDefaultAssistant({ ...state.session, id: "replacement-assistant" });

    await expect(state.service.deliver(deliveryInput(resolved.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("invalidates an equivalent replacement Session object before staging", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      allowDefaultAssistantFallback: true,
    });
    if (resolved.status !== "resolved") throw new Error("default Assistant was not resolved");
    const replacement = state.replaceSessionAndDefaultWithEquivalent();
    expect(replacement).not.toBe(state.session);
    expect(replacement).toMatchObject({
      id: state.session.id,
      agentSessionId: state.session.agentSessionId,
      agentGeneration: state.session.agentGeneration,
      threadId: state.session.threadId,
    });

    await expect(state.service.deliver(deliveryInput(resolved.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("invalidates an equivalent replacement adapter object before staging", async () => {
    const state = harness(root);
    services.push(state.service);
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");
    const replacement = state.replaceAdapterWithEquivalent();
    expect(replacement).not.toBe(state.adapter);
    expect(replacement.name).toBe(state.adapter.name);

    await expect(state.service.deliver(deliveryInput(resolved.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("rechecks canonical Assistant ownership after file staging", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      allowDefaultAssistantFallback: true,
    });
    if (resolved.status !== "resolved") throw new Error("default Assistant was not resolved");
    state.saveFile.mockImplementationOnce(async (_sessionId, fileName, data, mimeType) => {
      state.setDefaultAssistant({ ...state.session, id: "replacement-assistant" });
      return { type: "file", filePath: path.join(root, fileName), fileName, mimeType, size: data.length };
    });

    await expect(state.service.deliver(deliveryInput(resolved.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(state.deliverAttachment).not.toHaveBeenCalled();
    expect(state.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("keeps canonical Assistant ownership in the adapter's just-in-time binding", async () => {
    const gate = deferred<void>();
    let state!: ReturnType<typeof harness>;
    state = harness(root, {
      canonicalDefault: true,
      deliver: async (request) => {
        await gate.promise;
        if (!request.targetBinding.isCurrent()) throw new AttachmentDeliveryError("target_stale");
        throw new Error("provider I/O must not be reached");
      },
    });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({
      agentSessionId: "missing-agent-session",
      allowDefaultAssistantFallback: true,
    });
    if (resolved.status !== "resolved") throw new Error("default Assistant was not resolved");

    const pending = state.service.deliver(deliveryInput(resolved.target));
    await vi.waitFor(() => expect(state.deliverAttachment).toHaveBeenCalledOnce());
    state.setDefaultAssistant({ ...state.session, id: "replacement-assistant" });
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "target_stale" });
    expect(state.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("treats an archiving session as stale for explicit lookup and unavailable for fallback", async () => {
    const state = harness(root, { canonicalDefault: true });
    services.push(state.service);
    state.archive();

    await expect(state.service.resolveTarget({ explicitSessionId: "session-1" }))
      .rejects.toMatchObject({ code: "target_stale" });
    await expect(state.service.resolveTarget({
      agentSessionId: "agent-thread-1",
      allowDefaultAssistantFallback: true,
    }))
      .resolves.toMatchObject({ status: "target_unavailable" });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("invalidates a resolved target when the session starts archiving", async () => {
    const beforeStaging = harness(root);
    services.push(beforeStaging.service);
    const first = await beforeStaging.service.resolveTarget({ explicitSessionId: "session-1" });
    if (first.status !== "resolved") throw new Error("target was not resolved");
    beforeStaging.archive();
    await expect(beforeStaging.service.deliver(deliveryInput(first.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(beforeStaging.saveFile).not.toHaveBeenCalled();

    const duringStaging = harness(path.join(root, "archiving-during-stage"));
    services.push(duringStaging.service);
    const second = await duringStaging.service.resolveTarget({ explicitSessionId: "session-1" });
    if (second.status !== "resolved") throw new Error("target was not resolved");
    duringStaging.saveFile.mockImplementationOnce(async (_sessionId, fileName, data, mimeType) => {
      duringStaging.archive();
      return {
        type: "file",
        filePath: path.join(root, "archiving-during-stage", fileName),
        fileName,
        mimeType,
        size: data.length,
      };
    });
    await expect(duringStaging.service.deliver(deliveryInput(second.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(duringStaging.deliverAttachment).not.toHaveBeenCalled();
    expect(duringStaging.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("keeps the transport binding stale if archiving begins during a queued adapter call", async () => {
    const gate = deferred<void>();
    let state!: ReturnType<typeof harness>;
    state = harness(root, {
      deliver: async (request) => {
        await gate.promise;
        if (!request.targetBinding.isCurrent()) throw new AttachmentDeliveryError("target_stale");
        throw new Error("provider I/O must not be reached");
      },
    });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");

    const pending = state.service.deliver(deliveryInput(resolved.target));
    await vi.waitFor(() => expect(state.deliverAttachment).toHaveBeenCalledOnce());
    state.archive();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "target_stale" });
    expect(state.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("does not resurrect a signed target after in-place agent replacement reuses the same ID", async () => {
    const state = harness(root);
    services.push(state.service);
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");
    state.replaceAgentWithSameId();

    await expect(state.service.deliver(deliveryInput(resolved.target)))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(state.session.agentSessionId).toBe("agent-thread-1");
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("rejects a rebind both before staging and across the staging await", async () => {
    const before = harness(root);
    services.push(before.service);
    const first = await before.service.resolveTarget({ explicitSessionId: "session-1" });
    if (first.status !== "resolved") throw new Error("target was not resolved");
    before.rebind();
    await expect(before.service.deliver(deliveryInput(first.target))).rejects.toMatchObject({ code: "target_stale" });
    expect(before.saveFile).not.toHaveBeenCalled();

    const secondRoot = path.join(root, "second");
    const during = harness(secondRoot);
    services.push(during.service);
    const second = await during.service.resolveTarget({ explicitSessionId: "session-1" });
    if (second.status !== "resolved") throw new Error("target was not resolved");
    during.saveFile.mockImplementationOnce(async (_sessionId, fileName, data, mimeType) => {
      during.rebind();
      return { type: "file", filePath: path.join(secondRoot, fileName), fileName, mimeType, size: data.length };
    });
    await expect(during.service.deliver(deliveryInput(second.target))).rejects.toMatchObject({ code: "target_stale" });
    expect(during.deliverAttachment).not.toHaveBeenCalled();
    expect(during.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("single-flights concurrent retries and conflicts on reused IDs with different hashes", async () => {
    const gate = deferred<void>();
    const state = harness(root, {
      deliver: async (request) => {
        await gate.promise;
        return {
          status: "provider_accepted",
          deliveryId: request.deliveryId,
          providerMessageId: "telegram-message-10",
          adapterId: "telegram",
          acceptedAt: "2026-07-20T12:00:00.000Z",
        };
      },
    });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");

    const first = state.service.deliver(deliveryInput(resolved.target));
    const second = state.service.deliver(deliveryInput(resolved.target));
    await vi.waitFor(() => expect(state.deliverAttachment).toHaveBeenCalledOnce());
    gate.resolve();
    expect(await first).toEqual(await second);
    expect(state.deliverAttachment).toHaveBeenCalledOnce();

    await expect(state.service.deliver(
      deliveryInput(resolved.target, Buffer.from("different")),
    )).rejects.toMatchObject({ code: "delivery_id_conflict" });
    expect(state.deliverAttachment).toHaveBeenCalledOnce();
  });

  it("returns a committed receipt after restart without recontacting the provider", async () => {
    const first = harness(root);
    services.push(first.service);
    const resolved = await first.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");
    const input = deliveryInput(resolved.target);
    const originalReceipt = await first.service.deliver(input);
    await first.service.close();

    const restarted = harness(root);
    services.push(restarted.service);
    expect(await restarted.service.deliver(input)).toEqual(originalReceipt);
    expect(restarted.deliverAttachment).not.toHaveBeenCalled();
    expect(restarted.saveFile).not.toHaveBeenCalled();
  });

  it("bounds provider work and exposes a typed timeout", async () => {
    vi.useFakeTimers();
    const state = harness(root, { deliver: async () => new Promise(() => {}) });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");

    const pending = state.service.deliver(deliveryInput(resolved.target));
    const rejection = expect(pending).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    expect(state.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("observes a non-cooperative adapter rejection that arrives after timeout", async () => {
    vi.useFakeTimers();
    let rejectProvider!: (error: Error) => void;
    const state = harness(root, {
      deliver: async () => new Promise((_resolve, reject) => { rejectProvider = reject; }),
    });
    services.push(state.service);
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");

    const pending = state.service.deliver(deliveryInput(resolved.target));
    const rejection = expect(pending).rejects.toMatchObject({ code: "provider_timeout" });
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    rejectProvider(new Error("late adapter rejection"));
    await Promise.resolve();

    expect(state.removeStagedFile).toHaveBeenCalledOnce();
  });

  it("reports failed or stopping adapters as unavailable while preserving legacy compatibility", () => {
    const unavailable = harness(root, { isOperational: () => false });
    services.push(unavailable.service);
    expect(unavailable.service.getHealth()).toMatchObject({
      status: "degraded",
      adapters: [{ adapterId: "telegram", available: false, acknowledgedReceipt: true }],
    });

    const legacy = harness(path.join(root, "legacy"));
    services.push(legacy.service);
    expect(legacy.service.getHealth()).toMatchObject({
      status: "ok",
      adapters: [{ adapterId: "telegram", available: true, acknowledgedReceipt: true }],
    });
  });

  it("does not stage or send when the adapter becomes non-operational after resolution", async () => {
    let operational = false;
    const state = harness(root, { isOperational: () => operational, canonicalDefault: true });
    services.push(state.service);
    await expect(state.service.resolveTarget({
      explicitSessionId: "session-1",
      allowDefaultAssistantFallback: true,
    }))
      .rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
    operational = true;
    const resolved = await state.service.resolveTarget({ explicitSessionId: "session-1" });
    if (resolved.status !== "resolved") throw new Error("target was not resolved");
    operational = false;

    await expect(state.service.deliver(deliveryInput(resolved.target)))
      .rejects.toMatchObject({ code: "provider_unavailable", retryable: true });
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("does not fall back from an explicit target on an unsupported adapter", async () => {
    const state = harness(root, { fileUpload: false, canonicalDefault: true });
    services.push(state.service);

    await expect(state.service.resolveTarget({
      explicitSessionId: "session-1",
      allowDefaultAssistantFallback: true,
    })).rejects.toMatchObject({ code: "unsupported_channel" });
    expect(state.resolveDefaultAssistant).not.toHaveBeenCalled();
    expect(state.saveFile).not.toHaveBeenCalled();
    expect(state.deliverAttachment).not.toHaveBeenCalled();
  });

  it("fails closed on a corrupt durable journal", () => {
    fs.writeFileSync(path.join(root, "receipts.json"), "{not-json", { mode: 0o600 });
    expect(() => harness(root)).toThrow(
      expect.objectContaining<Partial<AttachmentDeliveryError>>({ code: "internal_error" }),
    );
  });
});
