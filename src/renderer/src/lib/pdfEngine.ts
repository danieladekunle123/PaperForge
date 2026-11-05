/**
 * pdf.js and image rendering, with hard limits on memory:
 *  - at most MAX_OPEN_DOCS documents stay parsed
 *  - thumbnails are a bounded LRU of small encoded blobs, never full-size bitmaps
 *  - rendering runs through a small LIFO queue, so visible pages win and scrolled-away ones are dropped
 */
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const assetBase = new URL('./pdfjs/', document.baseURI).href
const MAX_OPEN_DOCS = 6
const MAX_THUMBS = 600
const THUMB_LONG_EDGE = 340
const MAX_CONCURRENT = 2
const RANGE_CHUNK = 256 * 1024

export interface DocumentAccess {
  url: string
  sizeBytes: number
  password?: string
}

type AccessResolver = (sourceId: string) => DocumentAccess | undefined
let resolveAccess: AccessResolver = () => undefined

export function setAccessResolver(resolver: AccessResolver): void {
  resolveAccess = resolver
}

/** Reads ranges on demand, so a large PDF is not loaded whole just to draw a few thumbnails. */
class FileRangeTransport extends pdfjs.PDFDataRangeTransport {
  onFailure: () => void = () => undefined

  constructor(
    private readonly url: string,
    length: number
  ) {
    super(length, null)
  }

  requestDataRange(begin: number, end: number): void {
    void fetch(this.url, { headers: { Range: `bytes=${begin}-${end - 1}` } })
      .then((response) => {
        if (!response.ok) throw new Error(`Read failed with status ${response.status}`)
        return response.arrayBuffer()
      })
      .then((buffer) => this.onDataRange(begin, new Uint8Array(buffer)))
      // The transport has no error channel. If the file has gone, end the load so nothing waits forever.
      .catch(() => this.onFailure())
  }
}

interface OpenDoc {
  promise: Promise<PDFDocumentProxy>
  destroy: () => void
  users: number
  lastUsed: number
}

const openDocs = new Map<string, OpenDoc>()

function evictDocs(): void {
  if (openDocs.size <= MAX_OPEN_DOCS) return
  const idle = [...openDocs.entries()].filter(([, doc]) => doc.users === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  for (const [key, doc] of idle) {
    if (openDocs.size <= MAX_OPEN_DOCS) break
    doc.destroy()
    openDocs.delete(key)
  }
}

function acquire(sourceId: string): OpenDoc {
  let doc = openDocs.get(sourceId)
  if (!doc) {
    const access = resolveAccess(sourceId)
    if (!access) throw new Error('This document is not available.')
    const transport = new FileRangeTransport(access.url, access.sizeBytes)
    const task = pdfjs.getDocument({
      range: transport,
      password: access.password,
      cMapUrl: `${assetBase}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assetBase}standard_fonts/`,
      wasmUrl: `${assetBase}wasm/`,
      iccUrl: `${assetBase}iccs/`,
      disableAutoFetch: true,
      disableStream: true,
      rangeChunkSize: RANGE_CHUNK,
      enableXfa: false,
      useSystemFonts: false
    })
    transport.onFailure = () => {
      void task.destroy()
      openDocs.delete(sourceId)
    }
    doc = {
      promise: task.promise,
      destroy: () => void task.destroy(),
      users: 0,
      lastUsed: Date.now()
    }
    openDocs.set(sourceId, doc)
    evictDocs()
  }
  doc.users++
  doc.lastUsed = Date.now()
  return doc
}

/** Run with a document held open, so eviction cannot pull it away mid-render. */
async function withDocument<T>(sourceId: string, run: (doc: PDFDocumentProxy) => Promise<T>): Promise<T> {
  const held = acquire(sourceId)
  try {
    return await run(await held.promise)
  } finally {
    held.users--
    held.lastUsed = Date.now()
    evictDocs()
  }
}

export function closeDocument(sourceId: string): void {
  const doc = openDocs.get(sourceId)
  if (doc) {
    doc.destroy()
    openDocs.delete(sourceId)
  }
  for (const key of thumbs.keys()) {
    if (key.startsWith(`${sourceId}:`)) {
      URL.revokeObjectURL(thumbs.get(key)!)
      thumbs.delete(key)
    }
  }
}

const thumbs = new Map<string, string>()

function rememberThumb(key: string, url: string): void {
  thumbs.set(key, url)
  while (thumbs.size > MAX_THUMBS) {
    const oldest = thumbs.keys().next().value as string
    URL.revokeObjectURL(thumbs.get(oldest)!)
    thumbs.delete(oldest)
  }
}

function recallThumb(key: string): string | undefined {
  const url = thumbs.get(key)
  if (url) {
    // Reinsert to mark as recently used.
    thumbs.delete(key)
    thumbs.set(key, url)
  }
  return url
}

export function clearThumbnailCache(): void {
  for (const url of thumbs.values()) URL.revokeObjectURL(url)
  thumbs.clear()
}

interface RenderTaskEntry {
  run: () => Promise<void>
  cancelled: boolean
  cancelRunning?: () => void
}

const pending: RenderTaskEntry[] = []
let running = 0

function drain(): void {
  while (running < MAX_CONCURRENT && pending.length > 0) {
    const task = pending.pop()!
    if (task.cancelled) continue
    running++
    void task.run().finally(() => {
      running--
      drain()
    })
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Encoding failed'))), 'image/webp', 0.82)
  })
}

