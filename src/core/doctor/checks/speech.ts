import path from 'node:path'
import type { CheckResult, DoctorCheck } from '../types.js'
import { SettingsManager } from '../../plugin/settings-manager.js'
import { LOCAL_WHISPER_PROVIDER } from '../../../plugins/speech/native-stt.js'
import { getLocalWhisperReadiness } from '../../../plugins/speech/local-readiness.js'
import { GroqSTT } from '../../../plugins/speech/providers/groq.js'
import { proxyScopeLabel } from '../../network/proxy-labels.js'

const groqRoute = proxyScopeLabel('services.speech')
const modelDownloadRoute = proxyScopeLabel('services.speechDownloads')

export const speechCheck: DoctorCheck = {
  name: 'Speech-to-text',
  order: 84,
  async run(ctx): Promise<CheckResult[]> {
    const settings = await new SettingsManager(path.join(ctx.pluginsDir, 'data')).loadSettings('@openacp/speech')
    const legacyGroqKey = typeof settings.groqApiKey === 'string' && settings.groqApiKey.trim().length > 0
    const method = Object.prototype.hasOwnProperty.call(settings, 'sttProvider') ? settings.sttProvider : legacyGroqKey ? 'groq' : undefined
    if (method !== LOCAL_WHISPER_PROVIDER && method !== 'groq') {
      return [{ status: 'pass', message: 'Off (optional); no voice messages are sent for transcription' }]
    }
    if (method === LOCAL_WHISPER_PROVIDER) {
      const readiness = getLocalWhisperReadiness(settings)
      if (readiness.ready) {
        return [{ status: 'pass', message: `Local transcription selected; runtime ready. The model downloads on first use using the ${modelDownloadRoute} route` }]
      }
      const issue = readiness.script === 'missing'
        ? 'configured transcription executable missing'
        : readiness.script === 'not-file'
          ? 'configured transcription executable is not a file'
          : readiness.script === 'not-executable'
            ? 'configured transcription file is not executable'
            : 'Python 3 or uv not found'
      return [{
        status: 'warn',
        message: `Local transcription selected but setup is not ready (${issue}). Restore or authorize the configured executable, or install Python 3/uv; model downloads use the ${modelDownloadRoute} route`,
      }]
    }
    const key = typeof settings.groqApiKey === 'string' ? settings.groqApiKey.trim() : ''
    if (!key) return [{ status: 'warn', message: 'Groq cloud transcription selected; API key not set. Add it securely in Settings → Speech-to-text' }]
    try {
      const provider = new GroqSTT(key, undefined, ctx.fetchForScope('services.speech'))
      const result = await provider.checkAccess(AbortSignal.timeout(8_000))
      return [{
        status: result.ok ? 'pass' : 'warn',
        message: result.ok
          ? `Groq cloud transcription selected; API key saved (hidden) and access verified using the ${groqRoute} route`
          : `Groq cloud transcription selected; API key saved (hidden), but access is not ready: ${result.message} Route: ${groqRoute}`,
      }]
    } catch {
      return [{ status: 'warn', message: `Groq cloud transcription selected; API key saved (hidden), but the ${groqRoute} route could not start an access check` }]
    }
  },
}
