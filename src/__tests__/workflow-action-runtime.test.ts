import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('GitHub action runtime contract', () => {
  const workflows = fs.readdirSync(path.resolve('.github/workflows'))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => fs.readFileSync(path.resolve('.github/workflows', name), 'utf8'))
    .join('\n')

  it('pins maintained Node 24 action-runtime majors without weakening the project matrix', () => {
    const checkout = [...workflows.matchAll(/actions\/checkout@(\S+)/g)].map((match) => match[1])
    const setupNode = [...workflows.matchAll(/actions\/setup-node@(\S+)/g)].map((match) => match[1])
    const setupPnpm = [...workflows.matchAll(/pnpm\/action-setup@(\S+)/g)].map((match) => match[1])
    expect(checkout.length).toBeGreaterThan(0)
    expect(setupNode.length).toBeGreaterThan(0)
    expect(setupPnpm.length).toBeGreaterThan(0)
    expect(new Set(checkout)).toEqual(new Set(['v7']))
    expect(new Set(setupNode)).toEqual(new Set(['v6']))
    expect(new Set(setupPnpm)).toEqual(new Set(['v6']))
    expect(fs.readFileSync('.github/workflows/ci.yml', 'utf8')).toMatch(
      /node-version:\s*\n\s*- 22\s*\n\s*- 24/,
    )
    expect(fs.readFileSync('.github/workflows/publish.yml', 'utf8')).toMatch(
      /node-version:\s*\[22, 24\]/,
    )
  })
})
