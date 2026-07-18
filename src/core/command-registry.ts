import type { CommandDef, CommandArgs, CommandResponse } from './plugin/types.js'

/** ASCII-only case folding for short and namespace-qualified command lookup. */
export function normalizeCommandLookupName(name: string): string {
  if (!/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/.test(name)) return name
  return name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/**
 * Internal representation of a registered command, extending CommandDef with
 * a `scope` derived from the plugin name for namespace-qualified lookups.
 */
interface RegisteredCommand extends CommandDef {
  /** Scope extracted from pluginName, e.g. '@openacp/speech' → 'speech' */
  scope?: string
}

/**
 * Central command registry with namespace resolution and adapter-specific overrides.
 *
 * Namespace rules:
 * - System commands always own the short name.
 * - Among plugins, the first to register wins the short name.
 * - Every plugin command also gets a qualified name: `scope:name`.
 * - Adapter plugins (@openacp/telegram, @openacp/discord)
 *   registering a command that already exists → stored as an override
 *   keyed by `channelId:commandName`, used when channelId matches.
 *
 * Note: this registry only handles slash commands (e.g. /new, /session).
 * Callback button routing (inline keyboard buttons) is handled separately
 * at the adapter level using a `c/` prefix — it is not part of command dispatch
 * and does not go through this registry.
 */
export class CommandRegistry {
  /** Main registry: short names + qualified names → RegisteredCommand */
  private commands = new Map<string, RegisteredCommand>()

  /** Adapter-specific overrides: `channelId:commandName` → RegisteredCommand */
  private overrides = new Map<string, RegisteredCommand>()

  private static ADAPTER_SCOPES = new Set(['telegram', 'discord'])

  /**
   * Register a command definition.
   * @param def - Command definition
   * @param pluginName - Plugin that owns the command (set automatically by PluginContext)
   */
  register(def: CommandDef, pluginName?: string): void {
    const cmd: RegisteredCommand = {
      ...def,
      pluginName: pluginName ?? def.pluginName,
    }

    if (pluginName) {
      cmd.scope = CommandRegistry.extractScope(pluginName)
    }

    const commandName = normalizeCommandLookupName(cmd.name)
    const scope = cmd.scope ? normalizeCommandLookupName(cmd.scope) : undefined
    const qualifiedName = scope ? `${scope}:${commandName}` : undefined

    // Check if this is an adapter plugin overriding an existing command
    if (scope && CommandRegistry.ADAPTER_SCOPES.has(scope) && this.commands.has(commandName)) {
      // Store as adapter override
      this.overrides.set(`${scope}:${commandName}`, cmd)
      return
    }

    // Always register qualified name if available
    if (qualifiedName) {
      this.commands.set(qualifiedName, cmd)
    }

    // Short name logic
    if (this.commands.has(commandName)) {
      const existing = this.commands.get(commandName)!
      // System commands always win the short name
      if (existing.category === 'system') {
        // Plugin gets qualified name only (already registered above)
        return
      }
      // First plugin wins short name; later plugins get qualified only
      return
    }

    // No conflict — register short name
    this.commands.set(commandName, cmd)
  }

  /** Retrieve a command by name (short or qualified). */
  get(name: string): RegisteredCommand | undefined {
    return this.commands.get(normalizeCommandLookupName(name))
  }

  /** Remove a command by name (short or qualified). Also removes its qualified name entry. */
  unregister(name: string): void {
    const lookupName = normalizeCommandLookupName(name)
    const cmd = this.commands.get(lookupName)
    if (!cmd) return
    this.commands.delete(lookupName)
    if (cmd.scope) {
      // If we deleted by short name, also delete qualified name
      const scope = normalizeCommandLookupName(cmd.scope)
      const commandName = normalizeCommandLookupName(cmd.name)
      this.commands.delete(`${scope}:${commandName}`)
      // If we deleted by qualified name, only delete short name if it points to the same command
      if (this.commands.get(commandName) === cmd) {
        this.commands.delete(commandName)
      }
    }
  }

  /** Remove all commands registered by a given plugin. */
  unregisterByPlugin(pluginName: string): void {
    const toDelete: string[] = []

    for (const [key, cmd] of this.commands) {
      if (cmd.pluginName === pluginName) {
        toDelete.push(key)
      }
    }

    for (const key of toDelete) {
      this.commands.delete(key)
    }

    // Also remove adapter overrides
    for (const [key, cmd] of this.overrides) {
      if (cmd.pluginName === pluginName) {
        this.overrides.delete(key)
      }
    }
  }

  /** Return all unique commands (deduplicated — each command appears once). */
  getAll(): RegisteredCommand[] {
    const seen = new Set<RegisteredCommand>()
    for (const cmd of this.commands.values()) {
      seen.add(cmd)
    }
    return [...seen]
  }

  /** Filter commands by category. */
  getByCategory(category: 'system' | 'plugin'): RegisteredCommand[] {
    return this.getAll().filter((cmd) => cmd.category === category)
  }

  /**
   * Parse and execute a command string (e.g. "/greet hello world").
   *
   * Resolution order:
   * 1. Adapter-specific override (e.g. Telegram's version of /new)
   * 2. Short name or qualified name in the main registry
   *
   * Strips Telegram-style bot mentions (e.g. "/help@MyBot" → "help").
   * Returns `{ type: 'delegated' }` if the handler returns null/undefined
   * (meaning it handled the response itself, e.g. via assistant).
   */
  async execute(commandString: string, baseArgs: CommandArgs): Promise<CommandResponse> {
    const trimmed = commandString.trim()
    const spaceIdx = trimmed.indexOf(' ')
    const rawCmd = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
    // Strip bot mention suffix: "/help@MyBot" → "help"
    const originalCmdName = rawCmd.split("@")[0]
    const cmdName = normalizeCommandLookupName(originalCmdName)
    const rawArgs = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1)

    // Adapter-specific overrides take precedence (e.g. Telegram's /new with topic creation)
    const overrideKey = `${normalizeCommandLookupName(baseArgs.channelId)}:${cmdName}`
    const override = this.overrides.get(overrideKey)

    const cmd = override ?? this.commands.get(cmdName)

    if (!cmd) {
      return { type: 'error', message: `Unknown command: /${originalCmdName}` }
    }

    const args: CommandArgs = {
      ...baseArgs,
      raw: rawArgs,
    }

    try {
      const result = await cmd.handler(args)
      if (result === undefined || result === null) {
        return { type: 'delegated' }
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { type: 'error', message: `Command /${cmdName} failed: ${message}` }
    }
  }

  /** Extract scope from plugin name: '@openacp/speech' → 'speech', 'my-plugin' → 'my-plugin' */
  static extractScope(pluginName: string): string {
    const slashIdx = pluginName.lastIndexOf('/')
    if (slashIdx !== -1) {
      return pluginName.slice(slashIdx + 1)
    }
    return pluginName
  }
}
