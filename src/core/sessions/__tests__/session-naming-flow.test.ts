import { afterEach, describe, expect, it, vi } from "vitest";
import { Session } from "../session.js";
import { SessionBridge } from "../session-bridge.js";
import { MessageTransformer } from "../../message-transformer.js";
import { TypedEmitter } from "../../utils/typed-emitter.js";
import type { AgentEvent } from "../../types.js";

function makeAgent() {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>();
  return Object.assign(emitter, {
    sessionId: "agent-session",
    prompt: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: undefined as unknown,
    debugTracer: null,
    promptCapabilities: {},
  }) as any;
}

function makeAdapter() {
  return {
    name: "telegram",
    capabilities: {
      streaming: false,
      richFormatting: false,
      threads: true,
      reactions: false,
      fileUpload: false,
      voice: false,
    },
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPermissionRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    createSessionThread: vi.fn().mockResolvedValue("101"),
    renameSessionThread: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeHarness(middlewareChain?: { execute: ReturnType<typeof vi.fn> }) {
  const agent = makeAgent();
  const session = new Session({
    id: "naming-flow",
    channelId: "telegram",
    agentName: "codex",
    workingDirectory: "/workspace",
    agentInstance: agent,
  });
  session.threadId = "101";
  const adapter = makeAdapter();
  const patchRecord = vi.fn().mockResolvedValue(undefined);
  const eventBus = { emit: vi.fn() };
  const bridge = new SessionBridge(session, adapter, {
    messageTransformer: new MessageTransformer(),
    notificationManager: { notify: vi.fn() } as any,
    sessionManager: { patchRecord } as any,
    eventBus: eventBus as any,
    middlewareChain: middlewareChain as any,
  });
  bridge.connect();
  return { agent, session, adapter, patchRecord, eventBus, bridge };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe("Session naming policy flow", () => {
  it("ignores the Codex ACP 1.1.4 prompt echo and publishes only the short auto-name", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    const prompt = "Check whether agent memory MCP works, stop on failure, and provide a report";

    harness.agent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith("Summarize this conversation")) {
        harness.agent.emit("agent_event", { type: "text", content: "Check Agent Memory MCP" });
        return;
      }
      harness.agent.emit("agent_event", { type: "session_info_update", title: text });
      harness.agent.emit("agent_event", { type: "session_info_update", title: `"${text}"` });
      harness.agent.emit("agent_event", { type: "text", content: "Working on it" });
    });

    await harness.session.enqueuePrompt(prompt);
    await vi.waitFor(() => {
      expect(harness.adapter.renameSessionThread).toHaveBeenCalledWith(
        harness.session.id,
        "Check Agent Memory MCP",
      );
    });

    expect(harness.session.name).toBe("Check Agent Memory MCP");
    expect(harness.session.nameSource).toBe("auto");
    expect(harness.adapter.renameSessionThread).toHaveBeenCalledTimes(1);
    expect(harness.adapter.sendMessage).not.toHaveBeenCalledWith(
      harness.session.id,
      expect.objectContaining({ text: `Session updated: ${prompt}` }),
    );
    expect(harness.patchRecord).not.toHaveBeenCalledWith(
      harness.session.id,
      expect.objectContaining({ name: prompt }),
      expect.anything(),
    );
  });

  it("normalizes explicit ACP names, ignores repeats, and gives manual names priority", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });

    harness.agent.emit("agent_event", {
      type: "session_info_update",
      title: '  "One\nTwo\tThree Four Five Six Seven"  ',
    });
    await vi.waitFor(() => expect(harness.session.name).toBe("One Two Three Four Five"));

    harness.agent.emit("agent_event", {
      type: "session_info_update",
      title: "One Two Three Four Five Six",
    });
    await Promise.resolve();
    expect(harness.adapter.sendMessage).toHaveBeenCalledTimes(1);

    const manual51 = "M".repeat(51);
    expect(harness.session.setName(manual51, "manual")).toBe(manual51);

    const manual = "N".repeat(200);
    expect(harness.session.setName(manual, "manual")).toBe(manual);

    harness.agent.emit("agent_event", { type: "session_info_update", title: "Agent overwrite" });
    await Promise.resolve();
    expect(harness.session.name).toBe(manual);
  });

  it("keeps generated names within the five-word and 50-character limits", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });

    harness.agent.emit("agent_event", {
      type: "session_info_update",
      title: `${"A".repeat(80)} two three four five six`,
    });

    await vi.waitFor(() => expect(Array.from(harness.session.name ?? "")).toHaveLength(50));
    expect(harness.session.name).toBe("A".repeat(50));
    expect(harness.session.nameSource).toBe("agent");
  });

  it("keeps a manual name selected while successful auto-naming is in flight", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    const started = deferred();
    const release = deferred();

    harness.agent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith("Summarize this conversation")) {
        started.resolve();
        await release.promise;
        harness.agent.emit("agent_event", { type: "text", content: "Generated Short Title" });
      }
    });

    const prompt = harness.session.enqueuePrompt("Start a naming race");
    await started.promise;
    const manual = "Manual name chosen during naming";
    expect(harness.session.setName(manual, "manual")).toBe(manual);
    release.resolve();
    await prompt;

    expect(harness.session.name).toBe(manual);
    expect(harness.session.nameSource).toBe("manual");
    expect(harness.adapter.renameSessionThread).toHaveBeenCalledWith(harness.session.id, manual);
    expect(harness.adapter.renameSessionThread).not.toHaveBeenCalledWith(
      harness.session.id,
      "Generated Short Title",
    );
  });

  it("keeps a 200-character manual name when in-flight auto-naming fails", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    const started = deferred();
    const release = deferred();

    harness.agent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith("Summarize this conversation")) {
        started.resolve();
        await release.promise;
        throw new Error("auto-name failed after manual rename");
      }
    });

    const prompt = harness.session.enqueuePrompt("Start a fallback naming race");
    await started.promise;
    const manual = "M".repeat(200);
    expect(harness.session.setName(manual, "manual")).toBe(manual);
    release.resolve();
    await prompt;

    expect(harness.session.name).toBe(manual);
    expect(harness.session.nameSource).toBe("manual");
    expect(harness.adapter.renameSessionThread).not.toHaveBeenCalledWith(
      harness.session.id,
      "Session naming",
    );
  });

  it("does not overwrite a persisted name restored while auto-naming is in flight", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    const started = deferred();
    const release = deferred();

    harness.agent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith("Summarize this conversation")) {
        started.resolve();
        await release.promise;
        harness.agent.emit("agent_event", { type: "text", content: "Generated Short Title" });
      }
    });

    const prompt = harness.session.enqueuePrompt("Start a restore naming race");
    await started.promise;
    const persisted = `Persisted\n${"P".repeat(240)}`;
    expect(harness.session.initializeName(persisted, "persisted")).toBe(persisted);
    release.resolve();
    await prompt;

    expect(harness.session.name).toBe(persisted);
    expect(harness.session.nameSource).toBe("persisted");
    expect(harness.adapter.renameSessionThread).not.toHaveBeenCalledWith(
      harness.session.id,
      "Generated Short Title",
    );
  });

  it("coalesces overlapping auto-name attempts into one guarded operation", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    const started = deferred();
    const release = deferred();
    harness.agent.prompt.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      harness.agent.emit("agent_event", { type: "text", content: "Single Auto Result" });
    });
    const autoName = (harness.session as any).autoName.bind(harness.session);

    const first = autoName(harness.agent);
    const second = autoName(harness.agent);
    await started.promise;
    expect(harness.agent.prompt).toHaveBeenCalledTimes(1);
    release.resolve();
    await Promise.all([first, second]);

    expect(harness.session.name).toBe("Single Auto Result");
    expect(harness.session.nameSource).toBe("auto");
    expect(harness.adapter.renameSessionThread).toHaveBeenCalledTimes(1);
  });

  it("discards a completed auto-name after the session starts terminating", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    const started = deferred();
    const release = deferred();
    harness.agent.prompt.mockImplementation(async () => {
      started.resolve();
      await release.promise;
      harness.agent.emit("agent_event", { type: "text", content: "Late Auto Result" });
    });
    const autoName = (harness.session as any).autoName.bind(harness.session);

    const operation = autoName(harness.agent);
    await started.promise;
    harness.session.beginTermination();
    release.resolve();
    await operation;

    expect(harness.session.name).toBeUndefined();
    expect(harness.session.nameSource).toBeUndefined();
    expect(harness.adapter.renameSessionThread).not.toHaveBeenCalled();
  });

  it("allows an explicit later ACP rename for a legacy persisted session", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    harness.session.initializeName("Persisted Session", "persisted");

    harness.agent.emit("agent_event", {
      type: "session_info_update",
      title: "Explicit Later Rename",
    });

    await vi.waitFor(() => expect(harness.session.name).toBe("Explicit Later Rename"));
    expect(harness.session.nameSource).toBe("agent");
    expect(harness.adapter.renameSessionThread).toHaveBeenCalledWith(
      harness.session.id,
      "Explicit Later Rename",
    );
  });

  it("keeps auto-name deterministic when an accepted ACP title is delayed behind middleware", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const middlewareChain = {
      execute: vi.fn(async (_hook: string, payload: unknown) => {
        await gate;
        return payload;
      }),
    };
    const harness = makeHarness(middlewareChain);
    cleanups.push(async () => {
      release();
      harness.bridge.disconnect();
      await harness.session.destroy();
    });

    harness.agent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith("Summarize this conversation")) {
        harness.agent.emit("agent_event", { type: "text", content: "Stable Auto Name" });
      } else {
        harness.agent.emit("agent_event", { type: "session_info_update", title: "Early Agent Name" });
      }
    });

    await harness.session.enqueuePrompt("A different user prompt");
    expect(harness.session.name).toBe("Stable Auto Name");
    release();
    await vi.waitFor(() => expect(middlewareChain.execute).toHaveBeenCalled());
    await Promise.resolve();
    expect(harness.session.name).toBe("Stable Auto Name");
  });

  it("publishes the documented fallback when the auto-name request fails", async () => {
    const harness = makeHarness();
    cleanups.push(async () => {
      harness.bridge.disconnect();
      await harness.session.destroy();
    });
    harness.agent.prompt.mockImplementation(async (text: string) => {
      if (text.startsWith("Summarize this conversation")) throw new Error("naming failed");
      harness.agent.emit("agent_event", { type: "session_info_update", title: text });
    });

    await harness.session.enqueuePrompt("Prompt echoed by ACP");
    await vi.waitFor(() => {
      expect(harness.adapter.renameSessionThread).toHaveBeenCalledWith(
        harness.session.id,
        "Session naming",
      );
    });
    expect(harness.session.name).toBe("Session naming");
    expect(harness.session.nameSource).toBe("auto");
  });
});
