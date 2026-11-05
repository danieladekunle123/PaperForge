/** Turns a renderer job, which holds opaque ids, into a worker job with real paths. */
import { dirname, join } from 'node:path'
import { JobFailure } from './workerHost'
import type { FileRegistry } from './registry'
import type { RendererJob } from '../shared/schemas'

interface SourceRef {
  id: string
  password?: string
}

export interface ResolvedJob {
  op: string
  params: Record<string, unknown>
  /** Folders that may hold temp files for this job. */
  sweepDirectories: string[]
}

function missingFile(): JobFailure {
  return new JobFailure('FILE_NOT_REGISTERED', 'This file is no longer available in the workspace. Import it again.')
}

export function resolveJob(job: RendererJob, registry: FileRegistry): ResolvedJob {
  const sweep = new Set<string>()

  const source = (ref: SourceRef) => {
    const entry = registry.source(ref.id)
    if (!entry) throw missingFile()
    return { id: ref.id, path: entry.path, ...(ref.password ? { password: ref.password } : {}) }
  }

  const output = (ref: { outputId: string }) => {
    const path = registry.takeOutput(ref.outputId)
    if (!path) {
      throw new JobFailure('OUTPUT_EXPIRED', 'The chosen save location is no longer valid. Choose it again.')
    }
    sweep.add(dirname(path))
    // The user already confirmed any overwrite in the native Save As dialog.
    return { path, overwrite: 'replace' as const }
  }

  const folder = (ref: { folderId: string; overwrite: 'error' | 'replace' | 'rename' }) => {
    const path = registry.folder(ref.folderId)
    if (!path) throw new JobFailure('OUTPUT_EXPIRED', 'The chosen folder is no longer valid. Choose it again.')
    sweep.add(path)
    return { path, overwrite: ref.overwrite }
  }

  const done = (params: Record<string, unknown>): ResolvedJob => ({
    op: job.op,
    params,
    sweepDirectories: [...sweep]
  })

  switch (job.op) {
    case 'probe': {
      const entry = registry.source(job.params.source.id)
      if (!entry) throw missingFile()
      return done({ source: { ...source(job.params.source), kind: entry.kind } })
    }
    case 'assemble':
      return done({ ...job.params, sources: job.params.sources.map(source), output: output(job.params.output) })
    case 'preview_assemble':
      return done({ ...job.params, sources: job.params.sources.map(source) })
    case 'split': {
      const resolved = folder(job.params.folder)
      if (resolved.overwrite === 'replace') {
        for (const group of job.params.groups) {
          const name = /\.pdf$/i.test(group.name) ? group.name : `${group.name}.pdf`
          if (registry.isSourcePath(join(resolved.path, name))) {
            throw new JobFailure('OUTPUT_IS_SOURCE', `“${name}” is one of your source files, so it cannot be overwritten.`)
          }
        }
      }
      return done({ ...job.params, source: source(job.params.source), folder: resolved })
    }
    case 'compress':
    case 'protect':
    case 'unprotect':
      return done({ ...job.params, source: source(job.params.source), output: output(job.params.output) })
    case 'apply':
      return done({
        ...job.params,
        source: source(job.params.source),
        imageSources: job.params.imageSources?.map(source),
        output: output(job.params.output)
      })
    case 'preview_apply':
      return done({
        ...job.params,
        source: source(job.params.source),
        imageSources: job.params.imageSources?.map(source)
      })
    case 'pdf_to_images':
      return done({ ...job.params, source: source(job.params.source), folder: folder(job.params.folder) })
    case 'images_to_pdf':
      return done({ ...job.params, sources: job.params.sources.map(source), output: output(job.params.output) })
    case 'preview_images':
      return done({ ...job.params, sources: job.params.sources.map(source) })
    case 'extract_text':
      return done({ ...job.params, source: source(job.params.source) })
    case 'save_text':
      return done({ ...job.params, output: output(job.params.output) })
  }
}
