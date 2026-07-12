import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import type { ProxyProfile, ProxyRoutingConfig } from './proxy-types.js'

export const PROXY_STORE_VERSION = 2 as const

export interface StoredProxyConfig {
  version: typeof PROXY_STORE_VERSION
  revision: number
  profiles: ProxyProfile[]
  routing: ProxyRoutingConfig
  persistedScopes: string[]
}

export interface SecretRecord { username?: string; password?: string }
interface TransactionRecord { version: 1; config: StoredProxyConfig; secrets: Record<string, SecretRecord> }

const DEFAULT_CONFIG: StoredProxyConfig = {
  version: PROXY_STORE_VERSION,
  revision: 0,
  profiles: [],
  routing: { global: 'inherit', routes: {} },
  persistedScopes: [],
}

export class ProxyStoreError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message); this.name = 'ProxyStoreError'
  }
}
export class ProxyStoreCorruptError extends ProxyStoreError {
  constructor(file: string, reason: string, quarantine?: string, lkgAvailable = false) {
    super('PROXY_STORE_CORRUPT', `Proxy policy store is invalid (${path.basename(file)}): ${reason}`, { file, quarantine, lkgAvailable })
    this.name = 'ProxyStoreCorruptError'
  }
}
export class ProxyRevisionConflictError extends ProxyStoreError {
  constructor(expected: number, actual: number) {
    super('PROXY_REVISION_CONFLICT', `Proxy policy changed concurrently (expected revision ${expected}, current ${actual})`, { expected, actual })
    this.name = 'ProxyRevisionConflictError'
  }
}

function atomicWrite(file: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: 'wx' })
  fs.chmodSync(tmp, mode)
  const fd = fs.openSync(tmp, 'r'); fs.fsyncSync(fd); fs.closeSync(fd)
  fs.renameSync(tmp, file)
  try { const dir = fs.openSync(path.dirname(file), 'r'); fs.fsyncSync(dir); fs.closeSync(dir) } catch { /* unsupported on some platforms */ }
}

function isRoute(value: unknown): value is string {
  return value === 'direct' || value === 'inherit' || (typeof value === 'string' && /^profile:[a-z0-9][a-z0-9._-]{0,63}$/i.test(value))
}

export function isProxyScope(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)+$/i.test(value) && value.length <= 160
}

function canonicalStoredHost(value: unknown): string {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f\s/@?#]/.test(value)) throw new Error('invalid profile host')
  if (value.startsWith('[') && value.endsWith(']') && net.isIP(value.slice(1, -1)) === 6) return value.slice(1, -1).toLowerCase()
  if (net.isIP(value) === 4 || net.isIP(value) === 6) return value.toLowerCase()
  const host = value.toLowerCase().replace(/\.$/, '')
  if (host.length > 253 || !host.split('.').every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) throw new Error('invalid profile host')
  return host
}

function validateConfig(value: unknown): StoredProxyConfig {
  if (!value || typeof value !== 'object') throw new Error('root must be an object')
  const v = value as Record<string, any>
  if (v.version === 1) {
    v.version = PROXY_STORE_VERSION; v.revision = 0; v.persistedScopes = Object.keys(v.routing?.routes ?? {})
  }
  if (v.version !== PROXY_STORE_VERSION) throw new Error(`unsupported version ${String(v.version)}`)
  if (!Number.isSafeInteger(v.revision) || v.revision < 0) throw new Error('revision must be a non-negative integer')
  if (!Array.isArray(v.profiles) || !v.routing || typeof v.routing !== 'object' || !isRoute(v.routing.global) || !v.routing.routes || typeof v.routing.routes !== 'object' || Array.isArray(v.routing.routes)) throw new Error('invalid profiles/routing shape')
  const ids = new Set<string>()
  for (const p of v.profiles) {
    if (!p || typeof p !== 'object' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(p.id) || ids.has(p.id) || !['http', 'https', 'socks5', 'socks5h'].includes(p.protocol) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) throw new Error('invalid profile')
    ids.add(p.id); p.host = canonicalStoredHost(p.host)
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 || typeof p.failClosed !== 'boolean' || typeof p.hasCredentials !== 'boolean') throw new Error('invalid profile fields')
    if (!Array.isArray(p.noProxy) || p.noProxy.length > 256 || p.noProxy.some((item: unknown) => typeof item !== 'string' || !item.trim() || /[\u0000-\u001f\u007f\s]/.test(item))) throw new Error('invalid noProxy')
  }
  for (const [scope, route] of Object.entries(v.routing.routes)) {
    if (!isProxyScope(scope) || !isRoute(route)) throw new Error(`invalid route for ${scope}`)
  }
  for (const route of [v.routing.global, ...Object.values(v.routing.routes)] as string[]) {
    if (route.startsWith('profile:') && !ids.has(route.slice(8))) throw new Error(`route references missing profile ${route.slice(8)}`)
  }
  if (!Array.isArray(v.persistedScopes) || v.persistedScopes.some((s: unknown) => !isProxyScope(s)) || new Set(v.persistedScopes).size !== v.persistedScopes.length) throw new Error('invalid persisted scopes')
  return structuredClone(v as StoredProxyConfig)
}

