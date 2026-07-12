import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('npm trusted publishing workflow contract', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/publish.yml'), 'utf8')

  it('uses only OIDC-supported npm publish mutations', () => {
    expect(workflow).toContain('id-token: write')
    expect(workflow).not.toContain('npm dist-tag')
    expect(workflow).not.toContain('release-candidate')
    expect(workflow).not.toContain('NODE_AUTH_TOKEN')
  })

  it('publishes dependency-first and permits an idempotent partial rerun', () => {
    const sdk = workflow.indexOf('Publish @n1creator/openacp-plugin-sdk to latest')
    const cli = workflow.indexOf('Publish @n1creator/openacp-cli to latest')
    expect(cli).toBeGreaterThan(0)
    expect(sdk).toBeGreaterThan(cli)
    expect(workflow.match(/npm view .*\$\{VERSION\}.* version/g)).toHaveLength(2)
    expect(workflow.match(/dist-tags\.latest/g)).toHaveLength(2)
    expect(workflow.match(/interactive 2FA recovery runbook/g)).toHaveLength(2)
    expect(workflow.match(/npm publish --access=public --tag latest/g)).toHaveLength(2)
  })
})
