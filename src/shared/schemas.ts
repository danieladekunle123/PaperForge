/**
 * Job request schemas. One definition produces two variants:
 *  - renderer requests refer to files by opaque ids handed out by the main process
 *  - worker requests carry the real paths, resolved by the main process
 * The renderer never supplies a path, which is what keeps it inside the allow-list.
 */
import { z } from 'zod'

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Colours must be written as #RRGGBB.')
const pageIndex = z.number().int().min(0)
const pageList = z.array(pageIndex).min(1)
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)])
const pageSize = z.enum(['A4', 'Letter'])
const shortId = z.string().min(1).max(128)

export const pageNumbersSchema = z.strictObject({
  position: z.enum(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']),
  start: z.number().int().min(0).max(1_000_000),
  fontSize: z.number().min(4).max(96),
  color,
  format: z.enum(['n', 'page_n', 'n_of_total']),
  marginPt: z.number().min(0).max(200).optional(),
  pages: z.array(pageIndex).optional()
})
export type PageNumberSpec = z.infer<typeof pageNumbersSchema>

export const watermarkSchema = z.strictObject({
  text: z.string().min(1).max(500),
  fontSize: z.number().min(4).max(400),
  color,
  opacity: z.number().min(0.01).max(1),
  rotation: z.number().min(-360).max(360),
  position: z.enum([
    'center',
    'top-left',
    'top-center',
    'top-right',
    'middle-left',
    'middle-right',
    'bottom-left',
    'bottom-center',
    'bottom-right'
  ]),
  layer: z.enum(['foreground', 'background']),
  pages: z.array(pageIndex).optional()
})
export type WatermarkSpec = z.infer<typeof watermarkSchema>

export const overlaySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    pageIndex,
    x: z.number().min(-1).max(2),
    y: z.number().min(-1).max(2),
    w: z.number().min(0.001).max(3),
    h: z.number().min(0.001).max(3),
    pngBase64: z.string().min(1).max(40_000_000).optional(),
    imageSourceId: shortId.optional(),
    knockoutWhite: z.boolean().optional()
  }),
  z.strictObject({
    kind: z.literal('text'),
    pageIndex,
    x: z.number().min(-1).max(2),
    y: z.number().min(-1).max(2),
    text: z.string().min(1).max(5000),
    fontSize: z.number().min(4).max(200),
    color
  })
])
export type OverlaySpec = z.infer<typeof overlaySchema>

export const metadataSchema = z.strictObject({
  mode: z.enum(['edit', 'strip']),
  title: z.string().max(4000).optional(),
  author: z.string().max(4000).optional(),
  subject: z.string().max(4000).optional(),
  keywords: z.string().max(4000).optional()
})
export type MetadataSpec = z.infer<typeof metadataSchema>

export const outputPageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pdf'), sourceId: shortId, pageIndex, rotation }),
  z.strictObject({ kind: z.literal('image'), sourceId: shortId, rotation }),
  z.strictObject({ kind: z.literal('blank'), rotation })
])
export type OutputPageSpec = z.infer<typeof outputPageSchema>

export const assembleOptionsSchema = z.strictObject({
  pageSizing: z.enum(['preserve', 'fit']),
  fitSize: pageSize,
  blankSize: pageSize,
  imageFit: z.enum(['contain', 'cover']),
  keepAttachments: z.boolean().optional(),
  pageNumbers: pageNumbersSchema.optional(),
  metadata: metadataSchema.optional()
})
export type AssembleOptions = z.infer<typeof assembleOptionsSchema>

export const imageLayoutSchema = z.strictObject({
  pageSize: z.enum(['A4', 'Letter', 'image']),
  orientation: z.enum(['auto', 'portrait', 'landscape']),
  marginPt: z.number().min(0).max(200),
  fit: z.enum(['contain', 'cover'])
})
export type ImageLayout = z.infer<typeof imageLayoutSchema>

export const permissionsSchema = z.strictObject({
  print: z.boolean(),
  printHighQuality: z.boolean(),
  modify: z.boolean(),
  copy: z.boolean(),
  annotate: z.boolean(),
  fillForms: z.boolean(),
  assemble: z.boolean()
})
export type PermissionSpec = z.infer<typeof permissionsSchema>

const previewSize = z.number().int().min(64).max(2400)
const password = z.string().min(1).max(1024)

function opSchemas<
  S extends z.ZodType,
  P extends z.ZodType,
  O extends z.ZodType,
  F extends z.ZodType
