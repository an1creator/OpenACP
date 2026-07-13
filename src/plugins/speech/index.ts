import path from 'node:path'
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

// TTS is provided by a separate optional plugin so the core speech plugin
// doesn't bundle a large native dependency on every install.
const EDGE_TTS_PLUGIN = '@openacp/msedge-tts-plugin'

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
    const pluginsDir = ctx.instanceRoot ? path.join(ctx.instanceRoot, 'plugins') : undefined
    const installEnv = ctx.instanceRoot
      ? new (await import('../../core/network/proxy-service.js')).ProxyService(ctx.instanceRoot).buildChildEnv('services.pluginInstaller', process.env as Record<string, string>)
      : undefined

    // Interactive setup
    const enableStt = await terminal.confirm({
      message: 'Enable speech-to-text (STT)?',
      initialValue: false,
    })

    let sttProvider: string | null = null
    let groqApiKey = ''
    let localWhisperLanguage: string = LOCAL_WHISPER_DEFAULTS.language
    let localWhisperModel: string = LOCAL_WHISPER_DEFAULTS.model

    if (enableStt) {
      sttProvider = await terminal.select({
        message: 'STT provider:',
        options: [
          { value: LOCAL_WHISPER_PROVIDER, label: 'Local faster-whisper', hint: 'Private and offline after the first model download' },
          { value: 'groq', label: 'Groq (Whisper)', hint: 'Hosted API, requires an API key' },
        ],
      })

      if (sttProvider === 'groq') {
        groqApiKey = await terminal.text({
          message: 'Groq API key:',
          validate: (v) => (!v.trim() ? 'API key cannot be empty' : undefined),
        })
        groqApiKey = groqApiKey.trim()
      } else {
        localWhisperLanguage = (await terminal.text({
          message: 'Local Whisper language:',
          defaultValue: LOCAL_WHISPER_DEFAULTS.language,
        })).trim() || LOCAL_WHISPER_DEFAULTS.language
        localWhisperModel = (await terminal.text({
          message: 'Local Whisper model:',
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

    await settings.setAll({
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
    })
    terminal.log.success('Speech settings saved')
  },

  async configure(ctx: InstallContext) {
    const { terminal, settings } = ctx
    const current = await settings.getAll()

    const choice = await terminal.select({
      message: 'What to configure?',
      options: [
        { value: 'stt', label: 'Change STT provider/key' },
        { value: 'tts', label: 'Change TTS provider/voice' },
        { value: 'done', label: 'Done' },
      ],
    })

    if (choice === 'stt') {
      const provider = await terminal.select({
        message: 'STT provider:',
        options: [
          { value: LOCAL_WHISPER_PROVIDER, label: 'Local faster-whisper', hint: 'Private and offline after the first model download' },
          { value: 'groq', label: 'Groq (Whisper)', hint: 'Hosted API, requires an API key' },
          { value: 'none', label: 'None (disable STT)' },
        ],
      })
      await settings.set('sttProvider', provider === 'none' ? null : provider)
      if (provider === 'groq') {
        const key = await terminal.text({
          message: 'Groq API key:',
          defaultValue: (current.groqApiKey as string) ?? '',
          validate: (v) => (!v.trim() ? 'API key cannot be empty' : undefined),
        })
        await settings.set('groqApiKey', key.trim())
      } else if (provider === LOCAL_WHISPER_PROVIDER) {
        const language = await terminal.text({
          message: 'Local Whisper language:',
          defaultValue: (current.localWhisperLanguage as string) ?? LOCAL_WHISPER_DEFAULTS.language,
        })
        const model = await terminal.text({
          message: 'Local Whisper model:',
          defaultValue: (current.localWhisperModel as string) ?? LOCAL_WHISPER_DEFAULTS.model,
        })
        await settings.set('localWhisperLanguage', language.trim() || LOCAL_WHISPER_DEFAULTS.language)
        await settings.set('localWhisperModel', model.trim() || LOCAL_WHISPER_DEFAULTS.model)
      }
      terminal.log.success('STT settings updated')
    } else if (choice === 'tts') {
      const voice = await terminal.text({
        message: 'TTS voice (leave blank for default):',
        defaultValue: (current.ttsVoice as string) ?? '',
      })
      await settings.set('ttsVoice', voice.trim())
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
      { key: 'sttProvider', displayName: 'Speech to Text', type: 'select', scope: 'safe', hotReload: true, options: [LOCAL_WHISPER_PROVIDER, 'groq'] },
      { key: 'groqApiKey', displayName: 'Groq STT API Key', type: 'string', scope: 'sensitive', hotReload: true },
      { key: 'localWhisperLanguage', displayName: 'Local Whisper Language', type: 'string', scope: 'safe', hotReload: true },
      { key: 'localWhisperModel', displayName: 'Local Whisper Model', type: 'string', scope: 'safe', hotReload: true },
      { key: 'localWhisperBeamSize', displayName: 'Local Whisper Beam Size', type: 'number', scope: 'safe', hotReload: true },
      { key: 'localWhisperVadFilter', displayName: 'Local Whisper VAD Filter', type: 'toggle', scope: 'safe', hotReload: true },
      { key: 'localWhisperDevice', displayName: 'Local Whisper Device', type: 'select', scope: 'safe', hotReload: true, options: ['cpu', 'cuda', 'auto'] },
      { key: 'localWhisperComputeType', displayName: 'Local Whisper Compute Type', type: 'string', scope: 'safe', hotReload: true },
      { key: 'localWhisperTimeoutMs', displayName: 'Local Whisper Timeout (ms)', type: 'number', scope: 'safe', hotReload: true },
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
