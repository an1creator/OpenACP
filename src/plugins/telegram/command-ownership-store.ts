import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'

const STORE_VERSION = 2
const MAX_BOTS = 8
const MAX_SCOPES_PER_BOT = 64
const MAX_NAMES_PER_SCOPE = 100

interface ScopeOwnership {
  owned: string[]
  updatedAt: string
}

export interface TelegramCommandOwnerIdentity {
  instanceId: string
  instanceKey: string
  hostId: string
  pid: number
}

export interface TelegramCommandOwnerRecord extends TelegramCommandOwnerIdentity {
  heartbeatAt: string
  stoppedAt?: string
}

interface OwnershipLedger {
  version: typeof STORE_VERSION
  bots: Record<string, { scopes: Record<string, ScopeOwnership>; updatedAt: string; owner?: TelegramCommandOwnerRecord }>
}

export class TelegramCommandOwnerConflictError extends Error {
  readonly code = 'TELEGRAM_COMMAND_OWNER_CONFLICT'
  constructor(readonly ownerInstanceId: string) {
    super('This Telegram bot command menu is owned by another OpenACP instance. Configure a unique bot per instance, stop the current owner, or perform an explicit same-host takeover.')
    this.name = 'TelegramCommandOwnerConflictError'
  }
}

export function telegramCommandHostId(): string {
  let source = `${os.hostname()}|${typeof process.getuid === 'function' ? process.getuid() : 'unknown'}`
  try { source = fs.readFileSync('/etc/machine-id', 'utf8').trim() || source } catch { /* platform fallback */ }
  return createHash('sha256').update(source).digest('hex')
}

export function telegramCommandInstanceKey(instanceRoot: string): string {
  return createHash('sha256').update(path.resolve(instanceRoot)).digest('hex')
}

function emptyLedger(): OwnershipLedger {
  return { version: STORE_VERSION, bots: {} }
}

function validateLedger(value: unknown): OwnershipLedger {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid root')
  const ledger = value as OwnershipLedger
  if (ledger.version !== STORE_VERSION || !ledger.bots || typeof ledger.bots !== 'object') throw new Error('invalid version/bots')
  const botEntries = Object.entries(ledger.bots)
  if (botEntries.length > MAX_BOTS) throw new Error('too many bots')
  for (const [botId, bot] of botEntries) {
    if (!/^\d{1,20}$/.test(botId) || !bot || typeof bot !== 'object' || !bot.scopes || typeof bot.scopes !== 'object') throw new Error('invalid bot')
    if (bot.owner) {
      const owner = bot.owner
      if (typeof owner.instanceId !== 'string' || !owner.instanceId || owner.instanceId.length > 128 || /[\u0000-\u001f\u007f]/.test(owner.instanceId)
        || !/^[a-f0-9]{64}$/.test(owner.instanceKey) || !/^[a-f0-9]{64}$/.test(owner.hostId)
        || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || !Number.isFinite(Date.parse(owner.heartbeatAt))
        || (owner.stoppedAt !== undefined && !Number.isFinite(Date.parse(owner.stoppedAt)))) throw new Error('invalid owner')
    }
    const scopes = Object.entries(bot.scopes)
    if (scopes.length > MAX_SCOPES_PER_BOT) throw new Error('too many scopes')
    for (const [key, scope] of scopes) {
      if (!/^(default|chat:[a-f0-9]{16}|chat_administrators:[a-f0-9]{16})\|(neutral|en|ru)$/.test(key)) throw new Error('invalid scope key')
      if (!scope || !Array.isArray(scope.owned) || scope.owned.length > MAX_NAMES_PER_SCOPE) throw new Error('invalid ownership')
      if (scope.owned.some((name) => typeof name !== 'string' || !/^[a-z0-9_]{1,32}$/.test(name))) throw new Error('invalid command name')
    }
  }
  return structuredClone(ledger)
}

/** Durable ownership proof for commands OpenACP is allowed to replace/remove. */
export class TelegramCommandOwnershipStore {
  readonly file: string
  readonly lockFile: string

  constructor(instanceRoot: string) {
    this.file = path.join(instanceRoot, 'telegram-command-ownership.json')
    this.lockFile = `${this.file}.lock`
  }

