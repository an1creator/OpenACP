import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => new Map<string, string>())
const execFileSync = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFileSync }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/virtual-home',
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (file: string) => files.has(file),
  readFileSync: (file: string) => files.get(file) ?? '',
  writeFileSync: (file: string, data: string) => { files.set(file, String(data)) },
  renameSync: (from: string, to: string) => {
    files.set(to, files.get(from) ?? '')
    files.delete(from)
  },
  unlinkSync: (file: string) => { files.delete(file) },
  mkdirSync: vi.fn(),
}))

describe('systemd auto-start installation transaction', () => {
  const originalPlatform = process.platform
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'linux', configurable: true }))
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))
  beforeEach(() => {
    files.clear()
    execFileSync.mockReset()
  })

  it('restores the previous unit when reload/enable fails', async () => {
    const service = '/virtual-home/.config/systemd/user/openacp-project.service'
    files.set(service, 'previous unit\n')
    execFileSync.mockImplementation((_command, args: string[]) => {
      if (args.includes('enable')) throw new Error('enable failed')
      return ''
    })
    const { installAutoStart } = await import('../autostart.js')
    const result = installAutoStart('/logs', '/instance', 'project')
    expect(result).toMatchObject({ success: false, error: 'enable failed' })
    expect(files.get(service)).toBe('previous unit\n')
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' },
    )
  })
})
