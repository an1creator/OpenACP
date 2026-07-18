import { afterEach, describe, it, expect, vi } from "vitest";
import speechPlugin from "../index.js";
import { GroqSTT } from '../providers/groq.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsManager } from '../../../core/plugin/settings-manager.js'
import { createInstallContext } from '../../../core/plugin/install-context.js'
import { SpeechService } from '../speech-service.js'
import { buildSpeechServiceConfig } from '../native-stt.js'

afterEach(() => vi.restoreAllMocks())

function makePluginCtx(overrides: {
  pluginConfig?: Record<string, unknown>
  core?: unknown
}) {
  let registeredService: SpeechService | undefined;

  const ctx = {
    pluginConfig: overrides.pluginConfig ?? {},
    instanceRoot: undefined,
    registerService: vi.fn((_, svc) => { registeredService = svc as SpeechService }),
    registerCommand: vi.fn(),
    registerEditableFields: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    core: overrides.core,
    sessions: undefined,
  } as any;

  return { ctx, getService: () => registeredService };
}

describe("speech plugin setup()", () => {
  it('migrates only the persisted 1.0.0 timeout default to the safer value', async () => {
    expect(speechPlugin.version).toBe('1.0.1')
    await expect(speechPlugin.migrate!({} as any, { localWhisperTimeoutMs: 120_000, keep: true }, '1.0.0'))
      .resolves.toEqual({ localWhisperTimeoutMs: 600_000, keep: true })
  })

  it.each([undefined, 1_000, 300_000, 600_000])('preserves an absent or non-legacy-value 1.0.0 timeout (%s)', async (timeout) => {
    const settings = timeout === undefined ? { keep: true } : { localWhisperTimeoutMs: timeout, keep: true }
    await expect(speechPlugin.migrate!({} as any, settings, '1.0.0')).resolves.toEqual(settings)
  })

  it('does not reapply the legacy migration on a future version mismatch', async () => {
    await expect(speechPlugin.migrate!({} as any, { localWhisperTimeoutMs: 120_000 }, '1.0.1'))
      .resolves.toEqual({ localWhisperTimeoutMs: 120_000 })
  })

  it('recovers a non-object legacy settings payload to an empty settings object', async () => {
    await expect(speechPlugin.migrate!({} as any, null, '1.0.0')).resolves.toEqual({})
  })

  it("enables STT when groqApiKey is in plugin settings", async () => {
    const { ctx, getService } = makePluginCtx({
      pluginConfig: { groqApiKey: "gsk_from_settings" },
    });

    await speechPlugin.setup!(ctx);

    expect(getService()!.isSTTAvailable()).toBe(true);
    expect(ctx.log.warn).not.toHaveBeenCalled();
  });

  it("disables STT when groqApiKey is missing from plugin settings", async () => {
    const { ctx, getService } = makePluginCtx({
      pluginConfig: { sttProvider: "groq" }, // no groqApiKey
    });

    await speechPlugin.setup!(ctx);

    expect(getService()!.isSTTAvailable()).toBe(false);
  });

  it("enables native local Whisper without an API key", async () => {
    const { ctx, getService } = makePluginCtx({
      pluginConfig: { sttProvider: "local-whisper", localWhisperModel: "base" },
    });

    await speechPlugin.setup!(ctx);

    expect(getService()!.isSTTAvailable()).toBe(true);
    expect(ctx.registerEditableFields).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: 'sttProvider', options: ['local-whisper', 'groq'] }),
        expect.objectContaining({ key: 'localWhisperModel', hotReload: true }),
      ]),
    );
    expect(ctx.registerEditableFields).toHaveBeenCalledWith(
      expect.not.arrayContaining([expect.objectContaining({ key: 'localWhisperScriptPath' })]),
    );
  });

  it('keeps Groq requests separate from local runtime/model downloads', async () => {
    const createFetch = vi.fn(() => globalThis.fetch)
    const buildChildEnv = vi.fn(() => ({}))
    const { ctx } = makePluginCtx({
      pluginConfig: { sttProvider: 'groq', groqApiKey: 'gsk_test' },
      core: {
        proxyService: { createFetch, buildChildEnv },
        lifecycleManager: { serviceRegistry: { get: vi.fn() } },
      },
    })

    await speechPlugin.setup!(ctx)

    expect(createFetch).toHaveBeenCalledWith('services.speech')
    expect(buildChildEnv).not.toHaveBeenCalled()
    expect(ctx.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: 'speech' }))
  })
});

