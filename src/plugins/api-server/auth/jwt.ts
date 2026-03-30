import { createHmac, timingSafeEqual } from 'node:crypto'
import type { JwtPayload } from './types.js'

// Simple JWT implementation using Node.js crypto (no external dependency)
// Supports HS256 only — sufficient for local/self-hosted use case

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input
  return buf.toString('base64url')
}

function base64urlDecode(input: string): string {
  return Buffer.from(input, 'base64url').toString('utf-8')
}

export interface SignPayload {
  sub: string
  role: string
  scopes?: string[]
  rfd: number
}

function parseDurationToSeconds(expiresIn: string): number {
  const match = expiresIn.match(/^(\d+)(s|m|h|d)$/)
  if (!match) return 86400 // default 24h
  const value = parseInt(match[1], 10)
  switch (match[2]) {
    case 's': return value
    case 'm': return value * 60
    case 'h': return value * 3600
    case 'd': return value * 86400
    default: return 86400
  }
}

export function signToken(payload: SignPayload, secret: string, expiresIn: string): string {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + parseDurationToSeconds(expiresIn)

  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = base64url(JSON.stringify({
    ...payload,
    iat: now,
    exp,
  }))

  const signature = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')

  return `${header}.${body}.${signature}`
}

export function verifyToken(token: string, secret: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')

  const [header, body, signature] = parts

  // Verify signature
  const expectedSig = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')

  const sigBuf = Buffer.from(signature, 'base64url')
  const expectedBuf = Buffer.from(expectedSig, 'base64url')
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid JWT signature')
  }

  const payload = JSON.parse(base64urlDecode(body)) as JwtPayload

  // Check expiration
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp && payload.exp < now) {
    throw new Error('JWT expired')
  }

  return payload
}

export function verifyForRefresh(token: string, secret: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Invalid JWT format')

  const [header, body, signature] = parts

  // Verify signature only — ignore expiration
  const expectedSig = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url')

  const sigBuf = Buffer.from(signature, 'base64url')
  const expectedBuf = Buffer.from(expectedSig, 'base64url')
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid JWT signature')
  }

  return JSON.parse(base64urlDecode(body)) as JwtPayload
}
