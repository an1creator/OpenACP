import { createHash } from 'node:crypto'
import { TELEGRAM_COMMAND_LOCALES, type TelegramCommandLocale } from '../../core/telegram-command-scopes.js'
import { TelegramCommandOwnershipStore, type TelegramCommandOwnerIdentity } from './command-ownership-store.js'

export interface TelegramBotCommand {
  command: string
  description: string
}

type DefaultCommandScope = { type: 'default' }
type ChatCommandScope = {
  type: 'chat' | 'chat_administrators'
  chat_id: number
}
type ManagedCommandScope = DefaultCommandScope | ChatCommandScope

interface CommandOptions {
  scope: ManagedCommandScope
  language_code?: string
}

export interface TelegramCommandApi {
  getMyCommands(options: CommandOptions, signal?: AbortSignal): Promise<TelegramBotCommand[]>
  setMyCommands(
    commands: readonly TelegramBotCommand[],
    options: CommandOptions,
    signal?: AbortSignal,
  ): Promise<unknown>
}

export interface TelegramCommandSyncResult {
  updated: string[]
  unchanged: string[]
}

export interface TelegramRegistryCommand {
  name: string
  description: string
  category?: string
}

export interface TelegramCommandBoundaryResult {
  commands: TelegramBotCommand[]
  skipped: {
    invalidName: number
    invalidDescription: number
    duplicate: number
    overflow: number
  }
}

export class TelegramCommandBoundaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TelegramCommandBoundaryError'
  }
}

const TELEGRAM_COMMAND_NAME = /^[a-z0-9_]{1,32}$/
const TELEGRAM_COMMAND_LIMIT = 100
const TELEGRAM_DESCRIPTION_LIMIT = 256

function validDescription(description: unknown): description is string {
  if (typeof description !== 'string') return false
  const trimmed = description.trim()
  return trimmed.length > 0 && trimmed.length <= TELEGRAM_DESCRIPTION_LIMIT
}

/**
 * Apply the Bot API boundary before ownership or network retries.
 * Core commands are immutable priority entries; valid plugins are sorted by
 * command name so overflow behavior does not depend on plugin load timing.
 */
export function prepareTelegramCommandBoundary(
  coreCommands: readonly TelegramBotCommand[],
  registryCommands: readonly TelegramRegistryCommand[],
): TelegramCommandBoundaryResult {
  if (coreCommands.length > TELEGRAM_COMMAND_LIMIT) {
    throw new TelegramCommandBoundaryError('OpenACP core defines more than 100 Telegram commands')
  }
  const seen = new Set<string>()
  const commands: TelegramBotCommand[] = []
  for (const command of coreCommands) {
    if (!TELEGRAM_COMMAND_NAME.test(command.command) || !validDescription(command.description)) {
      throw new TelegramCommandBoundaryError('OpenACP core contains an invalid Telegram command definition')
    }
    if (seen.has(command.command)) throw new TelegramCommandBoundaryError('OpenACP core contains a duplicate Telegram command definition')
    seen.add(command.command)
    commands.push({ command: command.command, description: command.description.trim() })
  }

  const skipped = { invalidName: 0, invalidDescription: 0, duplicate: 0, overflow: 0 }
  const validPlugins: TelegramBotCommand[] = []
  for (const command of registryCommands) {
    if (command.category !== 'plugin') continue
    if (!TELEGRAM_COMMAND_NAME.test(command.name)) { skipped.invalidName++; continue }
    if (!validDescription(command.description)) { skipped.invalidDescription++; continue }
    if (seen.has(command.name) || validPlugins.some((entry) => entry.command === command.name)) {
      skipped.duplicate++
      continue
    }
    validPlugins.push({ command: command.name, description: command.description.trim() })
  }
  validPlugins.sort((a, b) => a.command.localeCompare(b.command) || a.description.localeCompare(b.description))
  const capacity = TELEGRAM_COMMAND_LIMIT - commands.length
  skipped.overflow = Math.max(0, validPlugins.length - capacity)
  commands.push(...validPlugins.slice(0, capacity))
  return { commands, skipped }
}

function assertTelegramCommandBoundary(commands: readonly TelegramBotCommand[]): void {
  if (commands.length > TELEGRAM_COMMAND_LIMIT) throw new TelegramCommandBoundaryError('Telegram command list exceeds 100 entries')
  const seen = new Set<string>()
  for (const command of commands) {
    if (!TELEGRAM_COMMAND_NAME.test(command.command) || !validDescription(command.description) || seen.has(command.command)) {
      throw new TelegramCommandBoundaryError('Telegram command list failed validation before synchronization')
    }
    seen.add(command.command)
  }
}

export interface TelegramCommandSyncOptions {
  ownershipStore: TelegramCommandOwnershipStore
  botId: string
  ownerIdentity: TelegramCommandOwnerIdentity
  allowOwnerTakeover?: boolean
  onOwnerClaimed?: () => void
  historicalOwnedNames: ReadonlySet<string>
  signal?: AbortSignal
}

