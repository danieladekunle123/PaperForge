import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, Scissors } from 'lucide-react'
import { emptySelection, clickSelection, type Selection } from '../../../shared/assemblyModel'
import { formatPageList } from '../../../shared/pageRanges'
import { planSplit, sanitizeBaseName, type SplitMode } from '../../../shared/splitPlan'
import type { JobResult } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { useSettings } from '../store/settings'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, Field, NumberInput, Segmented, TextInput } from '../components/ui'
import { PageGrid } from '../components/PageGrid'
import { PageThumb } from '../components/PageThumb'
import { NoDocument, OutputSummary, runReporting, SettingsPanel, SourcePicker, useFolderExport, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { plural, stripExtension } from '../lib/format'

export default function SplitTool() {
  const { entry, ready, select } = usePdfSource()
  const [mode, setMode] = useState<SplitMode>('ranges')
  const [ranges, setRanges] = useState('')
  const [every, setEvery] = useState(2)
  const [baseName, setBaseName] = useState('')
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [result, setResult] = useState<JobResult | null>(null)
  const [running, setRunning] = useState(false)
  const folderExport = useFolderExport()
  const gate = useSignatureGate(entry)
  const thumbnailSize = useSettings((state) => state.settings.thumbnailSize)
  const pageCount = entry?.info?.pageCount ?? 0

  const entryName = entry?.name
  useEffect(() => {
    setBaseName(entryName ? stripExtension(entryName) : '')
    setSelection(emptySelection())
    setResult(null)
    setRanges('')
  }, [entry?.id, entryName])

  const cells = useMemo(() => Array.from({ length: pageCount }, (_, i) => ({ id: String(i), pageIndex: i })), [pageCount])
  const selectedPages = useMemo(() => cells.filter((cell) => selection.ids.has(cell.id)).map((cell) => cell.pageIndex), [cells, selection])

  const plan = useMemo(() => {
    if (!entry) return null
    if (mode === 'ranges' && !ranges.trim()) return null
    return planSplit({ mode, baseName: baseName || entry.name, pageCount, selected: selectedPages, ranges, every })
  }, [baseName, entry, every, mode, pageCount, ranges, selectedPages])

  const groups = plan?.ok ? plan.groups : []
  const canRun = !!entry && groups.length > 0 && gate.ok && !running

  const run = async () => {
    if (!entry || !plan?.ok) return
    const target = await folderExport.pickFolder()
    if (!target) return
    const policy = await folderExport.resolvePolicy(target, groups.map((group) => group.name))
    if (!policy) return
    setRunning(true)
    setResult(null)
    const done = await runReporting(
      {
        op: 'split',
        params: { source: sourceRef(entry.id), groups, folder: { folderId: target.folderId, overwrite: policy } }
      },
      `Split: ${entry.name}`
    )
    setRunning(false)
    if (done) setResult(done)
  }

  usePrimaryAction('Split', canRun, () => void run())

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="split-tool">
      <ToolHeader title="Split & extract" description="Create new PDFs from parts of a document. The source stays as it is.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF to split">Pull out selected pages, split every page, cut by custom ranges, or split every N pages.</NoDocument>
      ) : (
        <div className="flex min-h-0 flex-1">
          <SettingsPanel>
            <Field label="How to split">
              {() => (
                <Segmented
                  label="How to split"
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'ranges', label: 'Custom ranges' },
                    { value: 'selected', label: 'Selected pages' },
                    { value: 'each', label: 'Every page' },
                    { value: 'every', label: 'Every N pages' }
                  ]}
                />
              )}
            </Field>
            {mode === 'ranges' && (
              <Field label="Ranges" hint="Each comma-separated part becomes one file, such as 1-3, 4-8, 9-12." error={plan && !plan.ok ? plan.error : null}>
                {(id) => <TextInput id={id} value={ranges} onChange={(event) => setRanges(event.target.value)} placeholder="1-3, 4-8, 9-" data-testid="split-ranges" />}
              </Field>
            )}
            {mode === 'selected' && (
              <p className="text-xs text-muted">{selectedPages.length ? `Selected: pages ${formatPageList(selectedPages)}` : 'Click pages on the right. Ctrl and Shift select several.'}</p>
            )}
            {mode === 'every' && (
              <Field label="Pages per file" error={plan && !plan.ok ? plan.error : null}>
                {(id) => <NumberInput id={id} value={every} min={1} max={pageCount || undefined} onChange={setEvery} />}
              </Field>
            )}
            <Field label="Filename starts with" hint={baseName !== sanitizeBaseName(baseName) && baseName ? `Invalid characters become underscores: ${sanitizeBaseName(baseName)}` : undefined}>
              {(id) => <TextInput id={id} value={baseName} onChange={(event) => setBaseName(event.target.value)} />}
            </Field>
            {gate.notice}
            <div>
              <h3 className="mb-1.5 text-xs font-medium text-muted" data-testid="split-count">
                {groups.length ? `Will create ${plural(groups.length, 'file')}` : 'Expected files appear here'}
              </h3>
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line bg-app p-2 text-xs" data-testid="split-plan">
                {groups.slice(0, 300).map((group) => (
                  <li key={group.name} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate font-mono" title={group.name}>
                      {group.name}
                    </span>
                    <span className="shrink-0 text-subtle tabular-nums">{plural(group.pages.length, 'pg', 'pgs')}</span>
                  </li>
                ))}
                {groups.length > 300 && <li className="text-subtle">and {groups.length - 300} more</li>}
                {groups.length === 0 && <li className="text-subtle">Nothing yet.</li>}
              </ul>
            </div>
            <Button variant="primary" icon={<FolderOpen size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="split-run">
              Choose folder and split
            </Button>
            {result && <OutputSummary result={result} />}
            <Banner>Bookmarks and links that point inside each output are kept. Attachments are not copied to split files.</Banner>
          </SettingsPanel>
          <div className="min-h-0 min-w-0 flex-1 bg-app">
            <PageGrid
              label={`Pages of ${entry.name}`}
              items={cells}
              cell={thumbnailSize}
              selected={mode === 'selected' ? selection.ids : new Set()}
              onItemClick={(cell, event) => {
                if (mode !== 'selected') setMode('selected')
                setSelection(clickSelection(selection, cells.map((item) => item.id), cell.id, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey }))
              }}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
                  event.preventDefault()
                  setMode('selected')
                  setSelection({ ids: new Set(cells.map((cell) => cell.id)), anchor: cells[0]?.id ?? null })
                }
              }}
              renderCell={(cell, _index, context) => {
                const info = entry.info!.pages[cell.pageIndex]
                return (
                  <>
                    <PageThumb sourceId={entry.id} pageIndex={cell.pageIndex} aspect={info.width / info.height} rotation={0} box={{ width: context.cell, height: context.boxHeight }} />
                    <div className="mt-1 text-[11px] text-muted tabular-nums">{cell.pageIndex + 1}</div>
                  </>
                )
              }}
              empty={<Scissors />}
            />
          </div>
        </div>
      )}
      {folderExport.dialog}
    </div>
  )
}
