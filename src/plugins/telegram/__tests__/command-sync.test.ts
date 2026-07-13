import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  synchronizeTelegramCommands,
  type TelegramBotCommand,
  type TelegramCommandApi,
} from '../command-sync.js'
import { TelegramCommandOwnershipStore } from '../command-ownership-store.js'
import type { TelegramCommandOwnerIdentity } from '../command-ownership-store.js'

type Options = Parameters<TelegramCommandApi['getMyCommands']>[0]

function key(options: Options): string {
  return `${options.scope.type}:${options.language_code || 'neutral'}`
}

function makeApi(initial: Record<string, TelegramBotCommand[]>) {
  const state = new Map(Object.entries(initial).map(([name, commands]) => [name, structuredClone(commands)]))
  const getMyCommands = vi.fn(async (options: Options) => structuredClone(state.get(key(options)) ?? []))
  const setMyCommands = vi.fn(async (commands: readonly TelegramBotCommand[], options: Options) => {
    state.set(key(options), structuredClone(commands))
    return true
  })
  return { api: { getMyCommands, setMyCommands }, state, getMyCommands, setMyCommands }
}

const desired: TelegramBotCommand[] = [
  { command: 'new', description: 'Create new session' },
  { command: 'proxy', description: 'Configure network proxy' },
  { command: 'doctor', description: 'Check OpenACP health' },
]
const historical = new Set(['new', 'doctor', 'clear', 'summary'])
const owner: TelegramCommandOwnerIdentity = {
  instanceId: 'instance-one', instanceKey: '1'.repeat(64), hostId: 'a'.repeat(64), pid: process.pid,
}

