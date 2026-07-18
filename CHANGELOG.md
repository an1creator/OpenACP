## Unreleased

## 2026.718.4 - 2026-07-18

### Changed

- Limit connector action UI to the intersection of each agent's advertised
  commands and the global ten-action vocabulary. An attested official Codex
  installation resolves `/skills` locally as a bounded names-only inventory
  without starting a model turn; this does not change Codex's model-visible
  command or skill inventory.
- Bind action snapshots and local responses to agent, attachment, and action
  epochs with immutable transport targets. Agent switches now retire stale UI,
  preserve explicit concurrent detaches, and commit runtime, bridges, and stored
  identity as one recoverable operation.
- Fingerprint the complete resolved agent definition, subprocess environment,
  workspace, and allowed paths before publishing or claiming a warm runtime.
- Refresh the reviewed offline ACP registry snapshot with current Dirac,
  fast-agent, GLM, Grok, Harn, and Qwen Code releases.

### Fixed

- Restore the public CLI and plugin SDK `/testing` exports from one shared
  adapter-conformance implementation and verify both packed contracts in a
  clean consumer project.

## 2026.718.3 - 2026-07-18

### Added

- Support connector-neutral ACP form elicitation with validated transient values,
  Telegram form controls, authenticated REST resolution, owner-filtered SSE events,
  and matching CLI and plugin SDK contracts. Adapters without a form renderer receive
  a visible REST fallback for non-sensitive requests.
- Expose agent-advertised commands as session-scoped Telegram actions while keeping
  OpenACP slash commands authoritative, and persist multi-message command menus with
  restart-safe cleanup.
- Add a read-only session queue endpoint and richer agent catalog diagnostics for
  source, freshness, validation, recovery, and reconciliation state.

### Changed

- Require exact reviewed npx and uvx runner versions, reconcile only provably newer
  compatible SemVer or PEP 440 releases, and show installed and available versions
  separately. Explicit registry refresh now fails truthfully when no valid live
  catalog can be fetched.
- Make agent installation and removal crash-consistent across OpenACP processes.
  Binary zip, tar, and raw-executable distributions use checksum verification,
  per-agent locking, atomic metadata commits, recovery journals, and bounded
  post-commit cleanup without rolling back a working replacement.
- Keep machine-readable CLI output stable regardless of documented global flag
  order, including early migration and already-running checks, and extend packaged
  artifact verification over those public command paths.
- Serialize per-session configuration changes, revision-guard persistence, cancel
  queued changes on agent replacement, and return the agent-acknowledged snapshot
  for each request.

### Fixed

- Reserve concurrent-session capacity before ACP startup and lazy resume, retain one
  exact lease per live session, and require errored sessions to reacquire capacity
  before accepting more work.
- Keep generated session titles to five words and 50 characters, reject prompt echoes,
  preserve stored and manual names, and prevent late naming results from an old agent
  from overwriting a switch, termination, or newer title.
- Bound failed ACP initialization cleanup and daemon shutdown, retain truthful health
  ownership until process exit is confirmed, and prevent abandoned children from
  blocking supervised restart indefinitely.
- Preserve form, command-menu, and SSE ownership through duplicate delivery,
  reconnect, cancellation, switch, and teardown races without leaking submitted
  values or resuming a stale session.

### Security

- Bind structured-input responses to the initiating API principal or canonical user,
  require protected Codex fields to use Telegram delete-after-capture or HTTPS/
  loopback REST, omit submitted values from history and events, and reject
  agent-supplied string patterns instead of evaluating untrusted regular expressions.
- Validate registry runners and binary archive paths before activation, preserve
  corrupt agent stores for recovery, and keep installer and catalog diagnostics
  bounded and free of credentials.

## 2026.718.2 - 2026-07-18

### Added

- Expose authenticated `serviceResources` health diagnostics for the hidden
  Assistant session, terminal cleanup operations, and the single-slot ACP warm
  pool without adding internal sessions to normal session listings.
- Export the API message-principal, prompt-dispatch outcome, and service-resource
  status types from the CLI package and plugin SDK.

### Changed

- Make REST and SSE prompt submission return HTTP 202 only after middleware and
  queue admission, with a stable `accepted` response, preserved `turnId`, and
  current `queueDepth`. The CLI now reports that the prompt was accepted rather
  than implying that the agent already processed it.
- Treat authenticated API secrets and JWTs as API principals rather than
  connector users. Connector `allowedUserIds` remains scoped to connector
  traffic; JWT scopes and the global concurrent-session limit still apply.

### Fixed

- Return typed `MESSAGE_BLOCKED` (403) and `SESSION_LIMIT` (429) prompt errors
  without emitting queued events or dispatching blocked work to the agent.
