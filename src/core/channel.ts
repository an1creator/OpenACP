import type { OutgoingMessage, PermissionRequest, NotificationMessage, AgentActionControlDeliveryContext, AgentActionControlDeliveryResult, AgentActionControlResponse, AgentActionControlTargetBinding, AgentActionControlDeliveryTarget, AgentCommand, ElicitationRequest, ElicitationResolvedEvent, AttachmentDeliveryRequest, AttachmentDeliveryReceipt } from './types.js'

/**
 * Configuration for an adapter channel (Telegram, Slack, etc.).
 * Each adapter defines its own fields beyond `enabled`.
 */
export interface ChannelConfig {
  enabled: boolean
  [key: string]: unknown
}

/**
 * Declares what a messaging platform supports. Core uses these to decide
 * whether to attempt features like streaming, file uploads, or voice.
 */
export interface AdapterCapabilities {
  streaming: boolean
  richFormatting: boolean
  threads: boolean
  reactions: boolean
  fileUpload: boolean
  voice: boolean
  /** Optional ACP form input rendering support. */
  elicitation?: {
    form?: boolean
    secureInput?: 'none' | 'private' | 'delete-after-capture'
  }
}

/**
 * Contract for a messaging platform adapter.
 *
 * A "channel" in OpenACP is identified by an adapter name (e.g. "telegram", "slack").
 * Each session binds to a channel + thread ID — together they form a unique conversation
 * location. The adapter is responsible for platform-specific I/O: sending messages,
 * creating threads/topics, handling permission buttons, etc.
 *
 * Core calls adapter methods via SessionBridge (for agent events) or directly
 * (for session lifecycle operations like thread creation and archiving).
 */
export interface IChannelAdapter {
  readonly name: string
  readonly capabilities: AdapterCapabilities

  /** Report whether the adapter can currently accept new provider operations. */
  isOperational?(): boolean

  start(): Promise<void>
  stop(): Promise<void>

  // --- Outgoing: core → platform ---
  sendMessage(sessionId: string, content: OutgoingMessage): Promise<void>
  /**
   * Deliver a file to an immutable target and return the provider acknowledgement.
   * Implementations must cooperate with `request.signal` and revalidate the target
   * immediately before every provider I/O so queued or timed-out work cannot late-send.
   */
  deliverAttachment?(request: AttachmentDeliveryRequest): Promise<AttachmentDeliveryReceipt>
  sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void>
  sendElicitationRequest?(sessionId: string, request: ElicitationRequest): Promise<void>
  dismissElicitationRequest?(sessionId: string, event: ElicitationResolvedEvent): Promise<void>
  sendNotification(notification: NotificationMessage): Promise<void>

  // --- Session lifecycle on platform side ---
  /** Create a thread/topic for a session. Returns the platform-specific thread ID. */
  createSessionThread(sessionId: string, name: string): Promise<string>
  renameSessionThread(sessionId: string, newName: string): Promise<void>
  deleteSessionThread?(sessionId: string): Promise<void>
  /** Delete a connector thread that was created before a Session record existed. */
  deleteSessionThreadById?(threadId: string): Promise<void>
  archiveSessionTopic?(sessionId: string): Promise<void>

  // TTS strip — optional, called after TTS audio is synthesized to remove [TTS] block from text
  stripTTSBlock?(sessionId: string): Promise<void>

  // --- Skill commands — optional, for agents that expose interactive commands ---
  sendSkillCommands?(sessionId: string, commands: AgentCommand[]): Promise<void>
  /** Bind one delivery to an immutable platform target before any part is written. */
  bindAgentActionControlTarget?(
    context: AgentActionControlDeliveryContext,
  ): AgentActionControlTargetBinding | null
  /** @deprecated Core requires bindAgentActionControlTarget and no longer invokes this method. */
  sendAgentActionControlResponse?(
    sessionId: string,
    response: AgentActionControlResponse,
    context: AgentActionControlDeliveryContext,
  ): Promise<AgentActionControlDeliveryResult>
  /** Clear pinned actions and pending action input owned by this adapter. */
  cleanupAgentActionState?(sessionId: string): Promise<void>
  cleanupSkillCommands?(sessionId: string): Promise<void>
  /** Flush skill commands that were queued before threadId was available. */
  flushPendingSkillCommands?(sessionId: string): Promise<void>

  // Agent switch cleanup — optional, called when switching agents to clear adapter-side per-session state
  cleanupSessionState?(sessionId: string): Promise<void>

  // --- User-targeted notifications (optional) ---
  /** Send a notification directly to a user by platform ID. Best-effort delivery. */
  sendUserNotification?(
    platformId: string,
    message: NotificationMessage,
    options?: {
      via?: 'dm' | 'thread' | 'topic'
      topicId?: string
      sessionId?: string
      platformMention?: { platformUsername?: string; platformId: string }
    }
  ): Promise<void>
}

/**
 * Original base class for channel adapters. Provides default no-op implementations
 * for optional IChannelAdapter methods so subclasses only need to implement the
 * methods they care about.
 *
 * This class predates the adapter-primitives package. It has since been superseded
 * by MessagingAdapter and StreamAdapter, which add structured send queuing, streaming
 * support, and platform-specific rendering out of the box.
 *
 * @deprecated Use MessagingAdapter or StreamAdapter instead. Kept for backward compat during migration.
 */
export abstract class ChannelAdapter<TCore = unknown> implements IChannelAdapter {
  abstract readonly name: string
  readonly capabilities: AdapterCapabilities = {
    streaming: false, richFormatting: false, threads: false,
    reactions: false, fileUpload: false, voice: false,
  }

  constructor(public readonly core: TCore, protected config: ChannelConfig) {}

  abstract start(): Promise<void>
  abstract stop(): Promise<void>

  abstract sendMessage(sessionId: string, content: OutgoingMessage): Promise<void>
  abstract sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void>
  abstract sendNotification(notification: NotificationMessage): Promise<void>

  abstract createSessionThread(sessionId: string, name: string): Promise<string>
  abstract renameSessionThread(sessionId: string, newName: string): Promise<void>
  async deleteSessionThread(_sessionId: string): Promise<void> {}

  async sendSkillCommands(_sessionId: string, _commands: AgentCommand[]): Promise<void> {}
  /** Override only when the platform can send to this exact target without resolving sessionId again. */
  protected sendAgentActionMessageToTarget?(
    target: Readonly<AgentActionControlDeliveryTarget>,
    content: OutgoingMessage,
  ): Promise<void>
  bindAgentActionControlTarget(
    context: AgentActionControlDeliveryContext,
  ): AgentActionControlTargetBinding | null {
    const sendToTarget = this.sendAgentActionMessageToTarget;
    if (!sendToTarget) return null;
    return {
      target: context.target,
      isCurrent: () => context.isCurrent(),
      sendPart: async (_response, part) => {
        if (!context.isCurrent()) return "stale";
        await sendToTarget.call(this, context.target, { type: "text", text: part });
      },
    };
  }
  async cleanupSkillCommands(_sessionId: string): Promise<void> {}
  async cleanupSessionState(_sessionId: string): Promise<void> {}
  async archiveSessionTopic(_sessionId: string): Promise<void> {}
  async sendUserNotification(_platformId: string, _message: NotificationMessage, _options?: any): Promise<void> {}
}
