import { describe, expect, it, vi } from "vitest";
import type { AttachmentDeliveryRequest } from "../../../core/types.js";
import { AttachmentDeliveryError } from "../../../core/attachment-delivery/errors.js";
import { SendQueue } from "../../../core/adapter-primitives/primitives/send-queue.js";

const inputFileCalls = vi.hoisted(() => [] as Array<{ file: string; filename?: string }>);

vi.mock("grammy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("grammy")>();
  class TestInputFile {
    constructor(
      readonly file: string,
      readonly filename?: string,
    ) {
      inputFileCalls.push({ file, filename });
    }
  }
  return { ...actual, InputFile: TestInputFile };
});

import { TelegramAdapter } from "../adapter.js";

const TELEGRAM_CHAT_ID = -1001234567890;

function makeAdapter(sendDocument: ReturnType<typeof vi.fn>): TelegramAdapter {
  const core = {
    configManager: { get: vi.fn().mockReturnValue({}) },
    instanceContext: { id: "attachment-test", root: "/tmp/openacp-attachment-test" },
    proxyService: {
      registerRouteTester: vi.fn().mockReturnValue(vi.fn()),
      createFetch: vi.fn().mockReturnValue(fetch),
    },
  } as any;
  const adapter = new TelegramAdapter(core, {
    enabled: true,
    botToken: "123456789:test-token",
    chatId: TELEGRAM_CHAT_ID,
    notificationTopicId: 0,
    assistantTopicId: 0,
  });
  (adapter as any).bot = { api: { sendDocument } };
  (adapter as any).sendQueue = new SendQueue({ minInterval: 0 });
  return adapter;
}

