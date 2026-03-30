import { readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { StoredToken, CreateTokenOpts } from './types.js'

const REFRESH_DEADLINE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function generateTokenId(): string {
  return `tok_${randomBytes(12).toString('hex')}`
}

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(m|h|d)$/)
  if (!match) throw new Error(`Invalid duration: ${duration}`)
  const value = parseInt(match[1], 10)
  switch (match[2]) {
    case 'm': return value * 60 * 1000
    case 'h': return value * 60 * 60 * 1000
    case 'd': return value * 24 * 60 * 60 * 1000
    default: throw new Error(`Invalid duration unit: ${match[2]}`)
  }
}

export class TokenStore {
  private tokens = new Map<string, StoredToken>()

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    try {
      const data = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data) as { tokens: StoredToken[] }
      this.tokens.clear()
      for (const token of parsed.tokens) {
        this.tokens.set(token.id, token)
      }
    } catch {
      this.tokens.clear()
    }
  }

  async save(): Promise<void> {
    const data = { tokens: Array.from(this.tokens.values()) }
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  create(opts: CreateTokenOpts): StoredToken {
    const now = new Date()
    const token: StoredToken = {
      id: generateTokenId(),
      name: opts.name,
      role: opts.role,
      scopes: opts.scopes,
      createdAt: now.toISOString(),
      refreshDeadline: new Date(now.getTime() + REFRESH_DEADLINE_MS).toISOString(),
      revoked: false,
    }
    this.tokens.set(token.id, token)
    this.save().catch(() => {})
    return token
  }

  get(id: string): StoredToken | undefined {
    return this.tokens.get(id)
  }

  revoke(id: string): void {
    const token = this.tokens.get(id)
    if (token) {
      token.revoked = true
      this.save().catch(() => {})
    }
  }

  list(): StoredToken[] {
    return Array.from(this.tokens.values()).filter((t) => !t.revoked)
  }

  listAll(): StoredToken[] {
    return Array.from(this.tokens.values())
  }

  updateLastUsed(id: string): void {
    const token = this.tokens.get(id)
    if (token) {
      token.lastUsedAt = new Date().toISOString()
    }
  }

  cleanup(): void {
    const now = Date.now()
    for (const [id, token] of this.tokens) {
      if (new Date(token.refreshDeadline).getTime() < now) {
        this.tokens.delete(id)
      }
    }
    this.save().catch(() => {})
  }
}
