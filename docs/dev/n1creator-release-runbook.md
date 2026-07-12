# N1 Creator npm release runbook

The maintained fork publishes two public packages from
`https://github.com/an1creator/OpenACP`:

- `@n1creator/openacp-cli`
- `@n1creator/openacp-plugin-sdk`

## Pre-release verification

Run from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm build:publish
npm pack --dry-run ./dist-publish
npm pack --dry-run ./dist-publish-sdk
```

The root and SDK versions must match the release tag. Version format is
`YYYY.MMDD.patch`. `CHANGELOG.md` must contain a heading beginning with the
exact version (for example, `## 2026.712.12 - 2026-07-12`). The tag commit must be
reachable from `origin/main`.

## First publication

A brand-new scoped package must be published once by the npm account owner with
2FA, or with a granular token that is explicitly allowed to bypass 2FA:

```bash
npm publish ./dist-publish --access public
npm publish ./dist-publish-sdk --access public
```

Never store an npm password, OTP, or long-lived write token in the repository.

## Trusted publishing

After the first publication, configure a GitHub Actions trusted publisher on
both npm package settings pages:

- GitHub owner: `an1creator`
- Repository: `OpenACP`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

The workflow uses a GitHub-hosted runner, `id-token: write`, Node 24, and npm
11.16 or newer. It does not use `NPM_TOKEN`. Trusted publishing generates npm
provenance for the release.

## Release

Push the verified commit to `main`, then create and push the matching tag:

```bash
VERSION=2026.712.12
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

Confirm both packages have the expected version and provenance, then test a
clean global install before updating a production daemon.

The workflow uses npm trusted publishing (OIDC) and only invokes operations that
npm officially supports with OIDC: `npm publish`. After both packs verify, it
publishes dependency-first to `latest`: CLI, then the plugin SDK that declares
the CLI as its peer dependency. `npm dist-tag` and
staged approval are deliberately absent because they require interactive
authentication/2FA. See [npm trusted publishing limitations](https://docs.npmjs.com/trusted-publishers/#limitations-and-future-improvements).

### Resume a partial registry release

If the CLI was published and the SDK failed, leave the immutable CLI version in
place. Correct the npm trusted-publisher or registry issue and rerun the same Git
tag: an existing exact version is skipped only when it is already the package's
current `latest`, then the missing SDK is published.
Cross-package atomic publication is not available through npm's OIDC-only
contract, so during this failure window CLI `latest` may be newer than SDK
`latest`; that state is compatible because the CLI does not depend on the SDK.

If an exact version exists but is not current `latest`, the workflow fails
instead of silently skipping it. npm versions are immutable and trusted
publishing does not authorize `npm dist-tag`, so the account owner must inspect
the package and repair `latest` interactively with 2FA: use the npmjs.com package
settings or run `npm dist-tag add <package>@<version> latest` from an
authenticated local terminal. Verify the resulting `dist-tags.latest`, then
rerun the same tag. Never add a write token to Actions as a workaround.

## Host rollout

```bash
npm uninstall -g @openacp/cli
npm install -g @n1creator/openacp-cli@latest
openacp --dir ~/openacp-workspace restart
openacp --dir ~/openacp-workspace status
openacp agents refresh
openacp doctor
```

On systemd-managed hosts, the daemon exits for systemd to invoke the stable
wrapper. Do not run a second detached daemon manually.

The Telegram `/update` command runs the global npm install inside the active
daemon and requests a restart only after npm succeeds. Do not stop/restart the
systemd unit or start a second manual npm install while `/update` is running:
the daemon forwards its termination signal to npm and reports the interrupted
update as failed. Wait for the Telegram success/failure message before doing
other rollout work.
