import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProjectPnpm } from './project-pnpm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const cliPublishDir = path.join(root, 'dist-publish')
const sdkPublishDir = path.join(root, 'dist-publish-sdk')

function normalizePublishTree(directory: string, executablePaths: Set<string>): void {
  const visit = (relative: string): void => {
    const current = path.join(directory, relative)
    fs.chmodSync(current, 0o755)
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(relative, entry.name)
      if (entry.isDirectory()) {
        visit(child)
      } else {
        const normalized = child.split(path.sep).join('/')
        fs.chmodSync(path.join(directory, child), executablePaths.has(normalized) ? 0o755 : 0o644)
      }
    }
  }
  visit('')
}

// Publish builds must never inherit files from an earlier local or CI build.
// In particular, copying an SDK dist directory into an existing destination
// used to create dist/dist on the second run and could ship stale declarations.
fs.rmSync(cliPublishDir, { recursive: true, force: true })
fs.rmSync(sdkPublishDir, { recursive: true, force: true })

// 1. Run tsup
console.log('Building with tsup...')
runProjectPnpm(root, ['tsup', '--config', 'tsup.config.ts'])

// 2. Rename .mjs → .js and .d.mts → .d.ts, update internal imports
const distDir = path.join(cliPublishDir, 'dist')
const files = fs.readdirSync(distDir)
for (const file of files) {
  const filePath = path.join(distDir, file)
  if (file.endsWith('.mjs') || file.endsWith('.d.mts')) {
    let content = fs.readFileSync(filePath, 'utf-8')
    content = content.replace(/\.mjs/g, '.js')
    content = content.replace(/\.d\.mts/g, '.d.ts')
    const newName = file.replace('.d.mts', '.d.ts').replace('.mjs', '.js')
    fs.writeFileSync(path.join(distDir, newName), content)
    fs.unlinkSync(filePath)
  } else if (file.endsWith('.mjs.map')) {
    const newName = file.replace('.mjs.map', '.js.map')
    fs.renameSync(filePath, path.join(distDir, newName))
  }
}

// 3. Copy deterministic agent and plugin catalogs to dist-publish/dist/data/
const snapshotSrc = path.join(root, 'src/data/registry-snapshot.json')
const snapshotDataDir = path.join(distDir, 'data')
fs.mkdirSync(snapshotDataDir, { recursive: true })
fs.copyFileSync(snapshotSrc, path.join(snapshotDataDir, 'registry-snapshot.json'))
console.log('Copied registry-snapshot.json to dist-publish/dist/data/')
fs.copyFileSync(path.join(root, 'src/data/plugin-catalog.json'), path.join(snapshotDataDir, 'plugin-catalog.json'))
console.log('Copied plugin-catalog.json to dist-publish/dist/data/')

// 3b. Copy the native local Whisper runtime next to the flat speech bundle.
const speechDir = path.join(distDir, 'speech')
const speechScript = path.join(speechDir, 'transcribe_audio.sh')
fs.mkdirSync(speechDir, { recursive: true })
fs.copyFileSync(path.join(root, 'src/plugins/speech/scripts/transcribe_audio.sh'), speechScript)
fs.chmodSync(speechScript, 0o755)
console.log('Copied native local Whisper runtime to dist-publish/dist/speech/')

// 4. Add shebang to cli.js
const cliPath = path.join(distDir, 'cli.js')
const cliContent = fs.readFileSync(cliPath, 'utf-8')
if (!cliContent.startsWith('#!/usr/bin/env node')) {
  fs.writeFileSync(cliPath, '#!/usr/bin/env node\n' + cliContent)
}
fs.chmodSync(cliPath, 0o755)

// 5. Generate package.json
const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'))

// Packages excluded from published dependencies (none currently bundled via noExternal).
const bundledDeps = new Set<string>()
const publishDeps: Record<string, string> = {}
for (const [dep, version] of Object.entries(rootPkg.dependencies as Record<string, string>)) {
  if (!bundledDeps.has(dep)) {
    publishDeps[dep] = version
  }
}

const publishPkg = {
  name: '@n1creator/openacp-cli',
  version: rootPkg.version,
  description: 'Self-hosted bridge for AI coding agents via ACP protocol',
  type: 'module',
  // npm 11 rejects a leading "./" in bin targets and removes the command.
  bin: { openacp: 'dist/cli.js' },
  main: './dist/index.js',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      types: './dist/index.d.ts',
      import: './dist/index.js',
    },
    './testing': {
      types: './dist/testing.d.ts',
      import: './dist/testing.js',
    },
  },
  files: ['dist/', 'README.md'],
  engines: { node: '>=22' },
  dependencies: publishDeps,
  peerDependencies: {
    vitest: '>=3 <5',
  },
  peerDependenciesMeta: {
    vitest: { optional: true },
  },
  repository: {
    type: 'git',
    url: 'git+https://github.com/an1creator/OpenACP.git',
  },
  homepage: 'https://github.com/an1creator/OpenACP',
  author: {
    name: 'N1 Creator',
    url: 'https://n1creator.com',
  },
  license: 'MIT',
  keywords: ['acp', 'ai', 'coding-agent', 'telegram', 'claude', 'codex', 'gemini', 'cursor', 'agent-client-protocol'],
}

