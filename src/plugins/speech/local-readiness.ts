import { statSync } from 'node:fs'
import { commandExists } from '../../core/agents/agent-dependencies.js'
import { readLocalWhisperSettings } from './native-stt.js'

export const LOCAL_WHISPER_SCRIPT_PATH_ENV = 'OPENACP_SPEECH_LOCAL_WHISPER_SCRIPT_PATH'

export type LocalWhisperScriptReadiness = 'ready' | 'missing' | 'not-file' | 'not-executable'

export interface LocalWhisperReadiness {
  ready: boolean
  script: LocalWhisperScriptReadiness
  runtimeReady: boolean
}

interface LocalWhisperReadinessOptions {
  env?: NodeJS.ProcessEnv
  commandAvailable?: (command: string) => boolean
}

/**
 * Check the effective local transcription executable and host runtime.
 *
 * The result deliberately contains no path so connector and doctor output can
 * report readiness without disclosing a host-only executable location.
 */
export function getLocalWhisperReadiness(
  settings: Record<string, unknown>,
  options: LocalWhisperReadinessOptions = {},
): LocalWhisperReadiness {
  const env = options.env ?? process.env
  const envScriptPath = env[LOCAL_WHISPER_SCRIPT_PATH_ENV]?.trim()
  const effectiveSettings = envScriptPath
    ? { ...settings, localWhisperScriptPath: envScriptPath }
    : settings
  const scriptPath = readLocalWhisperSettings(effectiveSettings).scriptPath
  const commandAvailable = options.commandAvailable ?? commandExists

  let script: LocalWhisperScriptReadiness
  try {
    const stat = statSync(scriptPath)
    script = !stat.isFile() ? 'not-file' : (stat.mode & 0o111) === 0 ? 'not-executable' : 'ready'
  } catch {
    script = 'missing'
  }

  const runtimeReady = commandAvailable('uv') || commandAvailable('python3')
  return { ready: script === 'ready' && runtimeReady, script, runtimeReady }
}
