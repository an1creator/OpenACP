import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

dirtyPublishRoots('first')
build()
const firstArtifacts = Object.fromEntries(publishDirs.map((name) => [name, artifactManifest(path.join(root, name))]))
const firstPacks = Object.fromEntries(publishDirs.map((name) => {
  const manifest = packManifest(`./${name}`)
  assertPackAllowlist(name, manifest)
  return [name, manifest]
}))

dirtyPublishRoots('second')
build()
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
