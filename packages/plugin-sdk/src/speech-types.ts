// Re-export the CLI's public speech contract. The SDK declares the CLI package
// as a peer, so one declaration source keeps plugin and runtime types identical.
export type {
  SpeechServiceInterface,
  STTOptions,
  STTProvider,
  STTResult,
  TTSOptions,
  TTSProvider,
  TTSResult,
} from '@n1creator/openacp-cli'
