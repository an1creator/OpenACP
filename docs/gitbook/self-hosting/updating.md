# Updating

## Check Your Current Version

```bash
openacp --version
```

This prints the version from the installed package (e.g., `2026.401.1`). The version is read from `package.json` bundled with the binary.

OpenACP also checks for updates automatically at startup. If a newer version is available on npm, you are prompted:

```
Update available: 2026.327.1 → 2026.401.1
? Update now before starting?
```

Selecting yes runs `npm install -g @n1creator/openacp-cli@latest` in-process and exits, asking you to re-run your command with the new version. Set `OPENACP_SKIP_UPDATE_CHECK=true` to suppress this prompt.

## Update

```bash
openacp update
```

The CLI update command checks and installs `@n1creator/openacp-cli`. When the
daemon is managed by systemd, OpenACP exits with its restart status and lets
systemd invoke the configured `ExecStart` wrapper again. This ensures wrapper
environment variables and the newly installed package path are used and avoids
creating a competing detached daemon. Retained ACP subprocesses from failed
initialization share one four-second cleanup budget during shutdown; an
unconfirmed child is force-signalled and detached so it cannot serialize or
indefinitely block the supervised restart.

Manual `openacp restart` follows the same ownership rule. Verify after update:

```bash
systemctl --user is-active <openacp-unit>
systemctl --user is-enabled <openacp-unit>
systemctl --user show <openacp-unit> -p MainPID
```

You can also update directly:

```bash
npm install -g @n1creator/openacp-cli@latest
openacp restart
```

Or to pin to a specific version:

```bash
npm install -g @n1creator/openacp-cli@2026.401.1
```

## Migrating from the upstream package

The N1 Creator distribution uses a different npm package name but preserves the
same `openacp` executable and workspace format:

```bash
npm uninstall -g @openacp/cli
npm install -g @n1creator/openacp-cli@latest
openacp --dir ~/openacp-workspace restart
openacp --dir ~/openacp-workspace status
```

If `openacp` is a wrapper, verify that it ultimately executes the global binary
from the npm prefix you updated. For native scoped proxy routing, remove legacy
proxy sourcing from both the wrapper and OpenACP-specific systemd drop-ins only
after profile/routes pass acceptance. Keep unrelated host application proxy
configuration untouched.

If you are running from source, pull and rebuild:

```bash
git pull
pnpm install
pnpm build
```

## Backward Compatibility Guarantee

OpenACP guarantees that existing config files, session data, and stored state continue to work after any minor or patch upgrade without manual intervention.

Specific commitments:

- **Config schema**: New fields always have `.default()` or `.optional()` in the Zod schema. An older config file will never fail validation after an upgrade.
- **CLI commands and flags**: Existing commands and flags are never removed or renamed in a minor/patch release. Deprecated commands are kept operational with a warning until the next major version.
- **Plugin API**: Plugin-facing interfaces maintain backward compatibility within a major version.
- **Data files**: All instance files (sessions, topics, state) are handled defensively — unknown fields are preserved and old formats are migrated automatically.
- **Instance migration**: If an existing global instance is detected at `~/.openacp/` on first run after upgrade, it is automatically migrated to `~/openacp-workspace/.openacp/`. No manual action required.

## Automatic Config Migrations

When OpenACP starts, it runs all pending config migrations before validation. Migrations are applied to the raw JSON in memory and written back to disk if any change was made. You do not need to edit the file manually after an upgrade.

Current migrations (run in order):

1. **`add-tunnel-section`** — Adds the `tunnel` block with Cloudflare defaults if the key is absent.
2. **`fix-agent-commands`** — Renames legacy agent command values to their current names.
3. **`migrate-agents-to-store`** — Moves agent definitions from `config.json` into the separate `<instance-root>/agents.json` store introduced in a later release.

In addition, a one-time **global instance migration** runs at CLI startup. If a legacy `~/.openacp/config.json` is detected, it is automatically moved to `~/openacp-workspace/.openacp/` and registered in the instance registry.

Migrations are idempotent: running them multiple times has no effect.

Installed npx and uvx agent definitions are reconciled with the current ACP
Registry only within the same runner distribution. Their stored command uses the
exact reviewed package version, and registry environment defaults remain below
user-provided environment overrides. Binary updates and changes between
distribution types are reported as available updates but keep the installed
version and command until an explicit agent installation completes and verifies
the replacement runtime.

## Post-Upgrade Checks

After upgrading, start OpenACP normally:

```bash
openacp start
```

Refresh agent metadata and verify external CLIs after a release that updates the
ACP SDK or registry:

```bash
openacp agents refresh
openacp doctor
```

If there are any issues with the config (e.g., a field that could not be migrated), the process prints the validation errors and exits with a non-zero code. Review the output and correct the config file at `<instance-root>/config.json`.

For plugin adapters installed under `<instance-root>/plugins/`, re-install them after a major upgrade to ensure API compatibility:

```bash
openacp install @openacp/adapter-discord
```

## Maintainer release recovery

The release workflow verifies Node 22 and 24, checks that the versioned tag is
reachable from `main`, and requires the tag, both package manifests, and the
CHANGELOG release heading to match. It packs both npm artifacts before making a
registry change. With npm trusted-publishing OIDC it publishes the CLI and then
the peer-dependent SDK directly to `latest`; OIDC supports `npm publish`, but
not later `npm dist-tag` promotion.

If SDK publication fails after CLI succeeds, do not publish a new CLI version.
Fix registry/authentication state and rerun the same tagged workflow; it skips
an existing exact version only when that version is current `latest`, then
publishes the missing SDK. This is not cross-package atomic—CLI `latest` can
briefly lead, which is compatible because the CLI does not depend on the SDK.
An exact version that is not current `latest` stops the workflow and requires an
account owner's interactive npm 2FA recovery because OIDC cannot mutate
dist-tags.
