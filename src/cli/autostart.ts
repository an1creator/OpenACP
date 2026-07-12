import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { createChildLogger } from '../core/utils/log.js'

// Autostart integrates with the OS process supervisor so the daemon restarts after login.
// macOS uses launchd (LaunchAgents), Linux uses systemd user units.
// Each instance gets its own service, identified by instanceId, so multiple instances
// can coexist without conflicting plist/unit names.

const log = createChildLogger({ module: 'autostart' })

// Legacy paths — no instanceId, used for migration only
const LEGACY_LAUNCHD_PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.openacp.daemon.plist')
const LEGACY_SYSTEMD_SERVICE_PATH = path.join(os.homedir(), '.config', 'systemd', 'user', 'openacp.service')

function getLaunchdLabel(instanceId: string): string {
  return `com.openacp.daemon.${instanceId}`
}

function getLaunchdPlistPath(instanceId: string): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${getLaunchdLabel(instanceId)}.plist`)
}

export function getSystemdServiceName(instanceId: string): string {
  return `openacp-${instanceId}`
}

function getSystemdServicePath(instanceId: string): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${getSystemdServiceName(instanceId)}.service`)
}

export interface AutoStartState {
  installed: boolean
  manager: 'systemd' | 'launchd' | null
  active: boolean
  pid?: number
}

/** Inspect the per-instance supervisor without changing it. */
export function getAutoStartState(instanceId: string): AutoStartState {
  if (process.platform === 'linux') {
    const installed = fs.existsSync(getSystemdServicePath(instanceId))
    if (!installed) return { installed: false, manager: null, active: false }
    try {
      const output = execFileSync('systemctl', [
        '--user', 'show', getSystemdServiceName(instanceId),
        '--property=ActiveState', '--property=MainPID',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const properties = Object.fromEntries(output.trim().split(/\r?\n/).map((line) => {
        const index = line.indexOf('=')
        return index >= 0 ? [line.slice(0, index), line.slice(index + 1)] : [line, '']
      }))
      const active = properties.ActiveState === 'active'
      const pid = Number(properties.MainPID)
      return { installed: true, manager: 'systemd', active, ...(pid > 0 ? { pid } : {}) }
    } catch {
      return { installed: true, manager: 'systemd', active: false }
    }
  }
  if (process.platform === 'darwin') {
    const installed = fs.existsSync(getLaunchdPlistPath(instanceId))
    if (!installed) return { installed: false, manager: null, active: false }
    try {
      const uid = process.getuid!()
      const output = execFileSync('launchctl', ['print', `gui/${uid}/${getLaunchdLabel(instanceId)}`], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      })
      const active = /^\s*state\s*=\s*running\s*$/m.test(output)
      const pidMatch = output.match(/^\s*pid\s*=\s*(\d+)\s*$/m)
      const pid = pidMatch ? Number(pidMatch[1]) : 0
      return { installed: true, manager: 'launchd', active, ...(pid > 0 ? { pid } : {}) }
    } catch {
      return { installed: true, manager: 'launchd', active: false }
    }
  }
  return { installed: false, manager: null, active: false }
}

/** Start/stop/restart an installed per-instance supervisor entry without removing it. */
export function controlAutoStart(
  instanceId: string,
  action: 'start' | 'stop' | 'restart',
): { success: boolean; error?: string } {
  const state = getAutoStartState(instanceId)
  if (!state.installed || !state.manager) return { success: false, error: 'Auto-start service is not installed' }
  try {
    if (state.manager === 'systemd') {
      execFileSync('systemctl', ['--user', action, getSystemdServiceName(instanceId)], { stdio: 'pipe' })
    } else {
      const uid = process.getuid!()
      const target = `gui/${uid}/${getLaunchdLabel(instanceId)}`
      if (action === 'stop') execFileSync('launchctl', ['kill', 'SIGTERM', target], { stdio: 'pipe' })
      else execFileSync('launchctl', ['kickstart', ...(action === 'restart' ? ['-k'] : []), target], { stdio: 'pipe' })
    }
    return { success: true }
  } catch (error) {
    return { success: false, error: (error as Error).message }
  }
}

/** Returns true if the current platform supports auto-start management. */
export function isAutoStartSupported(): boolean {
  return process.platform === 'darwin' || process.platform === 'linux'
}

/**
 * Escape a string for safe embedding in an XML plist value.
 * launchd plists are XML — unescaped special chars cause parse failures.
 */
export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Escape a string for safe use as a quoted value in a systemd unit file.
 * Systemd uses its own escaping rules: backslash, quotes, `$` (env expand), and `%` (specifiers).
 */
export function escapeSystemdValue(str: string): string {
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '$$$$')
    .replace(/%/g, '%%')
  return `"${escaped}"`
}

