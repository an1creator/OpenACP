# Command System

OpenACP has a centralized command system for chat commands (`/new`, `/cancel`, `/tts`, etc.). Commands are registered by core and plugins, dispatched by adapters, and rendered using platform-specific renderers.

This system covers **chat commands only** (Telegram, Discord, Slack), not CLI commands (`openacp start`, `openacp plugins install`).

Runtime commands advertised by an ACP agent are not registered in `CommandRegistry`. The agent boundary intersects every update with the ordered standard action vocabulary (`compact`, `goal`, `logout`, `mcp`, `plan`, `review`, `review-branch`, `review-commit`, `skills`, `status`) before a session, adapter, hook, or event subscriber receives it. OpenACP does not synthesize support: an action is present only when the current agent advertised it. Descriptions come from the centralized policy rather than agent-provided text, and dynamic per-skill commands are excluded from the action surface.

Adapters expose the filtered commands as session-scoped agent actions. Normal agent actions use the message ingress and model-turn pipeline with the exact invocation advertised by the agent; canonical lowercase keys are used only for ordering and lookup. Button actions use the central security service before session lookup or metadata rendering and never lazy-resume a session from a stale button. Typed `CommandRegistry` commands retain precedence; an adapter action uses a distinct callback namespace so an agent command with the same name remains unambiguous.

For an attested official `codex-acp` installation, the boundary derives a bounded, sanitized, deduplicated, sorted names-only skill inventory from advertised `$name` commands. Attestation requires a coherent installed registry identity, runner command, immutable official package specification, installed version, registry argument shape, and exact reviewed environment. Added, removed, renamed, or overridden variables make the process a generic ACP agent. A persisted registry label, display name, executable path, custom wrapper, or mismatched package cannot select this profile. A `/skills` action is represented by structured policy metadata that accepts no input. Core resolves it through a connector-neutral completed-control path with immutable principal and attachment snapshots. After the awaited security decision, core revalidates the live session object, agent generation and process, adapter instance, attachment generation, and exact thread binding. It never lazy-resumes a stale target or enters prompt admission, middleware, turn events, hooks, history, context, usage, or auto-naming. Before sending, the adapter must bind the exact target object to a platform thread or connection snapshot; there is no `sendMessage(sessionId)` fallback. Core revalidates before and after every part. Telegram serializes parts to the captured topic, while SSE writes only to captured live connections and never places local controls in the replay buffer. Before a trustworthy snapshot is available, `/skills` follows ordinary prompt behavior. Other ACP agents keep their advertised `/skills` behavior and are never parsed using the Codex convention.

During an agent switch, OpenACP captures generation-bound leases for every unique attached adapter, suspends the current action snapshot, disconnects bridges, and serially retires pinned actions and pending action input before spawning the replacement. Each cleanup and reconnect observes the current lease: an explicit concurrent detach remains detached, while an expected attached adapter that disappears is a switch failure. The replacement runtime and bridges remain provisional until the durable session identity commits. Cleanup, reconnect, or persistence failure retires the provisional runtime and restores the previous runtime, durable identity, action snapshot, and current attachments; if safe rollback itself cannot complete, OpenACP terminates the divergent session and reports an error.

Built-in and plugin command registration and lookup use the same ASCII case normalization for safe short and namespace-qualified names. Therefore `/STATUS` resolves to the built-in `/status` command rather than an agent action, while the original argument text remains unchanged.

Telegram persists the complete rendered command-message set in `platform.skillMsgIds`, while `platform.skillMsgId` mirrors its first ID for backward compatibility. `platform.skillMsgDigest` makes repeated updates idempotent. `platform.skillStaleMsgIds` is a bounded cleanup journal: a replacement is fully sent, pinned, and persisted before superseded bot-owned messages are retired, and a restart retries any interrupted retirement without deleting an unverified message ID. Session start, resume, agent switch, and reconnect replace the complete filtered snapshot; if no current snapshot exists, the adapter receives an empty update and removes persisted actions from the previous agent process.

---

## How It Works

```
User types /tts on
      |
      v
Adapter receives text
      |
      v
CommandRegistry.execute('/tts on', { channelId, userId, sessionId })
      |
      v
Find handler for 'tts'
      |
      v
Handler runs, returns CommandResponse
      |
      v
Adapter renders response (inline keyboard, embed, block kit, etc.)
```

---

## Core Types

### CommandDef

