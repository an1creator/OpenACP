import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  const version = '2026.712.12'

  it('keeps package, SDK peer floor, and changelog on the exact release', () => {
    const cli = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const sdk = JSON.parse(fs.readFileSync('packages/plugin-sdk/package.json', 'utf8'))
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
    const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')
    expect(cli.version).toBe(version)
    expect(sdk.version).toBe(version)
    expect(sdk.peerDependencies['@n1creator/openacp-cli']).toBe(`>=${version}`)
    expect(changelog).toMatch(/^## Unreleased\r?\n/)
    expect(changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')} - 2026-07-12$`, 'gm'))).toHaveLength(1)
    expect(changelog.slice('## Unreleased'.length, changelog.indexOf(`## ${version}`)).trim()).toBe('')
    expect(lockfile).toContain("version: link:../..")
    expect(lockfile).not.toContain('2026.712.10')
  })
})
