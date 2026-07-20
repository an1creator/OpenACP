# Adapter Reference

Complete API reference for the `ChannelAdapter` abstract class and the types it works with.

---

## ChannelAdapter Methods

### Required (abstract)

| Method | Signature | Description |
|--------|-----------|-------------|
| `start` | `() => Promise<void>` | Connect to the platform, register listeners, begin accepting messages. |
| `stop` | `() => Promise<void>` | Disconnect from the platform and release all resources. |
| `sendMessage` | `(sessionId: string, content: OutgoingMessage) => Promise<void>` | Deliver agent output to the session's thread. Called for every agent event. |
| `sendPermissionRequest` | `(sessionId: string, request: PermissionRequest) => Promise<void>` | Present a permission prompt to the user and collect their choice. |
| `sendNotification` | `(notification: NotificationMessage) => Promise<void>` | Send a summary notification (completion, error, budget warning). |
| `createSessionThread` | `(sessionId: string, name: string) => Promise<string>` | Create a platform thread/channel for a new session. Returns the platform thread ID. |
| `renameSessionThread` | `(sessionId: string, newName: string) => Promise<void>` | Rename the platform thread after auto-naming resolves. |

### Optional

| Method | Signature | Description |
|--------|-----------|-------------|
| `isOperational` | `() => boolean` | Report whether the adapter can currently accept provider operations. Optional; implement it when configured capability differs from runtime readiness. |
| `deleteSessionThread` | `(sessionId: string) => Promise<void>` | Delete the platform thread when a session is cleaned up. |
| `deleteSessionThreadById` | `(threadId: string) => Promise<void>` | Delete a thread created before the initial session record is durable. Recommended when `createSessionThread` creates a remote resource. |
| `deliverAttachment` | `(request: AttachmentDeliveryRequest) => Promise<AttachmentDeliveryReceipt>` | Deliver a staged file to the immutable bound target and return a real provider acknowledgement. |
| `sendElicitationRequest` | `(sessionId: string, request: ElicitationRequest) => Promise<void>` | Present a transient ACP form request when `capabilities.elicitation.form` is true. |
| `dismissElicitationRequest` | `(sessionId: string, event: ElicitationResolvedEvent) => Promise<void>` | Remove or disable stale form UI after any resolution. Resolution metadata contains no submitted values. |
| `sendSkillCommands` | `(sessionId: string, commands: AgentCommand[]) => Promise<void>` | Register dynamic slash commands or menu entries surfaced by the agent. |
| `cleanupSkillCommands` | `(sessionId: string) => Promise<void>` | Remove dynamic commands when the session ends. |
| `archiveSessionTopic` | `(sessionId: string) => Promise<void>` | Archive (rather than delete) the session thread — for platforms that support it (e.g. Telegram forum topics). |

The legacy `ChannelAdapter` base class provides no-op defaults for the
session-aware hooks, but intentionally does not implement
`deleteSessionThreadById`. This lets Core distinguish adapters that can clean up
a pre-created remote thread by its platform ID. Existing adapters do not need to
add the method; it is optional, and Core retains the session-ID fallback.

An adapter that renders ACP forms declares:

```typescript
capabilities: {
  // existing capability fields...
  elicitation: {
    form: true,
    secureInput: 'none' // or 'private' / 'delete-after-capture'
  }
}
```

`form` enables structured field delivery. `secureInput` describes the platform
guarantee; it does not turn standard ACP fields into secrets. OpenACP uses
protected input only for the Codex `isSecret` extension and fails closed if the
target connector cannot meet the declared guarantee. Adapters must bind replies
to the initiating conversation and user, keep callback identifiers short, and
call the session elicitation gate exactly once. They must never copy submitted
values into logs, visible confirmation messages, or resolution events.
ForceReply handlers must match the exact form prompt before command routing;
slash-prefixed values are valid form content, while replies to unrelated agent
command prompts must continue to the owning command router. Concurrent forms in
one conversation must bind text replies to the exact prompt message and owner,
not just to the topic. If any initial or mid-form send/edit fails, the adapter
must clear partial content, dismiss the remaining UI with bounded best-effort
cleanup, and cancel the gate exactly once. Request IDs are scoped by session, so
adapter lookup keys must include both `sessionId` and `requestId`. Every form also
needs a serialized transition boundary: duplicate callbacks, text replies, and
cancel actions must re-check the field generation after acquiring it, and a stale
action must never advance or cancel the active field. String `pattern`
constraints are rejected by Core and must not be evaluated by adapters.

