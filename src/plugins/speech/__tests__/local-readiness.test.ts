import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getLocalWhisperReadiness, LOCAL_WHISPER_SCRIPT_PATH_ENV } from '../local-readiness.js'

const roots: string[] = []

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true })
})

function tempScript(mode = 0o700): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-local-readiness-'))
  roots.push(root)
  const script = path.join(root, 'transcribe.sh')
  fs.writeFileSync(script, '#!/bin/sh\n', { mode })
  fs.chmodSync(script, mode)
  return script
}

const runtimeAvailable = (command: string): boolean => command === 'python3'

describe('local Whisper readiness', () => {
  it('accepts a valid executable custom settings path without returning that path', () => {
    const script = tempScript()
    const result = getLocalWhisperReadiness(
      { localWhisperScriptPath: script },
      { env: {}, commandAvailable: runtimeAvailable },
    )
    expect(result).toEqual({ ready: true, script: 'ready', runtimeReady: true })
    expect(JSON.stringify(result)).not.toContain(script)
  })

  it('rejects missing and non-executable custom settings paths without exposing them', () => {
    const nonExecutable = tempScript(0o600)
    const missing = path.join(path.dirname(nonExecutable), 'missing.sh')
    expect(getLocalWhisperReadiness(
      { localWhisperScriptPath: nonExecutable },
      { env: {}, commandAvailable: runtimeAvailable },
    )).toEqual({ ready: false, script: 'not-executable', runtimeReady: true })
    const result = getLocalWhisperReadiness(
      { localWhisperScriptPath: missing },
      { env: {}, commandAvailable: runtimeAvailable },
    )
    expect(result).toEqual({ ready: false, script: 'missing', runtimeReady: true })
    expect(JSON.stringify(result)).not.toContain(missing)
  })

  it('uses the environment override as the effective executable path', () => {
    const settingsScript = tempScript(0o600)
    const environmentScript = tempScript()
    expect(getLocalWhisperReadiness(
      { localWhisperScriptPath: settingsScript },
      {
        env: { [LOCAL_WHISPER_SCRIPT_PATH_ENV]: environmentScript },
        commandAvailable: runtimeAvailable,
      },
    )).toEqual({ ready: true, script: 'ready', runtimeReady: true })

    const missingOverride = path.join(path.dirname(environmentScript), 'missing.sh')
    expect(getLocalWhisperReadiness(
      { localWhisperScriptPath: environmentScript },
      {
        env: { [LOCAL_WHISPER_SCRIPT_PATH_ENV]: missingOverride },
        commandAvailable: runtimeAvailable,
      },
    )).toEqual({ ready: false, script: 'missing', runtimeReady: true })
  })

  it('requires Python 3 or uv even when the executable is ready', () => {
    const script = tempScript()
    expect(getLocalWhisperReadiness(
      { localWhisperScriptPath: script },
      { env: {}, commandAvailable: () => false },
    )).toEqual({ ready: false, script: 'ready', runtimeReady: false })
  })
})
