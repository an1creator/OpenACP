# Building Adapters

This guide walks through building a complete custom channel adapter from scratch.

---

## What Is a ChannelAdapter?

A `ChannelAdapter` is the bridge between OpenACP's core and a specific messaging platform. It has two responsibilities:

- **Inbound**: receive messages from the platform and call `core.handleIncomingMessage()`.
- **Outbound**: implement methods that core calls to deliver agent output back to the platform.

OpenACP provides an abstract base class `ChannelAdapter<TCore>` with default no-op implementations for optional methods. You extend it and implement the required abstracts.

---

## Message Flow

```
Platform user sends message
        ↓
  YourAdapter (platform SDK listener)
        ↓
  core.handleIncomingMessage(IncomingMessage)
        ↓
  OpenACPCore → Session → AgentInstance (ACP subprocess)
        ↓
  AgentEvents emitted
        ↓
  core calls adapter.sendMessage() / sendPermissionRequest() / sendNotification()
        ↓
  YourAdapter delivers to platform
```

The adapter is always the outermost layer. Core never talks to the platform directly.

---

## Step 1 — Extend ChannelAdapter

```typescript
import { ChannelAdapter, type ChannelConfig } from '@n1creator/openacp-cli'
import type {
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
} from '@n1creator/openacp-cli'
import type { OpenACPCore } from '@n1creator/openacp-cli'

export class MyPlatformAdapter extends ChannelAdapter<OpenACPCore> {
  constructor(core: OpenACPCore, config: ChannelConfig) {
    super(core, config)
  }
  // ...
}
```

The generic parameter `TCore` types `this.core`. Use `OpenACPCore` for full type safety.

---

## Step 2 — Implement start() and stop()

`start()` initializes your platform SDK, registers listeners, and begins receiving messages. `stop()` tears everything down cleanly.

```typescript
async start(): Promise<void> {
  // Initialize platform client
  this.client = new MyPlatformClient(this.config.token as string)

  // Register inbound listener
  this.client.on('message', (msg) => this.handlePlatformMessage(msg))

  await this.client.connect()
}

async stop(): Promise<void> {
  await this.client?.disconnect()
}
```

---

## Step 3 — Handle Inbound Messages

When the platform delivers a user message, convert it to `IncomingMessage` and call `core.handleIncomingMessage()`:

```typescript
private async handlePlatformMessage(msg: PlatformMessage): Promise<void> {
  await this.core.handleIncomingMessage({
    channelId: 'myplatform',
    threadId: msg.threadId,
    userId: msg.authorId,
    text: msg.content,
    // attachments: [...] — optional
  })
}
```

`handleIncomingMessage` looks up or creates a session for the `(channelId, threadId, userId)` combination and enqueues the prompt.

---

## Step 4 — Implement sendMessage()

Core calls `sendMessage()` for every agent output event (text chunks, tool calls, usage summaries, errors, etc.).

```typescript
async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
  const threadId = this.getThreadId(sessionId)

  switch (content.type) {
    case 'text':
      await this.client.sendText(threadId, content.text)
      break
    case 'thought':
      // Display or suppress agent reasoning — platform-specific choice
      await this.client.sendText(threadId, `_${content.text}_`)
      break
    case 'tool_call':
      await this.client.sendText(threadId, `Using tool: ${content.text}`)
      break
    case 'error':
      await this.client.sendText(threadId, `Error: ${content.text}`)
      break
    case 'session_end':
      // Agent finished — optionally close/archive the thread
      break
  }
}
```

`OutgoingMessage.type` can be: `text`, `thought`, `tool_call`, `tool_update`, `plan`, `usage`, `session_end`, `error`, `attachment`, `system_message`. You decide which types to surface in your UI.

### Local agent-control responses

Short connector-neutral responses such as the local skills inventory require an immutable transport binding. `sendMessage(sessionId, ...)` is not a safe fallback because an asynchronous adapter may resolve that session to a different thread before it writes. An adapter that cannot bind an exact target drops the response before sending data.

When extending `ChannelAdapter` or `MessagingAdapter`, implement the target-bound primitive:

```typescript
protected async sendAgentActionMessageToTarget(target, content) {
  await this.client.sendText(target.threadId, content.text)
}
```

The base class exposes this through `bindAgentActionControlTarget()`. Direct `IChannelAdapter` implementations can implement that binder themselves and return an `AgentActionControlTargetBinding`. Its `target` must be the exact object supplied by core, and `sendPart()` must return `"stale"` without writing if authorization changes while it waits for transport capacity.