/**
 * Generate a launchd plist for the given instance.
 *
 * The plist starts the daemon via `node <cli> --daemon-child`, with OPENACP_INSTANCE_ROOT
 * set so the child knows which instance to load. KeepAlive.SuccessfulExit=false means
 * launchd restarts on crash but not on clean exit (e.g. `openacp stop`).
 */
export function generateLaunchdPlist(nodePath: string, cliPath: string, logDir: string, instanceRoot: string, instanceId: string): string {
  const label = getLaunchdLabel(instanceId)
  const logFile = path.join(logDir, 'openacp.log')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(cliPath)}</string>
    <string>--daemon-child</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENACP_INSTANCE_ROOT</key>
    <string>${escapeXml(instanceRoot)}</string>
    <key>OPENACP_SUPERVISOR</key>
    <string>launchd</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logFile)}</string>
</dict>
</plist>
`
}

/**
 * Generate a systemd user unit for the given instance.
 *
 * `Restart=on-failure` mirrors launchd's KeepAlive.SuccessfulExit=false behavior —
 * the daemon is restarted on crash but not after a clean SIGTERM from `openacp stop`.
 * Uses `WantedBy=default.target` so it activates on user login (not system boot).
 */
export function generateSystemdUnit(nodePath: string, cliPath: string, instanceRoot: string, instanceId: string): string {
  const serviceName = getSystemdServiceName(instanceId)
  return `[Unit]
Description=OpenACP Daemon (${instanceId})

[Service]
ExecStart=${escapeSystemdValue(nodePath)} ${escapeSystemdValue(cliPath)} --daemon-child
Environment=OPENACP_INSTANCE_ROOT=${escapeSystemdValue(instanceRoot)}
Environment=OPENACP_SUPERVISOR=systemd
Restart=on-failure

