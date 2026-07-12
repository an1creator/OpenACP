import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { captureJsonOutput, expectValidJsonSuccess, expectValidJsonError } from './helpers/json-test-utils.js'

vi.mock('../../daemon.js', () => ({
  startDaemon: vi.fn().mockReturnValue({ pid: 12345 }),
  stopDaemon: vi.fn().mockResolvedValue({ stopped: true, pid: 12345 }),
  getPidPath: vi.fn().mockReturnValue('/tmp/test.pid'),
  isProcessRunning: vi.fn().mockReturnValue(false),
  markRunning: vi.fn(),
  readPidFile: vi.fn().mockReturnValue(12345),
  clearRunning: vi.fn(),
}))

vi.mock('../../../core/config/config.js', () => ({
  ConfigManager: class {
    exists = vi.fn().mockResolvedValue(true)
    load = vi.fn().mockResolvedValue(undefined)
    get = vi.fn().mockReturnValue({ logging: { logDir: '/tmp/logs' }, runMode: 'daemon', api: { port: 21420 } })
  },
}))

vi.mock('../../version.js', () => ({
  checkAndPromptUpdate: vi.fn().mockResolvedValue(undefined),
  getCurrentVersion: vi.fn().mockReturnValue('2026.401.1'),
}))

vi.mock('../../instance-hint.js', () => ({
  printInstanceHint: vi.fn(),
}))

vi.mock('../../api-client.js', () => ({
  waitForPortFile: vi.fn().mockResolvedValue(21420),
  waitForApiReady: vi.fn().mockResolvedValue(21420),
  readApiPort: vi.fn().mockReturnValue(null),
  readApiSecret: vi.fn().mockReturnValue(null),
  removeStalePortFile: vi.fn(),
  apiCall: vi.fn(),
}))

vi.mock('../../autostart.js', () => ({
  installAutoStart: vi.fn().mockReturnValue({ success: true }),
  uninstallAutoStart: vi.fn().mockReturnValue({ success: true }),
  isAutoStartInstalled: vi.fn().mockReturnValue(false),
  isAutoStartSupported: vi.fn().mockReturnValue(false),
  getAutoStartState: vi.fn().mockReturnValue({ installed: true, manager: 'systemd', active: true, pid: 12345 }),
  controlAutoStart: vi.fn().mockReturnValue({ success: true }),
}))

describe('stop --json', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('outputs JSON on successful stop', async () => {
    const { cmdStop } = await import('../stop.js')
    const result = await captureJsonOutput(async () => {
      await cmdStop(['--json'], '/tmp/test-instance')
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('stopped', true)
    expect(data).toHaveProperty('pid', 12345)
    const autostart = await import('../../autostart.js')
    expect(autostart.uninstallAutoStart).not.toHaveBeenCalled()
  })
})

describe('start --json', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    const autostart = await import('../../autostart.js')
    vi.mocked(autostart.getAutoStartState).mockReturnValue({ installed: true, manager: 'systemd', active: true, pid: 12345 })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('outputs JSON on successful start', async () => {
    const { cmdStart } = await import('../start.js')
    const result = await captureJsonOutput(async () => {
      await cmdStart(['--json'], '/tmp/test-instance')
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('pid', 12345)
    const daemon = await import('../../daemon.js')
    expect(daemon.startDaemon).not.toHaveBeenCalled()
    const autostart = await import('../../autostart.js')
    expect(vi.mocked(daemon.markRunning).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(autostart.installAutoStart).mock.invocationCallOrder[0],
    )
    expect(vi.mocked(daemon.markRunning).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(autostart.controlAutoStart).mock.invocationCallOrder[0],
    )
  })

  it('restores runtime intent in the exact managed stop then start sequence', async () => {
    const { cmdStop } = await import('../stop.js')
    const { cmdStart } = await import('../start.js')
    const stopResult = await captureJsonOutput(() => cmdStop(['--json'], '/tmp/test-instance'))
    expect(stopResult.exitCode).toBe(0)
    const startResult = await captureJsonOutput(() => cmdStart(['--json'], '/tmp/test-instance'))
    expect(startResult.exitCode).toBe(0)
    expectValidJsonSuccess(startResult.stdout)
    const daemon = await import('../../daemon.js')
    expect(daemon.clearRunning).toHaveBeenCalledWith('/tmp/test-instance')
    expect(daemon.markRunning).toHaveBeenCalledWith('/tmp/test-instance')
    expect(vi.mocked(daemon.clearRunning).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(daemon.markRunning).mock.invocationCallOrder[0],
    )
  })

  it('returns failure when systemd reports success but the child exits', async () => {
    const autostart = await import('../../autostart.js')
    vi.mocked(autostart.getAutoStartState).mockReturnValue({ installed: true, manager: 'systemd', active: false })
    const { cmdStart } = await import('../start.js')
    const result = await captureJsonOutput(() => cmdStart(['--json'], '/tmp/test-instance'))
    expect(result.exitCode).toBe(1)
    const error = expectValidJsonError(result.stdout)
    expect(error.message).toContain('managed service became inactive during startup')
  })

  it('refuses a detached competitor when managed installation failed partially', async () => {
    const autostart = await import('../../autostart.js')
    vi.mocked(autostart.installAutoStart).mockReturnValueOnce({ success: false, error: 'enable failed' })
    vi.mocked(autostart.getAutoStartState).mockReturnValueOnce({ installed: true, manager: 'systemd', active: false })
    const { cmdStart } = await import('../start.js')
    const result = await captureJsonOutput(() => cmdStart(['--json'], '/tmp/test-instance'))
    expect(result.exitCode).toBe(1)
    expect(expectValidJsonError(result.stdout).message).toContain('installation is partial')
    const daemon = await import('../../daemon.js')
    expect(daemon.startDaemon).not.toHaveBeenCalled()
  })
})
