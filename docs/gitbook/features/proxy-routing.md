# Scoped Proxy Routing

OpenACP routes network flows independently. It does not patch global `fetch`,
install a process-wide dispatcher, or require every request on the host to use
the same proxy.

## Profiles and routes

A profile describes an upstream proxy: HTTP, HTTPS, SOCKS5, or SOCKS5H. A route
assigns one profile—or an explicit direct/inherited policy—to a scope.

Routes have three states:

- `direct`: remove inherited proxy variables and connect directly.
- `inherit`: preserve the host's `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and
  `NO_PROXY` behavior. This is the backward-compatible default.
- `profile:<id>`: use the named OpenACP profile.

Resolution order is exact scope, category default, then global default. For
example, `agents.codex` overrides `agents.default`, which overrides `global`.

Built-in scopes include:

- `channels.telegram` and `channels.default`
- `agents.<name>` and `agents.default`
- `services.npmUpdate`, `services.agentRegistry`,
  `services.pluginInstaller`, `services.speechDownloads`, and `services.default`
- `plugins.default`; plugins can register additional `plugins.<name>.<flow>`
  scopes through the core `proxy` service

Plugin authors can import the `ProxyService` type from
`@n1creator/openacp-plugin-sdk`, resolve it with `ctx.getService<ProxyService>('proxy')`,
register a scope, and request a scoped fetch implementation.

## Credential storage

Non-secret routing metadata is stored in `<instance-root>/proxy.json`.
Credentials are stored separately in `<instance-root>/proxy-secrets.json` with
mode `0600`. API, CLI, Telegram status, and diagnostics expose only
`hasCredentials`; they never return usernames, passwords, or proxy URLs with
userinfo.

The policy store is versioned and revisioned. Metadata and secrets are committed
under a cross-process lock as one journaled transaction using fsynced atomic
renames (including the parent directory where supported), and the last known-good
transaction is retained for operator recovery. A malformed policy or secret
file is copied to a timestamped `.corrupt.*` quarantine and network consumers
fail closed; OpenACP does not replace malformed data with defaults. `openacp
doctor` reports this state. Restore a reviewed last-known-good copy or repair the
quarantined file before restarting network work.

Import an existing conventional env file without placing its contents in shell
arguments:

```bash
chmod 600 /path/to/openacp-proxy.env
openacp proxy import usa --env-file /path/to/openacp-proxy.env
```

The importer recognizes uppercase and lowercase HTTP(S)/ALL proxy variables and
`NO_PROXY`, copies the credential into the protected store, and does not retain
the source file path.

## CLI and connector UI

```bash
openacp proxy status
openacp proxy set global direct
openacp proxy set channels.telegram profile:usa
openacp proxy set agents.codex profile:usa
openacp proxy set agents.cursor direct
openacp proxy clear agents.cursor
openacp proxy test --scope channels.telegram
openacp proxy test --profile usa
```

In Telegram, use `/proxy`. The connector-neutral menus support profile listing,
protected env-file import/replacement, confirmed deletion, the routing matrix,
route selectors, and connectivity tests, so other adapters can render the same
management model. Credentials are never accepted as chat text; import references
a mode-0600 file already present on the host.

Viewing status and running the fixed connectivity checks is read-only. Import,
profile deletion, and route changes require the `network:proxy:manage`
capability in both command callbacks and REST requests. Long connector menus are
paginated, and authorization is checked again when a button is pressed rather
than trusted from the menu that created it.

## Runtime behavior and safety

- Telegram polling, outbound messages, and file downloads use
  `channels.telegram`.
- Telegram doctor, setup validation, startup prerequisite checks, and retry
  validation use that same scoped transport, so clean environments diagnose
  both direct and profile routes consistently.
- Telegram `/update`, `openacp update`, and interactive pre-start update checks
  use `services.npmUpdate` for both registry requests and npm child processes
  whenever an instance root is available.
- ACP registry refresh and binary downloads use `services.agentRegistry`;
  plugin registry and npm plugin installs (including `/tts install`) use
  `services.pluginInstaller`; Whisper environment/pip/model downloads and Groq
  STT requests use `services.speechDownloads`.
- A Telegram-affecting exact, category, global, or profile edit is tested with
  `getMe` before persistence. A failed test leaves the old route and transport.
- HTTP/HTTPS agent routes set standard upper/lowercase proxy variables,
  `NO_PROXY`, and Node proxy flags when supported by the running Node version.
