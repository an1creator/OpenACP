import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileSync = vi.hoisted(() => vi.fn())
const existsSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync,
}))

describe('systemd lifecycle control', () => {
  const originalPlatform = process.platform
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }))
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))
  beforeEach(() => {
    execFileSync.mockReset()
    existsSync.mockReset().mockReturnValue(true)
  })

  it('reads ActiveState and MainPID without mutating the unit', async () => {
    execFileSync.mockReturnValue('MainPID=4242\nActiveState=active\n')
    const { getAutoStartState } = await import('../autostart.js')
    expect(getAutoStartState('instance')).toMatchObject({ installed: true, manager: 'systemd', active: true, pid: 4242 })
    expect(execFileSync).toHaveBeenCalledWith('systemctl', expect.arrayContaining(['--user', 'show', 'openacp-instance']), expect.any(Object))
  })

  it.each(['start', 'stop', 'restart'] as const)('delegates %s to systemctl and never removes the unit', async (action) => {
    execFileSync.mockImplementation((_cmd, args: string[]) => args.includes('show') ? 'ActiveState=inactive\nMainPID=0\n' : '')
    const { controlAutoStart } = await import('../autostart.js')
    expect(controlAutoStart('instance', action)).toEqual({ success: true })
    expect(execFileSync).toHaveBeenCalledWith('systemctl', ['--user', action, 'openacp-instance'], { stdio: 'pipe' })
  })
})
