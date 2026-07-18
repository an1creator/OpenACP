import { describe, expect, it, vi } from "vitest";
import { ElicitationGate } from "../../../core/sessions/elicitation-gate.js";
import { TelegramElicitationHandler } from "../elicitation.js";

function setup() {
  const handlers: Array<{ filter: string; handler: (ctx: any, next: () => Promise<void>) => Promise<void> }> = [];
  let nextMessageId = 1;
  const api = {
    sendMessage: vi.fn(async () => ({ message_id: nextMessageId++ })),
    editMessageReplyMarkup: vi.fn().mockResolvedValue(undefined),
  };
  const bot = {
    api,
    on: vi.fn((filter: string, handler: any) => handlers.push({ filter, handler })),
  } as any;
  const gate = new ElicitationGate();
  const session = {
    id: "session-1",
    threadId: "321",
    threadIds: new Map([["telegram", "321"]]),
    elicitationGate: gate,
  } as any;
  const sessions = new Map([[session.id, session]]);
  const renderer = new TelegramElicitationHandler(bot, -1001, (sessionId) => sessions.get(sessionId));
  renderer.setupHandlers();
  return { handlers, api, gate, session, sessions, renderer };
}

describe("Telegram form elicitation", () => {
  it("binds a select response to the initiating user and topic", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const response = gate.request({
      id: "input-1", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Choose",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] } }, required: ["answer"],
      },
    });
    await renderer.send(session, gate.get("input-1")!);
    const markup = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard;
    const callback = markup[0][0].callback_data;
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;
    const wrongAnswer = vi.fn();
    await callbackHandler({
      callbackQuery: { data: callback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 7 }, answerCallbackQuery: wrongAnswer,
    }, vi.fn());
    expect(wrongAnswer).toHaveBeenCalledWith({ text: "This input request belongs to another user" });
    expect(gate.get("input-1")).toBeDefined();

    await callbackHandler({
      callbackQuery: { data: callback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(response).resolves.toEqual({ action: "accept", content: { answer: "yes" } });
  });

  it.each([
    {
      name: "oneOf",
      field: {
        type: "string" as const,
        oneOf: [{ const: "yes", title: "Yes please" }, { const: "no", title: "No thanks" }],
      },
      expectedLabel: "Yes please",
      expectedValue: "yes",
    },
    {
      name: "combined enum and oneOf",
      field: {
        type: "string" as const,
        enum: ["shared", "enum-only"],
        oneOf: [{ const: "oneof-only", title: "Not allowed" }, { const: "shared", title: "Shared choice" }],
      },
      expectedLabel: "Shared choice",
      expectedValue: "shared",
    },
  ])("presents and accepts the same effective $name choices as the core gate", async ({ field, expectedLabel, expectedValue }) => {
    const { handlers, api, gate, session, renderer } = setup();
    const response = gate.request({
      id: `input-${expectedValue}`,
      sessionId: session.id,
      targetAdapterId: "telegram",
      mode: "form",
      message: "Choose",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: { answer: field },
        required: ["answer"],
      },
    });
    await renderer.send(session, gate.get(`input-${expectedValue}`)!);
    const markup = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard;
    expect(markup[0][0].text).toBe(expectedLabel);
    if (expectedValue === "shared") {
      expect(markup.flat().map((button: { text: string }) => button.text)).not.toContain("Not allowed");
    }
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;
    await callbackHandler({
      callbackQuery: { data: markup[0][0].callback_data, message: { message_thread_id: 321 } },
      chat: { id: -1001 },
      from: { id: 42 },
      answerCallbackQuery: vi.fn(),
    }, vi.fn());

    await expect(response).resolves.toEqual({ action: "accept", content: { answer: expectedValue } });
  });

  it("discards a Codex secret when Telegram cannot delete the reply", async () => {
    const { handlers, gate, session, renderer } = setup();
    const response = gate.request({
      id: "secret-1", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Credential",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      sensitiveFields: ["token"],
      requestedSchema: {
        type: "object", properties: { token: { type: "string" } }, required: ["token"],
      },
    });
    await renderer.send(session, gate.get("secret-1")!);
    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    const reply = vi.fn().mockResolvedValue(undefined);
    await textHandler({
      message: { text: "must-not-be-used", message_thread_id: 321, reply_to_message: { message_id: 1 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn().mockRejectedValue(new Error("denied")), reply,
    }, vi.fn());
    await expect(response).resolves.toEqual({ action: "cancel" });
    expect(reply).toHaveBeenCalledWith(expect.stringContaining("value was not used"));
  });

  it("captures a slash-prefixed protected ForceReply before command routing", async () => {
    const { handlers, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "secret-slash", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Credential",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      sensitiveFields: ["token"],
      requestedSchema: {
        type: "object", properties: { token: { type: "string" } }, required: ["token"],
      },
    });
    await renderer.send(session, gate.get("secret-slash")!);
    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    const next = vi.fn();
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const resolveSpy = vi.spyOn(gate, "resolve");

    await textHandler({
      message: { text: "/token-value", message_thread_id: 321, reply_to_message: { message_id: 1 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage, reply: vi.fn(),
    }, next);

    expect(next).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledOnce();
    expect(deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(resolveSpy.mock.invocationCallOrder[0]);
    await expect(pending).resolves.toEqual({ action: "accept", content: { token: "/token-value" } });
  });

  it("passes an unrelated agent-command ForceReply to the next router", async () => {
    const { handlers, gate, session, renderer } = setup();
    void gate.request({
      id: "form-1", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Value",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    });
    await renderer.send(session, gate.get("form-1")!);
    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    const next = vi.fn().mockResolvedValue(undefined);

    await textHandler({
      message: { text: "/review", message_thread_id: 321, reply_to_message: { message_id: 999 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn(), reply: vi.fn(),
    }, next);

    expect(next).toHaveBeenCalledOnce();
    gate.cancelAll();
  });

  it("validates each field before advancing in a multi-field form", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "validated-steps",
      sessionId: session.id,
      targetAdapterId: "telegram",
      mode: "form",
      message: "Profile",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: {
          username: { type: "string", minLength: 5 },
          enabled: { type: "boolean" },
        },
        required: ["username", "enabled"],
      },
    });
    await renderer.send(session, gate.get("validated-steps")!);
    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    const validationReply = vi.fn().mockResolvedValue(undefined);

    await textHandler({
      message: { text: "x", message_thread_id: 321, reply_to_message: { message_id: 1 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn(), reply: validationReply,
    }, vi.fn());

    expect(validationReply).toHaveBeenCalledWith("username is too short");
    expect(gate.get("validated-steps")).toBeDefined();
    expect(api.sendMessage.mock.calls[2][1]).toContain("username");

    await textHandler({
      message: { text: "alice", message_thread_id: 321, reply_to_message: { message_id: 3 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn(), reply: vi.fn().mockResolvedValue(undefined),
    }, vi.fn());
    const booleanMarkup = api.sendMessage.mock.calls[4][2].reply_markup.inline_keyboard;
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;
    await callbackHandler({
      callbackQuery: { data: booleanMarkup[0][0].callback_data, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());

    await expect(pending).resolves.toEqual({ action: "accept", content: { username: "alice", enabled: true } });
  });

  it("rejects stale field callbacks and removes the old action markup", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "stale-field-action",
      sessionId: session.id,
      targetAdapterId: "telegram",
      mode: "form",
      message: "Optional fields",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: {
          first: { type: "string" },
          second: { type: "string" },
        },
      },
    });
    await renderer.send(session, gate.get("stale-field-action")!);
    const staleCallback = api.sendMessage.mock.calls[1][2].reply_markup.inline_keyboard[0][0].callback_data;
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;

    await callbackHandler({
      callbackQuery: { data: staleCallback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());

    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith(-1001, 2, { reply_markup: undefined });
    const staleAnswer = vi.fn();
    await callbackHandler({
      callbackQuery: { data: staleCallback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: staleAnswer,
    }, vi.fn());
    expect(staleAnswer).toHaveBeenCalledWith({ text: "This field is no longer active" });
    expect(gate.get("stale-field-action")).toBeDefined();

    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    await textHandler({
      message: { text: "kept", message_thread_id: 321, reply_to_message: { message_id: 3 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn(), reply: vi.fn().mockResolvedValue(undefined),
    }, vi.fn());
    await expect(pending).resolves.toEqual({ action: "accept", content: { second: "kept" } });
  });

  it("cancels and removes an initial form when its first message cannot be delivered", async () => {
    const { api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "initial-send-failure", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Choose",
      requestedSchema: { type: "object", properties: { answer: { type: "string", enum: ["yes"] } }, required: ["answer"] },
    });
    api.sendMessage.mockRejectedValueOnce(new Error("send failed"));

    await expect(renderer.send(session, gate.get("initial-send-failure")!)).rejects.toThrow("send failed");
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(gate.get("initial-send-failure")).toBeUndefined();
  });

  it("cancels without leaking the first answer when the next field send fails", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "next-send-failure", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Two fields",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: {
          first: { type: "string", enum: ["yes"] },
          second: { type: "boolean" },
        },
        required: ["first", "second"],
      },
    });
    await renderer.send(session, gate.get("next-send-failure")!);
    const callback = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data;
    api.sendMessage.mockRejectedValueOnce(new Error("next send failed"));
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;

    await expect(callbackHandler({
      callbackQuery: { data: callback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn())).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(gate.get("next-send-failure")).toBeUndefined();
  });

  it("cancels when ForceReply actions fail after the prompt was sent", async () => {
    const { api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "action-send-failure", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Text",
      requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
    });
    api.sendMessage
      .mockResolvedValueOnce({ message_id: 10 })
      .mockRejectedValueOnce(new Error("action failed"));

    await expect(renderer.send(session, gate.get("action-send-failure")!)).rejects.toThrow("action failed");
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith(-1001, 10, { reply_markup: undefined });
  });

  it("cancels when old field markup cannot be cleared during advance", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "advance-edit-failure", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Two fields",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: {
          first: { type: "string", enum: ["yes"] },
          second: { type: "string", enum: ["no"] },
        },
        required: ["first", "second"],
      },
    });
    await renderer.send(session, gate.get("advance-edit-failure")!);
    const callback = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data;
    api.editMessageReplyMarkup.mockRejectedValueOnce(new Error("edit denied"));
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;

    await callbackHandler({
      callbackQuery: { data: callback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(api.sendMessage).toHaveBeenCalledOnce();
  });

  it("cancels a skip transition when the next field cannot be presented", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "skip-send-failure", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Optional",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: {
          first: { type: "string", enum: ["yes"] },
          second: { type: "boolean" },
        },
      },
    });
    await renderer.send(session, gate.get("skip-send-failure")!);
    const buttons = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard.flat();
    const skip = buttons.find((button: { text: string }) => button.text === "Skip").callback_data;
    api.sendMessage.mockRejectedValueOnce(new Error("next field unavailable"));
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;

    await callbackHandler({
      callbackQuery: { data: skip, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(pending).resolves.toEqual({ action: "cancel" });
    expect(gate.get("skip-send-failure")).toBeUndefined();
  });

  it("cancels when a multi-select toggle edit fails", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "toggle-edit-failure", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Pick",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: { picks: { type: "array", items: { type: "string", enum: ["one"] } } },
        required: ["picks"],
      },
    });
    await renderer.send(session, gate.get("toggle-edit-failure")!);
    const callback = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data;
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;

    await callbackHandler({
      callbackQuery: { data: callback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
      editMessageText: vi.fn().mockRejectedValue(new Error("edit failed")),
    }, vi.fn());
    await expect(pending).resolves.toEqual({ action: "cancel" });
  });

  it("binds concurrent ForceReply forms to their exact prompt and owner", async () => {
    const { handlers, gate, session, renderer } = setup();
    const first = gate.request({
      id: "concurrent-first", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "First",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    });
    const second = gate.request({
      id: "concurrent-second", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Second",
      owner: { adapterId: "telegram", userId: "43", conversationId: "321" },
      requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    });
    await renderer.send(session, gate.get("concurrent-first")!);
    await renderer.send(session, gate.get("concurrent-second")!);
    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    const wrongOwnerReply = vi.fn().mockResolvedValue(undefined);

    await textHandler({
      message: { text: "wrong", message_thread_id: 321, reply_to_message: { message_id: 1 } },
      chat: { id: -1001 }, from: { id: 43 }, deleteMessage: vi.fn(), reply: wrongOwnerReply,
    }, vi.fn());
    expect(wrongOwnerReply).toHaveBeenCalledWith("This input request belongs to another user.");
    expect(gate.get("concurrent-first")).toBeDefined();
    expect(gate.get("concurrent-second")).toBeDefined();

    await textHandler({
      message: { text: "first-value", message_thread_id: 321, reply_to_message: { message_id: 1 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn(), reply: vi.fn(),
    }, vi.fn());
    await expect(first).resolves.toEqual({ action: "accept", content: { value: "first-value" } });
    expect(gate.get("concurrent-second")).toBeDefined();

    await textHandler({
      message: { text: "second-value", message_thread_id: 321, reply_to_message: { message_id: 3 } },
      chat: { id: -1001 }, from: { id: 43 }, deleteMessage: vi.fn(), reply: vi.fn(),
    }, vi.fn());
    await expect(second).resolves.toEqual({ action: "accept", content: { value: "second-value" } });
  });

  it("isolates identical ACP request IDs from different sessions", async () => {
    const { handlers, api, gate, session, sessions, renderer } = setup();
    const secondGate = new ElicitationGate();
    const secondSession = {
      id: "session-2",
      threadId: "321",
      threadIds: new Map([["telegram", "321"]]),
      elicitationGate: secondGate,
    } as any;
    sessions.set(secondSession.id, secondSession);
    const firstPending = gate.request({
      id: "same-id", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "First",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["one"] } }, required: ["value"] },
    });
    const secondPending = secondGate.request({
      id: "same-id", sessionId: secondSession.id, targetAdapterId: "telegram", mode: "form", message: "Second",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["two"] } }, required: ["value"] },
    });
    await renderer.send(session, gate.get("same-id")!);
    await renderer.send(secondSession, secondGate.get("same-id")!);
    const secondCallback = api.sendMessage.mock.calls[1][2].reply_markup.inline_keyboard[0][0].callback_data;

    gate.cancel("same-id", "cancelled");
    await renderer.dismiss({ requestId: "same-id", sessionId: session.id, action: "cancel" });
    await expect(firstPending).resolves.toEqual({ action: "cancel" });
    expect(api.editMessageReplyMarkup).toHaveBeenCalledWith(-1001, 1, { reply_markup: undefined });
    expect(secondGate.get("same-id")).toBeDefined();

    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;
    await callbackHandler({
      callbackQuery: { id: "second-session-answer", data: secondCallback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(secondPending).resolves.toEqual({ action: "accept", content: { value: "two" } });
  });

  it("keeps the other session form active when an identical request ID times out", async () => {
    const { handlers, api, gate, session, sessions, renderer } = setup();
    const secondGate = new ElicitationGate();
    const secondSession = {
      id: "session-timeout-2", threadId: "321", threadIds: new Map([["telegram", "321"]]), elicitationGate: secondGate,
    } as any;
    sessions.set(secondSession.id, secondSession);
    const firstPending = gate.request({
      id: "timeout-same-id", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Expires",
      timeoutMs: 1,
      requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["one"] } }, required: ["value"] },
    });
    const secondPending = secondGate.request({
      id: "timeout-same-id", sessionId: secondSession.id, targetAdapterId: "telegram", mode: "form", message: "Stays",
      requestedSchema: { type: "object", properties: { value: { type: "string", enum: ["two"] } }, required: ["value"] },
    });
    await renderer.send(session, gate.get("timeout-same-id")!);
    await renderer.send(secondSession, secondGate.get("timeout-same-id")!);
    const secondCallback = api.sendMessage.mock.calls[1][2].reply_markup.inline_keyboard[0][0].callback_data;

    await expect(firstPending).resolves.toEqual({ action: "cancel" });
    await renderer.dismiss({ requestId: "timeout-same-id", sessionId: session.id, action: "cancel" });
    expect(secondGate.get("timeout-same-id")).toBeDefined();
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;
    await callbackHandler({
      callbackQuery: { id: "second-after-timeout", data: secondCallback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(secondPending).resolves.toEqual({ action: "accept", content: { value: "two" } });
  });

  it("serializes duplicate first-field callbacks without skipping or cancelling the form", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "callback-race", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Race",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: {
          first: { type: "string", enum: ["one"] },
          second: { type: "boolean" },
        },
        required: ["first", "second"],
      },
    });
    await renderer.send(session, gate.get("callback-race")!);
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;
    const firstCallback = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard[0][0].callback_data;
    const context = (id: string) => ({
      callbackQuery: { id, data: firstCallback, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    });

    await Promise.all([
      callbackHandler(context("duplicate-delivery"), vi.fn()),
      callbackHandler(context("duplicate-delivery"), vi.fn()),
    ]);
    expect(gate.get("callback-race")).toBeDefined();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const secondMarkup = api.sendMessage.mock.calls[1][2].reply_markup.inline_keyboard;
    await callbackHandler({
      callbackQuery: { id: "finish-race", data: secondMarkup[0][0].callback_data, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(pending).resolves.toEqual({ action: "accept", content: { first: "one", second: true } });
  });

  it("treats a concurrent old-field cancel as stale after a text answer advances", async () => {
    const { handlers, api, gate, session, renderer } = setup();
    const pending = gate.request({
      id: "text-cancel-race", sessionId: session.id, targetAdapterId: "telegram", mode: "form", message: "Race",
      owner: { adapterId: "telegram", userId: "42", conversationId: "321" },
      requestedSchema: {
        type: "object",
        properties: { first: { type: "string" }, second: { type: "boolean" } },
        required: ["first", "second"],
      },
    });
    await renderer.send(session, gate.get("text-cancel-race")!);
    const cancelData = api.sendMessage.mock.calls[1][2].reply_markup.inline_keyboard.flat()
      .find((button: { text: string }) => button.text === "Cancel").callback_data;
    const textHandler = handlers.find((entry) => entry.filter === "message:text")!.handler;
    const callbackHandler = handlers.find((entry) => entry.filter === "callback_query:data")!.handler;

    const text = textHandler({
      message: { text: "kept", message_thread_id: 321, reply_to_message: { message_id: 1 } },
      chat: { id: -1001 }, from: { id: 42 }, deleteMessage: vi.fn(), reply: vi.fn(),
    }, vi.fn());
    const cancel = callbackHandler({
      callbackQuery: { id: "old-cancel", data: cancelData, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await Promise.all([text, cancel]);
    expect(gate.get("text-cancel-race")).toBeDefined();
    const booleanMarkup = api.sendMessage.mock.calls[2][2].reply_markup.inline_keyboard;
    await callbackHandler({
      callbackQuery: { id: "finish-text-race", data: booleanMarkup[0][0].callback_data, message: { message_thread_id: 321 } },
      chat: { id: -1001 }, from: { id: 42 }, answerCallbackQuery: vi.fn(),
    }, vi.fn());
    await expect(pending).resolves.toEqual({ action: "accept", content: { first: "kept", second: true } });
  });
});
