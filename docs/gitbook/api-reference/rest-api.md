# REST API

The OpenACP daemon exposes a local HTTP API used by the CLI and the web dashboard.

**Base URL:** `http://127.0.0.1:21420/api/v1` (configurable via `api.host` and `api.port`)

**Auth:** Two-tier authentication:

1. **Secret token** — from `<instance-root>/api-secret` (full admin access)
2. **JWT access token** — scoped, revokable tokens issued by the auth system

```bash
# Using secret token
TOKEN=$(cat ~/openacp-workspace/.openacp/api-secret)
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/sessions

# Using JWT token
curl -H "Authorization: Bearer $JWT" http://localhost:21420/api/v1/sessions
```

The secret file is created automatically with mode `0600` on first start. Protect it like an SSH private key.

The master secret has full API access. JWT requests are limited by their token
scopes. Connector user allowlists do not apply to either authenticated API
credential; the global concurrent-session limit still applies.

**Exempt from auth:** `GET /api/v1/system/health`.

**Body size limit:** 1 MB.

**API documentation:** Swagger UI is available at `/docs` when the server is running.

---

## Health & System

### GET /api/v1/system/health

Returns public liveness data. No auth required. Session, adapter, process, and
memory details are deliberately omitted.

**Response**
```json
{
  "status": "ok",
  "instanceId": "default",
  "uptime": 123456,
  "version": "2026.718.2"
}
```

`uptime` is milliseconds since daemon start. `instanceId` lets callers verify
that the responding daemon is the intended OpenACP instance.

```bash
curl http://localhost:21420/api/v1/system/health
```

---

### GET /api/v1/system/health/details

Returns authenticated operational diagnostics. Requires `system:health`.

**Response**
```json
{
  "status": "ok",
  "uptime": 123456,
  "version": "2026.718.2",
  "memory": {
    "rss": 52428800,
    "heapUsed": 30000000,
    "heapTotal": 45000000
  },
  "sessions": { "active": 2, "total": 5 },
  "serviceResources": {
    "assistant": { "live": 1, "active": 1 },
    "terminalCleanup": { "pending": 0, "failed": 0 },
    "warmPool": {
      "state": "ready",
      "capacity": 1,
      "agent": "codex",
      "createdAt": "2026-07-18T10:00:00.000Z",
      "expiresAt": "2026-07-18T10:05:00.000Z"
    }
  },
  "adapters": ["telegram"],
  "tunnel": { "enabled": true, "url": "https://abc.trycloudflare.com" }
}
```

`sessions` contains only user sessions. The hidden Assistant session is
reported under `serviceResources.assistant`. `terminalCleanup` reports bounded
ACP/logger teardown still pending or needing a retry. `warmPool.state` is one of
`empty`, `warming`, `ready`, `claiming`, `cleanupPending`, `failed`, or
`closing`. A ready entry enters owned cleanup in the background at `expiresAt`
if no session claims it. Failed cleanup retains the slot and reports bounded
retry attempts plus a redacted `lastError`; it is never reported as empty until
process destruction succeeds.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:21420/api/v1/system/health/details
```

---

### GET /api/v1/system/version

Returns the daemon version string. Requires `system:health`.

**Response**
```json
{ "version": "2026.718.2" }
```

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:21420/api/v1/system/version
```

---

### POST /api/v1/system/restart

Sends a restart signal to the daemon. The daemon exits cleanly and the process manager (or `openacp start`) restarts it.

**Response**
```json
{ "ok": true, "message": "Restarting..." }
```

Returns `501` if restart is not available in the current run mode.

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/system/restart
```

---

### GET /api/v1/system/adapters

Lists registered channel adapters.

**Response**
```json
{
  "adapters": [
    { "name": "telegram", "type": "built-in" }
  ]
}
```

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/system/adapters
```

---

## Sessions

### GET /api/v1/sessions

Lists all sessions (active, finished, cancelled, error). Persisted records and live in-memory sessions are merged by session ID; a live session remains visible even before its first store record is available.

**Response**
```json
{
  "sessions": [
    {
      "id": "sess_abc123",
      "agent": "claude",
      "status": "active",
      "name": "Fix login bug",
      "workspace": "/home/user/myproject",
      "createdAt": "2026-03-25T10:00:00.000Z",
      "bypassPermissions": false,
      "queueDepth": 0,
      "promptRunning": true,
      "lastActiveAt": "2026-03-25T10:05:00.000Z"
    }
  ]
}
```