function validateSecrets(value: unknown): Record<string, SecretRecord> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('secrets root must be an object')
  for (const [id, record] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) throw new Error('invalid secret profile id')
    if (!record || typeof record !== 'object') throw new Error('invalid secret record')
    const r = record as SecretRecord
    if (r.username !== undefined && (typeof r.username !== 'string' || r.username.length > 4096 || /[\r\n\u0000]/.test(r.username))) throw new Error('invalid secret username')
    if (r.password !== undefined && (typeof r.password !== 'string' || r.password.length > 4096 || /[\r\n\u0000]/.test(r.password))) throw new Error('invalid secret password')
  }
  return structuredClone(value as Record<string, SecretRecord>)
}

function validateCredentialConsistency(config: StoredProxyConfig, secrets: Record<string, SecretRecord>): void {
  const profiles = new Map(config.profiles.map((profile) => [profile.id, profile]))
  for (const id of Object.keys(secrets)) {
    if (!profiles.has(id)) throw new Error(`credentials reference missing profile ${id}`)
  }
  for (const profile of config.profiles) {
    const secret = secrets[profile.id]
    const present = Boolean(secret?.username || secret?.password)
    if (profile.hasCredentials !== present) throw new Error(`hasCredentials mismatch for profile ${profile.id}`)
  }
}

export class ProxyStore {
  readonly configPath: string
  readonly secretsPath: string
  readonly journalPath: string
  readonly lkgPath: string
  readonly lockPath: string

  constructor(instanceRoot: string) {
    this.configPath = path.join(instanceRoot, 'proxy.json')
    this.secretsPath = path.join(instanceRoot, 'proxy-secrets.json')
    this.journalPath = path.join(instanceRoot, 'proxy-transaction.json')
    this.lkgPath = path.join(instanceRoot, 'proxy-lkg.json')
    this.lockPath = path.join(instanceRoot, 'proxy.lock')
    const lock = this.acquireLock()
    try {
      this.cleanupOrphans(instanceRoot)
      this.recoverJournal()
    } finally { this.releaseLock(lock) }
  }

  private cleanupOrphans(root: string): void {
    try {
      const names = fs.readdirSync(root)
      for (const name of names) if (/^proxy.*\.tmp$/.test(name)) fs.rmSync(path.join(root, name), { force: true })
      const quarantines = names.filter((n) => n.includes('.corrupt.')).sort().reverse()
      for (const name of quarantines.slice(3)) fs.rmSync(path.join(root, name), { force: true })
    } catch { /* root may not exist yet */ }
  }

