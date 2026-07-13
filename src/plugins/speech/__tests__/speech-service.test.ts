import { describe, it, expect, vi } from "vitest";
import { SpeechService } from "../speech-service.js";
import type { STTProvider, SpeechServiceConfig } from "../speech-types.js";

function makeConfig(overrides?: Partial<SpeechServiceConfig>): SpeechServiceConfig {
  return {
    stt: { provider: null, providers: {} },
    tts: { provider: null, providers: {} },
    ...overrides,
  };
}

describe("SpeechService", () => {
  describe("isSTTAvailable", () => {
    it("returns false when no provider configured", () => {
      const svc = new SpeechService(makeConfig());
      expect(svc.isSTTAvailable()).toBe(false);
    });

    it("returns false when provider set but no matching config", () => {
      const svc = new SpeechService(makeConfig({
        stt: { provider: "groq", providers: {} },
      }));
      expect(svc.isSTTAvailable()).toBe(false);
    });

    it("returns true when provider configured with API key", () => {
      const svc = new SpeechService(makeConfig({
        stt: {
          provider: "groq",
          providers: { groq: { apiKey: "gsk_test" } },
        },
      }));
      expect(svc.isSTTAvailable()).toBe(true);
    });
  });

  describe("isTTSAvailable", () => {
    it("returns false when no provider configured", () => {
      const svc = new SpeechService(makeConfig());
      expect(svc.isTTSAvailable()).toBe(false);
    });
  });

  describe("unregisterTTSProvider", () => {
    it('unregisters a TTS provider', () => {
      const service = new SpeechService({
        stt: { provider: null, providers: {} },
        tts: { provider: 'test', providers: {} },
      })
      const mockProvider = { name: 'test', synthesize: vi.fn() }
      service.registerTTSProvider('test', mockProvider)
      expect(service.isTTSAvailable()).toBe(true)

      service.unregisterTTSProvider('test')
      expect(service.isTTSAvailable()).toBe(false)
    })
  });

  describe("transcribe", () => {
    it("throws when STT not configured", async () => {
      const svc = new SpeechService(makeConfig());
      await expect(svc.transcribe(Buffer.from("test"), "audio/wav"))
        .rejects.toThrow("Speech-to-text is off or not ready");
    });

    it("delegates to registered provider", async () => {
      const mockProvider: STTProvider = {
        name: "test",
        transcribe: vi.fn().mockResolvedValue({ text: "hello world" }),
      };
      const svc = new SpeechService(makeConfig({
        stt: {
          provider: "test",
          providers: { test: { apiKey: "key123" } },
        },
      }));
      svc.registerSTTProvider("test", mockProvider);
      const result = await svc.transcribe(Buffer.from("audio"), "audio/wav");
      expect(result.text).toBe("hello world");
      expect(mockProvider.transcribe).toHaveBeenCalledWith(
        Buffer.from("audio"), "audio/wav", undefined,
      );
    });

    it("throws when provider not registered", async () => {
      const svc = new SpeechService(makeConfig({
        stt: {
          provider: "unknown",
          providers: { unknown: { apiKey: "key" } },
        },
      }));
      await expect(svc.transcribe(Buffer.from("test"), "audio/wav"))
        .rejects.toThrow('STT provider "unknown" not registered');
    });
  });

  describe('atomic provider refresh', () => {
    it('removes factory-owned Groq references while preserving external TTS', async () => {
      const groqConfig = makeConfig({ stt: { provider: 'groq', providers: { groq: { apiKey: 'secret' } } }, tts: { provider: 'edge', providers: {} } })
      const service = new SpeechService(groqConfig)
      const groq = { name: 'groq', transcribe: vi.fn().mockResolvedValue({ text: 'old' }) }
      service.setProviderFactory((config) => ({
        stt: config.stt.provider === 'groq' ? new Map([['groq', groq]]) : new Map(),
        tts: new Map(),
      }))
      service.registerTTSProvider('edge', { name: 'edge', synthesize: vi.fn() })
      service.refreshProviders(groqConfig)
      expect(service.isTTSAvailable()).toBe(true)

      service.refreshProviders(makeConfig({ tts: { provider: 'edge', providers: {} } }))
      expect(service.isSTTAvailable()).toBe(false)
      expect(service.isTTSAvailable()).toBe(true)
      service.updateConfig(groqConfig)
      await expect(service.transcribe(Buffer.from('x'), 'audio/wav')).rejects.toThrow('not registered')
    })

    it('keeps an in-flight transcription on its captured provider during an atomic swap', async () => {
      let finish!: (value: { text: string }) => void
      const pending = new Promise<{ text: string }>((resolve) => { finish = resolve })
      const config = makeConfig({ stt: { provider: 'native', providers: { native: { apiKey: 'local' } } } })
      const oldProvider = { name: 'native', transcribe: vi.fn(() => pending) }
      const newProvider = { name: 'native', transcribe: vi.fn().mockResolvedValue({ text: 'new' }) }
      const service = new SpeechService(config)
      let current: STTProvider = oldProvider
      service.setProviderFactory(() => ({ stt: new Map([['native', current]]), tts: new Map() }))
      service.refreshProviders(config)
      const inFlight = service.transcribe(Buffer.from('old'), 'audio/wav')
      current = newProvider
      service.refreshProviders(config)
      finish({ text: 'old-complete' })
      await expect(inFlight).resolves.toEqual({ text: 'old-complete' })
      await expect(service.transcribe(Buffer.from('new'), 'audio/wav')).resolves.toEqual({ text: 'new' })
    })

    it('rolls back config and providers when replacement construction fails', async () => {
      const config = makeConfig({ stt: { provider: 'native', providers: { native: { apiKey: 'local' } } } })
      const provider = { name: 'native', transcribe: vi.fn().mockResolvedValue({ text: 'still-active' }) }
      const service = new SpeechService(config)
      let fail = false
      service.setProviderFactory(() => {
        if (fail) throw new Error('construction failed')
        return { stt: new Map([['native', provider]]), tts: new Map() }
      })
      service.refreshProviders(config)
      fail = true
      expect(() => service.refreshProviders(makeConfig())).toThrow('construction failed')
      expect(service.isSTTAvailable()).toBe(true)
      await expect(service.transcribe(Buffer.from('x'), 'audio/wav')).resolves.toEqual({ text: 'still-active' })
    })
  })
});