function makeRequest(options: {
  deliveryId?: string;
  sessionId?: string;
  threadId?: string;
  caption?: string;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  freezeTarget?: boolean;
} = {}): AttachmentDeliveryRequest {
  const sessionId = options.sessionId ?? "session-1";
  const targetValue = {
    schemaVersion: 1 as const,
    sessionId,
    adapterId: "telegram",
    bindingGeneration: `binding-${sessionId}`,
  };
  const target = options.freezeTarget === false ? targetValue : Object.freeze(targetValue);
  return {
    deliveryId: options.deliveryId ?? "delivery-1",
    sessionId,
    targetBinding: {
      target,
      threadId: options.threadId ?? "321",
      isCurrent: options.isCurrent ?? (() => true),
    },
    attachment: {
      filePath: "/tmp/staged-memory.md",
      fileName: "memory.md",
      mimeType: "text/markdown",
      size: 12,
      sha256: "a".repeat(64),
    },
    ...(options.caption !== undefined ? { caption: options.caption } : {}),
    signal: options.signal ?? new AbortController().signal,
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Telegram acknowledged attachment delivery", () => {
  it("returns the real provider message ID for the exact bound topic", async () => {
    inputFileCalls.length = 0;
    const sendDocument = vi.fn().mockResolvedValue({ message_id: 9123 });
    const adapter = makeAdapter(sendDocument);
    const request = makeRequest({ caption: "Saved memory" });

    const receipt = await adapter.deliverAttachment(request);

    expect(receipt).toMatchObject({
      status: "provider_accepted",
      deliveryId: "delivery-1",
      providerMessageId: "9123",
      adapterId: "telegram",
    });
    expect(Date.parse(receipt.acceptedAt)).not.toBeNaN();
    expect(inputFileCalls).toEqual([{
      file: "/tmp/staged-memory.md",
      filename: "memory.md",
    }]);
    expect(sendDocument).toHaveBeenCalledWith(
      TELEGRAM_CHAT_ID,
      expect.objectContaining({ file: "/tmp/staged-memory.md", filename: "memory.md" }),
      { message_thread_id: 321, caption: "Saved memory" },
      request.signal,
    );
  });

  it("keeps concurrent sessions isolated to their immutable topics", async () => {
    const sendDocument = vi.fn().mockImplementation(async (_chatId, _file, opts) => ({
      message_id: opts.message_thread_id + 1000,
    }));
    const adapter = makeAdapter(sendDocument);

    const [first, second] = await Promise.all([
      adapter.deliverAttachment(makeRequest({
        deliveryId: "delivery-a", sessionId: "session-a", threadId: "101",
      })),
      adapter.deliverAttachment(makeRequest({
        deliveryId: "delivery-b", sessionId: "session-b", threadId: "202",
      })),
    ]);

    expect(sendDocument.mock.calls.map((call) => call[2].message_thread_id)).toEqual([101, 202]);
    expect([first.providerMessageId, second.providerMessageId]).toEqual(["1101", "1202"]);
  });

  it("revalidates a stale binding after waiting for send capacity", async () => {
    const sendDocument = vi.fn();
    const adapter = makeAdapter(sendDocument);
    const gate = deferred();
    let current = true;
    (adapter as any).sendQueue = {
      enqueue: vi.fn(async (operation: () => Promise<unknown>) => {
        await gate.promise;
        return operation();
      }),
    };

    const pending = adapter.deliverAttachment(makeRequest({ isCurrent: () => current }));
    current = false;
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "target_stale", retryable: false });
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("does not send after the caller aborts while queued", async () => {
    const sendDocument = vi.fn();
    const adapter = makeAdapter(sendDocument);
    const gate = deferred();
    const controller = new AbortController();
    (adapter as any).sendQueue = {
      enqueue: vi.fn(async (operation: () => Promise<unknown>) => {
        await gate.promise;
        return operation();
      }),
    };

    const pending = adapter.deliverAttachment(makeRequest({ signal: controller.signal }));
    controller.abort();
    gate.resolve();

    await expect(pending).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("passes the AbortSignal into an in-flight Telegram upload", async () => {
    const controller = new AbortController();
    const sendDocument = vi.fn(
      async (_chatId, _file, _opts, signal: AbortSignal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }),
    );
    const adapter = makeAdapter(sendDocument);
    const pending = adapter.deliverAttachment(makeRequest({ signal: controller.signal }));
    await vi.waitFor(() => expect(sendDocument).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "provider_timeout", retryable: true });
    expect(sendDocument.mock.calls[0]?.[3]).toBe(controller.signal);
  });

  it.each([
    [401, "provider_rejected", false],
    [403, "provider_rejected", false],
    [429, "rate_limited", true],
    [500, "provider_unavailable", true],
  ] as const)("maps Telegram %s without returning success", async (errorCode, code, retryable) => {
    const sendDocument = vi.fn().mockRejectedValue({
      error_code: errorCode,
      description: "provider detail must stay private",
    });
    const adapter = makeAdapter(sendDocument);

    const failure = adapter.deliverAttachment(makeRequest());
    await expect(failure).rejects.toBeInstanceOf(AttachmentDeliveryError);
    await expect(failure).rejects.toMatchObject({ code, retryable });
  });

  it("maps network failures to a safe provider-unavailable error", async () => {
    const sendDocument = vi.fn().mockRejectedValue(
      new Error("fetch https://api.telegram.org/botSECRET/sendDocument failed"),
    );
    const adapter = makeAdapter(sendDocument);

    await expect(adapter.deliverAttachment(makeRequest())).rejects.toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      safeMessage: "Attachment provider is unavailable.",
    });
  });

  it("treats queue clearing and a malformed acknowledgement as failures", async () => {
    const sendDocument = vi.fn();
    const cleared = makeAdapter(sendDocument);
    (cleared as any).sendQueue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    await expect(cleared.deliverAttachment(makeRequest())).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    expect(sendDocument).not.toHaveBeenCalled();

    const malformed = makeAdapter(vi.fn().mockResolvedValue({ chat: { id: TELEGRAM_CHAT_ID } }));
    await expect(malformed.deliverAttachment(makeRequest())).rejects.toMatchObject({
      code: "internal_error",
      retryable: false,
    });
  });

  it("rejects mutable, mismatched, and invalid bindings before provider I/O", async () => {
    const sendDocument = vi.fn();
    const adapter = makeAdapter(sendDocument);

    await expect(adapter.deliverAttachment(makeRequest({ freezeTarget: false }))).rejects.toMatchObject({
      code: "target_mismatch",
    });
    await expect(adapter.deliverAttachment(makeRequest({ threadId: "not-a-topic" }))).rejects.toMatchObject({
      code: "target_stale",
    });
    await expect(adapter.deliverAttachment(makeRequest({ isCurrent: () => { throw new Error("stale"); } })))
      .rejects.toMatchObject({ code: "target_stale" });
    expect(sendDocument).not.toHaveBeenCalled();
  });
});
