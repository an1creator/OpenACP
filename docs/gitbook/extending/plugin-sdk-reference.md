# Plugin SDK Reference

## Scoped network transport

Plugins with service access can resolve `ProxyService` from the SDK, register a
stable scope, and retain the returned fetch facade:

```typescript
const proxy = ctx.getService<ProxyService>('proxy')
proxy.registerScope('plugins.example.api')
const fetchApi = proxy.createFetch('plugins.example.api')
```

The SDK intentionally exposes the portable subset that OpenACP guarantees:
`string | URL` input; `string`, `URLSearchParams`, `Blob`, or `FormData` request
bodies; standard request options; a native `Response`; and Web `ReadableStream`
response bodies. Web streams are deliberately excluded from request bodies
because the internal node-fetch transport does not consume them safely. OpenACP
may use Node streams internally, but normalizes responses at this boundary. Each
call resolves the latest route; consumers must consume or cancel response bodies
so retired transports can be released promptly.

The `@n1creator/openacp-plugin-sdk` package provides types, base classes, adapter primitives, and testing utilities for building OpenACP plugins.

---

## Installation

Use Node.js 22 or newer; Node.js 24 LTS is recommended.

```bash
npm install --save-dev @n1creator/openacp-plugin-sdk
```

---

## Type Exports

All types are re-exported from the main entry point:

```typescript
import type { OpenACPPlugin, PluginContext } from '@n1creator/openacp-plugin-sdk'
```

### Plugin Interfaces

| Type | Description |
|---|---|
| `OpenACPPlugin` | Main plugin interface. All plugins must default-export an object matching this shape. |
| `PluginContext` | Context passed to `setup()`. Provides services, events, commands, middleware, storage, and logging. |
| `PluginPermission` | Union type of all permission strings (e.g., `'events:read'`, `'services:register'`). |
| `PluginStorage` | Key-value storage interface available via `ctx.storage`. |
| `InstallContext` | Context passed to `install()`, `configure()`, and `uninstall()`. Provides terminal I/O and settings. |
| `MigrateContext` | Context passed to `migrate()`. Provides logging. |
| `TerminalIO` | Interactive terminal interface wrapping `@clack/prompts`. |
| `SettingsAPI` | Read/write interface for plugin settings. |

### Command Types

| Type | Description |
|---|---|
| `CommandDef` | Command definition including name, description, usage, category, and handler. |
| `CommandArgs` | Arguments passed to a command handler (raw text, sessionId, channelId, userId, reply function). |
| `CommandResponse` | Response from a command handler (text, error, menu, list, etc.). |
| `MenuOption` | A selectable option in a menu-type command response. |
| `ListItem` | An item in a list-type command response. |

### Service Interfaces

| Type | Description |
|---|---|
| `SecurityService` | Access control and session limit checking. |
| `FileServiceInterface` | File saving, resolving, and format conversion. |
| `NotificationService` | Send notifications to users. |
| `UsageService` | Token/cost tracking and budget checking. |
| `SpeechServiceInterface` | Text-to-speech and speech-to-text. |
| `TunnelServiceInterface` | Port tunneling and public URL management. |
| `ContextService` | Context building and provider registration for agent sessions. |

### Speech service and provider contract

The CLI and SDK export the same `SpeechServiceInterface`, `STTProvider`, and
`TTSProvider` shapes. Runtime methods are `synthesize()`, `transcribe()`,
`registerTTSProvider()`, `unregisterTTSProvider()`, `registerSTTProvider()`,
`isTTSAvailable()`, and `isSTTAvailable()`. The runtime does not expose
`textToSpeech()`, `speechToText()`, or `unregisterSTTProvider()`.

`STTProvider.transcribe(audioBuffer, mimeType, options)` receives an optional `STTOptions.signal`. Providers should stop promptly when it aborts, terminate descendant processes or requests, release temporary files and listeners, and reject only after cleanup finishes. OpenACP waits for that provider promise before it starts the next queued prompt.

```typescript
interface STTOptions {
  language?: string
  model?: string
  signal?: AbortSignal
}
```

### Adapter Types

