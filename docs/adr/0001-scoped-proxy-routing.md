# 0001 Scoped Proxy Routing

Status: accepted
Date: 2026-07-12

## Context

Daemon-wide proxy environment variables route unrelated OpenACP traffic and are
inherited unpredictably by ACP processes. The product needs independent control
over channel, agent, service, and plugin flows without affecting other host
applications or leaking proxy credentials through configuration APIs.

## Decision

Use one core `ProxyService` with separate profiles and routes. Route resolution
is exact scope, category default, then global default; each result is `direct`,
`inherit`, or `profile:<id>`. Internal consumers request a scoped transport and
ACP children receive a scoped environment at spawn. The service never mutates
global fetch state or `process.env`.

Store public profile/routing metadata in instance `proxy.json` and credentials
in mode-0600 `proxy-secrets.json`. Channel-affecting route/profile changes must
pass their registered connectivity test before persistence. Active ACP sessions
are not killed on route changes; the idle warm process is invalidated.
Cached transports are dependency-tracked by resolved scope/profile. Replacement
retires only affected entries, and destruction waits for leased response bodies
to finish or cancel. Public scoped fetches return native Fetch/Web Stream
responses regardless of the internal Node HTTP implementation.

## Consequences

HTTP, HTTPS, SOCKS5, and SOCKS5H work for internal HTTP transports. HTTP/HTTPS
ACP routing is broadly compatible through standard environment variables.
SOCKS for arbitrary ACP clients remains capability-dependent and is reported as
best effort. New network integrations must declare and consume a scope instead
of reading a daemon-global proxy setting.
