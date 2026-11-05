/** Export settings shared by Document Assembly and Merge: both run the same engine. */
import { useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { AssembleOptions, PageNumberSpec } from '../../../shared/schemas'
import type { OutputPage } from '../../../shared/assemblyModel'
import { buildPreservationReport } from '../../../shared/preservation'
import type { RendererJob } from '../../../shared/types'
import { sourceRef, useWorkspace } from '../store/workspace'
import { JobCancelledError, JobFailedError, runJob } from '../store/jobs'
import { notify } from '../store/ui'
import { plural } from '../lib/format'
import { Banner, Button, Field, IconButton, Modal, Segmented, Select, TextInput, Toggle } from './ui'
import { DEFAULT_NUMBERS, isValidNumbers, PageNumberFields } from './PageNumberFields'
import { WorkerPreviewImage } from './WorkerPreview'

export function outputPagesToSpec(pages: OutputPage[]) {
  return pages.map((page) => {
    if (page.kind === 'pdf') return { kind: 'pdf' as const, sourceId: page.sourceId, pageIndex: page.pageIndex, rotation: page.rotation }
    if (page.kind === 'image') return { kind: 'image' as const, sourceId: page.sourceId, rotation: page.rotation }
    return { kind: 'blank' as const, rotation: page.rotation }
  })
}

export async function runAssembleExport(pages: OutputPage[], options: AssembleOptions, defaultName: string, label: string): Promise<boolean> {
  const choice = await window.paperforge.chooseSaveTarget(defaultName, 'pdf')
  if (choice.status === 'cancelled') return false
  if (choice.status === 'rejected') {
    notify('error', choice.message)
    return false
  }
  const sourceIds = [...new Set(pages.flatMap((page) => (page.kind === 'blank' ? [] : [page.sourceId])))]
  try {
    const result = await runJob(
      {
        op: 'assemble',
        params: { sources: sourceIds.map(sourceRef), pages: outputPagesToSpec(pages), options, output: { outputId: choice.target.outputId } }
      },
      `${label}: ${choice.target.name}`
    )
    const count = result.outputs?.[0]?.pages ?? pages.length
    notify('success', `Exported ${plural(count, 'page')} to ${choice.target.name}. Reopened and verified.`)
    for (const warning of result.warnings ?? []) notify('warn', warning)
    return true
  } catch (error) {
    if (error instanceof JobFailedError) notify('error', error.message)
    else if (!(error instanceof JobCancelledError)) throw error
    return false
  }
}

export function ExportDialog({ pages, defaultName, label, onClose, onExported }: { pages: OutputPage[]; defaultName: string; label: string; onClose: () => void; onExported?: () => void }) {
  const sources = useWorkspace((state) => state.sources)
  const [pageSizing, setPageSizing] = useState<AssembleOptions['pageSizing']>('preserve')
  const [fitSize, setFitSize] = useState<AssembleOptions['fitSize']>('A4')
  const [blankSize, setBlankSize] = useState<AssembleOptions['blankSize']>('A4')
  const [imageFit, setImageFit] = useState<AssembleOptions['imageFit']>('contain')
  const [numbersOn, setNumbersOn] = useState(false)
  const [numbers, setNumbers] = useState<PageNumberSpec>(DEFAULT_NUMBERS)
  const [keepAttachments, setKeepAttachments] = useState(true)
  const [title, setTitle] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [previewIndex, setPreviewIndex] = useState(0)

  const sourceIds = useMemo(() => [...new Set(pages.flatMap((page) => (page.kind === 'blank' ? [] : [page.sourceId])))], [pages])
  const hasImages = pages.some((page) => page.kind === 'image')
  const hasBlank = pages.some((page) => page.kind === 'blank')

  const options: AssembleOptions = {
    pageSizing,
    fitSize,
    blankSize,
    imageFit,
    keepAttachments,
    ...(numbersOn ? { pageNumbers: numbers } : {}),
    ...(title.trim() ? { metadata: { mode: 'edit' as const, title: title.trim() } } : {})
  }

  const report = useMemo(
    () =>
      buildPreservationReport(
        sourceIds.map((id) => sources[id]).filter((entry) => entry?.kind === 'pdf').map((entry) => ({ name: entry.name, features: entry.info?.features, security: entry.info?.security })),
        pageSizing === 'fit' ? 'assemble-fit' : 'assemble-preserve'
      ),
    [pageSizing, sourceIds, sources]
  )

  const numbersValid = !numbersOn || isValidNumbers(numbers)
  const canExport = numbersValid && (!report.breaksSignatures || acknowledged)
  const clampedPreview = Math.min(previewIndex, pages.length - 1)

  const previewJob: RendererJob | null = numbersValid
    ? {
        op: 'preview_assemble',
        params: {
          sources: sourceIds.map(sourceRef),
          pages: outputPagesToSpec(pages),
          options: { ...options, metadata: undefined },
          previewIndex: clampedPreview,
          maxSize: 620
        }
      }
    : null

  const onExport = async () => {
    onClose()
    const exported = await runAssembleExport(pages, options, defaultName, label)
    if (exported) onExported?.()
  }

  return (
    <Modal
      title={`Export ${plural(pages.length, 'page')} as PDF`}
      onClose={onClose}
      width="max-w-[880px]"
      footer={
        <>
          <span className="mr-auto text-xs text-subtle">Next, choose a filename and location. Source files are never changed.</span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canExport} onClick={() => void onExport()} data-testid="export-confirm">
            Choose location and export
          </Button>
        </>
      }
    >
      <div className="grid gap-5 md:grid-cols-[1fr_270px]">
        <div className="space-y-4">
          <section className="space-y-2">
            <Field label="Page size">
              {() => (
                <Segmented
                  label="Page size"
                  value={pageSizing}
                  onChange={setPageSizing}
                  options={[
                    { value: 'preserve', label: 'Keep original sizes' },
                    { value: 'fit', label: 'Fit all to one size' }
                  ]}
                />
              )}
            </Field>
            {pageSizing === 'fit' && (
              <div className="max-w-52">
                <Field label="Fit pages to" hint="Pages turn to match their content's orientation.">
                  {(id) => <Select id={id} value={fitSize} onChange={setFitSize} options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'US Letter' }]} />}
                </Field>
              </div>
            )}
          </section>

          {(hasBlank || hasImages) && pageSizing === 'preserve' && (
            <div className="max-w-52">
              <Field label={hasImages ? 'Size for blank and image pages' : 'Size for blank pages'}>
                {(id) => <Select id={id} value={blankSize} onChange={setBlankSize} options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'US Letter' }]} />}
              </Field>
            </div>
          )}

          {hasImages && (
            <Field label="Image fit">
              {() => (
                <Segmented
                  label="Image fit"
                  value={imageFit}
                  onChange={setImageFit}
                  options={[
                    { value: 'contain', label: 'Contain: whole image visible' },
                    { value: 'cover', label: 'Cover: fill the page' }
                  ]}
                />
              )}
            </Field>
          )}

          <section className="space-y-3 rounded-md border border-line p-3">
            <Toggle checked={numbersOn} onChange={setNumbersOn} label="Add page numbers" />
            {numbersOn && <PageNumberFields value={numbers} onChange={setNumbers} />}
          </section>

          <Field label="Document title (optional)">{(id) => <TextInput id={id} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={400} />}</Field>
          <Toggle checked={keepAttachments} onChange={setKeepAttachments} label="Copy file attachments from source PDFs" />

          <section aria-label="What is preserved" className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted">What this export keeps</h3>
            {report.notes.map((note, index) => (
              <Banner key={index} kind={note.level}>
                {note.text}
              </Banner>
            ))}
            {report.breaksSignatures && (
              <div className="pt-1">
                <Toggle checked={acknowledged} onChange={setAcknowledged} label="I understand existing digital signatures will not remain valid in the output." />
              </div>
            )}
          </section>
        </div>

        <aside className="flex min-h-80 flex-col gap-2">
          <h3 className="text-xs font-medium text-muted">Output preview</h3>
          <div className="min-h-72 flex-1 rounded-md bg-app p-2">
            <WorkerPreviewImage job={previewJob} label={`Preview of output page ${clampedPreview + 1}`} />
          </div>
          <div className="flex items-center justify-center gap-1">
            <IconButton label="Previous output page" disabled={clampedPreview === 0} onClick={() => setPreviewIndex(clampedPreview - 1)}>
              <ChevronLeft size={16} />
            </IconButton>
            <span className="min-w-24 text-center text-xs text-muted tabular-nums">
              Page {clampedPreview + 1} of {pages.length}
            </span>
            <IconButton label="Next output page" disabled={clampedPreview >= pages.length - 1} onClick={() => setPreviewIndex(clampedPreview + 1)}>
              <ChevronRight size={16} />
            </IconButton>
          </div>
        </aside>
      </div>
    </Modal>
  )
}
