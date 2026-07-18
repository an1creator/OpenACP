import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { runProjectPnpm } from './project-pnpm.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publishDirs = ['dist-publish', 'dist-publish-sdk'] as const
const releaseArtifactsDir = path.join(root, 'release-artifacts')

interface FileRecord { path: string; mode: number; size: number; sha256: string }
interface PackRecord { path: string; mode: number; size: number }
interface PackedArtifact {
  name: string
  version: string
  filename: string
  size: number
  unpackedSize: number
  shasum: string
  integrity: string
  entryCount: number
  files: PackRecord[]
  sha256: string
  tarball: string
}

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
  const parsed = JSON.parse(output) as Array<{ files: PackRecord[] }> | Record<string, { files: PackRecord[] }>
  const pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (!pack?.files) throw new Error(`npm pack returned no file manifest for ${directory}`)
  return pack.files
    .map(({ path: file, mode, size }) => ({ path: file, mode, size }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

function tarString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length)
  const terminator = field.indexOf(0)
  return field.subarray(0, terminator === -1 ? field.length : terminator).toString('utf8')
}

function tarOctal(header: Buffer, offset: number, length: number): number {
  const raw = tarString(header, offset, length).trim()
  if (!/^[0-7]+$/.test(raw)) throw new Error(`Invalid tar octal field: ${JSON.stringify(raw)}`)
  return Number.parseInt(raw, 8)
}

