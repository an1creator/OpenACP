import { wantsHelp } from './helpers.js'
import { isJsonMode, jsonSuccess, jsonError, muteForJson, ErrorCodes } from '../output.js'

/**
 * `openacp plugins` — List all installed plugins.
 * Short alias for `openacp plugin list`.
 */
export async function cmdPlugins(args: string[] = [], instanceRoot?: string): Promise<void> {
  const json = isJsonMode(args)
  if (json) await muteForJson()

  if (!json && wantsHelp(args)) {
    console.log(`
\x1b[1mopenacp plugins\x1b[0m — List installed plugins

\x1b[1mUsage:\x1b[0m
  openacp plugins

\x1b[1mOptions:\x1b[0m
  --json          Output result as JSON
  -h, --help      Show this help message

Shows all plugins registered in the plugin registry.
`)
    return
  }

  const path = await import('node:path')
  const { PluginRegistry } = await import('../../core/plugin/plugin-registry.js')

  const root = instanceRoot!
  const registryPath = path.join(root, 'plugins.json')
  const registry = new PluginRegistry(registryPath)
  await registry.load()

  const plugins = registry.list()

  if (json) {
    const pluginList: Record<string, unknown>[] = []
    for (const [name, entry] of plugins) {
      pluginList.push({
        name,
        version: entry.version,
        enabled: entry.enabled !== false,
        source: entry.source ?? 'unknown',
        description: entry.description ?? '',
      })
    }
    jsonSuccess({ plugins: pluginList })
  }

  if (plugins.size === 0) {
    console.log("No plugins installed.")
  } else {
    console.log("Installed plugins:")
    for (const [name, entry] of plugins) {
      const status = entry.enabled ? '' : ' (disabled)'
      console.log(`  ${name}@${entry.version}${status}`)
    }
  }
}

/**
 * `openacp plugin <subcommand>` — Extended plugin management.
 *
 * Subcommands:
 *   list                — List all plugins with status (same as `openacp plugins`)
 *   add|install <pkg>   — Install a plugin package
 *   remove|uninstall    — Remove a plugin package (--purge to delete data)
 *   enable <name>       — Enable a plugin
 *   disable <name>      — Disable a plugin
 *   configure <name>    — Run interactive configuration for a plugin
 */
export async function cmdPlugin(args: string[] = [], instanceRoot?: string): Promise<void> {
  const subcommand = args[0]

  if (!subcommand || (wantsHelp(args) && !['create', 'search'].includes(subcommand))) {
    console.log(`
\x1b[1mopenacp plugin\x1b[0m — Plugin management

\x1b[1mUsage:\x1b[0m
  openacp plugin list                    List all plugins with status
  openacp plugin search <query>          Search the plugin registry
  openacp plugin add <package>[@version]  Install a plugin from npm
  openacp plugin install <package>       Alias for add
  openacp plugin remove <package>        Remove a plugin package
  openacp plugin uninstall <package>     Alias for remove (--purge to delete data)
  openacp plugin enable <name>           Enable a plugin
  openacp plugin disable <name>          Disable a plugin
  openacp plugin configure <name>        Run interactive configuration
  openacp plugin create                  Scaffold a new plugin project (interactive)
  openacp plugin create --name <name>    Scaffold a new plugin project (non-interactive)

\x1b[1mOptions:\x1b[0m
  --json          Output result as JSON
  -h, --help      Show this help message

\x1b[1mExamples:\x1b[0m
  openacp plugin list
  openacp plugin search telegram
  openacp plugin add @openacp/discord-adapter
  openacp plugin add translator@1.2.0
  openacp plugin enable @openacp/discord-adapter
  openacp plugin configure @openacp/discord-adapter
  openacp plugin remove @openacp/discord-adapter --purge
`)
    return
  }

  switch (subcommand) {
    case 'list':
      return cmdPlugins(isJsonMode(args) ? ['--json'] : [], instanceRoot)

    case 'search': {
      const { cmdPluginSearch } = await import('./plugin-search.js')
      await cmdPluginSearch(args.slice(1))
      return
    }

    case 'add':
    case 'install': {
      const pkg = args.slice(1).find(a => !a.startsWith('-'))
      if (!pkg) {
        if (isJsonMode(args)) jsonError(ErrorCodes.MISSING_ARGUMENT, 'Package name is required')
        console.error('Error: missing package name. Usage: openacp plugin add <package>')
        process.exit(1)
      }
      await installPlugin(pkg, instanceRoot, isJsonMode(args))
      return
    }

    case 'remove':
    case 'uninstall': {
      const pkg = args.slice(1).find(a => !a.startsWith('-'))
      if (!pkg) {
        if (isJsonMode(args)) jsonError(ErrorCodes.MISSING_ARGUMENT, 'Package name is required')
        console.error('Error: missing package name. Usage: openacp plugin remove <package> [--purge]')
        process.exit(1)
      }
      const purge = args.includes('--purge')
      await uninstallPlugin(pkg, purge, instanceRoot, isJsonMode(args))
      return
    }

    case 'enable': {
      const name = args[1]
      if (!name) {
        if (isJsonMode(args)) jsonError(ErrorCodes.MISSING_ARGUMENT, 'Plugin name is required')
        console.error('Error: missing plugin name. Usage: openacp plugin enable <name>')
        process.exit(1)
      }
      await setPluginEnabled(name, true, instanceRoot, isJsonMode(args))
      return
    }

    case 'disable': {
      const name = args[1]
      if (!name) {
        if (isJsonMode(args)) jsonError(ErrorCodes.MISSING_ARGUMENT, 'Plugin name is required')
        console.error('Error: missing plugin name. Usage: openacp plugin disable <name>')
        process.exit(1)
      }
      await setPluginEnabled(name, false, instanceRoot, isJsonMode(args))
      return
    }

    case 'configure': {
      const name = args[1]
      if (!name) {
        console.error('Error: missing plugin name. Usage: openacp plugin configure <name>')
        process.exit(1)
      }
      await configurePlugin(name, instanceRoot)
      return
    }

    case 'create': {
      const { cmdPluginCreate } = await import('./plugin-create.js')
      await cmdPluginCreate(args.slice(1))
      return
    }

    default:
      console.error(`Unknown subcommand: ${subcommand}`)
      console.error('Run "openacp plugin --help" for usage.')
      process.exit(1)
  }
}