function commandsEqual(
  current: readonly TelegramBotCommand[],
  desired: readonly TelegramBotCommand[],
): boolean {
  return current.length === desired.length && current.every((command, index) => {
    const expected = desired[index]
    return command.command === expected?.command && command.description === expected.description
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
}

function localeLabel(locale: TelegramCommandLocale): string {
  return locale || 'neutral'
}

/**
 * Reconcile only commands proven to be owned by OpenACP.
 *
 * Unknown BotFather/operator commands are preserved byte-for-byte. On a clean
 * first migration, only the explicit historical OpenACP manifest is claimed.
 * Afterwards the durable ledger owns current registry commands, which gives
 * plugin command removal/rename a safe lifecycle without deleting foreign names.
 */
export async function synchronizeTelegramCommands(
  api: TelegramCommandApi,
  chatId: number,
  desired: readonly TelegramBotCommand[],
  options: TelegramCommandSyncOptions,
): Promise<TelegramCommandSyncResult> {
  if (!/^\d{1,20}$/.test(options.botId)) throw new Error('Telegram bot identity is invalid')
  assertTelegramCommandBoundary(desired)
  const chatKey = createHash('sha256').update(String(chatId)).digest('hex').slice(0, 16)
  const scopes: Array<{
    name: 'default' | 'chat' | 'chat_administrators'
    scope: ManagedCommandScope
    ledgerName: string
    onlyWhenPresent?: boolean
  }> = [
    { name: 'default', scope: { type: 'default' }, ledgerName: 'default' },
    { name: 'chat', scope: { type: 'chat', chat_id: chatId }, ledgerName: `chat:${chatKey}` },
    {
      name: 'chat_administrators',
      scope: { type: 'chat_administrators', chat_id: chatId },
      ledgerName: `chat_administrators:${chatKey}`,
      onlyWhenPresent: true,
    },
  ]
  const desiredNames = new Set(desired.map((command) => command.command))
  const result: TelegramCommandSyncResult = { updated: [], unchanged: [] }

  // Claim and persist one owner before reading or mutating any Telegram scope.
  // Do not retain the filesystem lock across Bot API calls: shutdown must be
  // able to mark a claimed owner stopped even if a network implementation does
  // not promptly honor AbortSignal.
  const initialConservative = await options.ownershipStore.withLock(async ({ ledger, conservative }) => {
    options.ownershipStore.claimOwner(ledger, options.botId, options.ownerIdentity, options.allowOwnerTakeover)
    options.ownershipStore.save(ledger)
    return conservative
  })
  options.onOwnerClaimed?.()

  for (const locale of TELEGRAM_COMMAND_LOCALES) {
    for (const entry of scopes) {
      throwIfAborted(options.signal)
      const label = `${entry.name}:${localeLabel(locale)}`
      const scopeKey = `${entry.ledgerName}|${localeLabel(locale)}`
      const apiOptions: CommandOptions = {
        scope: entry.scope,
        ...(locale ? { language_code: locale } : {}),
      }
      const current = await api.getMyCommands(apiOptions, options.signal)
      throwIfAborted(options.signal)
      const ownership = await options.ownershipStore.withLock(async ({ ledger, conservative }) => ({
        priorOwned: options.ownershipStore.getOwned(ledger, options.botId, scopeKey), conservative,
      }))

      if (entry.onlyWhenPresent && current.length === 0) {
        await options.ownershipStore.withLock(async ({ ledger }) => {
          options.ownershipStore.claimOwner(ledger, options.botId, options.ownerIdentity)
          options.ownershipStore.setOwned(ledger, options.botId, scopeKey, [])
          options.ownershipStore.save(ledger)
        })
        result.unchanged.push(label)
        continue
      }

      const owned = new Set(ownership.priorOwned ?? (initialConservative || ownership.conservative ? [] : options.historicalOwnedNames))
      const unmanaged = current.filter((command) => !desiredNames.has(command.command) && !owned.has(command.command))
      const merged = [...desired, ...unmanaged]
      if (merged.length > 100) {
        throw new Error(`Telegram command scope ${label} has no capacity for OpenACP commands without deleting unmanaged commands`)
      }
      if (!commandsEqual(current, merged)) {
        throwIfAborted(options.signal)
        await api.setMyCommands(merged, apiOptions, options.signal)
        result.updated.push(label)
      } else {
        result.unchanged.push(label)
      }
      throwIfAborted(options.signal)
      await options.ownershipStore.withLock(async ({ ledger }) => {
        options.ownershipStore.claimOwner(ledger, options.botId, options.ownerIdentity)
        options.ownershipStore.setOwned(ledger, options.botId, scopeKey, [...desiredNames])
        options.ownershipStore.save(ledger)
      })
    }
  }
  return result
}
