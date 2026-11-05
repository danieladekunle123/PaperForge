/** Building blocks shared by the single-document tools. */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, FileUp, FolderOpen } from 'lucide-react'
import { parsePageRanges } from '../../../shared/pageRanges'
import { buildPreservationReport, type OperationKind } from '../../../shared/preservation'
import type { FolderTarget, JobResult, RendererJob, SaveFilter } from '../../../shared/types'
import { JobCancelledError, JobFailedError, runJob } from '../store/jobs'
import { notify, useUi } from '../store/ui'
import { readySources, useWorkspace, type SourceEntry } from '../store/workspace'
import { Banner, Button, EmptyState, Field, IconButton, Modal, Segmented, Select, TextInput, Toggle } from './ui'
import { formatBytes, plural } from '../lib/format'

/** Keep a current PDF across tool switches, defaulting to the most recently imported. */
export function usePdfSource() {
  const sources = useWorkspace((state) => state.sources)
  const order = useWorkspace((state) => state.order)
  const ready = useMemo(() => readySources(sources, order, 'pdf'), [order, sources])
  const [selected, setSelected] = useState<string | null>(lastUsedPdf)
  const entry = (selected ? sources[selected] : undefined) ?? ready[ready.length - 1]
  const current = entry?.status === 'ready' && entry.kind === 'pdf' ? entry : ready[ready.length - 1]

  const select = (id: string) => {
    lastUsedPdf = id
    setSelected(id)
  }
  useEffect(() => {
    if (current) lastUsedPdf = current.id
  }, [current])
  return { entry: current as SourceEntry | undefined, ready, select }
}

let lastUsedPdf: string | null = null

export function SourcePicker({ entry, ready, select }: { entry: SourceEntry | undefined; ready: SourceEntry[]; select: (id: string) => void }) {
  const importFiles = useWorkspace((state) => state.importWithDialog)
  const open = async () => {
    const ids = await importFiles('pdf')
    const last = ids[ids.length - 1]
    if (last) select(last)
  }
  return (
    <div className="flex items-center gap-2">
      {ready.length > 0 && entry && (
        <Select
          aria-label="Document"
          className="w-64 max-w-[40vw]"
          value={entry.id}
          onChange={select}
          options={ready.map((source) => ({ value: source.id, label: `${source.name} (${plural(source.info?.pageCount ?? 0, 'page')})` }))}
        />
      )}
      <Button icon={<FileUp size={14} />} onClick={() => void open()} data-testid="tool-open-pdf">
        Open PDF
      </Button>
    </div>
  )
}

export function NoDocument({ title, children }: { title: string; children: ReactNode }) {
  const importFiles = useWorkspace((state) => state.importWithDialog)
  return (
    <EmptyState
      icon={<FileUp size={30} />}
      title={title}
      action={
        <Button variant="primary" onClick={() => void importFiles('pdf')}>
          Open a PDF
        </Button>
      }
    >
      {children}
    </EmptyState>
  )
}

export type PageSelection = { ok: true; pages: number[]; all: boolean } | { ok: false; error: string }

/** All pages or a typed range, with validation in the user's terms. */
export function usePageSelection(pageCount: number) {
  const [mode, setMode] = useState<'all' | 'range'>('all')
  const [text, setText] = useState('')
  const selection: PageSelection = useMemo(() => {
    if (mode === 'all') {
      return { ok: true, pages: Array.from({ length: pageCount }, (_, i) => i), all: true }
    }
    const parsed = parsePageRanges(text, pageCount)
    return parsed.ok ? { ok: true, pages: [...new Set(parsed.pages)].sort((a, b) => a - b), all: false } : parsed
  }, [mode, pageCount, text])
  return { mode, setMode, text, setText, selection }
}

export function PageSelectionField({ state, label = 'Pages' }: { state: ReturnType<typeof usePageSelection>; label?: string }) {
  const { mode, setMode, text, setText, selection } = state
  return (
    <div className="space-y-2">
      <Field label={label}>
        {() => (
          <Segmented
            label={label}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'all', label: 'All pages' },
              { value: 'range', label: 'Choose pages' }
            ]}
          />
        )}
      </Field>
      {mode === 'range' && (
        <Field label="Page numbers" error={text.trim() && !selection.ok ? selection.error : null} hint="For example 1-3, 7, 9-">
          {(id) => <TextInput id={id} value={text} placeholder="1-3, 7, 9-" onChange={(event) => setText(event.target.value)} data-testid="pages-input" />}
        </Field>
      )}
    </div>
  )
}

export function PageStepper({ index, count, onChange }: { index: number; count: number; onChange: (index: number) => void }) {
  return (
    <div className="flex items-center justify-center gap-1">
      <IconButton label="Previous page" disabled={index <= 0} onClick={() => onChange(index - 1)}>
        <ChevronLeft size={16} />
      </IconButton>
      <span className="min-w-24 text-center text-xs text-muted tabular-nums">
        Page {index + 1} of {count}
      </span>
      <IconButton label="Next page" disabled={index >= count - 1} onClick={() => onChange(index + 1)}>
        <ChevronRight size={16} />
      </IconButton>
    </div>
  )
}

