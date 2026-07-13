import type { STTProvider, TTSProvider, STTOptions, STTResult, TTSOptions, TTSResult, SpeechServiceConfig } from './speech-types.js';

/**
 * A factory that recreates provider instances from a new config snapshot.
 * Used for hot-reload: when settings change, the plugin calls `refreshProviders`
 * which invokes this factory to build fresh provider objects.
 *
 * Returns separate Maps for STT and TTS so that externally-registered providers
 * (e.g. from `@openacp/msedge-tts-plugin`) are not discarded — only factory-owned
 * providers are overwritten.
 */
export type ProviderFactory = (config: SpeechServiceConfig) => { stt: Map<string, STTProvider>; tts: Map<string, TTSProvider> };

/** A fully-built provider replacement that can be committed without construction work. */
export interface PreparedProviderRefresh {
  commit(): void;
  rollback(): void;
}

/**
 * Central service for speech-to-text and text-to-speech operations.
 *
 * Providers are registered at setup time and may also be registered by external
 * plugins (e.g. `@openacp/msedge-tts-plugin` registers a TTS provider after boot).
 * The service itself is registered under the `"speech"` key in the ServiceRegistry
 * and accessed by `session.ts` to synthesize audio after agent responses when
 * `voiceMode` is active.
 */
export class SpeechService {
  private sttProviders = new Map<string, STTProvider>();
  private ttsProviders = new Map<string, TTSProvider>();
  private providerFactory?: ProviderFactory;
  private factoryOwnedSTT = new Set<string>();
  private factoryOwnedTTS = new Set<string>();
  private runtimeRevision = 0;

  constructor(private config: SpeechServiceConfig) {}

  /** Set a factory function that can recreate providers from config (for hot-reload) */
  setProviderFactory(factory: ProviderFactory): void {
    this.providerFactory = factory;
    this.runtimeRevision += 1;
  }

  /** Register an STT provider by name. Overwrites any existing provider with the same name. */
  registerSTTProvider(name: string, provider: STTProvider): void {
    this.sttProviders.set(name, provider);
    this.factoryOwnedSTT.delete(name);
    this.runtimeRevision += 1;
  }

  /** Register a TTS provider by name. Called by external TTS plugins (e.g. msedge-tts-plugin). */
  registerTTSProvider(name: string, provider: TTSProvider): void {
    this.ttsProviders.set(name, provider);
    this.factoryOwnedTTS.delete(name);
    this.runtimeRevision += 1;
  }

  /** Remove a TTS provider — called by external plugins on teardown. */
  unregisterTTSProvider(name: string): void {
    this.ttsProviders.delete(name);
    this.runtimeRevision += 1;
  }

  /** Returns true if an STT provider is configured and has credentials. */
  isSTTAvailable(): boolean {
    const { provider, providers } = this.config.stt;
    return provider !== null && providers[provider]?.apiKey !== undefined;
  }

  /**
   * Returns true if a TTS provider is configured and an implementation is registered.
   *
   * Config alone is not enough — the TTS provider plugin must have registered
   * its implementation via `registerTTSProvider` before this returns true.
   */
  isTTSAvailable(): boolean {
    const provider = this.config.tts.provider;
    return provider !== null && this.ttsProviders.has(provider);
  }

  /**
   * Transcribes audio using the configured STT provider.
   *
   * @throws if no STT provider is configured or if the named provider is not registered.
   */
  async transcribe(audioBuffer: Buffer, mimeType: string, options?: STTOptions): Promise<STTResult> {
    const providerName = this.config.stt.provider;
    if (!providerName || !this.config.stt.providers[providerName]?.apiKey) {
      throw new Error("Speech-to-text is off or not ready. Open Settings → Speech-to-text or run /speech.");
    }
    const provider = this.sttProviders.get(providerName);
    if (!provider) {
      throw new Error(`STT provider "${providerName}" not registered. Available: ${[...this.sttProviders.keys()].join(", ") || "none"}`);
    }
    return provider.transcribe(audioBuffer, mimeType, options);
  }

