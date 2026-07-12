# Environment Variables

Environment variables override values in `~/.openacp/config.json` at startup. They do not modify the config file.

All overrides are applied before Zod schema validation, so the final config is always validated.

| Variable | Config Equivalent | Type | Description |
|---|---|---|---|
| `OPENACP_TELEGRAM_BOT_TOKEN` | `channels.telegram.botToken` | string | Telegram Bot API token |
| `OPENACP_TELEGRAM_CHAT_ID` | `channels.telegram.chatId` | number | Telegram chat/supergroup ID (parsed as integer) |
| `OPENACP_TELEGRAM_COMMAND_TAKEOVER` | — | `"1"` | Explicitly claim command synchronization from a provably stopped owner on the same host. Use for one recovery start only; it cannot steal a live or cross-host owner. |
| `OPENACP_DISCORD_BOT_TOKEN` | `channels.discord.botToken` | string | Discord bot token |
| `OPENACP_DISCORD_GUILD_ID` | `channels.discord.guildId` | string | Discord server (guild) ID |
| `OPENACP_SLACK_BOT_TOKEN` | `channels.slack.botToken` | string | Slack bot OAuth token (`xoxb-...`) |
| `OPENACP_SLACK_APP_TOKEN` | `channels.slack.appToken` | string | Slack app-level token for Socket Mode (`xapp-...`) |
| `OPENACP_SLACK_SIGNING_SECRET` | `channels.slack.signingSecret` | string | Slack signing secret |
| `OPENACP_DEFAULT_AGENT` | `defaultAgent` | string | Agent name to use when none is specified |
| `OPENACP_RUN_MODE` | `runMode` | `"foreground"` \| `"daemon"` | How `openacp` starts the server |
| `OPENACP_API_PORT` | `api.port` | number | REST API listen port (parsed as integer) |
| `OPENACP_LOG_LEVEL` | `logging.level` | string | Log level (`silent`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `OPENACP_LOG_DIR` | `logging.logDir` | string | Directory for log files |
| `OPENACP_DEBUG` | `logging.level` → `"debug"` | any | Set to any non-empty value to enable debug logging. Ignored if `OPENACP_LOG_LEVEL` is also set. |
| `OPENACP_TUNNEL_ENABLED` | `tunnel.enabled` | boolean | Set to `"true"` or `"false"` to enable/disable the tunnel service |
| `OPENACP_TUNNEL_PORT` | `tunnel.port` | number | Tunnel service listen port (parsed as integer) |
| `OPENACP_TUNNEL_PROVIDER` | `tunnel.provider` | string | Tunnel provider (`cloudflare`, `ngrok`, `bore`, `tailscale`) |
| `OPENACP_SPEECH_STT_PROVIDER` | `@openacp/speech.sttProvider` | string | Active STT provider: `local-whisper` or `groq` |
| `OPENACP_SPEECH_GROQ_API_KEY` | `@openacp/speech.groqApiKey` | string | API key for the Groq STT provider |
| `OPENACP_SPEECH_LOCAL_WHISPER_LANGUAGE` | `@openacp/speech.localWhisperLanguage` | string | Local Whisper language hint (default `ru`) |
| `OPENACP_SPEECH_LOCAL_WHISPER_MODEL` | `@openacp/speech.localWhisperModel` | string | faster-whisper model name (default `base`) |
| `OPENACP_SPEECH_LOCAL_WHISPER_BEAM_SIZE` | `@openacp/speech.localWhisperBeamSize` | number | Decode beam size (default `5`) |
| `OPENACP_SPEECH_LOCAL_WHISPER_VAD_FILTER` | `@openacp/speech.localWhisperVadFilter` | boolean | Enable faster-whisper VAD filtering |
| `OPENACP_SPEECH_LOCAL_WHISPER_DEVICE` | `@openacp/speech.localWhisperDevice` | string | Runtime device: `cpu`, `cuda`, or `auto` |
| `OPENACP_SPEECH_LOCAL_WHISPER_COMPUTE_TYPE` | `@openacp/speech.localWhisperComputeType` | string | faster-whisper compute type (default `int8`) |
| `OPENACP_SPEECH_LOCAL_WHISPER_TIMEOUT_MS` | `@openacp/speech.localWhisperTimeoutMs` | number | Transcription timeout in milliseconds |
| `OPENACP_SPEECH_LOCAL_WHISPER_SCRIPT_PATH` | `@openacp/speech.localWhisperScriptPath` | string | Optional custom transcription executable |
| `OPENACP_CONFIG_PATH` | — | string | Override the config file path (default: `<instance-root>/config.json`) |
| `OPENACP_INSTANCE_ROOT` | — | string | Set the instance root directory. Overrides auto-detection and CLI flags. See [Multi-Instance](../features/multi-instance.md). |

## Plugin-Level Environment Variables

With the plugin architecture, channel-specific and feature-specific environment variables are now handled by individual plugins in their `setup()` method. The following variables are **plugin-level** (processed by the respective plugin, not core):

- **Telegram plugin:** `OPENACP_TELEGRAM_BOT_TOKEN`, `OPENACP_TELEGRAM_CHAT_ID`, `OPENACP_TELEGRAM_COMMAND_TAKEOVER`
- **Discord plugin:** `OPENACP_DISCORD_BOT_TOKEN`, `OPENACP_DISCORD_GUILD_ID`
- **Slack plugin:** `OPENACP_SLACK_BOT_TOKEN`, `OPENACP_SLACK_APP_TOKEN`, `OPENACP_SLACK_SIGNING_SECRET`
- **Speech plugin:** `OPENACP_SPEECH_STT_PROVIDER`, `OPENACP_SPEECH_GROQ_API_KEY`, and the `OPENACP_SPEECH_LOCAL_WHISPER_*` variables above
- **Tunnel plugin:** `OPENACP_TUNNEL_ENABLED`, `OPENACP_TUNNEL_PORT`, `OPENACP_TUNNEL_PROVIDER`

These remain functional for backward compatibility but are read by each plugin rather than by core config loading.

**Core-level** variables (processed by OpenACPCore directly): `OPENACP_CONFIG_PATH`, `OPENACP_DEFAULT_AGENT`, `OPENACP_RUN_MODE`, `OPENACP_API_PORT`, `OPENACP_LOG_LEVEL`, `OPENACP_LOG_DIR`, `OPENACP_DEBUG`.

## Notes

### Host proxy environment

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and `NO_PROXY` are not config
overrides. They are consumed only by a scope whose route is `inherit`. OpenACP
does not install them as a global dispatcher. A `direct` ACP-agent route removes
both upper/lowercase variants and Node proxy flags from the child environment.
Use `openacp proxy import <id> --env-file <file>` to migrate an existing proxy
environment into a protected profile without exposing credentials in arguments
or output.

- **`OPENACP_DEBUG`** is a convenience shorthand. Setting `OPENACP_LOG_LEVEL=debug` is equivalent and takes precedence.
- **`OPENACP_CONFIG_PATH`** does not correspond to a config field; it controls where the config file is read from and is evaluated before any config is loaded.
- Numeric fields (including local Whisper beam size and timeout) are converted to numbers automatically.
- Boolean fields (`OPENACP_TUNNEL_ENABLED`, `OPENACP_SPEECH_LOCAL_WHISPER_VAD_FILTER`) are compared to the string `"true"` — any other value is treated as `false`.
- Env vars take precedence over `config.json` but are not persisted; `openacp config set` modifies the file.
