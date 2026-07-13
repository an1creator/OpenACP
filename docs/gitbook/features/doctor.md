# Doctor

## What it is

`openacp doctor` runs a suite of system health checks and reports the status of every major component. It is the fastest way to diagnose why something is not working — misconfigured tokens, missing agent binaries, stale PID files, corrupt sessions data, and more.

---

## Running doctor

From the terminal:

```bash
openacp doctor
```

From inside Telegram or Discord, send `/doctor` in the Assistant topic.

Each check produces one or more results with a status of `pass`, `warn`, or `fail`. Interactive output starts with the overall result, shows failures and warnings before a compact pass count, and keeps Telegram output below its message limit. Telegram also provides **Run again**, **Speech-to-text settings**, and **Network proxy settings** actions. `--json` keeps the stable full report schema for automation.

---

## Checks

| Check | What it verifies |
|-------|-----------------|
| **Config** | Config file exists, is valid JSON, passes schema validation, and has no pending migrations |
| **Agents** | Each configured agent's binary exists on PATH; flags a missing default agent as a failure |
| **Telegram** | Bot token is set, the bot can reach the Telegram API, and the configured chat ID resolves to a supergroup with forum topics enabled |
| **Discord** | Bot token and guild ID are set, the bot can connect and access the configured guild |
| **Storage** | Instance root exists and is writable; `sessions.json` is valid; log directory exists and is writable |
| **Workspace** | The instance workspace directory (parent of `.openacp/`) exists and is readable |
| **Plugins** | Plugins directory exists; each installed plugin can be loaded without errors |
| **Daemon** | PID file is valid and the process is alive; API port file is valid; API port is in use by OpenACP (not another process) |
| **Tunnel** | Tunnel is enabled; configured provider is recognized; `cloudflared` binary is present (for Cloudflare provider); tunnel port is in valid range |
| **Speech-to-text** | Selected method, local runtime readiness or authenticated Groq access, hidden key status, and the `services.speech` / `services.speechDownloads` route boundary |
| **Network proxy** | Native scoped-routing store health and whether the running daemon itself has legacy proxy variables. On Linux, the daemon process is inspected by variable name only; caller-shell variables are reported separately and never treated as proof of daemon compatibility mode. |

---

## Auto-fix

Some issues can be fixed automatically. When a fix is marked as safe (low risk), doctor applies it immediately and reports what was done. Examples of safe auto-fixes:

- Applying pending config migrations
- Removing a stale or invalid PID file
- Removing an invalid API port file
- Creating a missing log directory
- Installing the `cloudflared` binary

Fixes that are risky (could cause data loss, such as resetting a corrupt sessions file) are listed as pending and require explicit confirmation before they are applied.

---

## Exit code

`openacp doctor` exits with code `0` if all checks pass or produce only warnings. It exits with code `1` if any check fails. This makes it usable in CI or startup scripts:

```bash
openacp doctor || exit 1
```
