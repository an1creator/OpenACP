import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publishDirs = ['dist-publish', 'dist-publish-sdk'] as const

interface FileRecord { path: string; mode: number; size: number; sha256: string }
interface PackRecord { path: string; mode: number; size: number }

function filesBelow(directory: string, relative = ''): string[] {
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true })
    .flatMap((entry) => {
      const child = path.join(relative, entry.name)
      return entry.isDirectory() ? filesBelow(directory, child) : [child]
    })
    .sort()
}

function artifactManifest(directory: string): FileRecord[] {
  return filesBelow(directory).map((relative) => {
    const file = path.join(directory, relative)
    const stat = fs.statSync(file)
    return {
      path: relative.split(path.sep).join('/'),
      mode: stat.mode & 0o777,
      size: stat.size,
      sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    }
  })
}

function packManifest(directory: string): PackRecord[] {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', directory], {
    cwd: root,
    encoding: 'utf8',
  })
  const pack = JSON.parse(output) as Array<{ files: PackRecord[] }>
  return pack[0].files.map(({ path: file, mode, size }) => ({ path: file, mode, size }))
}

function assertPackAllowlist(name: typeof publishDirs[number], files: PackRecord[]): void {
  const allowedRoot = new Set(['package.json', 'README.md'])
  for (const file of files) {
    if (!allowedRoot.has(file.path) && !file.path.startsWith('dist/')) {
      throw new Error(`${name} pack contains unexpected file: ${file.path}`)
    }
    if (file.path.includes('/dist/dist/') || file.path.startsWith('dist/dist/')) {
      throw new Error(`${name} pack contains a nested stale dist directory: ${file.path}`)
    }
  }
}