Session `status` values: `initializing`, `active`, `finished`, `cancelled`, `error`.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/sessions
```

---

### DELETE /api/v1/sessions/:id

Cancels fresh, idle, or running sessions. Cancellation is serialized per session,
so concurrent requests abort and destroy the agent at most once. Repeating the
request for a persisted terminal session is idempotent.

```json
{
  "ok": true,
  "sessionId": "sess_abc123",
  "cancelled": true,
  "previousStatus": "initializing",
  "status": "cancelled",
  "alreadyTerminal": false,
  "cleanupPending": false
}
```

The terminal record is flushed before agent/logger teardown. The request has a
bounded wait: if teardown fails or is still running at the deadline, it still
truthfully returns `status: "cancelled"`, plus `cleanupPending: true` and a safe
warning. Repeating DELETE observes the same in-flight teardown or retries a
completed failure without duplicating prompt cancellation or process destroy.
The cancelled record is never resumed after restart. Unknown IDs return HTTP
404 with `SESSION_NOT_FOUND`.

---

### GET /api/v1/sessions/:id

Returns details for a single session.

**Response**
```json
{
  "session": {
    "id": "sess_abc123",
    "agent": "claude",
    "status": "active",
    "name": "Fix login bug",
    "workspace": "/home/user/myproject",
    "createdAt": "2026-03-25T10:00:00.000Z",
    "bypassPermissions": false,
    "queueDepth": 1,
    "promptRunning": false,
    "threadId": "12345",
    "channelId": "telegram",
    "agentSessionId": "agent-internal-id"
  }
}
```

Returns `404` if not found.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/sessions/sess_abc123
```

---

### POST /api/v1/sessions

Creates a new session.

**Request body** (all fields optional)
```json
{
  "agent": "claude",
  "workspace": "/path/to/project"
}
```

`agent` defaults to `defaultAgent` from config. `workspace` defaults to the instance workspace directory (parent of `.openacp/`).

**Response**
```json
{
  "sessionId": "sess_abc123",
  "agent": "claude",
  "status": "initializing",
  "workspace": "/home/user/openacp-workspace"
}
```

Returns `429` if `maxConcurrentSessions` is reached.

Permissions are auto-approved for sessions created via the API when no channel adapter is attached.

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"agent":"claude","workspace":"/path/to/project"}' \
  http://localhost:21420/api/v1/sessions
```

---

### POST /api/v1/sessions/:id/prompt

Admits a prompt to a session after the complete `message:incoming` and
`agent:beforePrompt` middleware chain. HTTP 202 means the prompt was accepted
into the serial queue; agent processing and connector delivery remain
asynchronous.

**Request body**
```json
{
  "prompt": "Refactor the authentication module",
  "turnId": "client-turn-42"
}
```

**Response**
```json
{
  "ok": true,
  "accepted": true,
  "status": "accepted",
  "sessionId": "sess_abc123",
  "queueDepth": 1,
  "turnId": "client-turn-42"
}
```

The response preserves a supplied `turnId`; otherwise OpenACP creates one.
Blocked work is never queued or dispatched. Policy rejection returns a standard
error envelope with `MESSAGE_BLOCKED` and HTTP 403. The global concurrent-session
limit returns `SESSION_LIMIT` and HTTP 429. A `cancelled`, `finished`, or `error`
session returns 400; an unknown session returns 404.

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Fix the login bug"}' \
  http://localhost:21420/api/v1/sessions/sess_abc123/prompt
```

---

### PATCH /api/v1/sessions/:id/dangerous

Enables or disables bypass permissions for a session.

**Request body**
```json
{ "enabled": true }
```

**Response**
```json
{ "ok": true, "bypassPermissions": true }
```

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled":true}' \
  http://localhost:21420/api/v1/sessions/sess_abc123/dangerous
