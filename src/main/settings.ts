/** Small settings file in the app-data folder. It holds preferences, never document content. */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { settingsSchema, type Settings, type SettingsPatch } from '../shared/schemas'
import type { RecentFile } from '../shared/types'

const MAX_RECENT = 12

export class SettingsStore {
  private settings: Settings
  private recent: string[] = []
  private readonly settingsPath: string
  private readonly recentPath: string

  constructor(directory: string) {
    this.settingsPath = join(directory, 'settings.json')
    this.recentPath = join(directory, 'recent-files.json')
    this.settings = this.loadSettings()
    this.recent = this.settings.recentFilesEnabled ? this.loadRecent() : []
  }

  private loadSettings(): Settings {
    try {
      return settingsSchema.parse(JSON.parse(readFileSync(this.settingsPath, 'utf8')))
    } catch {
      return settingsSchema.parse({})
    }
  }

  private loadRecent(): string[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.recentPath, 'utf8'))
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT)
    } catch {
      /* No history yet. */
    }
    return []
  }

  private writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.tmp`
    writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(temp, path)
  }

  get(): Settings {
    return this.settings
  }

  update(patch: SettingsPatch): Settings {
    this.settings = settingsSchema.parse({ ...this.settings, ...patch })
    this.writeJson(this.settingsPath, this.settings)
    if (patch.recentFilesEnabled === false) this.clearRecent()
    return this.settings
  }

  setDefaultExportDir(directory: string | null): Settings {
    this.settings = { ...this.settings, defaultExportDir: directory }
    this.writeJson(this.settingsPath, this.settings)
    return this.settings
  }

  addRecent(paths: string[]): void {
    if (!this.settings.recentFilesEnabled || paths.length === 0) return
    this.recent = [...paths, ...this.recent.filter((item) => !paths.includes(item))].slice(0, MAX_RECENT)
    this.writeJson(this.recentPath, this.recent)
  }

  recentFiles(): RecentFile[] {
    return this.recent.filter((path) => existsSync(path)).map((path) => ({ displayPath: path, name: basename(path) }))
  }

  isRecent(path: string): boolean {
    return this.settings.recentFilesEnabled && this.recent.includes(path)
  }

  clearRecent(): void {
    this.recent = []
    try {
      unlinkSync(this.recentPath)
    } catch {
      /* Already gone. */
    }
  }
}
