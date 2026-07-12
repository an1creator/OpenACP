// Public surface of the speech plugin — re-exported for use by the plugin index
// and by external TTS plugins that need to register against SpeechService.
export type { STTProvider, TTSProvider, STTOptions, STTResult, TTSOptions, TTSResult, SpeechServiceConfig, SpeechProviderConfig } from './speech-types.js';
export { SpeechService } from './speech-service.js';
export { GroqSTT } from './providers/groq.js';
export {
  LOCAL_WHISPER_DEFAULTS,
  LOCAL_WHISPER_PROVIDER,
  LocalWhisperSTT,
  resolveLocalWhisperScriptPath,
} from './providers/local-whisper.js';
export type { LocalWhisperSTTOptions } from './providers/local-whisper.js';
