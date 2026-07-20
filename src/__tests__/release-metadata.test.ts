import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  const version = '2026.720.2'
  const previousVersion = '2026.720.1'

  it('keeps package, SDK peer floor, and changelog on the exact release', () => {
    const cli = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const sdk = JSON.parse(fs.readFileSync('packages/plugin-sdk/package.json', 'utf8'))
    const changelog = fs.readFileSync('CHANGELOG.md', 'utf8')
    const lockfile = fs.readFileSync('pnpm-lock.yaml', 'utf8')
    const registry = JSON.parse(fs.readFileSync('src/data/registry-snapshot.json', 'utf8'))
    const verifier = fs.readFileSync('scripts/verify-publish-artifacts.ts', 'utf8')
    const releaseRunbook = fs.readFileSync('docs/dev/n1creator-release-runbook.md', 'utf8')
    expect(cli.version).toBe(version)
    expect(sdk.version).toBe(version)
    expect(cli.engines.node).toBe('>=22')
    expect(sdk.engines.node).toBe('>=22')
    expect(sdk.peerDependencies['@n1creator/openacp-cli']).toBe(`>=${version}`)
    expect(sdk.peerDependencies.vitest).toBe('>=3 <5')
    expect(sdk.peerDependenciesMeta.vitest).toEqual({ optional: true })
    expect(version).toBe(`2026.${Number('0720')}.2`)
    expect(changelog).toMatch(new RegExp(`^## Unreleased\\r?\\n\\r?\\n## ${version.replaceAll('.', '\\.')} - 2026-07-20$`, 'm'))
    expect(changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')} - 2026-07-20$`, 'gm'))).toHaveLength(1)
    expect(changelog.slice(changelog.indexOf(`## ${version}`), changelog.indexOf(`## ${previousVersion}`)).trim()).not.toBe('')
    const taggedSection = changelog.slice(changelog.indexOf(`## ${previousVersion}`), changelog.indexOf('## 2026.718.4'))
    expect(createHash('sha256').update(taggedSection).digest('hex')).toBe('e7fb1f5c0697cbb0a65694f429d2fe3c9b0f49d9822a104c2ba5f7fe67ab04d0')
    expect(lockfile).toContain("version: link:../..")
    expect(lockfile).not.toContain(previousVersion)
    expect(changelog).not.toContain('2026.720.3')

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
      version: '0.2.105',
      distribution: { npx: { package: '@xai-official/grok@0.2.105' } },
    })
    expect(registry.agents.find((agent: { id: string }) => agent.id === 'factory-droid')).toMatchObject({
      version: '0.175.0',
      distribution: { npx: { package: 'droid@0.175.0' } },
    })
    expect(registry.agents.find((agent: { id: string }) => agent.id === 'harn')).toMatchObject({
      version: '0.10.24',
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.24/harn-aarch64-apple-darwin.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: '03c380383a0c6193b63bceff23ab4e8008bd8a2830f9a34e9aa88f47ed46f5e9',
          },
          'darwin-x86_64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.24/harn-x86_64-apple-darwin.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: '8e72b6477ba38bd58774f8397fa2bf2a252e7e1814a67de5a95566e8aa123db3',
          },
          'linux-aarch64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.24/harn-aarch64-unknown-linux-gnu.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: '687b52eeeb462e9577fcc182ff1ece5da47bc64e8853e662b2b09fd676ca0bd9',
          },
          'linux-x86_64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.24/harn-x86_64-unknown-linux-gnu.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: 'a9180f9a6eb7ddbf2a9198f44c44324503be47638e6c23cf77976ea1574ec37c',
          },
          'windows-x86_64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.24/harn-x86_64-pc-windows-msvc.zip',
            cmd: 'harn.exe',
            args: ['serve', 'acp'],
            sha256: 'b9f8ffa096417de8d4d87da527cbf838a829521c92556ccf598bd045e3369639',
          },
        },
      },
    })
    expect(createHash('sha256').update(fs.readFileSync('src/data/registry-snapshot.json')).digest('hex'))
      .toBe('a326e997f4d154bb0003d4a4aaac22e3282c5a4370d59f20b5c13b440ef9f147')
    expect(verifier).toContain('reviewed time-of-commit official release snapshot')
    expect(verifier).not.toContain('cdn.agentclientprotocol.com')
    expect(releaseRunbook).toMatch(/reviewed\s+time-of-commit release input/)
    expect(releaseRunbook).toContain('report-only and does not block that tag')
    expect(releaseRunbook).toContain('Codex ACP, Claude Agent ACP, or security-critical')
    expect(JSON.stringify(registry)).not.toContain('@zed-industries/codex-acp')
    expect(JSON.stringify(registry)).not.toContain('@augmentcode/auggie@0.32.0')
    expect(JSON.stringify(registry)).not.toContain('@xai-official/grok@0.2.104')
    expect(JSON.stringify(registry)).not.toContain('droid@0.174.0')
    expect(JSON.stringify(registry)).not.toContain('/harn/releases/download/v0.10.23/')
  })
})
