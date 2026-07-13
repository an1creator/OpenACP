import { randomUUID } from 'node:crypto'
import type { OpenACPCore } from '../../core/core.js'
import type { CommandArgs, CommandResponse, PluginContext } from '../../core/plugin/types.js'
import type { IdentityService } from '../identity/types.js'
import { formatIdentityId, hasIdentityCapability } from '../identity/types.js'
import { buildSpeechServiceConfig, LOCAL_WHISPER_DEFAULTS, LOCAL_WHISPER_PROVIDER, readLocalWhisperSettings } from './native-stt.js'
import type { SpeechService } from './speech-service.js'
import { GroqSTT, type GroqAccessCheck } from './providers/groq.js'
import { getLocalWhisperReadiness, type LocalWhisperReadiness } from './local-readiness.js'

const PLUGIN_NAME = '@openacp/speech'
export const SPEECH_CAPABILITY_ERROR = 'Administrator permission is required to manage Speech-to-text settings.'

type LocalField = 'language' | 'model' | 'beam' | 'vad' | 'device' | 'compute' | 'timeout'

interface GroqKeyDraft {
  id: string
  scope: string
  owner: string
  key: string
  expiresAt: number
  settingsVersion: string
}

const GROQ_DRAFT_TTL_MS = 10 * 60_000
const groqKeyDrafts = new Map<string, GroqKeyDraft>()

function scheduleGroqDraftExpiry(id: string): void {
  const timer = setTimeout(() => groqKeyDrafts.delete(id), GROQ_DRAFT_TTL_MS)
  timer.unref?.()
}

function commandOwner(args: CommandArgs): string {
  return `${args.channelId}:${args.userId}:${args.conversationId ?? args.sessionId ?? 'global'}`
}

function settingsVersion(settings: Record<string, unknown>): string {
  return JSON.stringify(Object.entries(settings).sort(([left], [right]) => left.localeCompare(right)))
}

function storeGroqDraft(scope: string, args: CommandArgs, key: string, settings: Record<string, unknown>): GroqKeyDraft {
  const now = Date.now()
  for (const [id, draft] of groqKeyDrafts) if (draft.expiresAt <= now) groqKeyDrafts.delete(id)
  while (groqKeyDrafts.size >= 100) {
    const oldest = groqKeyDrafts.keys().next().value
    if (!oldest) break
    groqKeyDrafts.delete(oldest)
  }
  const draft = {
    id: randomUUID(), scope, owner: commandOwner(args), key,
    expiresAt: now + GROQ_DRAFT_TTL_MS,
    settingsVersion: settingsVersion(settings),
  }
  groqKeyDrafts.set(draft.id, draft)
  scheduleGroqDraftExpiry(draft.id)
  return draft
}

function getGroqDraft(scope: string, id: string | undefined, args: CommandArgs): GroqKeyDraft | undefined {
  const draft = id ? groqKeyDrafts.get(id) : undefined
  if (!draft || draft.scope !== scope || draft.owner !== commandOwner(args) || draft.expiresAt <= Date.now()) {
    if (id && draft?.expiresAt && draft.expiresAt <= Date.now()) groqKeyDrafts.delete(id)
    return undefined
  }
  return draft
}

function takeGroqDraft(scope: string, id: string | undefined, args: CommandArgs): GroqKeyDraft | undefined {
  const draft = getGroqDraft(scope, id, args)
  if (draft) groqKeyDrafts.delete(draft.id)
  return draft
}

async function checkGroqAccess(core: OpenACPCore, key: string): Promise<GroqAccessCheck> {
  try {
    const provider = new GroqSTT(key, undefined, core.proxyService.createFetch('services.speech'))
    return provider.checkAccess(AbortSignal.timeout(10_000))
  } catch {
    return { ok: false, message: 'Could not start the Groq access check through the configured speech route.' }
  }
}

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

function selectedSpeechMethod(raw: Record<string, unknown>): 'off' | typeof LOCAL_WHISPER_PROVIDER | 'groq' {
  if (raw.sttProvider === LOCAL_WHISPER_PROVIDER) return LOCAL_WHISPER_PROVIDER
  if (raw.sttProvider === 'groq') return 'groq'
  if (!Object.prototype.hasOwnProperty.call(raw, 'sttProvider') && typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim()) return 'groq'
  return 'off'
}

