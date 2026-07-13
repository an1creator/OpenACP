import { describe, expect, it, vi } from 'vitest'
import { printHelp } from '../help.js'
import { printProxyHelp } from '../proxy.js'
import { MenuRegistry } from '../../../core/menu-registry.js'
import { registerCoreMenuItems } from '../../../core/menu/core-items.js'
import { STATIC_COMMANDS } from '../../../plugins/telegram/commands/index.js'

function captureHelp(print: () => void): string {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    print()
    return log.mock.calls.map(([value]) => String(value)).join('\n').replace(/\u001b\[[0-9;]*m/g, '')
  } finally {
    log.mockRestore()
  }
}

const COMPLETE_PROXY_COMMANDS = [
  'openacp proxy status',
  'openacp proxy create <id> --from-json <0600-file>',
  'openacp proxy update <id> --from-json <0600-file>',
  'openacp proxy import <id> --env-file <0600-file>',
  'openacp proxy test-candidate <id> --from-json <0600-file>',
  'openacp proxy set <scope|global> <direct|inherit|profile:id>',
  'openacp proxy clear <scope|global>',
  'openacp proxy test --scope <scope>',
  'openacp proxy test --profile <id>',
  'openacp proxy delete <id>',
]

describe('proxy command discoverability', () => {
  it('has a dedicated and complete section in top-level help', () => {
    const output = captureHelp(printHelp)
    expect(output).toContain('Tunnels:')
    expect(output).not.toContain('Tunnels & Network:')
    expect(output).toContain('Network proxy:')
    expect(output.indexOf('Network proxy:')).toBeGreaterThan(output.indexOf('Tunnels:'))
    for (const command of COMPLETE_PROXY_COMMANDS) expect(output).toContain(command)
    expect(output).toContain('--reassign <route>')
    expect(output).toContain('--expected-revision <n>')
    expect(output).toContain('regular files with mode 0600')
    expect(output).toContain('write-only')
    expect(output).toContain('Quick URL')
    expect(output).toContain('proxyUrl')
  })

  it('documents every implemented profile and routing operation in proxy help', () => {
    const output = captureHelp(printProxyHelp)
    expect(output).toContain('Proxy profiles:')
    expect(output).toContain('Traffic routes:')
    for (const command of COMPLETE_PROXY_COMMANDS) expect(output).toContain(command)
    expect(output).toContain('clearCredentials=true')
    expect(output).toContain('Test a complete profile in memory without saving it')
    expect(output).toContain('mode-0600 regular files')
    expect(output).toContain('never in command arguments')
  })

  it('is discoverable in Telegram autocomplete and through Settings without a duplicate main-menu item', () => {
    expect(STATIC_COMMANDS).toContainEqual({
      command: 'proxy',
      description: 'Configure network proxy',
    })
    const menu = new MenuRegistry()
    registerCoreMenuItems(menu)
    expect(menu.getItem('core:settings')).toMatchObject({
      label: '⚙️ Settings',
      action: { type: 'callback', callbackData: 's:settings' },
    })
    expect(menu.getItems().map((item) => item.id)).not.toContain('core:proxy')
    const legacyProxyItem = menu.getItem('core:proxy')
    expect(legacyProxyItem).toMatchObject({
      label: '🌐 Proxy Routing',
      action: { type: 'command', command: '/proxy' },
    })
    expect(legacyProxyItem?.visible?.()).toBe(false)
  })
})
