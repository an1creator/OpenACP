## Unreleased

## 2026.713.1 - 2026-07-13

### Added

- Add connector-neutral Speech-to-Text settings under Settings with fail-closed
  administrator authorization, secure write-only Groq key rotation,
  connector-safe local faster-whisper controls, redacted review, and immediate provider reload
  that preserves TTS registrations.
- Replace the unavailable plugin-registry endpoint with a deterministic,
  offline-only catalog shipped in the npm package. Direct npm package installs
  remain available without giving packages a maintained-catalog endorsement.

### Changed

- Route Groq STT through `services.speech` while reserving
  `services.speechDownloads` for the local Whisper runtime and first model
  download. The durable Groq scope inherits `services.default` unless assigned
  an exact route.

### Fixed

- Stage community npm plugins with lifecycle scripts disabled, validate the
  complete OpenACP plugin contract and explicit install hook before activation,
  serialize installers with a process-owned lock, and use a durable phase journal
  to restore or finish package, settings, and registry state after failure or
  process termination.
- Restore the exact registry entry and previous settings when version migration
  fails, and retain a durable quarantine when rollback persistence is incomplete
  instead of starting new code against old or partial settings.
- Persist plugin settings with atomic fsync/rename writes, mode `0600` files,
  mode `0700` directories including the settings base, fail-closed permission
  repair, and repair of permissive legacy modes.
- Serialize every plugin-registry writer through the package mutation lock,
  preserve concurrent independent updates, and require the journaled CLI install
  plus restart instead of mutating the shared npm tree from runtime commands.
- Atomically replace factory-owned STT providers on hot reload while preserving
  external TTS providers and in-flight transcription references.

## 2026.712.12 - 2026-07-12

### Documentation

- Align the public README, contribution paths, generated plugin guides, and
  community templates with the maintained `an1creator/OpenACP` repository and
  `@n1creator` packages. Replace upstream GitBook/social references with
  repository-owned documentation and remove instructions that depended on the
  unavailable `Open-ACP/plugin-registry` repository.
- Correct the active plugin-author contract for Node.js 20, calendar-versioned
  CLI/SDK compatibility, public package imports, and `main`-targeted pull
  requests. Document service-based adapter registration, restore enabled
  Issues/Discussions routes, add a private conduct channel, and add a root
  security policy with its private GitHub advisory route.
- Align the plugin SDK test helper and active architecture references with the
  current `InstallContext`, which no longer exposes a generic `legacyConfig`
  field.

## 2026.712.11 - 2026-07-12

### Changed

- Move proxy management from a separate main action-menu item into Settings.
  The Settings entry reuses the connector-neutral `/proxy` home, while direct
  `/proxy`, Telegram command discovery, and already-sent legacy menu buttons
  remain available. Telegram carries an allow-listed return target through
  proxy submenus and wizard callbacks, while direct and legacy entry points do
  not inherit Settings navigation.

### Security

- Require `network:proxy:manage` before every connector `/proxy` action,
  including status, profile/route views, diagnostics, and connectivity tests.
  Missing or failing identity resolution returns one typed safe error before
  proxy policy data is read; mutations retain an additional execution-time
  authorization check.

## 2026.712.10 - 2026-07-12

### Added

- Full connector-neutral proxy profile add/edit wizard with candidate testing,
  revision-safe save, credential clearing, pagination, and atomic route
  reassignment during deletion. Telegram exposes it through `/proxy`, bot
  command discovery, and the main menu.
- Two explicit profile creation paths: quick write-only `proxyUrl` input and a
  guided protocol/host/port/authentication flow. URL input supports HTTP, HTTPS,
  SOCKS5, SOCKS5H, percent-encoded credentials, and bracketed IPv6 without
  persisting or returning the source URL.
- Protected proxy profile create/update/candidate-test CLI operations using
  mode-0600 JSON files, plus matching REST endpoints and typed missing-profile
  responses.

### Fixed

- Reconcile Telegram command discovery against the current command registry for
  neutral, English, and Russian locales in both the default and configured-
  supergroup scopes, including pre-existing administrator overrides. Stale
  chat-specific lists no longer hide `/proxy`; unknown commands are preserved
  and OpenACP removes only commands in its mode-0600 ownership ledger;
  startup reads the authoritative registry after grammY is ready instead of
  depending on a pre-start event, while synchronization remains idempotent,
  retryable, and reported by `openacp doctor` without making a transient Bot API
  failure fatal to startup.
- Validate plugin commands before ownership or Bot API retries, preserve required
  core commands under the deterministic 100-command limit, and enforce one
  heartbeat-backed command-sync owner per public Telegram bot ID. Explicit
  takeover is limited to a provably stopped same-host owner.
- Cancel freshly created API sessions without an invalid state transition;
  concurrent cancellation now aborts/destroys once and returns an idempotent,
  typed API/CLI result for terminal sessions. Cancellation is flushed before
  teardown; failed process/logger cleanup is reported as retryable without making
  the session restorable.
- Require explicit no-authentication selection in the proxy wizard, reject the
  ambiguous `-` credential sentinel, and validate trimmed profile names at the
  100-character boundary before network or persistence work.
