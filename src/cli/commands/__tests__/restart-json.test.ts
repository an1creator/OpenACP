import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { captureJsonOutput, expectValidJsonSuccess } from './helpers/json-test-utils.js'

vi.mock('../../daemon.js', () => ({
  startDaemon: vi.fn().mockReturnValue({ pid: 99999 }),
  stopDaemon: vi.fn().mockResolvedValue({ stopped: false }),
  getPidPath: vi.fn().mockReturnValue('/tmp/test.pid'),
  markRunning: vi.fn(),
  isProcessRunning: vi.fn().mockReturnValue(false),
  readPidFile: vi.fn().mockReturnValue(99999),
}))

vi.mock('../../../core/config/config.js', () => ({
  ConfigManager: class {
    exists = vi.fn().mockResolvedValue(true)
    load = vi.fn().mockResolvedValue(undefined)
    get = vi.fn().mockReturnValue({ logging: { logDir: '/tmp/logs' }, runMode: 'foreground' })
  },
}))

vi.mock('../../version.js', () => ({
  checkAndPromptUpdate: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../instance-hint.js', () => ({
  printInstanceHint: vi.fn(),
}))

const managedState = vi.hoisted(() => ({ installed: false, manager: null as null | 'systemd', active: false, pid: undefined as number | undefined }))
vi.mock('../../autostart.js', () => ({
  getAutoStartState: vi.fn(() => ({ ...managedState })),
  controlAutoStart: vi.fn().mockImplementation((_instanceId: string, action: string) => {
    if (action === 'start' || action === 'restart') {
      Object.assign(managedState, { active: true, pid: managedState.pid ?? 4242 })
    }
    return { success: true }
  }),
  installAutoStart: vi.fn().mockReturnValue({ success: true }),
  isAutoStartInstalled: vi.fn().mockReturnValue(false),
  uninstallAutoStart: vi.fn().mockReturnValue({ success: true }),
}))

vi.mock('../../api-client.js', () => ({
  waitForPortFile: vi.fn().mockResolvedValue(21420),
  waitForApiReady: vi.fn().mockResolvedValue(21420),
  removeStalePortFile: vi.fn(),
}))

vi.mock('../../../core/instance/instance-context.js', () => ({
  createInstanceContext: vi.fn().mockReturnValue({}),
  getGlobalRoot: vi.fn().mockReturnValue('/tmp/global'),
}))

describe('restart --json', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(managedState, { installed: false, manager: null, active: false, pid: undefined })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('forces daemon mode when --json is passed even if config says foreground', async () => {
    const daemon = await import('../../daemon.js')
    vi.mocked(daemon.isProcessRunning).mockReturnValueOnce(true)
    const { cmdRestart } = await import('../restart.js')
    const result = await captureJsonOutput(async () => {
      await cmdRestart(['--json'], '/tmp/test-instance')
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('pid', 99999)

    // Verify startDaemon was called (not startServer for foreground)
    expect(daemon.startDaemon).toHaveBeenCalled()
  })

  it('restarts a systemd-managed instance through systemctl without a detached competitor', async () => {
    Object.assign(managedState, { installed: true, manager: 'systemd', active: true, pid: 4242 })
    const { cmdRestart } = await import('../restart.js')
    const result = await captureJsonOutput(async () => cmdRestart(['--json'], '/tmp/test-instance'))
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toMatchObject({ managed: true, manager: 'systemd', pid: 4242 })
    const daemon = await import('../../daemon.js')
    const autostart = await import('../../autostart.js')
    expect(autostart.controlAutoStart).toHaveBeenCalledWith(expect.any(String), 'restart')
    expect(daemon.startDaemon).not.toHaveBeenCalled()
    expect(daemon.stopDaemon).not.toHaveBeenCalled()
  })

  it('stops a legacy detached competitor before activating an installed unit', async () => {
    Object.assign(managedState, { installed: true, manager: 'systemd', active: false, pid: undefined })
    const daemon = await import('../../daemon.js')
    vi.mocked(daemon.isProcessRunning).mockReturnValue(true)
    vi.mocked(daemon.stopDaemon).mockResolvedValue({ stopped: true, pid: 99999 })
    const { cmdRestart } = await import('../restart.js')
    const result = await captureJsonOutput(() => cmdRestart(['--json'], '/tmp/test-instance'))
    expect(result.exitCode).toBe(0)
    expect(daemon.stopDaemon).toHaveBeenCalled()
    const autostart = await import('../../autostart.js')
    expect(autostart.controlAutoStart).toHaveBeenCalledWith(expect.any(String), 'restart')
    expect(daemon.startDaemon).not.toHaveBeenCalled()
  })
})