[Install]
WantedBy=default.target
# Service name: ${serviceName}
`
}

/** Remove legacy single-instance plist/service if it exists (one-time migration). */
function migrateLegacy(): void {
  if (process.platform === 'darwin' && fs.existsSync(LEGACY_LAUNCHD_PLIST_PATH)) {
    try {
      const uid = process.getuid!()
      execFileSync('launchctl', ['bootout', `gui/${uid}`, 'com.openacp.daemon'], { stdio: 'pipe' })
    } catch { /* already unloaded */ }
    try { fs.unlinkSync(LEGACY_LAUNCHD_PLIST_PATH) } catch { /* already gone */ }
    log.info('Removed legacy single-instance LaunchAgent')
  }
  if (process.platform === 'linux' && fs.existsSync(LEGACY_SYSTEMD_SERVICE_PATH)) {
    try { execFileSync('systemctl', ['--user', 'disable', 'openacp'], { stdio: 'pipe' }) } catch { /* ignore */ }
    try { fs.unlinkSync(LEGACY_SYSTEMD_SERVICE_PATH) } catch { /* already gone */ }
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' }) } catch { /* ignore */ }
    log.info('Removed legacy single-instance systemd service')
  }
}

/**
 * Register the daemon as a login-time service for the given instance.
 *
 * macOS: writes a LaunchAgent plist and bootstraps it into the user's GUI session.
 * Linux: writes a systemd user unit, reloads the daemon, and enables the service.
 * Runs `migrateLegacy()` first to remove the old single-instance service if present.
 */
export function installAutoStart(logDir: string, instanceRoot: string, instanceId: string): { success: boolean; error?: string } {
  if (!isAutoStartSupported()) {
    return { success: false, error: 'Auto-start not supported on this platform' }
  }

  const nodePath = process.execPath
  const cliPath = path.resolve(process.argv[1])
  const resolvedLogDir = logDir.startsWith('~')
    ? path.join(os.homedir(), logDir.slice(1))
    : logDir

  try {
    migrateLegacy()

    if (process.platform === 'darwin') {
      const plistPath = getLaunchdPlistPath(instanceId)
      const plist = generateLaunchdPlist(nodePath, cliPath, resolvedLogDir, instanceRoot, instanceId)
      const dir = path.dirname(plistPath)
      fs.mkdirSync(dir, { recursive: true })
      const uid = process.getuid!()
      const domain = `gui/${uid}`
      const previous = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : undefined
      const previousState = getAutoStartState(instanceId)
      const tmp = `${plistPath}.${process.pid}.tmp`
      let replaced = false
      let bootedOut = false
      try {
        fs.writeFileSync(tmp, plist, { mode: 0o600 })
        execFileSync('plutil', ['-lint', tmp], { stdio: 'pipe' })
        fs.renameSync(tmp, plistPath); replaced = true
        if (previousState.active) {
          execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' })
          bootedOut = true
        }
        execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' })
      } catch (error) {
        try { fs.rmSync(tmp, { force: true }) } catch {}
        if (replaced) {
          let rollbackBootedOut = false
          try { execFileSync('launchctl', ['bootout', domain, plistPath], { stdio: 'pipe' }); rollbackBootedOut = true } catch {}
          if (previous === undefined) fs.rmSync(plistPath, { force: true })
          else {
            const rollbackTmp = `${plistPath}.${process.pid}.rollback.tmp`
            fs.writeFileSync(rollbackTmp, previous, { mode: 0o600 }); fs.renameSync(rollbackTmp, plistPath)
            if (previousState.active || bootedOut || rollbackBootedOut) execFileSync('launchctl', ['bootstrap', domain, plistPath], { stdio: 'pipe' })
          }
        }
        throw error
      }
      log.info({ instanceId }, 'LaunchAgent installed')
      return { success: true }
    }

    if (process.platform === 'linux') {
      const servicePath = getSystemdServicePath(instanceId)
      const serviceName = getSystemdServiceName(instanceId)
      const unit = generateSystemdUnit(nodePath, cliPath, instanceRoot, instanceId)
      const dir = path.dirname(servicePath)
      fs.mkdirSync(dir, { recursive: true })
      const previous = fs.existsSync(servicePath) ? fs.readFileSync(servicePath, 'utf8') : undefined
      const tmp = `${servicePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, unit, { mode: 0o600 }); fs.renameSync(tmp, servicePath)
      try {
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
        execFileSync('systemctl', ['--user', 'enable', serviceName], { stdio: 'pipe' })
      } catch (error) {
        if (previous === undefined) fs.unlinkSync(servicePath); else fs.writeFileSync(servicePath, previous)
        try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' }) } catch {}
        throw error
      }
      log.info({ instanceId }, 'systemd user service installed')
      return { success: true }
    }

    return { success: false, error: 'Unsupported platform' }
  } catch (e) {
    const msg = (e as Error).message
    log.error({ err: msg }, 'Failed to install auto-start')
    return { success: false, error: msg }
  }
}

/**
 * Remove the login-time service registration for the given instance.
 * No-op if the service is not installed.
 */
export function uninstallAutoStart(instanceId: string): { success: boolean; error?: string } {
  if (!isAutoStartSupported()) {
    return { success: false, error: 'Auto-start not supported on this platform' }
  }

  try {
    if (process.platform === 'darwin') {
      const plistPath = getLaunchdPlistPath(instanceId)
      if (fs.existsSync(plistPath)) {
        const uid = process.getuid!()
        try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'pipe' }) } catch { /* already unloaded */ }
        fs.unlinkSync(plistPath)
        log.info({ instanceId }, 'LaunchAgent removed')
      }
      return { success: true }
    }

    if (process.platform === 'linux') {
      const servicePath = getSystemdServicePath(instanceId)
      const serviceName = getSystemdServiceName(instanceId)
      if (fs.existsSync(servicePath)) {
        try { execFileSync('systemctl', ['--user', 'disable', serviceName], { stdio: 'pipe' }) } catch { /* already disabled */ }
        fs.unlinkSync(servicePath)
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' })
        log.info({ instanceId }, 'systemd user service removed')
      }
      return { success: true }
    }

    return { success: false, error: 'Unsupported platform' }
  } catch (e) {
    const msg = (e as Error).message
    log.error({ err: msg }, 'Failed to uninstall auto-start')
    return { success: false, error: msg }
  }
}

/** Returns true if the login-time service is currently registered for this instance. */
export function isAutoStartInstalled(instanceId: string): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync(getLaunchdPlistPath(instanceId))
  }
  if (process.platform === 'linux') {
    return fs.existsSync(getSystemdServicePath(instanceId))
  }
  return false
}
