# Agents

Agents are the AI processes that OpenACP connects you to. Each agent implements the Agent Client Protocol (ACP) and exposes a prompt interface. OpenACP manages spawning, communication, and lifecycle.

## Browsing available agents

Use `/agents` to see what is installed and what is available to install:

```
/agents
```

The response has two sections:

- **Installed** — agents ready to use, with a checkmark
- **Available to install** — agents from the registry, with install buttons

The available list is paginated (6 per page) with Prev/Next navigation. Agents marked with a warning icon have unmet dependencies — tap the warning to see what is missing.

The registry is fetched from `cdn.agentclientprotocol.com` and cached locally for 24 hours. Lists identify whether the displayed catalog came from the live registry, the cache, or the packaged snapshot, and mark stale data. Simultaneous automatic and explicit refreshes share one request and publish one result. An invalid cache timestamp, including one far ahead of the host clock, is treated as stale and triggers a refresh instead of keeping the cache fresh indefinitely. A fetched catalog becomes active only after its cache file is replaced atomically; a cache-write failure keeps the prior catalog active. Registry entries are validated down to their runner or platform-specific binary settings before they become installable. npx packages must use an exact npm version, and uvx tools must use an exact `tool@version` or PEP 508 `tool==version` requirement matching the registry version. Tags, ranges, wildcards, environment markers, URLs, and VCS sources are rejected because they cannot guarantee the displayed runtime version. Invalid or duplicate entries are skipped and reported in catalog status; a response containing no valid entries is rejected without replacing the active catalog. `openacp agents refresh` is an explicit connectivity check: it exits non-zero instead of reporting success when the configured `services.agentRegistry` route cannot reach the registry.

For installed agents, the displayed installed version describes the command that OpenACP will launch. A different registry version is shown separately as an available update. npx and uvx commands retain the exact reviewed package version and environment. Registry-specific controls are enabled only when the persisted command, arguments, package version, and complete environment exactly match that reviewed definition. Any added, removed, renamed, or overridden environment variable makes the process a generic ACP agent; it can still run and advertise standard actions, but it cannot claim registry-specific behavior. Catalog reconciliation advances an exact npx runner only to a strictly newer SemVer release and an exact uvx runner only to a strictly newer PEP 440 release. Stable releases are newer than same-core prereleases; epochs, pre/dev/post releases, and local/build identifiers follow their package ecosystem ordering. Equal versions may refresh the display name or missing registry ID but never replace the command, arguments, environment, or stored version. Unparseable versions, inexact installed runners, binary updates, and changes between distribution types require an explicit install and do not replace the installed runtime during catalog reads. Skipped automatic reconciliation is exposed as `runnerReconciliationSkipped` with `lastRunnerReconciliationWarning` in catalog status.

## Installing an agent

From the `/agents` list, tap the install button next to any agent. Or use the command directly:

```
/install claude
/install gemini
/install codex
```

Progress updates appear in-line as the installation runs — downloading, extracting, configuring. After success, a button lets you start a session with the new agent immediately.

Binary agents may be published as zip, tar.gz/tgz, tar.bz2/tbz2, or a raw platform executable. When the registry provides a SHA-256 digest, OpenACP verifies the complete download before activating it. Runtime replacement and `agents.json` persistence form one transaction: a checksum, extraction, command-path, or persistence failure keeps the previous installed runtime and metadata. Downloads and extraction can run concurrently, but activation and metadata commit are serialized per agent across OpenACP processes. If a process exits during that commit, its private recovery journal is completed or rolled back by the next install, keeping the selected runtime and stored version aligned. Cleanup happens only after the new runtime and metadata are committed. If removal of the marked previous runtime is temporarily blocked, the command remains successful, reports `cleanupPending`, and retries that marked artifact on a later install. If automatic retry cannot be made safe, `cleanupRetryable` is false and the message asks for manual cleanup instead of promising a retry.

Installing the active registry version again is an idempotent no-op. If another OpenACP process installs a different version while a download is in progress, the waiting install does not overwrite or downgrade it. Use `--force` only when you intend to replace the currently installed version; the version check is repeated under the same per-agent lock immediately before activation.

`agents.json` uses an interprocess lock, revisioned merge, and atomic replacement. Concurrent installs or catalog reconciliation preserve unrelated agent entries, and a same-agent reconciliation conflict is retained for a later retry. If the file contains invalid JSON or an invalid schema, the first subsequent write preserves it as an owner-only `agents.json.corrupt-*` file before creating a valid store.