function redactedReview(raw: Record<string, unknown>): string {
  const local = readLocalWhisperSettings(raw)
  const configured = typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim().length > 0
  const method = selectedSpeechMethod(raw)
  const provider = method === LOCAL_WHISPER_PROVIDER ? 'Local' : method === 'groq' ? 'Groq' : 'Off'
  return [
    `Method: ${provider}`,
    `Groq key: ${configured ? 'Saved (hidden)' : 'Not saved'}`,
    `Language: ${local.language}`,
    `Model: ${local.model}`,
    `Recognition accuracy: beam ${local.beamSize}`,
    `Voice activity filter: ${local.vadFilter ? 'On' : 'Off'}`,
    `Processing device: ${local.device}`,
    `Compute type: ${local.computeType}`,
    `Time limit: ${Math.round(local.timeoutMs / 1_000)} seconds`,
  ].join('\n')
}

function localReadinessMessage(readiness: LocalWhisperReadiness): string {
  if (readiness.script === 'missing') return 'The configured transcription executable is missing.'
  if (readiness.script === 'not-file') return 'The configured transcription executable is not a file.'
  if (readiness.script === 'not-executable') return 'The configured transcription file is not executable.'
  if (!readiness.runtimeReady) return 'Python 3 or uv was not found on the host.'
  return 'Local transcription setup is ready.'
}

function home(raw: Record<string, unknown>, readiness: LocalWhisperReadiness): CommandResponse {
  const method = selectedSpeechMethod(raw)
  const localSelected = method === LOCAL_WHISPER_PROVIDER
  const groqSelected = method === 'groq'
  const groqConfigured = typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim().length > 0
  const status = localSelected
    ? readiness.ready ? 'On — Local transcription; runtime checks passed' : 'Needs setup — Local transcription selected'
    : groqSelected
      ? groqConfigured ? 'On — Groq selected; access not yet checked' : 'Needs a Groq API key'
      : 'Off'
  const next = localSelected && !readiness.ready
    ? `${localReadinessMessage(readiness)} Check setup for recovery guidance.`
    : groqSelected && !groqConfigured
      ? 'Add a Groq API key to start transcribing voice messages.'
      : 'Voice messages are converted to text before they reach the selected agent.'
  return {
    type: 'menu',
    title: `🎙 Speech-to-text\nStatus: ${status}\n${next}`,
    options: [
      { label: 'Transcription method', command: '/speech provider' },
      { label: 'Settings & access', command: '/speech settings' },
      { label: 'Check setup', command: '/speech check' },
    ],
  }
}

function settingsMenu(raw: Record<string, unknown>): CommandResponse {
  const groqConfigured = typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim().length > 0
  return {
    type: 'menu',
    title: 'Speech-to-text › Settings & access\nConfigure either method without changing which one is currently selected.',
    options: [
      { label: 'Local transcription', command: '/speech local' },
      { label: `Groq cloud · Key ${groqConfigured ? 'saved' : 'not set'}`, command: '/speech groq' },
      { label: 'Back', command: '/speech' },
    ],
  }
}

function localMenu(raw: Record<string, unknown>): CommandResponse {
  const local = readLocalWhisperSettings(raw)
  return { type: 'menu', title: `Speech-to-text › Local transcription\nLanguage: ${local.language} · Model: ${local.model}\nThe model downloads on first use and is then processed on this host.`, options: [
    { label: `Language: ${local.language}`, command: '/speech local-field language' },
    { label: `Model: ${local.model}`, command: '/speech local-field model' },
    { label: 'Performance & reliability', command: '/speech local-advanced' },
    { label: 'Back', command: '/speech settings' },
  ] }
}