  async withLock<T>(operation: (state: { ledger: OwnershipLedger; conservative: boolean }) => Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const deadline = Date.now() + 10_000
    let fd: number | undefined
    while (fd === undefined) {
      try {
        fd = fs.openSync(this.lockFile, 'wx', 0o600)
        fs.writeFileSync(fd, String(process.pid))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        try {
          const owner = Number(fs.readFileSync(this.lockFile, 'utf8'))
          let alive = Number.isSafeInteger(owner) && owner > 0
          if (alive) {
            try { process.kill(owner, 0) } catch { alive = false }
          }
          if (!alive) fs.unlinkSync(this.lockFile)
        } catch { /* another owner released it */ }
        if (Date.now() >= deadline) throw new Error('Timed out waiting for Telegram command ownership lock')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }
    try {
      return await operation(this.load())
    } finally {
      try { fs.closeSync(fd) } catch { /* already closed */ }
      try { fs.unlinkSync(this.lockFile) } catch { /* already released */ }
    }
  }

  load(): { ledger: OwnershipLedger; conservative: boolean } {
    if (!fs.existsSync(this.file)) return { ledger: emptyLedger(), conservative: false }
    try {
      return { ledger: validateLedger(JSON.parse(fs.readFileSync(this.file, 'utf8'))), conservative: false }
    } catch {
      // Preserve the damaged bytes for operator recovery. The replacement starts
      // conservatively and will not delete any command without fresh ownership proof.
      const quarantine = `${this.file}.corrupt.${Date.now()}`
      try { fs.renameSync(this.file, quarantine) } catch { /* leave original untouched */ }
      return { ledger: emptyLedger(), conservative: true }
    }
  }

  getOwned(ledger: OwnershipLedger, botId: string, scopeKey: string): string[] | undefined {
    return ledger.bots[botId]?.scopes[scopeKey]?.owned
  }

  /** Claim command-list ownership while the ledger lock is held. */
  claimOwner(
    ledger: OwnershipLedger,
    botId: string,
    identity: TelegramCommandOwnerIdentity,
    allowTakeover = false,
  ): void {
    const now = new Date().toISOString()
    const bot = this.ensureBot(ledger, botId, now)
    const current = bot.owner
    const sameProcess = current?.hostId === identity.hostId
      && current.instanceKey === identity.instanceKey && current.pid === identity.pid
    if (!current || sameProcess || (current.stoppedAt && current.hostId === identity.hostId && current.instanceKey === identity.instanceKey)) {
      bot.owner = { ...identity, heartbeatAt: now }
      bot.updatedAt = now
      return
    }

    const sameHost = current.hostId === identity.hostId
    const provablyStopped = sameHost && (Boolean(current.stoppedAt) || !this.processAlive(current.pid))
    if (allowTakeover && provablyStopped) {
      bot.owner = { ...identity, heartbeatAt: now }
      bot.updatedAt = now
      return
    }
    throw new TelegramCommandOwnerConflictError(current.instanceId)
  }

  async heartbeatOwner(botId: string, identity: TelegramCommandOwnerIdentity): Promise<boolean> {
    return this.withLock(async ({ ledger }) => {
      const bot = ledger.bots[botId]
      const owner = bot?.owner
      if (!owner || owner.hostId !== identity.hostId || owner.instanceKey !== identity.instanceKey || owner.pid !== identity.pid || owner.stoppedAt) return false
      owner.heartbeatAt = new Date().toISOString()
      bot.updatedAt = owner.heartbeatAt
      this.save(ledger)
      return true
    })
  }

  async releaseOwner(botId: string, identity: TelegramCommandOwnerIdentity): Promise<void> {
    await this.withLock(async ({ ledger }) => {
      const bot = ledger.bots[botId]
      const owner = bot?.owner
      if (!owner || owner.hostId !== identity.hostId || owner.instanceKey !== identity.instanceKey || owner.pid !== identity.pid) return
      owner.stoppedAt = new Date().toISOString()
      owner.heartbeatAt = owner.stoppedAt
      bot.updatedAt = owner.stoppedAt
      this.save(ledger)
    })
  }

  getOwner(botId: string): TelegramCommandOwnerRecord | undefined {
    return this.load().ledger.bots[botId]?.owner
  }

  setOwned(ledger: OwnershipLedger, botId: string, scopeKey: string, names: readonly string[]): void {
    const now = new Date().toISOString()
    const bot = this.ensureBot(ledger, botId, now)
    bot.updatedAt = now
    bot.scopes[scopeKey] = { owned: [...new Set(names)].slice(0, MAX_NAMES_PER_SCOPE), updatedAt: now }
  }

  private ensureBot(ledger: OwnershipLedger, botId: string, now: string): OwnershipLedger['bots'][string] {
    if (!ledger.bots[botId]) {
      const entries = Object.entries(ledger.bots).sort((a, b) => a[1].updatedAt.localeCompare(b[1].updatedAt))
      while (entries.length >= MAX_BOTS) {
        const oldest = entries.shift()
        if (oldest) delete ledger.bots[oldest[0]]
      }
      ledger.bots[botId] = { scopes: {}, updatedAt: now }
    }
    return ledger.bots[botId]
  }

  private processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  save(ledger: OwnershipLedger): void {
    const clean = validateLedger(ledger)
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.chmodSync(tmp, 0o600)
    const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd)
    fs.renameSync(tmp, this.file)
    try { const dir = fs.openSync(path.dirname(this.file), 'r'); fs.fsyncSync(dir); fs.closeSync(dir) } catch { /* unsupported */ }
  }
}
