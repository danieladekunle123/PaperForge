/**
 * Visual signatures and text annotations. Items are stored in normalised page coordinates, in the
 * frame of the page as shown, and the worker maps those through the page's rotation and crop box.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Download, Eraser, ImagePlus, PenLine, Trash2, Type } from 'lucide-react'
import type { OverlaySpec } from '../../../shared/schemas'
import type { JobResult } from '../../../shared/types'
import { sourceRef, useWorkspace } from '../store/workspace'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, ColorInput, cx, Field, IconButton, Modal, NumberInput, Toggle } from '../components/ui'
import { PdfCanvas } from '../components/PagePreview'
import { NoDocument, OutputSummary, PageStepper, saveAndRun, SettingsPanel, SourcePicker, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { plural, stripExtension } from '../lib/format'

type Item = { key: number; pageIndex: number; x: number; y: number } & (
  | { kind: 'drawn'; w: number; h: number; pngBase64: string }
  | { kind: 'imported'; w: number; h: number; sourceId: string; knockout: boolean }
  | { kind: 'text'; text: string; fontSize: number; color: string }
)

let nextKey = 1

function SignaturePad({ onDone, onClose }: { onDone: (png: string, aspect: number) => void; onClose: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [color, setColor] = useState('#10204a')
  const [hasInk, setHasInk] = useState(false)
  const WIDTH = 880
  const HEIGHT = 300

  const point = (event: ReactPointerEvent) => {
    const box = canvas.current!.getBoundingClientRect()
    return { x: ((event.clientX - box.left) / box.width) * WIDTH, y: ((event.clientY - box.top) / box.height) * HEIGHT }
  }

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    const ctx = canvas.current!.getContext('2d')!
    ctx.strokeStyle = color
    ctx.lineWidth = 4.5
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }

  const clear = () => {
    canvas.current!.getContext('2d')!.clearRect(0, 0, WIDTH, HEIGHT)
    setHasInk(false)
  }

  /** Trim transparent edges so the placed signature box hugs the ink. */
  const finish = () => {
    const source = canvas.current!
    const { data } = source.getContext('2d')!.getImageData(0, 0, WIDTH, HEIGHT)
    let minX = WIDTH
    let minY = HEIGHT
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        if (data[(y * WIDTH + x) * 4 + 3] > 8) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return
    const margin = 6
    const left = Math.max(0, minX - margin)
    const top = Math.max(0, minY - margin)
    const width = Math.min(WIDTH, maxX + margin + 1) - left
    const height = Math.min(HEIGHT, maxY + margin + 1) - top
    const out = document.createElement('canvas')
    out.width = width
    out.height = height
    out.getContext('2d')!.drawImage(source, left, top, width, height, 0, 0, width, height)
    onDone(out.toDataURL('image/png').split(',')[1], width / height)
  }

  return (
    <Modal
      title="Draw your signature"
      onClose={onClose}
      width="max-w-2xl"
      footer={
        <>
          <div className="mr-auto">
            <ColorInput value={color} onChange={setColor} />
          </div>
          <Button icon={<Eraser size={14} />} onClick={clear} disabled={!hasInk}>
            Clear
          </Button>
          <Button variant="primary" disabled={!hasInk} onClick={finish} data-testid="signature-done">
            Use signature
          </Button>
        </>
      }
    >
      <canvas
        ref={canvas}
        width={WIDTH}
        height={HEIGHT}
        data-testid="signature-pad"
        aria-label="Signature drawing area"
        className="w-full cursor-crosshair touch-none rounded-md border border-line bg-white"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          drawing.current = true
          last.current = point(event)
        }}
        onPointerMove={(event) => {
          if (!drawing.current || !last.current) return
          const next = point(event)
          stroke(last.current, next)
          last.current = next
          setHasInk(true)
        }}
        onPointerUp={() => {
          drawing.current = false
          last.current = null
        }}
      />
      <p className="mt-2 text-xs text-subtle">Draw with a mouse, pen or touch. The saved image has a transparent background.</p>
    </Modal>
  )
}