Some agents require additional setup after installation. Setup steps appear as copyable commands, for example:

```
Install Claude CLI: npm install -g @anthropic-ai/claude-code
Login: claude login (opens browser)
```

## Uninstalling an agent

Agents can be uninstalled from the CLI (see [CLI Commands](../api-reference/cli-commands.md) for the full command reference):

```
openacp agents uninstall <name>
```

This removes the agent's binary and configuration from `~/.openacp/agents/`. Any existing sessions using that agent are not affected until they end.

Binary removal uses the same per-agent transaction lock as installation. Before moving the active runtime, OpenACP writes an owner-only recovery journal. If the process exits before `agents.json` removal commits, the next startup or agent operation restores the runtime; if metadata removal already committed, it finishes deleting only the detached old-runtime backup. Cosmetic metadata edits made by another process do not change runtime ownership and are retained during recovery. A complete replacement activation is preserved; if replacement metadata points at the old path but its runtime is missing, OpenACP retains the only recovery backup and journal for a later safe retry instead of deleting it. `openacp doctor` reports an interrupted transaction and applies the same safe recovery. A blocked post-commit cleanup leaves the agent uninstalled and retains a retryable journal instead of restoring stale metadata.

## Switching agent per session

Pass the agent name to `/new` to use a specific agent for a session:

```
/new claude
/new gemini ~/code/my-project
```

If you have only one agent installed, it is selected automatically.

## Switching agents mid-conversation

Use `/switch` to change the agent handling the current session without starting a new thread or topic:

```
/switch                        # show a menu of available agents
/switch claude                 # switch directly to the claude agent
/switch gemini                 # switch directly to the gemini agent
```

The conversation history from the current session is automatically injected into the new agent, so it has full context of what was discussed. If you switch back to a previously used agent without having sent any new user prompts since the last switch, the old session is resumed (provided the agent supports resume). Otherwise a new session is started with the history prepended.

To label messages in the history with the agent name that produced them, use:

```
/switch label on               # enable agent name labels
/switch label off              # disable agent name labels
```

This is controlled globally by the `agentSwitch.labelHistory` config option (default: `true`).

For full details see [Agent Switch](../features/agent-switch.md).

## Default agent

The default agent is used when you create a session without specifying one. Configure it in `<instance-root>/config.json` (e.g. `~/openacp-workspace/.openacp/config.json`):

```json
{
  "defaultAgent": "claude"
}
```

Or use `/settings` to change it in-chat.

## Agent types

Agents are distributed in four ways:

| Type | Description | Example |
|---|---|---|
| `npx` | Runs an exact Node.js package version | `npx agent-package@1.2.3` |
| `uvx` | Runs an exact Python tool version with uv | `uvx agent-package@1.2.3` |
| `binary` | Platform-specific binary download | `codex` |
| `custom` | User-defined command and arguments | Any local tool |

OpenACP detects which distribution method is appropriate for your platform and handles installation automatically. If a required runtime (`node`, `npx`, `uv`, `uvx`) is missing, the agent shows as unavailable with an install hint.

## Popular agents

| Agent | Distribution | Notes |
|---|---|---|
| Claude (claude-code) | npx | Requires Anthropic API key or Claude login |
| Gemini CLI | npx | Requires Google AI API key |
| Codex CLI | binary | Requires OpenAI API key |
| Goose | uvx | Requires Python / uv |

Use `/agents` for the current full list — the registry is updated independently of OpenACP releases.

## Agent capabilities

Some agents declare capabilities that OpenACP uses to enable features:

- **Audio** — If an agent supports native audio input, voice attachments are passed directly rather than transcribed
- **Commands** — Agents can publish slash commands that appear as action buttons in the session topic. Tapping one sends the command to the current agent with exactly one leading `/`. If the command declares an input hint, OpenACP asks for the argument first. Typed OpenACP system commands keep precedence when a name overlaps; the agent button remains explicitly routed to the agent. Switching or terminating a session invalidates pending controls immediately, so delayed buttons and queued local responses from the old agent are ignored.

Capabilities are detected automatically when a session starts.

## Custom agents

You can add a custom agent directly to your config without going through the registry:

```json
{
  "agents": {
    "my-agent": {
      "command": "node",
      "args": ["/path/to/my-agent.js"],
      "workingDirectory": "~/code",
      "env": {
        "MY_API_KEY": "..."
      }
    }
  }
}
```

The agent must implement the ACP protocol to communicate with OpenACP.
