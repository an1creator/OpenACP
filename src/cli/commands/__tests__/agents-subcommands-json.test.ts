import { describe, it, expect, vi, afterEach } from 'vitest'
import { captureJsonOutput, expectValidJsonSuccess, expectValidJsonError } from './helpers/json-test-utils.js'

const refreshResult = vi.hoisted(() => ({
  current: {
    ok: true, refreshed: true, count: 38,
    status: { source: 'network', stale: false },
  } as Record<string, unknown>,
}))

const installResult = vi.hoisted(() => ({
  current: { ok: true, agentKey: 'gemini' } as Record<string, unknown>,
}))

vi.mock('../../../core/agents/agent-catalog.js', () => {
  class MockAgentCatalog {
    load = vi.fn()
    refreshRegistryIfStale = vi.fn().mockResolvedValue(undefined)
    getRegistryStatus = vi.fn().mockReturnValue({ source: 'cache', stale: false })
    fetchRegistry = vi.fn().mockImplementation(async () => refreshResult.current)
    getAvailable = vi.fn().mockReturnValue([])
    getInstalledAgent = vi.fn().mockImplementation((key: string) => {
      if (key === 'claude-code') {
        return {
          registryId: 'claude-code',
          name: 'Claude Code',
          version: '1.0.0',
          distribution: 'npm',
          command: 'npx',
          args: ['@anthropic-ai/claude-code'],
          env: {},
          installedAt: '2026-01-01T00:00:00Z',
          binaryPath: null,
        }
      }
      return undefined
    })
    findRegistryAgent = vi.fn().mockReturnValue(undefined)
    install = vi.fn().mockImplementation(async () => installResult.current)
    uninstall = vi.fn().mockResolvedValue({ ok: true })
    getInstalledEntries = vi.fn().mockReturnValue({ 'claude-code': {} })
  }
  return { AgentCatalog: MockAgentCatalog }
})

vi.mock('../../../core/agents/agent-dependencies.js', () => ({
  getAgentCapabilities: vi.fn().mockReturnValue({ integration: null }),
  getAgentSetup: vi.fn().mockReturnValue(undefined),
}))

describe('agents info --json', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('outputs JSON for installed agent', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['info', 'claude-code', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('key', 'claude-code')
    expect(data).toHaveProperty('name', 'Claude Code')
    expect(data).toHaveProperty('installed', true)
    expect(data).toHaveProperty('version', '1.0.0')
    expect(data).toHaveProperty('distribution', 'npm')
    expect(data).toHaveProperty('command', 'npx')
  })

  it('accepts JSON before the info subcommand', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['--json', 'info', 'claude-code'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    expect(expectValidJsonSuccess(result.stdout)).toMatchObject({ key: 'claude-code', installed: true })
  })

  it('outputs JSON error for unknown agent', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['info', 'nonexistent', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'AGENT_NOT_FOUND')
  })

  it('outputs JSON error when no agent name provided', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['info', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'MISSING_ARGUMENT')
  })
})

describe('agents install --json', () => {
  afterEach(() => {
    installResult.current = { ok: true, agentKey: 'gemini' }
    vi.restoreAllMocks()
  })

  it('outputs JSON on successful install', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['install', 'gemini', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('key', 'gemini')
    expect(data).toHaveProperty('installed', true)
    expect(data).toHaveProperty('alreadyInstalled', false)
    expect(data).toHaveProperty('cleanupPending', false)
  })

  it('accepts JSON before the install subcommand without changing its result', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['--json', 'install', 'gemini'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    expect(expectValidJsonSuccess(result.stdout)).toMatchObject({ key: 'gemini', installed: true })
  })

  it('reports an idempotent install without presenting it as a replacement', async () => {
    installResult.current = { ok: true, agentKey: 'gemini', alreadyInstalled: true }
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['install', 'gemini', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    expect(expectValidJsonSuccess(result.stdout)).toMatchObject({
      installed: true,
      alreadyInstalled: true,
      cleanupPending: false,
    })
  })

  it('keeps a committed install successful and exposes pending cleanup in JSON', async () => {
    installResult.current = {
      ok: true,
      agentKey: 'gemini',
      cleanupPending: true,
      cleanupRetryable: true,
      cleanupMessage: 'The agent is installed; cleanup is pending',
    }
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['install', 'gemini', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    expect(expectValidJsonSuccess(result.stdout)).toMatchObject({
      installed: true,
      cleanupPending: true,
      cleanupRetryable: true,
      cleanupMessage: 'The agent is installed; cleanup is pending',
    })
  })

  it('outputs JSON error when no agent name provided', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['install', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'MISSING_ARGUMENT')
  })
})

describe('agents uninstall --json', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('outputs JSON on successful uninstall', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['uninstall', 'claude-code', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    const data = expectValidJsonSuccess(result.stdout)
    expect(data).toHaveProperty('key', 'claude-code')
    expect(data).toHaveProperty('uninstalled', true)
  })

  it('outputs JSON error when no agent name provided', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['uninstall', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'MISSING_ARGUMENT')
  })
})

describe('agents refresh --json', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    refreshResult.current = {
      ok: true, refreshed: true, count: 38,
      status: { source: 'network', stale: false },
    }
  })

  it('returns the live catalog result on success', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['refresh', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    expect(expectValidJsonSuccess(result.stdout)).toMatchObject({
      refreshed: true,
      count: 38,
      catalog: { source: 'network', stale: false },
    })
  })

  it('accepts JSON before the refresh subcommand', async () => {
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['--json', 'refresh'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(0)
    expect(expectValidJsonSuccess(result.stdout)).toMatchObject({ refreshed: true, count: 38 })
  })

  it('exits non-zero with a stable typed error when the network refresh fails', async () => {
    refreshResult.current = {
      ok: false, refreshed: false,
      error: 'ACP Registry could not be reached or returned invalid data',
      status: { source: 'cache', stale: true },
    }
    const { cmdAgents } = await import('../agents.js')
    const result = await captureJsonOutput(async () => {
      await cmdAgents(['refresh', '--json'], '/tmp/test-openacp')
    })
    expect(result.exitCode).toBe(1)
    expectValidJsonError(result.stdout, 'AGENT_REGISTRY_REFRESH_FAILED')
  })
})