>(source: S, probeSource: P, output: O, folder: F) {
  const applyFields = {
    source,
    imageSources: z.array(source).optional(),
    pageNumbers: pageNumbersSchema.optional(),
    watermark: watermarkSchema.optional(),
    overlays: z.array(overlaySchema).max(2000).optional(),
    metadata: metadataSchema.optional()
  }
  const op = <N extends string, T extends z.ZodType>(name: N, params: T) =>
    z.strictObject({ op: z.literal(name), params })

  return z.discriminatedUnion('op', [
    op('probe', z.strictObject({ source: probeSource })),
    op(
      'assemble',
      z.strictObject({
        sources: z.array(source),
        pages: z.array(outputPageSchema).min(1),
        options: assembleOptionsSchema,
        output
      })
    ),
    op(
      'preview_assemble',
      z.strictObject({
        sources: z.array(source),
        pages: z.array(outputPageSchema).min(1),
        options: assembleOptionsSchema,
        previewIndex: pageIndex,
        maxSize: previewSize
      })
    ),
    op(
      'split',
      z.strictObject({
        source,
        groups: z
          .array(z.strictObject({ name: z.string().min(1).max(255), pages: pageList }))
          .min(1)
          .max(100_000),
        folder
      })
    ),
    op(
      'compress',
      z.strictObject({ source, mode: z.enum(['lossless', 'balanced', 'strong', 'rasterize']), output })
    ),
    op(
      'pdf_to_images',
      z.strictObject({
        source,
        pages: pageList,
        format: z.enum(['png', 'jpg']),
        dpi: z.number().int().min(36).max(1200),
        jpegQuality: z.number().int().min(1).max(100).optional(),
        baseName: z.string().min(1).max(200),
        folder
      })
    ),
    op(
      'images_to_pdf',
      z.strictObject({
        sources: z.array(source).min(1),
        images: z.array(shortId).min(1),
        layout: imageLayoutSchema,
        output
      })
    ),
    op(
      'preview_images',
      z.strictObject({
        sources: z.array(source).min(1),
        images: z.array(shortId).min(1),
        layout: imageLayoutSchema,
        previewIndex: pageIndex,
        maxSize: previewSize
      })
    ),
    op('apply', z.strictObject({ ...applyFields, output })),
    op('preview_apply', z.strictObject({ ...applyFields, previewIndex: pageIndex, maxSize: previewSize })),
    op(
      'protect',
      z.strictObject({
        source,
        userPassword: password.optional(),
        ownerPassword: password.optional(),
        permissions: permissionsSchema.optional(),
        output
      })
    ),
    op('unprotect', z.strictObject({ source, output })),
    op('extract_text', z.strictObject({ source, pages: pageList })),
    op('save_text', z.strictObject({ text: z.string(), output }))
  ])
}

const rendererSource = z.strictObject({ id: shortId, password: z.string().max(1024).optional() })
const rendererOutput = z.strictObject({ outputId: shortId })
const rendererFolder = z.strictObject({
  folderId: shortId,
  overwrite: z.enum(['error', 'replace', 'rename'])
})

/** What the renderer may ask for. */
export const rendererJobSchema = opSchemas(rendererSource, rendererSource, rendererOutput, rendererFolder)
export type RendererJob = z.infer<typeof rendererJobSchema>
export type JobOp = RendererJob['op']

const workerSource = z.strictObject({
  id: shortId,
  path: z.string().min(1),
  password: z.string().max(1024).optional()
})
const workerProbeSource = workerSource.extend({ kind: z.enum(['pdf', 'image']) })
const workerOutput = z.strictObject({
  path: z.string().min(1),
  overwrite: z.enum(['error', 'replace', 'rename'])
})

/** What the worker receives once ids are resolved. Shared fixtures keep this in step with Python. */
export const workerJobSchema = opSchemas(workerSource, workerProbeSource, workerOutput, workerOutput)
export type WorkerJob = z.infer<typeof workerJobSchema>

/** Worker to host events. */
export const workerEventSchema = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    type: z.literal('ready'),
    worker: z.string(),
    pymupdf: z.string(),
    mupdf: z.string(),
    pillow: z.string(),
    pid: z.number().optional()
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('progress'),
    id: z.string(),
    done: z.number(),
    total: z.number(),
    stage: z.string().optional()
  }),
  z.object({ v: z.literal(1), type: z.literal('result'), id: z.string(), data: z.record(z.string(), z.unknown()) }),
  z.object({
    v: z.literal(1),
    type: z.literal('error'),
    id: z.string().nullable(),
    code: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional()
  }),
  z.object({ v: z.literal(1), type: z.literal('cancelled'), id: z.string() })
])
export type WorkerEvent = z.infer<typeof workerEventSchema>

export const settingsSchema = z.object({
  theme: z.enum(['dark', 'light']).default('dark'),
  defaultExportDir: z.string().nullable().default(null),
  defaultDpi: z.number().int().min(36).max(1200).default(200),
  defaultCompression: z.enum(['lossless', 'balanced', 'strong']).default('balanced'),
  recentFilesEnabled: z.boolean().default(false),
  thumbnailSize: z.number().int().min(90).max(260).default(132)
})
export type Settings = z.infer<typeof settingsSchema>

export const settingsPatchSchema = z
  .strictObject({
    theme: z.enum(['dark', 'light']),
    defaultDpi: z.number().int().min(36).max(1200),
    defaultCompression: z.enum(['lossless', 'balanced', 'strong']),
    recentFilesEnabled: z.boolean(),
    thumbnailSize: z.number().int().min(90).max(260)
  })
  .partial()
export type SettingsPatch = z.infer<typeof settingsPatchSchema>
