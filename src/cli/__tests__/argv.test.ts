import { describe, expect, it } from 'vitest'
import { normalizeLeadingJsonFlag } from '../argv.js'

describe('normalizeLeadingJsonFlag', () => {
  it('moves a leading JSON flag behind the command', () => {
    expect(normalizeLeadingJsonFlag(['--json', 'agents'])).toEqual(['agents', '--json'])
    expect(normalizeLeadingJsonFlag(['--json', 'agents', 'info', 'claude'])).toEqual([
      'agents', 'info', 'claude', '--json',
    ])
  })

  it('keeps OpenACP JSON mode before passthrough agent arguments', () => {
    expect(normalizeLeadingJsonFlag([
      '--json', 'agents', 'run', 'claude', '--', '--json', '--verbose',
    ])).toEqual([
      'agents', 'run', 'claude', '--json', '--', '--json', '--verbose',
    ])
  })

  it('preserves the documented command-first order', () => {
    expect(normalizeLeadingJsonFlag(['agents', '--json'])).toEqual(['agents', '--json'])
    expect(normalizeLeadingJsonFlag(['instances', 'list', '--json'])).toEqual([
      'instances', 'list', '--json',
    ])
  })

  it('does not turn a lone output flag into a command', () => {
    expect(normalizeLeadingJsonFlag(['--json'])).toEqual(['--json'])
  })
})