```typescript
interface CommandDef {
  name: string              // 'new', 'tts', 'tunnel'
  description: string       // shown in /help
  usage?: string            // 'on|off', '<agent-name>'
  category: 'system' | 'plugin'
  pluginName?: string       // auto-set by registry
  handler(args: CommandArgs): Promise<CommandResponse | void>
}
```

### CommandArgs

```typescript
interface CommandArgs {
  raw: string               // text after command name
  options?: Record<string, string>  // Discord slash command options
  sessionId: string | null  // null if no active session
  channelId: string         // 'telegram', 'discord', 'slack'
  userId: string
  reply(content: string | CommandResponse): Promise<void>  // mid-execution feedback
  coreAccess?: CoreAccess   // restricted core access
}
```

The `reply()` method is an escape hatch for commands that need mid-execution feedback (e.g., `/update` sends "Checking..." then "Updating..." then "Done"). Most commands just return a `CommandResponse`.

### CommandResponse

```typescript
type CommandResponse =
  | { type: 'text'; text: string }
  | { type: 'menu'; title: string; options: MenuOption[] }
  | { type: 'list'; title: string; items: ListItem[] }
  | { type: 'confirm'; question: string; onYes: string; onNo: string }
  | { type: 'error'; message: string }
  | { type: 'silent' }

interface MenuOption {
  label: string
  command: string    // command to dispatch when selected
  hint?: string
}

interface ListItem {
  label: string
  detail?: string
}
```

---

## CommandRegistry

```typescript
class CommandRegistry {
  // Registration
  register(def: CommandDef, pluginName?: string): void
  unregister(name: string): void
  unregisterByPlugin(pluginName: string): void

  // Lookup
  get(name: string): CommandDef | undefined
  getAll(): CommandDef[]
  getByCategory(category: 'system' | 'plugin'): CommandDef[]

  // Execution
  async execute(commandString: string, baseArgs: Omit<CommandArgs, 'raw'>): Promise<CommandResponse>

  // Namespace
  getQualifiedName(name: string, pluginName: string): string
  getShortName(qualifiedName: string): string | undefined
}
```

---

## System Commands vs Plugin Commands

### System commands

Registered by core during boot, before plugins load. These handle fundamental operations:

| Command | Description |
|---------|-------------|
| `/new` | Create new session |
| `/newchat` | New chat in same agent |
| `/cancel` | Cancel current session |
| `/status` | Show session status |
| `/sessions` | List all sessions |
| `/resume` | Resume a session |
| `/agents` | List available agents |
| `/install` | Install new agent |
| `/help` | Show all commands (auto-generated) |
| `/menu` | Show main menu |
| `/restart` | Restart OpenACP |
| `/update` | Update and restart |
| `/doctor` | System diagnostics |
| `/clear` | Clear session history |

### Plugin commands

Registered by plugins in their `setup()` via `ctx.registerCommand()`:

| Command | Plugin | Description |
|---------|--------|-------------|
| `/tts` | `@openacp/speech` | Toggle text-to-speech |
| `/tunnel` | `@openacp/tunnel` | Manage tunnels |
| `/tunnels` | `@openacp/tunnel` | List active tunnels |
| `/usage` | `@openacp/usage` | View usage and cost |
| `/bypass` | `@openacp/security` | Toggle auto-approve mode |

---

## Namespace Conflict Resolution

Every plugin command has two names:

- **Qualified**: `pluginScope:commandName` -- always unique (e.g., `speech:tts`)
- **Short**: `commandName` -- available if no conflict (e.g., `tts`)

### Rules

1. **System commands always win** -- plugins cannot override system command short names
2. **First plugin wins** -- first plugin to register a short name keeps it
3. **Later conflicts get qualified name only** -- the first registrant is not affected
4. **Warning logged** on conflict

### Example

```
Register 'tts' by @openacp/speech:
  -> short: /tts (no conflict)
  -> qualified: /speech:tts

Register 'status' by @openacp/tunnel:
  -> short: /status (conflict with system command)
  -> qualified: /tunnel:status
  -> warning: "Plugin command 'status' conflicts with system command"

Register 'check' by @community/plugin-a:
  -> short: /check (no conflict)

Register 'check' by @community/plugin-b:
  -> short: /check (conflict with plugin-a)
  -> plugin-a KEEPS /check
  -> plugin-b only accessible via /plugin-b:check
```

---

## Adapter Dispatch and Rendering

### Generic dispatch

Each adapter adds ONE generic dispatch handler that replaces all hardcoded command handlers:

