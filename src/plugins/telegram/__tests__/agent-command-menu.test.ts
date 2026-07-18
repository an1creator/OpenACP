import { describe, expect, it } from 'vitest'
import {
  buildSkillKeyboard,
  buildSkillMessages,
  encodeAgentCommandCallback,
  formatAgentCommandInvocation,
  formatAgentCommandText,
  normalizeAgentCommandName,
  resolveAgentCommandCallback,
} from '../commands/menu.js'
import {
  STANDARD_AGENT_ACTIONS,
  normalizeAgentActionUpdate,
} from '../../../core/agents/agent-action-policy.js'

describe('Telegram ACP agent command controls', () => {
  it('formats advertised names with exactly one leading slash', () => {
    expect(formatAgentCommandText('review')).toBe('/review')
    expect(formatAgentCommandText('/review', 'branch')).toBe('/review branch')
    expect(buildSkillMessages([
      { name: '/review', description: 'Review code' },
    ])[0]).toContain('<code>/review</code>')
    expect(buildSkillMessages([
      { name: '/review', description: 'Review code' },
    ])[0]).not.toContain('//review')
    expect(formatAgentCommandInvocation({
      name: 'review', description: 'Review code',
      action: { key: 'review', invocation: '/ReViEw', handling: 'agent', acceptsInput: true },
    }, 'branch')).toBe('/ReViEw branch')
    expect(normalizeAgentCommandName('/REVIEW')).toBe('review')
    expect(normalizeAgentCommandName('/ＲＥＶＩＥＷ')).toBe('')
  })

  it('uses a distinct callback namespace and resolves the current exact command object', () => {
    const command = {
      name: 'status',
      description: 'Agent status',
      input: { hint: 'Optional target', _meta: { completion: true } },
      _meta: { owner: 'agent' },
    }
    const data = encodeAgentCommandCallback(command.name)
    const resolved = resolveAgentCommandCallback(data, [command])

    expect(data).toMatch(/^a\//)
    expect(resolved).toBe(command)
    expect(resolved?._meta).toEqual({ owner: 'agent' })
    expect((buildSkillKeyboard([command]) as any).inline_keyboard[0][0]).toMatchObject({
      text: '/status',
      callback_data: data,
    })
  })

  it('keeps long command callbacks within Telegram limits without losing lookup', () => {
    const command = { name: `command_${'x'.repeat(100)}`, description: 'Long command' }
    const data = encodeAgentCommandCallback(command.name)

    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    expect(data).toMatch(/^a\/#/)
    expect(resolveAgentCommandCallback(data, [command])).toBe(command)
  })

  it('splits long command catalogs within the Telegram text limit', () => {
    const commands = Array.from({ length: 100 }, (_, index) => ({
      name: `command_${index}_${'n'.repeat(100)}`,
      description: '&'.repeat(512),
    }))

    const messages = buildSkillMessages(commands)

    expect(messages.length).toBeGreaterThan(1)
    expect(messages.every((message) => message.length <= 4096)).toBe(true)
  })

  it('renders the complete Codex action surface in one ordered message', () => {
    const commands = normalizeAgentActionUpdate(
      {
        registryId: 'codex-acp', distribution: 'npx',
        registryPackage: '@agentclientprotocol/codex-acp@1.1.4',
        installedVersion: '1.1.4', registryRuntimeAttested: true,
        command: 'npx', args: ['@agentclientprotocol/codex-acp@1.1.4'],
        env: {}, registryEnvironment: {},
      },
      STANDARD_AGENT_ACTIONS.map(({ name }) => ({ name, description: 'ignored' })),
    ).commands
    const [message, ...overflow] = buildSkillMessages(commands)

    expect(overflow).toEqual([])
    let previousIndex = -1
    for (const action of commands) {
      const index = message!.indexOf(`<code>/${action.name}</code> — ${action.description}`)
      expect(index).toBeGreaterThan(previousIndex)
      previousIndex = index
    }
    expect(message).not.toContain('/$')
    expect(message).not.toContain('SKILL.md')
  })
})
