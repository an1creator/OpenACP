import { checkAndPromptUpdate } from '../version.js'
import { wantsHelp } from './helpers.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes } from '../output.js'
import { printInstanceHint } from '../instance-hint.js'
import { resolveInstanceId } from '../resolve-instance-id.js'
import path from 'node:path'

/**
 * `openacp start` — Start the daemon in the background.
 *
 * Installs and starts the per-instance systemd/launchd service when supported.
 * Detached startDaemon() is retained only as a supervisor-unavailable fallback.
 */
export async function cmdStart(args: string[] = [], instanceRoot?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()

  const root = instanceRoot!
  if (!json && wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp start\x1b[0m — Start OpenACP as a background daemon

\x1b[1mUsage:\x1b[0m
  openacp start

Starts the server as a background process (daemon mode).
Requires an existing config — run 'openacp' first to set up.

\x1b[1mOptions:\x1b[0m
  --json          Output result as JSON
  -h, --help      Show this help message

\x1b[1mSee also:\x1b[0m
  openacp stop       Stop the daemon
  openacp restart    Restart the daemon
  openacp status     Check if daemon is running
  openacp logs       Tail daemon log file
`)
    return
  }
  await checkAndPromptUpdate(root)
  const { startDaemon, getPidPath, isProcessRunning, markRunning, readPidFile } = await import('../daemon.js')
  const { ConfigManager } = await import('../../core/config/config.js')
  const cm = new ConfigManager(path.join(root, 'config.json'))
  if (await cm.exists()) {
    await cm.load()
    const config = cm.get()
    const pidPath = getPidPath(root)
    if (isProcessRunning(pidPath)) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, 'Daemon is already running. Use "openacp restart" to restart it.')
      console.error('OpenACP daemon is already running. Use "openacp restart" to restart it.')
      process.exit(1)
    }
    const instanceId = resolveInstanceId(root)
    // Prefer the OS supervisor. Installing a unit and then spawning a detached
    // competitor leaves systemd inactive and breaks future restart/update flows.
    try {
      const { installAutoStart, controlAutoStart, getAutoStartState } = await import('../autostart.js')
      const { removeStalePortFile, waitForApiReady } = await import('../api-client.js')
      // Explicit start always restores runtime intent before installAutoStart():
      // launchd bootstrap may launch the child as part of installation.
      markRunning(root)
      removeStalePortFile(undefined, root)
      const autoResult = installAutoStart(config.logging.logDir, root, instanceId)
      if (autoResult.success) {
        const controlled = controlAutoStart(instanceId, 'start')
        if (!controlled.success) {
          if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, controlled.error ?? 'Failed to start managed service')
          console.error(`Failed to start managed service: ${controlled.error}`)
          process.exit(1)
        }
        const port = await waitForApiReady(root, instanceId)
        const state = getAutoStartState(instanceId)
        const pid = state.pid ?? readPidFile(pidPath) ?? undefined
        if (port === null || !state.active || !state.pid) {
          const reason = !state.active
            ? 'managed service became inactive during startup'
            : !state.pid
              ? 'managed service has no running process'
              : 'daemon API did not become ready'
          if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, `Failed to start OpenACP: ${reason}`)
          console.error(`Failed to start OpenACP: ${reason}`)
          process.exit(1)
        }
        if (json) jsonSuccess({ pid: pid ?? null, instanceId, name: config.instanceName ?? null, directory: path.dirname(root), dir: root, port, manager: state.manager, managed: true })
        printInstanceHint(root)
        console.log(`OpenACP managed daemon started through ${state.manager}${pid ? ` (PID ${pid})` : ''}`)
        return
      }
      console.warn(`Warning: auto-start not enabled: ${autoResult.error}`)
      if (getAutoStartState(instanceId).installed) {
        if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, 'Managed service installation is partial; refusing detached fallback')
        console.error('Managed service installation is partial; refusing detached fallback')
        process.exit(1)
      }
    } catch (e) {
      if ((e as Error).message?.startsWith('process.exit')) throw e
      console.warn(`Warning: auto-start not enabled: ${(e as Error).message}`)
    }

    // Unsupported/failed supervisor setup: preserve the detached daemon fallback.
    const result = startDaemon(pidPath, config.logging.logDir, root)
    if ('error' in result) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, result.error)
      console.error(result.error)
      process.exit(1)
    }

    const { waitForApiReady } = await import('../api-client.js')
    const port = await waitForApiReady(root, instanceId)
    if (port === null || !isProcessRunning(pidPath)) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, 'Daemon process exited before its API became ready')
      console.error('Daemon process exited before its API became ready')
      process.exit(1)
    }

    if (json) {
      jsonSuccess({
        pid: result.pid,
        instanceId,
        name: config.instanceName ?? null,
        directory: path.dirname(root),
        dir: root,
        port,
      })
    }
    printInstanceHint(root)
    console.log(`OpenACP daemon started (PID ${result.pid})`)
  } else {
    if (json) jsonError(ErrorCodes.CONFIG_NOT_FOUND, 'No config found. Run "openacp" first to set up.')
    console.error('No config found. Run "openacp" first to set up.')
    process.exit(1)
  }
}
