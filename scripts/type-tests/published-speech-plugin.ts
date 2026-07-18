import type {
  OpenACPPlugin,
  PluginContext,
  SpeechServiceInterface as CliSpeechService,
  STTOptions as CliSTTOptions,
  STTProvider as CliSTTProvider,
  TTSProvider as CliTTSProvider,
} from '@n1creator/openacp-cli'
import type {
  SpeechServiceInterface as SdkSpeechService,
  STTOptions as SdkSTTOptions,
  STTProvider as SdkSTTProvider,
  TTSProvider as SdkTTSProvider,
} from '@n1creator/openacp-plugin-sdk'

const sttProvider = {
  name: 'minimal-stt',
  async transcribe(_audioBuffer: Buffer, _mimeType: string, options?: CliSTTOptions & SdkSTTOptions) {
    options?.signal?.throwIfAborted()
    return { text: 'transcript', language: options?.language }
  },
} satisfies CliSTTProvider & SdkSTTProvider

const ttsProvider = {
  name: 'minimal-tts',
  async synthesize(_text: string) {
    return { audioBuffer: Buffer.alloc(0), mimeType: 'audio/mpeg' }
  },
} satisfies CliTTSProvider & SdkTTSProvider

function useSpeech(service: CliSpeechService & SdkSpeechService): void {
  service.registerSTTProvider(sttProvider.name, sttProvider)
  service.registerTTSProvider(ttsProvider.name, ttsProvider)
  void service.transcribe(Buffer.alloc(0), 'audio/ogg', { signal: new AbortController().signal })
  void service.synthesize('hello')

  // The runtime supports TTS teardown, but has no STT unregister or legacy conversion methods.
  service.unregisterTTSProvider(ttsProvider.name)
  // @ts-expect-error `unregisterSTTProvider` is not part of the published runtime contract.
  service.unregisterSTTProvider(sttProvider.name)
  // @ts-expect-error Legacy names exist only on the SDK testing mock.
  service.textToSpeech('hello')
  // @ts-expect-error Legacy names exist only on the SDK testing mock.
  service.speechToText(Buffer.alloc(0))
}

export default {
  name: '@example/minimal-speech-plugin',
  version: '1.0.0',
  permissions: ['services:use'],
  async setup(ctx: PluginContext) {
    const service = ctx.getService<CliSpeechService & SdkSpeechService>('speech')
    if (service) useSpeech(service)
  },
} satisfies OpenACPPlugin