```

---

### POST /api/v1/sessions/:id/permission

Resolves a pending permission request for a session.

**Request body**
```json
{ "permissionId": "perm_xyz", "optionId": "allow" }
```

**Response**
```json
{ "ok": true }
```

Returns `400` if there is no matching pending request.

---

### POST /api/v1/sessions/:id/archive

Archives a session.

**Response**
```json
{ "ok": true }
```

---

### POST /api/v1/sessions/adopt

Adopts an existing external agent session and surfaces it as a messaging thread.

**Request body**
```json
{
  "agent": "claude",
  "agentSessionId": "external-session-id",
  "cwd": "/path/to/project",
  "channel": "telegram"
}
```

`agent` and `agentSessionId` are required. `cwd` defaults to the daemon's working directory. `channel` defaults to the first registered adapter.

**Response**
```json
{ "ok": true, "sessionId": "sess_abc123", "threadId": "12345", "status": "new" }
```

`status` is `"existing"` if the session was already active (topic is pinged instead of created). Returns `429` on session limit, `400` for unsupported agent.

---

## Agents

### GET /api/v1/agents

Lists agents configured in the daemon.

**Response**
```json
{
  "agents": [
    {
      "name": "claude",
      "command": "claude-agent-acp",
      "args": [],
      "env": { "HTTP_PROXY": "***" },
      "capabilities": { "integration": "claude" }
    }
  ],
  "default": "claude"
}
```

Agent environment variable names remain visible for diagnostics, but every value is redacted to `"***"`. The same rule applies to `GET /api/v1/agents/:name` and `POST /api/v1/agents/reload`.

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/agents
```

---

## Configuration

### GET /api/v1/config

Returns the full runtime config. Sensitive fields (`botToken`, `token`, `apiKey`, `secret`, `password`, `webhookSecret`) are redacted to `"***"`.

**Response**
```json
{ "config": { "defaultAgent": "claude", "channels": { ... }, ... } }
```

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/config
```

---

### PATCH /api/v1/config

Updates a single config value by dot-notation path. Only fields marked as `safe` in the config registry can be modified via the API.

**Request body**
```json
{ "path": "security.maxConcurrentSessions", "value": 10 }
```

`value` can be any JSON type. String values that parse as JSON are used as-is.

**Response**
```json
{
  "ok": true,
  "needsRestart": false,
  "config": { ... }
}
```

`needsRestart: true` means the change requires a daemon restart to take effect. Returns `403` for fields not in the safe-fields scope.

```bash
curl -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"path":"security.maxConcurrentSessions","value":10}' \
  http://localhost:21420/api/v1/config
```

---

### GET /api/v1/config/editable

Returns metadata about editable config fields (used by the web dashboard). Includes `path`, `displayName`, `group`, `type`, `options`, `value`, and `hotReload`.

---

## Topics

Topics represent channel adapter threads (Telegram forum topics, Discord threads, etc.).

### GET /api/v1/topics

Lists all topics. Optionally filter by status.

**Query params**

| Param | Description |
|---|---|
| `status` | Comma-separated status filter, e.g. `active,finished` |

**Response**
```json
{
  "topics": [
    {
      "sessionId": "sess_abc123",
      "topicId": 42,
      "name": "Fix login bug",
      "status": "active",
      "agentName": "claude",
      "lastActiveAt": "2026-03-25T10:05:00.000Z"
    }
  ]
}
```

Returns `501` if topic management is not available (no adapter with topic support).

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:21420/api/v1/topics?status=active,finished"
```

---

### DELETE /api/v1/topics/:sessionId

Deletes the topic for a session. Returns `409` if the session is active and `--force` is not set. Returns `403` for system topics.

**Query params**

| Param | Description |
|---|---|
| `force` | Set to `true` to delete even if the session is active |

**Response**
```json
{ "ok": true, "topicId": 42 }
```

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "http://localhost:21420/api/v1/topics/sess_abc123?force=true"
```

---

### POST /api/v1/topics/cleanup

Deletes all topics matching the given statuses. Returns counts of deleted and failed topics.

**Request body** (optional)
```json
{ "statuses": ["finished", "error"] }
```

**Response**
```json
{ "deleted": ["sess_abc123", "sess_def456"], "failed": [] }
```

---

## Tunnel

### GET /api/v1/tunnel

Returns tunnel status for the primary tunnel service.

**Response** (when enabled)
```json
{ "enabled": true, "url": "https://abc.trycloudflare.com", "provider": "cloudflare" }
```

**Response** (when disabled)
```json
{ "enabled": false }
```

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:21420/api/v1/tunnel
```

---

### GET /api/v1/tunnel/list

Lists all active user tunnels.

