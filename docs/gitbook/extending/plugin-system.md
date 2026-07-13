# Plugin System Overview

> **Note:** This page provides a quick overview of plugin management from a user's perspective. For the full technical deep dive into the plugin infrastructure, see [Architecture > Plugin System](../architecture/plugin-system.md).

---

## What Are Plugins?

Plugins are modules that extend OpenACP with new capabilities. Everything beyond the core kernel is a plugin: messaging adapters (Telegram, Discord, Slack), security, speech, tunnels, usage tracking, and more.

Plugins can:

- Register **services** that other plugins consume
- Register **chat commands** available on all platforms
- Register **middleware** to intercept and modify message flows
- Subscribe to **events** for cross-plugin communication
- Use **storage** for persistent data

---

## Installing a Plugin

```bash
openacp plugin install @community/my-plugin
```

Community packages are installed into a complete staging tree with npm lifecycle
scripts disabled. OpenACP validates the default export, matching package/plugin
name and version, `setup()`, and an explicit `install()` hook before the hook is
run or live packages are swapped. Import, validation, hook, activation, or
registry failure restores the previous package tree, settings, and registry
entry. A cross-process lock and durable phase journal make the same guarantee
across daemon termination or host restart: startup rolls back work before the
registry commit and completes activation after it. A corrupt or unverifiable
transaction quarantines community plugins while built-ins continue to start.
A successful install becomes active on restart.

OpenACP does not mutate the shared npm plugin tree from a running plugin or chat
command. If a runtime feature reports that a provider is missing, run
`openacp plugin install <package>` and restart OpenACP. Registry removal is also
restart-required and currently retains shared npm package files; this avoids
racing code that the daemon has already loaded.

OpenACP ships a deterministic offline plugin catalog with each release. `openacp plugin search` searches only entries the maintained package can promise; the catalog may be empty. A full npm package name can always be installed directly. Catalog lookup never performs a network request.

## Listing Plugins

```bash
openacp plugins
```

Shows all installed plugins with their version, source (builtin/npm), and enabled state.

## Configuring a Plugin

```bash
openacp plugin configure @community/my-plugin
```

Runs the plugin's interactive `configure()` hook.

## Disabling / Enabling

```bash
openacp plugin disable @openacp/speech
openacp plugin enable @openacp/speech
```

Built-in plugins cannot be uninstalled, but they can be disabled.

## Uninstalling

```bash
openacp plugin uninstall @community/my-plugin
openacp plugin uninstall @community/my-plugin --purge  # also delete settings
```

---

## Plugin Interface (Quick Reference)

```typescript
interface OpenACPPlugin {
  name: string
  version: string
  description?: string
  pluginDependencies?: Record<string, string>
  permissions?: PluginPermission[]
  settingsSchema?: ZodSchema
  essential?: boolean

  setup(ctx: PluginContext): Promise<void>
  teardown?(): Promise<void>
  install?(ctx: InstallContext): Promise<void>
  configure?(ctx: InstallContext): Promise<void>
  migrate?(ctx: MigrateContext, oldSettings: unknown, oldVersion: string): Promise<unknown>
  uninstall?(ctx: InstallContext, opts: { purge: boolean }): Promise<void>
}
```

---

## Further Reading

- [Architecture > Plugin System](../architecture/plugin-system.md) -- complete plugin infrastructure deep dive
- [Architecture > Writing Plugins](../architecture/writing-plugins.md) -- step-by-step guide for plugin authors
- [Architecture > Built-in Plugins](../architecture/built-in-plugins.md) -- reference for all 11 built-in plugins
- [Architecture > Command System](../architecture/command-system.md) -- how chat commands work
- [Building Adapters](building-adapters.md) -- building adapter plugins specifically
- [ADR 0007](../../adr/0007-crash-consistent-plugin-transactions.md) -- crash-consistent install and migration boundaries
