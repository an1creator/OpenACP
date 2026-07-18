import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  const version = '2026.718.1'
  const previousVersion = '2026.713.2'

  it('keeps package, SDK peer floor, and changelog on the exact release', () => {
    const cli = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const sdk = JSON.parse(fs.readFileSync('packages/plugin-sdk/package.json', 'utf8'))
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
    const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')
    const registry = JSON.parse(fs.readFileSync('src/data/registry-snapshot.json', 'utf8'))
    expect(cli.version).toBe(version)
    expect(sdk.version).toBe(version)
    expect(cli.engines.node).toBe('>=22')
    expect(sdk.engines.node).toBe('>=22')
    expect(sdk.peerDependencies['@n1creator/openacp-cli']).toBe(`>=${version}`)
    expect(version).toBe(`2026.${Number('0718')}.1`)
    expect(changelog).toMatch(new RegExp(`^## Unreleased\\r?\\n\\r?\\n## ${version.replaceAll('.', '\\.')} - 2026-07-18$`, 'm'))
    expect(changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')} - 2026-07-18$`, 'gm'))).toHaveLength(1)
    expect(changelog.slice(changelog.indexOf(`## ${version}`), changelog.indexOf(`## ${previousVersion}`)).trim()).not.toBe('')
    const taggedSection = changelog.slice(changelog.indexOf(`## ${previousVersion}`), changelog.indexOf('## 2026.713.1'))
    expect(createHash('sha256').update(taggedSection).digest('hex')).toBe('0a002ed8d3613d541d49669d93d2340bc4cbe97b777b317a6b0246cc82ef7e1d')
    expect(lockfile).toContain("version: link:../..")
    expect(lockfile).not.toContain(previousVersion)
    expect(changelog).not.toContain('2026.718.2')

    const codex = registry.agents.find((agent: { id: string }) => agent.id === 'codex-acp')
    expect(codex).toMatchObject({
      version: '1.1.4',
      distribution: { npx: { package: '@agentclientprotocol/codex-acp@1.1.4' } },
    })
    expect(registry.agents).toHaveLength(38)
    expect(registry.agents.find((agent: { id: string }) => agent.id === 'auggie')).toMatchObject({
      version: '0.33.0',
      distribution: { npx: { package: '@augmentcode/auggie@0.33.0' } },
    })
    expect(registry.agents.find((agent: { id: string }) => agent.id === 'grok-build')).toMatchObject({
      version: '0.2.104',
      distribution: { npx: { package: '@xai-official/grok@0.2.104' } },
    })
    expect(registry.agents.find((agent: { id: string }) => agent.id === 'factory-droid')).toMatchObject({
      version: '0.175.0',
      distribution: { npx: { package: 'droid@0.175.0' } },
    })
    expect(createHash('sha256').update(fs.readFileSync('src/data/registry-snapshot.json')).digest('hex'))
      .toBe('493e1fba107d69a3bedc2201e30c5c4fd6d9fcfdf378b18c7172982d2bd68af1')
    expect(JSON.stringify(registry)).not.toContain('@zed-industries/codex-acp')
    expect(JSON.stringify(registry)).not.toContain('@augmentcode/auggie@0.32.0')
    expect(JSON.stringify(registry)).not.toContain('@xai-official/grok@0.2.103')
    expect(JSON.stringify(registry)).not.toContain('droid@0.174.0')
  })
})