function localAdvancedMenu(raw: Record<string, unknown>): CommandResponse {
  const local = readLocalWhisperSettings(raw)
  return { type: 'menu', title: `Speech-to-text › Local › Performance & reliability\nAccuracy: beam ${local.beamSize} · Voice activity filter: ${local.vadFilter ? 'On' : 'Off'}\nDevice: ${local.device} · Compute: ${local.computeType} · Time limit: ${Math.round(local.timeoutMs / 1_000)} seconds`, options: [
    { label: `Accuracy: beam ${local.beamSize}`, command: '/speech local-field beam' },
    { label: `Voice filter: ${local.vadFilter ? 'On' : 'Off'}`, command: `/speech local-set vad ${local.vadFilter ? 'false' : 'true'}` },
    { label: `Device: ${local.device}`, command: '/speech local-device' },
    { label: `Compute: ${local.computeType}`, command: '/speech local-compute' },
    { label: `Time limit: ${Math.round(local.timeoutMs / 1_000)}s`, command: '/speech local-field timeout' },
    { label: 'Back', command: '/speech local' },
  ] }
}

function groqMenu(raw: Record<string, unknown>): CommandResponse {
  const configured = typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim().length > 0
  const active = selectedSpeechMethod(raw) === 'groq'
  return {
    type: 'menu',
    title: `Speech-to-text › Groq cloud transcription\nAccess: ${configured ? 'API key saved (hidden)' : 'API key not set'}\nStatus: ${active && configured ? 'Selected' : 'Not selected'}\nAudio is sent to Groq only while this method is selected.`,
    options: [
      { label: configured ? 'Replace API key' : 'Add API key', command: '/speech groq-set' },
      ...(configured && !active ? [{ label: 'Use Groq now', command: '/speech provider-set groq' }] : []),
      ...(configured ? [{ label: 'Clear API key', command: '/speech groq-clear' }] : []),
      { label: 'Back', command: '/speech settings' },
    ],
  }
}

