import { describe, expect, it } from 'vitest'
import { getDaemonSupervisor, isSystemdManagedDaemon } from '../daemon.js'

describe('daemon restart ownership', () => {
  it('delegates package-update restart only for a systemd-owned daemon child', () => {
    expect(isSystemdManagedDaemon(['node', 'cli', '--daemon-child'], { INVOCATION_ID: 'abc' })).toBe(true)
    expect(isSystemdManagedDaemon(['node', 'cli', '--daemon-child'], {})).toBe(false)
    expect(isSystemdManagedDaemon(['node', 'cli'], { INVOCATION_ID: 'abc' })).toBe(false)
  })

  it('uses an explicit launchd ownership marker without relying on systemd variables', () => {
    expect(getDaemonSupervisor(
      ['node', 'cli', '--daemon-child'],
      { OPENACP_SUPERVISOR: 'launchd' },
    )).toBe('launchd')
    expect(getDaemonSupervisor(
      ['node', 'cli'],
      { OPENACP_SUPERVISOR: 'launchd' },
    )).toBeNull()
  })
})
