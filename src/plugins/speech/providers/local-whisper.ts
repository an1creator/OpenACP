import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { STTOptions, STTProvider, STTResult } from '../speech-types.js'

const execFileAsync = promisify(execFile)

export const LOCAL_WHISPER_PROVIDER = 'local-whisper'

export interface LocalWhisperSTTOptions {
  scriptPath?: string
  language?: string
  model?: string
  beamSize?: number
  vadFilter?: boolean
  device?: string
  computeType?: string
  timeoutMs?: number
  tempRoot?: string
}

export const LOCAL_WHISPER_DEFAULTS = {
  language: 'ru',
  model: 'base',
  beamSize: 5,
  vadFilter: false,
  device: 'cpu',
  computeType: 'int8',
  timeoutMs: 120_000,
} as const

/** Local faster-whisper provider bundled with the maintained OpenACP package. */
export class LocalWhisperSTT implements STTProvider {
  readonly name = LOCAL_WHISPER_PROVIDER
  private readonly config: Required<Omit<LocalWhisperSTTOptions, 'tempRoot'>> & Pick<LocalWhisperSTTOptions, 'tempRoot'>

  constructor(options: LocalWhisperSTTOptions = {}) {
    this.config = {
      scriptPath: options.scriptPath ?? resolveLocalWhisperScriptPath(),
      language: options.language ?? LOCAL_WHISPER_DEFAULTS.language,
      model: options.model ?? LOCAL_WHISPER_DEFAULTS.model,
      beamSize: options.beamSize ?? LOCAL_WHISPER_DEFAULTS.beamSize,
      vadFilter: options.vadFilter ?? LOCAL_WHISPER_DEFAULTS.vadFilter,
      device: options.device ?? LOCAL_WHISPER_DEFAULTS.device,
      computeType: options.computeType ?? LOCAL_WHISPER_DEFAULTS.computeType,
      timeoutMs: options.timeoutMs ?? LOCAL_WHISPER_DEFAULTS.timeoutMs,
      tempRoot: options.tempRoot,
    }
  }

  async transcribe(audioBuffer: Buffer, mimeType: string, options?: STTOptions): Promise<STTResult> {
    const tempDir = await mkdtemp(path.join(this.config.tempRoot ?? tmpdir(), 'openacp-local-whisper-'))
    const audioPath = path.join(tempDir, `input${mimeToExt(mimeType)}`)

    try {
      await writeFile(audioPath, audioBuffer)
      const { stdout, stderr } = await execFileAsync(this.config.scriptPath, this.buildArgs(audioPath, options), {
        timeout: this.config.timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      })
      const text = stdout.trim()
      if (!text) throw new Error('Local Whisper returned an empty transcript')
      return { text, ...parseMetadata(stderr) }
    } catch (error) {
      throw new Error(`Local Whisper STT failed: ${formatExecError(error)}`)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  private buildArgs(audioPath: string, options?: STTOptions): string[] {
    return [
      '--model', options?.model ?? this.config.model,
      '--language', options?.language ?? this.config.language,
      '--beam-size', String(this.config.beamSize),
      '--device', this.config.device,
      '--compute-type', this.config.computeType,
      this.config.vadFilter ? '--vad-filter' : '--no-vad-filter',
      audioPath,
    ]
  }
}

/** Resolve both tsc's nested output and tsup's flat publish bundle. */
export function resolveLocalWhisperScriptPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDir, '../scripts/transcribe_audio.sh'),
    path.resolve(moduleDir, 'speech/transcribe_audio.sh'),
  ]
  return candidates.find(existsSync) ?? candidates[0]
}

function mimeToExt(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase()
  const extensions: Record<string, string> = {
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/aac': '.aac',
    'audio/webm': '.webm',
    'audio/flac': '.flac',
  }
  return (normalized && extensions[normalized]) || '.bin'
}

function parseMetadata(stderr: string): Pick<STTResult, 'language' | 'duration'> {
  const language = /\blanguage=([^\s]+)/.exec(stderr)?.[1]
  const durationRaw = /\bduration=([0-9.]+)s\b/.exec(stderr)?.[1]
  const duration = durationRaw ? Number(durationRaw) : undefined
  return { language, duration: Number.isFinite(duration) ? duration : undefined }
}

function formatExecError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const execError = error as Error & { stderr?: string; stdout?: string; code?: string | number }
  const details = [execError.stderr, execError.stdout].filter(Boolean).join('\n').trim()
  const code = execError.code === undefined ? '' : ` (exit ${execError.code})`
  return details ? `${error.message}${code}: ${details}` : `${error.message}${code}`
}
