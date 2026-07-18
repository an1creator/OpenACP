import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactNetworkSecrets, sanitizeNetworkLogValue } from '../../../core/security/network-redaction.js'
import { createChildLogger } from '../../../core/utils/log.js'
import type { STTOptions, STTProvider, STTResult } from '../speech-types.js'

export const LOCAL_WHISPER_PROVIDER = 'local-whisper'

const MAX_ERROR_DETAILS_LENGTH = 2_000
const MAX_PROCESS_BUFFER_LENGTH = 10 * 1024 * 1024
const FORCE_KILL_DELAY_MS = 1_000
const log = createChildLogger({ module: 'local-whisper' })
/** Largest timeout accepted by Node timers; zero intentionally disables the provider timeout. */
export const LOCAL_WHISPER_MAX_TIMEOUT_MS = 2_147_483_647

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
  childEnv?: Record<string, string>
  getChildEnv?: () => Record<string, string>
}

export const LOCAL_WHISPER_DEFAULTS = {
  language: 'ru',
  model: 'base',
  beamSize: 5,
  vadFilter: false,
  device: 'cpu',
  computeType: 'int8',
  timeoutMs: 600_000,
} as const

/** Local faster-whisper provider bundled with the maintained OpenACP package. */
export class LocalWhisperSTT implements STTProvider {
  readonly name = LOCAL_WHISPER_PROVIDER
  private readonly config: Required<Omit<LocalWhisperSTTOptions, 'tempRoot'>> & Pick<LocalWhisperSTTOptions, 'tempRoot'>
  private readonly getChildEnv?: () => Record<string, string>

  constructor(options: LocalWhisperSTTOptions = {}) {
    this.getChildEnv = options.getChildEnv
    this.config = {
      scriptPath: options.scriptPath ?? resolveLocalWhisperScriptPath(),
      language: options.language ?? LOCAL_WHISPER_DEFAULTS.language,
      model: options.model ?? LOCAL_WHISPER_DEFAULTS.model,
      beamSize: options.beamSize ?? LOCAL_WHISPER_DEFAULTS.beamSize,
      vadFilter: options.vadFilter ?? LOCAL_WHISPER_DEFAULTS.vadFilter,
      device: options.device ?? LOCAL_WHISPER_DEFAULTS.device,
      computeType: options.computeType ?? LOCAL_WHISPER_DEFAULTS.computeType,
      timeoutMs: validateTimeoutMs(options.timeoutMs ?? LOCAL_WHISPER_DEFAULTS.timeoutMs),
      tempRoot: options.tempRoot,
      childEnv: options.childEnv ?? process.env as Record<string, string>,
      getChildEnv: options.getChildEnv ?? (() => options.childEnv ?? process.env as Record<string, string>),
    }
  }

