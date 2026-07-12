OpenACP — self-hosted bridge that connects 28+ AI coding agents (Claude Code, Codex, Gemini, Cursor) to chat, REST, and SSE, with native bridge-agnostic speech-to-text. Your machine, your keys, your data.

<div align="center">

# OpenACP

**Control AI coding agents from Telegram, Discord & Slack — or automate them through REST and SSE**

Send a message. The agent writes code. You see everything — in real time.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/Node.js-%3E%3D%2020-green.svg)](https://nodejs.org/)
[![ACP Protocol](https://img.shields.io/badge/Protocol-ACP-purple.svg)](https://agentclientprotocol.org/)
[![npm](https://img.shields.io/npm/v/@n1creator/openacp-cli.svg)](https://www.npmjs.com/package/@n1creator/openacp-cli)
[![Twitter Follow](https://img.shields.io/twitter/follow/openacp_ai?style=social)](https://x.com/openacp_ai)

[Documentation](https://openacp.gitbook.io/docs) · [Quick Start](#quick-start) · [Features](#features) · [Agents](#supported-agents) · [Contributing](CONTRIBUTING.md) · [Discussions](https://github.com/an1creator/OpenACP/discussions)

<img src="docs/images/banner.jpg" alt="OpenACP — Control AI coding agents from Telegram, Discord and Slack" width="100%" />

</div>

---

> **N1 Creator distribution.** This repository publishes the maintained fork as
> `@n1creator/openacp-cli` and `@n1creator/openacp-plugin-sdk`. Existing OpenACP
> workspaces remain compatible; migrate by replacing the global CLI package and
> restarting the same instance. The maintained CLI includes native local
> faster-whisper STT and keeps the speech pipeline independent from any one
> messaging adapter.

## What is OpenACP?

OpenACP is a self-hosted bridge that connects AI coding agents to messaging and automation channels. Chat through Telegram, Discord, or Slack, or send prompts and attachments through REST/SSE — the agent reads your codebase, writes code, runs commands, and streams results back in real time.

Built on the open [Agent Client Protocol (ACP)](https://agentclientprotocol.org/). Your machine, your keys, your data.

```
You (Telegram / Discord / Slack / REST / SSE)
  ↓
OpenACP (bridge + session manager + speech service)
  ↓
AI Agent (Claude Code, Codex, Gemini, Cursor, ...)
  ↓
Your Codebase
```

## Why OpenACP?

| Without OpenACP | With OpenACP |
|----------------|-------------|
| *"Its usage is currently focused on its dedicated terminal REPL and specific IDE integrations"* | Control from Telegram, Discord, or Slack — any device, anywhere |
| *"Codex Desktop App only works with local projects. It does not support development on remote hosts"* | Full remote development support — run agents on your server, manage from your phone |
| *"There's no way to trigger Claude Code sessions from external issue trackers"* | REST API for CI/CD integration and external triggers |
| *"Being able to use a proper mobile app UI would be much better than having to access sessions through ssh + tmux"* | Native Telegram/Discord UI — no SSH, no terminal on mobile |
| *"Cline is really burning up OpenRouter tokens and my wallet"* | Built-in usage tracking and monthly budget limits per session |

## Use Cases

- **Remote coding** — Tired of being chained to your desk to run Claude Code? Review PRs, fix bugs, and deploy from your phone via Telegram while away from your desk.
- **Team visibility** — Share a Discord channel where everyone sees what the AI agent is doing in real time — no more black-box coding sessions.
- **Multi-agent workflows** — Start with Claude Code for planning, switch to Codex for implementation, use Gemini for review — all in one chat thread, no reconfiguration.
- **CI/CD integration** — Trigger agent sessions from GitHub Actions or any issue tracker via the REST API.
- **Voice-driven workflows** — Send audio from any compatible bridge; OpenACP transcribes it locally before the agent receives the prompt.
- **Self-hosted AI gateway** — Keep API keys and code on your own infrastructure. No third-party cloud, no vendor lock-in.
- **Local LLM support** — Run agents against self-hosted models (Ollama, LM Studio) via ACP-compatible adapters. Your models, your data.

<div align="center">
<table>
<tr>
<td align="center"><img src="docs/images/menu.png" width="250" alt="OpenACP control panel showing session management, agent selection, and settings menu in Telegram" /><br /><b>Control Panel</b><br />Manage sessions, agents, and settings</td>
<td align="center"><img src="docs/images/agent-working.png" width="250" alt="AI coding agent reading files, planning changes, and writing code through OpenACP Telegram interface" /><br /><b>Agent at Work</b><br />Plans, reads files, writes code</td>
</tr>
<tr>
<td align="center"><img src="docs/images/tool-calls.png" width="250" alt="Real-time tool call streaming showing agent actions like file reads, edits, and command execution" /><br /><b>Real-time Tool Calls</b><br />See every action the agent takes</td>
<td align="center"><img src="docs/images/skills.png" width="250" alt="OpenACP agent skills menu with options for brainstorming, TDD, debugging, and code review" /><br /><b>Agent Skills</b><br />Brainstorming, TDD, debugging & more</td>
</tr>
</table>
</div>

## Installation

**Requirements:** Node.js 20+ (the installer handles this for you)

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/an1creator/OpenACP/main/scripts/install.sh | bash
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/an1creator/OpenACP/main/scripts/install.sh | bash
```

> Works on Debian/Ubuntu, Fedora/RHEL, Arch, and other distros. Also supports WSL (Windows Subsystem for Linux).

### Windows

Open PowerShell and run:

```powershell
powershell -c "irm https://raw.githubusercontent.com/an1creator/OpenACP/main/scripts/install.ps1 | iex"
```

> Requires PowerShell 5.1+ (built into Windows 10/11).

### Manual install via npm

If you do not have Node.js yet, install it first. For example, on macOS or Linux with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm install --lts
nvm use --lts
```

Then install OpenACP with npm:

```bash
npm install -g @n1creator/openacp-cli
openacp
# → Interactive setup wizard starts:
# → ? Choose your platform: Telegram / Discord / Slack
# → ? Enter your bot token: ********
# → ? Select workspace directory: ~/projects
# → ? Choose default AI agent: Claude Code
# → ✓ Configuration saved. Starting OpenACP...
# → 🚀 OpenACP is running. Send a message to your bot!
```

---

After installation, the **interactive setup wizard** walks you through everything:

1. Choose your platform (Telegram, Discord, Slack, or multiple)
2. Connect your bot (token validation + auto-detection)
3. Pick a workspace directory
4. Select your default AI agent
5. Choose run mode (foreground or daemon)

That's it. Send a message to your bot and start coding.

> **Need detailed setup for a specific platform?** See the [Platform Setup guides](https://openacp.gitbook.io/docs/platform-setup).

## Features

### Channels and Bridges

| Platform | Status | Highlights |
|----------|--------|------------|
| **Telegram** | Stable | Forum topics per session, streaming, permission buttons, voice |
| **Discord** | Stable | Thread-based sessions, slash commands, button interactions |
| **Slack** | Stable | Socket Mode, channel-based sessions, thread organization |
| **REST API / SSE** | Stable | Session automation, base64 file/audio attachments, streamed events |

### Core

- **28+ AI agents** — Claude Code, Codex, Gemini, Cursor, Copilot, and [more](#supported-agents)
- **Session management** — Each conversation gets its own thread/topic with auto-naming
- **Session persistence** — Sessions survive restarts, with configurable TTL
- **Permission control** — Approve or deny agent actions via buttons, with optional auto-approve
- **Real-time streaming** — See agent thinking, tool calls, and output as they happen
- **Agent switching** — Switch agents mid-conversation with `/switch`; history carries over automatically
- **Dynamic model options** — Model, mode, and reasoning choices come from each ACP agent at runtime instead of a hard-coded model list
- **Agent-aware audio routing** — Pass audio directly to agents that support it; otherwise transcribe it through the shared STT service
- **Scoped proxy routing** — Route Telegram, individual ACP agents, services, or plugin flows independently through HTTP, HTTPS, SOCKS5, or SOCKS5H profiles

### Developer Tools

- **Tunnel & port forwarding** — Expose local ports to the internet (Cloudflare, ngrok, bore, Tailscale)
- **Built-in file viewer** — Monaco Editor with syntax highlighting, diffs, and markdown preview
- **Session transfer** — Move sessions between terminal and chat (`/handoff`)
- **Agent switch** — Change which AI agent handles your session mid-conversation (`/switch`)
- **Voice & speech** — Bundled local faster-whisper or Groq STT for every compatible bridge, plus optional Edge TTS
- **Usage tracking** — Token counts, cost reports, optional monthly budget limits
- **Context resume** — Resume sessions with full conversation history

### Native Speech-to-Text Across Bridges

The maintained package includes the `local-whisper` provider in the built-in
`@openacp/speech` service. STT runs in the shared session pipeline rather than
inside Telegram, so the same behavior applies to Telegram voice messages,
REST/SSE audio attachments, and external adapters that submit a standard
attachment with `type: "audio"`.

```text
audio attachment from any compatible bridge
  → agent supports native audio? send audio directly
  → otherwise: local faster-whisper or Groq STT
  → append transcript to the prompt and call the agent
```

- **Private local mode** — `local-whisper` runs on the OpenACP host with no API key.
- **Bundled runtime** — The CLI ships the transcription script and reuses the model/venv cache at `~/.cache/codex/transcribe-voice`.
- **Pluggable providers** — Select local Whisper or Groq, or register another STT provider through the plugin SDK.
- **Safe fallback** — If transcription fails, OpenACP keeps the original audio attachment instead of discarding it.
- **Audio-aware agents** — Agents advertising native audio capability receive the original attachment without unnecessary transcription.

Local Whisper needs Python 3 plus `uv` or `python3-venv`; its environment and
selected model are prepared on the first transcription. Configure it through
`/settings`, the plugin settings API, or `openacp config`. See
[Voice and Speech](docs/gitbook/using-openacp/voice-and-speech.md) for settings,
formats, providers, and troubleshooting.

### Scoped Proxy Routing

OpenACP can proxy only the flows that need it instead of exporting one proxy for
the whole daemon. Profiles (where to connect) are separate from routes (what uses
the profile), and every route is `direct`, `inherit`, or `profile:<id>`.

```text
global: direct
channels.telegram: profile:usa
agents.codex: profile:usa
agents.cursor: direct
services.default: direct
```

Telegram polling, outgoing Bot API calls, and Telegram file downloads share the
`channels.telegram` route. ACP subprocesses receive a per-agent environment;
`direct` explicitly removes inherited proxy variables. Local REST/SSE traffic is
not globally intercepted. Credentials live in a separate mode-0600 secret store
and never appear in route files, agent definitions, status responses, or
structured OpenACP logs.

Manage routes from any connector with `/proxy`, from the CLI with
`openacp proxy`, or through `/api/v1/proxy`. Channel changes are tested before
they are saved. See [Scoped Proxy Routing](docs/gitbook/features/proxy-routing.md).

### Operations

- **Daemon mode** — Run as a background service with auto-start on boot
- **CLI API** — Full REST API for automation (`openacp api ...`)
- **Fast first session** — A liveness-checked warm pool keeps the default agent ready, avoiding a full subprocess spawn on the first API session
- **Consistent health reporting** — `/api/health` merges persisted and live-only sessions so active and total counts describe the same population
- **Secret-safe agent inspection** — Agent list, reload, and detail API responses redact environment values while preserving variable names
- **Plugin system** — Install adapters as npm packages
- **Doctor diagnostics** — `openacp doctor` checks everything and suggests fixes
- **Structured logging** — Pino with rotation, per-session log files

> **Full feature documentation** — [Documentation](https://openacp.gitbook.io/docs)

## Supported Agents

OpenACP uses the [ACP Registry](https://agentclientprotocol.com/get-started/registry) — new agents are available as soon as they're registered.

| Agent | Type | Description |
|-------|------|-------------|
| [Claude Code](https://github.com/anthropics/claude-code) | npx | Anthropic's Claude coding agent |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | npx | Google's Gemini CLI |
| [Codex CLI](https://github.com/openai/codex) | npx | OpenAI's coding assistant |
| [GitHub Copilot](https://github.com/github/copilot-cli) | npx | GitHub's AI pair programmer |
| [Cursor](https://www.cursor.com/) | binary | Cursor's coding agent |
| [Cline](https://github.com/cline/cline) | npx | Autonomous coding agent |
| [goose](https://github.com/block/goose) | binary | Open source AI agent by Block |
| Amp | binary | The frontier coding agent |
| [Auggie CLI](https://www.augmentcode.com/) | npx | Augment Code's context engine |
| [Junie](https://www.jetbrains.com/) | binary | AI coding agent by JetBrains |
| [Kilo](https://github.com/kilocode/kilo) | npx | Open source coding agent |
| [Qwen Code](https://github.com/QwenLM/qwen-code) | npx | Alibaba's Qwen assistant |
| ...and more | | [Full registry →](https://agentclientprotocol.com/get-started/registry) |

```bash
openacp agents                     # Browse all agents
openacp agents install <name>      # Install from registry
```

## CLI Overview

```bash
# Server
openacp                            # Start (first run = setup wizard)
openacp start / stop / restart     # Daemon management
openacp status                     # Check daemon status
openacp logs                       # Tail daemon logs

# Configuration
openacp config                     # Interactive config editor
openacp reset                      # Re-run setup wizard
openacp doctor                     # System diagnostics

# Sessions & API (requires running daemon)
openacp api new [agent] [workspace]
openacp api status
openacp api health
openacp api cancel <id>

# Updates
openacp update                    # Install the latest maintained npm release

# Tunnels
openacp tunnel add <port> [--label name]
openacp tunnel list

# Scoped proxy routing (requires running daemon)
openacp proxy status
openacp proxy import usa --env-file ~/.openacp/secrets/proxy.env
openacp proxy create backup --from-json ~/.openacp/secrets/backup-proxy.json
openacp proxy update backup --from-json ~/.openacp/secrets/backup-proxy.json
openacp proxy set channels.telegram profile:usa
openacp proxy set agents.codex profile:usa
openacp proxy test --scope channels.telegram
```

The protected JSON file supports a Quick URL mode: use either separate
`protocol`, `host`, and `port` fields or one write-only `proxyUrl` such as
`{"proxyUrl":"socks5h://user:password@proxy.example:1080"}`. The two forms are
mutually exclusive. A URL must include an explicit port; credentials are parsed
and stored separately, and the original URL is never persisted or returned.

The connector-neutral `/proxy` interface now provides admin-only add/edit,
candidate test-before-save, credential clearing, paginated route controls, and
atomic delete-with-reassignment. Telegram deletes credential replies before use;
if that guarantee is unavailable, OpenACP refuses the value and directs the
operator to a mode-0600 CLI/API input file.

Use a unique Telegram bot for each OpenACP instance. Command synchronization has
one heartbeat-backed owner per public bot ID and a second instance will not
modify the first instance's command menus.

> **Full CLI reference** — [CLI Commands](https://openacp.gitbook.io/docs/api-reference/cli-commands)

## Documentation

| Section | Description |
|---------|-------------|
| [Getting Started](https://openacp.gitbook.io/docs/getting-started) | What is OpenACP, quickstart for users & developers |
| [Platform Setup](https://openacp.gitbook.io/docs/platform-setup) | Step-by-step guides for Telegram, Discord, Slack |
| [Using OpenACP](https://openacp.gitbook.io/docs/using-openacp) | Commands, sessions, agents, permissions, voice |
| [Self-Hosting](https://openacp.gitbook.io/docs/self-hosting) | Installation, configuration, daemon, security |
| [Features](https://openacp.gitbook.io/docs/features) | Tunnel, context resume, usage tracking, and more |
| [Extending](https://openacp.gitbook.io/docs/extending) | Plugin system, building adapters, contributing |
| [API Reference](https://openacp.gitbook.io/docs/api-reference) | CLI commands, REST API, config schema, env vars |
| [Troubleshooting](https://openacp.gitbook.io/docs/troubleshooting) | Common issues and FAQ |

## Known Limitations

- **Early stage** — OpenACP is under active development; expect breaking changes between minor versions
- **Single user** — Currently designed for individual use; multi-user/team support is planned
- **Remote host** — Agents run on the same machine as OpenACP; to use on a remote server, install OpenACP on that server
- **Agent availability** — Some agents require their own API keys and local installation
- **Platform features** — Not all messaging platform features are supported equally (e.g., Slack threads vs Telegram forum topics)
- **No Windows daemon** — Daemon mode (auto-start on boot) currently supports macOS and Linux only

## FAQ

### Why use Telegram or Discord instead of just the terminal?
Most AI coding agents are locked to a terminal REPL or IDE. OpenACP lets you send messages, review code diffs, approve or deny actions, and monitor progress from any device — phone, tablet, or browser — without opening a laptop.

### How is OpenACP different from MCP?
MCP (Model Context Protocol) is a standard for giving AI models access to tools and data sources. OpenACP uses the **Agent Client Protocol (ACP)** to manage full coding agent *sessions* — starting agents, streaming output, handling permissions, and routing results to your messaging platform. The two protocols are complementary: your agents can use MCP tools while OpenACP manages the session layer.

### Can I auto-approve agent actions?
Yes. By default, OpenACP shows a permission button for destructive actions. You can configure [auto-approve rules](https://openacp.gitbook.io/docs/using-openacp) to skip confirmation for specific action types (e.g., read-only operations) while still requiring approval for file writes or shell commands.

### How do I control API spending?
Set a monthly budget limit in your config. OpenACP tracks token usage and cost in real time and will pause the agent when the limit is reached. Run `openacp config` to set limits per session.

### Can I use a local or self-hosted LLM?
Yes, if the model has a compatible agent CLI. Any agent that implements the ACP protocol can be registered. Community adapters exist for Ollama and LM Studio — run `openacp agents` to browse available options.

### Does speech input only work in Telegram?
No. STT is part of the shared session pipeline. Telegram already converts voice and audio messages into standard audio attachments, while the REST API and SSE bridge accept base64 audio attachments. Any external adapter gets the same behavior when it submits an attachment with `type: "audio"`. If the selected agent supports native audio, OpenACP passes the audio through; otherwise it transcribes it with the configured STT provider.

### What happens if the agent gets stuck or the chat hangs?
Use `/cancel` in your chat to stop the current session. Run `openacp doctor` to check for connectivity or configuration issues. OpenACP's session persistence means you can resume with full context intact after a restart.

### Does OpenACP send my code to the cloud?
No. OpenACP runs entirely on your machine. AI agents connect directly to your chosen provider using your own API keys. Nothing is routed through OpenACP servers.

### Can I use multiple AI agents at the same time?
Each session uses one agent, but you can run multiple sessions simultaneously — one per thread/topic in your chat. Switch agents between sessions or start a new session with a different agent at any time.

### Is OpenACP free?
Yes. OpenACP is MIT-licensed and free to self-host. You only pay for the AI provider API keys you choose to use.

### How do I update OpenACP?
```bash
openacp update
```

On Telegram, administrators can also run `/update`; OpenACP waits for npm to
finish and then requests a managed daemon restart. Do not run a second npm
install or stop the service while that update is in progress.

To migrate from the upstream npm package:

```bash
npm uninstall -g @openacp/cli
npm install -g @n1creator/openacp-cli@latest
openacp --dir ~/openacp-workspace restart
```

## Security

OpenACP grants AI agents access to your filesystem and shell. Before using in production:

- Run in a sandboxed environment or container when possible
- Review agent permissions — use the built-in permission gate to approve/deny actions
- Never expose your OpenACP instance to the public internet without authentication
- Keep your bot tokens secret — rotate them if compromised
- See the [Security guide](https://openacp.gitbook.io/docs/self-hosting/security) for hardening recommendations

## Star History

<a href="https://star-history.com/#an1creator/OpenACP&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=an1creator/OpenACP&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=an1creator/OpenACP&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=an1creator/OpenACP&type=Date" />
 </picture>
</a>

## Contributing

We welcome contributions! See the [contributing guide](CONTRIBUTING.md) for development setup, testing conventions, and PR process. Have questions? Start a thread on [GitHub Discussions](https://github.com/an1creator/OpenACP/discussions).

## License

[MIT](LICENSE)
