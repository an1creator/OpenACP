import { existsSync } from 'node:fs'
import type { OpenACPCore } from '../../core/core.js'
import type { CommandArgs, CommandResponse, PluginContext } from '../../core/plugin/types.js'
import type { IdentityService } from '../identity/types.js'
import { formatIdentityId, hasIdentityCapability } from '../identity/types.js'
import { commandExists } from '../../core/agents/agent-dependencies.js'
import { buildSpeechServiceConfig, LOCAL_WHISPER_DEFAULTS, LOCAL_WHISPER_PROVIDER, readLocalWhisperSettings } from './native-stt.js'
import { resolveLocalWhisperScriptPath } from './providers/local-whisper.js'
import type { SpeechService } from './speech-service.js'

const PLUGIN_NAME = '@openacp/speech'
export const SPEECH_CAPABILITY_ERROR = 'Speech settings require speech:manage capability.'

type LocalField = 'language' | 'model' | 'beam' | 'vad' | 'device' | 'compute' | 'timeout'

const fieldSettingsKey: Record<LocalField, string> = {
  language: 'localWhisperLanguage', model: 'localWhisperModel', beam: 'localWhisperBeamSize',
  vad: 'localWhisperVadFilter', device: 'localWhisperDevice', compute: 'localWhisperComputeType',
  timeout: 'localWhisperTimeoutMs',
}

async function canManageSpeech(core: OpenACPCore, args: CommandArgs): Promise<boolean> {
  const identity = core.lifecycleManager?.serviceRegistry?.get<IdentityService>('identity')
  if (!identity) return false
  try {
    const user = await identity.getUserByIdentity(formatIdentityId(args.channelId, args.userId))
    return Boolean(user && hasIdentityCapability(user.role, 'speech:manage'))
  } catch {
    return false
  }
}

function speechError(): CommandResponse {
  return { type: 'error', message: SPEECH_CAPABILITY_ERROR }
}

function redactedReview(raw: Record<string, unknown>): string {
  const local = readLocalWhisperSettings(raw)
  const configured = typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim().length > 0
  const provider = raw.sttProvider === LOCAL_WHISPER_PROVIDER ? 'Local' : raw.sttProvider === 'groq' ? 'Groq' : 'Off'
  return [
    `Provider: ${provider}`,
    `Groq API key: ${configured ? 'configured (write-only)' : 'not configured'}`,
    `Local language: ${local.language}`,
    `Local model: ${local.model}`,
    `Local beam size: ${local.beamSize}`,
    `Local VAD: ${local.vadFilter ? 'on' : 'off'}`,
    `Local device: ${local.device}`,
    `Local compute type: ${local.computeType}`,
    `Local timeout: ${local.timeoutMs} ms`,
  ].join('\n')
}

function defaultRuntimeAvailable(): boolean {
  return existsSync(resolveLocalWhisperScriptPath()) && (commandExists('uv') || commandExists('python3'))
}

function home(raw: Record<string, unknown>, service: SpeechService, runtimeReady: boolean): CommandResponse {
  return {
    type: 'menu',
    title: `🎙 Speech-to-Text\n${redactedReview(raw)}\nActive now: ${service.isSTTAvailable() ? 'yes' : 'no'}\nLocal runtime: ${runtimeReady ? 'ready' : 'needs the bundled script and uv or Python 3'}\nChanges apply immediately. The first local model download follows services.speechDownloads proxy routing.`,
    options: [
      { label: 'Provider', command: '/speech provider' },
      { label: 'Local settings', command: '/speech local' },
      { label: 'Groq API key', command: '/speech groq' },
      { label: 'Review (redacted)', command: '/speech review' },
      { label: 'Cancel', command: '/speech cancel' },
    ],
  }
}

function localMenu(raw: Record<string, unknown>): CommandResponse {
  const local = readLocalWhisperSettings(raw)
  return { type: 'menu', title: `Speech-to-Text › Local settings\nLanguage ${local.language} · Model ${local.model} · Beam ${local.beamSize}\nVAD ${local.vadFilter ? 'on' : 'off'} · Device ${local.device} · Compute ${local.computeType} · Timeout ${local.timeoutMs} ms`, options: [
    { label: 'Language', command: '/speech local-field language' },
    { label: 'Model', command: '/speech local-field model' },
    { label: 'Beam size', command: '/speech local-field beam' },
    { label: `VAD: ${local.vadFilter ? 'ON' : 'OFF'}`, command: `/speech local-set vad ${local.vadFilter ? 'false' : 'true'}` },
    { label: 'Device', command: '/speech local-device' },
    { label: 'Compute type', command: '/speech local-compute' },
    { label: 'Timeout', command: '/speech local-field timeout' },
    { label: 'Back', command: '/speech' },
    { label: 'Cancel', command: '/speech cancel' },
  ] }
}