  async transcribe(audioBuffer: Buffer, mimeType: string, options?: STTOptions): Promise<STTResult> {
    const tempDir = await mkdtemp(path.join(this.config.tempRoot ?? tmpdir(), 'openacp-local-whisper-'))
    const audioPath = path.join(tempDir, `input${mimeToExt(mimeType)}`)

    try {
      options?.signal?.throwIfAborted()
      await writeFile(audioPath, audioBuffer)
      const { stdout, stderr } = await runLocalWhisper(
        this.config.scriptPath,
        this.buildArgs(audioPath, options),
        this.config.timeoutMs,
        this.getChildEnv?.() ?? this.config.childEnv,
        options?.signal,
      )
      const text = stdout.trim()
      if (!text) throw new Error('Local Whisper returned an empty transcript')
      return { text, ...parseMetadata(stderr) }
    } catch (error) {
      if (options?.signal?.aborted) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        throw abortReason(options.signal)
      }
      throw new Error(`Local Whisper STT failed: ${formatExecError(error)}`, {
        cause: sanitizeNetworkLogValue(error),
      })
    } finally {
      try {
        await rm(tempDir, { recursive: true, force: true })
      } catch (error) {
        // Cleanup is best-effort: never replace a successful transcript or the
        // primary transcription/AbortError. Do not log the temporary path or
        // the raw filesystem error because either may contain host secrets.
        log.warn(
          { code: cleanupErrorCode(error) },
          'Failed to remove Local Whisper temporary data; host cleanup may be required',
        )
      }
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

function cleanupErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN'
}

interface LocalWhisperExecError extends Error {
  code?: string | number | null
  signal?: NodeJS.Signals | null
  killed?: boolean
  stdout?: string
  stderr?: string
  timedOut?: boolean
  timeoutMs?: number
}

function abortReason(signal: AbortSignal, cleanupError?: Error): Error {
  const reason = signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Local Whisper transcription was cancelled', 'AbortError')
  if (!cleanupError) return reason
  const aborted = new Error(reason.message, { cause: sanitizeNetworkLogValue(cleanupError) })
  aborted.name = 'AbortError'
  return aborted
}

function validateTimeoutMs(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > LOCAL_WHISPER_MAX_TIMEOUT_MS) {
    throw new Error(`Local Whisper timeout must be a whole number from 0 to ${LOCAL_WHISPER_MAX_TIMEOUT_MS} milliseconds`)
  }
  return timeoutMs
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): Error | undefined {
  if (!child.pid) return
  let groupError: Error | undefined
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      groupError = error instanceof Error ? error : new Error(String(error))
    }
  }
  try {
    if (child.kill(signal)) return groupError
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    const directError = error instanceof Error ? error : new Error(String(error))
    return new Error(`${groupError ? `${groupError.message}; ` : ''}${directError.message}`)
  }
  return groupError ?? new Error(`Could not send ${signal} to the transcription process`)
}

