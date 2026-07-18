// Speech provider contracts live with the public plugin API so the runtime,
// CLI package, and generated declarations all expose one canonical shape.
export type {
  STTOptions,
  STTProvider,
  STTResult,
  TTSOptions,
  TTSProvider,
  TTSResult,
} from '../../core/plugin/types.js'

/** Provider-level configuration stored in plugin settings (API key, model override, etc.). */
export interface SpeechProviderConfig {
  apiKey?: string;
  model?: string;
  [key: string]: unknown;
}

/**
 * Top-level configuration for SpeechService.
 *
 * `stt.provider` and `tts.provider` name the active provider.
 * `null` disables the respective capability.
 * `providers` holds per-provider credentials and options.
 */
export interface SpeechServiceConfig {
  stt: {
    provider: string | null;
    providers: Record<string, SpeechProviderConfig>;
  };
  tts: {
    provider: string | null;
    providers: Record<string, SpeechProviderConfig>;
  };
}
