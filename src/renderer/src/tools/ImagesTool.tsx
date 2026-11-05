import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Download, FolderOpen, ImagePlus, Images, X } from 'lucide-react'
import type { ImageLayout } from '../../../shared/schemas'
import type { JobResult, RendererJob } from '../../../shared/types'
import { sourceRef, useWorkspace } from '../store/workspace'
import { useSettings } from '../store/settings'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, EmptyState, Field, IconButton, NumberInput, Segmented, Select } from '../components/ui'
import { PageThumb } from '../components/PageThumb'
import { WorkerPreviewImage } from '../components/WorkerPreview'
import { NoDocument, OutputSummary, PageSelectionField, PageStepper, runReporting, saveAndRun, SettingsPanel, SourcePicker, useFolderExport, usePageSelection, usePdfSource, usePrimaryAction } from '../components/toolKit'
import { plural, stripExtension } from '../lib/format'

export default function ImagesTool() {
  const [tab, setTab] = useState<'to-images' | 'to-pdf'>('to-images')
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ToolHeader title="PDF ↔ images" description="Convert pages to image files, or build a PDF from images.">
        <Segmented
          label="Direction"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'to-images', label: 'PDF to images' },
            { value: 'to-pdf', label: 'Images to PDF' }
          ]}
        />
      </ToolHeader>
      {tab === 'to-images' ? <PdfToImages /> : <ImagesToPdf />}
    </div>
  )
}

