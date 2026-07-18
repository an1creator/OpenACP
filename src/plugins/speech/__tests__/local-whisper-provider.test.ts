import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LocalWhisperSTT } from '../providers/local-whisper.js'

type Remove = typeof import('node:fs/promises')['rm']
type Spawn = typeof import('node:child_process')['spawn']

const fsMocks = vi.hoisted(() => ({
  actualRm: undefined as Remove | undefined,
  rm: vi.fn<Remove>(),
}))
const logMocks = vi.hoisted(() => ({ warn: vi.fn() }))
const childProcessMocks = vi.hoisted(() => ({
  actualSpawn: undefined as Spawn | undefined,
  spawn: vi.fn(),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  fsMocks.actualRm = actual.rm
  fsMocks.rm.mockImplementation(actual.rm)
  return { ...actual, rm: fsMocks.rm }
})

vi.mock('../../../core/utils/log.js', () => ({
  createChildLogger: () => ({ warn: logMocks.warn }),
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  childProcessMocks.actualSpawn = actual.spawn
  childProcessMocks.spawn.mockImplementation(actual.spawn)
  return { ...actual, spawn: childProcessMocks.spawn }
})

function createFakeChild(pid: number): ChildProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  }) as unknown as ChildProcess
}

function mockNextSpawn(child: ChildProcess): Promise<void> {
  let spawned!: () => void
  const ready = new Promise<void>((resolve) => { spawned = resolve })
  childProcessMocks.spawn.mockImplementationOnce(() => {
    spawned()
    return child
  })
  return ready
}

async function transcriptionTempDirs(root: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.startsWith('openacp-local-whisper-'))
}

async function waitForChildPid(pidFile: string): Promise<number> {
  let pid = 0
  await vi.waitFor(async () => {
    pid = Number((await readFile(pidFile, 'utf8')).trim())
    expect(pid).toBeGreaterThan(0)
  })
  return pid
}

