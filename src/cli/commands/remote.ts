import { readApiPort, readApiSecret, apiCall } from '../api-client.js'
import qrcode from 'qrcode-terminal'

export async function cmdRemote(args: string[]): Promise<void> {
  // Parse flags
  const role = getFlag(args, '--role') ?? 'admin'
  const expire = getFlag(args, '--expire') ?? '24h'
  const scopes = getFlag(args, '--scopes')
  const name = getFlag(args, '--name')
  const noTunnel = args.includes('--no-tunnel')
  const noQr = args.includes('--no-qr')

  // 1. Check API server is running
  const port = readApiPort()
  if (port === null) {
    console.error('API server not running. Start with: openacp start')
    process.exit(1)
  }

  // Verify health
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/system/health`)
    if (!res.ok) throw new Error('Health check failed')
  } catch {
    console.error(`API server not responding on port ${port}`)
    process.exit(1)
  }

  // 2. Read secret token
  const secret = readApiSecret()
  if (!secret) {
    console.error('Cannot read API secret. Is the instance set up?')
    process.exit(1)
  }

  // 3. Generate name
  const now = new Date()
  const tokenName = name ?? formatTokenName(now)

  // 4. Generate JWT via API
  const body: Record<string, unknown> = { role, name: tokenName, expire }
  if (scopes) {
    body.scopes = scopes.split(',').map((s) => s.trim())
  }

  const tokenRes = await apiCall(port, '/api/v1/auth/tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.json() as any
    console.error('Failed to generate token:', err.error?.message ?? JSON.stringify(err))
    process.exit(1)
  }

  const tokenData = await tokenRes.json() as {
    accessToken: string
    tokenId: string
    expiresAt: string
    refreshDeadline: string
  }

  // 5. Tunnel handling
  let tunnelUrl: string | null = null
  if (!noTunnel) {
    tunnelUrl = await getTunnelUrl(port)
  }

  // 6. Generate links
  const localLink = `http://localhost:${port}?token=${tokenData.accessToken}`
  const tunnelLink = tunnelUrl ? `${tunnelUrl}?token=${tokenData.accessToken}` : null
  const tunnelHost = tunnelUrl ? new URL(tunnelUrl).host : null
  const appLink = tunnelHost
    ? `openacp://connect?host=${tunnelHost}&token=${tokenData.accessToken}`
    : `openacp://connect?host=localhost&port=${port}&token=${tokenData.accessToken}`

  // 7. Output
  console.log('')
  console.log('  OpenACP Remote Access')
  console.log('  ' + '─'.repeat(50))
  console.log(`  Token:   ${tokenName}`)
  console.log(`  Role:    ${role}`)
  console.log(`  Expires: ${formatDate(tokenData.expiresAt)} (${expire})`)
  console.log(`  Refresh: until ${formatDate(tokenData.refreshDeadline)} (7d)`)
  console.log('')
  console.log('  Local:')
  console.log(`  ${localLink}`)

  if (tunnelLink) {
    console.log('')
    console.log('  Tunnel:')
    console.log(`  ${tunnelLink}`)
  }

  console.log('')
  console.log('  App:')
  console.log(`  ${appLink}`)
  console.log('')

  // 8. QR code
  if (!noQr) {
    const qrLink = tunnelLink ?? localLink
    qrcode.generate(qrLink, { small: true }, (qr) => {
      console.log('  Scan QR code to connect:')
      // Indent each line of QR code
      for (const line of qr.split('\n')) {
        console.log(`  ${line}`)
      }
      console.log('')
    })
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx !== -1 && idx + 1 < args.length) {
    return args[idx + 1]
  }
  return undefined
}

function formatTokenName(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const yy = date.getFullYear()
  return `remote-${hh}h${mm}-${dd}-${mo}-${yy}`
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

async function getTunnelUrl(port: number): Promise<string | null> {
  try {
    const res = await apiCall(port, '/api/v1/system/health')
    if (!res.ok) return null

    const health = await res.json() as { tunnel?: { enabled: boolean; url?: string } }
    if (health.tunnel?.enabled && health.tunnel?.url) {
      return health.tunnel.url
    }

    // Try to start tunnel
    try {
      const tunnelRes = await apiCall(port, '/api/v1/tunnel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }) })
      if (tunnelRes.ok) {
        const data = await tunnelRes.json() as { publicUrl?: string }
        return data.publicUrl ?? null
      }
    } catch {
      // Tunnel start failed
    }

    return null
  } catch {
    return null
  }
}
