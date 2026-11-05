/** A page at a readable size, rendered from the real source file by pdf.js. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut } from 'lucide-react'
import { renderToCanvas } from '../lib/pdfEngine'
import { Banner, Button, IconButton, Modal } from './ui'

export interface PreviewPage {
  key: string
  kind: 'pdf' | 'image' | 'blank'
  sourceId?: string
  pageIndex?: number
  rotation: number
  title: string
  subtitle?: string
  blankSize?: { width: number; height: number }
}

export function PdfCanvas({
  sourceId,
  pageIndex,
  rotation,
  maxWidth,
  maxHeight,
  zoom = 1,
  onRendered,
  className
}: {
  sourceId: string
  pageIndex: number
  rotation?: number
  maxWidth: number
  maxHeight: number
  zoom?: number
  onRendered?: (size: { width: number; height: number; scale: number }) => void
  className?: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState(false)
  const notify = useRef(onRendered)
  notify.current = onRendered

  useEffect(() => {
    if (!canvas.current || maxWidth <= 0 || maxHeight <= 0) return
    setError(false)
    const task = renderToCanvas(canvas.current, sourceId, pageIndex, { maxWidth, maxHeight, zoom }, rotation ?? 0)
    task.promise.then(
      (rendered) => notify.current?.(rendered),
      (reason: Error) => {
        if (reason.name !== 'RenderingCancelledException' && reason.name !== 'AbortError') setError(true)
      }
    )
    return task.cancel
  }, [maxHeight, maxWidth, pageIndex, rotation, sourceId, zoom])

  if (error) return <Banner kind="error">This page could not be rendered.</Banner>
  return <canvas ref={canvas} className={className ?? 'block bg-white shadow-lg'} />
}

function ImagePage({ sourceId, rotation, maxWidth, maxHeight }: { sourceId: string; rotation: number; maxWidth: number; maxHeight: number }) {
  const turned = rotation % 180 !== 0
  return (
    <div className="flex items-center justify-center" style={{ width: maxWidth, height: maxHeight }}>
      <img
        src={window.paperforge.documentUrl(sourceId)}
        alt=""
        style={{
          maxWidth: turned ? maxHeight : maxWidth,
          maxHeight: turned ? maxWidth : maxHeight,
          transform: `rotate(${rotation}deg)`
        }}
        className="bg-white shadow-lg"
      />
    </div>
  )
}

export function PagePreviewModal({ pages, startIndex, onClose }: { pages: PreviewPage[]; startIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(startIndex)
  const [zoom, setZoom] = useState(1)
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const update = () => setSize({ width: element.clientWidth - 32, height: element.clientHeight - 32 })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const page = pages[index]
  const go = useCallback((delta: number) => setIndex((value) => Math.max(0, Math.min(pages.length - 1, value + delta))), [pages.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') go(-1)
      else if (event.key === 'ArrowRight') go(1)
      else if (event.key === '+' || event.key === '=') setZoom((value) => Math.min(4, value * 1.25))
      else if (event.key === '-') setZoom((value) => Math.max(0.5, value / 1.25))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [go])

  if (!page) return null
  return (
    <Modal
      title={`${page.title}${page.subtitle ? ` · ${page.subtitle}` : ''}`}
      onClose={onClose}
      width="max-w-[min(1100px,92vw)]"
      footer={
        <div className="flex w-full items-center justify-between">
          <div className="flex items-center gap-1">
            <IconButton label="Previous page" disabled={index === 0} onClick={() => go(-1)}>
              <ChevronLeft size={16} />
            </IconButton>
            <span className="min-w-20 text-center text-xs text-muted tabular-nums">
              {index + 1} of {pages.length}
            </span>
            <IconButton label="Next page" disabled={index === pages.length - 1} onClick={() => go(1)}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
          <div className="flex items-center gap-1">
            <IconButton label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, value / 1.25))}>
              <ZoomOut size={16} />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => setZoom(1)} className="min-w-14 tabular-nums" aria-label="Reset zoom">
              {Math.round(zoom * 100)}%
            </Button>
            <IconButton label="Zoom in" onClick={() => setZoom((value) => Math.min(4, value * 1.25))}>
              <ZoomIn size={16} />
            </IconButton>
          </div>
        </div>
      }
    >
      <div ref={viewport} className="flex h-[70vh] items-start justify-center overflow-auto rounded bg-app p-4" data-testid="page-preview">
        <div className="m-auto">
          {page.kind === 'pdf' && size.width > 0 && (
            <PdfCanvas sourceId={page.sourceId!} pageIndex={page.pageIndex!} rotation={page.rotation} maxWidth={size.width} maxHeight={size.height} zoom={zoom} />
          )}
          {page.kind === 'image' && size.width > 0 && <ImagePage sourceId={page.sourceId!} rotation={page.rotation} maxWidth={size.width * zoom} maxHeight={size.height * zoom} />}
          {page.kind === 'blank' && (
            <div className="bg-white shadow-lg" style={{ width: size.height * 0.707 * zoom, height: size.height * zoom, transform: `rotate(${page.rotation}deg)` }} />
          )}
        </div>
      </div>
    </Modal>
  )
}
