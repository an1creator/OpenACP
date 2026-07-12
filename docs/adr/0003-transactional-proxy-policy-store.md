# 0003 Transactional Proxy Policy Store

Status: accepted
Date: 2026-07-12

## Context

Proxy metadata and credentials are separate files, yet they form one security
policy. Independent writes can leave a profile without matching credentials or
a route referencing missing state. Silently treating parse errors as an empty
configuration would bypass an operator's intended egress restrictions. Multiple
REST/connector writers can also overwrite one another.

## Decision

Version the store and commit metadata plus secrets through one mode-0600 journal,
atomic file renames, and a retained last-known-good transaction. Recover a
complete journal at startup. Preserve and quarantine invalid files, then fail
closed for all network consumers and surface the condition through doctor/API.
Serialize in-process mutations and acquire an O_EXCL filesystem lock with stale
owner recovery before journal recovery/commit. Increment a revision on every commit; REST
administrative writes may supply `expectedRevision` for compare-and-swap.
Persist dynamically registered scopes independently of routes.

## Consequences

A crash can be recovered without combining mismatched public/secret state, and
corruption cannot silently switch traffic to host defaults. Operators must make
an explicit recovery decision using the quarantine and last-known-good data.
Clients that receive HTTP 409 must refresh status and reapply their decision.
Store v1 remains readable and migrates to the revisioned schema without losing
routes.
Strict validation covers canonical hosts, profile and scope identifiers, unique
profiles, route references, ports, modes, booleans, and `noProxy`/secret types;
unsafe legacy userinfo is quarantined rather than migrated.
