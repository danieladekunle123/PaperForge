import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import type { WatermarkSpec } from '../../../shared/schemas'
import type { JobResult, RendererJob } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, ColorInput, Field, NumberInput, Segmented, Select, TextInput } from '../components/ui'
import { WorkerPreviewImage } from '../components/WorkerPreview'
import { NoDocument, OutputSummary, PageSelectionField, PageStepper, saveAndRun, SettingsPanel, SourcePicker, usePageSelection, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { stripExtension } from '../lib/format'

const POSITIONS: { value: WatermarkSpec['position']; label: string }[] = [
  { value: 'center', label: 'Centre' },
  { value: 'top-left', label: 'Top left' },
  { value: 'top-center', label: 'Top centre' },
  { value: 'top-right', label: 'Top right' },
  { value: 'middle-left', label: 'Middle left' },
  { value: 'middle-right', label: 'Middle right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'bottom-center', label: 'Bottom centre' },
  { value: 'bottom-right', label: 'Bottom right' }
]

export default function WatermarkTool() {
  const { entry, ready, select } = usePdfSource()
  const [spec, setSpec] = useState<WatermarkSpec>({
    text: 'CONFIDENTIAL',
    fontSize: 56,
    color: '#c0392b',
    opacity: 0.25,
    rotation: 45,
    position: 'center',
    layer: 'foreground'
  })
  const [previewIndex, setPreviewIndex] = useState(0)
  const [result, setResult] = useState<JobResult | null>(null)
  const pages = usePageSelection(entry?.info?.pageCount ?? 0)
  const gate = useSignatureGate(entry)
  const pageCount = entry?.info?.pageCount ?? 0
  const set = <K extends keyof WatermarkSpec>(key: K, value: WatermarkSpec[K]) => setSpec((current) => ({ ...current, [key]: value }))

  useEffect(() => {
    setPreviewIndex(0)
    setResult(null)
  }, [entry?.id])

  const opacityValid = spec.opacity >= 0.01 && spec.opacity <= 1
  const sizeValid = spec.fontSize >= 4 && spec.fontSize <= 400
  const rotationValid = spec.rotation >= -360 && spec.rotation <= 360
  const valid = spec.text.trim().length > 0 && opacityValid && sizeValid && rotationValid && pages.selection.ok
  const finalSpec: WatermarkSpec | null = valid && pages.selection.ok ? { ...spec, ...(pages.selection.all ? {} : { pages: pages.selection.pages }) } : null
  const canRun = !!entry && !!finalSpec && gate.ok

  const previewJob: RendererJob | null =
    entry && finalSpec
      ? { op: 'preview_apply', params: { source: sourceRef(entry.id), watermark: finalSpec, previewIndex: Math.min(previewIndex, pageCount - 1), maxSize: 900 } }
      : null

  const run = async () => {
    if (!entry || !finalSpec) return
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-watermarked.pdf`,
      label: 'Watermark',
      build: (outputId) => ({ op: 'apply', params: { source: sourceRef(entry.id), watermark: finalSpec, output: { outputId } } })
    })
    if (done) setResult(done)
  }

  usePrimaryAction('Add watermark', canRun, () => void run())

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="watermark-tool">
      <ToolHeader title="Watermark" description="Stamp text across pages. The preview is drawn by the same code as the export.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF to watermark">Set the text, look and position, then apply it to some or all pages.</NoDocument>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel>
            <Field label="Text" error={spec.text.trim() ? null : 'Enter the watermark text.'}>
              {(id) => <TextInput id={id} value={spec.text} maxLength={500} onChange={(event) => set('text', event.target.value)} data-testid="watermark-text" />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Font size (pt)" error={sizeValid ? null : 'Between 4 and 400.'}>
                {(id) => <NumberInput id={id} value={spec.fontSize} min={4} max={400} onChange={(value) => set('fontSize', value)} />}
              </Field>
              <Field label="Colour">{(id) => <ColorInput id={id} value={spec.color} onChange={(value) => set('color', value)} />}</Field>
              <Field label="Opacity (%)" error={opacityValid ? null : 'Between 1 and 100.'}>
                {(id) => <NumberInput id={id} value={Math.round(spec.opacity * 100)} min={1} max={100} onChange={(value) => set('opacity', value / 100)} />}
              </Field>
              <Field label="Rotation (°)" hint="Anticlockwise" error={rotationValid ? null : 'Between -360 and 360.'}>
                {(id) => <NumberInput id={id} value={spec.rotation} min={-360} max={360} onChange={(value) => set('rotation', value)} />}
              </Field>
            </div>
            <Field label="Position">{(id) => <Select id={id} value={spec.position} onChange={(value) => set('position', value)} options={POSITIONS} />}</Field>
            <Field label="Placement">
              {() => (
                <Segmented
                  label="Placement"
                  value={spec.layer}
                  onChange={(value) => set('layer', value)}
                  options={[
                    { value: 'foreground', label: 'In front of content' },
                    { value: 'background', label: 'Behind content' }
                  ]}
                />
              )}
            </Field>
            {spec.layer === 'background' && <Banner>A watermark behind content is hidden wherever the page has opaque content, such as a scan or a full-page image. Use the preview to check.</Banner>}
            <PageSelectionField state={pages} label="Apply to" />
            {gate.notice}
            <Button variant="primary" icon={<Download size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="watermark-run">
              Choose location and save
            </Button>
            {result && <OutputSummary result={result} />}
          </SettingsPanel>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 bg-app p-4">
            <div className="min-h-0 flex-1">
              <WorkerPreviewImage job={previewJob} label={`Preview of page ${previewIndex + 1} with the watermark`} emptyText="Fix the settings to see a preview." />
            </div>
            <PageStepper index={Math.min(previewIndex, pageCount - 1)} count={pageCount} onChange={setPreviewIndex} />
          </div>
        </div>
      )}
    </div>
  )
}
