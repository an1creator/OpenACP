import { readApiPort, apiCall } from '../api-client.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes, type ErrorCode } from '../output.js'
import { redactNetworkSecrets } from '../../core/security/network-redaction.js'
import fs from 'node:fs'

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

export function printProxyHelp(): void {
  console.log(`
\x1b[1mProxy Management\x1b[0m — profiles and scoped network routes
\x1b[2mRequires a running OpenACP daemon. All commands support --json.\x1b[0m

\x1b[1mProfile Commands:\x1b[0m
  openacp proxy status
      List redacted profiles, routing, registered scopes, and diagnostics.
  openacp proxy create <id> --from-json <0600-file> [--expected-revision <n>]
      Create a profile; an existing ID returns PROXY_PROFILE_EXISTS.
  openacp proxy update <id> --from-json <0600-file> [--expected-revision <n>]
      Update a profile. JSON may set clearCredentials=true.
  openacp proxy import <id> --env-file <0600-file> [--name <label>] [--expected-revision <n>]
      Import HTTP(S)_PROXY, ALL_PROXY, and NO_PROXY from a protected env file.
  openacp proxy test-candidate <id> --from-json <0600-file>
      Test a complete profile in memory without saving it.
  openacp proxy test --profile <id> [--url <approved-https-url>]
      Test a saved profile.
  openacp proxy delete <id> [--reassign <direct|inherit|profile:id>] [--expected-revision <n>]
      Delete a profile; atomically reassign routes when the profile is in use.

\x1b[1mRouting Commands:\x1b[0m
  openacp proxy set <scope|global> <direct|inherit|profile:id> [--expected-revision <n>]
      Set an exact, category-default, or global route.
  openacp proxy clear <scope|global> [--expected-revision <n>]
      Clear an override (global resets to inherit).
  openacp proxy test --scope <scope> [--url <approved-https-url>]
      Test the effective route for a registered scope.

Scopes use exact/category names such as channels.telegram, channels.default,
agents.codex, agents.default, services.npmUpdate, and plugins.default.
JSON/env input paths must be mode-0600 regular files. Put username/password only
inside those files, never in command arguments. Credentials are write-only and
never printed by status, command output, diagnostics, or errors.
Quick URL profile JSON may use either protocol/host/port fields or one write-only proxyUrl;
the forms are mutually exclusive and proxyUrl must include an explicit port.
`)
}

class ProxyCliInputError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'ProxyCliInputError'
  }
}

function validateProtectedFile(file: string, label: 'JSON' | 'env'): void {
  let stat: fs.Stats
  try { stat = fs.statSync(file) }
  catch {
    throw new ProxyCliInputError(
      ErrorCodes.PROXY_INPUT_FILE_NOT_FOUND,
      `Proxy ${label} input file was not found or could not be read.`,
    )
  }
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
    throw new ProxyCliInputError(
      ErrorCodes.PROXY_INPUT_FILE_INSECURE,
      `Proxy ${label} input must be a mode-0600 regular file.`,
    )
  }
}

function protectedJson(file: string): Record<string, unknown> {
  validateProtectedFile(file, 'JSON')
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown }
  catch {
    throw new ProxyCliInputError(
      ErrorCodes.PROXY_INPUT_JSON_INVALID,
      'Proxy JSON input is not valid JSON.',
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProxyCliInputError(
      ErrorCodes.PROXY_INPUT_SCHEMA_INVALID,
      'Proxy JSON input must contain one profile object.',
    )
  }
  return value as Record<string, unknown>
}

function validateProfileInput(input: Record<string, unknown>): void {
  const invalid: string[] = []
  const hasProxyUrl = input.proxyUrl !== undefined
  const componentsPresent = ['protocol', 'host', 'port', 'username', 'password', 'clearCredentials'].some((key) => input[key] !== undefined)
  if (hasProxyUrl) {
    if (typeof input.proxyUrl !== 'string' || !input.proxyUrl || componentsPresent) invalid.push('proxyUrl')
  } else {
    if (!['http', 'https', 'socks5', 'socks5h'].includes(String(input.protocol ?? ''))) invalid.push('protocol')
    if (typeof input.host !== 'string' || !input.host) invalid.push('host')
    if (!Number.isInteger(input.port) || Number(input.port) < 1 || Number(input.port) > 65535) invalid.push('port')
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100)) invalid.push('name')
  if (input.username !== undefined && typeof input.username !== 'string') invalid.push('username')
  if (input.password !== undefined && typeof input.password !== 'string') invalid.push('password')
  if (input.noProxy !== undefined && (!Array.isArray(input.noProxy) || input.noProxy.some((item) => typeof item !== 'string'))) invalid.push('noProxy')
  if (input.failClosed !== undefined && typeof input.failClosed !== 'boolean') invalid.push('failClosed')
  if (input.clearCredentials !== undefined && typeof input.clearCredentials !== 'boolean') invalid.push('clearCredentials')
  if (invalid.length) {
    throw new ProxyCliInputError(
      ErrorCodes.PROXY_INPUT_SCHEMA_INVALID,
      `Proxy JSON profile has invalid or missing fields: ${[...new Set(invalid)].join(', ')}.`,
    )
  }
}