function tarManifest(content: Buffer): PackRecord[] {
  const archive = gunzipSync(content)
  const files: PackRecord[] = []
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = tarString(header, 0, 100)
    const prefix = tarString(header, 345, 155)
    const archivedPath = prefix ? `${prefix}/${name}` : name
    const size = tarOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] || 48)
    if (type === '0') {
      if (!archivedPath.startsWith('package/')) {
        throw new Error(`npm tarball contains a file outside package/: ${archivedPath}`)
      }
      files.push({
        path: archivedPath.slice('package/'.length),
        mode: tarOctal(header, 100, 8) & 0o777,
        size,
      })
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function assertCanonicalPackModes(source: typeof publishDirs[number], files: PackRecord[]): void {
  const executablePaths = source === 'dist-publish'
    ? new Set(['dist/cli.js', 'dist/speech/transcribe_audio.sh'])
    : new Set<string>()
  for (const file of files) {
    const expected = executablePaths.has(file.path) ? 0o755 : 0o644
    if (file.mode !== expected) {
      throw new Error(`${source} tar header has mode ${file.mode.toString(8)} for ${file.path}; expected ${expected.toString(8)}`)
    }
  }
}

function packArtifact(source: typeof publishDirs[number], destination: string): PackedArtifact {
  fs.mkdirSync(destination, { recursive: true })
  const directory = `./${source}`
  const output = execFileSync('npm', [
    'pack', '--json', '--pack-destination', destination, directory,
  ], { cwd: root, encoding: 'utf8' })
  const parsed = JSON.parse(output) as Array<Omit<PackedArtifact, 'sha256' | 'tarball'>>
    | Record<string, Omit<PackedArtifact, 'sha256' | 'tarball'>>
  const packs = Array.isArray(parsed) ? parsed : Object.values(parsed)
  if (packs.length !== 1) throw new Error(`npm pack returned ${packs.length} records for ${directory}`)
  const pack = packs[0]
  if (!pack?.filename || !pack.files) throw new Error(`npm pack produced no artifact for ${directory}`)
  const manifest = JSON.parse(fs.readFileSync(path.join(root, source, 'package.json'), 'utf8')) as {
    name?: string
    version?: string
  }
  if (pack.name !== manifest.name || pack.version !== manifest.version) {
    throw new Error(`npm pack returned the wrong package identity for ${directory}`)
  }
  const expectedFilename = `${manifest.name?.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`
  if (pack.filename !== expectedFilename || path.basename(pack.filename) !== pack.filename
    || path.isAbsolute(pack.filename) || /[\\/]/.test(pack.filename)) {
    throw new Error(`npm pack returned an unsafe or unexpected filename for ${directory}`)
  }
  const resolvedDestination = path.resolve(destination)
  const tarball = path.resolve(resolvedDestination, pack.filename)
  if (path.dirname(tarball) !== resolvedDestination) {
    throw new Error(`npm pack artifact escaped its destination for ${directory}`)
  }
  const content = fs.readFileSync(tarball)
  const files = pack.files
    .map(({ path: file, mode, size }) => ({ path: file, mode, size }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const archivedFiles = tarManifest(content)
  if (JSON.stringify(files) !== JSON.stringify(archivedFiles)) {
    throw new Error(`${source} npm JSON manifest differs from its actual tar headers`)
  }
  assertCanonicalPackModes(source, archivedFiles)
  return {
    name: pack.name,
    version: pack.version,
    filename: pack.filename,
    size: pack.size,
    unpackedSize: pack.unpackedSize,
    shasum: pack.shasum,
    integrity: pack.integrity,
    entryCount: pack.entryCount,
    files,
    sha256: createHash('sha256').update(content).digest('hex'),
    tarball,
  }
}

function comparablePack(pack: PackedArtifact): Omit<PackedArtifact, 'tarball'> {
  const { tarball: _tarball, ...comparable } = pack
  return comparable
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

function assertPackagedSpeechRuntime(files: PackRecord[]): void {
  const source = path.join(root, 'src', 'plugins', 'speech', 'scripts', 'transcribe_audio.sh')
  const packaged = path.join(root, 'dist-publish', 'dist', 'speech', 'transcribe_audio.sh')
  if (!fs.existsSync(packaged)) throw new Error('Packaged local Whisper runtime is missing')
  if (!fs.readFileSync(source).equals(fs.readFileSync(packaged))) {
    throw new Error('Packaged local Whisper runtime differs byte-for-byte from source')
  }
  if ((fs.statSync(packaged).mode & 0o111) === 0) {
    throw new Error('Packaged local Whisper runtime is not executable')
  }
  const packedRuntime = files.find((file) => file.path === 'dist/speech/transcribe_audio.sh')
  if (!packedRuntime) throw new Error('npm pack omits the local Whisper runtime')
  if ((packedRuntime.mode & 0o111) === 0) {
    throw new Error('npm pack strips the local Whisper runtime executable mode')
  }
}

function assertPackagedRegistrySnapshot(): void {
  const sourcePath = path.join(root, 'src', 'data', 'registry-snapshot.json')
  const packagedPath = path.join(root, 'dist-publish', 'dist', 'data', 'registry-snapshot.json')
  const source = fs.readFileSync(sourcePath)
  const packaged = fs.readFileSync(packagedPath)
  if (!source.equals(packaged)) {
    throw new Error('Packaged ACP registry snapshot differs byte-for-byte from source')
  }
  const sourceHash = createHash('sha256').update(source).digest('hex')
  // Pin the manually reviewed time-of-commit snapshot. Build and verification
  // deliberately do not query the live registry, which may drift after CI.
  if (sourceHash !== '11850b8fef1032661534c3f611e9793f7af5e0f2b4cf856a72eca0394f48702b') {
    throw new Error('ACP registry snapshot differs from the reviewed time-of-commit official release snapshot')
  }

  const registry = JSON.parse(source.toString('utf8')) as {
    agents?: Array<{
      id?: string
      version?: string
      distribution?: {
        npx?: { package?: string }
        binary?: Record<string, { archive?: string; cmd?: string; args?: string[]; sha256?: string }>
      }
    }>
  }
  if (!Array.isArray(registry.agents) || registry.agents.length !== 38) {
    throw new Error('ACP registry snapshot must contain the reviewed 38-agent release set')
  }
  const expected = new Map([
    ['auggie', ['0.33.0', '@augmentcode/auggie@0.33.0']],
    ['codex-acp', ['1.1.4', '@agentclientprotocol/codex-acp@1.1.4']],
    ['grok-build', ['0.2.104', '@xai-official/grok@0.2.104']],
    ['factory-droid', ['0.175.0', 'droid@0.175.0']],
  ])
  for (const [id, [version, packageName]] of expected) {
    const agent = registry.agents.find((candidate) => candidate.id === id)
    if (agent?.version !== version || agent.distribution?.npx?.package !== packageName) {
      throw new Error(`ACP registry snapshot has unexpected ${id} release metadata`)
    }
  }

  const harn = registry.agents.find((candidate) => candidate.id === 'harn')
  const expectedHarnTargets = new Map([
    ['darwin-aarch64', ['https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-aarch64-apple-darwin.tar.gz', './harn', 'fccf097942c678aba14325f7fbfe06ccd08b41de7229ed987f4837b14d640cbb']],
    ['darwin-x86_64', ['https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-x86_64-apple-darwin.tar.gz', './harn', 'c871cb53064f0f5962068572dae37a679ad6765f6f74042a52473da24f585f32']],
    ['linux-aarch64', ['https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-aarch64-unknown-linux-gnu.tar.gz', './harn', 'a7bc1cdf1447105105d975aa1d0442bbed9e48b4df8a394dc23fda835abef149']],
    ['linux-x86_64', ['https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-x86_64-unknown-linux-gnu.tar.gz', './harn', 'a3c5d9ab75b154a846e6962a84b0acd8cd056890d8d5b40d2cd5f7f50d11bc87']],
    ['windows-x86_64', ['https://github.com/burin-labs/harn/releases/download/v0.10.23/harn-x86_64-pc-windows-msvc.zip', 'harn.exe', '05eea0438b8c619258cef7fd3ccf644bfe09d8b5cbf323c45f3addaaf8e6bcb8']],
  ])
  if (harn?.version !== '0.10.23') {
    throw new Error('ACP registry snapshot has unexpected harn release metadata')
  }
  for (const [platform, [archive, cmd, sha256]] of expectedHarnTargets) {
    const target = harn.distribution?.binary?.[platform]
    if (target?.archive !== archive || target.cmd !== cmd || target.sha256 !== sha256
      || JSON.stringify(target.args) !== '["serve","acp"]') {
      throw new Error(`ACP registry snapshot has unexpected harn ${platform} release metadata`)
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
  const rootDist = path.join(root, 'dist')
  fs.mkdirSync(rootDist, { recursive: true })
  fs.writeFileSync(path.join(rootDist, `${marker}.stale.d.ts`), `export type ${marker}Stale = true\n`)
}

function assertRootTypesWereRebuilt(): void {
  for (const marker of ['first', 'second']) {
    if (fs.existsSync(path.join(root, 'dist', `${marker}.stale.d.ts`))) {
      throw new Error(`Publish build retained stale root declarations from ${marker}`)
    }
  }
}

function build(): void {
  runProjectPnpm(root, ['build:publish'])
}

function assertPublishedSpeechContract(): void {
  runProjectPnpm(root, [
    'exec',
    'tsc',
    '--project',
    'scripts/type-tests/tsconfig.published-speech-plugin.json',
  ])
}

function assertPublishedNodePolicy(): void {
  for (const name of publishDirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, name, 'package.json'), 'utf8')) as {
      engines?: { node?: string }
    }
    if (manifest.engines?.node !== '>=22') {
      throw new Error(`${name} must publish with engines.node >=22`)
    }
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error(`${label} has unexpected fields`)
}

function assertPluginCatalog(value: unknown): asserts value is { pluginCount: number; plugins: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Plugin catalog root is invalid')
  const catalog = value as Record<string, unknown>
  exactKeys(catalog, ['version', 'generatedAt', 'pluginCount', 'plugins', 'categories'], 'Plugin catalog')
  if (!Number.isInteger(catalog.version) || Number(catalog.version) < 1 || typeof catalog.generatedAt !== 'string'
    || !Number.isInteger(catalog.pluginCount) || Number(catalog.pluginCount) < 0
    || !Array.isArray(catalog.plugins) || !Array.isArray(catalog.categories)
    || catalog.pluginCount !== catalog.plugins.length) throw new Error('Plugin catalog schema is invalid')
  for (const [index, raw] of catalog.plugins.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Plugin catalog entry ${index} is invalid`)
    const plugin = raw as Record<string, unknown>
    exactKeys(plugin, ['name', 'displayName', 'description', 'npm', 'version', 'minCliVersion', 'category', 'tags', 'icon', 'author', 'repository', 'license', 'verified', 'featured'].filter((key) => key !== 'displayName' || key in plugin), `Plugin catalog entry ${index}`)
    for (const key of ['name', 'description', 'npm', 'version', 'minCliVersion', 'category', 'icon', 'author', 'repository', 'license']) if (typeof plugin[key] !== 'string') throw new Error(`Plugin catalog entry ${index}.${key} is invalid`)
    if (!Array.isArray(plugin.tags) || plugin.tags.some((tag) => typeof tag !== 'string') || typeof plugin.verified !== 'boolean' || typeof plugin.featured !== 'boolean') throw new Error(`Plugin catalog entry ${index} types are invalid`)
  }
  for (const [index, raw] of catalog.categories.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Plugin catalog category ${index} is invalid`)
    const category = raw as Record<string, unknown>
    exactKeys(category, ['id', 'name', 'icon'], `Plugin catalog category ${index}`)
    if (Object.values(category).some((item) => typeof item !== 'string')) throw new Error(`Plugin catalog category ${index} types are invalid`)
  }
}

function assertRetiredSurfaceAbsent(): void {
  const bad = /raw\.githubusercontent\.com\/Open-ACP\/plugin-registry|github\.com\/Open-ACP\/plugin-registry|\btwitter\.com\b|\bx\.com\b|openacp_ai|follow us on|social badge/i
  for (const publishRoot of publishDirs) {
    for (const relative of filesBelow(path.join(root, publishRoot))) {
      if (!/\.(?:js|map|d\.ts|md|json)$/.test(relative)) continue
      const content = fs.readFileSync(path.join(root, publishRoot, relative), 'utf8')
      if (bad.test(content)) throw new Error(`Packaged textual surface contains a retired registry/social reference: ${publishRoot}/${relative}`)
    }
  }
}

async function assertPackagedProxyContract(): Promise<void> {
  const cli = path.join(root, 'dist-publish', 'dist', 'cli.js')
  const packagedReadme = fs.readFileSync(path.join(root, 'dist-publish', 'README.md'), 'utf8')
  if (packagedReadme !== fs.readFileSync(path.join(root, 'README.md'), 'utf8')) throw new Error('Packaged README differs from source')
  if (/\b(?:twitter\.com|x\.com)\b|follow us|social badge/i.test(packagedReadme)) {
    throw new Error('Packaged README contains a retired Twitter/X or social-follow claim')
  }
  const sourceCatalog = fs.readFileSync(path.join(root, 'src', 'data', 'plugin-catalog.json'))
  const packagedCatalog = fs.readFileSync(path.join(root, 'dist-publish', 'dist', 'data', 'plugin-catalog.json'))
  if (!sourceCatalog.equals(packagedCatalog)) throw new Error('Packaged plugin catalog differs byte-for-byte from source')
  assertPluginCatalog(JSON.parse(packagedCatalog.toString('utf8')))
  if (createHash('sha256').update(sourceCatalog).digest('hex') !== createHash('sha256').update(packagedCatalog).digest('hex')) throw new Error('Packaged plugin catalog SHA-256 mismatch')
  assertRetiredSurfaceAbsent()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-verify-proxy-help-'))
  const env = { ...process.env, HOME: workspace, OPENACP_HOME: workspace }
  try {
    const mainHelp = execFileSync(process.execPath, [cli, '--help'], {
      cwd: workspace, env, encoding: 'utf8',
    })
    const proxyHelp = execFileSync(process.execPath, [cli, '--dir', workspace, 'proxy', '--help'], {
      cwd: workspace, env, encoding: 'utf8',
    })
    const normalizeHelp = (value: string): string => value
      .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    const normalizedMainHelp = normalizeHelp(mainHelp)
    const normalizedProxyHelp = normalizeHelp(proxyHelp)
    const proxyCommands = [
      'openacp proxy status', 'openacp proxy create',
      'openacp proxy update', 'openacp proxy import', 'openacp proxy test-candidate',
      'openacp proxy set', 'openacp proxy clear', 'openacp proxy test --scope',
      'openacp proxy test --profile', 'openacp proxy delete',
    ]
    const topLevelRequired = [
      'Network proxy', ...proxyCommands, 'regular files with mode 0600',
      'Credentials are hidden', 'status, command output, diagnostics, and errors never print them',
      'write-only proxyUrl',
      'mutually exclusive',
    ]
    const proxyHelpRequired = [
      'Network proxy', 'Proxy profiles', 'Traffic routes', ...proxyCommands,
      '"inherit" means use host proxy settings',
      'Remove a saved override so the scope uses its category/global parent',
      'mode-0600 regular files', 'never in command arguments',
      'Credentials are write-only', 'never printed by status',
      'Quick URL', 'proxyUrl', 'mutually exclusive', 'explicit port',
    ]
    if (normalizedMainHelp.includes('Tunnels & Network:')) {
      throw new Error('Packaged top-level help still hides proxy management under tunnels')
    }
    for (const fragment of topLevelRequired) {
      if (!normalizedMainHelp.includes(fragment)) throw new Error(`Packaged top-level help is missing: ${fragment}`)
    }
    for (const fragment of proxyHelpRequired) {
      if (!normalizedProxyHelp.includes(fragment)) throw new Error(`Packaged proxy help is missing: ${fragment}`)
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

fs.rmSync(releaseArtifactsDir, { recursive: true, force: true })
const firstPackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openacp-first-pack-'))
const stagingArtifactsDir = fs.mkdtempSync(path.join(
  path.dirname(root),
  `.${path.basename(root)}-release-artifacts-staging-`,
))
let publishedVerifiedArtifacts = false

try {
  dirtyPublishRoots('first')
  build()
  assertRootTypesWereRebuilt()
  assertPublishedNodePolicy()
  assertPublishedSpeechContract()
  assertPackagedRegistrySnapshot()
  await assertPackagedProxyContract()
  const firstArtifacts = Object.fromEntries(publishDirs.map((name) => [name, artifactManifest(path.join(root, name))]))
  const firstPacks = Object.fromEntries(publishDirs.map((name) => {
    const manifest = packManifest(`./${name}`)
    assertPackAllowlist(name, manifest)
    if (name === 'dist-publish') assertPackagedSpeechRuntime(manifest)
    return [name, manifest]
  }))
  const firstTarballs = Object.fromEntries(publishDirs.map((name) => [
    name,
    packArtifact(name, firstPackDir),
  ])) as Record<typeof publishDirs[number], PackedArtifact>

  dirtyPublishRoots('second')
  build()
  assertRootTypesWereRebuilt()
  assertPublishedNodePolicy()
  assertPublishedSpeechContract()
  assertPackagedRegistrySnapshot()
  await assertPackagedProxyContract()
  const secondArtifacts = Object.fromEntries(publishDirs.map((name) => [name, artifactManifest(path.join(root, name))]))
  const secondPacks = Object.fromEntries(publishDirs.map((name) => {
    const manifest = packManifest(`./${name}`)
    assertPackAllowlist(name, manifest)
    if (name === 'dist-publish') assertPackagedSpeechRuntime(manifest)
    return [name, manifest]
  }))
  const releaseTarballs = {} as Record<typeof publishDirs[number], PackedArtifact>
  for (const name of publishDirs) {
    releaseTarballs[name] = packArtifact(name, stagingArtifactsDir)
    if (name === publishDirs[0]
      && process.env.OPENACP_VERIFY_PUBLISH_FAIL_AFTER_FIRST_RELEASE_PACK === '1') {
      throw new Error('Injected publish verification failure after the first staged release pack')
    }
  }

  if (JSON.stringify(firstArtifacts) !== JSON.stringify(secondArtifacts)) {
    throw new Error('Repeated publish builds produced different file/hash manifests')
  }
  if (JSON.stringify(firstPacks) !== JSON.stringify(secondPacks)) {
    throw new Error('Repeated publish builds produced different npm pack manifests')
  }

  for (const name of publishDirs) {
    const firstTarball = firstTarballs[name]
    const releaseTarball = releaseTarballs[name]
    if (JSON.stringify(firstPacks[name]) !== JSON.stringify(releaseTarball.files)) {
      throw new Error(`${name} verified dry-run manifest differs from the release tarball manifest`)
    }
    if (JSON.stringify(comparablePack(firstTarball)) !== JSON.stringify(comparablePack(releaseTarball))) {
      throw new Error(`${name} repeated builds produced different npm tarball metadata`)
    }
    if (!fs.readFileSync(firstTarball.tarball).equals(fs.readFileSync(releaseTarball.tarball))) {
      throw new Error(`${name} repeated builds produced different npm tarball bytes`)
    }
  }

  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version as string
  const npmVersion = execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim()
  const releaseManifest = {
    schemaVersion: 1,
    version,
    npmVersion,
    packages: publishDirs.map((source) => {
      const { tarball: _tarball, files: _files, ...artifact } = releaseTarballs[source]
      return { source, ...artifact }
    }),
  }
  fs.writeFileSync(
    path.join(stagingArtifactsDir, 'manifest.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
  )
  fs.renameSync(stagingArtifactsDir, releaseArtifactsDir)
  publishedVerifiedArtifacts = true

  console.log(`✅ Publish builds and npm tarballs are clean, deterministic, and verified`)
  console.log(`Verified release artifacts: ${path.relative(root, releaseArtifactsDir)}/`)
} finally {
  fs.rmSync(firstPackDir, { recursive: true, force: true })
  fs.rmSync(stagingArtifactsDir, { recursive: true, force: true })
  if (!publishedVerifiedArtifacts) {
    fs.rmSync(releaseArtifactsDir, { recursive: true, force: true })
  }
}