The target contains the exact session, adapter, thread, attachment generation, agent generation, and action epoch captured by core. Core revalidates it before and after every part and returns `completed`, `partial`, `dropped`, or `failed` with delivered-part counts. The transport must use the captured thread or connection identity directly; never resolve it again from `sessionId`. SSE-style adapters must capture the current connection objects and must not buffer this response for future connections. A detach, remap, adapter replacement, agent switch, or termination stops remaining parts.

### Optional acknowledged attachment delivery

If the platform supports file upload with a real provider acknowledgement, set
`capabilities.fileUpload` to `true` and implement `deliverAttachment()`. This
method is separate from `sendMessage()` so legacy adapters and normal message
delivery keep their existing behavior.

When configured capability does not prove current provider readiness, also
implement the side-effect-free `isOperational(): boolean` probe. Attachment
health uses it for the adapter's `available` field, and resolution plus delivery
revalidation fail while it is false. Legacy adapters that omit it remain
compatible.

```typescript
import type {
  AttachmentDeliveryReceipt,
  AttachmentDeliveryRequest,
} from '@n1creator/openacp-plugin-sdk'

async deliverAttachment(
  request: AttachmentDeliveryRequest,
): Promise<AttachmentDeliveryReceipt> {
  if (request.signal.aborted || !request.targetBinding.isCurrent()) {
    throw new Error('Attachment target is no longer current')
  }

  const result = await this.sendQueue.enqueue(async () => {
    // Capacity waits are a mutable boundary: revalidate inside the operation.
    if (request.signal.aborted || !request.targetBinding.isCurrent()) {
      throw new Error('Attachment target is no longer current')
    }
    return this.client.sendFile(
      request.targetBinding.threadId,
      request.attachment.filePath,
      {
        fileName: request.attachment.fileName,
        mimeType: request.attachment.mimeType,
        caption: request.caption,
        signal: request.signal,
      },
    )
  })

  if (!result.messageId) throw new Error('Provider returned no message ID')
  return {
    status: 'provider_accepted',
    deliveryId: request.deliveryId,
    providerMessageId: String(result.messageId),
    adapterId: this.name,
    acceptedAt: new Date().toISOString(),
  }
}
```