async function setPluginEnabled(name: string, enabled: boolean, instanceRoot?: string, json = false): Promise<void> {
  if (json) await muteForJson()

  const path = await import('node:path')
  const { PluginRegistry } = await import('../../core/plugin/plugin-registry.js')
  const { withPluginMutationLock } = await import('../../core/plugin/plugin-installer.js')

  const root = instanceRoot!
  const registryPath = path.join(root, 'plugins.json')
  const registry = new PluginRegistry(registryPath)
  await withPluginMutationLock(root, async () => {
    await registry.load()
    const entry = registry.get(name)
    if (!entry) {
      if (json) jsonError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin "${name}" not found.`)
      console.error(`Plugin "${name}" not found. Run "openacp plugin list" to see installed plugins.`)
      process.exit(1)
    }
    registry.setEnabled(name, enabled)
    await registry.save()
  })
  if (json) jsonSuccess({ plugin: name, enabled })
  console.log(`Plugin ${name} ${enabled ? 'enabled' : 'disabled'}. Restart to apply.`)
}

async function configurePlugin(name: string, instanceRoot?: string): Promise<void> {
  const path = await import('node:path')
  const { corePlugins } = await import('../../plugins/core-plugins.js')
  const { SettingsManager } = await import('../../core/plugin/settings-manager.js')
  const { createInstallContext } = await import('../../core/plugin/install-context.js')

  const plugin = corePlugins.find(p => p.name === name)
  if (!plugin) {
    console.error(`Plugin "${name}" not found.`)
    process.exit(1)
  }

  const root = instanceRoot!
  const basePath = path.join(root, 'plugins', 'data')
  const settingsManager = new SettingsManager(basePath)
  const ctx = createInstallContext({ pluginName: name, settingsManager, basePath, instanceRoot: root })

  if (plugin.configure) {
    await plugin.configure(ctx)
  } else if (plugin.install) {
    await plugin.install(ctx)
  } else {
    console.log(`Plugin ${name} has no configure or install hook.`)
  }
}

async function installPlugin(input: string, instanceRoot?: string, json = false): Promise<void> {
  if (json) await muteForJson()

  const path = await import('node:path')
  const { getCurrentVersion } = await import('../version.js')
  const { SettingsManager } = await import('../../core/plugin/settings-manager.js')
  const { createInstallContext } = await import('../../core/plugin/install-context.js')
  const { PluginRegistry } = await import('../../core/plugin/plugin-registry.js')

  const root = instanceRoot!

  const {
    parseNpmPackageSpec, stageNpmPlugin, PluginInstallError,
    acquirePluginInstallLock, PluginInstallJournalController, withHeldPluginMutationLock,
  } = await import('../../core/plugin/plugin-installer.js')
  let parsedInput: { packageName: string; spec: string }
  try { parsedInput = parseNpmPackageSpec(input) }
  catch (error) {
    const message = error instanceof PluginInstallError ? `${error.code}: ${error.message}` : 'PLUGIN_PACKAGE_SPEC_INVALID: Plugin package spec is invalid.'
    if (json) jsonError(ErrorCodes.INSTALL_FAILED, message)
    console.error(`Plugin install failed: ${message}`)
    process.exit(1)
  }
  let pkgName = parsedInput.packageName
  let installSpec = parsedInput.spec

  // Try resolve from registry
  const { RegistryClient } = await import('../../core/plugin/registry-client.js')
  const { ProxyService } = await import('../../core/network/proxy-service.js')
  const proxyService = new ProxyService(root)
  const registry = await new RegistryClient().getRegistry()
  const registryPlugin = registry.plugins.find(p => p.name === pkgName || p.npm === pkgName)
  if (registryPlugin) {
    if (!json) console.log(`Resolved from catalog: ${pkgName} → ${registryPlugin.npm}`)
    const versionAt = installSpec.startsWith('@')
      ? installSpec.indexOf('@', installSpec.indexOf('/') + 1)
      : installSpec.lastIndexOf('@')
    const requestedVersion = versionAt > 0 ? installSpec.slice(versionAt + 1) : undefined
    pkgName = registryPlugin.npm
    installSpec = requestedVersion ? `${pkgName}@${requestedVersion}` : pkgName
    if (!json && !registryPlugin.verified) {
      console.log('⚠️  This plugin is not verified by the OpenACP team.')
    }
  }
  if (!json) console.log(`Installing ${installSpec}...`)

  // Check if built-in plugin
  const { corePlugins } = await import('../../plugins/core-plugins.js')
  const builtinPlugin = corePlugins.find(p => p.name === pkgName)

  const basePath = path.join(root, 'plugins', 'data')
  const settingsManager = new SettingsManager(basePath)
  const registryPath = path.join(root, 'plugins.json')
  const pluginRegistry = new PluginRegistry(registryPath)
  await pluginRegistry.load()

  if (builtinPlugin) {
    // Built-in plugin — run install hook directly
    if (builtinPlugin.install) {
      const ctx = createInstallContext({ pluginName: builtinPlugin.name, settingsManager, basePath, instanceRoot: root })
      await builtinPlugin.install(ctx)
    }

    pluginRegistry.register(builtinPlugin.name, {
      version: builtinPlugin.version,
      source: 'builtin',
      enabled: true,
      settingsPath: settingsManager.getSettingsPath(builtinPlugin.name),
      description: builtinPlugin.description,
    })
    await pluginRegistry.save()
    if (json) jsonSuccess({ plugin: builtinPlugin.name, version: builtinPlugin.version, installed: true })
    console.log(`✓ ${builtinPlugin.name} installed! Restart to activate.`)
    return
  }

  // Community plugin — npm install to plugins/
  const pluginsDir = path.join(root, 'plugins')
  let staged: Awaited<ReturnType<typeof stageNpmPlugin>> | undefined
  let controller: InstanceType<typeof PluginInstallJournalController> | undefined
  let lock: Awaited<ReturnType<typeof acquirePluginInstallLock>> | undefined
  let pluginName = pkgName
  let installedVersion = ''
  let failure: string | undefined
  let cleanupPending = false
  try {
    lock = await acquirePluginInstallLock(root)
    await withHeldPluginMutationLock(root, lock, async () => {
      controller = new PluginInstallJournalController(root, lock!)
      controller.recoverExisting()
      // Recovery may have restored the exact pre-transaction registry bytes.
      await pluginRegistry.load()
      const intendedSettingsPath = settingsManager.getSettingsPath(pkgName)
      controller.initialize(pkgName, path.dirname(intendedSettingsPath), registryPath)
      staged = await stageNpmPlugin(
        installSpec, pluginsDir,
        proxyService.buildChildEnv('services.pluginInstaller', process.env as Record<string, string>),
        { transactionId: lock!.transactionId },
      )
      pluginName = staged.plugin.name
      const settingsPath = intendedSettingsPath
      const pluginDataDirectory = path.dirname(settingsPath)
      const activationHooks = await controller.prepare(pluginName, staged, pluginDataDirectory, registryPath)
      controller.snapshotData(pluginDataDirectory)

    // Check engines.openacp compatibility
    const cliVersion = getCurrentVersion()
    const minVersion = staged.manifest.engines?.openacp?.replace(/[>=^~\s]/g, '')
    if (minVersion) {
      const { compareVersions } = await import('../version.js')
      if (compareVersions(cliVersion, minVersion) < 0) {
        if (!json) {
          console.log(`\n⚠️  This plugin requires OpenACP >= ${minVersion}. You have ${cliVersion}.`)
          console.log(`   Run 'openacp update' to get the latest version.\n`)
        }
      }
    }

      const ctx = createInstallContext({ pluginName, settingsManager, basePath, instanceRoot: root })
      controller.transition('hook-running')
      try { await staged.plugin.install(ctx) }
      catch { throw new PluginInstallError('PLUGIN_INSTALL_HOOK_FAILED', 'Plugin install hook failed; live packages were not changed.') }
      controller.transition('hook-complete')
      await staged.activate(activationHooks)
      pluginRegistry.register(pluginName, {
        version: staged.manifest.version,
        source: 'npm',
        enabled: true,
        settingsPath,
        description: staged.plugin.description ?? staged.manifest.description,
      })
      controller.transition('registry-committing')
      const expectedRegistry = pluginRegistry.serializeCurrent()
      await pluginRegistry.save()
      controller.markRegistryCommitted(expectedRegistry, 0o600)
      cleanupPending = !controller.commit()
      installedVersion = staged.manifest.version
    })
  } catch (err) {
    let rollbackFailed = false
    try {
      if (controller) controller.rollback()
      else await staged?.discard()
      await pluginRegistry.load()
    } catch { rollbackFailed = true }
    failure = rollbackFailed
      ? 'PLUGIN_ROLLBACK_FAILED: Plugin installation failed and automatic rollback was incomplete. Keep OpenACP stopped and inspect the protected plugin state before retrying.'
      : err instanceof PluginInstallError
        ? `${err.code}: ${err.message}`
        : 'PLUGIN_STAGE_FAILED: Plugin validation or install hook failed; previous package, settings, and registry state were restored.'
  } finally {
    lock?.release()
  }
  if (failure) {
    if (json) jsonError(ErrorCodes.INSTALL_FAILED, failure)
    console.error(`Plugin install failed: ${failure}`)
    process.exit(1)
  }
  if (json) jsonSuccess({ plugin: pluginName, version: installedVersion, installed: true })
  console.log(`✓ ${pluginName} installed! Restart to activate.`)
  if (cleanupPending) console.warn('PLUGIN_CLEANUP_PENDING: install committed; protected transaction cleanup will retry on next startup.')
}

async function uninstallPlugin(name: string, purge: boolean, instanceRoot?: string, json = false): Promise<void> {
  if (json) await muteForJson()

  const path = await import('node:path')
  const fs = await import('node:fs')
  const { PluginRegistry } = await import('../../core/plugin/plugin-registry.js')
  const { withPluginMutationLock } = await import('../../core/plugin/plugin-installer.js')

  const root = instanceRoot!
  const registryPath = path.join(root, 'plugins.json')
  const registry = new PluginRegistry(registryPath)
  await withPluginMutationLock(root, async () => {
    await registry.load()
    const entry = registry.get(name)
    if (!entry) {
      if (json) jsonError(ErrorCodes.PLUGIN_NOT_FOUND, `Plugin "${name}" not installed.`)
      console.error(`Plugin "${name}" not installed.`)
      process.exit(1)
    }

    if (entry.source === 'builtin') {
      if (json) jsonError(ErrorCodes.UNINSTALL_FAILED, `Cannot uninstall built-in plugin "${name}". Use "openacp plugin disable ${name}" instead.`)
      console.error(`Cannot uninstall built-in plugin. Use "openacp plugin disable ${name}" instead.`)
      process.exit(1)
    }

  // Try to call uninstall hook
  try {
    const { corePlugins } = await import('../../plugins/core-plugins.js')
    const plugin = corePlugins.find(p => p.name === name)
    if (plugin?.uninstall) {
      const { SettingsManager } = await import('../../core/plugin/settings-manager.js')
      const { createInstallContext } = await import('../../core/plugin/install-context.js')
      const basePath = path.join(root, 'plugins', 'data')
      const settingsManager = new SettingsManager(basePath)
      const ctx = createInstallContext({ pluginName: name, settingsManager, basePath, instanceRoot: root })
      await plugin.uninstall(ctx, { purge })
    }
  } catch {
    // Plugin module might not be loadable, continue
  }

    if (purge) {
      const pluginDir = path.join(root, 'plugins', name)
      fs.rmSync(pluginDir, { recursive: true, force: true })
    }

    registry.remove(name)
    await registry.save()
  })
  if (json) jsonSuccess({ plugin: name, uninstalled: true })
  console.log(`Plugin ${name} uninstalled${purge ? ' (purged)' : ''}.`)
}
