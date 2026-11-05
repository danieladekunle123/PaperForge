/**
 * The file allow-list. The renderer only ever holds opaque ids: a source exists here because the
 * user picked or dropped it, and an output target because the user chose it in a native dialog.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type { ImportedFile, ImportResult, RejectedFile, SourceKind } from '../shared/types'

interface RegisteredSource {
  id: string
  path: string
  name: string
  kind: SourceKind
  sizeBytes: number
}

const KINDS: Record<string, SourceKind> = {
  '.pdf': 'pdf',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.png': 'image'
}

export const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png'
}

function normalize(path: string): string {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

export class FileRegistry {
  private sources = new Map<string, RegisteredSource>()
  private byPath = new Map<string, string>()
  private outputs = new Map<string, string>()
  private folders = new Map<string, string>()
  private knownResults = new Set<string>()

  async register(paths: string[]): Promise<ImportResult> {
    const files: ImportedFile[] = []
    const rejected: RejectedFile[] = []
    for (const path of paths) {
      const name = basename(path)
      const kind = KINDS[extname(path).toLowerCase()]
      if (!kind) {
        rejected.push({ name, reason: 'Only PDF, JPG and PNG files can be imported.' })
        continue
      }
      let size: number
      try {
        const stat = await fs.stat(path)
        if (!stat.isFile()) {
          rejected.push({ name, reason: 'This is not a file.' })
          continue
        }
        size = stat.size
      } catch {
        rejected.push({ name, reason: 'The file could not be found or opened.' })
        continue
      }
      const key = normalize(path)
      const existing = this.byPath.get(key)
      if (existing) {
        const entry = this.sources.get(existing)!
        entry.sizeBytes = size
        files.push(this.describe(entry, true))
        continue
      }
      const entry: RegisteredSource = { id: randomUUID(), path: resolve(path), name, kind, sizeBytes: size }
      this.sources.set(entry.id, entry)
      this.byPath.set(key, entry.id)
      files.push(this.describe(entry, false))
    }
    return { files, rejected }
  }

  private describe(entry: RegisteredSource, reused: boolean): ImportedFile {
    return {
      id: entry.id,
      name: entry.name,
      displayPath: entry.path,
      kind: entry.kind,
      sizeBytes: entry.sizeBytes,
      reused
    }
  }

  release(id: string): void {
    const entry = this.sources.get(id)
    if (!entry) return
    this.sources.delete(id)
    this.byPath.delete(normalize(entry.path))
  }

  source(id: string): RegisteredSource | undefined {
    return this.sources.get(id)
  }

  isSourcePath(path: string): boolean {
    return this.byPath.has(normalize(path))
  }

  addOutput(path: string): string {
    const id = randomUUID()
    this.outputs.set(id, path)
    return id
  }

  /** Output tokens work once, so a stale renderer cannot write there again without a new dialog. */
  takeOutput(id: string): string | undefined {
    const path = this.outputs.get(id)
    this.outputs.delete(id)
    return path
  }

  addFolder(path: string): string {
    const id = randomUUID()
    this.folders.set(id, path)
    return id
  }

  folder(id: string): string | undefined {
    return this.folders.get(id)
  }

  findCollisions(folderId: string, names: string[]): string[] {
    const folder = this.folders.get(folderId)
    if (!folder) return []
    return names.filter((name) => {
      if (name !== basename(name)) return false
      return existsSync(join(folder, name))
    })
  }

  rememberResult(path: string): void {
    this.knownResults.add(normalize(path))
  }

  isKnownResult(path: string): boolean {
    return this.knownResults.has(normalize(path)) && existsSync(path) && statSync(path).isFile()
  }
}