The request contains a staged local path for adapter use only. Its immutable
binding already owns the exact private destination; never look up a replacement
thread from `sessionId`, mutate the target, or expose the path/thread/provider
credentials in a response. Forward the abort signal, reject before writing when
the binding is stale, and reject every provider, queue, timeout, rate-limit, or
invalid-receipt failure. Return success only with the provider's actual message
ID. See the [Adapter Reference](adapter-reference.md#acknowledged-attachment-delivery)
for the exact types.

---

## Step 5 — Implement sendPermissionRequest()

When an agent needs user approval before taking an action, core calls `sendPermissionRequest()`. You must render the options and eventually call `core.resolvePermission()`.

```typescript
async sendPermissionRequest(
  sessionId: string,
  request: PermissionRequest
): Promise<void> {
  const threadId = this.getThreadId(sessionId)

  // Build a list of buttons/options and send to platform
  const optionLabels = request.options.map((o) => o.label)
  const userChoice = await this.client.promptWithButtons(
    threadId,
    request.description,
    optionLabels,
  )

  const chosen = request.options.find((o) => o.label === userChoice)
  if (chosen) {
    await this.core.resolvePermission(sessionId, request.id, chosen.id)
  }
}
```

---

## Step 6 — Implement sendNotification()

Notifications are summary alerts (session completed, error, budget warning). They are typically sent to a dedicated notification channel or thread.

```typescript
async sendNotification(notification: NotificationMessage): Promise<void> {
  const text = `[${notification.type}] ${notification.summary}`
  await this.client.sendToNotificationsChannel(text)
}
```

---

## Step 7 — Implement Session Thread Lifecycle

Core manages sessions and expects the adapter to maintain corresponding UI threads (channels, topics, threads):

```typescript
async createSessionThread(sessionId: string, name: string): Promise<string> {
  // Create a thread or channel for this session
  const thread = await this.client.createThread(name)
  // sessionId can be empty while Core pre-creates the thread before agent startup.
  if (sessionId) this.sessionThreads.set(sessionId, thread.id)
  return thread.id  // return the platform thread ID
}

async renameSessionThread(sessionId: string, newName: string): Promise<void> {
  const threadId = this.sessionThreads.get(sessionId)
  if (threadId) await this.client.renameThread(threadId, newName)
}

async deleteSessionThreadById(threadId: string): Promise<void> {
  // Optional, but recommended for threaded platforms. Core calls this when
  // startup or the initial durable session write fails after thread creation.
  await this.client.deleteThread(threadId)
}
```

`newName` has already passed the connector-neutral core naming policy. New
manual names are single-line values of at most 200 characters; generated names
contain at most 5 words and 50 characters. Adapters should render the supplied
value and must not derive a title from the raw user prompt.

`deleteSessionThread(sessionId)` and `archiveSessionTopic(sessionId)` are optional
session-aware cleanup hooks with base-class no-op defaults.
`deleteSessionThreadById(threadId)` is an optional capability without a base
default, so Core can detect support. Implement it when `createSessionThread`
creates a remote resource: Core uses it to remove a pre-created thread even when
agent startup fails before a `Session` record exists. Adapters that omit it remain
compatible; Core falls back to `deleteSessionThread(sessionId)` once a session ID
is available.

---

## Step 8 — Register With Core

Before calling `core.start()`, register your adapter:

```typescript
import { OpenACPCore } from '@n1creator/openacp-cli'
import { MyPlatformAdapter } from './adapter.js'

const core = new OpenACPCore(config)
const adapter = new MyPlatformAdapter(core, config.adapters.myplatform)
core.registerAdapter('myplatform', adapter)
await core.start()
```

---

## Step 9 — Package as a Plugin

Adapter plugins implement `OpenACPPlugin` and register themselves in `setup()`:

```typescript
import type {
  OpenACPCore,
  OpenACPPlugin,
  PluginContext,
} from '@n1creator/openacp-plugin-sdk'
import { MyPlatformAdapter } from './adapter.js'

const plugin: OpenACPPlugin = {
  name: '@myorg/adapter-myplatform',
  version: '1.0.0',
  description: 'MyPlatform adapter for OpenACP',
  permissions: ['services:register', 'kernel:access'],
  async setup(ctx: PluginContext) {
    const core = ctx.core as OpenACPCore
    const adapter = new MyPlatformAdapter(core, {
      ...ctx.pluginConfig,
      enabled: true,
    })
    ctx.registerService('adapter:myplatform', adapter)
  },
}

export default plugin
```

`services:register` permits the `adapter:myplatform` service registration.
This example also declares `kernel:access` because `MyPlatformAdapter` needs the
real `OpenACPCore` from `ctx.core`; omit that permission when an adapter does not
access kernel APIs. During startup, OpenACP discovers `adapter:*` services and
wires them into core with `core.registerAdapter()`.

Adapter implementations can extend `MessagingAdapter` (for platforms with threads/topics) or `StreamAdapter` (for simpler integrations) from `@n1creator/openacp-plugin-sdk`, instead of extending `ChannelAdapter` directly.

> **Note:** The previous `AdapterFactory` pattern is no longer used. All adapter registration now goes through the plugin system.

---

## Complete Minimal Adapter

```typescript
import { ChannelAdapter } from '@n1creator/openacp-cli'
import type {
  ChannelConfig,
  OutgoingMessage,
  PermissionRequest,
  NotificationMessage,
} from '@n1creator/openacp-cli'
import type { OpenACPCore } from '@n1creator/openacp-cli'

export class MinimalAdapter extends ChannelAdapter<OpenACPCore> {
  private sessionThreads = new Map<string, string>()

  async start(): Promise<void> {
    // connect platform SDK, register listeners
  }

  async stop(): Promise<void> {
    // disconnect
  }

  async sendMessage(sessionId: string, content: OutgoingMessage): Promise<void> {
    if (content.type === 'text') {
      console.log(`[${sessionId}] ${content.text}`)
    }
  }

  async sendPermissionRequest(
    sessionId: string,
    request: PermissionRequest,
  ): Promise<void> {
    // Render request.options, collect user input, call core.resolvePermission()
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    console.log(`[notification] ${notification.summary}`)
  }

  async createSessionThread(sessionId: string, name: string): Promise<string> {
    this.sessionThreads.set(sessionId, sessionId)
    return sessionId
  }

  async renameSessionThread(sessionId: string, newName: string): Promise<void> {
    // update thread name in platform
  }
}
```
