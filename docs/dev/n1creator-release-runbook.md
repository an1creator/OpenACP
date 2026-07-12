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
`YYYY.MMDD.patch`.

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
VERSION=2026.712.7
git tag "v${VERSION}"
git push origin main
git push origin "v${VERSION}"
```

Confirm both packages have the expected version and provenance, then test a
clean global install before updating a production daemon.

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
