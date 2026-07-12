import { wantsHelp } from './helpers.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes } from '../output.js'
import { resolveInstanceId } from '../resolve-instance-id.js'

/**
 * `openacp stop` — Stop the running daemon.
 *
 * Supervisor-managed instances are stopped through systemd/launchd while their
 * enabled unit remains installed. Detached fallback daemons use PID/SIGTERM.
 */
export async function cmdStop(args: string[] = [], instanceRoot?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()

  const root = instanceRoot!
  if (!json && wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp stop\x1b[0m — Stop the background daemon

\x1b[1mUsage:\x1b[0m
  openacp stop

Sends a stop signal to the running OpenACP daemon process.

\x1b[1mOptions:\x1b[0m
  --json          Output result as JSON
  -h, --help      Show this help message
`)
    return
  }
  const { stopDaemon, getPidPath, readPidFile, clearRunning } = await import('../daemon.js')
  const instanceId = resolveInstanceId(root)
  const { getAutoStartState, controlAutoStart } = await import('../autostart.js')
  const managed = getAutoStartState(instanceId)
  if (managed.installed && managed.active) {
    const pid = managed.pid ?? readPidFile(getPidPath(root)) ?? undefined
    const stopped = controlAutoStart(instanceId, 'stop')
    if (!stopped.success) {
      if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, stopped.error ?? 'Failed to stop managed daemon')
      console.error(stopped.error)
      process.exit(1)
    }
    clearRunning(root)
    if (json) jsonSuccess({ stopped: true, pid: pid ?? null, manager: managed.manager, serviceInstalled: true })
    console.log(`OpenACP managed daemon stopped${pid ? ` (was PID ${pid})` : ''}; auto-start remains installed`)
    return
  }
  const result = await stopDaemon(getPidPath(root), root)
  if (result.stopped) {
    if (json) jsonSuccess({ stopped: true, pid: result.pid, serviceInstalled: managed.installed })
    console.log(`OpenACP daemon stopped (was PID ${result.pid})`)
  } else {
    if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, result.error ?? 'Daemon is not running.')
    console.error(result.error)
    process.exit(1)
  }
}
