import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => new Map<string, string>())
const execFileSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFileSync }))
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), homedir: () => '/virtual-home' }))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: (file: string) => files.has(file),
  readFileSync: (file: string) => files.get(file) ?? '',
  writeFileSync: (file: string, data: string) => { files.set(file, String(data)) },
  renameSync: (from: string, to: string) => { files.set(to, files.get(from) ?? ''); files.delete(from) },
  unlinkSync: (file: string) => { files.delete(file) },
  rmSync: (file: string) => { files.delete(file) },
  mkdirSync: vi.fn(),
}))

describe('launchd auto-start installation transaction', () => {
  const originalPlatform = process.platform
  beforeAll(() => Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true }))
  afterAll(() => Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true }))
  beforeEach(() => { files.clear(); execFileSync.mockReset() })

  for (const phase of ['validate', 'bootout', 'bootstrap'] as const) {
    it(`restores the old plist/job when ${phase} fails`, async () => {
      const plist = '/virtual-home/Library/LaunchAgents/com.openacp.daemon.project.plist'
      files.set(plist, '<plist>previous</plist>')
      let failed = false
      execFileSync.mockImplementation((command: string, args: string[]) => {
        if (command === 'launchctl' && args[0] === 'print') return 'state = running\npid = 42\n'
        const matches = phase === 'validate' ? command === 'plutil'
          : phase === 'bootout' ? command === 'launchctl' && args[0] === 'bootout'
            : command === 'launchctl' && args[0] === 'bootstrap'
        if (matches && !failed) { failed = true; throw new Error(`${phase} failed`) }
        return ''
      })
      const { installAutoStart } = await import('../autostart.js')
      const result = installAutoStart('/logs', '/instance', 'project')
      expect(result).toMatchObject({ success: false, error: `${phase} failed` })
      expect(files.get(plist)).toBe('<plist>previous</plist>')
      if (phase !== 'validate') {
        expect(execFileSync).toHaveBeenCalledWith('launchctl', expect.arrayContaining(['bootstrap', plist]), { stdio: 'pipe' })
      }
    })
  }
})
