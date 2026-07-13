# 0006 Offline-First Plugin Catalog

Status: accepted
Date: 2026-07-13

## Context

The CLI, setup wizard, and marketplace API depended on a hard-coded GitHub raw
URL whose repository does not exist. That made ordinary search and alias
resolution network-dependent and left install promises outside the maintained
release artifact. The existing `registry-snapshot.json` is an ACP agent catalog
and cannot also represent installable OpenACP plugins.

## Decision

Ship a separate, schema-validated `plugin-catalog.json` in every CLI package and
treat it as the authoritative offline catalog for that release. Entries are
included only when the maintained package can promise them; an empty catalog is
valid and direct npm package installation remains available.

Catalog lookup never performs a network request. A missing or invalid packaged
catalog is a fatal catalog error rather than a silent network fallback.

The plugin catalog and ACP agent registry remain separate data models and build
artifacts.

## Consequences

Plugin discovery, setup, and marketplace listing work deterministically without
network access, and release verification can prove which catalog shipped.
Maintainers must update and review catalog entries as part of a release. Users
can still install a full npm package name directly, without that package gaining
a maintained-catalog endorsement.