async function expectProcessGone(pid: number): Promise<void> {
  await vi.waitFor(() => {
    try {
      process.kill(pid, 0)
      throw new Error(`Process ${pid} is still running`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  })
}

describe('LocalWhisperSTT', () => {
  beforeEach(() => {
    fsMocks.rm.mockReset().mockImplementation(fsMocks.actualRm!)
    logMocks.warn.mockReset()
    childProcessMocks.spawn.mockReset().mockImplementation(childProcessMocks.actualSpawn!)
  })

  it('validates direct timeout options while preserving zero as unlimited', async () => {
    expect(() => new LocalWhisperSTT({ timeoutMs: -1 })).toThrow(/whole number from 0/)
    expect(() => new LocalWhisperSTT({ timeoutMs: 2_147_483_648 })).toThrow(/whole number from 0/)
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-timeout-boundary-'))
    const scriptPath = path.join(tempRoot, 'success.sh')
    try {
      await writeFile(scriptPath, '#!/usr/bin/env bash\nprintf transcript\n')
      await chmod(scriptPath, 0o755)
      await expect(new LocalWhisperSTT({ scriptPath, tempRoot, timeoutMs: 0 }).transcribe(Buffer.from('audio'), 'audio/wav'))
        .resolves.toMatchObject({ text: 'transcript' })
      await expect(new LocalWhisperSTT({ scriptPath, tempRoot, timeoutMs: 2_147_483_647 }).transcribe(Buffer.from('audio'), 'audio/wav'))
        .resolves.toMatchObject({ text: 'transcript' })
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('writes audio to a temp file and returns transcript metadata', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-test-'))
    const scriptPath = path.join(tempRoot, 'fake-transcribe.sh')
    const seenPath = path.join(tempRoot, 'seen-path.txt')
    const seenProxy = path.join(tempRoot, 'seen-proxy.txt')

    try {
      await writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
audio_path="\${@: -1}"
printf '%s' "$audio_path" > ${JSON.stringify(seenPath)}
printf '%s' "\${ALL_PROXY:-missing}" > ${JSON.stringify(seenProxy)}
printf 'model=base language=ru language_probability=0.999 duration=1.250s\n' >&2
printf 'привет из теста\n'
`)
      await chmod(scriptPath, 0o755)

      const provider = new LocalWhisperSTT({
        scriptPath,
        language: 'ru',
        model: 'base',
        beamSize: 5,
        vadFilter: false,
        device: 'cpu',
        computeType: 'int8',
        timeoutMs: 10_000,
        tempRoot,
        childEnv: { ...process.env, ALL_PROXY: 'socks5h://scoped.test:1080' } as Record<string, string>,
      })

      const result = await provider.transcribe(Buffer.from('audio bytes'), 'audio/ogg; codecs=opus')
      const audioPath = await readFile(seenPath, 'utf8')

      expect(result).toEqual({ text: 'привет из теста', language: 'ru', duration: 1.25 })
      expect(audioPath).toMatch(/input\.ogg$/)
      expect(await readFile(seenProxy, 'utf8')).toBe('socks5h://scoped.test:1080')
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('reports script failures with stderr context', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-error-'))
    const scriptPath = path.join(tempRoot, 'fail.sh')
    try {
      await writeFile(scriptPath, '#!/usr/bin/env bash\necho "runtime unavailable" >&2\nexit 2\n')
      await chmod(scriptPath, 0o755)
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot })
      const error = await provider.transcribe(Buffer.from('audio'), 'audio/wav').catch((failure: unknown) => failure as Error)
      expect(error.message).toContain('exited with code 2')
      expect(error.message.match(/runtime unavailable/g)).toHaveLength(1)
      expect(error.message).not.toContain('Command failed:')
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('preserves the transcription error when temporary cleanup also fails', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-cleanup-error-'))
    const scriptPath = path.join(tempRoot, 'fail.sh')
    try {
      await writeFile(scriptPath, '#!/usr/bin/env bash\necho "primary runtime failure" >&2\nexit 7\n')
      await chmod(scriptPath, 0o755)
      fsMocks.rm.mockRejectedValueOnce(Object.assign(
        new Error(`cannot remove ${tempRoot}/secret-http://user:password@proxy.test`),
        { code: 'EACCES' },
      ))

      const error = await new LocalWhisperSTT({ scriptPath, tempRoot })
        .transcribe(Buffer.from('audio'), 'audio/wav')
        .catch((failure: unknown) => failure as Error)

      expect(error.message).toContain('exited with code 7')
      expect(error.message).toContain('primary runtime failure')
      expect(error.message).not.toContain('cannot remove')
      expect(logMocks.warn).toHaveBeenCalledWith(
        { code: 'EACCES' },
        'Failed to remove Local Whisper temporary data; host cleanup may be required',
      )
      const logged = JSON.stringify(logMocks.warn.mock.calls)
      expect(logged).not.toContain(tempRoot)
      expect(logged).not.toContain('password')
      expect(await transcriptionTempDirs(tempRoot)).toHaveLength(1)
    } finally {
      await fsMocks.actualRm!(tempRoot, { recursive: true, force: true })
    }
  })

  it('resolves child env at every spawn so proxy rotation needs no daemon restart', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-rotate-'))
    const scriptPath = path.join(tempRoot, 'capture-env.sh')
    const seenProxy = path.join(tempRoot, 'seen-proxy.txt')
    try {
      await writeFile(scriptPath, `#!/usr/bin/env bash
printf '%s\n' "\${HTTPS_PROXY:-missing}" >> ${JSON.stringify(seenProxy)}
printf 'transcript\n'
`)
      await chmod(scriptPath, 0o755)
      let proxy = 'http://old.test:8080'
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot, getChildEnv: () => ({ ...process.env, HTTPS_PROXY: proxy }) as Record<string, string> })
      await provider.transcribe(Buffer.from('one'), 'audio/wav')
      proxy = 'http://new.test:8080'
      await provider.transcribe(Buffer.from('two'), 'audio/wav')
      expect((await readFile(seenProxy, 'utf8')).trim().split('\n')).toEqual([
        'http://old.test:8080', 'http://new.test:8080',
      ])
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('reports a timeout with its limit, kills descendants, and removes the temp audio', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-timeout-'))
    const scriptPath = path.join(tempRoot, 'timeout.sh')
    const childPidFile = path.join(tempRoot, 'child.pid')
    try {
      await writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
sleep 30 &
printf '%s' "$!" > ${JSON.stringify(childPidFile)}
wait
`)
      await chmod(scriptPath, 0o755)
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot, timeoutMs: 200 })
      const pending = provider.transcribe(Buffer.from('audio'), 'audio/ogg')
      const childPid = await waitForChildPid(childPidFile)
      const error = await pending.catch((failure: unknown) => failure as Error)
      expect(error.message).toContain('timed out after 200 ms')
      expect(error.message).toContain('increase Local Processing Time Limit')
      expect(error.message).not.toContain('exit null')
      await expectProcessGone(childPid)
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('names abnormal process signals instead of reporting a null exit', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-signal-'))
    const scriptPath = path.join(tempRoot, 'signal.sh')
    try {
      await writeFile(scriptPath, '#!/usr/bin/env bash\nkill -TERM $$\n')
      await chmod(scriptPath, 0o755)
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot })
      const error = await provider.transcribe(Buffer.from('audio'), 'audio/wav').catch((failure: unknown) => failure as Error)
      expect(error.message).toContain('terminated by SIGTERM')
      expect(error.message).not.toContain('exit null')
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('cancels the process group without surfacing a transcription warning', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-cancel-'))
    const scriptPath = path.join(tempRoot, 'cancel.sh')
    const childPidFile = path.join(tempRoot, 'cancel-child.pid')
    try {
      await writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
sleep 30 &
printf '%s' "$!" > ${JSON.stringify(childPidFile)}
wait
`)
      await chmod(scriptPath, 0o755)
      const controller = new AbortController()
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot, timeoutMs: 10_000 })
      const pending = provider.transcribe(Buffer.from('audio'), 'audio/ogg', { signal: controller.signal })
      const childPid = await waitForChildPid(childPidFile)
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await expectProcessGone(childPid)
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('preserves AbortError and terminates the process when temporary cleanup also fails', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-cancel-cleanup-'))
    const scriptPath = path.join(tempRoot, 'cancel.sh')
    const childPidFile = path.join(tempRoot, 'cancel-child.pid')
    try {
      await writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
sleep 30 &
printf '%s' "$!" > ${JSON.stringify(childPidFile)}
wait
`)
      await chmod(scriptPath, 0o755)
      const controller = new AbortController()
      const reason = new DOMException('caller cancelled transcription', 'AbortError')
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot, timeoutMs: 10_000 })
      const pending = provider.transcribe(Buffer.from('audio'), 'audio/ogg', { signal: controller.signal })
      const childPid = await waitForChildPid(childPidFile)
      fsMocks.rm.mockRejectedValueOnce(Object.assign(
        new Error(`cannot remove ${tempRoot}/token=cleanup-secret`),
        { code: 'EBUSY' },
      ))

      controller.abort(reason)
      const error = await pending.catch((failure: unknown) => failure)

      expect(error).toBe(reason)
      await expectProcessGone(childPid)
      expect(logMocks.warn).toHaveBeenCalledWith(
        { code: 'EBUSY' },
        'Failed to remove Local Whisper temporary data; host cleanup may be required',
      )
      const logged = JSON.stringify(logMocks.warn.mock.calls)
      expect(logged).not.toContain(tempRoot)
      expect(logged).not.toContain('cleanup-secret')
      expect(await transcriptionTempDirs(tempRoot)).toHaveLength(1)
    } finally {
      await fsMocks.actualRm!(tempRoot, { recursive: true, force: true })
    }
  })

  it('redacts and bounds dependency output without duplicating stderr', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-redact-'))
    const scriptPath = path.join(tempRoot, 'verbose-failure.sh')
    const secret = 'proxy-user:proxy-password'
    try {
      await writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
head -c 5000 /dev/zero | tr '\\0' x >&2
printf '\\nruntime unavailable via http://${secret}@proxy.test:8080/model?token=model-secret\\n' >&2
exit 2
`)
      await chmod(scriptPath, 0o755)
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot })
      const error = await provider.transcribe(Buffer.from('audio'), 'audio/wav').catch((failure: unknown) => failure as Error & { cause?: Error })
      const serializedCause = `${error.cause?.message ?? ''}${JSON.stringify(error.cause)}`
      expect(error.message.length).toBeLessThan(2_500)
      expect(error.message).toContain('[earlier output truncated]')
      expect(error.message.match(/runtime unavailable/g)).toHaveLength(1)
      expect(error.message).toContain('http://<redacted>@proxy.test:8080/model?token=<redacted>')
      expect(`${error.message}${serializedCause}`).not.toContain(secret)
      expect(`${error.message}${serializedCause}`).not.toContain('model-secret')
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('stops a helper that exceeds the output buffer and returns a bounded diagnostic', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-buffer-'))
    const scriptPath = path.join(tempRoot, 'overflow.sh')
    try {
      await writeFile(scriptPath, '#!/usr/bin/env bash\nhead -c 11000000 /dev/zero | tr \'\\0\' x >&2\n')
      await chmod(scriptPath, 0o755)
      const provider = new LocalWhisperSTT({ scriptPath, tempRoot, timeoutMs: 10_000 })
      const error = await provider.transcribe(Buffer.from('audio'), 'audio/wav').catch((failure: unknown) => failure as Error)
      expect(error.message).toContain('produced too much output and was stopped')
      expect(error.message.length).toBeLessThan(2_500)
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally { await rm(tempRoot, { recursive: true, force: true }) }
  })

  it('uses one force-kill lifecycle when output overflow races with abort', async () => {
    vi.useFakeTimers()
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-overflow-abort-'))
    const child = createFakeChild(910_001)
    const spawned = mockNextSpawn(child)
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      signals.push(signal)
      return true
    }) as typeof process.kill)
    try {
      const controller = new AbortController()
      const reason = new DOMException('cancel overflow race', 'AbortError')
      const provider = new LocalWhisperSTT({
        scriptPath: path.join(tempRoot, 'mock-transcribe'),
        tempRoot,
        timeoutMs: 10_000,
      })
      const outcome = provider.transcribe(Buffer.from('audio'), 'audio/wav', { signal: controller.signal })
        .catch((error: unknown) => error)
      await spawned

      child.stderr!.emit('data', 'x'.repeat(10 * 1024 * 1024 + 1))
      controller.abort(reason)
      expect(signals).toEqual(['SIGTERM'])

      child.emit('close', null, 'SIGKILL')
      await expect(outcome).resolves.toBe(reason)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])

      await vi.advanceTimersByTimeAsync(5_000)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally {
      killSpy.mockRestore()
      vi.useRealTimers()
      await fsMocks.actualRm!(tempRoot, { recursive: true, force: true })
    }
  })

  it('uses one force-kill lifecycle when output overflow races with timeout', async () => {
    vi.useFakeTimers()
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'openacp-local-whisper-overflow-timeout-'))
    const child = createFakeChild(910_002)
    const spawned = mockNextSpawn(child)
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      _pid: number,
      signal?: NodeJS.Signals | number,
    ) => {
      signals.push(signal)
      return true
    }) as typeof process.kill)
    try {
      const provider = new LocalWhisperSTT({
        scriptPath: path.join(tempRoot, 'mock-transcribe'),
        tempRoot,
        timeoutMs: 100,
      })
      const outcome = provider.transcribe(Buffer.from('audio'), 'audio/wav')
        .catch((error: unknown) => error as Error)
      await spawned

      child.stdout!.emit('data', 'x'.repeat(10 * 1024 * 1024 + 1))
      expect(signals).toEqual(['SIGTERM'])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      child.emit('close', null, 'SIGKILL')

      const error = await outcome
      expect(error.message).toContain('timed out after 100 ms')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
      expect(await transcriptionTempDirs(tempRoot)).toEqual([])
    } finally {
      killSpy.mockRestore()
      vi.useRealTimers()
      await fsMocks.actualRm!(tempRoot, { recursive: true, force: true })
    }
  })
})
