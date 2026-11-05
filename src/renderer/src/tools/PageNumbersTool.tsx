import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import type { PageNumberSpec } from '../../../shared/schemas'
import type { JobResult, RendererJob } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { ToolHeader } from '../components/Shell'
import { Button } from '../components/ui'
import { DEFAULT_NUMBERS, isValidNumbers, PageNumberFields } from '../components/PageNumberFields'
import { WorkerPreviewImage } from '../components/WorkerPreview'
import { NoDocument, OutputSummary, PageSelectionField, PageStepper, saveAndRun, SettingsPanel, SourcePicker, usePageSelection, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { stripExtension } from '../lib/format'

export default function PageNumbersTool() {
  const { entry, ready, select } = usePdfSource()
  const [spec, setSpec] = useState<PageNumberSpec>(DEFAULT_NUMBERS)
  const [previewIndex, setPreviewIndex] = useState(0)
  const [result, setResult] = useState<JobResult | null>(null)
  const pages = usePageSelection(entry?.info?.pageCount ?? 0)
  const gate = useSignatureGate(entry)
  const pageCount = entry?.info?.pageCount ?? 0

  useEffect(() => {
    setPreviewIndex(0)
    setResult(null)
  }, [entry?.id])

  const numberSpec: PageNumberSpec | null =
    isValidNumbers(spec) && pages.selection.ok ? { ...spec, ...(pages.selection.all ? {} : { pages: pages.selection.pages }) } : null
  const canRun = !!entry && !!numberSpec && gate.ok

  const previewJob: RendererJob | null =
    entry && numberSpec
      ? { op: 'preview_apply', params: { source: sourceRef(entry.id), pageNumbers: numberSpec, previewIndex: Math.min(previewIndex, pageCount - 1), maxSize: 900 } }
      : null

  const run = async () => {
    if (!entry || !numberSpec) return
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-numbered.pdf`,
      label: 'Page numbers',
      build: (outputId) => ({ op: 'apply', params: { source: sourceRef(entry.id), pageNumbers: numberSpec, output: { outputId } } })
    })
    if (done) setResult(done)
  }

  usePrimaryAction('Add page numbers', canRun, () => void run())

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="numbers-tool">
      <ToolHeader title="Page numbers" description="Numbers are added as real text. Everything else in the document stays as it is.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF to number">Choose where numbers go, how they read, and which pages get them.</NoDocument>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel>
            <PageNumberFields value={spec} onChange={setSpec} />
            <PageSelectionField state={pages} label="Number these pages" />
            {gate.notice}
            <Button variant="primary" icon={<Download size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="numbers-run">
              Choose location and save
            </Button>
            {result && <OutputSummary result={result} />}
          </SettingsPanel>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 bg-app p-4">
            <div className="min-h-0 flex-1">
              <WorkerPreviewImage job={previewJob} label={`Preview of page ${previewIndex + 1} with its number`} emptyText="Fix the settings to see a preview." />
            </div>
            <PageStepper index={Math.min(previewIndex, pageCount - 1)} count={pageCount} onChange={setPreviewIndex} />
          </div>
        </div>
      )}
    </div>
  )
}
