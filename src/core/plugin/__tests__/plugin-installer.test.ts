import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import fsSync from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import {
  acquirePluginInstallLock, importFromDir, installNpmPlugin, PluginInstallCrashSimulation,
  PluginInstallError, PluginInstallJournalController, recoverPluginInstallTransaction,
  stageNpmPlugin, validateOpenACPPluginModule,
} from '../plugin-installer.js'

describe('importFromDir', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-installer-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function createFakePackage(
    name: string,
    pkgJson: Record<string, any>,
    entryContent = 'export const loaded = true;\n',
  ) {
    const pkgDir = path.join(tmpDir, 'node_modules', ...name.split('/'))
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson))

    const entry = pkgJson.exports?.['.']?.import
      ?? pkgJson.exports?.['.']
      ?? pkgJson.main
      ?? 'index.js'
    const entryResolved = typeof entry === 'string' ? entry : 'index.js'
    const entryPath = path.join(pkgDir, entryResolved)
    await fs.mkdir(path.dirname(entryPath), { recursive: true })
    await fs.writeFile(entryPath, entryContent)
  }

  it('resolves ESM package via exports["."].import', async () => {
    await createFakePackage('test-esm', {
      name: 'test-esm',
      type: 'module',
      exports: { '.': { import: './dist/index.js' } },
    })

    const mod = await importFromDir('test-esm', tmpDir)
    expect(mod.loaded).toBe(true)
  })

  it('resolves package via exports["."] string shorthand', async () => {
    await createFakePackage('test-shorthand', {
      name: 'test-shorthand',
      exports: { '.': './lib/main.js' },
    })

    const mod = await importFromDir('test-shorthand', tmpDir)
    expect(mod.loaded).toBe(true)
  })

  it('resolves package via main field', async () => {
    await createFakePackage('test-main', {
      name: 'test-main',
      main: './lib/index.js',
    })

    const mod = await importFromDir('test-main', tmpDir)
    expect(mod.loaded).toBe(true)
  })

  it('falls back to index.js when no exports or main', async () => {
    await createFakePackage('test-fallback', {
      name: 'test-fallback',
    })

    const mod = await importFromDir('test-fallback', tmpDir)
    expect(mod.loaded).toBe(true)
  })

  it('resolves scoped packages', async () => {
    await createFakePackage('@openacp/plugin-discord', {
      name: '@openacp/plugin-discord',
      exports: { '.': { import: './dist/index.js' } },
    })

    const mod = await importFromDir('@openacp/plugin-discord', tmpDir)
    expect(mod.loaded).toBe(true)
  })

  it('throws descriptive error when package.json missing', async () => {
    await expect(importFromDir('nonexistent', tmpDir)).rejects.toThrow(
      /Cannot read package\.json for "nonexistent"/,
    )
  })

  it('throws descriptive error when entry point missing', async () => {
    const pkgDir = path.join(tmpDir, 'node_modules', 'bad-entry')
    await fs.mkdir(pkgDir, { recursive: true })
    await fs.writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'bad-entry', main: './missing.js' }),
    )

    await expect(importFromDir('bad-entry', tmpDir)).rejects.toThrow(
      /Entry point "\.\/missing\.js" not found for "bad-entry"/,
    )
  })
})

describe('installNpmPlugin — --ignore-scripts flag', () => {
  it("includes --ignore-scripts flag in npm install command", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("../plugin-installer.ts", import.meta.url).pathname.replace("__tests__/", ""),
      "utf-8",
    );
    // Verify --ignore-scripts is present in execFile/exec npm install calls
    expect(source).toContain("--ignore-scripts");
    // Verify execFile is used instead of exec (no shell injection)
    expect(source).toContain("execFileAsync");
  });
});