function inputFor(field: LocalField, args: CommandArgs): CommandResponse {
  if (!args.interaction?.textInput) return { type: 'text', text: 'This connector cannot capture text input. Configure @openacp/speech on the host.' }
  const prompts: Record<LocalField, string> = {
    language: 'Enter a language code (for example ru or en).', model: 'Enter a faster-whisper model name.',
    beam: 'Enter beam size from 1 to 20.', vad: 'Enter true or false.', device: 'Enter cpu, cuda, or auto.',
    compute: 'Enter compute type: auto, default, int8, int8_float16, float16, float32, or bfloat16.',
    timeout: 'Enter timeout in milliseconds (1000–600000).',
  }
  return { type: 'input', prompt: prompts[field], command: `/speech local-input ${field}`, fallback: 'Configure @openacp/speech on the host.', expiresInMs: 10 * 60_000 }
}

function validateLocal(field: LocalField, value: string): string | number | boolean | undefined {
  const trimmed = value.trim()
  if (field === 'language') return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(trimmed) ? trimmed : undefined
  if (field === 'model') return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(trimmed) ? trimmed : undefined
  if (field === 'beam') { const number = Number(trimmed); return Number.isSafeInteger(number) && number >= 1 && number <= 20 ? number : undefined }
  if (field === 'vad') return trimmed === 'true' ? true : trimmed === 'false' ? false : undefined
  if (field === 'device') return ['cpu', 'cuda', 'auto'].includes(trimmed) ? trimmed : undefined
  if (field === 'compute') return ['auto', 'default', 'int8', 'int8_float16', 'float16', 'float32', 'bfloat16'].includes(trimmed) ? trimmed : undefined
  if (field === 'timeout') { const number = Number(trimmed); return Number.isSafeInteger(number) && number >= 1_000 && number <= 600_000 ? number : undefined }
  return undefined
}