/** Run the helper in its own process group so timeout and cancellation stop descendants too. */
function runLocalWhisper(
  scriptPath: string,
  args: string[],
  timeoutMs: number,
  env: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  if (signal?.aborted) return Promise.reject(abortReason(signal))

  return new Promise((resolve, reject) => {
    let timedOut = false
    let aborted = false
    let closed = false
    let terminationStarted = false
    let forceKillSent = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined
    let stdout = ''
    let stderr = ''
    let processError: LocalWhisperExecError | undefined
    let terminationError: Error | undefined

    const retainTerminationError = (next: Error | undefined): void => {
      if (!next) return
      terminationError = new Error(`${terminationError ? `${terminationError.message}; ` : ''}${next.message}`)
    }

    const child = spawn(scriptPath, args, {
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    const forceKill = (): void => {
      if (forceKillSent) return
      forceKillSent = true
      retainTerminationError(terminateProcessTree(child, 'SIGKILL'))
    }
    const clearForceKill = (): void => {
      if (forceKillTimer === undefined) return
      clearTimeout(forceKillTimer)
      forceKillTimer = undefined
    }
    const scheduleForceKill = (): void => {
      if (closed || forceKillSent || forceKillTimer !== undefined) return
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined
        if (!closed) forceKill()
      }, FORCE_KILL_DELAY_MS)
    }
    const requestTermination = (): void => {
      if (closed) return
      if (!terminationStarted) {
        terminationStarted = true
        retainTerminationError(terminateProcessTree(child, 'SIGTERM'))
      }
      scheduleForceKill()
    }

    const appendOutput = (stream: 'stdout' | 'stderr', chunk: string): void => {
      if (closed) return
      const current = stream === 'stdout' ? stdout : stderr
      const overflow = (): void => {
        if (processError) return
        processError = Object.assign(new Error(`Local Whisper ${stream} exceeded the process buffer limit`), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout, stderr,
        })
        requestTermination()
      }
      if (current.length >= MAX_PROCESS_BUFFER_LENGTH) {
        overflow()
        return
      }
      const available = MAX_PROCESS_BUFFER_LENGTH - current.length
      const next = current + chunk.slice(0, available)
      if (stream === 'stdout') stdout = next
      else stderr = next
      if (chunk.length > available) overflow()
    }
    child.stdout?.on('data', (chunk: string) => appendOutput('stdout', chunk))
    child.stderr?.on('data', (chunk: string) => appendOutput('stderr', chunk))
    child.once('error', (error) => {
      if (!closed && !processError) {
        processError = Object.assign(error, { stdout, stderr }) as LocalWhisperExecError
      }
    })
    child.once('close', (code, processSignal) => {
      closed = true
      if (timeoutTimer) clearTimeout(timeoutTimer)
      clearForceKill()
      if (aborted || timedOut || processError || code !== 0 || processSignal) {
        forceKill()
      }
      signal?.removeEventListener('abort', onAbort)

      if (aborted) {
        reject(abortReason(signal!, terminationError))
        return
      }
      if (timedOut) {
        const timeoutError = Object.assign(new Error('Local Whisper process timed out'), {
          name: 'LocalWhisperTimeoutError',
          code,
          signal: processSignal ?? 'SIGTERM',
          killed: true,
          stdout,
          stderr: terminationError ? `${stderr}\n${terminationError.message}` : stderr,
          timedOut: true,
          timeoutMs,
        } satisfies Partial<LocalWhisperExecError>)
        reject(timeoutError)
        return
      }
      if (processError || code !== 0 || processSignal) {
        const execError = processError ?? Object.assign(
          new Error(processSignal
            ? `Local Whisper process was terminated by ${processSignal}`
            : `Local Whisper process exited with code ${code}`),
          { code, signal: processSignal, stdout, stderr } satisfies Partial<LocalWhisperExecError>,
        )
        if (terminationError) execError.stderr = `${execError.stderr ?? ''}\n${terminationError.message}`
        reject(execError)
        return
      }
      resolve({ stdout, stderr })
    })

    const stop = (reason: 'abort' | 'timeout'): void => {
      if (closed || aborted || timedOut) return
      aborted = reason === 'abort'
      timedOut = reason === 'timeout'
      requestTermination()
    }
    const onAbort = (): void => stop('abort')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs > 0) timeoutTimer = setTimeout(() => stop('timeout'), timeoutMs)
  })
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
  if (!(error instanceof Error)) return boundedDetails(String(error))
  const execError = error as LocalWhisperExecError
  let summary: string
  if (execError.timedOut) {
    const timeoutMs = execError.timeoutMs ?? LOCAL_WHISPER_DEFAULTS.timeoutMs
    const limit = timeoutMs % 1_000 === 0 ? `${timeoutMs / 1_000} seconds` : `${timeoutMs} ms`
    const recovery = timeoutMs < LOCAL_WHISPER_DEFAULTS.timeoutMs
      ? 'Retry after the initial dependency/model download, or increase Local Processing Time Limit in Speech-to-text settings.'
      : 'Check dependency/model download access and the local runtime, then retry.'
    summary = `Transcription timed out after ${limit}. The first run may need extra time to install faster-whisper and download the model. ${recovery}`
  } else if (execError.signal) {
    const hint = execError.signal === 'SIGKILL' ? ' Check the host memory and process limits.' : ''
    summary = `Transcription process was terminated by ${execError.signal}.${hint}`
  } else if (typeof execError.code === 'number') {
    summary = `Transcription process exited with code ${execError.code}.`
  } else if (execError.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    summary = 'Transcription process produced too much output and was stopped.'
  } else if (typeof execError.code === 'string') {
    summary = `Could not start the transcription process (${execError.code}).`
  } else {
    summary = redactNetworkSecrets(error.message)
  }

  const details = boundedDetails([execError.stderr, execError.stdout]
    .filter((value): value is string => Boolean(value?.trim()))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join('\n'))
  return details ? `${summary} Details:\n${details}` : summary
}

function boundedDetails(details: string): string {
  const safe = redactNetworkSecrets(details).trim()
  if (safe.length <= MAX_ERROR_DETAILS_LENGTH) return safe
  return `[earlier output truncated]\n${safe.slice(-MAX_ERROR_DETAILS_LENGTH)}`
}
