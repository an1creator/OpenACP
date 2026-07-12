import type { STTProvider, SpeechServiceConfig, SpeechProviderConfig } from './speech-types.js'
import { GroqSTT } from './providers/groq.js'
import {
  LOCAL_WHISPER_DEFAULTS,
  LOCAL_WHISPER_PROVIDER,
  LocalWhisperSTT,
  resolveLocalWhisperScriptPath,
} from './providers/local-whisper.js'

export { LOCAL_WHISPER_DEFAULTS, LOCAL_WHISPER_PROVIDER } from './providers/local-whisper.js'

export interface LocalWhisperSettings {
  scriptPath: string
  language: string
  model: string
  beamSize: number
  vadFilter: boolean
  device: string
  computeType: string
  timeoutMs: number
}

export function readLocalWhisperSettings(raw: Record<string, unknown>): LocalWhisperSettings {
  return {
    scriptPath: readString(raw.localWhisperScriptPath, resolveLocalWhisperScriptPath()),
    language: readString(raw.localWhisperLanguage, LOCAL_WHISPER_DEFAULTS.language),
    model: readString(raw.localWhisperModel, LOCAL_WHISPER_DEFAULTS.model),
    beamSize: readNumber(raw.localWhisperBeamSize, LOCAL_WHISPER_DEFAULTS.beamSize),
    vadFilter: readBoolean(raw.localWhisperVadFilter, LOCAL_WHISPER_DEFAULTS.vadFilter),
    device: readString(raw.localWhisperDevice, LOCAL_WHISPER_DEFAULTS.device),
    computeType: readString(raw.localWhisperComputeType, LOCAL_WHISPER_DEFAULTS.computeType),
    timeoutMs: readNumber(raw.localWhisperTimeoutMs, LOCAL_WHISPER_DEFAULTS.timeoutMs),
  }
}

/** Convert built-in speech plugin settings into the provider-neutral service config. */
export function buildSpeechServiceConfig(raw: Record<string, unknown>): SpeechServiceConfig {
  const groqApiKey = readOptionalString(raw.groqApiKey)
  const requestedProvider = readOptionalString(raw.sttProvider)
  const provider = requestedProvider === LOCAL_WHISPER_PROVIDER
    ? LOCAL_WHISPER_PROVIDER
    : groqApiKey
      ? 'groq'
      : null

  const providers: Record<string, SpeechProviderConfig> = {}
  if (groqApiKey) providers.groq = { apiKey: groqApiKey }
  if (provider === LOCAL_WHISPER_PROVIDER) {
    providers[LOCAL_WHISPER_PROVIDER] = {
      apiKey: 'local',
      ...readLocalWhisperSettings(raw),
    }
  }

  return {
    stt: { provider, providers },
    tts: {
      provider: (readOptionalString(raw.ttsProvider) ?? 'edge-tts'),
      providers: {},
    },
  }
}

/** Instantiate all native STT providers described by a service config. */
export function createNativeSTTProviders(config: SpeechServiceConfig): Map<string, STTProvider> {
  const providers = new Map<string, STTProvider>()
  const groq = config.stt.providers.groq
  if (groq?.apiKey) providers.set('groq', new GroqSTT(groq.apiKey, groq.model))

  const local = config.stt.providers[LOCAL_WHISPER_PROVIDER]
  if (local?.apiKey !== undefined) {
    providers.set(LOCAL_WHISPER_PROVIDER, new LocalWhisperSTT({
      scriptPath: readOptionalString(local.scriptPath),
      language: readOptionalString(local.language),
      model: readOptionalString(local.model),
      beamSize: readOptionalNumber(local.beamSize),
      vadFilter: typeof local.vadFilter === 'boolean' ? local.vadFilter : undefined,
      device: readOptionalString(local.device),
      computeType: readOptionalString(local.computeType),
      timeoutMs: readOptionalNumber(local.timeoutMs),
    }))
  }
  return providers
}

function readString(value: unknown, fallback: string): string {
  return readOptionalString(value) ?? fallback
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown, fallback: number): number {
  return readOptionalNumber(value) ?? fallback
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
