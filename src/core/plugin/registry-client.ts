import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const registryPluginSchema = z.object({
  name: z.string().min(1), displayName: z.string().min(1).optional(), description: z.string(),
  npm: z.string().min(1), version: z.string().min(1), minCliVersion: z.string().min(1),
  category: z.string().min(1), tags: z.array(z.string()), icon: z.string(), author: z.string(),
  repository: z.string(), license: z.string(), verified: z.boolean(), featured: z.boolean(),
}).strict()

const registrySchema = z.object({
  version: z.number().int().positive(), generatedAt: z.string().min(1),
  pluginCount: z.number().int().nonnegative(), plugins: z.array(registryPluginSchema),
  categories: z.array(z.object({ id: z.string().min(1), name: z.string().min(1), icon: z.string() }).strict()),
}).strict().superRefine((value, ctx) => {
  if (value.pluginCount !== value.plugins.length) ctx.addIssue({ code: 'custom', message: 'pluginCount does not match plugins length' })
})

export type RegistryPlugin = z.infer<typeof registryPluginSchema>
export type Registry = z.infer<typeof registrySchema>

export class PluginCatalogError extends Error {
  readonly code = 'PLUGIN_CATALOG_BUNDLED_INVALID'
  constructor() {
    super('The packaged plugin catalog is unavailable or invalid.')
    this.name = 'PluginCatalogError'
  }
}

function bundledCatalogPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [path.join(moduleDir, 'data', 'plugin-catalog.json'), path.resolve(moduleDir, '../../data/plugin-catalog.json')]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function loadBundledCatalog(): Registry {
  try {
    const result = registrySchema.safeParse(JSON.parse(fs.readFileSync(bundledCatalogPath(), 'utf8')))
    if (!result.success) throw new Error('schema mismatch')
    return result.data
  } catch {
    throw new PluginCatalogError()
  }
}

/** Deterministic offline client for the plugin catalog shipped with this release. */
export class RegistryClient {
  private cache: Registry | undefined

  async getRegistry(): Promise<Registry> {
    return this.cache ??= loadBundledCatalog()
  }

  async search(query: string): Promise<RegistryPlugin[]> {
    const registry = await this.getRegistry()
    const normalized = query.toLowerCase()
    return registry.plugins.filter((plugin) => `${plugin.name} ${plugin.displayName ?? ''} ${plugin.description} ${plugin.tags.join(' ')}`.toLowerCase().includes(normalized))
  }

  async resolve(name: string): Promise<string | null> {
    const registry = await this.getRegistry()
    return registry.plugins.find((plugin) => plugin.name === name)?.npm ?? null
  }

  clearCache(): void { this.cache = undefined }
}
