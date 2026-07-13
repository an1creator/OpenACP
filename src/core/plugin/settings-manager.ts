import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SettingsAPI } from './types.js'
import type { ZodSchema } from 'zod'

function secureSettingsDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
}

function secureSettingsTree(basePath: string, settingsPath: string, create: boolean): void {
  const target = path.dirname(settingsPath)
  const relative = path.relative(basePath, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Settings path escapes its base directory')
  // The security boundary starts at basePath itself, not only its descendants.
  secureSettingsDirectory(basePath)
  let current = basePath
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment)
    if (create || fs.existsSync(current)) secureSettingsDirectory(current)
  }
}

function repairSettingsPermissions(settingsPath: string, basePath: string): void {
  if (!fs.existsSync(settingsPath)) return
  secureSettingsTree(basePath, settingsPath, false)
  fs.chmodSync(settingsPath, 0o600)
}

function atomicSettingsWrite(settingsPath: string, basePath: string, data: Record<string, unknown>): void {
  const directory = path.dirname(settingsPath)
  secureSettingsTree(basePath, settingsPath, true)
  const temporary = `${settingsPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    fs.chmodSync(temporary, 0o600)
    const fd = fs.openSync(temporary, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    fs.renameSync(temporary, settingsPath)
    fs.chmodSync(settingsPath, 0o600)
    try {
      const directoryFd = fs.openSync(directory, 'r')
      try { fs.fsyncSync(directoryFd) } finally { fs.closeSync(directoryFd) }
    } catch { /* directory fsync is unsupported on some platforms */ }
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary) } catch { /* best effort cleanup */ }
  }
}

/** Result of validating plugin settings against a Zod schema. */
export interface ValidationResult {
  valid: boolean
  errors?: string[]
}

/**
 * Manages per-plugin settings files.
 *
 * Each plugin's settings are stored at `<basePath>/<pluginName>/settings.json`.
 * The basePath is typically `~/.openacp/plugins/`.
 * Settings are distinct from plugin storage (kv.json) — settings are user-facing
 * configuration, while storage is internal plugin state.
 */
export class SettingsManager {
  constructor(private basePath: string) {
    secureSettingsDirectory(basePath)
  }

  /** Returns the base path for all plugin settings directories. */
  getBasePath(): string {
    return this.basePath
  }

  /** Create a SettingsAPI instance scoped to a specific plugin. */
  createAPI(pluginName: string): SettingsAPI {
    const settingsPath = this.getSettingsPath(pluginName)
    return new SettingsAPIImpl(settingsPath, this.basePath)
  }

  /** Load a plugin's settings from disk. Returns empty object if file doesn't exist. */
  async loadSettings(pluginName: string): Promise<Record<string, unknown>> {
    const settingsPath = this.getSettingsPath(pluginName)
    secureSettingsDirectory(this.basePath)
    if (!fs.existsSync(settingsPath)) return {}
    repairSettingsPermissions(settingsPath, this.basePath)
    try {
      const content = fs.readFileSync(settingsPath, 'utf-8')
      return JSON.parse(content)
    } catch {
      return {}
    }
  }

  /** Validate settings against a Zod schema. Returns valid if no schema is provided. */
  validateSettings(
    _pluginName: string,
    settings: unknown,
    schema?: ZodSchema,
  ): ValidationResult {
    if (!schema) return { valid: true }
    const result = schema.safeParse(settings)
    if (result.success) return { valid: true }
    return {
      valid: false,
      errors: result.error.issues.map(
        (e) => `${e.path.map(String).join('.')}: ${e.message}`,
      ),
    }
  }

  /** Resolve the absolute path to a plugin's settings.json file. */
  getSettingsPath(pluginName: string): string {
    return path.join(this.basePath, pluginName, 'settings.json')
  }

  async getPluginSettings(pluginName: string): Promise<Record<string, unknown>> {
    return this.loadSettings(pluginName)
  }

  /** Merge updates into existing settings (shallow merge). */
  async updatePluginSettings(pluginName: string, updates: Record<string, unknown>): Promise<void> {
    const api = this.createAPI(pluginName)
    const current = await api.getAll()
    await api.setAll({ ...current, ...updates })
  }
}

/**
 * File-backed implementation of SettingsAPI for a single plugin.
 * Reads/writes JSON synchronously with an in-memory cache to avoid
 * redundant disk reads within the same lifecycle.
 */
class SettingsAPIImpl implements SettingsAPI {
  private cache: Record<string, unknown> | null = null

  constructor(private settingsPath: string, private basePath: string) {}

  private readFile(): Record<string, unknown> {
    if (this.cache !== null) return this.cache
    secureSettingsDirectory(this.basePath)
    if (fs.existsSync(this.settingsPath)) repairSettingsPermissions(this.settingsPath, this.basePath)
    try {
      const content = fs.readFileSync(this.settingsPath, 'utf-8')
      this.cache = JSON.parse(content)
      return this.cache!
    } catch {
      this.cache = {}
      return this.cache
    }
  }

  private writeFile(data: Record<string, unknown>): void {
    atomicSettingsWrite(this.settingsPath, this.basePath, data)
    this.cache = data
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    const data = this.readFile()
    return data[key] as T | undefined
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const data = this.readFile()
    data[key] = value
    this.writeFile(data)
  }

  async getAll(): Promise<Record<string, unknown>> {
    return { ...this.readFile() }
  }

  async setAll(settings: Record<string, unknown>): Promise<void> {
    this.writeFile({ ...settings })
  }

  async delete(key: string): Promise<void> {
    const data = this.readFile()
    delete data[key]
    this.writeFile(data)
  }

  async clear(): Promise<void> {
    this.writeFile({})
  }

  async has(key: string): Promise<boolean> {
    const data = this.readFile()
    return key in data
  }
}
