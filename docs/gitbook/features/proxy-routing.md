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
  `services.pluginInstaller`, `services.speech`, `services.speechDownloads`, and
  `services.default`; Groq inherits `services.default` unless
  `services.speech` has an exact route
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
chmod 600 /path/to/profile.json
openacp proxy create usa --from-json /path/to/profile.json
openacp proxy update usa --from-json /path/to/profile.json --expected-revision 12
openacp proxy set global direct
openacp proxy set channels.telegram profile:usa
openacp proxy set agents.codex profile:usa
openacp proxy set agents.cursor direct
openacp proxy clear agents.cursor
openacp proxy test --scope channels.telegram
openacp proxy test --profile usa
openacp proxy delete usa --reassign direct --expected-revision 14
```

In Telegram, open **Settings → Network proxy** or use `/proxy` directly. The
main action menu keeps one Settings entry instead of duplicating proxy management
beside it; already-sent legacy proxy buttons continue to open the same home. The
connector-neutral home starts with the current mode, global default, profile
count, and route-override count. **Routes** uses human traffic labels; every scope shows its saved override,
effective route, and resolution source separately. **Proxy profiles** supports
full add/edit flows, a quick hidden proxy URL mode, manual endpoint setup,
candidate testing before save, credential replacement/clearing, and direct
**Assign this profile** navigation that preserves the selected profile,
transactional deletion with route reassignment, the routing matrix, route
selectors, and connectivity tests, so other adapters can render the same
management model. Wizard drafts exist only in memory for ten minutes, are bound
to the invoking connector, user, and conversation, and carry the policy revision
used for optimistic concurrency.

At startup and after plugin command changes, OpenACP reconciles Telegram's
neutral, English, and Russian default and configured-supergroup command lists
with the current command registry. An existing administrator-specific list is
reconciled too, so it cannot hide `/proxy`. Unknown commands remain unmanaged;
OpenACP removes only historical built-ins during the initial migration and
commands recorded in its ownership ledger afterward. The mode-0600 global
ledger is keyed by the public bot ID, a hashed chat alias, scope, and locale so
one instance owns synchronization for each bot. A second instance fails before
reading or changing Telegram lists; use a unique Telegram bot for every OpenACP
instance. A stopped same-host owner can be replaced only by an explicit one-time
`OPENACP_TELEGRAM_COMMAND_TAKEOVER=1` start, while cross-host ownership is never
stolen. Per-member lists remain untouched. Reconciliation is idempotent, coalesced, cancellable on
adapter stop, and non-fatal. `/doctor` checks the same effective neutral/en/ru
scope precedence, identifies the exact stale audience, and warns about ownership
conflicts.

Before ownership or Bot API calls, OpenACP validates the complete command
boundary. Core commands, including `/proxy`, have priority. Plugin command names
must match `[a-z0-9_]{1,32}` and trimmed descriptions must contain 1-256
characters. Invalid entries and deterministic overflow beyond Telegram's
100-command limit are skipped with aggregate warnings and never enter retries or
the ownership ledger.

Telegram captures credential fields with a one-time ForceReply and deletes the
reply before dispatching the value to the command handler. If deletion fails,
OpenACP discards the value and points the operator to the protected CLI/API path.
Connectors that cannot guarantee private or delete-before-dispatch input must not
accept credential text and render that fallback instead. For non-interactive
automation, `create`, `update`, and `test-candidate` accept a mode-0600 JSON file;
secrets must not be placed in command-line arguments.

In the route UI, **Use host proxy settings** persists the literal `inherit`
route. **Use parent route** removes the exact override so category/global route
precedence applies. These actions are intentionally separate; the scope detail
screen marks the saved choice and reports the resulting effective route and
source before any change.

Quick mode accepts a single `http://`, `https://`, `socks5://`, or `socks5h://`
URL with an explicit port. Percent-encoded credentials and bracketed IPv6 are
supported. The URL is parsed immediately into endpoint fields and the separate
secret record; the original value is neither retained in the draft nor
persisted. On edit, a replacement URL without credentials explicitly clears the
old credential record. Manual mode walks through protocol, host, port, and then
an explicit choice between no authentication and a complete non-empty
username/password pair. The former `-` sentinel is not accepted as no-auth.
Profile names are trimmed and must contain 1-100 characters.

The connector `/proxy` command requires `network:proxy:manage` before reading
status, profiles, routes, diagnostics, or test results; missing identity fails
closed with no policy data. REST authorization remains unchanged and is
documented separately. Connector mutations reauthorize again at execution time,
including every button callback and follow-up wizard input. Long connector menus
are paginated; drafts cannot be resumed by another member or topic.

## Runtime behavior and safety

- Telegram polling, outbound messages, and file downloads use
  `channels.telegram`.
- Telegram doctor, setup validation, startup prerequisite checks, and retry
  validation use that same scoped transport, so clean environments diagnose
  both direct and profile routes consistently.
- Telegram `/update`, `openacp update`, and interactive pre-start update checks
  use `services.npmUpdate` for both registry requests and npm child processes
  whenever an instance root is available.
- ACP registry refresh and binary downloads use `services.agentRegistry`.
  The plugin catalog is packaged and always offline; npm plugin installs
  (including `/tts install`) use `services.pluginInstaller`. Whisper environment/pip/model downloads use
  `services.speechDownloads`, while Groq STT requests use `services.speech`.
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
- Groq resolves `services.speech` at each remote request and Whisper resolves
  `services.speechDownloads` at each subprocess spawn, so profile rotation applies without daemon
  restart. Binary ACP downloads use the same native stream contract with size,
  progress, cancellation, and cleanup handling.
- Route writes are serialized and the REST API exposes a monotonically increasing
  `revision`. Send `expectedRevision` on administrative writes to prevent a stale
  dashboard or connector from overwriting a newer operator change; conflicts
  return HTTP 409.
- A profile referenced by routes cannot simply disappear. Deletion either fails
  with `PROXY_PROFILE_IN_USE` or tests and commits one atomic reassignment+delete
  transaction, then retires only the transports whose resolution changed.

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
| Plugin and speech downloads | independent service scopes can be direct | npm plugin children use `services.pluginInstaller`; Groq resolves `services.speech`; Whisper children resolve `services.speechDownloads` | TTS installs cannot accidentally inherit either STT route |
| Policy persistence | valid dynamic scopes survive restart | two real Node processes serialize writes and stale dead owners recover | metadata/secrets mismatch, invalid references, and corrupt journals fail closed |
| Transport lifecycle | unrelated route edits do not affect a live stream | saved fetch facades pick up profile rotation | body cancellation and bounded abandoned leases release retired agents |
| Release artifacts | clean and dirty build roots produce the same files | two builds have identical SHA-256 and npm pack manifests | nested/stale `dist` files fail verification before publish |
