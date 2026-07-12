import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  const version = '2026.712.9'

  it('keeps package, SDK peer floor, and changelog on the exact release', () => {
    const cli = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const sdk = JSON.parse(fs.readFileSync('packages/plugin-sdk/package.json', 'utf8'))
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
    expect(cli.version).toBe(version)
    expect(sdk.version).toBe(version)
    expect(sdk.peerDependencies['@n1creator/openacp-cli']).toBe(`>=${version}`)
    expect(changelog).toContain(`## ${version} - 2026-07-12`)
  })
})
