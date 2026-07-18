import type {
  SecurityService,
  FileServiceInterface,
  NotificationService,
  UsageService,
  TunnelServiceInterface,
  ContextService,
} from '@n1creator/openacp-cli'
import type { SpeechServiceInterface, STTOptions, TTSOptions } from '../speech-types.js'

/** Backward-compatible aliases retained by the speech test mock until the next SDK major version. */
export interface LegacySpeechMockAliases {
  /** @deprecated Use `synthesize()` and read `audioBuffer` from its result. */
  textToSpeech(text: string, options?: TTSOptions): Promise<Buffer>
  /** @deprecated Use `transcribe()` with an explicit MIME type and read `text` from its result. */
  speechToText(audio: Buffer, options?: STTOptions): Promise<string>
}

/** Speech test service with the canonical contract and deprecated mock-only aliases. */
export type SpeechServiceMock = SpeechServiceInterface & LegacySpeechMockAliases

/**
 * Factory functions that create mock implementations of OpenACP service interfaces.
 * Each returns an object matching the service contract with sensible defaults.
 */
export const mockServices = {
  security(overrides?: Partial<SecurityService>): SecurityService {
    return {
      async checkAccess() { return { allowed: true } },
      async checkSessionLimit() { return { allowed: true } },
      async getUserRole() { return 'user' },
      ...overrides,
    }
  },

  fileService(overrides?: Partial<FileServiceInterface>): FileServiceInterface {
    return {
      async saveFile(_sessionId, fileName, _data, mimeType) {
        return { type: 'file', filePath: `/tmp/${fileName}`, fileName, mimeType, size: 0 }
      },
      async resolveFile() { return null },
      async readTextFileWithRange() { return '' },
      extensionFromMime() { return '.bin' },
      async convertOggToWav(data) { return data },
      ...overrides,
    }
  },

  notifications(overrides?: Partial<NotificationService>): NotificationService {
    return {
      async notify() {},
      async notifyAll() {},
      ...overrides,
    }
  },

  usage(overrides?: Partial<UsageService>): UsageService {
    return {
      async trackUsage() {},
      async checkBudget() { return { ok: true, percent: 0 } },
      ...overrides,
    }
  },

  speech(overrides: Partial<SpeechServiceMock> = {}): SpeechServiceMock {
    const { textToSpeech, speechToText, ...canonicalOverrides } = overrides
    const service: SpeechServiceInterface = {
      async synthesize() { return { audioBuffer: Buffer.alloc(0), mimeType: 'audio/mpeg' } },
      async transcribe() { return { text: '' } },
      isTTSAvailable() { return false },
      isSTTAvailable() { return false },
      registerTTSProvider() {},
      unregisterTTSProvider() {},
      registerSTTProvider() {},
      ...canonicalOverrides,
    }
    return Object.assign(service, {
      textToSpeech: textToSpeech ?? (async (text: string, options?: TTSOptions) => (await service.synthesize(text, options)).audioBuffer),
      speechToText: speechToText ?? (async (audio: Buffer, options?: STTOptions) => (await service.transcribe(audio, 'application/octet-stream', options)).text),
    })
  },

  tunnel(overrides?: Partial<TunnelServiceInterface>): TunnelServiceInterface {
    return {
      getPublicUrl() { return 'http://localhost:0' },
      async start() { return 'http://localhost:0' },
      async stop() {},
      getStore() {
        return {
          storeFile() { return null },
          storeDiff() { return null },
          storeOutput() { return null },
        }
      },
      fileUrl(id) { return `http://localhost:0/file/${id}` },
      diffUrl(id) { return `http://localhost:0/diff/${id}` },
      outputUrl(id) { return `http://localhost:0/output/${id}` },
      ...overrides,
    }
  },

  context(overrides?: Partial<ContextService>): ContextService {
    return {
      async buildContext() { return '' },
      registerProvider() {},
      ...overrides,
    }
  },
}
