import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

describe('release metadata', () => {
  const version = '2026.718.3'
  const previousVersion = '2026.718.2'

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
    expect(version).toBe(`2026.${Number('0718')}.3`)
    expect(changelog).toMatch(new RegExp(`^## Unreleased\\r?\\n\\r?\\n## ${version.replaceAll('.', '\\.')} - 2026-07-18$`, 'm'))
    expect(changelog.match(new RegExp(`^## ${version.replaceAll('.', '\\.')} - 2026-07-18$`, 'gm'))).toHaveLength(1)
    expect(changelog.slice(changelog.indexOf(`## ${version}`), changelog.indexOf(`## ${previousVersion}`)).trim()).not.toBe('')
    const taggedSection = changelog.slice(changelog.indexOf(`## ${previousVersion}`), changelog.indexOf('## 2026.718.1'))
    expect(createHash('sha256').update(taggedSection).digest('hex')).toBe('33657f8dfa375ef333b9070594a3cd89ba1fa1bf385f61aadd3728e4f58b7f01')
    expect(lockfile).toContain("version: link:../..")
    expect(lockfile).not.toContain(previousVersion)
    expect(changelog).not.toContain('2026.718.4')

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
    expect(registry.agents.find((agent: { id: string }) => agent.id === 'harn')).toMatchObject({
      version: '0.10.23',
      distribution: {
        binary: {
          'darwin-aarch64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-aarch64-apple-darwin.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: 'fccf097942c678aba14325f7fbfe06ccd08b41de7229ed987f4837b14d640cbb',
          },
          'darwin-x86_64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-x86_64-apple-darwin.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: 'c871cb53064f0f5962068572dae37a679ad6765f6f74042a52473da24f585f32',
          },
          'linux-aarch64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-aarch64-unknown-linux-gnu.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: 'a7bc1cdf1447105105d975aa1d0442bbed9e48b4df8a394dc23fda835abef149',
          },
          'linux-x86_64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-x86_64-unknown-linux-gnu.tar.gz',
            cmd: './harn',
            args: ['serve', 'acp'],
            sha256: 'a3c5d9ab75b154a846e6962a84b0acd8cd056890d8d5b40d2cd5f7f50d11bc87',
          },
          'windows-x86_64': {
            archive: 'https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-x86_64-pc-windows-msvc.zip',
            cmd: 'harn.exe',
            args: ['serve', 'acp'],
            sha256: '05eea0438b8c619258cef7fd3ccf644bfe09d8b5cbf323c45f3addaaf8e6bcb8',
          },
        },
      },
    })
    expect(createHash('sha256').update(fs.readFileSync('src/data/registry-snapshot.json')).digest('hex'))
      .toBe('11850b8fef1032661534c3f611e9793f7af5e0f2b4cf856a72eca0394f48702b')
    expect(verifier).toContain('reviewed time-of-commit official release snapshot')
    expect(verifier).not.toContain('cdn.agentclientprotocol.com')
    expect(releaseRunbook).toMatch(/reviewed\s+time-of-commit release input/)
    expect(releaseRunbook).toContain('report-only and does not block that tag')
    expect(releaseRunbook).toContain('Codex ACP, Claude Agent ACP, or security-critical')
    expect(JSON.stringify(registry)).not.toContain('@zed-industries/codex-acp')
    expect(JSON.stringify(registry)).not.toContain('@augmentcode/auggie@0.32.0')
    expect(JSON.stringify(registry)).not.toContain('@xai-official/grok@0.2.103')
    expect(JSON.stringify(registry)).not.toContain('droid@0.174.0')
    expect(JSON.stringify(registry)).not.toContain('/harn/releases/download/v0.10.22/')
  })
})