describe('synchronizeTelegramCommands ownership and locales', () => {
  let root: string
  let store: TelegramCommandOwnershipStore

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-command-ownership-'))
    store = new TelegramCommandOwnershipStore(root)
  })

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const sync = (api: TelegramCommandApi, commands = desired) => synchronizeTelegramCommands(
    api, -100123, commands,
    { ownershipStore: store, botId: '123456789', ownerIdentity: owner, historicalOwnedNames: historical },
  )

  it('migrates known OpenACP commands but preserves unknown BotFather commands', async () => {
    const fixture = makeApi({
      'default:neutral': [
        { command: 'new', description: 'Old new' },
        { command: 'clear', description: 'Removed OpenACP command' },
        { command: 'legacy_2', description: 'Unmanaged legacy command' },
        { command: 'custom', description: 'BotFather custom command' },
      ],
      'chat:neutral': [{ command: 'clear', description: 'Removed OpenACP command' }],
    })

    await sync(fixture.api)

    expect(fixture.state.get('default:neutral')).toEqual([
      ...desired,
      { command: 'legacy_2', description: 'Unmanaged legacy command' },
      { command: 'custom', description: 'BotFather custom command' },
    ])
    expect(fixture.state.get('default:neutral')).not.toContainEqual(expect.objectContaining({ command: 'clear' }))
    expect(fixture.state.get('chat:neutral')).toEqual(desired)
    for (const locale of ['en', 'ru']) {
      expect(fixture.state.get(`default:${locale}`)).toEqual(desired)
      expect(fixture.state.get(`chat:${locale}`)).toEqual(desired)
    }
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600)
  })

  it('reconciles an existing Russian administrator override without deleting custom commands', async () => {
    const fixture = makeApi({
      'chat_administrators:ru': [{ command: 'custom_admin', description: 'Только администратору' }],
    })

    await sync(fixture.api)

    expect(fixture.state.get('chat_administrators:ru')).toEqual([
      ...desired,
      { command: 'custom_admin', description: 'Только администратору' },
    ])
    expect(fixture.state.get('chat_administrators:neutral')).toBeUndefined()
    expect(fixture.state.get('chat_administrators:en')).toBeUndefined()
  })

  it('is idempotent across restart and removes a plugin command only after proving ownership', async () => {
    const fixture = makeApi({ 'default:neutral': [{ command: 'custom', description: 'Keep me' }] })
    const withPlugin = [...desired, { command: 'community', description: 'Community command' }]
    await sync(fixture.api, withPlugin)
    fixture.setMyCommands.mockClear()
    store = new TelegramCommandOwnershipStore(root)

    await sync(fixture.api, withPlugin)
    expect(fixture.setMyCommands).not.toHaveBeenCalled()

    await sync(fixture.api, desired)
    expect(fixture.state.get('default:neutral')).toEqual([
      ...desired,
      { command: 'custom', description: 'Keep me' },
    ])
    expect(fixture.state.get('default:neutral')).not.toContainEqual(expect.objectContaining({ command: 'community' }))
  })

  it('recovers corrupt ownership state conservatively without deleting unproven commands', async () => {
    fs.writeFileSync(store.file, '{broken', { mode: 0o600 })
    const fixture = makeApi({
      'default:neutral': [{ command: 'clear', description: 'Ownership is no longer proven' }],
    })

    await sync(fixture.api)

    expect(fixture.state.get('default:neutral')).toContainEqual({
      command: 'clear', description: 'Ownership is no longer proven',
    })
    expect(fs.readdirSync(root).some((name) => name.startsWith('telegram-command-ownership.json.corrupt.'))).toBe(true)
  })

  it('surfaces API failures for retry and honors cancellation before mutation', async () => {
    const fixture = makeApi({})
    fixture.getMyCommands.mockRejectedValueOnce(new Error('temporary Telegram outage'))
    await expect(sync(fixture.api)).rejects.toThrow('temporary Telegram outage')

    const controller = new AbortController()
    controller.abort()
    await expect(synchronizeTelegramCommands(fixture.api, -100123, desired, {
      ownershipStore: store, botId: '123456789', ownerIdentity: owner, historicalOwnedNames: historical, signal: controller.signal,
    })).rejects.toThrow()
    expect(fixture.setMyCommands).not.toHaveBeenCalled()
  })

  it('prevents a second instance from mutating or deleting the current owner command set', async () => {
    const fixture = makeApi({ 'default:neutral': [{ command: 'custom', description: 'Unmanaged' }] })
    await sync(fixture.api, [...desired, { command: 'plugin_one', description: 'Owned by first' }])
    fixture.getMyCommands.mockClear()
    fixture.setMyCommands.mockClear()
    const second: TelegramCommandOwnerIdentity = {
      instanceId: 'instance-two', instanceKey: '2'.repeat(64), hostId: owner.hostId, pid: process.pid + 1,
    }

    await expect(synchronizeTelegramCommands(fixture.api, -100123, [...desired, { command: 'plugin_two', description: 'Owned by second' }], {
      ownershipStore: store, botId: '123456789', ownerIdentity: second, historicalOwnedNames: historical,
    })).rejects.toMatchObject({ code: 'TELEGRAM_COMMAND_OWNER_CONFLICT' })

    expect(fixture.getMyCommands).not.toHaveBeenCalled()
    expect(fixture.setMyCommands).not.toHaveBeenCalled()
    expect(fixture.state.get('default:neutral')).toContainEqual({ command: 'plugin_one', description: 'Owned by first' })
    expect(fixture.state.get('default:neutral')).toContainEqual({ command: 'custom', description: 'Unmanaged' })
    expect(fixture.state.get('default:neutral')).not.toContainEqual(expect.objectContaining({ command: 'plugin_two' }))
    expect(JSON.stringify(store.getOwner('123456789'))).not.toContain('-100123')
  })

  it('allows explicit takeover only after a same-host owner has stopped', async () => {
    const fixture = makeApi({})
    await sync(fixture.api)
    await store.releaseOwner('123456789', owner)
    const second: TelegramCommandOwnerIdentity = {
      instanceId: 'instance-two', instanceKey: '2'.repeat(64), hostId: owner.hostId, pid: process.pid + 1,
    }
    await expect(synchronizeTelegramCommands(fixture.api, -100123, desired, {
      ownershipStore: store, botId: '123456789', ownerIdentity: second, historicalOwnedNames: historical,
    })).rejects.toMatchObject({ code: 'TELEGRAM_COMMAND_OWNER_CONFLICT' })
    await expect(synchronizeTelegramCommands(fixture.api, -100123, desired, {
      ownershipStore: store, botId: '123456789', ownerIdentity: second, allowOwnerTakeover: true, historicalOwnedNames: historical,
    })).resolves.toBeDefined()

    await store.releaseOwner('123456789', second)
    const otherHost = { ...owner, instanceId: 'remote', instanceKey: '3'.repeat(64), hostId: 'b'.repeat(64), pid: 1 }
    await expect(synchronizeTelegramCommands(fixture.api, -100123, desired, {
      ownershipStore: store, botId: '123456789', ownerIdentity: otherHost, allowOwnerTakeover: true, historicalOwnedNames: historical,
    })).rejects.toMatchObject({ code: 'TELEGRAM_COMMAND_OWNER_CONFLICT' })
  })
})
