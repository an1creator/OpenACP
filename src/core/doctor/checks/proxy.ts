import fs from 'node:fs'
import type { DaemonProxyEnvironment, DoctorCheck } from '../types.js'
import { PROXY_ENV_KEYS } from '../../network/proxy-service.js'
import { ProxyStore, ProxyStoreCorruptError } from '../../network/proxy-store.js'
import path from 'node:path'
import { verifyDaemonIdentity } from '../../instance/daemon-identity.js'

const ROUTING_PROXY_KEYS = new Set<string>(PROXY_ENV_KEYS.filter((key) => !['NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'].includes(key)))

function activeCallerProxyVariables(): string[] {
  return [...ROUTING_PROXY_KEYS].filter((key) => process.env[key] !== undefined && process.env[key] !== '')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Inspect only proxy variable names from the tracked daemon; values never leave this function. */
export function inspectDaemonProxyEnvironment(pidPath: string, expectedInstanceRoot = path.dirname(pidPath)): DaemonProxyEnvironment {
  let pid: number
  try {
    pid = Number(fs.readFileSync(pidPath, 'utf8').trim())
  } catch {
    return { state: 'not-running', variableNames: [], source: 'none' }
  }
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    return { state: 'not-running', variableNames: [], source: 'none' }
  }
  // A live PID file is not identity proof: PIDs are reusable and the file may
  // be stale. Never inspect /proc environment data without the instance-bound
  // process-start marker written alongside the PID file.
  if (!verifyDaemonIdentity(pidPath, pid, expectedInstanceRoot)) {
    return { state: 'unavailable', variableNames: [], source: 'none' }
  }
  if (pid === process.pid) {
    return { state: 'known', variableNames: activeCallerProxyVariables(), source: 'current-process' }
  }
  if (process.platform !== 'linux') {
    return { state: 'unavailable', variableNames: [], source: 'none' }
  }
  try {
    const names = fs.readFileSync(`/proc/${pid}/environ`)
      .toString('utf8')
      .split('\0')
      .filter((entry) => entry.includes('='))
      .map((entry) => entry.slice(0, entry.indexOf('=')))
      .filter((key) => ROUTING_PROXY_KEYS.has(key))
    return { state: 'known', variableNames: [...new Set(names)].sort(), source: 'proc' }
  } catch {
    return { state: 'unavailable', variableNames: [], source: 'none' }
  }
}

export const proxyCheck: DoctorCheck = {
  name: 'Network proxy',
  order: 85,
  async run(ctx) {
    try { if (ctx.dataDir) new ProxyStore(ctx.dataDir).load() }
    catch (error) {
      if (error instanceof ProxyStoreCorruptError) return [{ status: 'fail', message: `${error.message}. Network traffic is blocked for safety. Inspect the quarantined file and last known-good copy before recovery.` }]
      throw error
    }
    const callerVariables = activeCallerProxyVariables()
    const daemon = ctx.daemonProxyEnvironment ?? inspectDaemonProxyEnvironment(ctx.pidPath ?? '', ctx.dataDir)
    if (daemon.state === 'known' && daemon.variableNames.length) {
      return [{
        status: 'warn',
        message: `Compatibility mode: the running OpenACP daemon has proxy variables (${daemon.variableNames.join(', ')}). Scoped routes still apply, but “Use host proxy settings” can use these variables. Remove only the OpenACP wrapper or service override when migration is complete.`,
      }]
    }
    if (daemon.state === 'known') {
      const shellNote = callerVariables.length && daemon.source !== 'current-process'
        ? ` Current command shell has proxy variables (${callerVariables.join(', ')}), but they are not present in the running daemon.`
        : ''
      return [{ status: 'pass', message: `Scoped routing is active; the running daemon has no proxy variables.${shellNote}` }]
    }
    if (callerVariables.length) {
      const daemonState = daemon.state === 'not-running'
        ? 'No running daemon was available to inspect'
        : 'The running daemon environment could not be inspected on this platform'
      return [{
        status: 'warn',
        message: `Current command shell has proxy variables (${callerVariables.join(', ')}). ${daemonState}, so daemon compatibility mode was not inferred. A daemon started from this shell may inherit them.`,
      }]
    }
    return [{
      status: 'pass',
      message: daemon.state === 'not-running'
        ? 'Current command shell has no proxy variables; no running daemon environment was available'
        : 'Current command shell has no proxy variables; the running daemon environment could not be inspected, so compatibility mode was not inferred',
    }]
  },
}