### Constructor

```typescript
constructor(core: TCore, config: ChannelConfig)
```

Both values are stored as public/protected properties:

- `this.core` — the `OpenACPCore` instance (typed by generic `TCore`)
- `this.config` — the raw config block for this adapter from `<instance-root>/config.json`

---

## Key Types

### IncomingMessage

Represents a message arriving from a user on the platform. Pass this to `core.handleIncomingMessage()`.

```typescript
interface IncomingMessage {
  channelId: string       // Adapter identifier, e.g. "telegram" or "discord"
  threadId: string        // Platform thread/channel/topic ID
  userId: string          // Platform user ID
  text: string            // Message content
  attachments?: Attachment[]
}
```

### Attachment

```typescript
interface Attachment {
  type: 'image' | 'audio' | 'file'
  filePath: string        // Local path after download
  fileName: string
  mimeType: string
  size: number
  originalFilePath?: string
}
```

### Acknowledged attachment delivery

The CLI and plugin SDK export these additive adapter types:

```typescript
interface AttachmentDeliveryTarget {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly adapterId: string
  readonly bindingGeneration: string
}

interface AttachmentTargetBinding {
  readonly target: Readonly<AttachmentDeliveryTarget>
  readonly threadId: string
  isCurrent(): boolean
}

interface AttachmentDeliveryRequest {
  readonly deliveryId: string
  readonly sessionId: string
  readonly targetBinding: AttachmentTargetBinding
  readonly attachment: {
    readonly filePath: string
    readonly fileName: string
    readonly mimeType: string
    readonly size: number
    readonly sha256: string
  }
  readonly caption?: string
  readonly signal: AbortSignal
}

interface AttachmentDeliveryReceipt {
  readonly status: 'provider_accepted'
  readonly deliveryId: string
  readonly providerMessageId: string
  readonly adapterId: string
  readonly acceptedAt: string
}
```

`deliverAttachment()` is optional for backward compatibility. Existing adapters
remain valid, and the semantics of `sendMessage(): Promise<void>` do not change.
An adapter participates in acknowledged delivery only when
`capabilities.fileUpload` is true and `deliverAttachment` is implemented.
If runtime readiness can differ from configured capability, implement
`isOperational()` as a side-effect-free probe. Attachment health reports its
result as `available`, and target resolution plus delivery revalidation reject
with retryable `provider_unavailable` while it is false. Omitting it preserves
compatibility and is treated as available while the service is open.

The binding is immutable and host-owned. `threadId` is the exact private
provider destination captured by Core; never resolve a new destination from
`sessionId` or expose `threadId` outside the adapter. Check `isCurrent()` after
waiting for send capacity and immediately before provider I/O, and pass
`request.signal` to the provider operation. A stale or aborted operation must
reject without sending. The currentness check covers session lifecycle, agent
generation, adapter identity, runtime readiness, capability, and the exact
topic/thread lease.

Return a receipt only after the provider accepts the file and returns a real,
non-empty message ID. Preserve `deliveryId`, use the adapter's registered ID,
and serialize `acceptedAt` as an ISO timestamp. Provider rejection, timeout,
queue failure, rate limiting, and invalid acknowledgement must reject; do not
convert them to `void` or a synthetic success. The built-in Telegram adapter
uses `sendDocument` and returns its real `message_id` as a string.

### OutgoingMessage

Delivered to `sendMessage()`. The `type` field tells you what kind of agent output this is.

```typescript
interface OutgoingMessage {
  type:
    | 'text'            // Agent response text
    | 'thought'         // Internal agent reasoning
    | 'tool_call'       // A tool/command being invoked
    | 'tool_update'     // Progress update on a running tool
    | 'plan'            // Step-by-step plan from the agent
    | 'usage'           // Token/cost usage summary
    | 'session_end'     // Agent has finished the session
    | 'error'           // An error occurred
    | 'attachment'      // A file or image output
    | 'system_message'  // Internal system-level message
  text: string
  metadata?: Record<string, unknown>
  attachment?: Attachment
}
```

### PermissionRequest

Sent to `sendPermissionRequest()`. The adapter must present the options to the user and call `core.resolvePermission(sessionId, request.id, chosenOptionId)`.