- Make proxy management prominent and complete in packaged CLI help, including
  protected profile CRUD, unsaved candidate testing, scoped route operations,
  reassignment, revision flags, and write-only credential guidance.
- Return stable JSON envelopes for every local proxy CLI input failure and keep
  human errors concise, without falling through to the top-level fatal stack or
  exposing protected input paths.
- Verify the packaged Quick URL/proxyUrl XOR and redaction contract in clean,
  deterministic publish builds rather than checking help text alone.

### Security

- Bind proxy wizard drafts and follow-up input to the authenticated connector,
  user, and conversation with bounded RAM-only TTL state and revision CAS.
  Telegram requires a reply to the exact prompt and deletes credential messages
  before dispatch; failed deletion discards the value and falls back to the
  protected CLI/API path.

## 2026.712.9 - 2026-07-12

### Added

- Native scoped proxy profiles and routing for channel transports, per-agent ACP
  subprocesses, services, and plugin-defined flows. Includes HTTP/HTTPS/SOCKS5/
  SOCKS5H internal transports, `direct`/`inherit`/`profile` precedence, protected
  credential persistence, redacted REST/CLI diagnostics, `/proxy` connector UI,
  env-file migration, and test-before-apply rollback for Telegram routes.
- Revisioned, journaled proxy policy transactions with last-known-good recovery,
  corrupt-file quarantine/fail-closed behavior, persisted dynamic scopes, and
  optimistic concurrency for administrative API writes.
- Cross-process policy locking with stale-owner recovery, strict persisted
  schema/reference validation, parent-directory fsync, and safe IPv6 migration.

### Fixed

- Preserve proxy profile labels passed through the top-level `--name` parser and
  return non-zero typed CLI errors for connectivity/transaction failures.
- Keep systemd/launchd ownership authoritative across start, stop, restart, and
  package update; stop no longer uninstalls an enabled unit and restart no longer
  spawns a detached competitor.
- Restore explicit runtime intent before supervisor activation and require an
  active managed process plus a matching live API health response before start or
  restart reports success, including the managed stop-to-start sequence.
- Report daemon-wide proxy compatibility mode in proxy status/doctor and set
  `NODE_USE_ENV_PROXY=0` for strict direct ACP child routes.
- Route Telegram doctor, installation validation, startup prerequisites, retry
  validation, and polling helpers through the authoritative
  `channels.telegram` transport instead of an independent global fetch path.
- Route ACP/plugin registries, binary/plugin installation, and speech/model
  downloads through their declared service scopes, with stable hot-swappable
  fetch facades and generation-safe warm ACP processes.
- Route Telegram, manual CLI, and interactive pre-start package update checks
  plus npm children through `services.npmUpdate` when an instance is available.
- Make systemd unit replacement transactional and identify both systemd and
  launchd ownership explicitly, refusing detached fallback after partial setup.
- Normalize scoped responses to native Web Streams, retire only affected
  transports after in-flight bodies complete, and resolve speech child policy at
  every spawn/install without daemon restart.
- Keep the plugin SDK scoped-fetch body contract honest: portable text/form/blob
  bodies are supported, while Web stream request bodies are rejected instead of
  being silently serialized as `[object ReadableStream]`.
- Gate Node's `--use-env-proxy` child option on runtime support so Node 20 ACP
  processes retain HTTP(S) proxy variables without failing at startup, and move
  CI actions to maintained Node 24-runtime majors without weakening the matrix.
- Publish npm packages through supported OIDC-only `npm publish` operations in
  dependency order (CLI before its peer-dependent plugin SDK); remove unsupported
  automated dist-tag mutation and fail safely on non-latest immutable versions.

### Security

- Centrally redact network credentials before proxy errors reach the REST API,
  CLI, or logs. This covers Telegram bot-token paths, URL userinfo, common secret
  query parameters, authorization/API-key headers, cookies, and structured log
  fields while retaining actionable host and path context.
- Require `network:proxy:manage` for every REST/connector mutation, reauthorize
  Telegram callbacks, and restrict custom test targets to public HTTPS
  destinations to prevent SSRF through proxy diagnostics.
- Suppress credential-risk proxy `DEBUG` namespaces inside the daemon as well as
  child processes, while preserving unrelated debug namespaces.

## 2026.712.8 - 2026-07-12

### Fixed

- Made identity `updatedAt` advance monotonically even when create and update happen within the same millisecond, removing a Node 24 CI race.

### Changed

- Agent warm-pool: server keeps one pre-initialized AgentInstance ready in the background for the default agent, so first `POST /sessions` calls pay only for the `newSession` RPC (~300ms) instead of a full subprocess spawn (~2–3s). Refills after consumption; 5-min idle TTL; liveness-checked before claim.

## 2026.712.7 - 2026-07-12

### Fixed

- Merge live-only sessions with persisted session records so session listings and health counters report the same active and total population.

## 2026.712.6 - 2026-07-12

### Security

- Redact all agent environment values returned by the list, reload, and detail API routes so proxy credentials and other secrets cannot leak through `openacp api agents --json`.

## 2026.712.5 - 2026-07-12

### Added

- Native `local-whisper` STT provider with a bundled faster-whisper runtime, hot-reloadable settings, environment overrides, and compatibility with the former local speech wrapper cache.
