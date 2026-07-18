import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "../../utils/typed-emitter.js";
import { Session } from "../session.js";
import { SessionEv } from "../../events.js";

function agent() {
  return Object.assign(new TypedEmitter(), {
    sessionId: "agent-session",
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setConfigOption: vi.fn(),
    onPermissionRequest: vi.fn(),
  }) as any;
}

describe("Session ACP form elicitation", () => {
  it("pauses, publishes a sanitized request, and returns non-empty accepted answers", async () => {
    const instance = agent();
    const session = new Session({
      id: "session-1", channelId: "telegram", agentName: "codex", workingDirectory: "/tmp", agentInstance: instance,
    });
    session.threadIds.set("telegram", "321");
    session.activeTurnContext = {
      turnId: "turn-1",
      sourceAdapterId: "telegram",
      userPrompt: "help",
      finalPrompt: "help",
      meta: {
        turnId: "turn-1",
        channelUser: { channelId: "telegram", userId: "42" },
        identity: { userId: "canonical-42", identityId: "telegram:42" },
      },
    };
    const published = vi.fn();
    session.on(SessionEv.ELICITATION_REQUEST, published);

    const response = instance.onElicitationRequest({
      mode: "form",
      sessionId: "agent-session",
      message: "Choose",
      requestedSchema: {
        type: "object",
        properties: {
          answer: { type: "string", enum: ["yes", "no"], _meta: { codex: { isSecret: false } } },
        },
        required: ["answer"],
        _meta: { ignored: true },
      },
      _meta: { codex: { autoResolutionMs: 30_000 }, ignored: "value" },
    });

    expect(published).toHaveBeenCalledOnce();
    const request = published.mock.calls[0][0];
    expect(request).toMatchObject({
      sessionId: "session-1", turnId: "turn-1", targetAdapterId: "telegram",
      owner: {
        adapterId: "telegram",
        userId: "42",
        canonicalUserId: "canonical-42",
        conversationId: "321",
      },
    });
    expect(request.requestedSchema._meta).toBeUndefined();
    expect(request.requestedSchema.properties.answer._meta).toBeUndefined();

    session.elicitationGate.resolve(request.id, { action: "accept", content: { answer: "yes" } }, "telegram");
    await expect(response).resolves.toEqual({ action: "accept", content: { answer: "yes" } });
    await session.destroy();
  });

  it("cancels a pending request when its turn is aborted", async () => {
    const instance = agent();
    const session = new Session({
      id: "session-2", channelId: "telegram", agentName: "codex", workingDirectory: "/tmp", agentInstance: instance,
    });
    session.activeTurnContext = {
      turnId: "turn-2", sourceAdapterId: "telegram", userPrompt: "help", finalPrompt: "help",
    };
    const response = instance.onElicitationRequest({
      mode: "form", sessionId: "agent-session", message: "Value",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    });
    await session.abortPrompt();
    await expect(response).resolves.toEqual({ action: "cancel" });
    expect(session.elicitationGate.size).toBe(0);
    await session.destroy();
  });

  it("binds API requests to both the initiating JWT and its canonical linked user", async () => {
    const instance = agent();
    const session = new Session({
      id: "session-api", channelId: "api", agentName: "codex", workingDirectory: "/tmp", agentInstance: instance,
    });
    session.activeTurnContext = {
      turnId: "turn-api", sourceAdapterId: "api", responseAdapterId: "sse", userPrompt: "help", finalPrompt: "help",
      meta: {
        turnId: "turn-api",
        channelUser: { channelId: "api", userId: "token-1" },
        principal: { type: "api", credential: "jwt", tokenId: "token-1", linkedUserId: "user-1" },
      },
    };
    const published = vi.fn();
    session.on(SessionEv.ELICITATION_REQUEST, published);

    const response = instance.onElicitationRequest({
      mode: "form", sessionId: "agent-session", message: "Value",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    });
    const request = published.mock.calls[0][0];
    expect(request.owner).toEqual({
      adapterId: "api",
      userId: "token-1",
      canonicalUserId: "user-1",
      conversationId: undefined,
      apiCredential: "jwt",
      apiTokenId: "token-1",
    });
    session.elicitationGate.cancel(request.id);
    await expect(response).resolves.toEqual({ action: "cancel" });
    await session.destroy();
  });

  it("rejects a late old-agent form during switch teardown and accepts only the replacement", async () => {
    const oldAgent = agent();
    let releaseDestroy!: () => void;
    oldAgent.destroy = vi.fn(() => new Promise<void>((resolve) => { releaseDestroy = resolve; }));
    const replacement = agent();
    replacement.sessionId = "replacement-agent";
    replacement.initialSessionResponse = { configOptions: [] };
    const session = new Session({
      id: "session-switch", channelId: "telegram", agentName: "codex", workingDirectory: "/tmp", agentInstance: oldAgent,
    });
    const oldHandler = oldAgent.onElicitationRequest;

    const switching = session.switchAgent("replacement", async () => replacement);
    await vi.waitFor(() => expect(oldAgent.destroy).toHaveBeenCalledOnce());
    await expect(oldHandler({
      mode: "form", sessionId: oldAgent.sessionId, message: "stale",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    })).resolves.toEqual({ action: "cancel" });
    expect(session.elicitationGate.size).toBe(0);

    releaseDestroy();
    await switching;
    const published = vi.fn();
    session.on(SessionEv.ELICITATION_REQUEST, published);
    const current = replacement.onElicitationRequest({
      mode: "form", sessionId: replacement.sessionId, message: "current",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    });
    expect(published).toHaveBeenCalledOnce();
    const request = published.mock.calls[0][0];
    session.elicitationGate.cancel(request.id);
    await expect(current).resolves.toEqual({ action: "cancel" });
    await session.destroy();
  });

  it("rejects old-agent forms after the terminal boundary", async () => {
    const instance = agent();
    const session = new Session({
      id: "session-terminal", channelId: "telegram", agentName: "codex", workingDirectory: "/tmp", agentInstance: instance,
    });
    const handler = instance.onElicitationRequest;
    session.beginTermination();

    await expect(handler({
      mode: "form", sessionId: instance.sessionId, message: "too late",
      requestedSchema: { type: "object", properties: { value: { type: "string" } } },
    })).resolves.toEqual({ action: "cancel" });
    expect(session.elicitationGate.size).toBe(0);
    await session.destroy();
  });
});