- `direct` scrubs all proxy variables from ACP child environments.
- Agent route changes invalidate only the idle warm process. Active sessions are
  not killed; new processes use the new route.
- SOCKS5/SOCKS5H are fully supported for OpenACP internal HTTP transports.
  Arbitrary ACP agents receive `ALL_PROXY`, but agent support varies; status
  reports this as `best-effort-socks-env` instead of promising compatibility.
- Internal transports fail closed by default. Direct fallback must be explicitly
  enabled on the profile with `failClosed: false`; arbitrary ACP child clients
  control their own connection-failure behavior.
- Scoped fetch objects are stable facades: a plugin may retain one, while each
  call resolves the current policy. Profile/route edits therefore take effect
  without requiring consumers to reacquire the service.
- Responses are normalized to the native Response/Web Streams contract even though
  the internal HTTP client uses Node streams. Retired transports are tracked per
  affected scope and closed only after in-flight response bodies finish or are
  cancelled; an agent route edit cannot tear down an unrelated Telegram poll.
  An abandoned response on a retired transport is cancelled after a five-minute
  maximum lease so obsolete proxy agents cannot remain allocated forever.
- Speech providers resolve `services.speechDownloads` at each remote request or
  Whisper subprocess spawn, so profile rotation applies without daemon
  restart. Binary ACP downloads use the same native stream contract with size,
  progress, cancellation, and cleanup handling.
- Route writes are serialized and the REST API exposes a monotonically increasing
  `revision`. Send `expectedRevision` on administrative writes to prevent a stale
  dashboard or connector from overwriting a newer operator change; conflicts
  return HTTP 409.

## Migration from global proxy wrappers

`openacp proxy status` and `openacp doctor` report compatibility mode when the
daemon inherited proxy variables. The source may be both a systemd
`EnvironmentFile=` drop-in and the executable referenced by `ExecStart` (for
example, a legacy wrapper that sources the same env file). Removing only one
source is insufficient.

Safe migration order:

1. Import the existing mode-0600 env file as a profile.
2. Keep global routing as `inherit` during initial validation.
3. Set and test exact routes for required channels/agents; set unrelated routes
   to `direct`. Create fresh ACP processes to verify their environments.
4. Set global/category defaults and re-run `openacp proxy status`.
5. Inspect the installed unit and drop-ins with
   `systemctl --user cat <openacp-unit>`. Identify both `EnvironmentFile=` and
   any proxy-sourcing `ExecStart` wrapper.
6. Replace the legacy wrapper with a stable non-proxy wrapper (or point
   `ExecStart` at the packaged CLI), remove only the OpenACP proxy drop-in, and
   run `systemctl --user daemon-reload`.
7. Run `openacp restart`. It must use systemd, leave the unit active/enabled,
   and create no detached competitor.
8. Re-test Telegram, scope connectivity, and new Codex/Cursor sessions. Confirm
   status/doctor no longer report compatibility mode.

Do not rotate or edit a shared proxy service used by other applications during
this migration.

Package upgrades do not overwrite `proxy.json` or `proxy-secrets.json`.

## Acceptance validation matrix

The maintained release exercises policy boundaries rather than only schema and
menu rendering:

| Boundary | Direct/inherit case | Profile/rotation case | Failure/safety case |
|---|---|---|---|
| Telegram channel | polling and API helpers use `channels.telegram` | an in-flight response finishes on the old profile while the next call uses the new profile | failed `getMe` candidate is not committed |
| Agent catalog | standalone CLI refresh/install uses `services.agentRegistry` | a real local HTTP proxy serves both registry JSON and binary archive | corrupt policy fails closed before registry access |
| ACP processes | `direct` removes inherited proxy variables | HTTP(S) env reaches new Codex/Cursor processes; SOCKS is reported best-effort | active sessions stay alive while only idle warm processes invalidate |
| Plugin and speech downloads | independent service scopes can be direct | npm plugin children use `services.pluginInstaller`; Groq and Whisper children resolve `services.speechDownloads` on every action | TTS installs cannot accidentally inherit the speech-download route |
| Policy persistence | valid dynamic scopes survive restart | two real Node processes serialize writes and stale dead owners recover | metadata/secrets mismatch, invalid references, and corrupt journals fail closed |
| Transport lifecycle | unrelated route edits do not affect a live stream | saved fetch facades pick up profile rotation | body cancellation and bounded abandoned leases release retired agents |
| Release artifacts | clean and dirty build roots produce the same files | two builds have identical SHA-256 and npm pack manifests | nested/stale `dist` files fail verification before publish |