  private quarantine(file: string): string | undefined {
    try {
      const target = `${file}.corrupt.${Date.now()}`
      fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, 0o600)
      return target
    } catch { return undefined }
  }

  private readConfigFile(file = this.configPath): StoredProxyConfig {
    try { return validateConfig(JSON.parse(fs.readFileSync(file, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && file === this.configPath) return structuredClone(DEFAULT_CONFIG)
      const q = file === this.configPath ? this.quarantine(file) : undefined
      throw new ProxyStoreCorruptError(file, (error as Error).message, q, fs.existsSync(this.lkgPath))
    }
  }

  private readSecretsFile(): Record<string, SecretRecord> {
    try {
      const stat = fs.statSync(this.secretsPath)
      if ((stat.mode & 0o077) !== 0) throw new Error('secret file mode must be 0600')
      return validateSecrets(JSON.parse(fs.readFileSync(this.secretsPath, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      const q = this.quarantine(this.secretsPath)
      throw new ProxyStoreCorruptError(this.secretsPath, (error as Error).message, q, fs.existsSync(this.lkgPath))
    }
  }

  private recoverJournal(): void {
    if (!fs.existsSync(this.journalPath)) return
    try {
      const tx = JSON.parse(fs.readFileSync(this.journalPath, 'utf8')) as TransactionRecord
      if (tx.version !== 1) throw new Error('unsupported transaction version')
      const config = validateConfig(tx.config); const secrets = validateSecrets(tx.secrets)
      validateCredentialConsistency(config, secrets)
      atomicWrite(this.configPath, config, 0o600); atomicWrite(this.secretsPath, secrets, 0o600)
      atomicWrite(this.lkgPath, tx, 0o600); fs.unlinkSync(this.journalPath)
    } catch (error) {
      throw new ProxyStoreCorruptError(this.journalPath, (error as Error).message, this.quarantine(this.journalPath), fs.existsSync(this.lkgPath))
    }
  }

  load(): StoredProxyConfig {
    const config = this.readConfigFile()
    try {
      validateCredentialConsistency(config, this.readSecretsFile())
    } catch (error) {
      if (error instanceof ProxyStoreCorruptError) throw error
      throw new ProxyStoreCorruptError(this.secretsPath, (error as Error).message, this.quarantine(this.secretsPath), fs.existsSync(this.lkgPath))
    }
    return config
  }
  getSecrets(): Record<string, SecretRecord> {
    const config = this.readConfigFile(); const secrets = this.readSecretsFile()
    try { validateCredentialConsistency(config, secrets) }
    catch (error) { throw new ProxyStoreCorruptError(this.secretsPath, (error as Error).message, this.quarantine(this.secretsPath), fs.existsSync(this.lkgPath)) }
    return secrets
  }
  getSecret(id: string): SecretRecord | undefined { return this.getSecrets()[id] }

  commit(config: StoredProxyConfig, secrets: Record<string, SecretRecord>, expectedRevision: number): StoredProxyConfig {
    const lock = this.acquireLock()
    try {
      this.recoverJournal()
      const actual = this.load().revision
      if (actual !== expectedRevision) throw new ProxyRevisionConflictError(expectedRevision, actual)
      const next = validateConfig({ ...config, version: PROXY_STORE_VERSION, revision: actual + 1 })
      const cleanSecrets = validateSecrets(secrets)
      validateCredentialConsistency(next, cleanSecrets)
      const tx: TransactionRecord = { version: 1, config: next, secrets: cleanSecrets }
      atomicWrite(this.journalPath, tx, 0o600)
      atomicWrite(this.configPath, next, 0o600)
      atomicWrite(this.secretsPath, cleanSecrets, 0o600)
      atomicWrite(this.lkgPath, tx, 0o600)
      fs.unlinkSync(this.journalPath)
      return next
    } finally { this.releaseLock(lock) }
  }

  private releaseLock(fd: number): void {
    try { fs.closeSync(fd) } catch {}
    try { fs.unlinkSync(this.lockPath) } catch {}
  }

  private acquireLock(): number {
    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true, mode: 0o700 })
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600)
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() })); fs.fsyncSync(fd)
        return fd
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (this.removeStaleLock()) continue
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    throw new ProxyStoreError('PROXY_STORE_BUSY', 'Proxy policy store is locked by another process')
  }

  private removeStaleLock(): boolean {
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number; createdAt?: number }
      const old = !Number.isFinite(lock.createdAt) || Date.now() - Number(lock.createdAt) > 30_000
      let dead = false
      if (Number.isInteger(lock.pid)) { try { process.kill(lock.pid!, 0) } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH' } }
      if (dead || old && !Number.isInteger(lock.pid)) { fs.unlinkSync(this.lockPath); return true }
    } catch {
      try { if (Date.now() - fs.statSync(this.lockPath).mtimeMs > 30_000) { fs.unlinkSync(this.lockPath); return true } } catch {}
    }
    return false
  }

  loadLastKnownGood(): StoredProxyConfig | undefined {
    try { return validateConfig((JSON.parse(fs.readFileSync(this.lkgPath, 'utf8')) as TransactionRecord).config) } catch { return undefined }
  }
}
