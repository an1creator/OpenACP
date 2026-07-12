## Unreleased

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
