import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsManager } from '../../plugin/settings-manager.js'
import { speechCheck } from '../checks/speech.js'
import type { DoctorContext } from '../types.js'

const roots: string[] = []
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }) })

function context(root: string, fetcher: typeof fetch = vi.fn() as unknown as typeof fetch): DoctorContext {
  return {
    config: null, rawConfig: null, configPath: path.join(root, 'config.json'), dataDir: root,
    sessionsPath: path.join(root, 'sessions.json'), pidPath: path.join(root, 'pid'),
    portFilePath: path.join(root, 'port'), pluginsDir: path.join(root, 'plugins'),
    logsDir: path.join(root, 'logs'), fetchForScope: vi.fn(() => fetcher),
  }
}

async function setup(settings: Record<string, unknown>): Promise<{ root: string; sm: SettingsManager }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-doctor-speech-')); roots.push(root)
  const sm = new SettingsManager(path.join(root, 'plugins', 'data'))
  await sm.updatePluginSettings('@openacp/speech', settings)
  return { root, sm }
}

describe('speech doctor check', () => {
  it('reports optional off state without a network request', async () => {
    const { root } = await setup({ sttProvider: null })
    const ctx = context(root)
    await expect(speechCheck.run(ctx)).resolves.toEqual([
      expect.objectContaining({ status: 'pass', message: expect.stringContaining('Off') }),
    ])
    expect(ctx.fetchForScope).not.toHaveBeenCalled()
  })

  it('verifies Groq access through the speech scope while keeping the key hidden', async () => {
    const secret = 'gsk_doctor_secret'
    const { root } = await setup({ sttProvider: 'groq', groqApiKey: secret })
    const fetcher = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const ctx = context(root, fetcher as typeof fetch)
    const result = await speechCheck.run(ctx)
    expect(result).toEqual([expect.objectContaining({ status: 'pass', message: expect.stringContaining('Groq transcription route') })])
    expect(JSON.stringify(result)).toContain('saved (hidden)')
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain('services.')
    expect(ctx.fetchForScope).toHaveBeenCalledWith('services.speech')
  })

  it('uses a human route label for local model downloads', async () => {
    const { root } = await setup({ sttProvider: 'local-whisper' })
    const result = await speechCheck.run(context(root))
    expect(JSON.stringify(result)).toContain('Local speech model downloads route')
    expect(JSON.stringify(result)).not.toContain('services.')
  })

  it('reports a selected Groq method with no key as actionable and redacted', async () => {
    const { root } = await setup({ sttProvider: 'groq' })
    const result = await speechCheck.run(context(root))
    expect(result).toEqual([expect.objectContaining({ status: 'warn', message: expect.stringContaining('API key not set') })])
    expect(JSON.stringify(result)).not.toContain('/home/')
  })
})