describe('speech plugin terminal configuration', () => {
  it('replaces a saved Groq key through hidden password input without prefilling the old key', async () => {
    vi.spyOn(GroqSTT.prototype, 'checkAccess').mockResolvedValue({ ok: true, status: 200, message: 'accepted' })
    const values = new Map<string, unknown>([['groqApiKey', 'gsk_old_secret'], ['sttProvider', 'groq']])
    const select = vi.fn()
      .mockResolvedValueOnce('stt')
      .mockResolvedValueOnce('groq')
      .mockResolvedValueOnce('replace')
    const password = vi.fn().mockResolvedValue('gsk_new_secret')
    const text = vi.fn()
    const transact = vi.fn(async (prepare: (current: Record<string, unknown>) => any) => {
      const plan = await prepare(Object.fromEntries(values))
      values.clear()
      for (const [key, value] of Object.entries(plan.settings)) values.set(key, value)
      return plan.result
    })
    const settings = {
      getAll: vi.fn(async () => Object.fromEntries(values)),
    }
    await speechPlugin.configure!({
      terminal: {
        select, password, text,
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
      },
      settings,
      transactSettings: transact,
    } as any)
    expect(password).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('hidden') }))
    expect(JSON.stringify(password.mock.calls)).not.toContain('gsk_old_secret')
    expect(text).not.toHaveBeenCalled()
    expect(transact).toHaveBeenCalledTimes(1)
    expect(Object.fromEntries(values)).toEqual({ groqApiKey: 'gsk_new_secret', sttProvider: 'groq' })
  })

  it('keeps the exact configure snapshot when credential input is cancelled', async () => {
    const snapshot = { groqApiKey: 'gsk_old', sttProvider: 'local-whisper', localWhisperModel: 'base' }
    const select = vi.fn()
      .mockResolvedValueOnce('stt')
      .mockResolvedValueOnce('groq')
      .mockResolvedValueOnce('replace')
    const settings = { getAll: vi.fn(async () => ({ ...snapshot })) }
    const transactSettings = vi.fn()

    await expect(speechPlugin.configure!({
      terminal: {
        select, password: vi.fn().mockRejectedValue(new Error('cancelled')), text: vi.fn(),
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
      },
      settings,
      transactSettings,
    } as any)).rejects.toThrow('cancelled')

    expect(transactSettings).not.toHaveBeenCalled()
    await expect(settings.getAll()).resolves.toEqual(snapshot)
  })

  it('checks a replacement Groq candidate before the single configure save', async () => {
    const checkAccess = vi.spyOn(GroqSTT.prototype, 'checkAccess').mockResolvedValue({ ok: false, status: 401, message: 'rejected' })
    const snapshot = { groqApiKey: 'gsk_old', sttProvider: 'local-whisper' }
    const settings = { getAll: vi.fn(async () => ({ ...snapshot })) }
    const transactSettings = vi.fn()

    await expect(speechPlugin.configure!({
      terminal: {
        select: vi.fn()
          .mockResolvedValueOnce('stt')
          .mockResolvedValueOnce('groq')
          .mockResolvedValueOnce('replace'),
        password: vi.fn().mockResolvedValue('gsk_candidate'), text: vi.fn(),
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
      },
      settings,
      transactSettings,
    } as any)).rejects.toThrow('Groq API key was not saved')

    expect(checkAccess).toHaveBeenCalledTimes(1)
    expect(transactSettings).not.toHaveBeenCalled()
    await expect(settings.getAll()).resolves.toEqual(snapshot)
  })

  it('checks a Groq candidate before install persists any speech settings', async () => {
    vi.spyOn(GroqSTT.prototype, 'checkAccess').mockResolvedValue({ ok: false, status: 401, message: 'rejected' })
    const settings = { getAll: vi.fn(async () => ({})) }
    const transactSettings = vi.fn()
    const select = vi.fn().mockResolvedValueOnce('groq')

    await expect(speechPlugin.install!({
      terminal: {
        confirm: vi.fn().mockResolvedValue(true), select,
        password: vi.fn().mockResolvedValue('gsk_candidate'), text: vi.fn(),
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
      },
      settings,
      transactSettings,
    } as any)).rejects.toThrow('Groq API key was not saved')

    expect(transactSettings).not.toHaveBeenCalled()
    expect(select).toHaveBeenCalledTimes(1)
  })

  it('preserves an unrelated update from another manager while the terminal wizard is open', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-terminal-merge-'))
    try {
      const basePath = path.join(root, 'plugins', 'data')
      const wizardManager = new SettingsManager(basePath)
      const telegramManager = new SettingsManager(basePath)
      const initial = { sttProvider: 'local-whisper', localWhisperLanguage: 'ru', localWhisperModel: 'base' }
      await wizardManager.updatePluginSettings('@openacp/speech', initial)
      const ctx = createInstallContext({ pluginName: '@openacp/speech', settingsManager: wizardManager, basePath })
      const select = vi.fn().mockResolvedValueOnce('stt').mockResolvedValueOnce('local-whisper')
      const text = vi.fn()
        .mockImplementationOnce(async () => {
          await telegramManager.updatePluginSettings('@openacp/speech', { telegramMarker: 'preserve-me' })
          return 'en'
        })
        .mockResolvedValueOnce('small')
      ctx.terminal = {
        select, text, password: vi.fn(), confirm: vi.fn(), multiselect: vi.fn(),
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
        spinner: () => ({ start: vi.fn(), stop: vi.fn(), fail: vi.fn() }), note: vi.fn(), cancel: vi.fn(),
      }

      await speechPlugin.configure!(ctx)

      await expect(wizardManager.loadSettings('@openacp/speech')).resolves.toEqual({
        sttProvider: 'local-whisper',
        localWhisperLanguage: 'en',
        localWhisperModel: 'small',
        telegramMarker: 'preserve-me',
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('merges an unrelated concurrent update during install instead of replacing the fresh snapshot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-terminal-install-'))
    try {
      const basePath = path.join(root, 'plugins', 'data')
      const installerManager = new SettingsManager(basePath)
      const otherManager = new SettingsManager(basePath)
      const ctx = createInstallContext({ pluginName: '@openacp/speech', settingsManager: installerManager, basePath })
      ctx.terminal = {
        confirm: vi.fn().mockImplementation(async () => {
          await otherManager.updatePluginSettings('@openacp/speech', { connectorMarker: 'preserve-me' })
          return true
        }),
        select: vi.fn().mockResolvedValueOnce('local-whisper').mockResolvedValueOnce('none'),
        text: vi.fn().mockResolvedValueOnce('ru').mockResolvedValueOnce('small'),
        password: vi.fn(), multiselect: vi.fn(),
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
        spinner: () => ({ start: vi.fn(), stop: vi.fn(), fail: vi.fn() }), note: vi.fn(), cancel: vi.fn(),
      }

      await speechPlugin.install!(ctx)

      await expect(installerManager.loadSettings('@openacp/speech')).resolves.toMatchObject({
        connectorMarker: 'preserve-me',
        sttProvider: 'local-whisper',
        localWhisperLanguage: 'ru',
        localWhisperModel: 'small',
        ttsProvider: null,
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('aborts when another manager changes the validated Groq field and leaves disk and runtime untouched', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-terminal-conflict-'))
    try {
      const basePath = path.join(root, 'plugins', 'data')
      const wizardManager = new SettingsManager(basePath)
      const telegramManager = new SettingsManager(basePath)
      const initial = { sttProvider: 'local-whisper', localWhisperModel: 'base', groqApiKey: 'gsk_old' }
      await wizardManager.updatePluginSettings('@openacp/speech', initial)
      const activeProvider = { name: 'local-whisper', transcribe: vi.fn().mockResolvedValue({ text: 'old-runtime' }) }
      const service = new SpeechService(buildSpeechServiceConfig(initial))
      service.setProviderFactory(() => ({ stt: new Map([['local-whisper', activeProvider]]), tts: new Map() }))
      service.refreshProviders(buildSpeechServiceConfig(initial))
      vi.spyOn(GroqSTT.prototype, 'checkAccess').mockImplementation(async () => {
        await telegramManager.updatePluginSettings('@openacp/speech', { groqApiKey: 'gsk_concurrent' })
        return { ok: true, status: 200, message: 'accepted' }
      })
      const ctx = createInstallContext({ pluginName: '@openacp/speech', settingsManager: wizardManager, basePath })
      ctx.terminal = {
        select: vi.fn().mockResolvedValueOnce('stt').mockResolvedValueOnce('groq').mockResolvedValueOnce('replace'),
        password: vi.fn().mockResolvedValue('gsk_candidate'), text: vi.fn(), confirm: vi.fn(), multiselect: vi.fn(),
        log: { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn(), step: vi.fn() },
        spinner: () => ({ start: vi.fn(), stop: vi.fn(), fail: vi.fn() }), note: vi.fn(), cancel: vi.fn(),
      }

      await expect(speechPlugin.configure!(ctx)).rejects.toThrow('changed while this wizard was open')

      await expect(wizardManager.loadSettings('@openacp/speech')).resolves.toEqual({
        ...initial,
        groqApiKey: 'gsk_concurrent',
      })
      await expect(service.transcribe(Buffer.from('audio'), 'audio/wav')).resolves.toEqual({ text: 'old-runtime' })
      expect(activeProvider.transcribe).toHaveBeenCalledOnce()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