```typescript
interface PermissionRequest {
  id: string                  // Unique request ID — pass back to core.resolvePermission()
  description: string         // Human-readable description of what needs approval
  options: PermissionOption[]
}

interface PermissionOption {
  id: string       // Pass to core.resolvePermission() as chosenOptionId
  label: string    // Display label for the button/option
  isAllow: boolean // Whether this option grants permission
}
```

### NotificationMessage

Sent to `sendNotification()`. Typically delivered to a dedicated notifications channel, not the session thread.

```typescript
interface NotificationMessage {
  sessionId: string
  sessionName?: string
  type: 'completed' | 'error' | 'permission' | 'input_required' | 'budget_warning'
  summary: string
  deepLink?: string   // Optional URL linking back to the session thread
}
```

### AgentCommand

Used in `sendSkillCommands()`. Represents a dynamic slash command or action the agent has registered.

```typescript
interface AgentCommand {
  name: string
  description: string
  input?: unknown
  _meta?: Record<string, unknown> | null
}
```

Adapters must preserve `input` and opaque ACP `_meta` fields. Interactive action callbacks should stay distinct from the adapter's system-command namespace and must forward the advertised command with exactly one leading `/`.

### ChannelConfig

Passed as the second constructor argument. At minimum it carries `enabled: boolean`, plus any adapter-specific fields from config.

```typescript
interface ChannelConfig {
  enabled: boolean
  [key: string]: unknown
}
```

### Plugin Registration (replaces AdapterFactory)

Adapter plugins now implement the `OpenACPPlugin` interface. Instead of exporting an `AdapterFactory`, plugins register their adapter in the `setup()` method:

```typescript
import type {
  OpenACPCore,
  OpenACPPlugin,
  PluginContext,
} from '@n1creator/openacp-plugin-sdk'

const plugin: OpenACPPlugin = {
  name: '@myorg/adapter-myplatform',
  version: '1.0.0',
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
```

`services:register` permits adapter service registration. `kernel:access` is
required here only because the constructor receives `ctx.core`; omit it when an
adapter does not access kernel APIs. OpenACP discovers `adapter:*` services at
startup and registers them with core.

Adapter implementations should extend `MessagingAdapter` (for full-featured platforms with threads/topics) or `StreamAdapter` (for simpler stream-based integrations) from `@n1creator/openacp-plugin-sdk`.

---

## Adapter Lifecycle

```
new MyAdapter(core, config)
        ↓
  ctx.registerService('adapter:<id>', adapter)
        ↓
  bootstrap calls core.registerAdapter(id, adapter)
        ↓
  core.start() → adapter.start()
        ↓
  [running: inbound and outbound events flow]
        ↓
  core.stop() → adapter.stop()
```

During the running phase, the order of calls is:

1. User sends message → adapter calls `core.handleIncomingMessage()`
2. Core creates/resumes session, enqueues prompt
3. Agent emits events → core calls `adapter.sendMessage()` for each
4. Agent needs approval → core calls `adapter.sendPermissionRequest()`
5. Session completes → core calls `adapter.sendNotification()`
6. If auto-naming is configured → core calls `adapter.renameSessionThread()` after first prompt

---

## AgentEvent Types

`AgentEvent` is the union type emitted by `AgentInstance`. Adapters do not consume these directly — core translates them into `OutgoingMessage` calls on the adapter. For reference:

| `type` | Key fields | Description |
|--------|-----------|-------------|
| `text` | `content: string` | Agent response text chunk |
| `thought` | `content: string` | Internal agent reasoning |
| `tool_call` | `id`, `name`, `status`, `content` | A tool invocation |
| `tool_update` | `id`, `name`, `status`, `content` | Progress update on a tool call |
| `plan` | `entries: PlanEntry[]` | Multi-step plan with status per entry |
| `usage` | `tokensUsed`, `contextSize`, `cost` | Resource usage summary |
| `commands_update` | `commands: AgentCommand[]` | Dynamic commands from the agent |
| `image_content` | `data: string`, `mimeType: string` | Base64 image output |
| `audio_content` | `data: string`, `mimeType: string` | Base64 audio output |
| `session_end` | `reason: string` | Agent has ended the session |
| `error` | `message: string` | An error from the agent |
| `system_message` | `message: string` | Internal system message |