function requireArgument(value: string | undefined, usage: string): string {
  if (value && !value.startsWith('--')) return value
  throw new ProxyCliInputError(ErrorCodes.PROXY_MISSING_ARGUMENT, usage)
}

function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new ProxyCliInputError(ErrorCodes.PROXY_INVALID_ARGUMENT, 'Proxy profile ID is invalid.')
  }
}

function validateRoute(route: string): void {
  if (route !== 'direct' && route !== 'inherit' && !/^profile:[a-z0-9][a-z0-9._-]{0,63}$/i.test(route)) {
    throw new ProxyCliInputError(ErrorCodes.PROXY_INVALID_ARGUMENT, 'Proxy route must be direct, inherit, or profile:<id>.')
  }
}

function emitProxyInputError(error: ProxyCliInputError, json: boolean): never {
  const message = redactNetworkSecrets(error.message)
  if (json) jsonError(error.code, message)
  console.error(`Proxy error: ${message}`)
  process.exit(1)
}

function expectedRevision(args: string[]): number | undefined {
  const raw = option(args, '--expected-revision')
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProxyCliInputError(ErrorCodes.PROXY_INVALID_ARGUMENT, '--expected-revision must be a non-negative integer.')
  }
  return value
}

function proxyErrorCode(code: string | undefined): typeof ErrorCodes[keyof typeof ErrorCodes] {
  const known = new Set<string>([
    ErrorCodes.PROXY_ROUTE_TEST_FAILED, ErrorCodes.PROXY_PROFILE_TEST_FAILED,
    ErrorCodes.PROXY_REVISION_CONFLICT, ErrorCodes.PROXY_PROFILE_EXISTS,
    ErrorCodes.PROXY_PROFILE_NOT_FOUND, ErrorCodes.PROXY_PROFILE_IN_USE,
    ErrorCodes.PROXY_VALIDATION_ERROR,
  ])
  return code && known.has(code)
    ? code as typeof ErrorCodes[keyof typeof ErrorCodes]
    : ErrorCodes.PROXY_ERROR
}