async function renderPdfThumb(sourceId: string, pageIndex: number, entry: RenderTaskEntry): Promise<string> {
  return withDocument(sourceId, async (doc) => {
    const page: PDFPageProxy = await doc.getPage(pageIndex + 1)
    const base = page.getViewport({ scale: 1 })
    const scale = THUMB_LONG_EDGE / Math.max(base.width, base.height)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    const task = page.render({ canvas, viewport })
    entry.cancelRunning = () => task.cancel()
    await task.promise
    page.cleanup()
    const blob = await canvasToBlob(canvas)
    canvas.width = canvas.height = 0
    return URL.createObjectURL(blob)
  })
}

async function renderImageThumb(sourceId: string): Promise<string> {
  const access = resolveAccess(sourceId)
  if (!access) throw new Error('This image is not available.')
  const response = await fetch(access.url)
  if (!response.ok) throw new Error('This image could not be read.')
  const bitmap = await createImageBitmap(await response.blob())
  const scale = Math.min(1, THUMB_LONG_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await canvasToBlob(canvas)
  return URL.createObjectURL(blob)
}

/** Request a thumbnail. The returned function abandons the request when the cell scrolls away. */
export function requestThumbnail(
  sourceId: string,
  pageIndex: number | null,
  onReady: (url: string) => void,
  onError: (message: string) => void
): () => void {
  const key = `${sourceId}:${pageIndex ?? 'image'}`
  const cached = recallThumb(key)
  if (cached) {
    onReady(cached)
    return () => undefined
  }
  const entry: RenderTaskEntry = {
    cancelled: false,
    run: async () => {
      if (entry.cancelled) return
      try {
        const url = pageIndex === null ? await renderImageThumb(sourceId) : await renderPdfThumb(sourceId, pageIndex, entry)
        rememberThumb(key, url)
        if (!entry.cancelled) onReady(url)
      } catch (error) {
        const name = (error as Error).name
        if (!entry.cancelled && name !== 'RenderingCancelledException') onError('Preview unavailable')
      }
    }
  }
  pending.push(entry)
  drain()
  return () => {
    entry.cancelled = true
    entry.cancelRunning?.()
  }
}

export interface RenderedPage {
  width: number
  height: number
  /** CSS pixels per PDF point at scale 1. */
  scale: number
}

/**
 * Draw a page at a readable size into a canvas. ``extraRotation`` is added to the page's own.
 * Returns a cancel function along with the result promise.
 */
export function renderToCanvas(
  canvas: HTMLCanvasElement,
  sourceId: string,
  pageIndex: number,
  fit: { maxWidth: number; maxHeight: number; zoom?: number },
  extraRotation = 0
): { promise: Promise<RenderedPage>; cancel: () => void } {
  let cancelled = false
  let cancelTask: (() => void) | undefined
  const promise = withDocument(sourceId, async (doc) => {
    const page = await doc.getPage(pageIndex + 1)
    const rotation = (page.rotate + extraRotation) % 360
    const base = page.getViewport({ scale: 1, rotation })
    const scale = Math.min(fit.maxWidth / base.width, fit.maxHeight / base.height) * (fit.zoom ?? 1)
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = page.getViewport({ scale: scale * dpr, rotation })
    if (cancelled) throw new DOMException('Cancelled', 'AbortError')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    canvas.style.width = `${Math.round(viewport.width / dpr)}px`
    canvas.style.height = `${Math.round(viewport.height / dpr)}px`
    const task = page.render({ canvas, viewport })
    cancelTask = () => task.cancel()
    await task.promise
    page.cleanup()
    return { width: viewport.width / dpr, height: viewport.height / dpr, scale }
  })
  return {
    promise,
    cancel: () => {
      cancelled = true
      cancelTask?.()
    }
  }
}
