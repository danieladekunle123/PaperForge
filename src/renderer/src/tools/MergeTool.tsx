/** Merge is a focused front end for the Document Assembly engine, not a second implementation. */
import { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Combine, Download, FileUp, GripVertical, Layers, X } from 'lucide-react'
import { instantiate, type NewPage } from '../../../shared/assemblyModel'
import { parsePageRanges } from '../../../shared/pageRanges'
import { useAssembly } from '../store/assembly'
import { notify, useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, cx, EmptyState, IconButton, TextInput } from '../components/ui'
import { PageThumb } from '../components/PageThumb'
import { ExportDialog } from '../components/ExportDialog'
import { usePrimaryAction } from '../components/toolKit'
import { formatBytes, plural, stripExtension } from '../lib/format'

interface MergeItem {
  key: number
  sourceId: string
  range: string
  expanded: boolean
}

let nextKey = 1

export default function MergeTool() {
  const sources = useWorkspace((state) => state.sources)
  const importFiles = useWorkspace((state) => state.importWithDialog)
  const [items, setItems] = useState<MergeItem[]>([])
  const [exporting, setExporting] = useState(false)
  const [dragKey, setDragKey] = useState<number | null>(null)
  const [dropBefore, setDropBefore] = useState<number | null>(null)

  const addFiles = async () => {
    const ids = await importFiles('pdf')
    setItems((current) => [...current, ...ids.map((sourceId) => ({ key: nextKey++, sourceId, range: '', expanded: false }))])
  }

  const addImported = (id: string) => setItems((current) => [...current, { key: nextKey++, sourceId: id, range: '', expanded: false }])

  const update = (key: number, patch: Partial<MergeItem>) => setItems((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)))

  const move = (index: number, delta: number) =>
    setItems((current) => {
      const next = [...current]
      const [item] = next.splice(index, 1)
      next.splice(Math.max(0, Math.min(next.length, index + delta)), 0, item)
      return next
    })

  const moveByDrag = (key: number, beforeIndex: number) =>
    setItems((current) => {
      const from = current.findIndex((item) => item.key === key)
      if (from === -1) return current
      const next = [...current]
      const [item] = next.splice(from, 1)
      next.splice(beforeIndex > from ? beforeIndex - 1 : beforeIndex, 0, item)
      return next
    })

  const planned = useMemo(() => {
    const pages: NewPage[] = []
    const errors = new Map<number, string>()
    const counts = new Map<number, number>()
    for (const item of items) {
      const entry = sources[item.sourceId]
      if (entry?.status !== 'ready' || !entry.info) {
        errors.set(item.key, entry?.status === 'locked' ? 'Unlock this file first.' : 'This file is not ready.')
        continue
      }
      if (item.range.trim()) {
        const parsed = parsePageRanges(item.range, entry.info.pageCount)
        if (!parsed.ok) {
          errors.set(item.key, parsed.error)
          continue
        }
        counts.set(item.key, parsed.pages.length)
        pages.push(...parsed.pages.map((pageIndex) => ({ kind: 'pdf' as const, sourceId: item.sourceId, pageIndex })))
      } else {
        counts.set(item.key, entry.info.pageCount)
        for (let i = 0; i < entry.info.pageCount; i++) pages.push({ kind: 'pdf', sourceId: item.sourceId, pageIndex: i })
      }
    }
    return { pages, errors, counts }
  }, [items, sources])

  const outputPages = useMemo(() => instantiate(planned.pages), [planned.pages])
  const canExport = items.length > 0 && planned.errors.size === 0 && planned.pages.length > 0

  usePrimaryAction('Merge', canExport, () => setExporting(true))

  const available = useWorkspace((state) => state.order).filter((id) => sources[id]?.kind === 'pdf' && sources[id]?.status === 'ready' && !items.some((item) => item.sourceId === id))
  const firstName = items[0] ? sources[items[0].sourceId]?.name : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="merge-tool">
      <ToolHeader title="Merge PDFs" description="Put whole files in order, or limit a file to a page range. Uses the same engine as Document Assembly.">
        <Button icon={<FileUp size={14} />} onClick={() => void addFiles()} data-testid="merge-add">
          Add PDFs
        </Button>
        <Button
          icon={<Layers size={14} />}
          disabled={!canExport}
          onClick={() => {
            useAssembly.getState().add(planned.pages)
            useUi.getState().setTool('assembly')
            notify('success', `Added ${plural(planned.pages.length, 'page')} to Document Assembly.`)
          }}
        >
          Open in Assembly
        </Button>
        <Button variant="primary" icon={<Download size={14} />} disabled={!canExport} onClick={() => setExporting(true)} data-testid="merge-export">
          Merge and export
        </Button>
      </ToolHeader>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <EmptyState icon={<Combine size={32} />} title="Add the PDFs you want to combine" action={<Button variant="primary" onClick={() => void addFiles()}>Add PDFs</Button>}>
              You can reorder files, and expand one to take only some of its pages.
            </EmptyState>
          ) : (
            <ol
              className="mx-auto max-w-3xl space-y-1.5"
              onDragOver={(event) => {
                if (dragKey !== null) event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                if (dragKey !== null && dropBefore !== null) moveByDrag(dragKey, dropBefore)
                setDragKey(null)
                setDropBefore(null)
              }}
            >
              {items.map((item, index) => {
                const entry = sources[item.sourceId]
                const error = planned.errors.get(item.key)
                const hasError = error && item.range.trim()
                return (
                  <li
                    key={item.key}
                    data-testid="merge-item"
                    onDragOver={(event) => {
                      if (dragKey === null) return
                      const box = event.currentTarget.getBoundingClientRect()
                      setDropBefore(event.clientY < box.top + box.height / 2 ? index : index + 1)
                    }}
                    className={cx(
                      'rounded-md border bg-surface',
                      'border-line',
                      dropBefore === index && 'border-t-accent',
                      dropBefore === index + 1 && index === items.length - 1 && 'border-b-accent'
                    )}
                  >
                    <div className="flex items-center gap-1.5 px-2 py-1.5">
                      <span
                        draggable
                        onDragStart={(event) => {
                          setDragKey(item.key)
                          event.dataTransfer.setData('text/plain', String(item.key))
                          event.dataTransfer.effectAllowed = 'move'
                        }}
                        onDragEnd={() => {
                          setDragKey(null)
                          setDropBefore(null)
                        }}
                        className="cursor-grab text-subtle hover:text-fg"
                        title="Drag to reorder"
                      >
                        <GripVertical size={15} />
                      </span>
                      <IconButton label={item.expanded ? 'Collapse' : 'Choose pages'} className="h-7 w-7" onClick={() => update(item.key, { expanded: !item.expanded })} aria-expanded={item.expanded}>
                        {item.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                      </IconButton>
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium" title={entry?.displayPath}>
                          {entry?.name ?? 'Removed file'}
                        </div>
                        <div className="text-[11px] text-subtle">
                          {item.range.trim() ? `Pages ${item.range} · ` : 'All pages · '}
                          {plural(planned.counts.get(item.key) ?? 0, 'page')} · {entry ? formatBytes(entry.sizeBytes) : ''}
                        </div>
                      </div>
                      <IconButton label="Move up" className="h-7 w-7" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp size={14} />
                      </IconButton>
                      <IconButton label="Move down" className="h-7 w-7" disabled={index === items.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown size={14} />
                      </IconButton>
                      <IconButton label="Remove from merge" className="h-7 w-7" onClick={() => setItems((current) => current.filter((other) => other.key !== item.key))}>
                        <X size={14} />
                      </IconButton>
                    </div>
                    {error && !hasError && <div className="px-3 pb-2"><Banner kind="warn">{error}</Banner></div>}
                    {item.expanded && entry?.info && (
                      <div className="space-y-2 border-t border-line p-3">
                        <div className="max-w-xs">
                          <label className="mb-1 block text-xs font-medium text-muted">Pages to include</label>
                          <TextInput value={item.range} placeholder={`All ${entry.info.pageCount} pages, or 1-3, 7`} aria-label={`Pages from ${entry.name}`} onChange={(event) => update(item.key, { range: event.target.value })} />
                          {hasError && <p role="alert" className="mt-1 text-xs text-danger">{error}</p>}
                        </div>
                        <div className="flex gap-2 overflow-x-auto pb-1">
                          {entry.info.pages.slice(0, 40).map((page, pageIndex) => (
                            <div key={pageIndex} className="shrink-0 text-center">
                              <PageThumb sourceId={entry.id} pageIndex={pageIndex} aspect={page.width / page.height} rotation={0} box={{ width: 70, height: 96 }} />
                              <span className="text-[10px] text-subtle">{pageIndex + 1}</span>
                            </div>
                          ))}
                          {entry.info.pages.length > 40 && <span className="self-center px-2 text-xs text-subtle">and {entry.info.pages.length - 40} more</span>}
                        </div>
                      </div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
          {available.length > 0 && (
            <div className="mx-auto mt-4 max-w-3xl">
              <h3 className="mb-1 text-xs font-medium text-muted">Already in your workspace</h3>
              <div className="flex flex-wrap gap-1.5">
                {available.map((id) => (
                  <Button key={id} size="sm" onClick={() => addImported(id)}>
                    + {sources[id].name}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>
        {items.length > 0 && (
          <aside className="flex w-64 shrink-0 flex-col border-l border-line bg-surface" aria-label="Output order">
            <div className="border-b border-line p-3">
              <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Output order</h2>
              <p className="mt-0.5 text-sm font-medium tabular-nums" data-testid="merge-total">
                {plural(planned.pages.length, 'page')}
              </p>
            </div>
            <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3 text-xs">
              {items.map((item, index) => {
                const start = items.slice(0, index).reduce((sum, other) => sum + (planned.counts.get(other.key) ?? 0), 0)
                const count = planned.counts.get(item.key) ?? 0
                return (
                  <li key={item.key} className="flex gap-2">
                    <span className="w-14 shrink-0 text-right text-subtle tabular-nums">{count === 0 ? '–' : count === 1 ? start + 1 : `${start + 1}–${start + count}`}</span>
                    <span className="min-w-0 truncate" title={sources[item.sourceId]?.name}>
                      {sources[item.sourceId]?.name}
                    </span>
                  </li>
                )
              })}
            </ol>
          </aside>
        )}
      </div>
      {exporting && (
        <ExportDialog pages={outputPages} defaultName={firstName ? `${stripExtension(firstName)}-merged.pdf` : 'merged.pdf'} label="Merge" onClose={() => setExporting(false)} />
      )}
    </div>
  )
}