/** Register the connector-neutral settings surface for the existing built-in SpeechService. */
export function registerSpeechSettingsCommand(
  ctx: PluginContext,
  core: OpenACPCore,
  service: SpeechService,
  options: { isLocalRuntimeAvailable?: () => boolean } = {},
): void {
  const isLocalRuntimeAvailable = options.isLocalRuntimeAvailable ?? defaultRuntimeAvailable
  ctx.registerCommand({
    name: 'speech', description: 'Manage speech-to-text settings', usage: '[provider|local|groq|review]', category: 'plugin',
    handler: async (args) => {
      if (!(await canManageSpeech(core, args))) return speechError()
      const settingsManager = core.settingsManager
      if (!settingsManager) return { type: 'error', message: 'Speech settings are unavailable.' }
      const api = settingsManager.createAPI(PLUGIN_NAME)
      const raw = await api.getAll()
      const [action, field, directValue] = args.raw.trim().split(/\s+/).filter(Boolean)
      const mutations = new Set(['provider-set', 'local-set', 'local-input', 'groq-input', 'groq-clear-confirm'])
      if (action && mutations.has(action) && !(await canManageSpeech(core, args))) return speechError()

      const refresh = async (): Promise<Record<string, unknown>> => {
        const updated = await api.getAll()
        service.refreshProviders(buildSpeechServiceConfig(updated))
        return updated
      }

      if (!action) return home(raw, service, isLocalRuntimeAvailable())
      if (action === 'cancel') return { type: 'text', text: 'Speech settings were not changed.' }
      if (action === 'review') return { type: 'menu', title: `Speech-to-Text › Review\n${redactedReview(raw)}\nChanges apply immediately.`, options: [{ label: 'Back', command: '/speech' }] }
      if (action === 'provider') return { type: 'menu', title: 'Speech-to-Text › Provider', options: [
        { label: 'Off', command: '/speech provider-set off' },
        { label: 'Local faster-whisper', command: '/speech provider-set local-whisper' },
        { label: 'Groq Whisper', command: '/speech provider-set groq' },
        { label: 'Back', command: '/speech' }, { label: 'Cancel', command: '/speech cancel' },
      ] }
      if (action === 'provider-set') {
        if (!['off', LOCAL_WHISPER_PROVIDER, 'groq'].includes(field ?? '')) return { type: 'error', message: 'Invalid STT provider.' }
        if (field === 'groq' && !(typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim())) {
          return { type: 'menu', title: 'A Groq API key is required before Groq can be enabled.', options: [{ label: 'Add API key', command: '/speech groq-set' }, { label: 'Back', command: '/speech provider' }] }
        }
        await api.set('sttProvider', field === 'off' ? null : field)
        const updated = await refresh()
        return home(updated, service, isLocalRuntimeAvailable())
      }
      if (action === 'local') return localMenu(raw)
      if (action === 'local-field' && field && field in fieldSettingsKey) return inputFor(field as LocalField, args)
      if (action === 'local-device') return { type: 'menu', title: 'Speech-to-Text › Local device', options: ['cpu', 'cuda', 'auto'].map((value) => ({ label: value, command: `/speech local-set device ${value}` })).concat([{ label: 'Back', command: '/speech local' }]) }
      if (action === 'local-compute') return { type: 'menu', title: 'Speech-to-Text › Local compute type', options: ['auto', 'default', 'int8', 'int8_float16', 'float16', 'float32', 'bfloat16'].map((value) => ({ label: value, command: `/speech local-set compute ${value}` })).concat([{ label: 'Back', command: '/speech local' }]) }
      if (action === 'local-input' || action === 'local-set') {
        if (!field || !(field in fieldSettingsKey)) return { type: 'error', message: 'Invalid local STT field.' }
        const captured = action === 'local-input' ? args.interaction?.capturedInput : undefined
        if (action === 'local-input' && (!captured || captured.sensitive)) return { type: 'error', message: 'The local STT value was not captured safely.' }
        const parsed = validateLocal(field as LocalField, action === 'local-input' ? captured!.value : (directValue ?? ''))
        if (parsed === undefined) return { type: 'error', message: 'Invalid local STT value. No changes were made.' }
        await api.set(fieldSettingsKey[field as LocalField], parsed)
        const updated = await refresh()
        return localMenu(updated)
      }
      if (action === 'groq') return { type: 'menu', title: `Speech-to-Text › Groq API key\nStatus: ${typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim() ? 'configured (write-only)' : 'not configured'}`, options: [
        { label: 'Replace API key', command: '/speech groq-set' },
        ...(typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim() ? [{ label: 'Clear API key', command: '/speech groq-clear' }] : []),
        { label: 'Back', command: '/speech' }, { label: 'Cancel', command: '/speech cancel' },
      ] }
      if (action === 'groq-set') {
        if (!args.interaction?.textInput || args.interaction.secureInput === 'none') return { type: 'text', text: 'This connector cannot safely capture credentials. Configure the Groq key on the host.' }
        return { type: 'input', prompt: 'Enter the Groq API key. It will be deleted or kept private by the connector before dispatch.', command: '/speech groq-input', sensitive: true, fallback: 'Configure the Groq key on the host.', expiresInMs: 10 * 60_000 }
      }
      if (action === 'groq-input') {
        const captured = args.interaction?.capturedInput
        if (!captured?.sensitive || args.interaction?.secureInput === 'none' || !captured.value.trim()) return { type: 'error', message: 'The Groq API key was not captured securely. No changes were made.' }
        await api.set('groqApiKey', captured.value.trim())
        await refresh()
        return { type: 'text', text: '✅ Groq API key stored as write-only. Select Groq under Provider to enable it.' }
      }
      if (action === 'groq-clear') return { type: 'confirm', question: 'Clear the stored Groq API key? Groq STT will be disabled if active.', onYes: '/speech groq-clear-confirm', onNo: '/speech groq' }
      if (action === 'groq-clear-confirm') {
        await api.delete('groqApiKey')
        if (raw.sttProvider === 'groq') await api.set('sttProvider', null)
        await refresh()
        return { type: 'text', text: '✅ Groq API key cleared. Groq STT is off.' }
      }
      return { type: 'error', message: 'Use /speech, provider, local, groq, or review.' }
    },
  })
}