describe('installNpmPlugin — package name validation', () => {
  // Shell injection attempts must be rejected before any exec
  const maliciousNames = [
    'foo; rm -rf /',
    '$(whoami)',
    'foo`id`bar',
    'foo && bar',
    'foo | bar',
    'foo > /tmp/out',
    '../../../etc/passwd',
    'foo\nbar',
  ]

  for (const name of maliciousNames) {
    it(`rejects shell metacharacter input: ${JSON.stringify(name)}`, async () => {
      await expect(installNpmPlugin(name, '/tmp/nonexistent-plugins-dir')).rejects.toThrow(
        'Invalid package name',
      )
    })
  }

  // Valid names should NOT throw "Invalid package name" — they may fail further down the stack
  // (e.g., npm install) but validation itself must pass.
  const validNames = [
    'my-openacp-plugin',
    'my.plugin',
    '@scope/my-plugin',
    '@openacp/telegram',
    'my-plugin@4.17.21',
    '@scope/pkg@^1.0.0',
    'MY-PLUGIN',
  ]

  for (const name of validNames) {
    it(`accepts valid npm package name: ${JSON.stringify(name)}`, async () => {
      // These will throw because the plugins dir doesn't exist or npm install fails,
      // but the error must NOT be "Invalid package name"
      const result = await installNpmPlugin(name, '/tmp/nonexistent-plugins-dir').catch((e: Error) => e)
      if (result instanceof Error) {
        expect(result.message).not.toContain('Invalid package name')
      }
      // If it resolved (unlikely in test env), validation definitely passed
    })
  }
})

describe('staged npm plugin activation', () => {
  let pluginsDir: string
  beforeEach(async () => {
    pluginsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-stage-test-'))
  })
  afterEach(async () => { await fs.rm(pluginsDir, { recursive: true, force: true }) })

  async function fakeNpm(stageDir: string, _spec: string, installBody = ''): Promise<void> {
    await fs.writeFile(path.join(stageDir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'safe-plugin': '1.0.0' } }))
    const packageDir = path.join(stageDir, 'node_modules', 'safe-plugin')
    await fs.mkdir(packageDir, { recursive: true })
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'safe-plugin', version: '1.0.0', type: 'module', main: 'index.js' }))
    await fs.writeFile(path.join(packageDir, 'index.js'), `export default { name: 'safe-plugin', version: '1.0.0', setup: async () => {}, install: async () => { ${installBody} } }`)
  }

  it('rolls an activated tree back to the exact previous package state', async () => {
    await fs.writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true, dependencies: { old: '1.0.0' } }))
    await fs.mkdir(path.join(pluginsDir, 'node_modules', 'old'), { recursive: true })
    await fs.writeFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'previous')
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm })
    const activation = await staged.activate()
    expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'safe-plugin', 'package.json'), 'utf8')).toContain('safe-plugin')
    await activation.rollback()
    expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
    expect(await fs.readFile(path.join(pluginsDir, 'package.json'), 'utf8')).toContain('"old"')
    await expect(fs.access(path.join(pluginsDir, 'node_modules', 'safe-plugin'))).rejects.toThrow()
  })

  it('leaves live packages untouched when validation fails', async () => {
    await fs.writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true }))
    await fs.mkdir(path.join(pluginsDir, 'node_modules', 'old'), { recursive: true })
    await fs.writeFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'previous')
    await expect(stageNpmPlugin('safe-plugin', pluginsDir, undefined, {
      runNpm: async (stageDir) => fakeNpm(stageDir, 'safe-plugin', '').then(async () => {
        await fs.writeFile(path.join(stageDir, 'node_modules', 'safe-plugin', 'index.js'), 'export default { name: "safe-plugin", version: "1.0.0", setup: async () => {} }')
      }),
    })).rejects.toMatchObject({ code: 'PLUGIN_CONTRACT_INVALID' })
    expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
  })

  it('can discard a staged tree after an explicit install hook failure without activation', async () => {
    await fs.writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true }))
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, {
      runNpm: (stageDir, spec) => fakeNpm(stageDir, spec, 'throw new Error("hook failed")'),
    })
    await expect(staged.plugin.install({} as any)).rejects.toThrow('hook failed')
    await staged.discard()
    await expect(fs.access(path.join(pluginsDir, 'node_modules', 'safe-plugin'))).rejects.toThrow()
  })

  it('requires a strict default OpenACPPlugin contract with an install hook', () => {
    expect(() => validateOpenACPPluginModule(
      { default: { name: 'safe-plugin', version: '1.0.0', setup: async () => {} } },
      { name: 'safe-plugin', version: '1.0.0' }, 'safe-plugin',
    )).toThrow(PluginInstallError)
  })
})

