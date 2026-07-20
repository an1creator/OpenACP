import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fork } from 'node:child_process'
import { PROXY_STORE_VERSION, ProxyRevisionConflictError, ProxyStore, ProxyStoreCorruptError } from '../proxy-store.js'
import { ProxyService } from '../proxy-service.js'

describe('ProxyStore recovery and concurrency contract', () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-proxy-store-')) })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('uses defaults only for ENOENT', () => {
    const state = new ProxyStore(root).load()
    expect(state).toMatchObject({ version: PROXY_STORE_VERSION, revision: 0, routing: { global: 'inherit' } })
  })

  it('migrates a v1 policy in memory without dropping routes', () => {
    fs.writeFileSync(path.join(root, 'proxy.json'), JSON.stringify({
      version: 1,
      profiles: [],
      routing: { global: 'direct', routes: { 'plugins.legacy': 'inherit' } },
    }), { mode: 0o600 })
    const state = new ProxyStore(root).load()
    expect(state).toMatchObject({ version: PROXY_STORE_VERSION, revision: 0 })
    expect(state.routing.routes).toEqual({ 'plugins.legacy': 'inherit' })
    expect(state.persistedScopes).toContain('plugins.legacy')
  })

  it('normalizes safe bracketed IPv6 during v1 migration', () => {
    fs.writeFileSync(path.join(root, 'proxy.json'), JSON.stringify({
      version: 1,
      profiles: [{ id: 'v6', name: 'IPv6', protocol: 'http', host: '[2001:db8::1]', port: 8080, noProxy: ['::1'], failClosed: true, hasCredentials: false }],
      routing: { global: 'profile:v6', routes: {} },
    }), { mode: 0o600 })
    expect(new ProxyStore(root).load().profiles[0].host).toBe('2001:db8::1')
  })

  it('fails closed, preserves and quarantines corrupt policy', () => {
    const file = path.join(root, 'proxy.json'); fs.writeFileSync(file, '{broken', { mode: 0o600 })
    const before = fs.readFileSync(file, 'utf8')
    expect(() => new ProxyStore(root).load()).toThrow(ProxyStoreCorruptError)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(root).some((name) => name.startsWith('proxy.json.corrupt.'))).toBe(true)
  })

  it('prevents network consumers from silently falling back when policy is corrupt', () => {
    fs.writeFileSync(path.join(root, 'proxy.json'), '{broken', { mode: 0o600 })
    const service = new ProxyService(root)
    expect(() => service.createFetch('channels.telegram')).toThrow(ProxyStoreCorruptError)
    expect(() => service.buildAgentEnv('codex', { PATH: '/bin' })).toThrow(ProxyStoreCorruptError)
    expect(() => service.status()).toThrow(ProxyStoreCorruptError)
  })

  it('recovers a complete journal after a simulated crash', () => {
    const config = { version: PROXY_STORE_VERSION, revision: 4, profiles: [], routing: { global: 'direct', routes: {} }, persistedScopes: [] }
    fs.writeFileSync(path.join(root, 'proxy-transaction.json'), JSON.stringify({ version: 1, config, secrets: {} }), { mode: 0o600 })
    const store = new ProxyStore(root)
    expect(store.load().revision).toBe(4)
    expect(fs.existsSync(path.join(root, 'proxy-transaction.json'))).toBe(false)
  })

  it('rejects stale revisions instead of losing a concurrent update', () => {
    const store = new ProxyStore(root); const first = store.load()
    store.commit({ ...first, routing: { global: 'direct', routes: {} } }, {}, first.revision)
    expect(() => store.commit(first, {}, first.revision)).toThrow(ProxyRevisionConflictError)
  })

  it.each([
    ['userinfo host', (c: any) => { c.profiles[0].host = 'user@proxy.test' }],
    ['duplicate profile id', (c: any) => { c.profiles.push({ ...c.profiles[0] }) }],
    ['invalid scope', (c: any) => { c.routing.routes['bad scope'] = 'direct' }],
    ['missing profile reference', (c: any) => { c.routing.global = 'profile:missing' }],
    ['invalid noProxy type', (c: any) => { c.profiles[0].noProxy = [42] }],
  ])('fails closed and quarantines invalid persisted schema: %s', (_label, mutate) => {
    const config: any = {
      version: PROXY_STORE_VERSION, revision: 1,
      profiles: [{ id: 'safe', name: 'Safe', protocol: 'http', host: 'proxy.test', port: 8080, noProxy: ['localhost'], failClosed: true, hasCredentials: false }],
      routing: { global: 'direct', routes: {} }, persistedScopes: [],
    }
    mutate(config)
    fs.writeFileSync(path.join(root, 'proxy.json'), JSON.stringify(config), { mode: 0o600 })
    expect(() => new ProxyStore(root).load()).toThrow(ProxyStoreCorruptError)
    expect(fs.readdirSync(root).some((name) => name.startsWith('proxy.json.corrupt.'))).toBe(true)
  })

  it('recovers a stale cross-process lock', () => {
    fs.writeFileSync(path.join(root, 'proxy.lock'), JSON.stringify({ pid: 99999999, createdAt: Date.now() - 60_000 }), { mode: 0o600 })
    const store = new ProxyStore(root); const state = store.load()
    expect(store.commit(state, {}, state.revision).revision).toBe(1)
    expect(fs.existsSync(path.join(root, 'proxy.lock'))).toBe(false)
  })

  it('recovers a fresh lock immediately when its recorded process is dead', () => {
    fs.writeFileSync(path.join(root, 'proxy.lock'), JSON.stringify({ pid: 99999999, createdAt: Date.now() }), { mode: 0o600 })
    const started = Date.now()
    const store = new ProxyStore(root); const state = store.load()
    expect(store.commit(state, {}, state.revision).revision).toBe(1)
    expect(Date.now() - started).toBeLessThan(500)
  })

  it('never removes an old lock whose owner process is still live', () => {
    const store = new ProxyStore(root)
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() - 60_000 }), { mode: 0o600 })
    expect((store as any).removeStaleLock()).toBe(false)
    expect(fs.existsSync(store.lockPath)).toBe(true)
  })

  it('rejects credentials metadata that disagrees with the secret store', () => {
    fs.writeFileSync(path.join(root, 'proxy.json'), JSON.stringify({
      version: PROXY_STORE_VERSION, revision: 1,
      profiles: [{ id: 'private', name: 'Private', protocol: 'http', host: 'proxy.test', port: 8080, noProxy: [], failClosed: true, hasCredentials: true }],
      routing: { global: 'direct', routes: {} }, persistedScopes: [],
    }), { mode: 0o600 })
    expect(() => new ProxyStore(root).load()).toThrow(/hasCredentials mismatch/)
  })

  it('serializes real cross-process writers and returns a typed revision conflict', async () => {
    const moduleUrl = new URL('../proxy-store.ts', import.meta.url).href
    const script = path.join(root, 'writer.mjs')
    fs.writeFileSync(script, `import { ProxyStore } from ${JSON.stringify(moduleUrl)};
const store = new ProxyStore(process.argv[2]); const state = store.load();
const send = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()));
const go = new Promise((resolve, reject) => {
  process.once('message', (message) => message?.type === 'go' ? resolve() : reject(new Error('Unexpected parent command')));
  process.once('disconnect', () => reject(new Error('Parent disconnected before releasing writer')));
});
await send({ type: 'ready', revision: state.revision });
await go;
let outcome;
try { store.commit({ ...state, routing: { global: process.argv[3], routes: {} } }, {}, state.revision); outcome = 'ok' }
catch (error) { outcome = error.code || error.name }
await send({ type: 'result', outcome });
process.disconnect();
`, { mode: 0o600 })
    const start = (route: string) => {
      const child = fork(script, [root, route], { execArgv: ['--import', 'tsx'], silent: true })
      let stderr = ''
      let readySeen = false
      let resultSeen = false
      let resolveReady!: (revision: number) => void
      let rejectReady!: (error: Error) => void
      let resolveResult!: (outcome: string) => void
      let rejectResult!: (error: Error) => void
      const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
      const result = new Promise<string>((resolve, reject) => { resolveResult = resolve; rejectResult = reject })
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
      child.stderr?.on('data', (data) => { stderr += data })
      child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null) return
        const event = message as { type?: unknown; revision?: unknown; outcome?: unknown }
        if (event.type === 'ready' && typeof event.revision === 'number' && !readySeen) {
          readySeen = true
          resolveReady(event.revision)
        }
        if (event.type === 'result' && typeof event.outcome === 'string' && !resultSeen) {
          resultSeen = true
          resolveResult(event.outcome)
        }
      })
      const fail = (error: Error) => {
        if (!readySeen) rejectReady(error)
        if (!resultSeen) rejectResult(error)
      }
      child.once('error', fail)
      const completed = new Promise<void>((resolve, reject) => {
        child.once('close', (code) => {
          if (readySeen && resultSeen && code === 0) {
            resolve()
            return
          }
          const error = new Error(`Proxy writer exited with code ${String(code)}${stderr ? `: ${stderr}` : ''}`)
          fail(error)
          reject(error)
        })
      })
      completed.catch(() => {
        // The ready/result promises surface the same child failure while the test is at that barrier.
      })
      result.catch(() => {
        // A writer can fail while the parent is still waiting for both ready messages.
      })
      const release = () => new Promise<void>((resolve, reject) => {
        child.send({ type: 'go' }, (error) => error ? reject(error) : resolve())
      })
      return { child, ready, release, result, completed, closed }
    }

    const routes = ['direct', 'inherit'] as const
    const writers = routes.map((route) => start(route))
    try {
      const revisions = await Promise.all(writers.map((writer) => writer.ready))
      await Promise.all(writers.map((writer) => writer.release()))
      const outcomes = await Promise.all(writers.map((writer) => writer.result))
      await Promise.all(writers.map((writer) => writer.completed))

      expect(revisions).toEqual([0, 0])
      expect([...outcomes].sort()).toEqual(['PROXY_REVISION_CONFLICT', 'ok'])
      const winner = outcomes.indexOf('ok')
      const committed = new ProxyStore(root).load()
      expect(committed.revision).toBe(1)
      expect(committed.routing.global).toBe(routes[winner])
    } finally {
      for (const writer of writers) {
        if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill()
      }
      await Promise.all(writers.map((writer) => writer.closed))
    }
  })
})
