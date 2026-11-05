import { useEffect, useMemo, useState } from 'react'
import { ClipboardCopy, FileText, Save } from 'lucide-react'
import { formatPageList } from '../../../shared/pageRanges'
import type { ExtractTextResult, JobResult } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { notify } from '../store/ui'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, Field, Select } from '../components/ui'
import { NoDocument, OutputSummary, PageSelectionField, runReporting, saveAndRun, SettingsPanel, SourcePicker, usePageSelection, usePdfSource, usePrimaryAction } from '../components/toolKit'
import { plural, stripExtension } from '../lib/format'

type Separator = 'none' | 'blank' | 'marker'

function joinPages(result: ExtractTextResult, separator: Separator): string {
  const parts = result.pages.map((page) => {
    if (separator === 'marker') return `--- Page ${page.index + 1} ---\n${page.text}`
    return page.text
  })
  return parts.join(separator === 'none' ? '\n' : '\n\n') + '\n'
}

const PREVIEW_LIMIT = 500_000

export default function TextTool() {
  const { entry, ready, select } = usePdfSource()
  const pages = usePageSelection(entry?.info?.pageCount ?? 0)
  const [separator, setSeparator] = useState<Separator>('marker')
  const [extracted, setExtracted] = useState<ExtractTextResult | null>(null)
  const [running, setRunning] = useState(false)
  const [saved, setSaved] = useState<JobResult | null>(null)

  useEffect(() => {
    setExtracted(null)
    setSaved(null)
  }, [entry?.id])

  const text = useMemo(() => (extracted ? joinPages(extracted, separator) : ''), [extracted, separator])
  const empty = useMemo(() => extracted?.pages.filter((page) => !page.hasText) ?? [], [extracted])
  const imageOnly = empty.filter((page) => page.hasImages)
  const blank = empty.filter((page) => !page.hasImages)
  const canRun = !!entry && pages.selection.ok && pages.selection.pages.length > 0 && !running

  const extract = async () => {
    if (!entry || !pages.selection.ok) return
    setRunning(true)
    setSaved(null)
    const done = await runReporting({ op: 'extract_text', params: { source: sourceRef(entry.id), pages: pages.selection.pages } }, `Extract text: ${entry.name}`)
    setRunning(false)
    if (done) setExtracted(done as ExtractTextResult)
  }

  const save = async () => {
    if (!entry) return
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}.txt`,
      filter: 'txt',
      label: 'Save text',
      build: (outputId) => ({ op: 'save_text', params: { text, output: { outputId } } })
    })
    if (done) setSaved(done)
  }

  usePrimaryAction(extracted ? 'Save text' : 'Extract', extracted ? true : canRun, () => void (extracted ? save() : extract()))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="text-tool">
      <ToolHeader title="Extract text" description="Read the text stored in a PDF. Scanned pages hold pictures of text and need OCR, which is not included.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF to read its text">Preview it here, then copy it or save it as a UTF-8 text file.</NoDocument>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel>
            <PageSelectionField state={pages} />
            <Button variant="primary" icon={<FileText size={14} />} disabled={!canRun} onClick={() => void extract()} data-testid="text-extract">
              {running ? 'Reading…' : 'Extract text'}
            </Button>
            <Field label="Between pages">
              {(id) => (
                <Select
                  id={id}
                  value={separator}
                  onChange={setSeparator}
                  options={[
                    { value: 'marker', label: 'Page marker: --- Page 1 ---' },
                    { value: 'blank', label: 'Blank line' },
                    { value: 'none', label: 'Nothing' }
                  ]}
                />
              )}
            </Field>
            {extracted && (
              <div className="flex gap-2">
                <Button
                  className="flex-1"
                  icon={<ClipboardCopy size={14} />}
                  data-testid="text-copy"
                  onClick={() => void window.paperforge.writeClipboard(text).then(() => notify('success', `Copied ${text.length.toLocaleString()} characters.`))}
                >
                  Copy
                </Button>
                <Button className="flex-1" icon={<Save size={14} />} onClick={() => void save()} data-testid="text-save">
                  Save as TXT
                </Button>
              </div>
            )}
            {saved && <OutputSummary result={saved} />}
            {imageOnly.length > 0 && (
              <Banner kind="warn">
                {plural(imageOnly.length, 'page')} ({formatPageList(imageOnly.map((page) => page.index))}) {imageOnly.length === 1 ? 'has' : 'have'} no extractable text but {imageOnly.length === 1 ? 'contains' : 'contain'} images. {imageOnly.length === 1 ? 'It is' : 'They are'} probably scanned, and would need OCR.
              </Banner>
            )}
            {blank.length > 0 && (
              <Banner>
                {plural(blank.length, 'page')} ({formatPageList(blank.map((page) => page.index))}) {blank.length === 1 ? 'has' : 'have'} no text or images.
              </Banner>
            )}
          </SettingsPanel>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-app p-4">
            {extracted ? (
              <>
                <textarea readOnly value={text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}\n\n[Preview shortened. Copy and Save include everything.]` : text} aria-label="Extracted text" data-testid="text-preview" className="selectable min-h-0 w-full flex-1 resize-none rounded-md border border-line bg-surface p-3 font-mono text-xs leading-relaxed text-fg" />
                <p className="mt-2 text-xs text-subtle">
                  {text.length.toLocaleString()} characters from {plural(extracted.pages.length, 'page')}
                </p>
              </>
            ) : (
              <p className="m-auto text-xs text-subtle">Extracted text appears here.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