```typescript
// Telegram adapter
bot.on('message:text', async (ctx) => {
  const text = ctx.message.text
  if (!text.startsWith('/')) return

  const registry = core.serviceRegistry.get<CommandRegistry>('command-registry')
  if (!registry) return

  const response = await registry.execute(text, {
    sessionId: getSessionIdFromTopic(ctx),
    channelId: 'telegram',
    userId: String(ctx.from.id),
  })

  await this.renderResponse(response, ctx)
})
```

### Response renderers

Adapters provide platform-specific renderers for each response type. Default renderers in the `MessagingAdapter` base class provide plain text fallback.

**Telegram** renders `menu` as inline keyboards, `confirm` as Yes/No buttons:

```typescript
// menu -> inline keyboard
this.responseRenderers.set('menu', async (response, ctx) => {
  const keyboard = response.options.map(opt => [{
    text: `${opt.label}${opt.hint ? ' -- ' + opt.hint : ''}`,
    callback_data: toCallbackData(opt.command),
  }])
  await ctx.reply(response.title, {
    reply_markup: { inline_keyboard: keyboard },
  })
})
```

**Discord** renders `menu` as select menus, `list` as embeds.

**Slack** renders using Block Kit sections.

### Button callback data

Commands triggered by button clicks use the `c/` prefix:

```
c/tts on        -> dispatch /tts on
c/#42           -> lookup cached command (for commands > 64 bytes)
```

Other callback prefixes remain unchanged: `p:` for permission buttons, etc.

---

## Two-Layer Architecture for Complex Commands

Some commands need multi-step interactive flows that vary by platform:

- `/new` on Telegram: create forum topic, show agent picker keyboard, workspace selection
- `/new` on Discord: use slash command options, channel creation
- `/resume`: session scanner, session picker UI

### How it works

**Layer 1 -- Core logic** (portable): handler returns a simple `CommandResponse`. Works on all adapters.

**Layer 2 -- Platform orchestration** (adapter-specific): adapter registers its own handler for the same command, using `reply()` for multi-step feedback and platform-specific APIs.

### Override priority

1. **Adapter-specific handler** (matches current `channelId`) -> highest priority
2. **Core handler** -> fallback

If Telegram registers its own `/new` handler, Telegram users get the rich wizard. Discord users (without an override) get the simpler core handler with a menu response.

---

## Writing a Plugin Command

Here's a complete example of a plugin that registers a command:

```typescript
import type { OpenACPPlugin, PluginContext } from '@n1creator/openacp-cli'

export default {
  name: '@community/weather',
  version: '1.0.0',
  description: 'Check weather in chat',
  permissions: ['commands:register', 'services:use'],

  async setup(ctx: PluginContext) {
    ctx.registerCommand({
      name: 'weather',
      description: 'Check weather for a city',
      usage: '<city>',
      category: 'plugin',

      handler: async (args) => {
        const city = args.raw.trim()
        if (!city) {
          return {
            type: 'text',
            text: 'Usage: /weather <city>',
          }
        }

        try {
          const weather = await fetchWeather(city)
          return {
            type: 'list',
            title: `Weather in ${city}`,
            items: [
              { label: 'Temperature', detail: `${weather.temp}C` },
              { label: 'Conditions', detail: weather.conditions },
              { label: 'Wind', detail: `${weather.wind} km/h` },
            ],
          }
        } catch {
          return {
            type: 'error',
            message: `Could not fetch weather for "${city}"`,
          }
        }
      },
    })
  },
} satisfies OpenACPPlugin
```

This command will:
- Be available as `/weather` on all adapters (short name, no conflict)
- Also available as `/weather:weather` (qualified name)
- Appear in `/help` under "Plugin" category
- Render as a list on Telegram (plain text), Discord (embed), and Slack (blocks)

---

## Boot Flow

```
1. Core creates CommandRegistry, registers as service 'command-registry'
2. Core registers system commands (/new, /cancel, /help, etc.)
3. LifecycleManager boots plugins in dependency order
   -> Each plugin's setup() calls ctx.registerCommand()
4. After all plugins booted:
   -> Emit 'system:commands-ready' with registry.getAll()
5. Adapter plugins receive event -> sync with platform:
   - Telegram: bot.setMyCommands()
   - Discord: registerSlashCommands()
   - Slack: register message listener
```

---

## Further Reading

- [Architecture Overview](README.md) -- high-level picture
- [Plugin System](plugin-system.md) -- plugin infrastructure
- [Built-in Plugins](built-in-plugins.md) -- commands each plugin provides
- [Writing Plugins](writing-plugins.md) -- how to create plugins with commands
