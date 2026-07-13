# 0007 Crash-Consistent Plugin Installation and Migration

Status: accepted
Date: 2026-07-13

## Context

Community plugin installation changes three independent durable resources: the
shared npm package tree, plugin-owned data and settings, and `plugins.json`.
Process termination, disk exhaustion, or concurrent installers can otherwise
leave a package version paired with the wrong settings or registry entry.
Plugin migrations have the same compatibility risk when settings and the
registry version cannot both be committed or rolled back.

## Decision

Serialize community package changes with a mode-0600, process-owned lock below
the instance root. Before an install hook runs, write a mode-0600 atomic journal
containing exact package boundaries, the previous registry bytes and mode, and
a verified plugin-data snapshot. A snapshot becomes usable only after its tree
digest, completion marker, file fsyncs, directory fsyncs, and same-filesystem
rename have completed. Incomplete snapshots never authorize deletion of live
plugin data.

Persist a journal phase before every package backup, activation, and registry
commit boundary. Recovery before the registry commit restores the exact old
package, data, and registry state. Recovery at or after `registry-committed`
keeps the new state and finishes cleanup. Startup performs this recovery before
loading community plugins; recovery failure quarantines community plugins but
does not prevent built-in plugins from starting. Cleanup is restricted to paths
whose transaction ID and fixed parent prove journal ownership.

Validate the journal as a bounded, exact versioned schema. Derive package,
snapshot, data, and registry paths again from the validated transaction ID and
package name rather than accepting persisted paths as authority. Preflight each
live, staged, and backup rename boundary for type, real path, symbolic links,
and filesystem device before the first live rename. Track each package boundary
as untouched, completely backed up, or newly activated; rollback never removes
an untouched live boundary.

The journal state machine uses these invariants (`i` is the current package
boundary in the fixed activation order):

| Durable phase | Package item states | Data state |
|---|---|---|
| `initialized`, `staged`, `snapshot-pending` | every item `untouched` | no snapshot result and hook not started |
| `hook-pending` | every item `untouched` | complete snapshot result; hook not started |
| `hook-running`, `hook-complete` | every item `untouched` | complete snapshot result and durable `hookStarted` |
| `backup:i` | earlier items `new-activated`; `i` untouched or completely backed up; later items `untouched` | hook started |
| `activate:i` | earlier items `new-activated`; `i` has its required backup or is `new-activated`; later items `untouched` | hook started |
| `packages-activated`, `registry-committing`, `registry-committed`, `committed` | every item `new-activated` | hook started |

Any parseable journal that violates the phase, item-prefix, snapshot, or
`hookStarted` relationship is quarantined without filesystem mutation.
There is deliberately no durable `rolled-back` phase. Pre-commit recovery keeps
the original package digests, backups, snapshot digest and modes, and exact
registry bytes until restored live state has been fsynced and verified. Recovery
then removes owned artifacts and deletes the journal last. A crash at any restore
or cleanup boundary repeats the same evidence-based recovery; missing evidence
is accepted only when live state already matches every recorded digest and mode.

`registry-committed` is valid only with bounded commit evidence containing the
exact intended registry bytes, their SHA-256 digest, and file mode. The intended
bytes are serialized from the replayed in-memory registry before save. After the
atomic registry save, OpenACP reads the file back and verifies exact bytes and
mode, then atomically persists the evidence and `registry-committed` phase in one
journal replacement. Recovery treats `registry-committing` as pre-commit even if
the new registry file exists, while `registry-committed` and `committed` require
both valid evidence and an exact match with the persisted registry before any
backup or snapshot cleanup.

All plugin-registry saves enter the same cross-process mutation lock, reload the
latest registry, and replay the writer's pending operations before atomic save.
Runtime code may import an already-installed package, but may not run npm against
the shared package tree. A missing package must be installed through
`openacp plugin install <package>` and activated after restart.

For version migration, snapshot the complete registry entry, including enabled
state, source, paths, description, and timestamps. Restore that entry and the
old settings if migration or registry persistence fails. A mode-0600 durable
migration guard is created before migration and remains when rollback cannot be
fully persisted, so a later startup cannot enable new code against old settings.
Plugin settings use mode-0700 directories starting at the settings base itself
and mode-0600 atomic files; permission repair failures fail closed.

## Consequences

Install and migration operations are restart-safe and mutually exclusive, and
the registry commit is the single activation decision boundary. Installation
requires staging, rollback, snapshot, journal, and live package paths to support
the required atomic renames. Corrupt ownership metadata is handled
conservatively and may require operator repair rather than deleting unknown
paths. Failed migration rollback leaves an explicit quarantine marker that must
be resolved before the plugin can run again. Registry-only removal retains the
shared npm tree until a future coordinated package-tree maintenance transaction;
the CLI reports this and requires restart instead of racing loaded module code.
