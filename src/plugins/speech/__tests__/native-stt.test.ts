import { describe, expect, it } from 'vitest'
import { buildSpeechServiceConfig, createNativeSTTProviders, readLocalWhisperSettings } from '../native-stt.js'

describe('native STT configuration', () => {
  it('uses a ten-minute local timeout for first-run setup and CPU transcription', () => {
    expect(readLocalWhisperSettings({}).timeoutMs).toBe(600_000)
  })

  it.each([Number.NaN, -1, 2_147_483_648, 1.5])('falls back for an invalid persisted timeout (%s)', (timeout) => {
    expect(readLocalWhisperSettings({ localWhisperTimeoutMs: timeout }).timeoutMs).toBe(600_000)
  })

  it.each([0, 1_000, 600_000, 2_147_483_647])('preserves a valid host timeout (%s)', (timeout) => {
    expect(readLocalWhisperSettings({ localWhisperTimeoutMs: timeout }).timeoutMs).toBe(timeout)
  })

  it('builds and instantiates the local Whisper provider without an API key', () => {
    const config = buildSpeechServiceConfig({
      sttProvider: 'local-whisper',
      localWhisperLanguage: 'en',
      localWhisperModel: 'small',
      localWhisperBeamSize: 3,
      localWhisperVadFilter: true,
    })

    expect(config.stt).toMatchObject({
      provider: 'local-whisper',
      providers: {
        'local-whisper': {
          apiKey: 'local',
          language: 'en',
          model: 'small',
          beamSize: 3,
          vadFilter: true,
        },
      },
    })
    expect(createNativeSTTProviders(config).get('local-whisper')?.name).toBe('local-whisper')
  })

  it('keeps the legacy Groq fallback when a key exists and no provider is selected', () => {
    const config = buildSpeechServiceConfig({ groqApiKey: 'gsk_test' })
    expect(config.stt.provider).toBe('groq')
    expect(createNativeSTTProviders(config).has('groq')).toBe(true)
  })

  it('does not activate Groq merely because it was selected without a key', () => {
    const config = buildSpeechServiceConfig({ sttProvider: 'groq' })
    expect(config.stt.provider).toBeNull()
  })

  it('keeps STT off when the provider is explicitly cleared but a legacy key remains', () => {
    const config = buildSpeechServiceConfig({ sttProvider: null, groqApiKey: 'gsk_stored' })
    expect(config.stt.provider).toBeNull()
  })
})