function dirtyPublishRoots(marker: string): void {
  for (const name of publishDirs) {
    const directory = path.join(root, name)
    fs.mkdirSync(path.join(directory, 'dist', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(directory, `${marker}.stale`), marker)
    fs.writeFileSync(path.join(directory, 'dist', 'dist', `${marker}.stale`), marker)
  }
}

function build(): void {
  execFileSync('pnpm', ['build:publish'], { cwd: root, stdio: 'inherit' })
}

async function assertPackagedProxyContract(): Promise<void> {
  const cli = path.join(root, 'dist-publish', 'dist', 'cli.js')
  const workspace = fs.mkdtempSync(path.join(root, '.verify-proxy-help-'))
  const env = { ...process.env, HOME: workspace, OPENACP_HOME: workspace }
  try {
    const mainHelp = execFileSync(process.execPath, [cli, '--help'], {
      cwd: workspace, env, encoding: 'utf8',
    })
    const proxyHelp = execFileSync(process.execPath, [cli, '--dir', workspace, 'proxy', '--help'], {
      cwd: workspace, env, encoding: 'utf8',
    })
    const required = [
      'Proxy Management', 'openacp proxy status', 'openacp proxy create',
      'openacp proxy update', 'openacp proxy import', 'openacp proxy test-candidate',
      'openacp proxy set', 'openacp proxy clear', 'openacp proxy test --scope',
      'openacp proxy test --profile', 'openacp proxy delete', '0600', 'write-only',
      'Quick URL', 'proxyUrl',
    ]
    if (mainHelp.includes('Tunnels & Network:')) {
      throw new Error('Packaged top-level help still hides proxy management under tunnels')
    }
    for (const fragment of required) {
      if (!mainHelp.includes(fragment)) throw new Error(`Packaged top-level help is missing: ${fragment}`)
      if (!proxyHelp.includes(fragment)) throw new Error(`Packaged proxy help is missing: ${fragment}`)
    }
    const packagedReadme = fs.readFileSync(path.join(root, 'dist-publish', 'README.md'), 'utf8')
    for (const fragment of ['Quick URL', 'proxyUrl', 'mode-0600']) {
      if (!packagedReadme.includes(fragment)) throw new Error(`Packaged README is missing the protected Quick URL contract: ${fragment}`)
    }

    const insecure = path.join(workspace, 'insecure.json')
    const invalid = path.join(workspace, 'invalid.json')
    const missing = path.join(workspace, 'missing.json')
    fs.writeFileSync(insecure, '{}\n', { mode: 0o644 })
    fs.chmodSync(insecure, 0o644)
    fs.writeFileSync(invalid, '{not-json\n', { mode: 0o600 })
    fs.chmodSync(invalid, 0o600)

    const jsonCases = [
      { file: insecure, code: 'PROXY_INPUT_FILE_INSECURE' },
      { file: missing, code: 'PROXY_INPUT_FILE_NOT_FOUND' },
      { file: invalid, code: 'PROXY_INPUT_JSON_INVALID' },
    ]
    for (const testCase of jsonCases) {
      const result = spawnSync(process.execPath, [
        cli, '--dir', workspace, 'proxy', 'test-candidate', 'acceptance-crud',
        '--from-json', testCase.file, '--json',
      ], { cwd: workspace, env, encoding: 'utf8' })
      if (result.status !== 1) throw new Error(`Packaged proxy validation should exit 1 for ${testCase.code}`)
      let parsed: { success?: boolean; error?: { code?: string; message?: string } }
      try { parsed = JSON.parse(result.stdout) }
      catch { throw new Error(`Packaged proxy validation did not emit valid JSON for ${testCase.code}`) }
      if (parsed.success !== false || parsed.error?.code !== testCase.code || typeof parsed.error.message !== 'string') {
        throw new Error(`Packaged proxy validation returned the wrong envelope for ${testCase.code}`)
      }
      const combined = `${result.stdout}\n${result.stderr}`
      if (combined.includes(testCase.file) || combined.includes('Fatal:') || /\n\s*at\s/.test(combined)) {
        throw new Error(`Packaged proxy validation leaked a path or stack for ${testCase.code}`)
      }
    }

    const human = spawnSync(process.execPath, [
      cli, '--dir', workspace, 'proxy', 'test-candidate', 'acceptance-crud',
      '--from-json', insecure,
    ], { cwd: workspace, env, encoding: 'utf8' })
    if (human.status !== 1 || !human.stderr.startsWith('Proxy error: Proxy JSON input must be a mode-0600 regular file.')) {
      throw new Error('Packaged human proxy validation did not emit a concise error')
    }
    if (human.stderr.includes(insecure) || human.stderr.includes('Fatal:') || /\n\s*at\s/.test(human.stderr)) {
      throw new Error('Packaged human proxy validation leaked a path or stack')
    }

    const proxyUrl = 'http://artifact-user:artifact-secret@proxy.test:8080'
    const quick = path.join(workspace, 'quick-url.json')
    const mixed = path.join(workspace, 'mixed-url.json')
    fs.writeFileSync(quick, `${JSON.stringify({ name: 'Artifact Quick URL', proxyUrl, noProxy: ['localhost'], failClosed: true })}\n`, { mode: 0o600 })
    fs.writeFileSync(mixed, `${JSON.stringify({ proxyUrl, protocol: 'http', host: 'proxy.test', port: 8080 })}\n`, { mode: 0o600 })
    fs.chmodSync(quick, 0o600); fs.chmodSync(mixed, 0o600)

    // A valid Quick URL must cross the packaged CLI's local schema boundary and
    // fail only because this isolated verifier intentionally has no daemon.
    const accepted = spawnSync(process.execPath, [
      cli, '--dir', workspace, 'proxy', 'test-candidate', 'artifact-quick', '--from-json', quick, '--json',
    ], { cwd: workspace, env, encoding: 'utf8' })
    const acceptedOutput = `${accepted.stdout}\n${accepted.stderr}`
    if (accepted.status === 0 || acceptedOutput.includes('PROXY_INPUT_SCHEMA_INVALID')) {
      throw new Error('Packaged CLI did not accept the Quick URL profile shape before daemon lookup')
    }
    if (acceptedOutput.includes(proxyUrl) || acceptedOutput.includes('artifact-user') || acceptedOutput.includes('artifact-secret') || acceptedOutput.includes(quick)) {
      throw new Error('Packaged Quick URL validation leaked protected input')
    }

    const rejected = spawnSync(process.execPath, [
      cli, '--dir', workspace, 'proxy', 'test-candidate', 'artifact-mixed', '--from-json', mixed, '--json',
    ], { cwd: workspace, env, encoding: 'utf8' })
    const rejectedOutput = `${rejected.stdout}\n${rejected.stderr}`
    if (rejected.status !== 1 || !rejected.stdout.includes('PROXY_INPUT_SCHEMA_INVALID')) {
      throw new Error('Packaged CLI did not enforce proxyUrl XOR component fields')
    }
    if (rejectedOutput.includes(proxyUrl) || rejectedOutput.includes('artifact-user') || rejectedOutput.includes('artifact-secret') || rejectedOutput.includes(mixed)) {
      throw new Error('Packaged mixed Quick URL validation leaked protected input')
    }

    const bundledSource = fs.readFileSync(cli, 'utf8')
    if (!bundledSource.includes('proxyUrl is mutually exclusive with endpoint and credential fields')) {
      throw new Error('Packaged API/CLI bundle is missing the proxyUrl XOR schema contract')
    }
    const publicApi = await import(`${pathToFileURL(path.join(root, 'dist-publish', 'dist', 'index.js')).href}?verify=${Date.now()}`) as {
      ProxyService: new (instanceRoot: string) => {
        saveProfile(input: Record<string, unknown>): { hasCredentials: boolean }
        status(): unknown
      }
    }
    const serviceRoot = path.join(workspace, 'service')
    const service = new publicApi.ProxyService(serviceRoot)
    const profile = service.saveProfile({ id: 'artifact-quick', name: 'Artifact Quick URL', proxyUrl })
    const publicOutput = JSON.stringify({ profile, status: service.status() })
    if (!profile.hasCredentials || publicOutput.includes(proxyUrl) || publicOutput.includes('artifact-user') || publicOutput.includes('artifact-secret')) {
      throw new Error('Packaged ProxyService did not preserve Quick URL redaction')
    }
    try {
      service.saveProfile({ id: 'artifact-mixed', proxyUrl, protocol: 'http', host: 'proxy.test', port: 8080 })
      throw new Error('Packaged ProxyService accepted mixed proxyUrl/component fields')
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('mutually exclusive')) throw error
    }
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
}

dirtyPublishRoots('first')
build()
await assertPackagedProxyContract()
const firstArtifacts = Object.fromEntries(publishDirs.map((name) => [name, artifactManifest(path.join(root, name))]))
const firstPacks = Object.fromEntries(publishDirs.map((name) => {
  const manifest = packManifest(`./${name}`)
  assertPackAllowlist(name, manifest)
  return [name, manifest]
}))

dirtyPublishRoots('second')
build()
await assertPackagedProxyContract()
const secondArtifacts = Object.fromEntries(publishDirs.map((name) => [name, artifactManifest(path.join(root, name))]))
const secondPacks = Object.fromEntries(publishDirs.map((name) => {
  const manifest = packManifest(`./${name}`)
  assertPackAllowlist(name, manifest)
  return [name, manifest]
}))

if (JSON.stringify(firstArtifacts) !== JSON.stringify(secondArtifacts)) {
  throw new Error('Repeated publish builds produced different file/hash manifests')
}
if (JSON.stringify(firstPacks) !== JSON.stringify(secondPacks)) {
  throw new Error('Repeated publish builds produced different npm pack manifests')
}

console.log('✅ Publish builds are clean and deterministic; file hashes and npm pack manifests match')