**Response**
```json
[
  { "port": 3000, "label": "dev server", "status": "active", "publicUrl": "https://xyz.trycloudflare.com" }
]
```

---

### POST /api/v1/tunnel

Creates a new tunnel to a local port.

**Request body**
```json
{ "port": 3000, "label": "dev server", "sessionId": "sess_abc123" }
```

`port` is required. `label` and `sessionId` are optional.

**Response**
```json
{ "port": 3000, "publicUrl": "https://xyz.trycloudflare.com", "label": "dev server", "status": "active" }
```

Returns `400` if the tunnel service is not enabled.

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"port":3000,"label":"dev server"}' \
  http://localhost:21420/api/v1/tunnel
```

---

### DELETE /api/v1/tunnel/:port

Stops the tunnel for a specific local port.

**Response**
```json
{ "ok": true }
```

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:21420/api/v1/tunnel/3000
```

---

### DELETE /api/v1/tunnel

Stops all user tunnels.

**Response**
```json
{ "ok": true, "stopped": 3 }
```

---

## Notifications

### POST /api/v1/notify

Sends a notification message to all registered channel adapters (e.g. to the Notifications topic in Telegram).

**Request body**
```json
{ "message": "Deployment complete" }
```

**Response**
```json
{ "ok": true }
```

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"Deployment complete"}' \
  http://localhost:21420/api/v1/notify