function inputFor(field: LocalField, args: CommandArgs): CommandResponse {
  if (!args.interaction?.textInput) return { type: 'text', text: 'This connector cannot capture text input. Configure @openacp/speech on the host.' }
  const prompts: Record<LocalField, string> = {
    language: 'Enter the spoken language code, for example ru, en, or en-US.', model: 'Enter a faster-whisper model name, for example base, small, or medium.',
    beam: 'Enter recognition beam size from 1 to 20. Higher values may improve accuracy but take longer.', vad: 'Enter true or false.', device: 'Enter cpu, cuda, or auto.',
    compute: 'Enter compute type: auto, default, int8, int8_float16, float16, float32, or bfloat16.',
    timeout: 'Enter the maximum processing time in milliseconds, from 1000 to 600000.',
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

function localValidationMessage(field: LocalField): string {
  const messages: Record<LocalField, string> = {
    language: 'Use a language code such as ru, en, or en-US.',
    model: 'Use a faster-whisper model name such as base, small, or medium.',
    beam: 'Beam size must be a whole number from 1 to 20.',
    vad: 'Voice activity filter must be true or false.',
    device: 'Device must be cpu, cuda, or auto.',
    compute: 'Choose a compute type shown in the menu.',
    timeout: 'Time limit must be a whole number from 1000 to 600000 milliseconds.',
  }
  return `${messages[field]} No changes were made.`
}

class SpeechMutationRejection extends Error {
  constructor(readonly response: CommandResponse) {
    super('Speech settings mutation rejected')
  }
}

function rejectMutation(response: CommandResponse): never {
  throw new SpeechMutationRejection(response)
}

/** Register the connector-neutral settings surface for the existing built-in SpeechService. */
export function registerSpeechSettingsCommand(
  ctx: PluginContext,
  core: OpenACPCore,
  service: SpeechService,
  options: { getLocalReadiness?: (settings: Record<string, unknown>) => LocalWhisperReadiness } = {},
): void {
  const readinessFor = options.getLocalReadiness ?? getLocalWhisperReadiness
  const draftScope = randomUUID()
  const mutationActions = new Set(['provider-set', 'local-set', 'local-input', 'groq-input', 'groq-save', 'groq-discard', 'groq-clear-confirm'])
  let mutationTail: Promise<void> = Promise.resolve()
  const serializeMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationTail.then(operation, operation)
    mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  ctx.registerCommand({
    name: 'speech', description: 'Configure voice transcription', usage: '[provider|local|groq|review]', category: 'plugin',
    handler: async (args) => {
      if (!(await canManageSpeech(core, args))) return speechError()
      const settingsManager = core.settingsManager
      if (!settingsManager) return { type: 'error', message: 'Speech settings are unavailable.' }
      const [action, field, directValue] = args.raw.trim().split(/\s+/).filter(Boolean)

      if (action && mutationActions.has(action)) return serializeMutation(async () => {
        // Authorization is re-checked after waiting for prior callbacks so a
        // queued mutation cannot outlive an administrator role change.
        if (!(await canManageSpeech(core, args))) return speechError()

        const commitSettings = async (
          transform: (current: Record<string, unknown>) => Record<string, unknown>,
        ): Promise<Record<string, unknown>> => settingsManager.transactPluginSettings(PLUGIN_NAME, (current) => {
          const next = transform(current)
          const prepared = service.prepareProviderRefresh(buildSpeechServiceConfig(next))
          return {
            settings: next,
            result: next,
            apply: () => prepared.commit(),
            rollback: () => prepared.rollback(),
          }
        })

        try {
          if (action === 'provider-set') {
            if (!['off', LOCAL_WHISPER_PROVIDER, 'groq'].includes(field ?? '')) {
              return { type: 'menu', title: 'That transcription method is not available. No changes were made.', options: [{ label: 'Choose a method', command: '/speech provider' }, { label: 'Back', command: '/speech' }] }
            }
            const updated = await commitSettings((current) => {
              if (field === 'groq' && !(typeof current.groqApiKey === 'string' && current.groqApiKey.trim())) {
                rejectMutation({ type: 'menu', title: 'Groq cannot be selected yet because no API key is saved. Add a key securely, then select Groq.', options: [{ label: 'Add API key', command: '/speech groq-set' }, { label: 'Back', command: '/speech provider' }] })
              }
              return { ...current, sttProvider: field === 'off' ? null : field }
            })
            return home(updated, readinessFor(updated))
          }

          if (action === 'local-input' || action === 'local-set') {
            if (!field || !(field in fieldSettingsKey)) return { type: 'menu', title: 'That local transcription setting is not available. No changes were made.', options: [{ label: 'Local settings', command: '/speech local' }, { label: 'Back', command: '/speech' }] }
            const captured = action === 'local-input' ? args.interaction?.capturedInput : undefined
            if (action === 'local-input' && (!captured || captured.sensitive)) return { type: 'menu', title: 'The value could not be read safely. No changes were made.', options: [{ label: 'Try again', command: `/speech local-field ${field}` }, { label: 'Back', command: '/speech local' }] }
            const parsed = validateLocal(field as LocalField, action === 'local-input' ? captured!.value : (directValue ?? ''))
            if (parsed === undefined) return { type: 'menu', title: localValidationMessage(field as LocalField), options: [{ label: 'Try again', command: `/speech local-field ${field}` }, { label: 'Back', command: field === 'language' || field === 'model' ? '/speech local' : '/speech local-advanced' }] }
            const updated = await commitSettings((current) => ({ ...current, [fieldSettingsKey[field as LocalField]]: parsed }))
            return localMenu(updated)
          }

          if (action === 'groq-input') {
            const captured = args.interaction?.capturedInput
            if (!captured?.sensitive || args.interaction?.secureInput === 'none' || !captured.value.trim()) return { type: 'menu', title: 'The Groq API key was not captured securely. No changes were made.', options: [{ label: 'Try again', command: '/speech groq-set' }, { label: 'Back', command: '/speech groq' }] }
            const candidateKey = captured.value.trim()
            const result = await checkGroqAccess(core, candidateKey)
            if (!result.ok) return { type: 'menu', title: `${result.message} The candidate key was discarded; the saved key and active transcription method were not changed.`, options: [{ label: 'Try another API key', command: '/speech groq-set' }, { label: 'Back', command: '/speech groq' }] }
            const current = await settingsManager.loadSettings(PLUGIN_NAME)
            const draft = storeGroqDraft(draftScope, args, candidateKey, current)
            return { type: 'menu', title: 'Groq accepted the candidate API key. Nothing has been saved yet.', options: [{ label: 'Save and use Groq', command: `/speech groq-save ${draft.id} use` }, { label: 'Save key only', command: `/speech groq-save ${draft.id} keep` }, { label: 'Discard', command: `/speech groq-discard ${draft.id}` }] }
          }

          if (action === 'groq-save') {
            if (!['use', 'keep'].includes(directValue ?? '')) return { type: 'menu', title: 'That key-save action is invalid. Nothing was changed.', options: [{ label: 'Enter API key again', command: '/speech groq-set' }, { label: 'Back', command: '/speech groq' }] }
            const draft = takeGroqDraft(draftScope, field, args)
            if (!draft) return { type: 'menu', title: 'This verified key draft expired, was already used, or belongs to another conversation. The saved key was not changed.', options: [{ label: 'Enter API key again', command: '/speech groq-set' }, { label: 'Back', command: '/speech groq' }] }
            const updated = await commitSettings((current) => {
              if (settingsVersion(current) !== draft.settingsVersion) {
                rejectMutation({ type: 'menu', title: 'Speech settings changed after this key was verified. The stale draft was discarded and nothing was saved.', options: [{ label: 'Enter API key again', command: '/speech groq-set' }, { label: 'Back', command: '/speech groq' }] })
              }
              return {
                ...current,
                groqApiKey: draft.key,
                ...(directValue === 'use' ? { sttProvider: 'groq' } : {}),
              }
            })
            const method = selectedSpeechMethod(updated)
            return { type: 'menu', title: directValue === 'use' ? 'Verified Groq API key saved. Groq cloud transcription is now selected.' : `Verified Groq API key saved. Transcription method remains ${method === 'groq' ? 'Groq' : method === LOCAL_WHISPER_PROVIDER ? 'Local' : 'Off'}.`, options: [{ label: 'Groq settings', command: '/speech groq' }, { label: 'Speech-to-text home', command: '/speech' }] }
          }

          if (action === 'groq-discard') {
            const draft = takeGroqDraft(draftScope, field, args)
            return draft
              ? { type: 'menu', title: 'Candidate Groq API key discarded. Saved settings were not changed.', options: [{ label: 'Groq settings', command: '/speech groq' }, { label: 'Back', command: '/speech' }] }
              : { type: 'menu', title: 'This candidate key was already discarded, used, or expired. Saved settings were not changed.', options: [{ label: 'Groq settings', command: '/speech groq' }, { label: 'Back', command: '/speech' }] }
          }

          if (action === 'groq-clear-confirm') {
            await commitSettings((current) => {
              const next = { ...current }
              delete next.groqApiKey
              if (selectedSpeechMethod(current) === 'groq') next.sttProvider = null
              return next
            })
            return { type: 'menu', title: 'Groq API key cleared. Groq cloud transcription is off.', options: [{ label: 'Choose another method', command: '/speech provider' }, { label: 'Back', command: '/speech' }] }
          }
        } catch (error) {
          if (error instanceof SpeechMutationRejection) return error.response
          return { type: 'menu', title: 'Speech settings could not be applied. The previous saved settings and active runtime were restored.', options: [{ label: 'Try again', command: '/speech' }] }
        }

        return { type: 'error', message: 'Unknown speech setting. Use /speech to open the menu.' }
      })

      const raw = await settingsManager.loadSettings(PLUGIN_NAME)
      const readiness = readinessFor(raw)

      if (!action) return home(raw, readiness)
      if (action === 'cancel') return { type: 'text', text: 'No changes were made.' }
      if (action === 'review') return { type: 'menu', title: `Speech-to-text › Configuration details\n${redactedReview(raw)}\nAPI keys are never shown. Changes take effect immediately.`, options: [{ label: 'Back', command: '/speech' }] }
      if (action === 'settings') return settingsMenu(raw)
      if (action === 'provider') {
        const current = selectedSpeechMethod(raw)
        return { type: 'menu', title: 'Speech-to-text › Transcription method\nChoose where voice messages are converted to text. Changes take effect immediately.', options: [
          { label: `Off${current === 'off' ? ' ✓' : ''}`, command: '/speech provider-set off' },
          { label: `Local (on this host)${current === LOCAL_WHISPER_PROVIDER ? ' ✓' : ''}`, command: '/speech provider-set local-whisper' },
          { label: `Groq (cloud)${current === 'groq' ? ' ✓' : ''}`, command: '/speech provider-set groq' },
          { label: 'Back', command: '/speech' },
        ] }
      }
      if (action === 'local') return localMenu(raw)
      if (action === 'local-advanced') return localAdvancedMenu(raw)
      if (action === 'local-field' && field && field in fieldSettingsKey) return inputFor(field as LocalField, args)
      if (action === 'local-device') return { type: 'menu', title: 'Speech-to-text › Local › Processing device\nAuto chooses the best available device.', options: ['cpu', 'cuda', 'auto'].map((value) => ({ label: value, command: `/speech local-set device ${value}` })).concat([{ label: 'Back', command: '/speech local-advanced' }]) }
      if (action === 'local-compute') return { type: 'menu', title: 'Speech-to-text › Local › Compute type\nAuto is recommended unless you are tuning a specific device.', options: ['auto', 'default', 'int8', 'int8_float16', 'float16', 'float32', 'bfloat16'].map((value) => ({ label: value, command: `/speech local-set compute ${value}` })).concat([{ label: 'Back', command: '/speech local-advanced' }]) }
      if (action === 'groq') return groqMenu(raw)
      if (action === 'check') {
        const method = selectedSpeechMethod(raw)
        if (method === LOCAL_WHISPER_PROVIDER) {
          return readiness.ready
            ? { type: 'menu', title: 'Local transcription setup is ready. The selected model downloads on first use, then audio is processed on this host.', options: [{ label: 'Back to local settings', command: '/speech local' }, { label: 'Speech-to-text home', command: '/speech' }] }
            : { type: 'menu', title: `Local transcription setup is not ready. ${localReadinessMessage(readiness)} No host path is shown here.`, options: [{ label: 'Back to local settings', command: '/speech local' }, { label: 'Speech-to-text home', command: '/speech' }] }
        }
        if (method === 'groq') {
          if (!(typeof raw.groqApiKey === 'string' && raw.groqApiKey.trim())) return { type: 'menu', title: 'Groq is selected, but no API key is saved.', options: [{ label: 'Add API key', command: '/speech groq-set' }, { label: 'Back', command: '/speech' }] }
          const result = await checkGroqAccess(core, raw.groqApiKey.trim())
          return { type: 'menu', title: result.ok ? 'Groq access check passed. The saved key is valid and the speech route can reach Groq.' : `${result.message} The saved key and current method were not changed.`, options: result.ok ? [{ label: 'Back to Groq settings', command: '/speech groq' }, { label: 'Speech-to-text home', command: '/speech' }] : [{ label: 'Replace API key', command: '/speech groq-set' }, { label: 'Back to Groq settings', command: '/speech groq' }] }
        }
        return { type: 'menu', title: 'Speech-to-text is off. Choose a transcription method before checking setup.', options: [{ label: 'Choose a method', command: '/speech provider' }, { label: 'Back', command: '/speech' }] }
      }
      if (action === 'groq-set') {
        if (!args.interaction?.textInput || args.interaction.secureInput === 'none') return { type: 'text', text: 'This connector cannot safely capture credentials. Configure the Groq key on the host.' }
        return { type: 'input', prompt: 'Enter the Groq API key. The connector will remove this message before saving the key, and the key will never be shown again.', command: '/speech groq-input', sensitive: true, fallback: 'This connector cannot capture a key securely. Configure the Groq key on the host.', expiresInMs: 10 * 60_000 }
      }
      if (action === 'groq-clear') return { type: 'confirm', question: 'Clear the saved Groq API key? Groq cloud transcription will be turned off immediately if it is selected.', onYes: '/speech groq-clear-confirm', onNo: '/speech groq' }
      return { type: 'error', message: 'Unknown speech setting. Use /speech to open the menu.' }
    },
  })
}
