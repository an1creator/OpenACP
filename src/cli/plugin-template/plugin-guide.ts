import type { TemplateParams } from './package-json.js'

/**
 * Generate PLUGIN_GUIDE.md — the human-readable developer guide embedded in every plugin.
 *
 * Contains practical how-to sections: adding commands, registering services, listening to
 * events, using middleware, and writing tests. Aimed at plugin authors who prefer docs
 * over reading the API types directly.
 *
 * This file is kept in sync with the actual OpenACP plugin API. When the API changes,
 * this generator must be updated so newly scaffolded plugins start with accurate examples.
 */
export function generatePluginGuide(params: TemplateParams): string {
  return `# Plugin Developer Guide

## Overview

**${params.pluginName}** is an OpenACP plugin.

> TODO: Describe what this plugin does.

## Project Structure

\`\`\`
src/
  index.ts              — Plugin entry point (exports OpenACPPlugin object)
  __tests__/
    index.test.ts       — Tests using Vitest + @n1creator/openacp-plugin-sdk/testing
package.json            — npm package config with Node.js and OpenACP engine constraints
tsconfig.json           — TypeScript strict mode, ES2022, NodeNext
CLAUDE.md               — Full technical reference for AI coding agents
PLUGIN_GUIDE.md         — This file
\`\`\`

## Development Workflow

1. **Edit** \`src/index.ts\` — implement your plugin logic
2. **Dev mode**: \`openacp dev .\` — compiles, watches, and hot-reloads your plugin
3. **Test**: \`npm test\` — runs Vitest with SDK testing utilities
4. **Build**: \`npm run build\` — compiles TypeScript to \`dist/\`

\`\`\`bash
npm install
openacp dev .     # start developing with hot-reload
npm test          # run tests
npm run build     # compile for publishing
\`\`\`

## Adding a Command

Register commands in your \`setup()\` function. Requires \`commands:register\` permission.

\`\`\`typescript
async setup(ctx: PluginContext) {
  ctx.registerCommand({
    name: 'greet',
    description: 'Send a greeting',
    usage: '[name]',
    category: 'plugin',
    async handler(args) {
      const name = args.raw.trim() || 'World'
      return { type: 'text', text: \\\`Hello, \\\${name}!\\\` }
    },
  })

  // Add a menu item to the /menu command
  ctx.registerMenuItem({ id: 'my-item', label: 'My Feature', priority: 150, action: { type: 'command', command: '/greet' } })
  // Remove it later if needed
  ctx.unregisterMenuItem('my-item')

  // Add context sections for the assistant command
  ctx.registerAssistantSection({ id: 'my-section', title: 'My Section', priority: 200, buildContext: () => 'context text' })
  ctx.unregisterAssistantSection('my-section')
}
\`\`\`

The command will be available as \`/greet\` in all messaging platforms.

## Adding a Service

Provide a service that other plugins can consume. Requires \`services:register\` permission.

\`\`\`typescript
async setup(ctx: PluginContext) {
  const myService = {
    doSomething(input: string): string {
      return input.toUpperCase()
    },
  }
  ctx.registerService('my-service', myService)
}
\`\`\`

Other plugins access it with \`ctx.getService<MyServiceType>('my-service')\`.

## Adapter Plugins

Adapter plugins implement the exported \`IChannelAdapter\` contract. On threaded
platforms, \`createSessionThread(sessionId, name)\` may receive an empty
\`sessionId\` because Core creates the remote thread before agent startup.
Return the platform thread ID and optionally implement
\`deleteSessionThreadById(threadId)\` so Core can remove that remote resource if
startup or the initial durable session write fails. The method is optional for
backward compatibility; when a session exists, Core can still fall back to
\`deleteSessionThread(sessionId)\`.

To render ACP forms, declare \`capabilities.elicitation.form\` and implement
\`sendElicitationRequest?(sessionId, request)\`. Implement
\`dismissElicitationRequest?(sessionId, event)\` to remove stale UI after a
response, timeout, cancellation, or session end. Bind replies to the initiating
user and conversation, and never persist, log, or echo submitted values.
Match the exact form prompt before command routing: slash-prefixed form values
belong to the form, while unrelated ForceReply messages belong to their command
owner. Do not compile agent-supplied string \`pattern\` constraints; Core
rejects them.

Only declare \`secureInput: 'private'\` or \`'delete-after-capture'\` when the
platform actually provides that guarantee. Protected fields are a Codex ACP
extension; standard ACP form fields are not secrets.

When implementing an \`STTProvider\`, pass request options through to external calls and honor \`options.signal\`. Abort promptly, terminate descendant work, release temporary resources, and reject only after cleanup completes. OpenACP waits for the provider promise before it drains the next queued prompt.

The runtime speech service exposes result-returning \`synthesize()\`, \`transcribe()\`, provider registration, TTS provider teardown, and availability checks. It does not expose \`textToSpeech()\`, \`speechToText()\`, or \`unregisterSTTProvider()\`. Only the SDK speech test mock retains the two deprecated conversion aliases for test-suite compatibility until the next major version.

## Adding Middleware

Intercept and modify message flows. Requires \`middleware:register\` permission.

\`\`\`typescript
async setup(ctx: PluginContext) {
  ctx.registerMiddleware('message:outgoing', {
    priority: 50,
    handler: async (payload, next) => {
      // Modify the message before delivery
      payload.message.text += '\\n-- sent via ${params.pluginName}'
      return next()  // continue the chain
      // return null to block the message entirely
    },
  })
}
\`\`\`

The read-only \`turn:start\` hook runs before local preprocessing such as speech transcription. Its \`promptText\` is therefore the pre-STT prompt; use later agent events when a plugin needs the generated transcript.

## Handling Settings

### Install flow (first-time setup)

\`\`\`typescript
async install(ctx: InstallContext) {
  const apiKey = await ctx.terminal.password({
    message: 'Enter your API key:',
    validate: (v) => v.length > 0 ? undefined : 'Required',
  })
  await ctx.settings.set('apiKey', apiKey)
  ctx.terminal.log.success('Configured!')
}
\`\`\`

### Configure flow (reconfiguration)

\`\`\`typescript
async configure(ctx: InstallContext) {
  const current = await ctx.settings.getAll()
  const apiKey = await ctx.terminal.password({
    message: \\\`API key (current: \\\${current.apiKey ? '***' : 'not set'}):\\\`,
  })
  if (apiKey) await ctx.settings.set('apiKey', apiKey)
  ctx.terminal.log.success('Updated!')
}
\`\`\`

### Reading settings at runtime

\`\`\`typescript
async setup(ctx: PluginContext) {
  const apiKey = ctx.pluginConfig.apiKey as string
  if (!apiKey) {
    ctx.log.warn('Not configured — run: openacp plugin configure ${params.pluginName}')
    return
  }
  // Use apiKey...
}
\`\`\`

## Testing

Tests use Vitest and \`@n1creator/openacp-plugin-sdk/testing\`.

\`\`\`typescript
import { describe, it, expect } from 'vitest'
import { createTestContext, createTestInstallContext, mockServices } from '@n1creator/openacp-plugin-sdk/testing'
import plugin from '../index.js'

describe('${params.pluginName}', () => {
  it('registers commands on setup', async () => {
    const ctx = createTestContext({ pluginName: '${params.pluginName}' })
    await plugin.setup(ctx)
    expect(ctx.registeredCommands.has('greet')).toBe(true)
  })

  it('command returns expected response', async () => {
    const ctx = createTestContext({ pluginName: '${params.pluginName}' })
    await plugin.setup(ctx)
    const res = await ctx.executeCommand('greet', { raw: 'Alice' })
    expect(res).toEqual({ type: 'text', text: 'Hello, Alice!' })
  })

  it('install saves settings', async () => {
    const ctx = createTestInstallContext({
      pluginName: '${params.pluginName}',
      terminalResponses: { password: ['sk-test-key'] },
    })
    await plugin.install!(ctx)
    expect(ctx.settingsData.get('apiKey')).toBe('sk-test-key')
  })
})
\`\`\`

### Available mock services

\`\`\`typescript
const ctx = createTestContext({
  pluginName: '${params.pluginName}',
  services: {
    security: mockServices.security(),
    usage: mockServices.usage({ async checkBudget() { return { ok: false, percent: 100 } } }),
  },
})
\`\`\`

## Publishing

1. Update \`version\` in both \`package.json\` and \`src/index.ts\`
2. Build and test:
   \`\`\`bash
   npm run build
   npm test
   \`\`\`
3. Publish:
   \`\`\`bash
   npm publish --access public
   \`\`\`
4. Users install with:
   \`\`\`bash
   openacp plugin install ${params.pluginName}
   \`\`\`
5. Verify installation by the complete npm package name from a clean environment.

## Useful Links

- [Architecture: Plugin System](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/architecture/plugin-system.md)
- [Architecture: Writing Plugins](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/architecture/writing-plugins.md)
- [Architecture: Command System](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/architecture/command-system.md)
- [Plugin SDK Reference](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/extending/plugin-sdk-reference.md)
- [Getting Started: Your First Plugin](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/extending/getting-started-plugin.md)
- [Dev Mode](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/extending/dev-mode.md)
- [Contributing](https://github.com/an1creator/OpenACP/blob/main/CONTRIBUTING.md)
`
}
