import fs from 'node:fs'
import path from 'node:path'
import { readIdFromConfig } from './instance-registry.js'

interface DaemonIdentityMarker {
  version: 1
  pid: number
  instanceRoot: string
  instanceId: string | null
  processStartTicks: string | null
}

export function daemonIdentityPath(pidPath: string): string {
  return `${pidPath}.identity`
}

function processStartTicks(pid: number): string | null {
  if (process.platform !== 'linux') return null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const endOfCommand = stat.lastIndexOf(') ')
    if (endOfCommand < 0) return null
    // The suffix begins at field 3 (state); starttime is field 22.
    const value = stat.slice(endOfCommand + 2).trim().split(/\s+/)[19]
    return /^\d+$/.test(value ?? '') ? value : null
  } catch { return null }
}

/** Persist an instance-bound, PID-reuse-safe marker next to the legacy PID file. */
export function writeDaemonIdentity(pidPath: string, pid: number): void {
  const instanceRoot = path.resolve(path.dirname(pidPath))
  const marker: DaemonIdentityMarker = {
    version: 1,
    pid,
    instanceRoot,
    instanceId: readIdFromConfig(instanceRoot),
    processStartTicks: processStartTicks(pid),
  }
  fs.writeFileSync(daemonIdentityPath(pidPath), JSON.stringify(marker), { mode: 0o600 })
}

export function removeDaemonIdentity(pidPath: string): void {
  try { fs.unlinkSync(daemonIdentityPath(pidPath)) } catch {}
}

/**
 * Prove that a live PID is the daemon recorded by this exact instance before
 * callers inspect any process-owned data such as /proc/<pid>/environ.
 */
export function verifyDaemonIdentity(pidPath: string, pid: number, expectedInstanceRoot: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(daemonIdentityPath(pidPath), 'utf8')) as Partial<DaemonIdentityMarker>
    const expectedRoot = path.resolve(expectedInstanceRoot)
    if (marker.version !== 1 || marker.pid !== pid || marker.instanceRoot !== expectedRoot) return false
    const expectedId = readIdFromConfig(expectedRoot)
    if (expectedId && marker.instanceId !== expectedId) return false
    const currentStartTicks = processStartTicks(pid)
    // Linux environment inspection requires a start marker so PID reuse cannot
    // make an unrelated live process pass identity verification.
    if (process.platform === 'linux') {
      if (!marker.processStartTicks || !currentStartTicks || marker.processStartTicks !== currentStartTicks) return false
    }
    return true
  } catch { return false }
}

