import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const prompt = vi.hoisted(() => ({
  confirm: vi.fn(),
  select: vi.fn(),
  password: vi.fn(),
  text: vi.fn(),
}))
const installNpmPlugin = vi.hoisted(() => vi.fn())

vi.mock('@clack/prompts', () => ({
  confirm: prompt.confirm,
  select: prompt.select,
  password: prompt.password,
  text: prompt.text,
  multiselect: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  note: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('../../../core/plugin/plugin-installer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../core/plugin/plugin-installer.js')>(),
  installNpmPlugin,
}))

describe('speech plugin CLI uses instance-scoped proxy routes', () => {
  let instanceRoot: string

  beforeEach(() => {
    instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-speech-cli-'))
    vi.clearAllMocks()
  })

  afterEach(() => {
    fs.rmSync(instanceRoot, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('configures Groq through services.speech and leaves settings unchanged when validation fails', async () => {
    const { SettingsManager } = await import('../../../core/plugin/settings-manager.js')
    const settings = new SettingsManager(path.join(instanceRoot, 'plugins', 'data'))
    await settings.updatePluginSettings('@openacp/speech', { sttProvider: 'local-whisper', localWhisperModel: 'small' })

    prompt.select.mockResolvedValueOnce('stt').mockResolvedValueOnce('groq')
    prompt.password.mockResolvedValue('gsk_rejected')

    const { ProxyService } = await import('../../../core/network/proxy-service.js')
    const scopedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }))
    const createFetch = vi.spyOn(ProxyService.prototype, 'createFetch').mockReturnValue(scopedFetch)
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unscoped fetch must not be used'))

    const { cmdPlugin } = await import('../plugins.js')
    await expect(cmdPlugin(['configure', '@openacp/speech'], instanceRoot)).rejects.toThrow('Groq rejected the API key')

    expect(createFetch).toHaveBeenCalledWith('services.speech')
    expect(scopedFetch).toHaveBeenCalledOnce()
    expect(globalFetch).not.toHaveBeenCalled()
    await expect(settings.loadSettings('@openacp/speech')).resolves.toEqual({
      sttProvider: 'local-whisper',
      localWhisperModel: 'small',
    })
  })

  it('installs built-in Speech with scoped Groq validation and plugin downloads', async () => {
    prompt.confirm.mockResolvedValue(true)
    prompt.select.mockResolvedValueOnce('groq').mockResolvedValueOnce('edge-tts')
    prompt.password.mockResolvedValue('gsk_valid')
    prompt.text.mockResolvedValue('en-US-AriaNeural')

    const { ProxyService } = await import('../../../core/network/proxy-service.js')
    const scopedFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }))
    vi.spyOn(ProxyService.prototype, 'createFetch').mockReturnValue(scopedFetch)
    const childEnv = { OPENACP_PROXY_TEST: 'scoped' }
    const buildChildEnv = vi.spyOn(ProxyService.prototype, 'buildChildEnv').mockReturnValue(childEnv)
    const globalFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unscoped fetch must not be used'))

    const { cmdPlugin } = await import('../plugins.js')
    await cmdPlugin(['install', '@openacp/speech'], instanceRoot)

    expect(scopedFetch).toHaveBeenCalledOnce()
    expect(globalFetch).not.toHaveBeenCalled()
    expect(buildChildEnv).toHaveBeenCalledWith('services.pluginInstaller', process.env)
    expect(installNpmPlugin).toHaveBeenCalledWith(
      '@openacp/msedge-tts-plugin',
      path.join(instanceRoot, 'plugins'),
      childEnv,
    )
  })
})
