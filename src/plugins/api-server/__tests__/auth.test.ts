import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { getRoleScopes, hasScope, isValidRole } from '../auth/roles.js'
import { TokenStore } from '../auth/token-store.js'
import { signToken, verifyToken, verifyForRefresh } from '../auth/jwt.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ========================
// Roles
// ========================

describe('roles', () => {
  it('admin has wildcard scope', () => {
    expect(getRoleScopes('admin')).toEqual(['*'])
  })

  it('operator has session and agent scopes but not config:write', () => {
    const scopes = getRoleScopes('operator')
    expect(scopes).toContain('sessions:read')
    expect(scopes).toContain('sessions:write')
    expect(scopes).toContain('sessions:prompt')
    expect(scopes).not.toContain('config:write')
    expect(scopes).not.toContain('system:admin')
  })

  it('viewer has read-only scopes', () => {
    const scopes = getRoleScopes('viewer')
    expect(scopes).toContain('sessions:read')
    expect(scopes).toContain('agents:read')
    expect(scopes).not.toContain('sessions:write')
  })

  it('hasScope checks wildcard', () => {
    expect(hasScope(['*'], 'anything:here')).toBe(true)
  })

  it('hasScope checks exact match', () => {
    expect(hasScope(['sessions:read', 'agents:read'], 'sessions:read')).toBe(true)
    expect(hasScope(['sessions:read'], 'sessions:write')).toBe(false)
  })

  it('isValidRole validates role names', () => {
    expect(isValidRole('admin')).toBe(true)
    expect(isValidRole('operator')).toBe(true)
    expect(isValidRole('viewer')).toBe(true)
    expect(isValidRole('superadmin')).toBe(false)
  })
})

// ========================
// TokenStore
// ========================

describe('TokenStore', () => {
  let store: TokenStore
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'token-store-'))
    store = new TokenStore(join(tmpDir, 'tokens.json'))
    await store.load()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('creates a token with generated ID', () => {
    const token = store.create({ role: 'admin', name: 'test-token', expire: '24h' })
    expect(token.id).toMatch(/^tok_/)
    expect(token.name).toBe('test-token')
    expect(token.role).toBe('admin')
    expect(token.revoked).toBe(false)
  })

  it('refresh deadline is 7 days from creation', () => {
    const token = store.create({ role: 'admin', name: 'test', expire: '24h' })
    const created = new Date(token.createdAt).getTime()
    const deadline = new Date(token.refreshDeadline).getTime()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    expect(deadline - created).toBe(sevenDays)
  })

  it('gets a token by ID', () => {
    const created = store.create({ role: 'viewer', name: 'get-test', expire: '1h' })
    const found = store.get(created.id)
    expect(found).toBeDefined()
    expect(found!.id).toBe(created.id)
  })

  it('returns undefined for unknown token ID', () => {
    expect(store.get('tok_nonexistent')).toBeUndefined()
  })

  it('revokes a token', () => {
    const token = store.create({ role: 'admin', name: 'revoke-test', expire: '24h' })
    store.revoke(token.id)
    expect(store.get(token.id)!.revoked).toBe(true)
  })

  it('lists non-revoked tokens', () => {
    store.create({ role: 'admin', name: 'tok-1', expire: '24h' })
    store.create({ role: 'viewer', name: 'tok-2', expire: '24h' })
    const tok3 = store.create({ role: 'operator', name: 'tok-3', expire: '24h' })
    store.revoke(tok3.id)
    expect(store.list()).toHaveLength(2)
  })

  it('updates lastUsedAt', () => {
    const token = store.create({ role: 'admin', name: 'used-test', expire: '24h' })
    expect(token.lastUsedAt).toBeUndefined()
    store.updateLastUsed(token.id)
    expect(store.get(token.id)!.lastUsedAt).toBeDefined()
  })

  it('persists to disk and loads back', async () => {
    store.create({ role: 'admin', name: 'persist-test', expire: '24h' })
    await store.save()

    const store2 = new TokenStore(join(tmpDir, 'tokens.json'))
    await store2.load()
    expect(store2.list()).toHaveLength(1)
    expect(store2.list()[0].name).toBe('persist-test')
  })

  it('cleanup removes tokens past refresh deadline', () => {
    const token = store.create({ role: 'admin', name: 'expired', expire: '24h' })
    const stored = store.get(token.id)!
    ;(stored as any).refreshDeadline = new Date(Date.now() - 1000).toISOString()
    store.cleanup()
    expect(store.get(token.id)).toBeUndefined()
  })
})

// ========================
// JWT
// ========================

const JWT_SECRET = 'test-secret-key-for-jwt-signing-minimum-length'

describe('JWT', () => {
  it('signs a token with correct format', () => {
    const token = signToken(
      { sub: 'tok_123', role: 'admin', rfd: Math.floor(Date.now() / 1000) + 86400 * 7 },
      JWT_SECRET,
      '24h',
    )
    expect(token.split('.')).toHaveLength(3)
  })

  it('verifies a valid token', () => {
    const rfd = Math.floor(Date.now() / 1000) + 86400 * 7
    const token = signToken({ sub: 'tok_123', role: 'operator', rfd }, JWT_SECRET, '24h')
    const payload = verifyToken(token, JWT_SECRET)
    expect(payload.sub).toBe('tok_123')
    expect(payload.role).toBe('operator')
    expect(payload.rfd).toBe(rfd)
  })

  it('rejects an expired token', () => {
    const rfd = Math.floor(Date.now() / 1000) + 86400 * 7
    // Craft a token with exp set to 10 seconds ago
    const token = signToken({ sub: 'tok_123', role: 'admin', rfd }, JWT_SECRET, '1h')
    const parts = token.split('.')
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
    payload.exp = Math.floor(Date.now() / 1000) - 10
    const newBody = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${newBody}`).digest('base64url')
    const expiredToken = `${parts[0]}.${newBody}.${sig}`

    expect(() => verifyToken(expiredToken, JWT_SECRET)).toThrow('JWT expired')
  })

  it('rejects a token with wrong secret', () => {
    const rfd = Math.floor(Date.now() / 1000) + 86400 * 7
    const token = signToken({ sub: 'tok_123', role: 'admin', rfd }, JWT_SECRET, '24h')
    expect(() => verifyToken(token, 'wrong-secret')).toThrow()
  })

  it('verifyForRefresh accepts expired token', () => {
    const rfd = Math.floor(Date.now() / 1000) + 86400 * 7
    const token = signToken({ sub: 'tok_123', role: 'admin', rfd }, JWT_SECRET, '0s')
    const payload = verifyForRefresh(token, JWT_SECRET)
    expect(payload.sub).toBe('tok_123')
  })

  it('verifyForRefresh rejects wrong signature', () => {
    const rfd = Math.floor(Date.now() / 1000) + 86400 * 7
    const token = signToken({ sub: 'tok_123', role: 'admin', rfd }, JWT_SECRET, '24h')
    expect(() => verifyForRefresh(token, 'wrong-secret')).toThrow()
  })

  it('includes scopes in payload', () => {
    const rfd = Math.floor(Date.now() / 1000) + 86400 * 7
    const token = signToken(
      { sub: 'tok_123', role: 'viewer', scopes: ['sessions:read'], rfd },
      JWT_SECRET,
      '24h',
    )
    const payload = verifyToken(token, JWT_SECRET)
    expect(payload.scopes).toEqual(['sessions:read'])
  })
})