export default function SignTool() {
  const { entry, ready, select } = usePdfSource()
  const importFiles = useWorkspace((state) => state.importWithDialog)
  const sources = useWorkspace((state) => state.sources)
  const [items, setItems] = useState<Item[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [drawing, setDrawing] = useState(false)
  const [rendered, setRendered] = useState<{ width: number; height: number; scale: number } | null>(null)
  const [result, setResult] = useState<JobResult | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  const gate = useSignatureGate(entry)
  const pageCount = entry?.info?.pageCount ?? 0

  useEffect(() => {
    setItems([])
    setSelected(null)
    setPageIndex(0)
    setResult(null)
  }, [entry?.id])

  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const update = () => setBounds({ width: element.clientWidth - 40, height: element.clientHeight - 40 })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [entry?.id])

  const pageInfo = entry?.info?.pages[pageIndex]
  const pageAspect = pageInfo ? pageInfo.width / pageInfo.height : 1

  const place = useCallback(
    (make: (key: number) => Item) => {
      const key = nextKey++
      setItems((current) => [...current, make(key)])
      setSelected(key)
    },
    []
  )

  const addDrawn = (png: string, aspect: number) => {
    setDrawing(false)
    const w = 0.3
    place((key) => ({ key, kind: 'drawn', pageIndex, x: 0.55, y: 0.78, w, h: (w * pageAspect) / aspect, pngBase64: png }))
  }

  const addImported = async () => {
    const ids = await importFiles('image')
    const id = ids[ids.length - 1]
    if (!id) return
    const info = useWorkspace.getState().sources[id]?.info?.pages[0]
    if (!info) return
    const aspect = info.width / info.height
    const w = 0.3
    place((key) => ({ key, kind: 'imported', pageIndex, x: 0.55, y: 0.78, w, h: (w * pageAspect) / aspect, sourceId: id, knockout: true }))
  }

  const addText = () => place((key) => ({ key, kind: 'text', pageIndex, x: 0.1, y: 0.1, text: 'Text note', fontSize: 14, color: '#000000' }))

  const patch = (key: number, change: Partial<Item>) => setItems((current) => current.map((item) => (item.key === key ? ({ ...item, ...change } as Item) : item)))

  const removeItem = (key: number) => {
    setItems((current) => current.filter((item) => item.key !== key))
    setSelected((value) => (value === key ? null : value))
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Delete' && selected !== null) removeItem(selected)
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected])

  const startMove = (event: ReactPointerEvent, item: Item) => {
    if (!rendered) return
    event.preventDefault()
    event.stopPropagation()
    setSelected(item.key)
    const startX = event.clientX
    const startY = event.clientY
    const { x: originX, y: originY } = item
    const move = (e: PointerEvent) => {
      patch(item.key, { x: originX + (e.clientX - startX) / rendered.width, y: originY + (e.clientY - startY) / rendered.height })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startResize = (event: ReactPointerEvent, item: Item & { w: number; h: number }) => {
    if (!rendered) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const { w, h } = item
    const ratio = h / w
    const move = (e: PointerEvent) => {
      const nextW = Math.max(0.03, w + (e.clientX - startX) / rendered.width)
      patch(item.key, { w: nextW, h: nextW * ratio })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const textOk = items.every((item) => item.kind !== 'text' || (item.text.trim().length > 0 && item.fontSize >= 4 && item.fontSize <= 200))
  const canRun = !!entry && items.length > 0 && textOk && gate.ok

  const run = async () => {
    if (!entry) return
    const overlays: OverlaySpec[] = items.map((item) => {
      if (item.kind === 'text') return { kind: 'text', pageIndex: item.pageIndex, x: item.x, y: item.y, text: item.text, fontSize: item.fontSize, color: item.color }
      if (item.kind === 'drawn') return { kind: 'image', pageIndex: item.pageIndex, x: item.x, y: item.y, w: item.w, h: item.h, pngBase64: item.pngBase64 }
      return { kind: 'image', pageIndex: item.pageIndex, x: item.x, y: item.y, w: item.w, h: item.h, imageSourceId: item.sourceId, knockoutWhite: item.knockout }
    })
    const imageIds = [...new Set(items.flatMap((item) => (item.kind === 'imported' ? [item.sourceId] : [])))]
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-signed-visual.pdf`,
      label: 'Visual signature',
      build: (outputId) => ({
        op: 'apply',
        params: { source: sourceRef(entry.id), ...(imageIds.length ? { imageSources: imageIds.map(sourceRef) } : {}), overlays, output: { outputId } }
      })
    })
    if (done) setResult(done)
  }

  usePrimaryAction('Save signed copy', canRun, () => void run())

  const selectedItem = items.find((item) => item.key === selected)
  const pageItems = items.filter((item) => item.pageIndex === pageIndex)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="sign-tool">
      <ToolHeader title="Visual signature & annotations" description="Places a picture of a signature or text on the page.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF to sign visually">Draw or import a signature, drag it into place, resize it, and save a new copy.</NoDocument>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel>
            <Banner kind="warn">
              <strong className="font-semibold">This is a visual signature only.</strong> It is an image on the page. It is not a cryptographic signature, it does not verify who signed, and it does not protect the document from later changes.
            </Banner>
            <div className="grid grid-cols-1 gap-2">
              <Button icon={<PenLine size={14} />} onClick={() => setDrawing(true)} data-testid="sign-draw">
                Draw a signature
              </Button>
              <Button icon={<ImagePlus size={14} />} onClick={() => void addImported()}>
                Import a signature image
              </Button>
              <Button icon={<Type size={14} />} onClick={addText} data-testid="sign-text">
                Add text
              </Button>
            </div>

            {selectedItem && selectedItem.kind === 'text' && (
              <div className="space-y-3 rounded-md border border-line p-3">
                <Field label="Text" error={selectedItem.text.trim() ? null : 'Enter some text.'}>
                  {(id) => <textarea id={id} rows={3} value={selectedItem.text} onChange={(event) => patch(selectedItem.key, { text: event.target.value })} className="w-full rounded-md border border-line bg-app p-2 text-fg" data-testid="sign-text-input" />}
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Size (pt)">{(id) => <NumberInput id={id} value={selectedItem.fontSize} min={4} max={200} onChange={(value) => patch(selectedItem.key, { fontSize: value })} />}</Field>
                  <Field label="Colour">{(id) => <ColorInput id={id} value={selectedItem.color} onChange={(value) => patch(selectedItem.key, { color: value })} />}</Field>
                </div>
              </div>
            )}
            {selectedItem && selectedItem.kind === 'imported' && (
              <div className="rounded-md border border-line p-3">
                <Toggle checked={selectedItem.knockout} onChange={(value) => patch(selectedItem.key, { knockout: value })} label="Make white background transparent" hint="Useful for a scanned signature on white paper." />
              </div>
            )}

            <div>
              <h3 className="mb-1 text-xs font-medium text-muted">{plural(items.length, 'item')} placed</h3>
              <ul className="space-y-1">
                {items.map((item) => (
                  <li key={item.key} className={cx('flex items-center gap-2 rounded-md border px-2 py-1 text-xs', selected === item.key ? 'border-accent' : 'border-line')}>
                    <button
                      type="button"
                      className="min-w-0 flex-1 truncate text-left"
                      onClick={() => {
                        setPageIndex(item.pageIndex)
                        setSelected(item.key)
                      }}
                    >
                      {item.kind === 'text' ? `“${item.text}”` : item.kind === 'drawn' ? 'Drawn signature' : (sources[item.sourceId]?.name ?? 'Image')} · page {item.pageIndex + 1}
                    </button>
                    <IconButton label="Remove item" className="h-6 w-6" onClick={() => removeItem(item.key)}>
                      <Trash2 size={13} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </div>

            {gate.notice}
            <Button variant="primary" icon={<Download size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="sign-save">
              Choose location and save
            </Button>
            {result && <OutputSummary result={result} />}
            <Banner>Signatures and text are written into the page content of the new copy, so they cannot be moved afterwards.</Banner>
          </SettingsPanel>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app">
            <div ref={stage} className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-5" onPointerDown={() => setSelected(null)}>
              {bounds.width > 0 && (
                <div className="relative" data-testid="sign-stage" style={rendered ? { width: rendered.width, height: rendered.height } : undefined}>
                  <PdfCanvas sourceId={entry.id} pageIndex={pageIndex} maxWidth={bounds.width} maxHeight={bounds.height} onRendered={setRendered} />
                  {rendered &&
                    pageItems.map((item) =>
                      item.kind === 'text' ? (
                        <div
                          key={item.key}
                          data-testid="placed-item"
                          onPointerDown={(event) => startMove(event, item)}
                          className={cx('absolute cursor-move whitespace-pre outline-offset-1', selected === item.key ? 'outline-2 outline-accent' : 'outline-1 outline-transparent hover:outline-line-strong')}
                          style={{
                            left: item.x * rendered.width,
                            top: item.y * rendered.height,
                            fontFamily: 'Helvetica, Arial, sans-serif',
                            fontSize: item.fontSize * rendered.scale,
                            color: item.color,
                            lineHeight: 1.25
                          }}
                        >
                          {item.text}
                        </div>
                      ) : (
                        <div
                          key={item.key}
                          data-testid="placed-item"
                          onPointerDown={(event) => startMove(event, item)}
                          className={cx('absolute cursor-move', selected === item.key ? 'outline-2 outline-accent' : 'outline-1 outline-transparent hover:outline-line-strong')}
                          style={{ left: item.x * rendered.width, top: item.y * rendered.height, width: item.w * rendered.width, height: item.h * rendered.height }}
                        >
                          <img
                            src={item.kind === 'drawn' ? `data:image/png;base64,${item.pngBase64}` : window.paperforge.documentUrl(item.sourceId)}
                            alt="Signature"
                            draggable={false}
                            className="h-full w-full"
                            style={item.kind === 'imported' && item.knockout ? { mixBlendMode: 'multiply' } : undefined}
                          />
                          {selected === item.key && (
                            <span
                              role="presentation"
                              data-testid="resize-handle"
                              onPointerDown={(event) => startResize(event, item)}
                              className="absolute -right-1.5 -bottom-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-accent"
                            />
                          )}
                        </div>
                      )
                    )}
                </div>
              )}
            </div>
            <div className="shrink-0 border-t border-line py-1.5">
              <PageStepper
                index={pageIndex}
                count={pageCount}
                onChange={(value) => {
                  setRendered(null)
                  setPageIndex(value)
                }}
              />
            </div>
          </div>
        </div>
      )}
      {drawing && <SignaturePad onDone={addDrawn} onClose={() => setDrawing(false)} />}
    </div>
  )
}