| Type | Description |
|---|---|
| `IChannelAdapter` | Interface that all channel adapters must implement. |
| `OutgoingMessage` | Message sent from OpenACP to a channel. |
| `PermissionRequest` | Permission prompt sent to the user. |
| `PermissionOption` | A selectable option in a permission request. |
| `ElicitationRequest` | A transient ACP form request with a validated schema and expiry. |
| `ElicitationResponse` | Exact `accept`, `decline`, or `cancel` response returned to the agent. |
| `ElicitationContentValue` | Supported form value union: string, number, boolean, or string array. |
| `ElicitationResolvedEvent` | Resolution metadata with no submitted content. |
| `NotificationMessage` | Notification sent to the notification channel. |
| `AgentCommand` | Command received from a channel adapter. |
| `AttachmentDeliveryTarget` | Secret-free, opaque identity for one resolved attachment destination. |
| `AttachmentTargetBinding` | Immutable host-owned target plus private thread ID and a just-in-time currentness check. |
| `AttachmentDeliveryRequest` | Staged file metadata, exact target binding, caption, and abort signal passed to an acknowledged adapter call. |
| `AttachmentDeliveryReceipt` | Provider-accepted receipt containing the stable delivery ID and real provider message ID. |

`IChannelAdapter.deleteSessionThreadById?(threadId)` is the optional cleanup
contract for a remote thread created before the first session record is durable.
Threaded adapters should implement it when `createSessionThread` allocates a
remote resource. Existing adapters remain valid without it; Core uses
`deleteSessionThread(sessionId)` as a fallback after a session identity exists.

Form-capable adapters can additionally implement
`sendElicitationRequest?(sessionId, request)` and
`dismissElicitationRequest?(sessionId, event)`, and declare
`capabilities.elicitation.form`. See [Adapter Reference](adapter-reference.md)
for ownership and protected-input requirements.
OpenACP accepts flat primitive schemas but rejects string `pattern` constraints;
plugins must not compile agent-supplied regular expressions independently.

