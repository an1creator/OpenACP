import path from 'node:path'
import { createHash } from 'node:crypto'
import type { OpenACPPlugin, InstallContext, PluginContext } from '../../core/plugin/types.js'
import type { OpenACPCore } from '../../core/core.js'
import type { Session } from '../../core/sessions/session.js'
import { SpeechService } from './exports.js'
import {
  LOCAL_WHISPER_DEFAULTS,
  LOCAL_WHISPER_PROVIDER,
  buildSpeechServiceConfig,
  createNativeSTTProviders,
} from './native-stt.js'
import { installNpmPlugin } from '../../core/plugin/plugin-installer.js'
import { registerSpeechSettingsCommand } from './settings-command.js'
import { GroqSTT } from './providers/groq.js'

// TTS is provided by a separate optional plugin so the core speech plugin
// doesn't bundle a large native dependency on every install.
const EDGE_TTS_PLUGIN = '@openacp/msedge-tts-plugin'

async function verifyTerminalGroqCandidate(ctx: InstallContext, key: string): Promise<void> {
  const fetcher = ctx.instanceRoot
    ? new (await import('../../core/network/proxy-service.js')).ProxyService(ctx.instanceRoot).createFetch('services.speech')
    : globalThis.fetch
  const result = await new GroqSTT(key, undefined, fetcher).checkAccess(AbortSignal.timeout(10_000))
  if (!result.ok) throw new Error(`Groq API key was not saved: ${result.message}`)
}

interface TerminalSettingsPlan {
  relevantFields: string[]
  baseDigest: string
  set: Record<string, unknown>
  remove?: string[]
}

export class TerminalSpeechSettingsConflictError extends Error {
  constructor() {
    super('Speech settings changed while this wizard was open. Nothing was saved. Reopen the Speech configurator and review the latest values.')
    this.name = 'TerminalSpeechSettingsConflictError'
  }
}

function relevantSettingsDigest(settings: Record<string, unknown>, fields: string[]): string {
  const snapshot = [...new Set(fields)].sort().map((field) => ({
    field,
    present: Object.prototype.hasOwnProperty.call(settings, field),
    value: settings[field],
  }))
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
}

function terminalSettingsPlan(
  base: Record<string, unknown>,
  relevantFields: string[],
  set: Record<string, unknown>,
  remove?: string[],
): TerminalSettingsPlan {
  return { relevantFields, baseDigest: relevantSettingsDigest(base, relevantFields), set, remove }
}

async function commitTerminalSettings(ctx: InstallContext, plan: TerminalSettingsPlan): Promise<void> {
  if (!ctx.transactSettings) throw new Error('This OpenACP host does not support transactional terminal settings. Update OpenACP and reopen the Speech configurator.')
  await ctx.transactSettings((current) => {
    if (relevantSettingsDigest(current, plan.relevantFields) !== plan.baseDigest) {
      throw new TerminalSpeechSettingsConflictError()
    }
    const next = { ...current, ...plan.set }
    for (const field of plan.remove ?? []) delete next[field]
    return { settings: next, result: undefined }
  })
}

