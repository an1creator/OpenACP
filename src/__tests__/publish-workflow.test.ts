import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('npm trusted publishing workflow contract', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/publish.yml'), 'utf8')

  it('uses only OIDC-supported npm publish mutations', () => {
    expect(workflow).toContain('id-token: write')
    expect(workflow).toContain('registry-url: https://registry.npmjs.org')
    expect(workflow).not.toContain('npm dist-tag')
    expect(workflow).not.toContain('release-candidate')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
    expect(workflow).not.toContain('NPM_TOKEN')
  })

  it('publishes dependency-first and permits an idempotent partial rerun', () => {
    const sdk = workflow.indexOf('Publish @n1creator/openacp-plugin-sdk to latest')
    const cli = workflow.indexOf('Publish @n1creator/openacp-cli to latest')
    expect(cli).toBeGreaterThan(0)
    expect(sdk).toBeGreaterThan(cli)
    expect(workflow.match(/npm view .*\$\{VERSION\}.* version/g)).toHaveLength(2)
    expect(workflow.match(/dist-tags\.latest/g)).toHaveLength(2)
    expect(workflow.match(/is already latest; resuming partial release/g)).toHaveLength(2)
    expect(workflow.match(/interactive 2FA recovery runbook/g)).toHaveLength(2)
    expect(workflow.match(/^\s*if \[ "\$LATEST" = "\$VERSION" \]; then$/gm)).toHaveLength(2)
    expect(workflow.match(/^\s*exit 1$/gm)).toHaveLength(2)

    expect(workflow).toContain('LATEST="$(npm view "@n1creator/openacp-cli" dist-tags.latest)"')
    expect(workflow).toContain('LATEST="$(npm view "@n1creator/openacp-plugin-sdk" dist-tags.latest)"')

    const publishCommands = workflow.match(/^\s*npm publish .*$/gm)?.map((command) => command.trim())
    expect(publishCommands).toEqual([
      'npm publish "./release-artifacts/n1creator-openacp-cli-${VERSION}.tgz" --access=public --tag latest',
      'npm publish "./release-artifacts/n1creator-openacp-plugin-sdk-${VERSION}.tgz" --access=public --tag latest',
    ])
    expect(workflow).not.toMatch(/^\s*npm publish\s+["']?release-artifacts\//gm)
    expect(workflow).not.toMatch(/^\s*npm publish\s+(?:github:|git\+ssh:|git@github\.com:)/gm)
    expect(workflow).toContain('if npm view "@n1creator/openacp-cli@${VERSION}" version')
    expect(workflow).toContain('if npm view "@n1creator/openacp-plugin-sdk@${VERSION}" version')
  })
})
