export interface StoredToken {
  id: string              // tok_<random>
  name: string            // "remote-14h30-31-03-2026"
  role: string            // admin | operator | viewer
  scopes?: string[]       // optional scope override
  createdAt: string       // ISO 8601
  refreshDeadline: string // ISO 8601, 7 days from createdAt
  lastUsedAt?: string     // ISO 8601
  revoked: boolean
}

export interface JwtPayload {
  sub: string             // tokenId
  role: string
  scopes?: string[]
  iat: number
  exp: number
  rfd: number             // refresh deadline timestamp
}

export interface CreateTokenOpts {
  role: string
  name: string
  expire: string          // "24h", "7d", "30d"
  scopes?: string[]
}

export interface TokenInfo {
  tokenId: string
  accessToken: string
  expiresAt: string
  refreshDeadline: string
}