const speechPlugin: OpenACPPlugin = {
  name: '@openacp/speech',
  version: '1.0.0',
  description: 'Text-to-speech and speech-to-text with pluggable providers',
  essential: false,
  // file-service is needed to persist synthesized audio for adapters that send files
  optionalPluginDependencies: { '@openacp/file-service': '^1.0.0' },
  permissions: ['services:register', 'commands:register', 'kernel:access'],
  inheritableKeys: ['ttsProvider', 'ttsVoice'],

  async install(ctx: InstallContext) {
    const { terminal, settings } = ctx
    const baseSettings = await settings.getAll()
    const pluginsDir = ctx.instanceRoot ? path.join(ctx.instanceRoot, 'plugins') : undefined
    const installEnv = ctx.instanceRoot
      ? new (await import('../../core/network/proxy-service.js')).ProxyService(ctx.instanceRoot).buildChildEnv('services.pluginInstaller', process.env as Record<string, string>)
      : undefined

    // Interactive setup
    const enableStt = await terminal.confirm({
      message: 'Enable voice-message transcription?',
      initialValue: false,
    })

    let sttProvider: string | null = null
    let groqApiKey = ''
    let localWhisperLanguage: string = LOCAL_WHISPER_DEFAULTS.language
    let localWhisperModel: string = LOCAL_WHISPER_DEFAULTS.model

    if (enableStt) {
      sttProvider = await terminal.select({
        message: 'Where should voice messages be transcribed?',
        options: [
          { value: LOCAL_WHISPER_PROVIDER, label: 'Local (on this host)', hint: 'Downloads the model on first use, then processes locally' },
          { value: 'groq', label: 'Groq (cloud)', hint: 'Sends audio to Groq and requires an API key' },
        ],
      })

      if (sttProvider === 'groq') {
        groqApiKey = await terminal.password({
          message: 'Groq API key (input is hidden):',
          validate: (v) => (!v.trim() ? 'API key cannot be empty' : undefined),
        })
        groqApiKey = groqApiKey.trim()
        await verifyTerminalGroqCandidate(ctx, groqApiKey)
      } else {
        localWhisperLanguage = (await terminal.text({
          message: 'Spoken language code (for example ru or en):',
          defaultValue: LOCAL_WHISPER_DEFAULTS.language,
        })).trim() || LOCAL_WHISPER_DEFAULTS.language
        localWhisperModel = (await terminal.text({
          message: 'Local transcription model (downloads on first use):',
          defaultValue: LOCAL_WHISPER_DEFAULTS.model,
        })).trim() || LOCAL_WHISPER_DEFAULTS.model
      }
    }

    const ttsProvider = await terminal.select({
      message: 'TTS provider:',
      options: [
        { value: 'edge-tts', label: 'Edge TTS', hint: 'Free, good quality' },
        { value: 'none', label: 'None (disable TTS)' },
      ],
    })

    let ttsVoice = ''
    if (ttsProvider === 'edge-tts') {
      terminal.log.info('Installing Edge TTS plugin...')
      try {
        await installNpmPlugin(EDGE_TTS_PLUGIN, pluginsDir, installEnv)
        terminal.log.success('Edge TTS plugin installed')
      } catch (err) {
        terminal.log.warning(`Failed to install Edge TTS plugin: ${err}. You can install it later with: openacp plugin install ${EDGE_TTS_PLUGIN}`)
      }

      ttsVoice = await terminal.text({
        message: 'TTS voice (leave blank for default):',
        placeholder: 'e.g. en-US-AriaNeural',
      })
      ttsVoice = ttsVoice.trim()
    }

    const installedSettings = {
      sttProvider,
      groqApiKey,
      localWhisperLanguage,
      localWhisperModel,
      localWhisperBeamSize: LOCAL_WHISPER_DEFAULTS.beamSize,
      localWhisperVadFilter: LOCAL_WHISPER_DEFAULTS.vadFilter,
      localWhisperDevice: LOCAL_WHISPER_DEFAULTS.device,
      localWhisperComputeType: LOCAL_WHISPER_DEFAULTS.computeType,
      localWhisperTimeoutMs: LOCAL_WHISPER_DEFAULTS.timeoutMs,
      ttsProvider: ttsProvider === 'none' ? null : ttsProvider,
      ttsVoice,
    }
    await commitTerminalSettings(ctx, terminalSettingsPlan(
      baseSettings,
      Object.keys(installedSettings),
      installedSettings,
    ))
    terminal.log.success('Speech settings saved. You can change transcription later in Settings → Speech-to-text or with /speech.')
  },

  async configure(ctx: InstallContext) {
    const { terminal, settings } = ctx
    const current = await settings.getAll()

    const choice = await terminal.select({
      message: 'What to configure?',
      options: [
        { value: 'stt', label: 'Speech-to-text method and access' },
        { value: 'tts', label: 'Change TTS provider/voice' },
        { value: 'done', label: 'Done' },
      ],
    })

    if (choice === 'stt') {
      const provider = await terminal.select({
        message: 'Where should voice messages be transcribed?',
        options: [
          { value: LOCAL_WHISPER_PROVIDER, label: 'Local (on this host)', hint: 'Downloads the model on first use, then processes locally' },
          { value: 'groq', label: 'Groq (cloud)', hint: 'Sends audio to Groq and requires an API key' },
          { value: 'none', label: 'Off', hint: 'Do not convert voice messages to text' },
        ],
      })
      const set: Record<string, unknown> = { sttProvider: provider === 'none' ? null : provider }
      const relevantFields = ['sttProvider']
      let remove: string[] | undefined
      if (provider === 'groq') {
        const hasSavedKey = typeof current.groqApiKey === 'string' && current.groqApiKey.trim().length > 0
        relevantFields.push('groqApiKey')
        const keyAction = hasSavedKey
          ? await terminal.select({
              message: 'A Groq API key is saved and hidden. What should OpenACP do?',
              options: [
                { value: 'keep', label: 'Keep saved key' },
                { value: 'replace', label: 'Replace saved key' },
                { value: 'clear', label: 'Clear key and turn transcription off' },
              ],
            })
          : 'replace'
        if (keyAction === 'clear') {
          set.sttProvider = null
          remove = ['groqApiKey']
          await commitTerminalSettings(ctx, terminalSettingsPlan(current, relevantFields, set, remove))
          terminal.log.success('Groq API key cleared. Speech-to-text is off.')
          return
        }
        if (keyAction === 'replace') {
          const key = await terminal.password({
            message: 'New Groq API key (input is hidden):',
            validate: (v) => (!v.trim() ? 'API key cannot be empty' : undefined),
          })
          const candidate = key.trim()
          await verifyTerminalGroqCandidate(ctx, candidate)
          set.groqApiKey = candidate
        }
      } else if (provider === LOCAL_WHISPER_PROVIDER) {
        relevantFields.push('localWhisperLanguage', 'localWhisperModel')
        const language = await terminal.text({
          message: 'Spoken language code (for example ru or en):',
          defaultValue: (current.localWhisperLanguage as string) ?? LOCAL_WHISPER_DEFAULTS.language,
        })
        const model = await terminal.text({
          message: 'Local transcription model (downloads on first use):',
          defaultValue: (current.localWhisperModel as string) ?? LOCAL_WHISPER_DEFAULTS.model,
        })
        set.localWhisperLanguage = language.trim() || LOCAL_WHISPER_DEFAULTS.language
        set.localWhisperModel = model.trim() || LOCAL_WHISPER_DEFAULTS.model
      }
      await commitTerminalSettings(ctx, terminalSettingsPlan(current, relevantFields, set, remove))
      terminal.log.success('Speech-to-text settings updated')
    } else if (choice === 'tts') {
      const voice = await terminal.text({
        message: 'TTS voice (leave blank for default):',
        defaultValue: (current.ttsVoice as string) ?? '',
      })
      await commitTerminalSettings(ctx, terminalSettingsPlan(current, ['ttsVoice'], { ttsVoice: voice.trim() }))
      terminal.log.success('TTS settings updated')
    }
  },

  async uninstall(ctx: InstallContext, opts: { purge: boolean }) {
    if (opts.purge) {
      await ctx.settings.clear()
      ctx.terminal.log.success('Speech settings cleared')
    }
  },

  async setup(ctx) {
    ctx.registerEditableFields([
      { key: 'sttProvider', displayName: 'Speech-to-text method', type: 'select', scope: 'safe', hotReload: true, options: [LOCAL_WHISPER_PROVIDER, 'groq'] },
      { key: 'groqApiKey', displayName: 'Groq API Key', type: 'string', scope: 'sensitive', hotReload: true },
      { key: 'localWhisperLanguage', displayName: 'Local Transcription Language', type: 'string', scope: 'safe', hotReload: true },
      { key: 'localWhisperModel', displayName: 'Local Transcription Model', type: 'string', scope: 'safe', hotReload: true },
      { key: 'localWhisperBeamSize', displayName: 'Local Recognition Beam Size', type: 'number', scope: 'safe', hotReload: true },
      { key: 'localWhisperVadFilter', displayName: 'Local Voice Activity Filter', type: 'toggle', scope: 'safe', hotReload: true },
      { key: 'localWhisperDevice', displayName: 'Local Processing Device', type: 'select', scope: 'safe', hotReload: true, options: ['cpu', 'cuda', 'auto'] },
      { key: 'localWhisperComputeType', displayName: 'Local Compute Type', type: 'string', scope: 'safe', hotReload: true },
      { key: 'localWhisperTimeoutMs', displayName: 'Local Processing Time Limit (ms)', type: 'number', scope: 'safe', hotReload: true },
      { key: 'ttsProvider', displayName: 'Text to Speech', type: 'select', scope: 'safe', hotReload: true, options: ['edge-tts'] },
    ])

    const pluginsDir = ctx.instanceRoot ? path.join(ctx.instanceRoot, 'plugins') : undefined
    const config = ctx.pluginConfig as Record<string, unknown>
    const speechConfig = buildSpeechServiceConfig(config)
    const core = ctx.core as OpenACPCore | undefined
    // `ctx.core` is absent in standalone plugin validation and older embedding
    // hosts. A normal OpenACP boot always supplies ProxyService; corruption still
    // throws here and remains fail-closed rather than falling through.
    const network = core?.proxyService ? {
      getFetch: () => core.proxyService.createFetch('services.speech'),
      getChildEnv: () => core.proxyService.buildChildEnv('services.speechDownloads', process.env as Record<string, string>),
    } : undefined
    const pluginInstallEnv = core?.proxyService
      ? () => core.proxyService.buildChildEnv('services.pluginInstaller', process.env as Record<string, string>)
      : undefined

    const service = new SpeechService(speechConfig)

    // TTS provider is now registered by @openacp/msedge-tts-plugin (no EdgeTTS here)

    // Register provider factory for hot-reload (STT only — TTS providers are managed by external plugins)
    service.setProviderFactory((cfg) => ({ stt: createNativeSTTProviders(cfg, network), tts: new Map() }))
    service.refreshProviders(speechConfig)

    ctx.registerService('speech', service)
    if (core) registerSpeechSettingsCommand(ctx, core, service)

    // Helper to look up the session and set voiceMode
    const setSessionVoiceMode = (pluginCtx: PluginContext, sessionId: string | null, voiceMode: 'off' | 'next' | 'on'): void => {
      if (!sessionId) return
      try {
        const sessionManager = pluginCtx.sessions as { getSession(id: string): Session | undefined }
        const session = sessionManager.getSession(sessionId)
        if (session) {
          session.setVoiceMode(voiceMode)
        }
      } catch {
        // Session lookup may fail if kernel:access is unavailable; silently ignore
      }
    }

    ctx.registerCommand({
      name: 'tts',
      description: 'Toggle text-to-speech',
      usage: 'on|off|next|install',
      category: 'plugin',
      handler: async (args) => {
        const mode = args.raw.trim().toLowerCase()

        // Check if TTS provider is available
        if ((mode === 'on' || mode === '' || mode === 'next') && !service.isTTSAvailable()) {
          return {
            type: 'menu' as const,
            title: 'TTS provider not installed. Install Edge TTS plugin?',
            options: [
              { label: 'Install Edge TTS', command: '/tts install' },
              { label: 'Cancel', command: '/tts off' },
            ],
          }
        }

        if (mode === 'install') {
          try {
            const mod = pluginInstallEnv
              ? await installNpmPlugin(EDGE_TTS_PLUGIN, pluginsDir, pluginInstallEnv())
              : await installNpmPlugin(EDGE_TTS_PLUGIN, pluginsDir)
            const plugin = mod.default
            if (plugin && ctx.core) {
              // Boot the newly installed plugin without restarting the process
              const lm = (ctx.core as OpenACPCore).lifecycleManager
              const registry = lm.registry
              if (registry) {
                registry.register(plugin.name, {
                  version: plugin.version,
                  source: 'npm',
                  enabled: true,
                  settingsPath: '',
                  description: plugin.description,
                })
                await registry.save()
              }
              await lm.boot([plugin])
            }
            return { type: 'text' as const, text: 'Edge TTS plugin installed and ready! Use /tts on to enable.' }
          } catch (err) {
            return { type: 'error' as const, message: `Failed to install Edge TTS plugin: ${err}. Try manually: openacp plugin install ${EDGE_TTS_PLUGIN}` }
          }
        }

        if (mode === 'on') {
          setSessionVoiceMode(ctx, args.sessionId, 'on')
          return { type: 'text' as const, text: 'Text-to-speech enabled' }
        }
        if (mode === 'off') {
          setSessionVoiceMode(ctx, args.sessionId, 'off')
          return { type: 'text' as const, text: 'Text-to-speech disabled' }
        }
        if (mode === 'next') {
          setSessionVoiceMode(ctx, args.sessionId, 'next')
          return { type: 'text' as const, text: 'Text-to-speech enabled for next message' }
        }
        return { type: 'menu' as const, title: 'Text to Speech', options: [
          { label: 'Enable', command: '/tts on' },
          { label: 'Disable', command: '/tts off' },
          { label: 'Next message only', command: '/tts next' },
        ]}
      },
    })

    ctx.log.info('Speech service ready')
  },
}

export default speechPlugin
