import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  const scopedFetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
  const core = {
    settingsManager,
    proxyService: { createFetch: vi.fn(() => scopedFetch as typeof fetch) },
    lifecycleManager: { serviceRegistry: { get: vi.fn((name: string) => name === 'identity' ? identity : undefined) } },
  } as unknown as OpenACPCore
  const service = new SpeechService(buildSpeechServiceConfig({ ttsProvider: 'edge-tts' }))
  service.setProviderFactory(() => ({ stt: new Map(), tts: new Map() }))
  service.registerTTSProvider('edge-tts', { name: 'edge-tts', synthesize: vi.fn() } as unknown as TTSProvider)
  registerSpeechSettingsCommand(ctx, core, service, {
    getLocalReadiness: () => ({ ready: runtime, script: runtime ? 'ready' : 'missing', runtimeReady: runtime }),
  })
  const run = (raw: string, interaction?: CommandArgs['interaction'], overrides: Partial<CommandArgs> = {}) => command!.handler({
    raw, sessionId: null, channelId: 'telegram', userId: '42', interaction,
    reply: vi.fn(),
    ...overrides,
  })
  return { run, settingsManager, service, root, scopedFetch }
}

describe('connector-neutral speech settings command', () => {
  it('fails closed for a member or missing identity before returning status', async () => {
    expect(await harness('member').run('')).toEqual({ type: 'error', message: SPEECH_CAPABILITY_ERROR })
    expect(await harness(null).run('review')).toEqual({ type: 'error', message: SPEECH_CAPABILITY_ERROR })
  })

  it('reports missing local dependencies without exposing host paths', async () => {
    const response = await harness('admin', false).run('provider-set local-whisper')
    expect(response).toMatchObject({ type: 'menu' })
    expect(JSON.stringify(response)).toContain('configured transcription executable')
    expect(JSON.stringify(response)).not.toContain('/home/')
  })

  it('stores a Groq key only through secure captured input and keeps reviews redacted', async () => {
    const { run, settingsManager, service } = harness()
    const request = await run('groq-set', { textInput: true, secureInput: 'delete-after-capture' })
    expect(request).toMatchObject({ type: 'input', sensitive: true, command: '/speech groq-input' })
    const secret = 'gsk_test_secret_value'
    const verified = await run('groq-input', { textInput: true, secureInput: 'delete-after-capture', capturedInput: { value: secret, sensitive: true } }) as any
    expect(JSON.stringify(verified)).not.toContain(secret)
    expect(await settingsManager.loadSettings('@openacp/speech')).toEqual({})
    const save = verified.options.find((option: any) => option.label === 'Save and use Groq')
    expect(save.command).not.toContain(secret)
    const stored = await run(save.command.replace('/speech ', ''))
    expect(JSON.stringify(stored)).not.toContain(secret)
    expect((await settingsManager.loadSettings('@openacp/speech')).groqApiKey).toBe(secret)
    expect((await settingsManager.loadSettings('@openacp/speech')).sttProvider).toBe('groq')
    expect(service.isSTTAvailable()).toBe(true)
    const review = await run('review')
    expect(JSON.stringify(review)).toContain('Saved (hidden)')
    expect(JSON.stringify(review)).not.toContain(secret)
  })

  it('discards a rejected candidate key and preserves the active key and provider', async () => {
    const { run, settingsManager, service, scopedFetch } = harness()
    await settingsManager.updatePluginSettings('@openacp/speech', { sttProvider: 'groq', groqApiKey: 'gsk_current' })
    service.refreshProviders(buildSpeechServiceConfig(await settingsManager.loadSettings('@openacp/speech')))
    scopedFetch.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    const result = await run('groq-input', {
      textInput: true,
      secureInput: 'delete-after-capture',
      capturedInput: { value: 'gsk_rejected', sensitive: true },
    })
    expect(JSON.stringify(result)).not.toContain('gsk_rejected')
    expect(result).toMatchObject({ type: 'menu' })
    expect(await settingsManager.loadSettings('@openacp/speech')).toMatchObject({ sttProvider: 'groq', groqApiKey: 'gsk_current' })
    expect(service.isSTTAvailable()).toBe(true)
  })

  it('binds a verified candidate key to the originating user and conversation', async () => {
    const { run, settingsManager } = harness()
    const verified = await run('groq-input', {
      textInput: true,
      secureInput: 'delete-after-capture',
      capturedInput: { value: 'gsk_candidate', sensitive: true },
    }) as any
    const save = verified.options.find((option: any) => option.label === 'Save key only').command as string
    const command = save.replace('/speech ', '')
    const result = await run(command, undefined, { userId: '99', conversationId: 'other-topic' })
    expect(result).toMatchObject({ type: 'menu' })
    expect(await settingsManager.loadSettings('@openacp/speech')).toEqual({})
  })

  it('rejects insecure Groq capture and invalid local values without writing them', async () => {
    const { run, settingsManager } = harness()
    expect(await run('groq-input', { textInput: true, secureInput: 'none', capturedInput: { value: 'gsk_nope', sensitive: true } })).toMatchObject({ type: 'menu' })
    expect(await run('local-input beam', { textInput: true, secureInput: 'private', capturedInput: { value: '999', sensitive: false } })).toMatchObject({ type: 'menu' })
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

  it('serializes concurrent local callbacks against fresh settings without losing either update', async () => {
    const { run, settingsManager } = harness()
    await Promise.all([
      run('local-set language en'),
      run('local-set model small'),
      run('local-set beam 7'),
    ])
    await expect(settingsManager.loadSettings('@openacp/speech')).resolves.toMatchObject({
      localWhisperLanguage: 'en',
      localWhisperModel: 'small',
      localWhisperBeamSize: 7,
    })
  })

  it('retries a settings CAS conflict before swapping the active Speech runtime', async () => {
    const { run, settingsManager, service } = harness()
    const oldProvider = { name: 'local-whisper', transcribe: vi.fn().mockResolvedValue({ text: 'old-runtime' }) }
    const newProvider = { name: 'local-whisper', transcribe: vi.fn().mockResolvedValue({ text: 'new-runtime' }) }
    service.setProviderFactory((config) => ({
      stt: config.stt.provider === 'local-whisper'
        ? new Map([['local-whisper', config.stt.providers['local-whisper']?.model === 'small' ? newProvider : oldProvider]])
        : new Map(),
      tts: new Map(),
    }))
    const before = { sttProvider: 'local-whisper', localWhisperModel: 'base', ttsProvider: 'edge-tts' }
    await settingsManager.updatePluginSettings('@openacp/speech', before)
    service.refreshProviders(buildSpeechServiceConfig(before))
    const settingsPath = settingsManager.getSettingsPath('@openacp/speech')
    const prepare = service.prepareProviderRefresh.bind(service)
    let attempts = 0
    vi.spyOn(service, 'prepareProviderRefresh').mockImplementation((config) => {
      attempts += 1
      const prepared = prepare(config)
      if (attempts === 1) {
        writeFileSync(settingsPath, `${JSON.stringify({ ...before, concurrentMarker: 'preserve-me' })}\n`, { mode: 0o600 })
      }
      return prepared
    })

    const response = await run('local-set model small')

    expect(response).toMatchObject({ type: 'menu' })
    expect(attempts).toBe(2)
    await expect(settingsManager.loadSettings('@openacp/speech')).resolves.toMatchObject({
      concurrentMarker: 'preserve-me',
      localWhisperModel: 'small',
    })
    await expect(service.transcribe(Buffer.from('audio'), 'audio/wav')).resolves.toEqual({ text: 'new-runtime' })
    expect(oldProvider.transcribe).not.toHaveBeenCalled()
  })

  it('rolls back the exact saved settings and active runtime when provider preparation fails', async () => {
    const { run, settingsManager, service } = harness()
    const activeProvider = { name: 'local-whisper', transcribe: vi.fn().mockResolvedValue({ text: 'still-active' }) }
    let fail = false
    service.setProviderFactory((config) => {
      if (fail) throw new Error('provider construction failed')
      return {
        stt: config.stt.provider === 'local-whisper' ? new Map([['local-whisper', activeProvider]]) : new Map(),
        tts: new Map(),
      }
    })
    const before = { sttProvider: 'local-whisper', localWhisperModel: 'base', ttsProvider: 'edge-tts' }
    await settingsManager.updatePluginSettings('@openacp/speech', before)
    service.refreshProviders(buildSpeechServiceConfig(before))
    fail = true

    const response = await run('local-set model small')

    expect(JSON.stringify(response)).toContain('previous saved settings and active runtime were restored')
    await expect(settingsManager.loadSettings('@openacp/speech')).resolves.toEqual(before)
    await expect(service.transcribe(Buffer.from('audio'), 'audio/wav')).resolves.toEqual({ text: 'still-active' })
    expect(service.isTTSAvailable()).toBe(true)
  })

  it('restores the exact prior runtime and settings when a post-persist swap fails', async () => {
    const { run, settingsManager, service } = harness()
    const oldProvider = { name: 'local-whisper', transcribe: vi.fn().mockResolvedValue({ text: 'old-runtime' }) }
    const newProvider = { name: 'local-whisper', transcribe: vi.fn().mockResolvedValue({ text: 'new-runtime' }) }
    service.setProviderFactory((config) => ({
      stt: config.stt.provider === 'local-whisper'
        ? new Map([['local-whisper', config.stt.providers['local-whisper']?.model === 'small' ? newProvider : oldProvider]])
        : new Map(),
      tts: new Map(),
    }))
    const before = { sttProvider: 'local-whisper', localWhisperModel: 'base', ttsProvider: 'edge-tts' }
    await settingsManager.updatePluginSettings('@openacp/speech', before)
    service.refreshProviders(buildSpeechServiceConfig(before))
    const prepare = service.prepareProviderRefresh.bind(service)
    vi.spyOn(service, 'prepareProviderRefresh').mockImplementation((config) => {
      const prepared = prepare(config)
      return {
        commit: () => {
          prepared.commit()
          throw new Error('post-persist swap failed')
        },
        rollback: () => prepared.rollback(),
      }
    })

    const response = await run('local-set model small')

    expect(JSON.stringify(response)).toContain('previous saved settings and active runtime were restored')
    await expect(settingsManager.loadSettings('@openacp/speech')).resolves.toEqual(before)
    await expect(service.transcribe(Buffer.from('audio'), 'audio/wav')).resolves.toEqual({ text: 'old-runtime' })
    expect(newProvider.transcribe).not.toHaveBeenCalled()
    expect(service.isTTSAvailable()).toBe(true)
  })

  it('consumes a verified Groq save callback once and rejects a concurrent replay', async () => {
    const { run, settingsManager } = harness()
    const verified = await run('groq-input', {
      textInput: true,
      secureInput: 'delete-after-capture',
      capturedInput: { value: 'gsk_once', sensitive: true },
    }) as any
    const command = verified.options.find((option: any) => option.label === 'Save and use Groq').command.replace('/speech ', '')
    const transaction = vi.spyOn(settingsManager, 'transactPluginSettings')

    const responses = await Promise.all([run(command), run(command)])

    expect(transaction).toHaveBeenCalledTimes(1)
    expect(responses.filter((response) => JSON.stringify(response).includes('now selected'))).toHaveLength(1)
    expect(responses.filter((response) => JSON.stringify(response).includes('already used'))).toHaveLength(1)
    await expect(settingsManager.loadSettings('@openacp/speech')).resolves.toMatchObject({ groqApiKey: 'gsk_once', sttProvider: 'groq' })
  })

  it('discards a verified Groq draft when settings changed after verification', async () => {
    const { run, settingsManager } = harness()
    const verified = await run('groq-input', {
      textInput: true,
      secureInput: 'delete-after-capture',
      capturedInput: { value: 'gsk_stale', sensitive: true },
    }) as any
    const command = verified.options.find((option: any) => option.label === 'Save key only').command.replace('/speech ', '')
    await settingsManager.updatePluginSettings('@openacp/speech', { localWhisperModel: 'small' })

    const response = await run(command)

    expect(JSON.stringify(response)).toContain('stale draft was discarded')
    await expect(settingsManager.loadSettings('@openacp/speech')).resolves.toEqual({ localWhisperModel: 'small' })
  })

  it('shows legacy key-only Groq activation consistently with runtime configuration', async () => {
    const { run, settingsManager } = harness()
    await settingsManager.updatePluginSettings('@openacp/speech', { groqApiKey: 'gsk_legacy' })
    const home = await run('') as any
    expect(home.title).toContain('On — Groq selected')
    expect(home.options.map((option: any) => option.label)).toEqual(['Transcription method', 'Settings & access', 'Check setup'])
    const settings = await run('settings') as any
    expect(settings.options).toContainEqual(expect.objectContaining({ label: 'Groq cloud · Key saved' }))
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
