import { wantsHelp } from './helpers.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes } from '../output.js'

/**
 * `openacp uninstall` — Remove an adapter plugin from the instance's plugins directory.
 *
 * Delegates to `npm uninstall` to remove the package from the plugins directory.
 */
export async function cmdUninstall(args: string[], instanceRoot?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()

  if (!json && wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp uninstall\x1b[0m — Remove a plugin adapter

\x1b[1mUsage:\x1b[0m
  openacp uninstall <package>

\x1b[1mArguments:\x1b[0m
  <package>       npm package name to remove

\x1b[1mOptions:\x1b[0m
  --json          Output result as JSON
  -h, --help      Show this help message

\x1b[1mExamples:\x1b[0m
  openacp uninstall @openacp/discord-adapter
`)
    return
  }

  const pkg = args.filter(a => a !== '--json')[0]
  if (!pkg) {
    if (json) jsonError(ErrorCodes.MISSING_ARGUMENT, 'Package name is required')
    console.error("Usage: openacp uninstall <package>")
    process.exit(1)
  }

  const path = await import('node:path')
  const { PluginRegistry } = await import('../../core/plugin/plugin-registry.js')
  const registry = new PluginRegistry(path.join(instanceRoot!, 'plugins.json'))
  await registry.load()
  if (registry.get(pkg)) {
    registry.remove(pkg)
    await registry.save()
  }
  if (json) jsonSuccess({ plugin: pkg, uninstalled: true, packageTreeRetained: true, restartRequired: true })
  if (!json) console.log('Shared npm package files are retained until a coordinated package-tree maintenance transaction; restart OpenACP to apply removal.')
}
