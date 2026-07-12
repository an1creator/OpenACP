import { readApiPort, apiCall } from '../api-client.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes } from '../output.js'
import { redactNetworkSecrets } from '../../core/security/network-redaction.js'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function help(): void {
  console.log(`
Proxy management (requires a running daemon):
  openacp proxy status
  openacp proxy import <id> --env-file <0600-file> [--name <label>]
  openacp proxy set <scope|global> <direct|inherit|profile:id>
  openacp proxy clear <scope>
  openacp proxy test --scope <scope> [--url <url>]
  openacp proxy test --profile <id> [--url <url>]
  openacp proxy delete <id>

Scopes use exact/category names such as channels.telegram, channels.default,
agents.codex, agents.default, services.npmUpdate, and plugins.default.
Credentials are imported from a mode-0600 env file and are never printed.
`)
}

/** Operational CLI for the daemon's redacted proxy API. */
export async function cmdProxy(args: string[], instanceRoot?: string, extractedName?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()
  const command = args[0] ?? 'status'
  if (command === 'help' || args.includes('--help') || args.includes('-h')) return help()
  const port = readApiPort(undefined, instanceRoot)
  if (port === null) {
    if (json) jsonError(ErrorCodes.DAEMON_NOT_RUNNING, 'OpenACP is not running.')
    throw new Error('OpenACP is not running. Start it before changing proxy settings.')
  }
  const call = (urlPath: string, init?: RequestInit) => apiCall(port, urlPath, init, instanceRoot)
  let response: Response
  if (command === 'status' || command === 'list' || command === 'routes') {
    response = await call('/api/v1/proxy')
  } else if (command === 'import') {
    const id = args[1]
    const envFile = option(args, '--env-file')
    if (!id || !envFile) throw new Error('Usage: openacp proxy import <id> --env-file <0600-file>')
    response = await call('/api/v1/proxy/profiles/import-env', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, envFile, name: option(args, '--name') ?? extractedName }),
    })
  } else if (command === 'set') {
    const scope = args[1]
    const route = args[2]
    if (!scope || !route) throw new Error('Usage: openacp proxy set <scope|global> <direct|inherit|profile:id>')
    response = await call(`/api/v1/proxy/routes/${encodeURIComponent(scope)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ route }),
    })
  } else if (command === 'clear') {
    const scope = args[1]
    if (!scope) throw new Error('Usage: openacp proxy clear <scope>')
    response = await call(`/api/v1/proxy/routes/${encodeURIComponent(scope)}`, { method: 'DELETE' })
  } else if (command === 'test') {
    const scope = option(args, '--scope')
    const profile = option(args, '--profile')
    if (Boolean(scope) === Boolean(profile)) throw new Error('Specify exactly one of --scope or --profile')
    response = await call('/api/v1/proxy/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, profile, targetUrl: option(args, '--url') }),
    })
  } else if (command === 'delete') {
    const id = args[1]
    if (!id) throw new Error('Usage: openacp proxy delete <id>')
    response = await call(`/api/v1/proxy/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } else {
    help()
    return
  }
  const data = await response.json() as Record<string, unknown>
  if (!response.ok) {
    const error = data.error as string | { code?: string; message?: string } | undefined
    const message = redactNetworkSecrets(
      typeof error === 'string' ? error : error?.message ?? `Proxy API failed (${response.status})`,
    )
    const apiCode = typeof error === 'object' && error?.code === 'PROXY_ROUTE_TEST_FAILED'
      ? ErrorCodes.PROXY_ROUTE_TEST_FAILED
      : ErrorCodes.PROXY_ERROR
    if (json) jsonError(apiCode, message)
    console.error(`Proxy error: ${message}`)
    process.exit(1)
  }
  if (command === 'test' && data.ok === false) {
    const message = redactNetworkSecrets(
      typeof data.error === 'string' ? data.error : 'Proxy connectivity test failed',
    )
    if (json) jsonError(ErrorCodes.PROXY_TEST_FAILED, message)
    console.error(`Proxy test failed: ${message}`)
    process.exit(1)
  }
  if (json) jsonSuccess(data)
  console.log(JSON.stringify(data, null, 2))
}
