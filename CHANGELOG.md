## Unreleased

### Changed

- Agent warm-pool: server keeps one pre-initialized AgentInstance ready in the background for the default agent, so first `POST /sessions` calls pay only for the `newSession` RPC (~300ms) instead of a full subprocess spawn (~2–3s). Refills after consumption; 5-min idle TTL; liveness-checked before claim.
