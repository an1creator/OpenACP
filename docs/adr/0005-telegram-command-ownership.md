# 0005 Telegram Command Ownership and Localized Reconciliation

Status: accepted
Date: 2026-07-12

## Context

Telegram command menus are server-side state split by language and audience
scope. Replacing a whole list from one OpenACP instance can erase commands
managed by another instance or operator. Updating only the neutral default also
leaves localized or administrator-specific lists stale, which can hide newly
registered commands such as `/proxy`. Plugin commands can appear and disappear
at runtime, and adapter stop must not allow a delayed retry to write old state.

## Decision

Reconcile the effective default and configured-chat command scopes for the
neutral, English, and Russian locales. Preserve every command that is not owned
by OpenACP. During a clean first migration, remove only an explicit set of
historical built-ins; after that, add and remove names according to a durable
ownership ledger.

Store the ledger below the global OpenACP root as a mode-0600 atomic file. Key
records by the bot's public numeric ID, hashed chat alias, Telegram scope, and
locale, never by token or plaintext chat configuration. Serialize writers with
a process-aware lock and recover from corruption conservatively, treating
unknown remote commands as unmanaged.

One OpenACP instance owns command synchronization for each public bot ID. The
ledger records the instance ID, hashed instance root, hashed host identity, PID,
heartbeat, and clean-stop time. A different instance fails before any Bot API
read or write. Clean restart by the same instance reclaims its stopped record.
A different same-host instance may take over only when the old PID is provably
stopped and the operator explicitly starts once with
`OPENACP_TELEGRAM_COMMAND_TAKEOVER=1`. Cross-host ownership is never stolen.

Validate all commands before ownership or network work. Core commands have
priority and must satisfy the Bot API name and description grammar. Plugin names
must match `[a-z0-9_]{1,32}` and trimmed descriptions must contain 1-256
characters. Invalid entries are skipped with aggregate warnings. Valid plugins
are sorted deterministically and appended only until the 100-command limit, so
required core commands including `/proxy` are never dropped.

Coalesce registry changes to the latest snapshot, serialize Bot API writes,
cancel in-flight reads/retries when the adapter stops, and apply the same
Telegram scope precedence in reconciliation and doctor diagnostics. A Bot API
failure remains non-fatal to daemon startup.

## Consequences

Localized and administrator command menus discover current core and plugin
commands without deleting unrelated operator state. Plugin removal can clean up
only commands that OpenACP previously recorded as owned. Each OpenACP instance
must normally use a unique Telegram bot; sharing one bot for long polling is not
safe. Multi-instance and restart behavior gains a small global state file,
heartbeat, and lock protocol; if that
state is corrupt or unavailable, cleanup intentionally becomes conservative and
may leave a stale owned command until ownership is re-established.
