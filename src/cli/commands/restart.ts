import { wantsHelp } from './helpers.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes } from '../output.js'
import { printInstanceHint } from '../instance-hint.js'
import { resolveInstanceId } from '../resolve-instance-id.js'
import path from 'node:path'
import { createInstanceContext, getGlobalRoot } from '../../core/instance/instance-context.js'
import { InstanceRegistry } from '../../core/instance/instance-registry.js'
import { randomUUID } from 'node:crypto'

/**
 * `openacp restart` — Stop and restart the daemon.
 *
 * Mode selection: explicit --foreground/--daemon flags win; otherwise, if a daemon
 * was running we restart as daemon, else we honour config.runMode. This logic prevents
 * a daemon that was started with `openacp start` (runMode='foreground') from accidentally
 * restarting in foreground mode.
 *
 * A supervisor-managed daemon is always refreshed/restarted through its manager;
 * a detached competitor must never be spawned beside an inactive enabled unit.
 */
export async function cmdRestart(args: string[] = [], instanceRoot?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()

  const root = instanceRoot!
  if (!json && wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp restart\x1b[0m — Restart the background daemon

\x1b[1mUsage:\x1b[0m
  openacp restart
  openacp restart --foreground    Restart in foreground mode
  openacp restart --daemon        Restart as background daemon

Stops the running daemon (if any) and starts a new one.

\x1b[1mOptions:\x1b[0m
  --json          Output result as JSON
  -h, --help      Show this help message

\x1b[1mSee also:\x1b[0m
  openacp start       Start the daemon
  openacp stop        Stop the daemon
  openacp status      Check if daemon is running
`)
    return
  }

  const forceForeground = args.includes('--foreground')
  const forceDaemon = args.includes('--daemon')

  const { stopDaemon, startDaemon, getPidPath, markRunning, isProcessRunning, readPidFile } = await import('../daemon.js')
  const { ConfigManager } = await import('../../core/config/config.js')
  const { checkAndPromptUpdate } = await import('../version.js')

  await checkAndPromptUpdate(root)

  const pidPath = getPidPath(root)

  const cm = new ConfigManager(path.join(root, 'config.json'))
  if (!(await cm.exists())) {
    if (json) jsonError(ErrorCodes.CONFIG_NOT_FOUND, 'No config found. Run "openacp" first to set up.')
    console.error('No config found. Run "openacp" first to set up.')
    process.exit(1)
  }

  await cm.load()
  const config = cm.get()
  const instanceId = resolveInstanceId(root)
  const { getAutoStartState, controlAutoStart, installAutoStart } = await import('../autostart.js')
  const managed = getAutoStartState(instanceId)

  // A supervisor-owned instance must be restarted by its supervisor. Starting a
  // detached child here creates a PPID-1 competitor while the unit stays inactive.
  if (managed.installed && !forceForeground) {
    if (!json) console.log(`Restarting through ${managed.manager}...`)
    const trackedPid = readPidFile(pidPath)
    const detachedCompetitor = isProcessRunning(pidPath) && (
      !managed.active || (managed.pid !== undefined && trackedPid !== managed.pid)
    )
    if (detachedCompetitor) {
      // Repair a legacy/broken state where an enabled unit coexists with a detached daemon.
      const legacyStop = await stopDaemon(pidPath, root)
      if (!legacyStop.stopped && isProcessRunning(pidPath)) {
        const message = legacyStop.error ?? 'Could not stop detached daemon competitor'
        if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, message)
        console.error(message)
        process.exit(1)
      }
    }
    const { removeStalePortFile, waitForApiReady } = await import('../api-client.js')
    // Set intent before refreshing the supervisor definition: launchd may start
    // the child during bootstrap, before controlAutoStart('restart') is reached.
    markRunning(root)
    removeStalePortFile(undefined, root)
    const refreshed = installAutoStart(config.logging.logDir, root, instanceId)
    if (!refreshed.success) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, refreshed.error ?? 'Failed to refresh managed service')
      console.error(`Failed to refresh managed service: ${refreshed.error}`)
      process.exit(1)
    }
    const restarted = controlAutoStart(instanceId, 'restart')
    if (!restarted.success) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, restarted.error ?? 'Managed restart failed')
      console.error(`Managed restart failed: ${restarted.error}`)
      process.exit(1)
    }
    const port = await waitForApiReady(root, instanceId)
    const state = getAutoStartState(instanceId)
    const pid = state.pid ?? readPidFile(pidPath) ?? undefined
    if (port === null || !state.active || !state.pid) {
      const reason = !state.active
        ? 'managed service became inactive during restart'
        : !state.pid
          ? 'managed service has no running process'
          : 'daemon API did not become ready'
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, `Failed to restart OpenACP: ${reason}`)
      console.error(`Failed to restart OpenACP: ${reason}`)
      process.exit(1)
    }
    if (json) jsonSuccess({ pid: pid ?? null, instanceId, dir: root, port, manager: state.manager, managed: true })
    printInstanceHint(root)
    console.log(`OpenACP restarted through ${state.manager}${pid ? ` (PID ${pid})` : ''}`)
    return
  }

  // Non-managed or explicit foreground transition: stop the PID-tracked process.
  if (!json) console.log('Stopping...')
  const stopResult = await stopDaemon(pidPath, root)
  if (!json && stopResult.stopped) console.log(`Stopped daemon (was PID ${stopResult.pid})`)

  // Determine mode: explicit flag > was-running-as-daemon > config
  // If a daemon was running (PID exists), restart as daemon to preserve the current mode.
  // `openacp start` always starts as daemon regardless of config.runMode, so we must not
  // use config.runMode alone — otherwise a daemon started via `openacp start` with
  // runMode:'foreground' would incorrectly restart in foreground.
  const hadDaemon = stopResult.pid !== undefined
  const useForeground = json ? false : (forceForeground || (!forceDaemon && !hadDaemon && config.runMode !== 'daemon'))

  if (useForeground) {
    // Restarting in foreground: remove any stale autostart entry so it doesn't
    // surprise the user by relaunching a daemon on next login
    try {
      const { uninstallAutoStart, isAutoStartInstalled } = await import('../autostart.js')
      if (isAutoStartInstalled(instanceId)) uninstallAutoStart(instanceId)
    } catch { /* non-fatal */ }

    markRunning(root)
    printInstanceHint(root)
    console.log('Starting in foreground mode...')
    const { startServer } = await import('../../main.js')
    const reg = new InstanceRegistry(path.join(getGlobalRoot(), 'instances.json'))
    reg.load()
    const existingEntry = reg.getByRoot(root)
    const ctx = createInstanceContext({
      id: existingEntry?.id ?? randomUUID(),
      root,
    })
    await startServer({ instanceContext: ctx })
  } else {
    const { removeStalePortFile, waitForApiReady } = await import('../api-client.js')
    removeStalePortFile(undefined, root)
    const result = startDaemon(pidPath, config.logging.logDir, root)
    if ('error' in result) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, result.error)
      console.error(result.error)
      process.exit(1)
    }
    // Reinstall autostart to refresh node path (e.g. after nvm version change),
    // but only if autostart was already installed before this restart
    try {
      const { installAutoStart, isAutoStartInstalled } = await import('../autostart.js')
      if (isAutoStartInstalled(instanceId)) {
        const autoResult = installAutoStart(config.logging.logDir, root, instanceId)
        if (!autoResult.success) console.warn(`Warning: auto-start not refreshed: ${autoResult.error}`)
      }
    } catch { /* non-fatal */ }

    const port = await waitForApiReady(root, instanceId)
    if (port === null || !isProcessRunning(pidPath)) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, 'Daemon process exited before its API became ready')
      console.error('Daemon process exited before its API became ready')
      process.exit(1)
    }

    if (json) jsonSuccess({ pid: result.pid, instanceId, dir: root, port })
    printInstanceHint(root)
    console.log(`OpenACP daemon started (PID ${result.pid})`)
  }
}
