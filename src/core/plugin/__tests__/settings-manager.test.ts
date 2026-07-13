import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { SettingsConflictError, SettingsManager } from '../settings-manager.js'

const execFileAsync = promisify(execFile)

function linuxProcessStartIdentity(pid: number): string {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  const endOfCommand = stat.lastIndexOf(') ')
  if (endOfCommand < 0) throw new Error('invalid proc stat')
  const ticks = stat.slice(endOfCommand + 2).trim().split(/\s+/)[19]
  if (!/^\d+$/.test(ticks ?? '')) throw new Error('missing process start ticks')
  return `linux:${ticks}`
}

describe('SettingsManager', () => {
  let tmpDir: string
  let manager: SettingsManager

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-manager-'))
    manager = new SettingsManager(tmpDir)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tmpDir, { recursive: true })
  })

  it('createAPI returns a SettingsAPI scoped to plugin name', () => {
    const api = manager.createAPI('my-plugin')
    expect(api).toBeDefined()
    expect(api.get).toBeTypeOf('function')
    expect(api.set).toBeTypeOf('function')
    expect(api.getAll).toBeTypeOf('function')
    expect(api.setAll).toBeTypeOf('function')
    expect(api.delete).toBeTypeOf('function')
    expect(api.clear).toBeTypeOf('function')
    expect(api.has).toBeTypeOf('function')
  })

  it('get returns undefined for missing key', async () => {
    const api = manager.createAPI('my-plugin')
    expect(await api.get('missing')).toBeUndefined()
  })

  it('set and get round-trip', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('theme', 'dark')
    expect(await api.get('theme')).toBe('dark')
  })

  it('setAll replaces all settings', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('a', 1)
    await api.set('b', 2)
    await api.setAll({ c: 3 })
    expect(await api.get('a')).toBeUndefined()
    expect(await api.get('b')).toBeUndefined()
    expect(await api.get('c')).toBe(3)
  })

  it('getAll returns all settings', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('x', 10)
    await api.set('y', 20)
    expect(await api.getAll()).toEqual({ x: 10, y: 20 })
  })

  it('getAll returns empty object when no settings', async () => {
    const api = manager.createAPI('my-plugin')
    expect(await api.getAll()).toEqual({})
  })

  it('delete removes a key', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('key', 'value')
    await api.delete('key')
    expect(await api.get('key')).toBeUndefined()
  })

  it('clear removes all settings', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('a', 1)
    await api.set('b', 2)
    await api.clear()
    expect(await api.getAll()).toEqual({})
  })

  it('has returns true for existing key, false for missing', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('exists', true)
    expect(await api.has('exists')).toBe(true)
    expect(await api.has('missing')).toBe(false)
  })

  it('persists to disk across manager instances', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('persist', 'yes')

    const manager2 = new SettingsManager(tmpDir)
    const api2 = manager2.createAPI('my-plugin')
    expect(await api2.get('persist')).toBe('yes')
  })

  it('reads fresh snapshots through APIs created before another manager writes', async () => {
    const first = manager.createAPI('my-plugin')
    const second = new SettingsManager(tmpDir).createAPI('my-plugin')
    await first.set('version', 1)
    expect(await first.get('version')).toBe(1)

    await second.set('version', 2)

    expect(await first.get('version')).toBe(2)
    expect(await first.getAll()).toEqual({ version: 2 })
  })

  it('serializes transactions from multiple manager instances against fresh disk state', async () => {
    const manager2 = new SettingsManager(tmpDir)
    await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const owner = index % 2 === 0 ? manager : manager2
      return owner.transactPluginSettings('counter', (current) => ({
        settings: { count: Number(current.count ?? 0) + 1 },
        result: undefined,
      }))
    }))
    await expect(manager.loadSettings('counter')).resolves.toEqual({ count: 12 })
  })

  it('serializes writers in two independent Node processes without losing updates', async () => {
    const settingsManagerUrl = new URL('../settings-manager.ts', import.meta.url).href
    const worker = (owner: string) => `
      import { SettingsManager } from ${JSON.stringify(settingsManagerUrl)}
      const manager = new SettingsManager(${JSON.stringify(tmpDir)})
      for (let index = 0; index < 15; index += 1) {
        await manager.transactPluginSettings('cross-process', async (current) => {
          await new Promise((resolve) => setTimeout(resolve, index % 3))
          return {
            settings: {
              ...current,
              count: Number(current.count ?? 0) + 1,
              [${JSON.stringify(owner)}]: Number(current[${JSON.stringify(owner)}] ?? 0) + 1,
            },
            result: undefined,
          }
        })
      }
    `

    await Promise.all(['writer-a', 'writer-b'].map((owner) => execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', worker(owner)],
      { cwd: process.cwd(), timeout: 30_000 },
    )))

    await expect(manager.loadSettings('cross-process')).resolves.toEqual({
      count: 30,
      'writer-a': 15,
      'writer-b': 15,
    })
  }, 35_000)

  it('reclaims an abandoned filesystem lock and keeps lock artifacts private', async () => {
    const settingsPath = manager.getSettingsPath('stale-lock')
    const lockPath = `${settingsPath}.lock`
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o777 })
    fs.chmodSync(lockPath, 0o777)
    const ownerPath = path.join(lockPath, 'owner.json')
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: 9_999_999, owner: 'dead-process', acquiredAt: Date.now() }), { mode: 0o666 })
    fs.chmodSync(ownerPath, 0o666)

    await manager.createAPI('stale-lock').set('recovered', true)

    expect(fs.existsSync(lockPath)).toBe(false)
    expect(await manager.loadSettings('stale-lock')).toEqual({ recovered: true })
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(settingsPath)).mode & 0o777).toBe(0o700)
  })

  it('reclaims an old incomplete lock left before owner metadata was written', async () => {
    const settingsPath = manager.getSettingsPath('incomplete-lock')
    const lockPath = `${settingsPath}.lock`
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 })
    const old = new Date(Date.now() - 2_000)
    fs.utimesSync(lockPath, old, old)

    const started = Date.now()
    await manager.createAPI('incomplete-lock').set('recovered', true)

    expect(Date.now() - started).toBeLessThan(500)
    expect(fs.existsSync(lockPath)).toBe(false)
    await expect(manager.loadSettings('incomplete-lock')).resolves.toEqual({ recovered: true })
  })

  it('gives fresh incomplete metadata a grace period, then recovers it well before the 30-second lock wait', async () => {
    const settingsPath = manager.getSettingsPath('fresh-incomplete-lock')
    const lockPath = `${settingsPath}.lock`
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 })

    let completed = false
    const started = Date.now()
    const write = manager.createAPI('fresh-incomplete-lock').set('recovered', true).then(() => { completed = true })
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(completed).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    await write
    expect(Date.now() - started).toBeLessThan(2_500)
    expect(await manager.loadSettings('fresh-incomplete-lock')).toEqual({ recovered: true })
  })

  it('reclaims old legacy metadata with an unverifiable live owner without waiting 30 seconds', async () => {
    const settingsPath = manager.getSettingsPath('old-legacy-owner')
    const lockPath = `${settingsPath}.lock`
    const oldTime = Date.now() - 3 * 60_000
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid,
      owner: 'legacy-owner-without-start-identity',
      acquiredAt: oldTime,
    }), { mode: 0o600 })
    const old = new Date(oldTime)
    fs.utimesSync(lockPath, old, old)

    const started = Date.now()
    await manager.createAPI('old-legacy-owner').set('recovered', true)

    expect(Date.now() - started).toBeLessThan(500)
    expect(await manager.loadSettings('old-legacy-owner')).toEqual({ recovered: true })
  })

  it.runIf(process.platform === 'linux')('reclaims a reused live foreign PID whose process start identity mismatches', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      if (!child.pid) throw new Error('child PID unavailable')
      const actualIdentity = linuxProcessStartIdentity(child.pid)
      const actualTicks = actualIdentity.slice('linux:'.length)
      const settingsPath = manager.getSettingsPath('reused-pid')
      const lockPath = `${settingsPath}.lock`
      fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        version: 1,
        pid: child.pid,
        owner: 'previous-process',
        acquiredAt: Date.now(),
        processStartIdentity: `linux:${BigInt(actualTicks) + 1n}`,
      }), { mode: 0o600 })

      const started = Date.now()
      await manager.createAPI('reused-pid').set('recovered', true)

      expect(Date.now() - started).toBeLessThan(500)
      expect(await manager.loadSettings('reused-pid')).toEqual({ recovered: true })
      expect(fs.existsSync(lockPath)).toBe(false)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it.runIf(process.platform === 'linux')('does not reclaim an old lock whose live process identity matches', async () => {
    const settingsPath = manager.getSettingsPath('matching-owner')
    const lockPath = `${settingsPath}.lock`
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      version: 1,
      pid: process.pid,
      owner: 'active-owner',
      acquiredAt: Date.now() - 5 * 60_000,
      processStartIdentity: linuxProcessStartIdentity(process.pid),
    }), { mode: 0o600 })
    const old = new Date(Date.now() - 5 * 60_000)
    fs.utimesSync(lockPath, old, old)

    let completed = false
    const write = manager.createAPI('matching-owner').set('afterRelease', true).then(() => { completed = true })
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(completed).toBe(false)
    expect(fs.existsSync(lockPath)).toBe(true)
    fs.rmSync(lockPath, { recursive: true, force: true })
    await write
    expect(await manager.loadSettings('matching-owner')).toEqual({ afterRelease: true })
  })

  it('does not follow a settings lock symlink during recovery', async () => {
    const settingsPath = manager.getSettingsPath('lock-symlink')
    const lockPath = `${settingsPath}.lock`
    const victim = path.join(tmpDir, 'lock-victim')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 })
    fs.mkdirSync(victim, { mode: 0o700 })
    fs.writeFileSync(path.join(victim, 'marker'), 'preserved', { mode: 0o600 })
    fs.symlinkSync(victim, lockPath, 'dir')

    await manager.createAPI('lock-symlink').set('safe', true)

    expect(fs.readFileSync(path.join(victim, 'marker'), 'utf8')).toBe('preserved')
    expect(await manager.loadSettings('lock-symlink')).toEqual({ safe: true })
  })

  it('does not follow owner metadata symlinks or change their target mode', async () => {
    const settingsPath = manager.getSettingsPath('owner-symlink')
    const lockPath = `${settingsPath}.lock`
    const victim = path.join(tmpDir, 'owner-victim.json')
    fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 })
    fs.writeFileSync(victim, '{"preserved":true}', { mode: 0o644 })
    fs.chmodSync(victim, 0o644)
    fs.symlinkSync(victim, path.join(lockPath, 'owner.json'))
    const old = new Date(Date.now() - 2_000)
    fs.utimesSync(lockPath, old, old)

    await manager.createAPI('owner-symlink').set('safe', true)

    expect(fs.readFileSync(victim, 'utf8')).toBe('{"preserved":true}')
    expect(fs.statSync(victim).mode & 0o777).toBe(0o644)
  })

  it('creates 0700 lock directories and 0600 identity metadata', async () => {
    const settingsPath = manager.getSettingsPath('private-lock')
    const lockPath = `${settingsPath}.lock`
    let lockMode = 0
    let ownerMode = 0
    let metadata: Record<string, unknown> = {}

    await manager.transactPluginSettings('private-lock', () => {
      lockMode = fs.statSync(lockPath).mode & 0o777
      const ownerPath = path.join(lockPath, 'owner.json')
      ownerMode = fs.statSync(ownerPath).mode & 0o777
      metadata = JSON.parse(fs.readFileSync(ownerPath, 'utf8'))
      return { settings: { saved: true }, result: undefined }
    })

    expect(lockMode).toBe(0o700)
    expect(ownerMode).toBe(0o600)
    expect(metadata).toMatchObject({ version: 1, pid: process.pid })
    expect(metadata.owner).toEqual(expect.any(String))
    expect(metadata).toHaveProperty('processStartIdentity')
  })

  it('retries a content conflict from a fresh snapshot without losing the competing update', async () => {
    const settingsPath = manager.getSettingsPath('conflict')
    let attempts = 0

    await manager.transactPluginSettings('conflict', (current) => {
      attempts += 1
      if (attempts === 1) {
        fs.writeFileSync(settingsPath, '{"external":true}\n', { mode: 0o600 })
      }
      return { settings: { ...current, managed: true }, result: undefined }
    })

    expect(attempts).toBe(2)
    await expect(manager.loadSettings('conflict')).resolves.toEqual({ external: true, managed: true })
  })

  it('aborts after repeated content conflicts without applying runtime state', async () => {
    const settingsPath = manager.getSettingsPath('conflict-abort')
    let attempts = 0
    const apply = vi.fn()

    await expect(manager.transactPluginSettings('conflict-abort', () => {
      attempts += 1
      fs.writeFileSync(settingsPath, `${JSON.stringify({ externalRevision: attempts })}\n`, { mode: 0o600 })
      return { settings: { managed: true }, result: undefined, apply }
    })).rejects.toBeInstanceOf(SettingsConflictError)

    expect(attempts).toBe(3)
    expect(apply).not.toHaveBeenCalled()
    await expect(manager.loadSettings('conflict-abort')).resolves.toEqual({ externalRevision: 3 })
  })

  it('restores saved settings and the supplied side effect when runtime apply fails', async () => {
    await manager.updatePluginSettings('speech', { provider: 'old', secret: 'preserved' })
    let runtime = 'old'

    await expect(manager.transactPluginSettings('speech', () => ({
      settings: { provider: 'new', secret: 'replacement' },
      result: undefined,
      apply: () => {
        runtime = 'new'
        throw new Error('runtime swap failed')
      },
      rollback: () => { runtime = 'old' },
    }))).rejects.toThrow('runtime swap failed')

    expect(runtime).toBe('old')
    await expect(manager.loadSettings('speech')).resolves.toEqual({ provider: 'old', secret: 'preserved' })
  })

  it('restores the exact previous file content when runtime apply fails', async () => {
    const settingsPath = manager.getSettingsPath('exact-rollback')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 })
    const original = '{\n  "provider" : "old",\n  "secret": "preserved"\n}'
    fs.writeFileSync(settingsPath, original, { mode: 0o600 })
    let runtime = 'old'

    await expect(manager.transactPluginSettings('exact-rollback', () => ({
      settings: { provider: 'new', secret: 'replacement' },
      result: undefined,
      apply: () => {
        runtime = 'new'
        throw new Error('runtime swap failed')
      },
      rollback: () => { runtime = 'old' },
    }))).rejects.toThrow('runtime swap failed')

    expect(runtime).toBe('old')
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(original)
  })

  it('writes settings atomically with secret-safe file and directory modes', async () => {
    const api = manager.createAPI('@openacp/speech')
    await api.set('groqApiKey', 'gsk_private')
    const settingsPath = manager.getSettingsPath('@openacp/speech')
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(settingsPath)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.dirname(path.dirname(settingsPath))).mode & 0o777).toBe(0o700)
    expect(fs.readdirSync(path.dirname(settingsPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('secures the settings base directory itself on construction and every access', async () => {
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700)
    fs.chmodSync(tmpDir, 0o777)
    await manager.loadSettings('nonexistent')
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700)
    fs.chmodSync(tmpDir, 0o777)
    await manager.createAPI('plugin').setAll({ secret: true })
    expect(fs.statSync(tmpDir).mode & 0o777).toBe(0o700)
  })

  it('fails closed when the base directory mode cannot be secured', async () => {
    fs.chmodSync(tmpDir, 0o777)
    const originalChmod = fs.chmodSync.bind(fs)
    vi.spyOn(fs, 'chmodSync').mockImplementation((target, mode) => {
      if (path.resolve(String(target)) === path.resolve(tmpDir)) throw new Error('base chmod denied')
      return originalChmod(target, mode)
    })
    await expect(manager.loadSettings('nonexistent')).rejects.toThrow('base chmod denied')
  })

  it('repairs permissive existing settings and parent modes before reading', async () => {
    const settingsPath = manager.getSettingsPath('legacy-plugin')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o777 })
    fs.chmodSync(path.dirname(settingsPath), 0o777)
    fs.writeFileSync(settingsPath, '{"secret":"legacy"}', { mode: 0o644 })
    fs.chmodSync(settingsPath, 0o644)
    expect(await manager.loadSettings('legacy-plugin')).toEqual({ secret: 'legacy' })
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(settingsPath)).mode & 0o777).toBe(0o700)
  })

  it('fails closed when existing settings permissions cannot be repaired', async () => {
    const settingsPath = manager.getSettingsPath('locked-plugin')
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{"secret":"locked"}', { mode: 0o644 })
    vi.spyOn(fs, 'chmodSync').mockImplementationOnce(() => { throw new Error('chmod denied') })
    await expect(manager.loadSettings('locked-plugin')).rejects.toThrow('chmod denied')
  })

  it('isolates settings between plugins', async () => {
    const apiA = manager.createAPI('plugin-a')
    const apiB = manager.createAPI('plugin-b')

    await apiA.set('key', 'from-a')
    await apiB.set('key', 'from-b')

    expect(await apiA.get('key')).toBe('from-a')
    expect(await apiB.get('key')).toBe('from-b')
  })

  it('loadSettings returns empty object when no file', async () => {
    const settings = await manager.loadSettings('nonexistent')
    expect(settings).toEqual({})
  })

  it('loadSettings returns saved settings', async () => {
    const api = manager.createAPI('my-plugin')
    await api.set('loaded', true)

    const settings = await manager.loadSettings('my-plugin')
    expect(settings).toEqual({ loaded: true })
  })

  it('validateSettings returns valid for correct settings', () => {
    const schema = z.object({
      port: z.number(),
      host: z.string(),
    })
    const result = manager.validateSettings('my-plugin', { port: 3000, host: 'localhost' }, schema)
    expect(result.valid).toBe(true)
    expect(result.errors).toBeUndefined()
  })

  it('validateSettings returns invalid for incorrect settings', () => {
    const schema = z.object({
      port: z.number(),
      host: z.string(),
    })
    const result = manager.validateSettings('my-plugin', { port: 'not-a-number', host: 123 }, schema)
    expect(result.valid).toBe(false)
    expect(result.errors).toBeDefined()
    expect(result.errors!.length).toBeGreaterThan(0)
  })

  it('validateSettings returns valid when no schema', () => {
    const result = manager.validateSettings('my-plugin', { anything: 'goes' })
    expect(result.valid).toBe(true)
  })

  it('getSettingsPath returns correct path for scoped package', () => {
    const settingsPath = manager.getSettingsPath('@openacp/adapter-discord')
    expect(settingsPath).toBe(path.join(tmpDir, '@openacp/adapter-discord', 'settings.json'))
  })
})
