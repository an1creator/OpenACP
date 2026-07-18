import { describe, expect, it, vi } from "vitest";
import { ChannelAdapter } from "../channel.js";
import { MessagingAdapter } from "../adapter-primitives/messaging-adapter.js";
import { StreamAdapter, type StreamEvent } from "../adapter-primitives/stream-adapter.js";
import { BaseRenderer } from "../adapter-primitives/rendering/renderer.js";
import { deliverAgentActionControlParts } from "../agent-action-delivery.js";
import type {
  AgentActionControlDeliveryContext,
  AgentActionControlDeliveryTarget,
  NotificationMessage,
  OutgoingMessage,
  PermissionRequest,
} from "../types.js";

const response = {
  type: "agent_action_control" as const,
  action: "skills",
  status: "completed" as const,
  chunks: ["one", "two"],
};

function context(isCurrent: () => boolean): AgentActionControlDeliveryContext {
  return {
    target: Object.freeze({
      sessionId: "session-1", adapterId: "test", threadId: "thread-1",
      attachmentGeneration: 1, agentGeneration: 1, actionEpoch: 1,
    }),
    isCurrent,
  };
}

interface TargetTestAdapter {
  sentTargets: string[];
  sendEntered: ReturnType<typeof vi.fn>;
  waitBeforeTargetSend: Promise<void>;
  bindAgentActionControlTarget(context: AgentActionControlDeliveryContext): any;
}

class LegacyTestAdapter extends ChannelAdapter implements TargetTestAdapter {
  readonly name = "test";
  readonly sentTargets: string[] = [];
  readonly sendEntered = vi.fn();
  waitBeforeTargetSend = Promise.resolve();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(): Promise<void> { throw new Error("sessionId delivery must not be used"); }
  protected async sendAgentActionMessageToTarget(
    target: Readonly<AgentActionControlDeliveryTarget>,
    _content: OutgoingMessage,
  ): Promise<void> {
    this.sendEntered();
    await this.waitBeforeTargetSend;
    this.sentTargets.push(target.threadId);
  }
  async sendPermissionRequest(_sessionId: string, _request: PermissionRequest): Promise<void> {}
  async sendNotification(_notification: NotificationMessage): Promise<void> {}
  async createSessionThread(): Promise<string> { return "thread-1"; }
  async renameSessionThread(): Promise<void> {}
}

class MessagingTestAdapter extends MessagingAdapter implements TargetTestAdapter {
  readonly name = "test";
  readonly renderer = new BaseRenderer();
  readonly capabilities = {
    streaming: false, richFormatting: false, threads: true,
    reactions: false, fileUpload: false, voice: false,
  };
  readonly sentTargets: string[] = [];
  readonly sendEntered = vi.fn();
  waitBeforeTargetSend = Promise.resolve();
  constructor() {
    super({ configManager: { get: () => ({}) } }, { enabled: true, maxMessageLength: 4_096 });
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendMessage(): Promise<void> { throw new Error("sessionId delivery must not be used"); }
  protected async sendAgentActionMessageToTarget(
    target: Readonly<AgentActionControlDeliveryTarget>,
    _content: OutgoingMessage,
  ): Promise<void> {
    this.sendEntered();
    await this.waitBeforeTargetSend;
    this.sentTargets.push(target.threadId);
  }
  async createSessionThread(): Promise<string> { return "thread-1"; }
  async renameSessionThread(): Promise<void> {}
  async sendPermissionRequest(_sessionId: string, _request: PermissionRequest): Promise<void> {}
  async sendNotification(_notification: NotificationMessage): Promise<void> {}
}

class StreamTestAdapter extends StreamAdapter implements TargetTestAdapter {
  readonly name = "test";
  readonly sentTargets: string[] = [];
  readonly sendEntered = vi.fn();
  waitBeforeTargetSend = Promise.resolve();
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  protected async emit(): Promise<void> { throw new Error("sessionId delivery must not be used"); }
  protected async broadcast(): Promise<void> {}
  protected async emitToAgentActionTarget(
    target: Readonly<AgentActionControlDeliveryTarget>,
    _event: StreamEvent,
  ): Promise<void> {
    this.sendEntered();
    await this.waitBeforeTargetSend;
    this.sentTargets.push(target.threadId);
  }
}

class NoTargetLegacyAdapter extends ChannelAdapter {
  readonly name = "test";
  readonly sendMessage = vi.fn().mockResolvedValue(undefined);
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async sendPermissionRequest(): Promise<void> {}
  async sendNotification(): Promise<void> {}
  async createSessionThread(): Promise<string> { return "thread-1"; }
  async renameSessionThread(): Promise<void> {}
}

describe("agent action immutable target bindings", () => {
  it.each([
    ["ChannelAdapter", () => new LegacyTestAdapter({}, { enabled: true })],
    ["MessagingAdapter", () => new MessagingTestAdapter()],
    ["StreamAdapter", () => new StreamTestAdapter()],
  ])("keeps %s on the old target when remap happens during awaited first send", async (_name, createAdapter) => {
    const adapter = createAdapter() as TargetTestAdapter;
    let current = true;
    let release!: () => void;
    adapter.waitBeforeTargetSend = new Promise<void>((resolve) => { release = resolve; });
    const deliveryContext = context(() => current);
    const binding = adapter.bindAgentActionControlTarget(deliveryContext);
    expect(binding?.target).toBe(deliveryContext.target);

    const pending = deliverAgentActionControlParts(
      response,
      response.chunks,
      { target: deliveryContext.target, isCurrent: () => current && binding!.isCurrent() },
      (part, index) => binding!.sendPart(response, part, index),
    );
    await vi.waitFor(() => expect(adapter.sendEntered).toHaveBeenCalledOnce());
    current = false;
    release();

    expect(await pending).toMatchObject({
      status: "partial", deliveredParts: 1, totalParts: 2, reason: "stale-target",
    });
    expect(adapter.sentTargets).toEqual(["thread-1"]);
    expect(adapter.sentTargets).not.toContain("thread-2");
  });

  it("returns no binding instead of falling back to lazy sessionId resolution", () => {
    const adapter = new NoTargetLegacyAdapter({}, { enabled: true });
    expect(adapter.bindAgentActionControlTarget(context(() => true))).toBeNull();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });
});
