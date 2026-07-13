import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandArgs, CommandDef, PluginContext } from '../../../core/plugin/types.js'
import { SettingsManager } from '../../../core/plugin/settings-manager.js'
import type { OpenACPCore } from '../../../core/core.js'
import { SpeechService } from '../speech-service.js'
import { buildSpeechServiceConfig } from '../native-stt.js'
import { registerSpeechSettingsCommand, SPEECH_CAPABILITY_ERROR } from '../settings-command.js'
import type { TTSProvider } from '../speech-types.js'

const roots: string[] = []
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

function harness(role: 'admin' | 'member' | null = 'admin', runtime = true) {
  const root = mkdtempSync(path.join(tmpdir(), 'openacp-speech-settings-')); roots.push(root)
  const settingsManager = new SettingsManager(root)
  let command: CommandDef | undefined
  const ctx = { registerCommand: vi.fn((def: CommandDef) => { command = def }) } as unknown as PluginContext
  const identity = { getUserByIdentity: vi.fn().mockResolvedValue(role ? { role } : undefined) }
  const core = {
    settingsManager,
    lifecycleManager: { serviceRegistry: { get: vi.fn((name: string) => name === 'identity' ? identity : undefined) } },
  } as unknown as OpenACPCore
  const service = new SpeechService(buildSpeechServiceConfig({ ttsProvider: 'edge-tts' }))
  service.setProviderFactory(() => ({ stt: new Map(), tts: new Map() }))
  service.registerTTSProvider('edge-tts', { name: 'edge-tts', synthesize: vi.fn() } as unknown as TTSProvider)
  registerSpeechSettingsCommand(ctx, core, service, { isLocalRuntimeAvailable: () => runtime })
  const run = (raw: string, interaction?: CommandArgs['interaction']) => command!.handler({
    raw, sessionId: null, channelId: 'telegram', userId: '42', interaction,
    reply: vi.fn(),
  })
  return { run, settingsManager, service, root }
}

describe('connector-neutral speech settings command', () => {
  it('fails closed for a member or missing identity before returning status', async () => {
    expect(await harness('member').run('')).toEqual({ type: 'error', message: SPEECH_CAPABILITY_ERROR })
    expect(await harness(null).run('review')).toEqual({ type: 'error', message: SPEECH_CAPABILITY_ERROR })
  })

  it('reports missing local dependencies without exposing host paths', async () => {
    const response = await harness('admin', false).run('')
    expect(response).toMatchObject({ type: 'menu' })
    expect(JSON.stringify(response)).toContain('needs the bundled script and uv or Python 3')
    expect(JSON.stringify(response)).not.toContain('/home/')
  })

  it('stores a Groq key only through secure captured input and keeps reviews redacted', async () => {
    const { run, settingsManager } = harness()
    const request = await run('groq-set', { textInput: true, secureInput: 'delete-after-capture' })
    expect(request).toMatchObject({ type: 'input', sensitive: true, command: '/speech groq-input' })
    const secret = 'gsk_test_secret_value'
    const stored = await run('groq-input', { textInput: true, secureInput: 'delete-after-capture', capturedInput: { value: secret, sensitive: true } })
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect((await settingsManager.loadSettings('@openacp/speech')).groqApiKey).toBe(secret)
    const review = await run('review')
    expect(JSON.stringify(review)).toContain('configured (write-only)')
    expect(JSON.stringify(review)).not.toContain(secret)
  })

  it('rejects insecure Groq capture and invalid local values without writing them', async () => {
    const { run, settingsManager } = harness()
    expect(await run('groq-input', { textInput: true, secureInput: 'none', capturedInput: { value: 'gsk_nope', sensitive: true } })).toMatchObject({ type: 'error' })
    expect(await run('local-input beam', { textInput: true, secureInput: 'private', capturedInput: { value: '999', sensitive: false } })).toMatchObject({ type: 'error' })
    expect(await settingsManager.loadSettings('@openacp/speech')).toEqual({})
  })

  it('switches providers immediately while preserving the existing TTS provider', async () => {
    const { run, settingsManager, service } = harness()
    expect(service.isTTSAvailable()).toBe(true)
    await run('provider-set local-whisper')
    expect((await settingsManager.loadSettings('@openacp/speech')).sttProvider).toBe('local-whisper')
    expect(service.isSTTAvailable()).toBe(true)
    expect(service.isTTSAvailable()).toBe(true)
  })

  it('clears the Groq key from disk and turns Groq off immediately', async () => {
    const { run, settingsManager, service } = harness()
    await settingsManager.updatePluginSettings('@openacp/speech', { sttProvider: 'groq', groqApiKey: 'gsk_delete_me' })
    service.refreshProviders(buildSpeechServiceConfig(await settingsManager.loadSettings('@openacp/speech')))
    expect(service.isSTTAvailable()).toBe(true)
    await run('groq-clear-confirm')
    const settings = await settingsManager.loadSettings('@openacp/speech')
    expect(settings.groqApiKey).toBeUndefined()
    expect(settings.sttProvider).toBeNull()
    expect(service.isSTTAvailable()).toBe(false)
    expect(readFileSync(settingsManager.getSettingsPath('@openacp/speech'), 'utf8')).not.toContain('gsk_delete_me')
  })
})
