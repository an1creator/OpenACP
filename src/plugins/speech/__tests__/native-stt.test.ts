import { describe, expect, it } from 'vitest'
import { buildSpeechServiceConfig, createNativeSTTProviders } from '../native-stt.js'

describe('native STT configuration', () => {
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
})