/** Choose a destination, run the job and report the outcome. Resolves to null if it did not finish. */
export async function saveAndRun(options: {
  defaultName: string
  filter?: SaveFilter
  label: string
  build: (outputId: string) => RendererJob
}): Promise<JobResult | null> {
  const choice = await window.paperforge.chooseSaveTarget(options.defaultName, options.filter ?? 'pdf')
  if (choice.status === 'cancelled') return null
  if (choice.status === 'rejected') {
    notify('error', choice.message)
    return null
  }
  return runReporting(options.build(choice.target.outputId), `${options.label}: ${choice.target.name}`)
}

export async function runReporting(job: RendererJob, label: string): Promise<JobResult | null> {
  try {
    const result = await runJob(job, label)
    for (const warning of result.warnings ?? []) notify('warn', warning)
    return result
  } catch (error) {
    if (error instanceof JobFailedError) notify('error', error.message)
    else if (!(error instanceof JobCancelledError)) throw error
    return null
  }
}

/** Register the tool's main action for Ctrl+S. */
export function usePrimaryAction(label: string, enabled: boolean, run: () => void): void {
  const setPrimary = useUi((state) => state.setPrimary)
  useEffect(() => {
    setPrimary({ label, enabled, run })
    return () => setPrimary(null)
  })
}

/** A warning for signed documents that must be acknowledged before the tool can write output. */
export function useSignatureGate(entry: SourceEntry | undefined, operation: OperationKind = 'whole-document') {
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => setAcknowledged(false), [entry?.id])
  const report = entry ? buildPreservationReport([{ name: entry.name, features: entry.info?.features, security: entry.info?.security }], operation) : null
  const needsAck = report?.breaksSignatures ?? false
  const notice = report?.notes.length ? (
    <div className="space-y-1.5">
      {report.notes.map((note, index) => (
        <Banner key={index} kind={note.level}>
          {note.text}
        </Banner>
      ))}
      {needsAck && <Toggle checked={acknowledged} onChange={setAcknowledged} label="I understand existing digital signatures will not remain valid in the output." />}
    </div>
  ) : null
  return { notice, ok: !needsAck || acknowledged }
}

export function OutputSummary({ result, extra }: { result: JobResult; extra?: ReactNode }) {
  const outputs = result.outputs ?? []
  if (outputs.length === 0) return null
  return (
    <Banner kind="success">
      <p>
        {plural(outputs.length, 'file')} written{result.verified ? ', reopened and verified' : ''}.
      </p>
      {outputs.length === 1 && <p className="selectable mt-0.5 break-all text-muted">{outputs[0].path} · {formatBytes(outputs[0].sizeBytes)}</p>}
      {extra}
      <Button size="sm" className="mt-2" icon={<FolderOpen size={13} />} onClick={() => void window.paperforge.revealOutput(outputs[0].path)}>
        Show in folder
      </Button>
    </Banner>
  )
}

export function CollisionDialog({ names, onResolve }: { names: string[]; onResolve: (choice: 'replace' | 'rename' | null) => void }) {
  return (
    <Modal
      title={`${plural(names.length, 'file')} already ${names.length === 1 ? 'exists' : 'exist'}`}
      onClose={() => onResolve(null)}
      footer={
        <>
          <Button onClick={() => onResolve(null)}>Cancel</Button>
          <Button onClick={() => onResolve('rename')}>Keep both</Button>
          <Button variant="danger" onClick={() => onResolve('replace')} data-testid="collision-replace">
            Replace
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-muted">These names are already taken in the chosen folder. Replace them, or keep both by adding a number to the new files.</p>
      <ul className="max-h-48 space-y-0.5 overflow-y-auto font-mono text-xs">
        {names.slice(0, 200).map((name) => (
          <li key={name} className="truncate">
            {name}
          </li>
        ))}
        {names.length > 200 && <li className="text-subtle">and {names.length - 200} more</li>}
      </ul>
    </Modal>
  )
}

/** Choose a folder, and ask about collisions when names are known up front. */
export function useFolderExport() {
  const [folder, setFolder] = useState<FolderTarget | null>(null)
  const [collisions, setCollisions] = useState<{ names: string[]; resolve: (choice: 'replace' | 'rename' | null) => void } | null>(null)

  const pickFolder = async (): Promise<FolderTarget | null> => {
    const chosen = await window.paperforge.chooseFolder()
    if (chosen) setFolder(chosen)
    return chosen
  }

  const resolvePolicy = async (target: FolderTarget, names: string[]): Promise<'error' | 'replace' | 'rename' | null> => {
    const existing = await window.paperforge.findCollisions(target.folderId, names)
    if (existing.length === 0) return 'error'
    return new Promise((resolve) => setCollisions({ names: existing, resolve }))
  }

  const dialog = collisions ? (
    <CollisionDialog
      names={collisions.names}
      onResolve={(choice) => {
        collisions.resolve(choice)
        setCollisions(null)
      }}
    />
  ) : null

  return { folder, pickFolder, resolvePolicy, dialog }
}

export function SettingsPanel({ children }: { children: ReactNode }) {
  return <div className="flex w-[330px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-line bg-surface p-4">{children}</div>
}
