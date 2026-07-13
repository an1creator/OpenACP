<div align="center">

# OpenACP

**Run AI coding agents from chat, automation, or your own integration.**

Self-hosted sessions for Codex, Cursor, Claude Code, Gemini, and other ACP agents — with native speech-to-text, scoped proxy routing, and real-time control from Telegram, Discord, Slack, REST, or SSE.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org/)
[![ACP Protocol](https://img.shields.io/badge/Protocol-ACP-purple.svg)](https://agentclientprotocol.org/)
[![npm](https://img.shields.io/npm/v/@n1creator/openacp-cli.svg)](https://www.npmjs.com/package/@n1creator/openacp-cli)

[Quick Start](#quick-start) · [Capabilities](#capabilities) · [Agents](#agents) · [Documentation](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook) · [Contributing](CONTRIBUTING.md)

<img src="docs/images/banner.jpg" alt="OpenACP — control AI coding agents from messaging and automation clients" width="100%" />

</div>

OpenACP runs on your machine and connects messaging or API clients to local ACP agent processes. It owns session lifecycle, permissions, streaming, files, speech, and routing; the selected agent works in your configured workspace with its own provider credentials.

> **N1 Creator distribution.** This repository is the maintained
> [`an1creator/OpenACP`](https://github.com/an1creator/OpenACP) fork. Its public
> packages are [`@n1creator/openacp-cli`](https://www.npmjs.com/package/@n1creator/openacp-cli)
> and [`@n1creator/openacp-plugin-sdk`](https://www.npmjs.com/package/@n1creator/openacp-plugin-sdk).

```text
Telegram / Discord / Slack / REST / SSE
                  ↓
       OpenACP session bridge
       ├─ permissions and streaming
       ├─ speech and file handling
       └─ scoped network routing
                  ↓
       Codex / Cursor / Claude / Gemini / ACP agent
                  ↓
             Your workspace
```

<div align="center">
<table>
<tr>
<td align="center"><img src="docs/images/menu.png" width="250" alt="OpenACP control panel in Telegram" /><br /><b>Control Panel</b><br />Sessions, agents, and settings</td>
<td align="center"><img src="docs/images/agent-working.png" width="250" alt="An AI coding agent working through OpenACP" /><br /><b>Agent at Work</b><br />Plans, tools, and output in real time</td>
</tr>
<tr>
<td align="center"><img src="docs/images/tool-calls.png" width="250" alt="Real-time tool calls in OpenACP" /><br /><b>Tool Calls</b><br />Review actions as they happen</td>
<td align="center"><img src="docs/images/skills.png" width="250" alt="Agent skills in OpenACP" /><br /><b>Agent Skills</b><br />Reusable coding workflows</td>
</tr>
</table>
</div>

## Quick Start

**Requirement:** Node.js 20 or newer.

```bash
npm install -g @n1creator/openacp-cli
openacp
```

The first run opens an interactive setup wizard. Choose one or more connectors, provide their credentials, select a workspace and default agent, then choose foreground or daemon mode.

```bash
openacp doctor       # validate the installation
openacp status       # inspect the running instance
openacp logs         # follow daemon logs
```

Platform-specific setup is in the maintained [Telegram](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/platform-setup/telegram.md), [Discord](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/platform-setup/discord.md), and [Slack](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/platform-setup/slack.md) guides.

## Capabilities

### Agents and sessions

- Run modern Codex and Cursor ACP processes alongside Claude Code, Gemini CLI, and other ACP-compatible agents.
- Read model, mode, and reasoning choices from each agent at runtime instead of maintaining a hard-coded model list.
- Keep one persistent session per topic, thread, or API session; resume it after process restarts.
- Switch agents with `/switch`, transfer work between terminal and chat with `/handoff`, and cancel safely with `/cancel`.
- Review permission requests through connector controls or configure narrowly scoped approval behavior.

### Connectors and automation

| Interface | Session mapping | Highlights |
|-----------|-----------------|------------|
| Telegram | Forum topics | Commands, buttons, streaming, files, voice |
| Discord | Threads | Commands, interactions, files, streaming |
| Slack | Channels and threads | Socket Mode, commands, files, streaming |
| REST + SSE | API session IDs | Automation, attachments, live event streams |

The core session pipeline is connector-neutral. An external adapter gets the same session, attachment, speech, permission, and agent-routing behavior when it implements the standard adapter contract.

### Native speech-to-text

STT is a built-in OpenACP service, not Telegram-specific glue. Any compatible bridge can submit a standard `audio` attachment:

```text
audio attachment
  ├─ agent supports native audio → pass the original attachment
  └─ otherwise → local faster-whisper or Groq STT → append transcript to prompt
```

- `local-whisper` runs on the OpenACP host without an API key and reuses its environment and model cache.
- Groq provides an optional hosted STT path.
- Failed transcription preserves the original audio instead of silently dropping it.
- In Telegram, open **Settings → Speech-to-text** or use `/speech` to see the selected method and setup state, choose Off, Local, or Groq, and edit local settings. Discord and Slack use the same service after host configuration with `openacp plugin configure @openacp/speech`; their current adapters do not register a native `/speech` slash command. A candidate Groq key is checked before it can replace the saved hidden key; changes hot-reload without replacing TTS providers.

Local Whisper requires Python 3 and either `uv` or `python3-venv`; its runtime is prepared on first use. See [Voice and Speech](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/using-openacp/voice-and-speech.md).

### Scoped proxy routing

Proxy profiles describe endpoints; routes decide which traffic uses them. OpenACP supports **HTTP, HTTPS, SOCKS5, and SOCKS5H**, with independent scopes for channels, agents, services, and plugins.

```text
global: direct
channels.telegram: profile:primary
agents.codex: profile:primary
agents.cursor: direct
services.default: direct
```

- In Telegram, open **Settings → Network proxy** or use `/proxy`. Current Discord and Slack adapters do not register a native `/proxy` slash command, so manage their shared routes with the CLI or authenticated REST API. The status-first menu separates saved overrides from effective inherited routes and lets a tested profile be assigned directly to human-labelled traffic.
- CLI and REST automation are available through `openacp proxy` and `/api/v1/proxy`.
- `direct` removes inherited proxy environment variables from the selected ACP process. An explicit `inherit` route uses host proxy environment variables; clearing an exact override returns that traffic to its category/global parent route.
- Credentials are write-only, stored separately in a mode-0600 secret store, and never returned in route or status data.
- Protected JSON imports accept a write-only **Quick URL** in `proxyUrl`; it requires an explicit port and is mutually exclusive with separate endpoint or credential fields.
- Telegram deletes credential replies before use; environments without that guarantee use protected CLI/API input files.

See [Scoped Proxy Routing](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/features/proxy-routing.md) for route precedence, secure inputs, testing, and recovery.

### Operations and extension

- Managed foreground or daemon lifecycle on Linux and macOS.
- REST API, SSE event stream, and JSON-capable CLI for automation.
- Health checks, structured logging, usage tracking, tunnels, and `openacp doctor` diagnostics.
- Plugin SDK and lifecycle for custom adapters, services, commands, and middleware.

## Agents

OpenACP uses ACP-compatible agent definitions and the public [ACP agent registry](https://agentclientprotocol.com/get-started/registry).

| Agent | Integration |
|-------|-------------|
| [Codex CLI](https://github.com/openai/codex) | ACP process with runtime model, mode, and reasoning options |
| [Cursor](https://www.cursor.com/) | Local Cursor ACP process |
| [Claude Code](https://github.com/anthropics/claude-code) | ACP-compatible package process |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | ACP-compatible package process |
| Other agents | Install or define another ACP-compatible process |

```bash
openacp agents
openacp agents install <name>
```

Agent CLIs may require their own installation, account, or provider credentials.

## CLI Reference

```bash
# Lifecycle
openacp
openacp start | stop | restart
openacp status
openacp doctor

# Sessions and local API
openacp api new [agent] [workspace]
openacp api status
openacp api cancel <session-id>

# Scoped proxy routing
openacp proxy status
openacp proxy import primary --env-file ~/.openacp/secrets/proxy.env
openacp proxy set channels.telegram profile:primary
openacp proxy set agents.codex profile:primary
openacp proxy test --scope channels.telegram

# Updates
openacp update
```

The complete command contract is in [CLI Commands](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/api-reference/cli-commands.md).

## Documentation

| Area | Maintained reference |
|------|----------------------|
| Start and configure | [Getting Started](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/getting-started) · [Self-Hosting](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/self-hosting) |
| Connect clients | [Platform Setup](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/platform-setup) |
| Use sessions and commands | [Using OpenACP](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/using-openacp) |
| Speech, proxy, handoff | [Features](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/features) |
| CLI, REST, config, env | [API Reference](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/api-reference) |
| Build plugins and adapters | [Extending](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/extending) |
| Diagnose failures | [Troubleshooting](https://github.com/an1creator/OpenACP/tree/main/docs/gitbook/troubleshooting) |

## Updating and Migration

```bash
openacp update
```

The managed updater installs the latest `@n1creator/openacp-cli` release and requests a daemon restart after npm finishes. To migrate an older global installation:

```bash
npm uninstall -g @openacp/cli
npm install -g @n1creator/openacp-cli@latest
openacp restart
```

See [Updating](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/self-hosting/updating.md) before changing a production instance.

## Security

OpenACP grants selected agent processes access to configured workspaces and may allow shell or file operations. Keep connector tokens and provider credentials secret, review permission policy, avoid exposing the local API without authentication, and use process or container isolation where appropriate.

Follow the [Security guide](https://github.com/an1creator/OpenACP/blob/main/docs/gitbook/self-hosting/security.md) for the current hardening checklist. Report vulnerabilities through the repository's [Security Policy](https://github.com/an1creator/OpenACP/blob/main/SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project conventions, tests, and pull-request requirements. Project conduct is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE)
