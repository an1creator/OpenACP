import { describe, expect, it } from 'vitest'
import { redactAgentEnv } from '../routes/agents.js'

describe('agent API response redaction', () => {
  it('never exposes agent environment values', () => {
    const result = redactAgentEnv({
      name: 'codex',
      env: {
        HTTP_PROXY: 'http://user:password@proxy.example:8080',
        NODE_OPTIONS: '--use-env-proxy',
      },
    })

    expect(result).toEqual({
      name: 'codex',
      env: {
        HTTP_PROXY: '***',
        NODE_OPTIONS: '***',
      },
    })
    expect(JSON.stringify(result)).not.toContain('password')
    expect(JSON.stringify(result)).not.toContain('--use-env-proxy')
  })

  it('leaves agents without an env object unchanged', () => {
    const agent = { name: 'custom', command: '/usr/bin/custom' }
    expect(redactAgentEnv(agent)).toBe(agent)
  })
})