describe('durable plugin install transactions', () => {
  let instanceRoot: string
  let pluginsDir: string

  beforeEach(async () => {
    instanceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-transaction-test-'))
    pluginsDir = path.join(instanceRoot, 'plugins')
    await fs.mkdir(pluginsDir, { recursive: true })
  })
  afterEach(async () => { await fs.rm(instanceRoot, { recursive: true, force: true }) })

  async function fakeNpm(stageDir: string): Promise<void> {
    await fs.writeFile(path.join(stageDir, 'package.json'), JSON.stringify({ private: true, dependencies: { 'safe-plugin': '2.0.0' } }))
    await fs.writeFile(path.join(stageDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, new: true }))
    const packageDir = path.join(stageDir, 'node_modules', 'safe-plugin')
    await fs.mkdir(packageDir, { recursive: true })
    await fs.writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'safe-plugin', version: '2.0.0', type: 'module', main: 'index.js' }))
    await fs.writeFile(path.join(packageDir, 'index.js'), 'export default { name: "safe-plugin", version: "2.0.0", setup: async () => {}, install: async () => {} }')
  }

  async function seedOldState(): Promise<{ dataDir: string; registryPath: string; registryBefore: Buffer }> {
    await fs.writeFile(path.join(pluginsDir, 'package.json'), JSON.stringify({ private: true, dependencies: { old: '1.0.0' } }))
    await fs.writeFile(path.join(pluginsDir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, old: true }))
    await fs.mkdir(path.join(pluginsDir, 'node_modules', 'old'), { recursive: true })
    await fs.writeFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'previous')
    const dataDir = path.join(pluginsDir, 'data', 'safe-plugin')
    await fs.mkdir(path.join(dataDir, 'nested'), { recursive: true })
    await fs.writeFile(path.join(dataDir, 'settings.json'), '{"secret":"old"}\n')
    await fs.writeFile(path.join(dataDir, 'nested', 'state'), 'stable')
    const registryPath = path.join(instanceRoot, 'plugins.json')
    const registryBefore = Buffer.from('{\n  "installed": {"safe-plugin":{"version":"1.0.0"}}\n}\n')
    await fs.writeFile(registryPath, registryBefore, { mode: 0o600 })
    return { dataDir, registryPath, registryBefore }
  }

  it('serializes installers across processes and only reclaims a proven stale owner', async () => {
    const first = await acquirePluginInstallLock(instanceRoot, { timeoutMs: 20 })
    expect(fsSync.statSync(path.join(instanceRoot, 'plugin-install.lock')).mode & 0o777).toBe(0o600)
    await expect(acquirePluginInstallLock(instanceRoot, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_BUSY' })
    first.release()

    const deadId = '11111111-1111-4111-8111-111111111111'
    fsSync.writeFileSync(path.join(instanceRoot, 'plugin-install.lock'), JSON.stringify({ version: 1, transactionId: deadId, pid: 99_999_999, createdAt: 1 }), { mode: 0o600 })
    const reclaimed = await acquirePluginInstallLock(instanceRoot, { timeoutMs: 30, staleMs: 1 })
    reclaimed.release()

    fsSync.writeFileSync(path.join(instanceRoot, `plugin-install.lock.reclaim-${deadId}`), JSON.stringify({ version: 1, transactionId: deadId, pid: 99_999_999, createdAt: 1 }), { mode: 0o600 })
    const orphanRecovered = await acquirePluginInstallLock(instanceRoot, { timeoutMs: 30, staleMs: 1 })
    orphanRecovered.release()

    fsSync.writeFileSync(path.join(instanceRoot, 'plugin-install.lock'), 'malformed', { mode: 0o600 })
    await expect(acquirePluginInstallLock(instanceRoot, { timeoutMs: 30, staleMs: 1 })).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_BUSY' })
  })

  it('does not mark or consume a partial data snapshot when copying fails', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const before = fsSync.readFileSync(path.join(dataDir, 'settings.json'))
    const nestedBefore = fsSync.readFileSync(path.join(dataDir, 'nested', 'state'))
    const lock = await acquirePluginInstallLock(instanceRoot)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      copyTree: (source, destination) => {
        fsSync.mkdirSync(destination, { recursive: true })
        fsSync.copyFileSync(path.join(source, 'settings.json'), path.join(destination, 'settings.json'))
        const error = new Error('disk full') as NodeJS.ErrnoException; error.code = 'ENOSPC'; throw error
      },
    })
    await controller.prepare('safe-plugin', staged, dataDir, registryPath)

    expect(() => controller.snapshotData(dataDir)).toThrow(PluginInstallError)
    expect(fsSync.readFileSync(path.join(dataDir, 'settings.json'))).toEqual(before)
    expect(fsSync.readFileSync(path.join(dataDir, 'nested', 'state'))).toEqual(nestedBefore)
    expect(fsSync.existsSync(path.join(pluginsDir, `.data-snapshot-${lock.transactionId}.complete`))).toBe(false)
    controller.rollback(); controller.release()
  })

  it('fails before journaling when atomic rename boundaries are on different filesystems', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      deviceForPath: (target) => target === staged.stageDir ? 2 : 1,
    })
    await expect(controller.prepare('safe-plugin', staged, dataDir, registryPath)).rejects.toMatchObject({ code: 'PLUGIN_STAGE_FAILED' })
    expect(fsSync.existsSync(path.join(instanceRoot, 'plugin-install.journal.json'))).toBe(false)
    await staged.discard(); controller.release()
  })

  const crashPhases = [
    'snapshot-pending', 'hook-pending', 'hook-running', 'hook-complete',
    'backup:node_modules', 'activate:node_modules', 'backup:package.json', 'activate:package.json',
    'backup:package-lock.json', 'activate:package-lock.json', 'packages-activated',
    'registry-committing', 'registry-committed', 'committed',
  ]

  for (const crashPhase of crashPhases) {
    it(`recovers idempotently after SIGKILL boundary ${crashPhase}`, async () => {
      const { dataDir, registryPath, registryBefore } = await seedOldState()
      const lock = await acquirePluginInstallLock(instanceRoot)
      const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
      const unrelated = path.join(pluginsDir, '.stage-unrelated-owner')
      await fs.mkdir(unrelated); await fs.writeFile(path.join(unrelated, 'keep'), 'unrelated')
      const controller = new PluginInstallJournalController(instanceRoot, lock, {
        crashAt: (phase) => { if (phase === crashPhase) throw new PluginInstallCrashSimulation(phase) },
      })
      let crashed: unknown
      try {
        const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
        controller.snapshotData(dataDir)
        controller.transition('hook-running')
        await fs.writeFile(path.join(dataDir, 'settings.json'), '{"secret":"new"}\n')
        controller.transition('hook-complete')
        const activation = await staged.activate(hooks)
        controller.transition('registry-committing')
        const committedRegistry = Buffer.from('{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
        await fs.writeFile(registryPath, committedRegistry)
        controller.markRegistryCommitted(committedRegistry, 0o600)
        await activation.commit()
        controller.commit()
      } catch (error) { crashed = error }
      expect(crashed).toBeInstanceOf(PluginInstallCrashSimulation)
      lock.release()

      await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
      await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
      const committed = crashPhase === 'registry-committed' || crashPhase === 'committed'
      if (committed) {
        expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'safe-plugin', 'package.json'), 'utf8')).toContain('2.0.0')
        expect(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).toContain('new')
        expect(await fs.readFile(registryPath, 'utf8')).toContain('2.0.0')
      } else {
        expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
        expect(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).toContain('old')
        expect(await fs.readFile(registryPath)).toEqual(registryBefore)
      }
      expect(await fs.readFile(path.join(unrelated, 'keep'), 'utf8')).toBe('unrelated')
      expect(fsSync.existsSync(path.join(instanceRoot, 'plugin-install.journal.json'))).toBe(false)
    })
  }

  for (const code of ['EXDEV', 'EACCES'] as const) {
    for (let failureBoundary = 1; failureBoundary <= 6; failureBoundary++) {
      it(`preserves the previous tree when rename ${failureBoundary} fails with ${code}`, async () => {
        const { dataDir, registryPath, registryBefore } = await seedOldState()
        const lock = await acquirePluginInstallLock(instanceRoot)
        const controller = new PluginInstallJournalController(instanceRoot, lock)
        controller.initialize('safe-plugin', dataDir, registryPath)
        let renameCount = 0
        const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, {
          runNpm: fakeNpm, transactionId: lock.transactionId,
          renamePath: (source, destination) => {
            renameCount++
            if (renameCount === failureBoundary) {
              const error = new Error(code) as NodeJS.ErrnoException; error.code = code; throw error
            }
            fsSync.renameSync(source, destination)
          },
        })
        const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
        controller.snapshotData(dataDir)
        controller.transition('hook-running'); controller.transition('hook-complete')
        await expect(staged.activate(hooks)).rejects.toMatchObject({ code })
        controller.rollback(); controller.release()

        expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
        expect(await fs.readFile(path.join(pluginsDir, 'package.json'), 'utf8')).toContain('"old"')
        expect(await fs.readFile(path.join(pluginsDir, 'package-lock.json'), 'utf8')).toContain('"old":true')
        expect(await fs.readFile(registryPath)).toEqual(registryBefore)
      })
    }
  }

  const corruptions: Array<[string, (journal: any) => void]> = [
    ['path traversal', (journal) => { journal.data.directory = path.join(pluginsDir, 'data', '..', 'node_modules') }],
    ['missing registry content', (journal) => { journal.registry.existed = true; delete journal.registry.contentBase64 }],
    ['duplicate items', (journal) => { journal.items[2] = { ...journal.items[1] } }],
    ['invalid phase', (journal) => { journal.phase = 'activate:../../outside' }],
    ['initialized with activated item', (journal) => { journal.items[0].state = 'new-activated' }],
    ['backup phase with activated current item', (journal) => { journal.phase = 'backup:node_modules'; journal.items[0].state = 'new-activated'; journal.data = { ...journal.data, existed: false, hookStarted: true } }],
    ['activate phase without required backup', (journal) => { journal.phase = 'activate:node_modules'; journal.data = { ...journal.data, existed: false, hookStarted: true } }],
    ['registry committed before all activation', (journal) => { journal.phase = 'registry-committed'; journal.data = { ...journal.data, existed: false, hookStarted: true } }],
    ['hook pending without snapshot result', (journal) => { journal.phase = 'hook-pending' }],
    ['initialized with data cleanup authority', (journal) => { journal.data.existed = false }],
    ['hook running without hook-start marker', (journal) => { journal.phase = 'hook-running'; journal.data.existed = false }],
    ['hook pending marked as started', (journal) => { journal.phase = 'hook-pending'; journal.data.existed = false; journal.data.hookStarted = true }],
  ]
  for (const [label, corrupt] of corruptions) {
    it(`fails closed without mutation for corrupt journal: ${label}`, async () => {
      const { dataDir, registryPath, registryBefore } = await seedOldState()
      const lock = await acquirePluginInstallLock(instanceRoot)
      const controller = new PluginInstallJournalController(instanceRoot, lock)
      controller.initialize('safe-plugin', dataDir, registryPath)
      controller.release()
      const journalPath = path.join(instanceRoot, 'plugin-install.journal.json')
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      corrupt(journal)
      await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })

      await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
      expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
      expect(await fs.readFile(registryPath)).toEqual(registryBefore)
      expect(fsSync.existsSync(journalPath)).toBe(true)
    })
  }

  it('rejects symlinked instance and data roots without following them', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const linkedRoot = `${instanceRoot}-link`
    await fs.symlink(instanceRoot, linkedRoot)
    try {
      await expect(recoverPluginInstallTransaction(linkedRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
      const lock = await acquirePluginInstallLock(instanceRoot)
      const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
      const controller = new PluginInstallJournalController(instanceRoot, lock)
      await controller.prepare('safe-plugin', staged, dataDir, registryPath)
      const realData = `${dataDir}-real`
      await fs.rename(dataDir, realData); await fs.symlink(realData, dataDir)
      expect(() => controller.snapshotData(dataDir)).toThrow(PluginInstallError)
      await fs.rm(dataDir); await fs.rename(realData, dataDir)
      controller.rollback(); controller.release()
    } finally { await fs.rm(linkedRoot, { force: true }) }
  })

  it('rejects symlinked plugins and data ancestors', async () => {
    const { registryPath } = await seedOldState()
    const realPlugins = `${pluginsDir}-real`
    await fs.rename(pluginsDir, realPlugins); await fs.symlink(realPlugins, pluginsDir)
    await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
    await fs.rm(pluginsDir); await fs.rename(realPlugins, pluginsDir)

    const dataRoot = path.join(pluginsDir, 'data')
    const realData = `${dataRoot}-real`
    await fs.rename(dataRoot, realData); await fs.symlink(realData, dataRoot)
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock)
    expect(() => controller.initialize('safe-plugin', path.join(dataRoot, 'safe-plugin'), registryPath)).toThrow(PluginInstallError)
    controller.release()
    await fs.rm(dataRoot); await fs.rename(realData, dataRoot)
  })

  it('rejects a symlink substituted for a completed snapshot', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock)
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    const snapshotState = controller.snapshotData(dataDir)
    const snapshot = snapshotState.snapshotDir!
    const realSnapshot = `${snapshot}.real`
    await fs.rename(snapshot, realSnapshot); await fs.symlink(realSnapshot, snapshot)
    controller.release()
    await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
    expect(fsSync.existsSync(path.join(instanceRoot, 'plugin-install.journal.json'))).toBe(true)
  })

  it('rolls back when the registry-committed marker cannot be persisted', async () => {
    const { dataDir, registryPath, registryBefore } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      failPersistAt: (phase) => { if (phase === 'registry-committed') throw new Error('fsync failed') },
    })
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running'); controller.transition('hook-complete')
    await staged.activate(hooks)
    controller.transition('registry-committing')
    const committedRegistry = Buffer.from('{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
    await fs.writeFile(registryPath, committedRegistry)
    expect(() => controller.markRegistryCommitted(committedRegistry, 0o600)).toThrow('fsync failed')
    controller.rollback(); controller.release()
    expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
    expect(await fs.readFile(registryPath)).toEqual(registryBefore)
  })

  it('keeps committed state and retries cleanup after marker persistence', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    let failedCleanup = false
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      removePath: (target) => {
        if (!failedCleanup && path.basename(target).startsWith('.rollback-')) { failedCleanup = true; throw new Error('cleanup denied') }
        fsSync.rmSync(target, { recursive: true, force: true })
      },
    })
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running'); controller.transition('hook-complete')
    await staged.activate(hooks)
    controller.transition('registry-committing')
    const committedRegistry = Buffer.from('{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
    await fs.writeFile(registryPath, committedRegistry)
    controller.markRegistryCommitted(committedRegistry, 0o600)
    expect(controller.commit()).toBe(false)
    controller.release()

    await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
    expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'safe-plugin', 'package.json'), 'utf8')).toContain('2.0.0')
    expect(await fs.readFile(registryPath, 'utf8')).toContain('2.0.0')
    expect(fsSync.existsSync(path.join(instanceRoot, 'plugin-install.journal.json'))).toBe(false)
  })

  for (const forgedPhase of ['registry-committed', 'committed'] as const) {
    it(`rejects packages-activated journal forged to ${forgedPhase} without commit evidence`, async () => {
      const { dataDir, registryPath } = await seedOldState()
      const lock = await acquirePluginInstallLock(instanceRoot)
      const controller = new PluginInstallJournalController(instanceRoot, lock)
      controller.initialize('safe-plugin', dataDir, registryPath)
      const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
      const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
      controller.snapshotData(dataDir); controller.transition('hook-running'); controller.transition('hook-complete')
      await staged.activate(hooks); controller.release()
      const journalPath = path.join(instanceRoot, 'plugin-install.journal.json')
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      journal.phase = forgedPhase
      await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })

      await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
      expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'safe-plugin', 'package.json'), 'utf8')).toContain('2.0.0')
      expect(fsSync.existsSync(path.join(pluginsDir, `.rollback-${lock.transactionId}`))).toBe(true)
      expect(fsSync.existsSync(journalPath)).toBe(true)
    })
  }

  it('rejects commit evidence attached to a precommit registry-committing phase', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock)
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running'); controller.transition('hook-complete')
    await staged.activate(hooks); controller.transition('registry-committing')
    const committedRegistry = Buffer.from('{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
    await fs.writeFile(registryPath, committedRegistry); controller.release()
    const journalPath = path.join(instanceRoot, 'plugin-install.journal.json')
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
    journal.registry.commitEvidence = {
      contentBase64: committedRegistry.toString('base64'),
      digest: createHash('sha256').update(committedRegistry).digest('hex'), mode: 0o600,
    }
    await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })
    await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
    expect(await fs.readFile(registryPath)).toEqual(committedRegistry)
    expect(fsSync.existsSync(path.join(pluginsDir, `.rollback-${lock.transactionId}`))).toBe(true)
  })

  it('quarantines committed cleanup when persisted registry no longer matches evidence', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      crashAt: (phase) => { if (phase === 'registry-committed') throw new PluginInstallCrashSimulation(phase) },
    })
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running'); controller.transition('hook-complete')
    await staged.activate(hooks); controller.transition('registry-committing')
    const committedRegistry = Buffer.from('{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
    await fs.writeFile(registryPath, committedRegistry)
    expect(() => controller.markRegistryCommitted(committedRegistry, 0o600)).toThrow(PluginInstallCrashSimulation)
    controller.release()
    await fs.writeFile(registryPath, '{"corrupt":true}\n')
    await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
    expect(fsSync.existsSync(path.join(pluginsDir, `.rollback-${lock.transactionId}`))).toBe(true)
    expect(fsSync.existsSync(path.join(instanceRoot, 'plugin-install.journal.json'))).toBe(true)
  })

  it('rolls back after a crash between registry save and atomic evidence marker', async () => {
    const { dataDir, registryPath, registryBefore } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      failPersistAt: (phase) => { if (phase === 'registry-committed') throw new PluginInstallCrashSimulation('evidence-marker') },
    })
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running'); controller.transition('hook-complete')
    await staged.activate(hooks); controller.transition('registry-committing')
    const committedRegistry = Buffer.from('{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
    await fs.writeFile(registryPath, committedRegistry)
    expect(() => controller.markRegistryCommitted(committedRegistry, 0o600)).toThrow(PluginInstallCrashSimulation)
    controller.release()
    await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
    expect(await fs.readFile(registryPath)).toEqual(registryBefore)
    expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
  })

  it('recovers after intent, stage mkdir, and complete snapshot crashes', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock, {
      crashAfterSnapshotRename: () => { throw new PluginInstallCrashSimulation('snapshot-renamed') },
    })
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    expect(() => controller.snapshotData(dataDir)).toThrow(PluginInstallCrashSimulation)
    const snapshot = path.join(pluginsDir, `.data-snapshot-${lock.transactionId}.complete`)
    expect(fsSync.statSync(snapshot).mode & 0o777).toBe(0o700)
    expect(fsSync.statSync(path.join(snapshot, 'settings.json')).mode & 0o777).toBe(0o600)
    controller.release()
    await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
    expect(fsSync.existsSync(snapshot)).toBe(false)
    expect(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).toContain('old')
  })

  for (const [sourcePhase, invalidPhase] of [['packages-activated', 'rolled-back'], ['registry-committing', 'unknown-future-phase']] as const) {
    it(`does not trust a genuine ${sourcePhase} journal mutated to ${invalidPhase}`, async () => {
      const { dataDir, registryPath } = await seedOldState()
      const lock = await acquirePluginInstallLock(instanceRoot)
      const controller = new PluginInstallJournalController(instanceRoot, lock)
      controller.initialize('safe-plugin', dataDir, registryPath)
      const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
      const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
      controller.snapshotData(dataDir); controller.transition('hook-running')
      await fs.writeFile(path.join(dataDir, 'settings.json'), '{"secret":"new"}\n')
      controller.transition('hook-complete'); await staged.activate(hooks)
      if (sourcePhase === 'registry-committing') {
        controller.transition('registry-committing')
        await fs.writeFile(registryPath, '{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
      }
      controller.release()
      const journalPath = path.join(instanceRoot, 'plugin-install.journal.json')
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'))
      journal.phase = invalidPhase
      await fs.writeFile(journalPath, JSON.stringify(journal), { mode: 0o600 })

      await expect(recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })).rejects.toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
      expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'safe-plugin', 'package.json'), 'utf8')).toContain('2.0.0')
      if (sourcePhase === 'registry-committing') expect(await fs.readFile(registryPath, 'utf8')).toContain('2.0.0')
      else expect(await fs.readFile(registryPath, 'utf8')).toContain('1.0.0')
      expect(fsSync.existsSync(path.join(pluginsDir, `.rollback-${lock.transactionId}`))).toBe(true)
      expect(fsSync.existsSync(journalPath)).toBe(true)
    })
  }

  const rollbackBoundaries = [
    ...['node_modules', 'package.json', 'package-lock.json'].flatMap((name) => [
      `package:${name}:prepared`, `package:${name}:live-removed`, `package:${name}:restored`, `package:${name}:verified`,
    ]),
    'data:prepared', 'data:live-removed', 'data:restored', 'data:verified',
    'registry:restored', 'all:verified',
  ]
  for (const rollbackBoundary of rollbackBoundaries) {
    it(`repeats rollback safely after power loss at ${rollbackBoundary}`, async () => {
      const { dataDir, registryPath, registryBefore } = await seedOldState()
      const lock = await acquirePluginInstallLock(instanceRoot)
      let crashed = false
      const controller = new PluginInstallJournalController(instanceRoot, lock, {
        rollbackBoundary: (boundary) => {
          if (!crashed && boundary === rollbackBoundary) { crashed = true; throw new PluginInstallCrashSimulation(`rollback:${boundary}`) }
        },
      })
      controller.initialize('safe-plugin', dataDir, registryPath)
      const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
      const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
      controller.snapshotData(dataDir); controller.transition('hook-running')
      await fs.writeFile(path.join(dataDir, 'settings.json'), '{"secret":"new"}\n')
      controller.transition('hook-complete'); await staged.activate(hooks)
      controller.transition('registry-committing')
      await fs.writeFile(registryPath, '{"installed":{"safe-plugin":{"version":"2.0.0"}}}\n')
      expect(() => controller.rollback()).toThrow(PluginInstallCrashSimulation)
      controller.release()

      await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
      await recoverPluginInstallTransaction(instanceRoot, { timeoutMs: 100 })
      expect(await fs.readFile(path.join(pluginsDir, 'node_modules', 'old', 'marker'), 'utf8')).toBe('previous')
      expect(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8')).toContain('old')
      expect(await fs.readFile(registryPath)).toEqual(registryBefore)
      expect(fsSync.existsSync(path.join(instanceRoot, 'plugin-install.journal.json'))).toBe(false)
    })
  }

  it('fsyncs restored package, data, registry, and parent boundaries before cleanup', async () => {
    const { dataDir, registryPath } = await seedOldState()
    await fs.chmod(dataDir, 0o700)
    await fs.chmod(path.join(dataDir, 'settings.json'), 0o600)
    await fs.chmod(path.join(dataDir, 'nested'), 0o710)
    await fs.chmod(path.join(dataDir, 'nested', 'state'), 0o640)
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock)
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    const hooks = await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running')
    await fs.writeFile(path.join(dataDir, 'settings.json'), '{"secret":"new"}\n')
    await fs.chmod(dataDir, 0o755)
    await fs.chmod(path.join(dataDir, 'settings.json'), 0o644)
    await fs.chmod(path.join(dataDir, 'nested'), 0o755)
    await fs.chmod(path.join(dataDir, 'nested', 'state'), 0o644)
    controller.transition('hook-complete'); await staged.activate(hooks)
    controller.transition('registry-committing')
    await fs.writeFile(registryPath, '{"installed":{}}\n')
    const fsync = vi.spyOn(fsSync, 'fsyncSync')
    controller.rollback(); controller.release()
    expect(fsync.mock.calls.length).toBeGreaterThan(6)
    expect(fsSync.statSync(dataDir).mode & 0o777).toBe(0o700)
    expect(fsSync.statSync(path.join(dataDir, 'settings.json')).mode & 0o777).toBe(0o600)
    expect(fsSync.statSync(path.join(dataDir, 'nested')).mode & 0o777).toBe(0o700)
    expect(fsSync.statSync(path.join(dataDir, 'nested', 'state')).mode & 0o777).toBe(0o600)
  })

  it('reports a safe relative record when prepared rollback mode verification fails', async () => {
    const { dataDir, registryPath } = await seedOldState()
    const lock = await acquirePluginInstallLock(instanceRoot)
    const controller = new PluginInstallJournalController(instanceRoot, lock)
    controller.initialize('safe-plugin', dataDir, registryPath)
    const staged = await stageNpmPlugin('safe-plugin', pluginsDir, undefined, { runNpm: fakeNpm, transactionId: lock.transactionId })
    await controller.prepare('safe-plugin', staged, dataDir, registryPath)
    controller.snapshotData(dataDir); controller.transition('hook-running')
    await fs.writeFile(path.join(dataDir, 'settings.json'), '{"secret":"new"}\n')

    const chmodSync = fsSync.chmodSync.bind(fsSync)
    const chmod = vi.spyOn(fsSync, 'chmodSync').mockImplementation((target, mode) => {
      chmodSync(target, mode)
      if (String(target).includes('.data-restore-') && String(target).endsWith(`${path.sep}nested`)) chmodSync(target, 0o755)
    })
    let failure: unknown
    try { controller.rollback() } catch (error) { failure = error }
    finally { chmod.mockRestore(); controller.release() }

    expect(failure).toMatchObject({ code: 'PLUGIN_RECOVERY_FAILED' })
    const message = (failure as Error).message
    expect(message).toContain('relative record "nested" mode expected 700, actual 755')
    expect(message).not.toContain(instanceRoot)
  })
})