- Tear down ordinary finished-session ACP processes, loggers, bridge ownership,
  and live registry entries after the final channel-delivery barrier while
  retaining the durable record for lazy resume.
- Reap idle warm ACP processes after five minutes in the background, retain
  ownership through bounded destroy retries, expose truthful cleanup state,
  invalidate in-flight prewarm work during shutdown, and keep shutdown idempotent.
- Preserve idempotent cancellation responses while sharing one bounded process
  teardown across completion, cancellation, and retry races. Store-backed
  managers follow durable record TTL; store-less retry tombstones are bounded by
  time and capacity.

## 2026.718.1 - 2026-07-18

### Changed

- Raise the native Local Whisper time limit from two to ten minutes so first-run
  environment setup, model download, and CPU transcription have a practical
  default. Migrate 1.0.0 settings equal to that old default and preserve absent
  settings and all other values.
- Pass prompt cancellation to STT providers and define the optional SDK
  `STTOptions.signal` cleanup contract. The turn lifecycle now starts before
  local speech preprocessing so cancellation retains paired lifecycle events.
- Align the SDK speech test mock with canonical result-returning methods while
  retaining deprecated `textToSpeech()` and `speechToText()` aliases for
  test-only backward compatibility. The CLI, SDK, and runtime now expose the
  same `synthesize()`, `transcribe()`, and provider-registration contract and
  no longer advertise an STT unregister method that the runtime does not have.
- Refresh the bundled offline ACP catalog from the official public registry,
  including `@agentclientprotocol/codex-acp` 1.1.4, Claude Agent ACP 0.59.0,
  and Harn 0.10.23 with current binary checksums. Update compatible Fastify
  Swagger, grammY, and tsx patch/minor dependencies.
- Raise the supported runtime from Node.js 20 to Node.js 22 because Claude
  Agent ACP 0.59.0 requires Node.js 22. Installers default to Node.js 24, and
  release gates cover Node.js 22 and 24; Node.js 20 is no longer supported.

### Fixed

- Replace the opaque Local Whisper `(exit null)` failure with specific bounded
  timeout, signal, output-limit, missing-runtime, and exit-code diagnostics.
  Timeouts and cancellation terminate the helper process group, remove temporary
  audio, and wait for cleanup before the next queued prompt starts.
- Keep transcription fallback nonfatal: show a visible warning, preserve the
  original audio for the agent, and leave the session active.
- Bound service/API session cancellation even when both the ACP prompt and its
  cancel request never settle. Terminal teardown is shared and idempotent,
  force-destroys the agent after the cancellation grace period, closes the
  queue without draining, and releases prompt callers after process teardown.
- Keep Local Whisper temporary-file cleanup best-effort so an `rm` failure
  cannot replace a successful transcript, the transcription error, or the
  caller's `AbortError`; log only a safe filesystem error code.
- Accept both npm 11 and npm 12 `npm pack --json` output shapes in the publish
  artifact verifier.

### Security

- Redact network credentials and cap transcription diagnostics before logging or
  connector delivery.
- Refresh the test and publish toolchain to patched Vitest, Vite, picomatch,
  postcss, and esbuild releases; pin pnpm 10.34.5 so the esbuild security
  override is enforced consistently in local and release installs.

## 2026.713.2 - 2026-07-13

### Added

- Add readiness checks for the bundled local Speech-to-text runtime and doctor
  coverage for the selected method, setup state, hidden Groq credential state,
  and independent `services.speech` / `services.speechDownloads` routes.

### Changed

- Simplify the connector settings information architecture around status-first
  **Network proxy** and **Speech-to-text** homes. Human traffic labels, separate
  saved/effective proxy routes, explicit transcription method and readiness,
  and grouped advanced local options make the common paths easier to scan.
- Make human doctor output outcome-first, place failures and warnings before a
  compact pass count, and add direct Telegram actions for rerunning diagnostics
  or opening Speech-to-text and Network proxy settings. JSON output retains the
  complete stable report for automation.

### Fixed

- Complete the connector-neutral proxy profile lifecycle with tested create and
  edit flows, direct profile assignment, transactional deletion/reassignment,
  stable category pagination, opaque bounded callbacks, and one preflight per
  route change instead of duplicate connectivity checks.
- Serialize plugin settings across OpenACP processes and commit interactive
  Speech configuration against a fresh locked snapshot. Independent updates are
  preserved, while same-field conflicts stop with an actionable error instead
  of silently overwriting newer values.
- Make settings locks distinguish a reused PID from the original owner, retain
  exact live owners regardless of age, recover bounded incomplete locks, and
  harden metadata and reclamation against symlink substitution.

### Security

- Keep Groq credentials write-only and connector-bound, validate a short-lived
  candidate through `services.speech` before it can replace the saved key, and
  discard rejected, expired, or cancelled candidates without changing the
  active transcription method.

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
