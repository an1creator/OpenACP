import { execFileSync, type ExecFileSyncOptions } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

type RunOptions = Pick<ExecFileSyncOptions, 'cwd' | 'env' | 'stdio'>

interface ConfiguredPnpm { spec: string; version: string }

function configuredPnpm(root: string): ConfiguredPnpm {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    packageManager?: string
  }
  const match = manifest.packageManager?.match(/^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/)
  if (!match) {
    throw new Error('package.json must pin packageManager to an exact pnpm version')
  }
  return { spec: manifest.packageManager!, version: match[1] }
}

function needsWindowsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
}

function run(command: string, args: string[], options: ExecFileSyncOptions): Buffer | string {
  return execFileSync(command, args, {
    ...options,
    shell: needsWindowsShell(command),
  })
}

/** Run the project pnpm without resolving an unrelated global binary from PATH. */
export function runProjectPnpm(root: string, args: string[], options: RunOptions = {}): void {
  const configured = configuredPnpm(root)
  const lifecyclePnpm = process.env.npm_execpath
  const isPnpmExecutable = lifecyclePnpm
    && /(?:^|[\\/])pnpm(?:\.(?:c?js|mjs|cmd|exe))?$/i.test(lifecyclePnpm)

  if (lifecyclePnpm && isPnpmExecutable) {
    const isNodeScript = /\.(?:c?js|mjs)$/i.test(lifecyclePnpm)
    const command = isNodeScript ? process.execPath : lifecyclePnpm
    const prefix = isNodeScript ? [lifecyclePnpm] : []
    const lifecycleVersion = run(command, [...prefix, '--version'], {
      cwd: root,
      env: options.env,
      encoding: 'utf8',
    }).toString().trim()
    if (lifecycleVersion === configured.version) {
      run(command, [...prefix, ...args], { cwd: root, stdio: 'inherit', ...options })
      return
    }
  }

  const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack'
  const corepackVersion = run(corepack, [configured.spec, '--version'], {
    cwd: root,
    env: options.env,
    encoding: 'utf8',
  }).toString().trim()
  if (corepackVersion !== configured.version) {
    throw new Error(`Corepack resolved pnpm ${corepackVersion}; expected ${configured.version}`)
  }
  run(corepack, [configured.spec, ...args], { cwd: root, stdio: 'inherit', ...options })
}
