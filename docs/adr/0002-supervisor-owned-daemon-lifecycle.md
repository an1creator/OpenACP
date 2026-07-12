# 0002 Supervisor-Owned Daemon Lifecycle

Status: accepted
Date: 2026-07-12

## Context

Installing a systemd/launchd entry while also spawning a detached daemon creates
two competing ownership models. Restart could leave the unit inactive with a
PPID-1 process, stop could accidentally uninstall the enabled service, and a
package update could restart through a stale path.

## Decision

When a per-instance supervisor entry is installed, start, stop, and restart are
delegated to that supervisor. Stop preserves registration. Restart refreshes the
unit and invokes the manager; it never spawns a detached competitor. A daemon
running under systemd exits with the restart failure code after `/update` so
`Restart=on-failure` starts the updated package. PID-based detached lifecycle is
only the unsupported-supervisor fallback.

## Consequences

Supervisor state is authoritative and multi-instance unit names remain stable.
Removing registration requires the explicit `autostart uninstall` command.
Operators migrating legacy wrappers must remove proxy injection from both unit
drop-ins and `ExecStart` wrappers before native scoped routing becomes fully
authoritative.

Supervisor registration updates are transactional. systemd restores the prior
unit on reload/enable failure. launchd validates a temporary plist, records the
old job state, and restores/re-bootstraps the old plist if validation, bootout,
or bootstrap fails; detached fallback is forbidden after a partial install.
