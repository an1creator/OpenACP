# 0004 Connector Secure Input Boundary

Status: accepted
Date: 2026-07-12

## Context

Connector-neutral administrative wizards need follow-up text fields, including
write-only proxy credentials. A normal chat message can remain in history,
appear in notifications, be consumed by another pending flow, or reach command
tracing before deletion. Trusting a menu's original authorization also lets a
later callback or message outlive the principal or conversation that created it.
Different adapters offer different input guarantees; Telegram in the configured
forum group cannot assume a private direct-message channel.

## Decision

Represent follow-up input as a connector-neutral `CommandResponse` of type
`input`, with a command continuation, TTL, sensitivity flag, and protected
fallback. Adapters declare whether they support text input and whether sensitive
input is private, delete-before-capture, or unsupported.

Bind every pending input and in-memory wizard draft to connector, authenticated
user, and conversation/topic. Give drafts random identifiers, a ten-minute TTL,
a bounded in-memory store, and the proxy policy revision used for compare-and-
swap. Reauthorize every initial command, callback, and captured value.

For Telegram, require the next value to reply to the exact ForceReply prompt.
For sensitive fields, delete that reply successfully before dispatching its
value to the command registry through the out-of-band captured-input field. The
secret is never concatenated into the command string. If deletion fails,
discard the value. Never put credentials in callback data, persistent draft
state, previews, status, or diagnostics. An adapter without an adequate
guarantee renders the protected CLI/API fallback instead of accepting the value.

## Consequences

Telegram can provide an in-group credential wizard without retaining the secret
when bot deletion permissions work. A failed deletion is safe but requires the
operator to retry through a mode-0600 CLI/API file. New connectors must opt into
input guarantees explicitly; merely rendering menus is insufficient for secret
fields. Wizard state is intentionally lost on daemon restart or TTL expiry, and
stale saves fail with the existing proxy revision conflict rather than
overwriting a newer policy.
