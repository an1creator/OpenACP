import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  const version = '2026.713.1'
  const previousVersion = '2026.712.12'

  it('keeps package, SDK peer floor, and changelog on the exact release', () => {
    const cli = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const sdk = JSON.parse(fs.readFileSync('packages/plugin-sdk/package.json', 'utf8'))
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
    const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')
    expect(cli.version).toBe(version)
    expect(sdk.version).toBe(version)
    expect(sdk.peerDependencies['@n1creator/openacp-cli']).toBe(`>=${version}`)
    expect(version).toBe(`2026.${Number('0713')}.1`)
    expect(changelog).toMatch(new RegExp(`^## Unreleased\\r?\\n\\r?\\n## ${version.replaceAll('.', '\\.')} - 2026-07-13$`, 'm'))
    expect(changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')} - 2026-07-13$`, 'gm'))).toHaveLength(1)
    expect(changelog.slice(changelog.indexOf(`## ${version}`), changelog.indexOf(`## ${previousVersion}`)).trim()).not.toBe('')
    const taggedSection = changelog.slice(changelog.indexOf(`## ${previousVersion}`), changelog.indexOf('## 2026.712.11'))
    expect(createHash('sha256').update(taggedSection).digest('hex')).toBe('aa63ad52d1569e251c9c472433057456aa8fbf10d656d023a66f58e234e3a0b3')
    expect(lockfile).toContain("version: link:../..")
    expect(lockfile).not.toContain('2026.712.10')
    expect(changelog).not.toContain('2026.712.13')
  })
})