fs.writeFileSync(
  path.join(cliPublishDir, 'package.json'),
  JSON.stringify(publishPkg, null, 2) + '\n'
)

// 5. Copy README
fs.copyFileSync(
  path.join(root, 'README.md'),
  path.join(cliPublishDir, 'README.md')
)

// 6. Verify: every external import in the bundle must be a Node builtin or a published dependency
import { builtinModules } from 'node:module'

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
])

// Packages that appear in template strings (scaffold generator) but are not real runtime imports
const templateOnlyDeps = new Set(['@n1creator/openacp-plugin-sdk', 'vitest', '@n1creator/openacp-plugin-sdk/testing'])

const importPattern = /(?:from\s+["']|import\s*\(\s*["'])([^./"'][^"']*)["']/g
const missingDeps: Map<string, string[]> = new Map()

const jsFiles = fs.readdirSync(distDir).filter(f => f.endsWith('.js'))
for (const file of jsFiles) {
  const content = fs.readFileSync(path.join(distDir, file), 'utf-8')
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1]
    // Resolve package name (handle scoped packages like @foo/bar)
    const pkgName = specifier.startsWith('@')
      ? specifier.split('/').slice(0, 2).join('/')
      : specifier.split('/')[0]

    if (builtins.has(pkgName)) continue
    if (pkgName in publishDeps) continue
    if (templateOnlyDeps.has(specifier) || templateOnlyDeps.has(pkgName)) continue

    if (!missingDeps.has(pkgName)) missingDeps.set(pkgName, [])
    missingDeps.get(pkgName)!.push(file)
  }
}

if (missingDeps.size > 0) {
  console.error('\n❌ Build verification failed!')
  console.error('These packages are imported in the bundle but not in published dependencies:\n')
  for (const [dep, files] of missingDeps) {
    console.error(`  ${dep}  (in ${[...new Set(files)].join(', ')})`)
  }
  console.error('\nFix: add them to `dependencies` in package.json, or to `noExternal` in tsup.config.ts')
  process.exit(1)
}

console.log('✅ All external imports are covered by published dependencies')

// 7. Build and prepare @n1creator/openacp-plugin-sdk
const sdkDir = path.join(root, 'packages/plugin-sdk')
if (fs.existsSync(sdkDir)) {
  // SDK consumes the CLI declarations. Always rebuild them so a stale local
  // dist directory can never validate or shape the published SDK.
  console.log('\nBuilding CLI types (required by SDK)...')
  fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true })
  runProjectPnpm(root, ['tsc'])

  console.log('\nBuilding @n1creator/openacp-plugin-sdk...')
  fs.rmSync(path.join(sdkDir, 'dist'), { recursive: true, force: true })
  runProjectPnpm(root, ['--dir', sdkDir, 'test:types'])
  runProjectPnpm(root, ['--dir', sdkDir, 'exec', 'tsc'])

  // Generate SDK publish package.json (replace workspace:* with actual version)
  const sdkPkg = JSON.parse(fs.readFileSync(path.join(sdkDir, 'package.json'), 'utf-8'))
  sdkPkg.version = rootPkg.version
  // devDependencies with workspace:* are stripped for publish (not needed at runtime)
  delete sdkPkg.devDependencies
  // peerDependencies already uses @n1creator/openacp-cli (not workspace protocol)

  fs.mkdirSync(sdkPublishDir, { recursive: true })

  // Copy dist
  fs.cpSync(path.join(sdkDir, 'dist'), path.join(sdkPublishDir, 'dist'), { recursive: true })

  // Write package.json
  fs.writeFileSync(
    path.join(sdkPublishDir, 'package.json'),
    JSON.stringify(sdkPkg, null, 2) + '\n'
  )

  // Copy README if exists
  const sdkReadme = path.join(sdkDir, 'README.md')
  if (fs.existsSync(sdkReadme)) {
    fs.copyFileSync(sdkReadme, path.join(sdkPublishDir, 'README.md'))
  }

  console.log(`✅ SDK built: @n1creator/openacp-plugin-sdk@${rootPkg.version}`)
}

// npm preserves ambient source modes in the tarball. Normalize every publish
// tree so restrictive local umasks and root-owned CI builds produce readable,
// byte-reproducible packages.
normalizePublishTree(cliPublishDir, new Set([
  'dist/cli.js',
  'dist/speech/transcribe_audio.sh',
]))
if (fs.existsSync(sdkPublishDir)) normalizePublishTree(sdkPublishDir, new Set())

console.log(`\nBuild complete! Package: @n1creator/openacp-cli@${rootPkg.version}`)
console.log('Run pnpm verify:publish-artifacts to create the verified release tarballs.')
