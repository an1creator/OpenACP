import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { captureJsonOutput, expectValidJsonSuccess, expectValidJsonError } from './helpers/json-test-utils.js'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    execFile: vi.fn((_cmd: unknown, rawArgs: unknown, _opts: unknown, cb: (err: null, stdout: string, stderr: string) => void) => {
      const args = rawArgs as string[]
      const prefix = args[args.indexOf('--prefix') + 1]
      const spec = args[1]
      const scopedVersionAt = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : -1
      const packageName = spec.startsWith('@')
        ? scopedVersionAt === -1 ? spec : spec.slice(0, scopedVersionAt)
        : spec.split('@')[0]
      const packageDir = path.join(prefix, 'node_modules', ...packageName.split('/'))
      fs.mkdirSync(packageDir, { recursive: true })
      fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ private: true, dependencies: { [packageName]: '1.0.0' } }))
      fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', type: 'module', main: 'index.js' }))
      fs.writeFileSync(path.join(packageDir, 'index.js'), `export default { name: ${JSON.stringify(packageName)}, version: '1.0.0', setup: async () => {}, install: async () => {} }`)
      cb(null, '', '')
      return {} as any
    }),
  }
})

// Mock the logger to prevent pino initialization errors in test environment
const noopLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  trace: vi.fn(), fatal: vi.fn(), child: () => noopLogger,
}
vi.mock('../../../core/utils/log.js', () => ({
  muteLogger: vi.fn(),
  unmuteLogger: vi.fn(),
  initLogger: vi.fn(),
  setLogLevel: vi.fn(),
  createChildLogger: vi.fn(() => noopLogger),
  createSessionLogger: vi.fn(() => noopLogger),
  closeSessionLogger: vi.fn(),
  shutdownLogger: vi.fn(),
  cleanupOldSessionLogs: vi.fn(),
  log: noopLogger,
}))

describe('install --json', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-install-test-'))
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('outputs JSON on successful install', async () => {
    const { cmdInstall } = await import('../install.js')
    const result = await captureJsonOutput(async () => {
      await cmdInstall(['@test/plugin', '--json'], tmpDir)
    })
    expect(result.exitCode, result.stdout).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('plugin', '@test/plugin')
    expect(data).toHaveProperty('installed', true)
  })

  it('outputs JSON error when package name missing', async () => {
    const { cmdInstall } = await import('../install.js')
    const result = await captureJsonOutput(async () => {
      await cmdInstall(['--json'], tmpDir)
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'MISSING_ARGUMENT')
  })
})

describe('uninstall --json', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-uninstall-test-'))
    vi.resetModules()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('outputs JSON on successful uninstall', async () => {
    const { cmdUninstall } = await import('../uninstall.js')
    const result = await captureJsonOutput(async () => {
      await cmdUninstall(['@test/plugin', '--json'], tmpDir)
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('plugin', '@test/plugin')
    expect(data).toHaveProperty('uninstalled', true)
  })

  it('outputs JSON error when package name missing', async () => {
    const { cmdUninstall } = await import('../uninstall.js')
    const result = await captureJsonOutput(async () => {
      await cmdUninstall(['--json'], tmpDir)
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'MISSING_ARGUMENT')
  })
})