```

---

## Session Config

### GET /api/v1/sessions/:id/config

Returns the agent-declared config options for a session (modes, models, toggles).

**Response**
```json
{
  "configOptions": [
    {
      "id": "mode",
      "name": "Mode",
      "type": "select",
      "category": "general",
      "currentValue": "code",
      "options": [
        { "value": "code", "label": "Code" },
        { "value": "architect", "label": "Architect" }
      ]
    }
  ]
}
```

---

### PUT /api/v1/sessions/:id/config/:configId

Updates a config option value for a session.

**Request body**
```json
{ "value": "architect" }
```

**Response**
```json
{ "ok": true, "configId": "mode", "value": "architect" }
```

---

## Authentication

### POST /api/v1/auth/tokens

Creates a new JWT access token. Requires secret token authentication.

**Request body**
```json
{ "name": "my-app", "role": "operator" }
```

**Response**
```json
{
  "token": "eyJhbG...",
  "id": "tok_abc123",
  "name": "my-app",
  "role": "operator",
  "expiresAt": "2026-04-08T10:00:00.000Z"
}
```

---

### GET /api/v1/auth/tokens

Lists all active tokens (secret token auth required).

**Response**
```json
{
  "tokens": [
    {
      "id": "tok_abc123",
      "name": "my-app",
      "role": "operator",
      "createdAt": "2026-04-01T10:00:00.000Z",
      "lastUsedAt": "2026-04-01T12:00:00.000Z"
    }
  ]
}
```

---

### DELETE /api/v1/auth/tokens/:id

Revokes a token by ID. Requires secret token authentication.

**Response**
```json
{ "ok": true }
```

---

### GET /api/v1/auth/me

Returns information about the current token (works with both secret and JWT).

**Response**
```json
{
  "type": "jwt",
  "role": "operator",
  "scopes": ["sessions:read", "sessions:write", "agents:read"],
  "tokenId": "tok_abc123"
}
```

---

### POST /api/v1/auth/codes

Generates a one-time access code (for app connectivity). Requires secret token auth.

**Response**
```json
{
  "code": "abc123def456",
  "expiresAt": "2026-04-01T10:30:00.000Z"
}
```

The code is valid for 30 minutes and can be used exactly once.

---

### POST /api/v1/auth/exchange

Exchanges a one-time code for a JWT token. No prior authentication required.

**Request body**
```json
{ "code": "abc123def456" }
```

**Response**
```json
{
  "token": "eyJhbG...",
  "role": "operator",
  "expiresAt": "2026-04-08T10:00:00.000Z"
}
```

Returns `401` if the code is expired or already used.

---

## Proxy routing

All proxy endpoints require authentication. Reads and tests require
`config:read`; mutations require `network:proxy:manage` (admin-only in built-in
roles). Responses
never include credential values.

### `GET /api/v1/proxy`

Returns profiles with `hasCredentials`, routing rules, registered scopes, and
redacted capability diagnostics. The `revision` field is the current optimistic
concurrency token.

### `POST /api/v1/proxy/profiles`

Creates a profile. `username` and `password` are write-only.
An existing ID returns HTTP 409 with `PROXY_PROFILE_EXISTS`; use `PUT` for
updates.

```json
{
  "id": "usa",
  "protocol": "http",
  "host": "proxy.example",
  "port": 8080,
  "username": "write-only",
  "password": "write-only",
  "noProxy": ["localhost", "127.0.0.1", "::1"],
  "failClosed": true,
  "expectedRevision": 12
}
```

Instead of the component fields, clients may send a write-only URL:

```json
{
  "id": "usa",
  "name": "US proxy",
  "proxyUrl": "socks5h://user:password@proxy.example:1080"
}
```

`proxyUrl` is mutually exclusive with `protocol`, `host`, `port`, `username`,
`password`, and `clearCredentials`. It must use `http`, `https`, `socks5`, or
`socks5h`, include an explicit port, and contain no path, query, or fragment.
The URL is parsed into the separate profile and secret stores and is never
persisted or returned. On update, a URL without userinfo clears old credentials.
Profile names are trimmed and must contain 1-100 non-whitespace characters;
violations return `PROXY_VALIDATION_ERROR`.

### `PUT /api/v1/proxy/profiles/:id`

Updates an existing profile. The body is the same as create without `id`.
Use `clearCredentials: true` to explicitly remove stored credentials. Missing
profiles return HTTP 404 with `PROXY_PROFILE_NOT_FOUND`.

### `POST /api/v1/proxy/profiles/test-candidate`

Tests a complete unsaved profile body entirely in memory. The candidate and its
credentials are not persisted or returned. An optional approved `targetUrl`
uses the same SSRF restrictions as `/test`.

### `POST /api/v1/proxy/profiles/import-env`

Imports a mode-0600 env file visible to the daemon:

```json
{ "id": "usa", "envFile": "/protected/path/proxy.env", "name": "USA", "expectedRevision": 12 }
```

### `PUT /api/v1/proxy/routes/:scope`

```json
{ "route": "profile:usa", "expectedRevision": 12 }
```

Use `direct` or `inherit` instead of a profile as needed. Delete the endpoint to
remove an exact/category override. Telegram-affecting changes are tested before
they are persisted. Rejection returns HTTP 400 with code
`PROXY_ROUTE_TEST_FAILED` and confirms that the old route remains active.
An `expectedRevision` mismatch returns HTTP 409 with
`PROXY_REVISION_CONFLICT`; read status again before retrying. Profile/route
validation errors are HTTP 400 and a corrupt fail-closed policy store is HTTP
503.

### `DELETE /api/v1/proxy/profiles/:id`

Deletes an unused profile. If routes reference it, provide a single replacement
route in the query, for example
`?reassign=profile%3Anext&expectedRevision=12`. Route testing, reassignment,
secret deletion, and profile deletion are one CAS transaction; the response
lists `reassignedScopes`.

### `POST /api/v1/proxy/test`

Test exactly one scope or profile:

```json
{ "scope": "channels.telegram" }
```

```json
{ "profile": "usa", "targetUrl": "https://api.ipify.org?format=json" }
```

The response contains only `ok`, optional HTTP status/error, and the redacted
scope/profile identifier. The default target is fixed and needs only
`config:read`. Supplying `targetUrl` requires `network:proxy:manage`; it must be
HTTPS without credentials, use an approved diagnostic host (`api.ipify.org`,
`ifconfig.me`, or `httpbin.org`), and must not resolve to private, loopback,
link-local, CGNAT, reserved, or metadata space.

## Server-Sent Events

### GET /api/v1/events

SSE stream of real-time daemon events. Auth via query parameter (EventSource cannot set headers).

```
GET /api/v1/events?token=<api-secret>
```

Returns a persistent SSE connection. Events include session lifecycle changes, agent output, and health pings (every 30 seconds).

### GET /api/v1/sse/sessions/:id/stream

Per-session SSE stream. Requires JWT authentication via query parameter.

```
GET /api/v1/sse/sessions/:id/stream?token=<jwt>
```

Streams only events for the specified session. Supports reconnect replay — if fewer than 100 events were missed, they are replayed on reconnection. Multiple clients can connect to the same session stream simultaneously.

**Event types**: `agent:event`, `session:updated`, `permission:request`, `health`.
