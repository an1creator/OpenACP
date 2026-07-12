import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalWhisperSTT } from '../providers/local-whisper.js'

describe('LocalWhisperSTT', () => {
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
      await expect(provider.transcribe(Buffer.from('audio'), 'audio/wav'))
        .rejects.toThrow(/runtime unavailable/)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
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
})