  /**
   * Synthesizes speech using the configured TTS provider.
   *
   * @throws if no TTS provider is configured or if the named provider is not registered.
   */
  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const providerName = this.config.tts.provider;
    if (!providerName) {
      throw new Error("TTS not configured. Set speech.tts.provider in config.");
    }
    const provider = this.ttsProviders.get(providerName);
    if (!provider) {
      throw new Error(`TTS provider "${providerName}" not registered. Available: ${[...this.ttsProviders.keys()].join(", ") || "none"}`);
    }
    return provider.synthesize(text, options);
  }

  /** Replace the active config without rebuilding providers. Use `refreshProviders` to also rebuild. */
  updateConfig(config: SpeechServiceConfig): void {
    this.config = config;
    this.runtimeRevision += 1;
  }

  /**
   * Build and validate a complete factory-owned provider replacement without
   * changing the active runtime. The returned commit is revision-checked and
   * preserves providers registered by external plugins. Rollback restores the
   * exact config, maps, ownership sets, and provider object references captured
   * immediately before commit.
   */
  prepareProviderRefresh(newConfig: SpeechServiceConfig): PreparedProviderRefresh {
    if (!this.providerFactory) {
      const baseRevision = this.runtimeRevision;
      let previousConfig: SpeechServiceConfig | undefined;
      let committed = false;
      return {
        commit: () => {
          if (committed || this.runtimeRevision !== baseRevision) throw new Error('Speech runtime changed while provider refresh was being prepared');
          previousConfig = this.config;
          this.config = newConfig;
          this.runtimeRevision = baseRevision + 1;
          committed = true;
        },
        rollback: () => {
          if (!committed || previousConfig === undefined) return;
          if (this.runtimeRevision !== baseRevision + 1) throw new Error('Speech runtime changed before provider refresh rollback');
          this.config = previousConfig;
          this.runtimeRevision = baseRevision;
          committed = false;
        },
      };
    }

    const baseRevision = this.runtimeRevision;
    const built = this.providerFactory(newConfig);
    let previous: {
      config: SpeechServiceConfig;
      sttProviders: Map<string, STTProvider>;
      ttsProviders: Map<string, TTSProvider>;
      factoryOwnedSTT: Set<string>;
      factoryOwnedTTS: Set<string>;
    } | undefined;
    let committed = false;

    return {
      commit: () => {
        if (committed || this.runtimeRevision !== baseRevision) throw new Error('Speech runtime changed while provider refresh was being prepared');
        previous = {
          config: this.config,
          sttProviders: this.sttProviders,
          ttsProviders: this.ttsProviders,
          factoryOwnedSTT: this.factoryOwnedSTT,
          factoryOwnedTTS: this.factoryOwnedTTS,
        };
        const nextSTT = new Map(this.sttProviders);
        const nextTTS = new Map(this.ttsProviders);
        for (const name of this.factoryOwnedSTT) nextSTT.delete(name);
        for (const name of this.factoryOwnedTTS) nextTTS.delete(name);
        for (const [name, provider] of built.stt) nextSTT.set(name, provider);
        for (const [name, provider] of built.tts) nextTTS.set(name, provider);

        this.config = newConfig;
        this.sttProviders = nextSTT;
        this.ttsProviders = nextTTS;
        this.factoryOwnedSTT = new Set(built.stt.keys());
        this.factoryOwnedTTS = new Set(built.tts.keys());
        this.runtimeRevision = baseRevision + 1;
        committed = true;
      },
      rollback: () => {
        if (!committed || !previous) return;
        if (this.runtimeRevision !== baseRevision + 1) throw new Error('Speech runtime changed before provider refresh rollback');
        this.config = previous.config;
        this.sttProviders = previous.sttProviders;
        this.ttsProviders = previous.ttsProviders;
        this.factoryOwnedSTT = previous.factoryOwnedSTT;
        this.factoryOwnedTTS = previous.factoryOwnedTTS;
        this.runtimeRevision = baseRevision;
        committed = false;
      },
    };
  }

  /**
   * Reloads TTS and STT providers from a new config snapshot.
   *
   * Called after config changes or plugin hot-reload. Factory-managed providers are
   * rebuilt via the registered `ProviderFactory`; externally-registered providers
   * (e.g. from `@openacp/msedge-tts-plugin`) are preserved rather than discarded.
   */
  refreshProviders(newConfig: SpeechServiceConfig): void {
    this.prepareProviderRefresh(newConfig).commit();
  }
}
