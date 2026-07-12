## Unreleased

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