function PdfToImages() {
  const { entry, ready, select } = usePdfSource()
  const defaultDpi = useSettings((state) => state.settings.defaultDpi)
  const [format, setFormat] = useState<'png' | 'jpg'>('png')
  const [dpi, setDpi] = useState(defaultDpi)
  const [quality, setQuality] = useState(90)
  const [result, setResult] = useState<JobResult | null>(null)
  const [running, setRunning] = useState(false)
  const pages = usePageSelection(entry?.info?.pageCount ?? 0)
  const folderExport = useFolderExport()

  useEffect(() => setResult(null), [entry?.id])

  const dpiValid = Number.isInteger(dpi) && dpi >= 36 && dpi <= 1200
  const qualityValid = quality >= 1 && quality <= 100
  const canRun = !!entry && pages.selection.ok && pages.selection.pages.length > 0 && dpiValid && qualityValid && !running
  const baseName = entry ? stripExtension(entry.name).replace(/[<>:"/\\|?*]/g, '_').replace(/[. ]+$/, '') || 'page' : 'page'

  const run = async () => {
    if (!entry || !pages.selection.ok) return
    const target = await folderExport.pickFolder()
    if (!target) return
    const digits = String(entry.info!.pageCount).length
    const names = pages.selection.pages.map((index) => `${baseName}-page-${String(index + 1).padStart(digits, '0')}.${format}`)
    const policy = await folderExport.resolvePolicy(target, names)
    if (!policy) return
    setRunning(true)
    setResult(null)
    const done = await runReporting(
      {
        op: 'pdf_to_images',
        params: {
          source: sourceRef(entry.id),
          pages: pages.selection.pages,
          format,
          dpi,
          ...(format === 'jpg' ? { jpegQuality: quality } : {}),
          baseName,
          folder: { folderId: target.folderId, overwrite: policy }
        }
      },
      `Export images: ${entry.name}`
    )
    setRunning(false)
    if (done) setResult(done)
  }

  usePrimaryAction('Export images', canRun, () => void run())

  if (!entry) {
    return (
      <div className="min-h-0 flex-1">
        <div className="flex justify-end p-3">
          <SourcePicker entry={entry} ready={ready} select={select} />
        </div>
        <NoDocument title="Open a PDF to export its pages">Each page becomes one PNG or JPG file in a folder you choose.</NoDocument>
      </div>
    )
  }

  const sample = pages.selection.ok ? pages.selection.pages[0] : undefined
  const info = sample !== undefined ? entry.info!.pages[sample] : undefined
  const estimate = info ? `${Math.round((info.width * dpi) / 72)} × ${Math.round((info.height * dpi) / 72)} px` : null

  return (
    <div className="flex min-h-0 flex-1">
      <SettingsPanel>
        <SourcePicker entry={entry} ready={ready} select={select} />
        <PageSelectionField state={pages} />
        <Field label="Format">
          {() => (
            <Segmented
              label="Format"
              value={format}
              onChange={setFormat}
              options={[
                { value: 'png', label: 'PNG: lossless' },
                { value: 'jpg', label: 'JPG: smaller' }
              ]}
            />
          )}
        </Field>
        <Field label="Resolution (DPI)" error={dpiValid ? null : 'Between 36 and 1200.'} hint={estimate ? `First page: ${estimate}` : undefined}>
          {(id) => <NumberInput id={id} value={dpi} min={36} max={1200} step={10} onChange={setDpi} />}
        </Field>
        {format === 'jpg' && (
          <Field label="JPG quality" error={qualityValid ? null : 'Between 1 and 100.'}>
            {(id) => <NumberInput id={id} value={quality} min={1} max={100} onChange={setQuality} />}
          </Field>
        )}
        <Button variant="primary" icon={<FolderOpen size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="images-export">
          Choose folder and export {pages.selection.ok ? plural(pages.selection.pages.length, 'page') : ''}
        </Button>
        {result && <OutputSummary result={result} />}
      </SettingsPanel>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto bg-app p-4">
        <div className="flex flex-wrap gap-3">
          {(pages.selection.ok ? pages.selection.pages : []).slice(0, 60).map((index) => {
            const page = entry.info!.pages[index]
            return (
              <div key={index} className="text-center">
                <PageThumb sourceId={entry.id} pageIndex={index} aspect={page.width / page.height} rotation={0} box={{ width: 120, height: 160 }} />
                <span className="text-[11px] text-subtle tabular-nums">{index + 1}</span>
              </div>
            )
          })}
        </div>
      </div>
      {folderExport.dialog}
    </div>
  )
}

function ImagesToPdf() {
  const sources = useWorkspace((state) => state.sources)
  const importFiles = useWorkspace((state) => state.importWithDialog)
  const [images, setImages] = useState<{ key: number; id: string }[]>([])
  const [layout, setLayout] = useState<ImageLayout>({ pageSize: 'A4', orientation: 'auto', marginPt: 18, fit: 'contain' })
  const [previewIndex, setPreviewIndex] = useState(0)
  const [result, setResult] = useState<JobResult | null>(null)

  const add = async () => {
    const ids = await importFiles('image')
    setImages((current) => [...current, ...ids.map((id) => ({ key: Math.random(), id }))])
  }

  const usable = useMemo(() => images.filter((image) => sources[image.id]?.status === 'ready' && sources[image.id]?.kind === 'image'), [images, sources])
  const marginValid = layout.marginPt >= 0 && layout.marginPt <= 200
  const canRun = usable.length > 0 && marginValid
  const index = Math.min(previewIndex, Math.max(0, usable.length - 1))
  const set = <K extends keyof ImageLayout>(key: K, value: ImageLayout[K]) => setLayout((current) => ({ ...current, [key]: value }))

  const previewJob: RendererJob | null =
    canRun && usable[index]
      ? {
          op: 'preview_images',
          params: { sources: [sourceRef(usable[index].id)], images: [usable[index].id], layout, previewIndex: 0, maxSize: 800 }
        }
      : null

  const run = async () => {
    const ids = usable.map((image) => image.id)
    const first = sources[ids[0]]?.name
    const done = await saveAndRun({
      defaultName: first ? `${stripExtension(first)}.pdf` : 'images.pdf',
      label: 'Images to PDF',
      build: (outputId) => ({
        op: 'images_to_pdf',
        params: { sources: [...new Set(ids)].map(sourceRef), images: ids, layout, output: { outputId } }
      })
    })
    if (done) setResult(done)
  }

  usePrimaryAction('Create PDF', canRun, () => void run())

  const move = (position: number, delta: number) =>
    setImages((current) => {
      const next = [...current]
      const [item] = next.splice(position, 1)
      next.splice(position + delta, 0, item)
      return next
    })

  return (
    <div className="flex min-h-0 flex-1" data-testid="images-to-pdf">
      <SettingsPanel>
        <Button icon={<ImagePlus size={14} />} onClick={() => void add()} data-testid="images-add">
          Add JPG or PNG images
        </Button>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Page size">
            {(id) => (
              <Select
                id={id}
                value={layout.pageSize}
                onChange={(value) => set('pageSize', value)}
                options={[
                  { value: 'A4', label: 'A4' },
                  { value: 'Letter', label: 'US Letter' },
                  { value: 'image', label: 'Match each image' }
                ]}
              />
            )}
          </Field>
          <Field label="Orientation">
            {(id) => (
              <Select
                id={id}
                value={layout.orientation}
                onChange={(value) => set('orientation', value)}
                options={[
                  { value: 'auto', label: 'Match image' },
                  { value: 'portrait', label: 'Portrait' },
                  { value: 'landscape', label: 'Landscape' }
                ]}
              />
            )}
          </Field>
          <Field label="Margin (pt)" error={marginValid ? null : 'Between 0 and 200.'} hint="72 pt is 1 inch.">
            {(id) => <NumberInput id={id} value={layout.marginPt} min={0} max={200} onChange={(value) => set('marginPt', value)} />}
          </Field>
          <Field label="Fit" hint={layout.pageSize === 'image' ? 'Pages match the image.' : 'Aspect ratio is kept.'}>
            {(id) => (
              <Select
                id={id}
                value={layout.fit}
                onChange={(value) => set('fit', value)}
                options={[
                  { value: 'contain', label: 'Contain' },
                  { value: 'cover', label: 'Cover (crops)' }
                ]}
              />
            )}
          </Field>
        </div>
        <div className="min-h-0">
          <h3 className="mb-1 text-xs font-medium text-muted">{plural(images.length, 'image')}, in page order</h3>
          <ol className="space-y-1">
            {images.map((image, position) => {
              const entry = sources[image.id]
              const pageInfo = entry?.info?.pages[0]
              return (
                <li key={image.key} className="flex items-center gap-2 rounded-md border border-line bg-raised p-1" data-testid="image-item">
                  <button type="button" onClick={() => setPreviewIndex(position)} aria-label={`Preview ${entry?.name}`} className="shrink-0">
                    <PageThumb sourceId={image.id} pageIndex={null} aspect={pageInfo ? pageInfo.width / pageInfo.height : 1} rotation={0} box={{ width: 36, height: 36 }} />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-xs" title={entry?.name}>
                    {entry?.name}
                  </span>
                  <IconButton label="Move up" className="h-6 w-6" disabled={position === 0} onClick={() => move(position, -1)}>
                    <ArrowUp size={13} />
                  </IconButton>
                  <IconButton label="Move down" className="h-6 w-6" disabled={position === images.length - 1} onClick={() => move(position, 1)}>
                    <ArrowDown size={13} />
                  </IconButton>
                  <IconButton label="Remove" className="h-6 w-6" onClick={() => setImages((current) => current.filter((other) => other.key !== image.key))}>
                    <X size={13} />
                  </IconButton>
                </li>
              )
            })}
          </ol>
        </div>
        {images.length > usable.length && <Banner kind="warn">Some images could not be read, so they will be left out.</Banner>}
        <Button variant="primary" icon={<Download size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="images-create">
          Create PDF
        </Button>
        {result && <OutputSummary result={result} />}
      </SettingsPanel>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 bg-app p-4">
        {usable.length === 0 ? (
          <EmptyState icon={<Images size={32} />} title="Add images to build a PDF" action={<Button variant="primary" onClick={() => void add()}>Add images</Button>}>
            The preview here is drawn by the real export code, so it matches the final file.
          </EmptyState>
        ) : (
          <>
            <div className="min-h-0 flex-1">
              <WorkerPreviewImage job={previewJob} label={`Preview of page ${index + 1}`} />
            </div>
            <PageStepper index={index} count={usable.length} onChange={setPreviewIndex} />
          </>
        )}
      </div>
    </div>
  )
}
