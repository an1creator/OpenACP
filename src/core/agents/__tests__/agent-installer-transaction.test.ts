import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegistryAgent } from '../../types.js'
import { AgentStore } from '../agent-store.js'
import { getPlatformKey, installAgent } from '../agent-installer.js'

describe('binary agent installation transaction', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('keeps the prior runtime and metadata when the replacement archive fails verification', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agent-transaction-'))
    roots.push(root)
    const agentsDir = path.join(root, 'agents')
    const installedDir = path.join(agentsDir, 'crow-cli')
    fs.mkdirSync(installedDir, { recursive: true })
    fs.writeFileSync(path.join(installedDir, 'crow-cli'), 'old-runtime', { mode: 0o755 })

    const store = new AgentStore(path.join(root, 'agents.json'))
    store.addAgent('crow', {
      registryId: 'crow-cli', name: 'crow-cli', version: '0.1.23', distribution: 'binary',
      command: path.join(installedDir, 'crow-cli'), args: ['acp'], env: {},
      installedAt: '2026-07-17T00:00:00.000Z', binaryPath: installedDir,
    })

    const archiveSource = path.join(root, 'archive-source')
    fs.mkdirSync(archiveSource)
    fs.writeFileSync(path.join(archiveSource, 'wrong-command'), 'invalid', { mode: 0o755 })
    const archivePath = path.join(root, 'crow.tar.gz')
    execFileSync('tar', ['czf', archivePath, '-C', archiveSource, '.'])
    const archive = fs.readFileSync(archivePath)
    const agent: RegistryAgent = {
      id: 'crow-cli', name: 'crow-cli', version: '0.1.24', description: 'Crow',
      distribution: { binary: { [getPlatformKey()]: {
        archive: 'https://example.test/crow.tar.gz', cmd: './crow-cli', args: ['acp'],
      } } },
    }

    const result = await installAgent(
      agent,
      store,
      undefined,
      agentsDir,
      async () => new Response(archive, {
        status: 200,
        headers: { 'content-length': String(archive.length) },
      }),
    )

    expect(result.ok).toBe(false)
    expect(store.getAgent('crow')).toMatchObject({
      version: '0.1.23', command: path.join(installedDir, 'crow-cli'),
    })
    expect(fs.readFileSync(path.join(installedDir, 'crow-cli'), 'utf8')).toBe('old-runtime')
    expect(fs.readdirSync(agentsDir).filter((name) => name.startsWith('.crow-cli-'))).toEqual([])
  })

  it('rejects a checksum mismatch before activation and leaves the prior install untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agent-checksum-'))
    roots.push(root)
    const agentsDir = path.join(root, 'agents')
    const installedDir = path.join(agentsDir, 'checked-agent')
    fs.mkdirSync(installedDir, { recursive: true })
    fs.writeFileSync(path.join(installedDir, 'checked-agent'), 'old-runtime', { mode: 0o755 })
    const store = new AgentStore(path.join(root, 'agents.json'))
    store.addAgent('checked-agent', {
      registryId: 'checked-agent', name: 'Checked agent', version: '1.0.0', distribution: 'binary',
      command: path.join(installedDir, 'checked-agent'), args: [], env: {},
      installedAt: '2026-07-17T00:00:00.000Z', binaryPath: installedDir,
    })
    const payload = Buffer.from('new-runtime')
    const agent: RegistryAgent = {
      id: 'checked-agent', name: 'Checked agent', version: '2.0.0', description: 'test',
      distribution: { binary: { [getPlatformKey()]: {
        archive: 'https://example.test/checked-agent', cmd: './checked-agent', sha256: '0'.repeat(64),
      } } },
    }

    const result = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload))

    expect(result.ok).toBe(false)
    expect(store.getAgent('checked-agent')?.version).toBe('1.0.0')
    expect(fs.readFileSync(path.join(installedDir, 'checked-agent'), 'utf8')).toBe('old-runtime')
    expect(fs.readdirSync(agentsDir).filter((name) => name.startsWith('.checked-agent-'))).toEqual([])
  })

  it('rejects a registry agent ID that escapes the installation root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agent-id-'))
    roots.push(root)
    const agentsDir = path.join(root, 'agents')
    const store = new AgentStore(path.join(root, 'agents.json'))
    const agent: RegistryAgent = {
      id: '../outside-agent', name: 'Unsafe agent', version: '1.0.0', description: 'test',
      distribution: { binary: { [getPlatformKey()]: {
        archive: 'https://example.test/outside-agent', cmd: './outside-agent',
      } } },
    }

    const result = await installAgent(
      agent, store, undefined, agentsDir,
      async () => new Response(Buffer.from('payload')),
    )

    expect(result.ok).toBe(false)
    expect(fs.existsSync(path.join(root, 'outside-agent'))).toBe(false)
    expect(store.getInstalled()).toEqual({})
  })

  it('restores the prior runtime and metadata when agents.json persistence fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agent-store-rollback-'))
    roots.push(root)
    const agentsDir = path.join(root, 'agents')
    const installedDir = path.join(agentsDir, 'persisted-agent')
    fs.mkdirSync(installedDir, { recursive: true })
    fs.writeFileSync(path.join(installedDir, 'persisted-agent'), 'old-runtime', { mode: 0o755 })
    const storePath = path.join(root, 'agents.json')
    const store = new AgentStore(storePath)
    store.addAgent('persisted-agent', {
      registryId: 'persisted-agent', name: 'Persisted agent', version: '1.0.0', distribution: 'binary',
      command: path.join(installedDir, 'persisted-agent'), args: [], env: { KEEP: 'yes' },
      installedAt: '2026-07-17T00:00:00.000Z', binaryPath: installedDir,
    })
    const oldStoreFile = fs.readFileSync(storePath, 'utf8')
    const source = path.join(root, 'source')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'persisted-agent'), 'new-runtime', { mode: 0o755 })
    const archivePath = path.join(root, 'persisted-agent.tgz')
    execFileSync('tar', ['czf', archivePath, '-C', source, '.'])
    const archive = fs.readFileSync(archivePath)
    const agent: RegistryAgent = {
      id: 'persisted-agent', name: 'Persisted agent', version: '2.0.0', description: 'test',
      distribution: { binary: { [getPlatformKey()]: {
        archive: 'https://example.test/persisted-agent.tgz', cmd: './persisted-agent',
        sha256: crypto.createHash('sha256').update(archive).digest('hex'),
      } } },
    }
    vi.spyOn(store as any, 'save').mockImplementationOnce(() => { throw new Error('disk full') })

    const result = await installAgent(
      agent, store, undefined, agentsDir,
      async () => new Response(archive, { headers: { 'content-length': String(archive.length) } }),
    )

    expect(result.ok).toBe(false)
    expect(store.getAgent('persisted-agent')).toMatchObject({ version: '1.0.0', env: { KEEP: 'yes' } })
    expect(fs.readFileSync(storePath, 'utf8')).toBe(oldStoreFile)
    expect(fs.readFileSync(path.join(installedDir, 'persisted-agent'), 'utf8')).toBe('old-runtime')
    expect(fs.readdirSync(agentsDir).filter((name) => name.startsWith('.persisted-agent-'))).toEqual([])
  })

  it('installs zip, tar.bz2, and raw payloads and cleans every transaction artifact', async () => {
    for (const payloadKind of ['zip', 'tar.bz2', 'raw'] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `openacp-agent-${payloadKind.replace('.', '-')}-`))
      roots.push(root)
      const agentsDir = path.join(root, 'agents')
      const commandName = `format-agent-${payloadKind.replace('.', '-')}`
      let payload: Buffer
      let archive: string
      if (payloadKind === 'tar.bz2') {
        const source = path.join(root, 'source')
        fs.mkdirSync(source)
        fs.writeFileSync(path.join(source, commandName), 'bzip-runtime', { mode: 0o644 })
        const archivePath = path.join(root, `${commandName}.tbz2`)
        execFileSync('tar', ['cjf', archivePath, '-C', source, '.'])
        payload = fs.readFileSync(archivePath)
        archive = `https://example.test/${commandName}.tbz2`
      } else if (payloadKind === 'zip') {
        const source = path.join(root, 'source')
        fs.mkdirSync(source)
        fs.writeFileSync(path.join(source, commandName), 'zip-runtime', { mode: 0o644 })
        const archivePath = path.join(root, `${commandName}.zip`)
        execFileSync('zip', ['-q', '-j', archivePath, path.join(source, commandName)])
        payload = fs.readFileSync(archivePath)
        archive = `https://example.test/${commandName}.zip`
      } else {
        payload = Buffer.from('raw-runtime')
        archive = `https://example.test/${commandName}`
      }
      const store = new AgentStore(path.join(root, 'agents.json'))
      const agent: RegistryAgent = {
        id: commandName, name: commandName, version: '1.0.0', description: 'test',
        distribution: { binary: { [getPlatformKey()]: {
          archive, cmd: `./${commandName}`,
          sha256: crypto.createHash('sha256').update(payload).digest('hex'),
        } } },
      }

      const result = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload))

      expect(result.ok).toBe(true)
      const command = path.join(agentsDir, commandName, commandName)
      expect(fs.readFileSync(command, 'utf8')).toBe(
        payloadKind === 'raw' ? 'raw-runtime' : payloadKind === 'zip' ? 'zip-runtime' : 'bzip-runtime',
      )
      if (process.platform !== 'win32') expect(fs.statSync(command).mode & 0o111).not.toBe(0)
      expect(fs.readdirSync(agentsDir).filter((name) => name.startsWith(`.${commandName}-`))).toEqual([])
    }
  })

  it('reports success when post-commit cleanup is blocked and retries only marked cleanup artifacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agent-cleanup-pending-'))
    roots.push(root)
    const agentsDir = path.join(root, 'agents')
    const installedDir = path.join(agentsDir, 'cleanup-agent')
    fs.mkdirSync(installedDir, { recursive: true })
    fs.writeFileSync(path.join(installedDir, 'cleanup-agent'), 'old-runtime', { mode: 0o755 })
    const store = new AgentStore(path.join(root, 'agents.json'))
    store.addAgent('cleanup-agent', {
      registryId: 'cleanup-agent', name: 'Cleanup agent', version: '1.0.0', distribution: 'binary',
      command: path.join(installedDir, 'cleanup-agent'), args: [], env: {},
      installedAt: '2026-07-17T00:00:00.000Z', binaryPath: installedDir,
    })
    const payload = Buffer.from('new-runtime')
    const agent: RegistryAgent = {
      id: 'cleanup-agent', name: 'Cleanup agent', version: '2.0.0', description: 'test',
      distribution: { binary: { [getPlatformKey()]: {
        archive: 'https://example.test/cleanup-agent', cmd: './cleanup-agent',
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      } } },
    }
    const foreignBackup = path.join(
      agentsDir,
      '.cleanup-agent-00000000-0000-4000-8000-000000000000.backup',
    )
    fs.mkdirSync(foreignBackup)
    fs.writeFileSync(path.join(foreignBackup, 'keep'), 'foreign')
    // The parent remains writable so activation can rename this runtime, but
    // recursive deletion of the committed cleanup artifact receives EACCES.
    fs.chmodSync(installedDir, 0o000)

    const first = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload))
    const pendingArtifacts = fs.readdirSync(agentsDir).filter((name) => name.endsWith('.cleanup'))
    for (const name of pendingArtifacts) fs.chmodSync(path.join(agentsDir, name), 0o700)

    expect(first).toMatchObject({
      ok: true,
      cleanupPending: true,
      cleanupMessage: expect.stringContaining('installed'),
    })
    expect(store.getAgent('cleanup-agent')).toMatchObject({ version: '2.0.0' })
    expect(fs.readFileSync(path.join(installedDir, 'cleanup-agent'), 'utf8')).toBe('new-runtime')
    expect(pendingArtifacts).toHaveLength(1)
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith('.committed'))).toHaveLength(1)
    expect(fs.readFileSync(path.join(foreignBackup, 'keep'), 'utf8')).toBe('foreign')

    const second = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload))

    expect(second).toMatchObject({ ok: true })
    expect(second.cleanupPending).toBeUndefined()
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith('.cleanup'))).toEqual([])
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith('.committed'))).toEqual([])
    expect(fs.readFileSync(path.join(foreignBackup, 'keep'), 'utf8')).toBe('foreign')
  })

  it('bounds committed cleanup retries per install', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-agent-cleanup-bounded-'))
    roots.push(root)
    const agentsDir = path.join(root, 'agents')
    fs.mkdirSync(agentsDir)
    for (let index = 0; index < 10; index++) {
      const stem = `.bounded-agent-${crypto.randomUUID()}`
      fs.writeFileSync(path.join(agentsDir, `${stem}.committed`), '')
      fs.mkdirSync(path.join(agentsDir, `${stem}.cleanup`))
      fs.writeFileSync(path.join(agentsDir, `${stem}.cleanup`, 'old-runtime'), String(index))
    }
    const payload = Buffer.from('bounded-runtime')
    const agent: RegistryAgent = {
      id: 'bounded-agent', name: 'Bounded agent', version: '1.0.0', description: 'test',
      distribution: { binary: { [getPlatformKey()]: {
        archive: 'https://example.test/bounded-agent', cmd: './bounded-agent',
        sha256: crypto.createHash('sha256').update(payload).digest('hex'),
      } } },
    }

    const result = await installAgent(
      agent,
      new AgentStore(path.join(root, 'agents.json')),
      undefined,
      agentsDir,
      async () => new Response(payload),
    )

    expect(result.ok).toBe(true)
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith('.committed'))).toHaveLength(2)
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith('.cleanup'))).toHaveLength(2)
  })
})
