import { describe, it, expect, vi } from 'vitest'
import { AgentManager } from '../agent-manager.js'
import { AgentInstance } from '../agent-instance.js'

function mockCatalog(installed: Record<string, any> = {}) {
  return {
    resolve: vi.fn((name: string) => {
      if (installed[name]) {
        return {
          name,
          command: installed[name].command,
          args: installed[name].args || [],
          env: installed[name].env || {},
        }
      }
      return undefined
    }),
    getInstalledEntries: vi.fn(() => installed),
  } as any
}

describe('AgentManager', () => {
  describe('getAvailableAgents()', () => {
    it('returns agent definitions from catalog', () => {
      const catalog = mockCatalog({
        claude: { command: 'claude-agent-acp', args: [], env: {} },
        codex: { command: 'codex', args: ['--acp'], env: {} },
      })
      const manager = new AgentManager(catalog)

      const agents = manager.getAvailableAgents()
      expect(agents).toHaveLength(2)
      expect(agents[0]).toMatchObject({
        name: 'claude',
        command: 'claude-agent-acp',
      })
    })

    it('returns empty array when no agents installed', () => {
      const catalog = mockCatalog({})
      const manager = new AgentManager(catalog)

      expect(manager.getAvailableAgents()).toEqual([])
    })
  })

  describe('getAgent()', () => {
    it('returns agent definition for known agent', () => {
      const catalog = mockCatalog({
        claude: { command: 'claude-agent-acp', args: [], env: {} },
      })
      const manager = new AgentManager(catalog)

      const agent = manager.getAgent('claude')
      expect(agent).toMatchObject({ name: 'claude', command: 'claude-agent-acp' })
    })

    it('returns undefined for unknown agent', () => {
      const catalog = mockCatalog({})
      const manager = new AgentManager(catalog)

      expect(manager.getAgent('unknown')).toBeUndefined()
    })
  })

  describe('spawn()', () => {
    it('throws for unknown agent', async () => {
      const catalog = mockCatalog({})
      const manager = new AgentManager(catalog)

      await expect(manager.spawn('unknown', '/workspace')).rejects.toThrow(
        /not installed/,
      )
    })

    it('includes install hint in error message', async () => {
      const catalog = mockCatalog({})
      const manager = new AgentManager(catalog)

      await expect(manager.spawn('claude', '/workspace')).rejects.toThrow(
        /openacp agents install claude/,
      )
    })

    it('passes the exact attested catalog definition to the subprocess boundary', async () => {
      const definition = {
        name: 'codex',
        registryId: 'codex-acp',
        distribution: 'npx',
        registryPackage: '@agentclientprotocol/codex-acp@1.1.4',
        installedVersion: '1.1.4',
        registryRuntimeAttested: true,
        registryEnvironment: { CODEX_MODE: 'reviewed' },
        command: 'npx',
        args: ['@agentclientprotocol/codex-acp@1.1.4'],
        env: { CODEX_MODE: 'reviewed' },
      }
      const catalog = {
        resolve: vi.fn(() => definition),
        getInstalledEntries: vi.fn(() => ({ codex: definition })),
      } as any
      const spawned = {} as AgentInstance
      const spawn = vi.spyOn(AgentInstance, 'spawn').mockResolvedValue(spawned)

      try {
        const manager = new AgentManager(catalog)
        await expect(manager.spawn('codex', '/workspace')).resolves.toBe(spawned)
        expect(spawn).toHaveBeenCalledWith(
          definition, '/workspace', undefined, undefined, expect.any(Object),
        )
        expect(spawn.mock.calls[0]?.[0]).toEqual(definition)
        expect(spawn.mock.calls[0]?.[0]).not.toBe(definition)
      } finally {
        spawn.mockRestore()
      }
    })
  })

  describe('resume()', () => {
    it('throws for unknown agent', async () => {
      const catalog = mockCatalog({})
      const manager = new AgentManager(catalog)

      await expect(
        manager.resume('unknown', '/workspace', 'session-id'),
      ).rejects.toThrow(/not installed/)
    })

    it('includes install hint in error message', async () => {
      const catalog = mockCatalog({})
      const manager = new AgentManager(catalog)

      await expect(
        manager.resume('codex', '/workspace', 'session-id'),
      ).rejects.toThrow(/openacp agents install codex/)
    })
  })
})