/** Operational CLI for the daemon's redacted proxy API. */
export async function cmdProxy(args: string[], instanceRoot?: string, extractedName?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()
  const command = args[0] ?? 'status'
  if (command === 'help' || args.includes('--help') || args.includes('-h')) return printProxyHelp()
  let preparedInput: Record<string, unknown> | undefined
  try {
    if (command === 'import') {
      const id = requireArgument(args[1], 'Usage: openacp proxy import <id> --env-file <0600-file>')
      validateId(id)
      const envFile = requireArgument(option(args, '--env-file'), 'Usage: openacp proxy import <id> --env-file <0600-file>')
      validateProtectedFile(envFile, 'env')
      expectedRevision(args)
    } else if (command === 'create' || command === 'update' || command === 'test-candidate') {
      const id = requireArgument(args[1], `Usage: openacp proxy ${command} <id> --from-json <0600-file>`)
      validateId(id)
      const file = requireArgument(option(args, '--from-json'), `Usage: openacp proxy ${command} <id> --from-json <0600-file>`)
      preparedInput = protectedJson(file)
      validateProfileInput(preparedInput)
      if (preparedInput.id !== undefined && preparedInput.id !== id) {
        throw new ProxyCliInputError(ErrorCodes.PROXY_INPUT_SCHEMA_INVALID, 'Profile ID in JSON does not match the command argument.')
      }
      if (command !== 'test-candidate') expectedRevision(args)
    } else if (command === 'set') {
      requireArgument(args[1], 'Usage: openacp proxy set <scope|global> <direct|inherit|profile:id>')
      const route = requireArgument(args[2], 'Usage: openacp proxy set <scope|global> <direct|inherit|profile:id>')
      validateRoute(route)
      expectedRevision(args)
    } else if (command === 'clear') {
      requireArgument(args[1], 'Usage: openacp proxy clear <scope|global>')
      expectedRevision(args)
    } else if (command === 'test') {
      const scope = option(args, '--scope')
      const profile = option(args, '--profile')
      if (Boolean(scope) === Boolean(profile)) {
        throw new ProxyCliInputError(ErrorCodes.PROXY_INVALID_ARGUMENT, 'Specify exactly one of --scope or --profile.')
      }
      const targetUrl = option(args, '--url')
      if (targetUrl) {
        try { new URL(targetUrl) }
        catch { throw new ProxyCliInputError(ErrorCodes.PROXY_INVALID_ARGUMENT, '--url must be a valid URL.') }
      }
    } else if (command === 'delete') {
      const id = requireArgument(args[1], 'Usage: openacp proxy delete <id>')
      validateId(id)
      const reassign = option(args, '--reassign')
      if (reassign) validateRoute(reassign)
      expectedRevision(args)
    }
  } catch (error) {
    if (error instanceof ProxyCliInputError) emitProxyInputError(error, json)
    throw error
  }
  const port = readApiPort(undefined, instanceRoot)
  if (port === null) {
    emitProxyInputError(new ProxyCliInputError(
      ErrorCodes.DAEMON_NOT_RUNNING,
      'OpenACP is not running. Start it before changing proxy settings.',
    ), json)
  }
  const call = (urlPath: string, init?: RequestInit) => apiCall(port, urlPath, init, instanceRoot)
  let response: Response
  if (command === 'status' || command === 'list' || command === 'routes') {
    response = await call('/api/v1/proxy')
  } else if (command === 'import') {
    const id = args[1]!
    const envFile = option(args, '--env-file')!
    response = await call('/api/v1/proxy/profiles/import-env', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, envFile, name: option(args, '--name') ?? extractedName, expectedRevision: expectedRevision(args) }),
    })
  } else if (command === 'create' || command === 'update' || command === 'test-candidate') {
    const id = args[1]!
    const input = preparedInput!
    const body: Record<string, unknown> = { ...input, id, expectedRevision: expectedRevision(args) }
    const url = command === 'create'
      ? '/api/v1/proxy/profiles'
      : command === 'update'
        ? `/api/v1/proxy/profiles/${encodeURIComponent(id)}`
        : '/api/v1/proxy/profiles/test-candidate'
    if (command === 'update') delete body.id
    if (command === 'test-candidate') delete body.expectedRevision
    response = await call(url, {
      method: command === 'update' ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } else if (command === 'set') {
    const scope = args[1]!
    const route = args[2]!
    response = await call(`/api/v1/proxy/routes/${encodeURIComponent(scope)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ route, expectedRevision: expectedRevision(args) }),
    })
  } else if (command === 'clear') {
    const scope = args[1]!
    const revision = expectedRevision(args)
    response = await call(`/api/v1/proxy/routes/${encodeURIComponent(scope)}${revision === undefined ? '' : `?expectedRevision=${revision}`}`, { method: 'DELETE' })
  } else if (command === 'test') {
    const scope = option(args, '--scope')
    const profile = option(args, '--profile')
    response = await call('/api/v1/proxy/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, profile, targetUrl: option(args, '--url') }),
    })
  } else if (command === 'delete') {
    const id = args[1]!
    const query = new URLSearchParams()
    const reassign = option(args, '--reassign')
    const revision = expectedRevision(args)
    if (reassign) query.set('reassign', reassign)
    if (revision !== undefined) query.set('expectedRevision', String(revision))
    response = await call(`/api/v1/proxy/profiles/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`, { method: 'DELETE' })
  } else {
    printProxyHelp()
    return
  }
  const data = await response.json() as Record<string, unknown>
  if (!response.ok) {
    const error = data.error as string | { code?: string; message?: string } | undefined
    const message = redactNetworkSecrets(
      typeof error === 'string' ? error : error?.message ?? `Proxy API failed (${response.status})`,
    )
    const apiCode = proxyErrorCode(typeof error === 'object' ? error?.code : undefined)
    if (json) jsonError(apiCode, message)
    console.error(`Proxy error: ${message}`)
    process.exit(1)
  }
  if ((command === 'test' || command === 'test-candidate') && data.ok === false) {
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