`IChannelAdapter.deliverAttachment?(request)` is additive and optional. The CLI
and SDK main entries export all four attachment-delivery types, so existing
adapters compile without the method and `sendMessage(): Promise<void>` retains
its legacy semantics. Supporting adapters must also advertise
`capabilities.fileUpload`, use the immutable `AttachmentTargetBinding.threadId`
instead of resolving mutable session state, call `isCurrent()` immediately
before provider I/O, honor `request.signal`, and return a receipt only after the
provider supplies a real message ID. See [Adapter Reference](adapter-reference.md#acknowledged-attachment-delivery).

`IChannelAdapter.isOperational?()` is the optional side-effect-free runtime
readiness probe used by attachment health, target resolution, and delivery
revalidation. Implement it when an adapter can be configured for file delivery
but not currently connected or able to accept provider operations. While it is
false, new work fails with retryable `provider_unavailable`. Existing adapters
may omit it.

---

## Base Classes

Exported from the main entry point:

```typescript
import { MessagingAdapter, StreamAdapter, BaseRenderer } from '@n1creator/openacp-plugin-sdk'
```

### MessagingAdapter

Abstract base class for channel adapters (Telegram, Discord, Slack, etc.). Implements `IChannelAdapter` with common patterns for session threading and message routing.

Use this when building a new platform adapter.

### StreamAdapter

Extends `MessagingAdapter` with streaming support. Handles chunked message updates, buffering, and periodic batch sends.

Use this when your platform supports message editing (e.g., Telegram, Discord).

### BaseRenderer

Base class for rendering agent output into platform-specific formats. Handles markdown conversion, code block formatting, and tool call display.

Use this to customize how agent responses appear on your platform.

---

## Adapter Primitives

Reusable building blocks for adapter implementations:

```typescript
import { SendQueue, DraftManager, ToolCallTracker, ActivityTracker } from '@n1creator/openacp-plugin-sdk'
```

| Class | Description |
|---|---|
| `SendQueue` | Serial message queue that ensures messages are sent one at a time. Prevents race conditions when multiple messages arrive simultaneously. |
| `DraftManager` | Manages streaming message drafts. Buffers text chunks and sends periodic batch updates to the platform. |
| `ToolCallTracker` | Tracks active tool calls (file edits, shell commands, etc.) and generates status displays. |
| `ActivityTracker` | Monitors agent activity and manages typing indicators. |

---

## Testing Utilities

Import from the `/testing` subpath:

```typescript
import {
  createTestContext,
  createTestInstallContext,
  mockServices,
  runAdapterConformanceTests,
} from '@n1creator/openacp-plugin-sdk/testing'
```

The testing subpath uses the Vitest runner supplied by the plugin project. Add
Vitest 3 or 4 to the project's development dependencies before importing it.

`runAdapterConformanceTests(factory, cleanup?)` registers the standard channel
adapter contract against that runner. The same helper is available directly
from `@n1creator/openacp-cli/testing` for adapter packages that do not otherwise
depend on the plugin SDK.

---

### createTestContext(opts)

Creates a test-friendly `PluginContext` for unit-testing plugin `setup()` and runtime behavior. All state is in-memory, the logger is silent, and services can be pre-populated.

**Options:**

```typescript
interface TestContextOpts {
  pluginName: string
  pluginConfig?: Record<string, unknown>
  permissions?: string[]
  services?: Record<string, unknown>
}
```

| Option | Type | Description |
|---|---|---|
| `pluginName` | `string` | Required. The plugin name. |
| `pluginConfig` | `Record<string, unknown>` | Plugin settings available as `ctx.pluginConfig`. Default: `{}`. |
| `permissions` | `string[]` | Simulated permissions. Default: all permitted. |
| `services` | `Record<string, unknown>` | Pre-registered services available via `ctx.getService()`. |

**Returns: `TestPluginContext`**

Extends `PluginContext` with inspection properties:

| Property / Method | Type | Description |
|---|---|---|
| `registeredServices` | `Map<string, unknown>` | Services registered via `registerService()`. |
| `registeredCommands` | `Map<string, CommandDef>` | Commands registered via `registerCommand()`. |
| `registeredMiddleware` | `Array<{ hook, opts }>` | Middleware registered via `registerMiddleware()`. |
| `emittedEvents` | `Array<{ event, payload }>` | Events emitted via `emit()`. |
| `sentMessages` | `Array<{ sessionId, content }>` | Messages sent via `sendMessage()`. |
| `executeCommand(name, args?)` | `Promise<CommandResponse>` | Dispatch a registered command by name for testing. |

**Example:**

```typescript
import { describe, it, expect } from 'vitest'
import { createTestContext } from '@n1creator/openacp-plugin-sdk/testing'
import plugin from '../index.js'

describe('my-plugin', () => {
  it('registers a service on setup', async () => {
    const ctx = createTestContext({
      pluginName: '@myorg/my-plugin',
      pluginConfig: { apiKey: 'test-key' },
    })

    await plugin.setup(ctx)

    expect(ctx.registeredServices.has('my-service')).toBe(true)
  })

  it('registers a command and handles it', async () => {
    const ctx = createTestContext({ pluginName: '@myorg/my-plugin' })
    await plugin.setup(ctx)

    const response = await ctx.executeCommand('mycommand', { raw: 'test input' })
    expect(response).toEqual({ type: 'text', text: expect.any(String) })
  })

  it('sends messages on events', async () => {
    const ctx = createTestContext({ pluginName: '@myorg/my-plugin' })
    await plugin.setup(ctx)

    ctx.emit('session:created', { sessionId: 'sess-1' })

    expect(ctx.sentMessages).toHaveLength(1)
    expect(ctx.sentMessages[0].sessionId).toBe('sess-1')
  })

  it('uses pre-populated services', async () => {
    const ctx = createTestContext({
      pluginName: '@myorg/my-plugin',
      services: { security: mockServices.security() },
    })

    await plugin.setup(ctx)
    // Plugin can call ctx.getService('security') and get the mock
  })
})
```

---

### createTestInstallContext(opts)

Creates a test-friendly `InstallContext` for unit-testing `install()`, `configure()`, and `uninstall()` hooks. Terminal prompts are automatically answered from a response map.

**Options:**

```typescript
interface TestInstallContextOpts {
  pluginName: string
  terminalResponses?: Record<string, unknown[]>
}
```

| Option | Type | Description |
|---|---|---|
| `pluginName` | `string` | Required. The plugin name. |
| `terminalResponses` | `Record<string, unknown[]>` | Auto-answers for terminal prompts, keyed by method name. |

**Terminal auto-answering:**

The `terminalResponses` map provides answers for each prompt method. Responses are consumed in order (queue). If the queue is empty, sensible defaults are returned:

- `text` -> `''`
- `password` -> `''`
- `confirm` -> `false`
- `select` -> `undefined`
- `multiselect` -> `[]`

**Returns: `InstallContext` with extra properties:**

| Property | Type | Description |
|---|---|---|
| `terminalCalls` | `Array<{ method, args }>` | Log of all terminal prompt calls made. |
| `settingsData` | `Map<string, unknown>` | In-memory settings store. |

**Example:**

```typescript
import { describe, it, expect } from 'vitest'
import { createTestInstallContext } from '@n1creator/openacp-plugin-sdk/testing'
import plugin from '../index.js'

describe('install flow', () => {
  it('saves API key from prompt', async () => {
    const ctx = createTestInstallContext({
      pluginName: '@myorg/my-plugin',
      terminalResponses: {
        password: ['sk-test-123456789'],
        select: ['en'],
      },
    })

    await plugin.install!(ctx)

    // Verify settings were saved
    expect(ctx.settingsData.get('apiKey')).toBe('sk-test-123456789')
    expect(ctx.settingsData.get('targetLanguage')).toBe('en')
  })

  it('records terminal interactions', async () => {
    const ctx = createTestInstallContext({
      pluginName: '@myorg/my-plugin',
      terminalResponses: {
        password: ['sk-test-123456789'],
        select: ['en'],
      },
    })

    await plugin.install!(ctx)

    expect(ctx.terminalCalls).toEqual([
      { method: 'password', args: expect.objectContaining({ message: expect.any(String) }) },
      { method: 'select', args: expect.objectContaining({ message: expect.any(String) }) },
    ])
  })

})
```

---

### mockServices

Factory functions that create mock implementations of OpenACP service interfaces. Each function returns a fully-typed object with sensible defaults. Pass `overrides` to customize specific methods.

```typescript
import { mockServices } from '@n1creator/openacp-plugin-sdk/testing'
```

#### mockServices.security(overrides?)

```typescript
const security = mockServices.security()
// { checkAccess() -> { allowed: true }, checkSessionLimit() -> { allowed: true }, getUserRole() -> 'user' }

const restricted = mockServices.security({
  async checkAccess() { return { allowed: false, reason: 'blocked' } },
})
```

#### mockServices.fileService(overrides?)

```typescript
const files = mockServices.fileService()
// { saveFile(), resolveFile() -> null, readTextFileWithRange() -> '', extensionFromMime() -> '.bin', convertOggToWav() }
```

#### mockServices.notifications(overrides?)

```typescript
const notifs = mockServices.notifications()
// { notify(), notifyAll() }
```

#### mockServices.usage(overrides?)

```typescript
const usage = mockServices.usage()
// { trackUsage(), checkBudget() -> { ok: true }, getSummary() -> { totalTokens: 0, ... } }
```

#### mockServices.speech(overrides?)

```typescript
const speech = mockServices.speech()
// { synthesize(), transcribe(), isTTSAvailable(), isSTTAvailable(), registerTTSProvider(), unregisterTTSProvider(), registerSTTProvider() }
```

Only the test mock retains deprecated `textToSpeech()` and `speechToText()` aliases for test-suite compatibility until the next SDK major version. They are not methods of `SpeechServiceInterface` or the runtime service. New tests should use the canonical result-returning methods above.

#### mockServices.tunnel(overrides?)

```typescript
const tunnel = mockServices.tunnel()
// { getPublicUrl(), start(), stop(), getStore(), fileUrl(), diffUrl() }
```

#### mockServices.context(overrides?)

```typescript
const context = mockServices.context()
// { buildContext() -> '', registerProvider() }
```

**Using mockServices with createTestContext:**

```typescript
const ctx = createTestContext({
  pluginName: '@myorg/my-plugin',
  services: {
    security: mockServices.security(),
    usage: mockServices.usage({
      async checkBudget() { return { ok: false, percent: 100 } },
    }),
  },
})

await plugin.setup(ctx)
// Plugin can now call ctx.getService('security') and ctx.getService('usage')
```

---

## Further Reading

- [Getting Started: Your First Plugin](getting-started-plugin.md) -- step-by-step tutorial
- [Writing Plugins](../architecture/writing-plugins.md) -- full guide to services, middleware, events, and storage
- [Dev Mode](dev-mode.md) -- development workflow with hot-reload
