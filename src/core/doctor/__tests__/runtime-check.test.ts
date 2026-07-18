import { describe, expect, it } from 'vitest'
import { checkNodeRuntime } from '../checks/runtime.js'

describe('Node.js runtime doctor check', () => {
  it.each(['22.0.0', '24.18.0'])('accepts supported release runtime %s', (version) => {
    expect(checkNodeRuntime(version)).toEqual({
      status: 'pass',
      message: `Node.js ${version} meets the required version (22 or newer)`,
    })
  })

  it('rejects Node.js 20 with an upgrade path', () => {
    expect(checkNodeRuntime('20.19.5')).toEqual({
      status: 'fail',
      message: 'Node.js 20.19.5 is unsupported; install Node.js 22 or newer (Node.js 24 is recommended)',
    })
  })

  it('fails closed for an unparseable runtime version', () => {
    expect(checkNodeRuntime('unknown').status).toBe('fail')
  })
})
