/** The standout feature: build one document visually from pages of many files. */
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { Copy, Download, FilePlus2, FileUp, History, Image as ImageIcon, Layers, LoaderCircle, Lock, Plus, Redo2, RotateCcw, RotateCw, Trash2, TriangleAlert, Undo2, X } from 'lucide-react'
import { clickSelection, emptySelection, type NewPage, type OutputPage, type Selection } from '../../../shared/assemblyModel'
import { formatPageList, parsePageRanges } from '../../../shared/pageRanges'
import { useAssembly } from '../store/assembly'
import { useWorkspace, type SourceEntry } from '../store/workspace'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { formatBytes, formatPageSize, plural, stripExtension } from '../lib/format'
import { PageGrid, type CellContext } from '../components/PageGrid'
import { PageThumb } from '../components/PageThumb'
import { PagePreviewModal, type PreviewPage } from '../components/PagePreview'
import { ExportDialog } from '../components/ExportDialog'
import { Button, cx, EmptyState, Field, IconButton, TextInput } from '../components/ui'
import type { RecentFile } from '../../../shared/types'

const A4_ASPECT = 595 / 842

interface SourceCell {
  id: string
  sourceId: string
  pageIndex: number
  kind: 'pdf' | 'image'
}

function aspectOf(entry: SourceEntry | undefined, pageIndex: number): number {
  const info = entry?.info?.pages[pageIndex]
  return info ? info.width / info.height : A4_ASPECT
}

function SourceRow({ entry, active, onSelect, onRemove }: { entry: SourceEntry; active: boolean; onSelect: () => void; onRemove: () => void }) {
  const requestPassword = useWorkspace((state) => state.requestPassword)
  const restricted = entry.status === 'ready' && entry.info?.security?.encrypted && !entry.info.security.fullAccess
  return (
    <div
      className={cx('group flex items-center gap-2 rounded-md px-2 py-1.5', active ? 'bg-accent-soft' : 'hover:bg-hover')}
      data-testid="source-row"
    >
      <button type="button" onClick={onSelect} aria-current={active} className="flex min-w-0 flex-1 items-center gap-2 text-left" title={entry.displayPath}>
        <span className={cx('shrink-0', active ? 'text-accent' : 'text-subtle')}>
          {entry.status === 'probing' ? <LoaderCircle size={15} className="spin" /> : entry.status === 'locked' ? <Lock size={15} /> : entry.status === 'error' ? <TriangleAlert size={15} className="text-danger" /> : entry.kind === 'image' ? <ImageIcon size={15} /> : <FileUp size={15} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{entry.name}</span>
          <span className="block truncate text-[11px] text-subtle">
            {entry.status === 'ready' && entry.info
              ? `${entry.kind === 'image' ? `${entry.info.image?.width} × ${entry.info.image?.height} px` : plural(entry.info.pageCount, 'page')} · ${formatBytes(entry.sizeBytes)}`
              : entry.status === 'probing'
                ? 'Reading…'
                : entry.status === 'locked'
                  ? 'Password required'
                  : (entry.error ?? 'Could not be read')}
          </span>
        </span>
      </button>
      {entry.status === 'locked' && (
        <Button size="sm" onClick={() => requestPassword(entry.id)}>
          Unlock
        </Button>
      )}
      {restricted && (
        <IconButton label="This file has restricted permissions. Enter its owner password" className="h-6 w-6 text-warn" onClick={() => requestPassword(entry.id)}>
          <Lock size={13} />
        </IconButton>
      )}
      <IconButton label={`Remove ${entry.name} from workspace`} className="h-6 w-6 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100" onClick={onRemove}>
        <X size={14} />
      </IconButton>
    </div>
  )
}

function useResizable(initial: number, min: number, max: number, edge: 'left' | 'right' = 'right') {
  const [width, setWidth] = useState(initial)
  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault()
      const startX = event.clientX
      const startWidth = width
      const move = (e: PointerEvent) => {
        const delta = e.clientX - startX
        setWidth(Math.max(min, Math.min(max, startWidth + (edge === 'right' ? delta : -delta))))
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [edge, max, min, width]
  )
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (step) {
      event.preventDefault()
      setWidth((value) => Math.max(min, Math.min(max, value + (edge === 'right' ? step : -step))))
    }
  }
  return { width, handleProps: { onPointerDown, onKeyDown } }
}

function ResizeHandle(props: { onPointerDown: (event: ReactPointerEvent) => void; onKeyDown: (event: KeyboardEvent) => void; label: string }) {
  const { label, ...rest } = props
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className="w-1 shrink-0 cursor-col-resize bg-line transition-colors hover:bg-accent focus-visible:bg-accent"
      {...rest}
    />
  )
}

export function AssemblyTool() {
  const sources = useWorkspace((state) => state.sources)
  const order = useWorkspace((state) => state.order)
  const importFiles = useWorkspace((state) => state.importWithDialog)
  const removeSource = useWorkspace((state) => state.remove)
  const acceptImport = useWorkspace((state) => state.acceptImport)
  const dropSource = useAssembly((state) => state.dropSource)
  const pages = useAssembly((state) => state.history.present)
  const canUndo = useAssembly((state) => state.history.past.length > 0)
  const canRedo = useAssembly((state) => state.history.future.length > 0)
  const selection = useAssembly((state) => state.selection)
  const actions = useAssembly.getState()
  const thumbnailSize = useSettings((state) => state.settings.thumbnailSize)
  const setPrimary = useUi((state) => state.setPrimary)

  const [activeSource, setActiveSource] = useState<string | null>(null)
  const [sourceSelection, setSourceSelection] = useState<Selection>(emptySelection)
  const [rangeText, setRangeText] = useState('')
  const [rangeError, setRangeError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [preview, setPreview] = useState<{ pages: PreviewPage[]; index: number } | null>(null)
  const [recent, setRecent] = useState<RecentFile[]>([])
  // 290 keeps two thumbnail columns once the scrollbar has taken its width.
  const left = useResizable(290, 230, 440, 'right')
  const right = useResizable(226, 190, 320, 'left')

  useEffect(() => {
    void window.paperforge.getRecentFiles().then(setRecent)
  }, [order.length])

  // Keep a valid active source.
  useEffect(() => {
    if (activeSource && sources[activeSource]) return
    const next = order.find((id) => sources[id]?.status === 'ready') ?? order[0] ?? null
    setActiveSource(next)
  }, [activeSource, order, sources])

  const active = activeSource ? sources[activeSource] : undefined

  const sourceCells = useMemo<SourceCell[]>(() => {
    if (!active || active.status !== 'ready' || !active.info) return []
    if (active.kind === 'image') return [{ id: `${active.id}:image`, sourceId: active.id, pageIndex: 0, kind: 'image' }]
    return Array.from({ length: active.info.pageCount }, (_, i) => ({ id: `${active.id}:${i}`, sourceId: active.id, pageIndex: i, kind: 'pdf' as const }))
  }, [active])

  useEffect(() => {
    setSourceSelection(emptySelection())
    setRangeText('')
    setRangeError(null)
  }, [activeSource])

  const toNewPages = useCallback((cells: SourceCell[]): NewPage[] => cells.map((cell) => (cell.kind === 'image' ? { kind: 'image', sourceId: cell.sourceId } : { kind: 'pdf', sourceId: cell.sourceId, pageIndex: cell.pageIndex })), [])

  const selectedCells = useMemo(() => sourceCells.filter((cell) => sourceSelection.ids.has(cell.id)), [sourceCells, sourceSelection])

  const addSelected = () => {
    if (selectedCells.length) actions.add(toNewPages(selectedCells))
  }

  const addRange = () => {
    if (!active?.info) return
    const parsed = parsePageRanges(rangeText, active.info.pageCount)
    if (!parsed.ok) {
      setRangeError(parsed.error)
      return
    }
    setRangeError(null)
    actions.add(parsed.pages.map((pageIndex) => ({ kind: 'pdf', sourceId: active.id, pageIndex })))
    setRangeText('')
  }

  const pageLabel = useCallback(
    (page: OutputPage): { name: string; detail: string } => {
      if (page.kind === 'blank') return { name: 'Blank page', detail: 'Inserted' }
      const entry = sources[page.sourceId]
      const name = entry?.name ?? 'Missing file'
      return { name, detail: page.kind === 'image' ? 'Image' : `Page ${page.pageIndex + 1}` }
    },
    [sources]
  )

  const openPreview = useCallback(
    (index: number) => {
      setPreview({
        index,
        pages: pages.map((page) => {
          const label = pageLabel(page)
          return {
            key: page.id,
            kind: page.kind,
            sourceId: page.kind === 'blank' ? undefined : page.sourceId,
            pageIndex: page.kind === 'pdf' ? page.pageIndex : undefined,
            rotation: page.rotation,
            title: label.name,
            subtitle: label.detail
          }
        })
      })
    },
    [pageLabel, pages]
  )

  const openSourcePreview = useCallback(
    (index: number) => {
      if (!active) return
      setPreview({
        index,
        pages: sourceCells.map((cell) => ({
          key: cell.id,
          kind: cell.kind,
          sourceId: cell.sourceId,
          pageIndex: cell.pageIndex,
          rotation: 0,
          title: active.name,
          subtitle: cell.kind === 'image' ? 'Image' : `Page ${cell.pageIndex + 1}`
        }))
      })
    },
    [active, sourceCells]
  )

  const pagesEmpty = pages.length === 0

  const toolActive = useUi((state) => state.tool === 'assembly')

  useEffect(() => {
    // This component stays mounted behind other tools, so it only claims Ctrl+S while visible.
    if (!toolActive) return
    setPrimary({ label: 'Export PDF', enabled: !pagesEmpty, run: () => setExporting(true) })
    return () => setPrimary(null)
  }, [pagesEmpty, setPrimary, toolActive])

  // Workspace shortcuts. Modals and text fields keep their own keys.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (useUi.getState().modalDepth > 0 || useUi.getState().tool !== 'assembly') return
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return
      const ctrl = event.ctrlKey || event.metaKey
      const inSource = target.closest?.('[data-testid="source-grid"]')
      if (ctrl && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) actions.redo()
        else actions.undo()
      } else if (ctrl && event.key.toLowerCase() === 'y') {
        event.preventDefault()
        actions.redo()
      } else if (ctrl && event.key.toLowerCase() === 'a') {
        event.preventDefault()
        if (inSource) setSourceSelection({ ids: new Set(sourceCells.map((cell) => cell.id)), anchor: sourceCells[0]?.id ?? null })
        else actions.selectAll()
      } else if (event.key === 'Delete') {
        if (!inSource) {
          event.preventDefault()
          actions.remove()
        }
      } else if (event.key === 'Escape') {
        actions.clearSelection()
        setSourceSelection(emptySelection())
      } else if (ctrl && event.key.toLowerCase() === 'd') {
        event.preventDefault()
        actions.duplicate()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, sourceCells])

  const onOutputKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowUp')) {
      event.preventDefault()
      actions.nudge(-1)
    } else if (event.altKey && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) {
      event.preventDefault()
      actions.nudge(1)
    } else if (event.key === 'r' || event.key === 'R') {
      actions.rotate(event.shiftKey ? -90 : 90)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const index = pages.findIndex((page) => selection.ids.has(page.id))
      if (index !== -1) openPreview(index)
    }
  }

  const onOutputDrop = (raw: string, index: number) => {
    const payload = JSON.parse(raw) as { from: 'output'; ids: string[] } | { from: 'source'; pages: NewPage[] }
    if (payload.from === 'output') actions.move(payload.ids, index)
    else actions.add(payload.pages, index)
  }

  const renderOutputCell = (page: OutputPage, index: number, context: CellContext) => {
    const label = pageLabel(page)
    const entry = page.kind === 'blank' ? undefined : sources[page.sourceId]
    const aspect = page.kind === 'pdf' ? aspectOf(entry, page.pageIndex) : page.kind === 'image' ? aspectOf(entry, 0) : A4_ASPECT
    return (
      <>
        <PageThumb
          sourceId={page.kind === 'blank' ? undefined : page.sourceId}
          pageIndex={page.kind === 'pdf' ? page.pageIndex : null}
          aspect={aspect}
          rotation={page.rotation}
          blank={page.kind === 'blank'}
          box={{ width: context.cell, height: context.boxHeight }}
        />
        <span className="absolute top-1.5 left-1.5 rounded bg-black/70 px-1.5 text-[11px] leading-[18px] font-semibold text-white tabular-nums">{index + 1}</span>
        {page.rotation !== 0 && <span className="absolute top-1.5 right-1.5 rounded bg-black/70 px-1 text-[10px] leading-[18px] text-white">{page.rotation}°</span>}
        <div className="mt-1 w-full min-w-0 text-center leading-tight" title={`${label.name} · ${label.detail}`}>
          <div className="truncate text-[11px] text-fg">{label.name}</div>
          <div className="truncate text-[10px] text-subtle">{label.detail}</div>
        </div>
      </>
    )
  }

  const renderSourceCell = (cell: SourceCell, _index: number, context: CellContext) => {
    const aspect = aspectOf(active, cell.pageIndex)
    return (
      <>
        <PageThumb sourceId={cell.sourceId} pageIndex={cell.kind === 'pdf' ? cell.pageIndex : null} aspect={aspect} rotation={0} box={{ width: context.cell, height: context.boxHeight }} />
        <div className="mt-1 text-[11px] text-muted tabular-nums">{cell.kind === 'image' ? 'Image' : cell.pageIndex + 1}</div>
      </>
    )
  }

  const focused = pages.find((page) => selection.anchor === page.id) ?? pages.find((page) => selection.ids.has(page.id))
  const selectedCount = selection.ids.size
  const hasSelection = selectedCount > 0
  const defaultName = useMemo(() => {
    const first = pages.find((page) => page.kind !== 'blank')
    const name = first ? sources[first.sourceId]?.name : undefined
    return name ? `${stripExtension(name)}-assembled.pdf` : 'assembled.pdf'
  }, [pages, sources])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1" data-testid="assembly-tool">
      {/* Sources */}
      <section aria-label="Source files" className="flex shrink-0 flex-col bg-surface" style={{ width: left.width }}>
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line pr-2 pl-3">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Sources</h2>
          <Button size="sm" variant="secondary" icon={<Plus size={14} />} onClick={() => void importFiles('any')} data-testid="import-button">
            Import
          </Button>
        </div>
        {order.length === 0 ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <EmptyState icon={<FileUp size={28} />} title="Import PDFs and images" action={<Button variant="primary" onClick={() => void importFiles('any')}>Choose files</Button>}>
              Drop files anywhere in this window, or press Ctrl+O. They are read locally and left unchanged.
            </EmptyState>
            {recent.length > 0 && (
              <div className="px-3 pb-3">
                <h3 className="mb-1 flex items-center gap-1 text-[11px] text-subtle">
                  <History size={12} /> Recent
                </h3>
                {recent.map((file) => (
                  <button key={file.displayPath} type="button" title={file.displayPath} onClick={() => void window.paperforge.importRecent(file.displayPath).then(acceptImport)} className="block w-full truncate rounded px-2 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg">
                    {file.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="max-h-[32%] shrink-0 space-y-0.5 overflow-y-auto border-b border-line p-1.5">
              {order.map((id) => (
                <SourceRow
                  key={id}
                  entry={sources[id]}
                  active={id === activeSource}
                  onSelect={() => setActiveSource(id)}
                  onRemove={() => {
                    dropSource(id)
                    removeSource(id)
                  }}
                />
              ))}
            </div>
            <div className="min-h-0 flex-1">
              <PageGrid
                testId="source-grid"
                label={active ? `Pages of ${active.name}` : 'Source pages'}
                items={sourceCells}
                cell={Math.min(thumbnailSize, 118)}
                selected={sourceSelection.ids}
                renderCell={renderSourceCell}
                onItemClick={(cell, event) =>
                  setSourceSelection(
                    clickSelection(sourceSelection, sourceCells.map((item) => item.id), cell.id, {
                      ctrl: event.ctrlKey || event.metaKey,
                      shift: event.shiftKey
                    })
                  )
                }
                onItemDoubleClick={(cell) => actions.add(toNewPages([cell]))}
                dragPayload={(cell) => {
                  const cells = sourceSelection.ids.has(cell.id) ? selectedCells : [cell]
                  return JSON.stringify({ from: 'source', pages: toNewPages(cells) })
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    addSelected()
                  } else if (event.key === ' ') {
                    event.preventDefault()
                    const index = sourceCells.findIndex((cell) => sourceSelection.ids.has(cell.id))
                    if (index !== -1) openSourcePreview(index)
                  }
                }}
                empty={
                  <EmptyState title={active?.status === 'locked' ? 'Unlock this file to see its pages' : active?.status === 'error' ? 'This file could not be read' : 'Reading…'}>
                    {active?.status === 'error' ? active.error : null}
                  </EmptyState>
                }
              />
            </div>
            {active?.status === 'ready' && (
              <div className="shrink-0 space-y-2 border-t border-line p-2.5">
                {active.kind === 'pdf' && (
                  <form
                    className="flex items-start gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault()
                      addRange()
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <Field label="Add pages by number" error={rangeError}>
                        {(id) => <TextInput id={id} data-testid="range-input" placeholder="1-3, 7, 9-" value={rangeText} onChange={(event) => { setRangeText(event.target.value); setRangeError(null) }} />}
                      </Field>
                    </div>
                    <Button type="submit" className="mt-5" disabled={!rangeText.trim()} data-testid="range-add">
                      Add
                    </Button>
                  </form>
                )}
                <div className="flex gap-1.5">
                  <Button className="flex-1" variant={selectedCells.length ? 'primary' : 'secondary'} disabled={!selectedCells.length} onClick={addSelected} data-testid="add-selected">
                    Add {selectedCells.length || ''} selected
                  </Button>
                  <Button className="flex-1" onClick={() => actions.add(toNewPages(sourceCells))} data-testid="add-all">
                    Add {active.kind === 'image' ? 'image' : 'all'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </section>
      <ResizeHandle {...left.handleProps} label="Resize sources panel" />

      {/* Output */}
      <section aria-label="Output document" className="@container flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line px-2 [scrollbar-width:none]" role="toolbar" aria-label="Page actions">
          <IconButton label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={actions.undo} data-testid="undo">
            <Undo2 size={16} />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={actions.redo} data-testid="redo">
            <Redo2 size={16} />
          </IconButton>
          <div className="mx-1 h-5 w-px bg-line" />
          <IconButton label="Rotate left" disabled={!hasSelection} onClick={() => actions.rotate(-90)}>
            <RotateCcw size={16} />
          </IconButton>
          <IconButton label="Rotate right (R)" disabled={!hasSelection} onClick={() => actions.rotate(90)} data-testid="rotate-right">
            <RotateCw size={16} />
          </IconButton>
          <IconButton label="Duplicate (Ctrl+D)" disabled={!hasSelection} onClick={actions.duplicate} data-testid="duplicate">
            <Copy size={16} />
          </IconButton>
          <IconButton label="Remove (Delete)" disabled={!hasSelection} onClick={actions.remove} data-testid="remove">
            <Trash2 size={16} />
          </IconButton>
          <div className="mx-1 h-5 w-px bg-line" />
          <IconButton label="Insert blank page" onClick={actions.insertBlank} data-testid="insert-blank">
            <FilePlus2 size={16} />
          </IconButton>
          <div className="ml-auto flex shrink-0 items-center gap-3 pl-2">
            <span className="text-xs whitespace-nowrap text-muted tabular-nums @max-[470px]:hidden" data-testid="output-count">
              {plural(pages.length, 'page')}
              {selectedCount > 0 && ` · ${selectedCount} selected`}
            </span>
            <input
              type="range"
              aria-label="Thumbnail size"
              title="Thumbnail size"
              min={90}
              max={260}
              step={10}
              value={thumbnailSize}
              onChange={(event) => void useSettings.getState().update({ thumbnailSize: Number(event.target.value) })}
              className="w-16 accent-[var(--pf-accent)] @max-[600px]:hidden"
            />
            <Button variant="primary" className="shrink-0" icon={<Download size={14} />} disabled={pagesEmpty} onClick={() => setExporting(true)} title="Export (Ctrl+S)" data-testid="export-button">
              Export PDF
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-app" onClick={(event) => event.target === event.currentTarget && actions.clearSelection()}>
          <PageGrid
            testId="output-grid"
            label="Output pages"
            items={pages}
            cell={thumbnailSize}
            selected={selection.ids}
            renderCell={renderOutputCell}
            onItemClick={(page, event) => {
              const keyboardMove = 'key' in event
              actions.click(page.id, { ctrl: !keyboardMove && (event.ctrlKey || event.metaKey), shift: event.shiftKey })
            }}
            onItemDoubleClick={(_page, index) => openPreview(index)}
            dragPayload={(page) => {
              const ids = selection.ids.has(page.id) ? pages.filter((item) => selection.ids.has(item.id)).map((item) => item.id) : [page.id]
              if (!selection.ids.has(page.id)) actions.click(page.id, {})
              return JSON.stringify({ from: 'output', ids })
            }}
            acceptDrops
            onDropPayload={onOutputDrop}
            onKeyDown={onOutputKeyDown}
            empty={
              <EmptyState icon={<Layers size={32} />} title="Your document starts here">
                {order.length ? (
                  <>Drag pages here from the Sources panel, double-click one, or use Add. Then reorder, rotate and duplicate before you export.</>
                ) : (
                  <>Import a few PDFs or images, and pick the pages you want. Nothing changes on disk until you export a new PDF.</>
                )}
              </EmptyState>
            }
          />
        </div>
      </section>
      <ResizeHandle {...right.handleProps} label="Resize details panel" />

      {/* Details */}
      <aside aria-label="Page details" className="flex shrink-0 flex-col overflow-y-auto bg-surface" style={{ width: right.width }}>
        <div className="flex h-11 shrink-0 items-center border-b border-line px-3">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Details</h2>
        </div>
        <PageDetails page={focused} selectedCount={selectedCount} pageNumber={focused ? pages.indexOf(focused) + 1 : 0} onPreview={openPreview} />
        {pages.length > 0 && <OutputSummary pages={pages} />}
        <div className="mt-auto space-y-1 border-t border-line p-3 text-[11px] leading-relaxed text-subtle">
          <p>
            <kbd className="font-sans font-medium text-muted">Ctrl/Shift+click</kbd> selects several. <kbd className="font-sans font-medium text-muted">Alt+arrows</kbd> move selected pages. <kbd className="font-sans font-medium text-muted">Ctrl+S</kbd> exports.
          </p>
        </div>
      </aside>

      {exporting && <ExportDialog pages={pages} defaultName={defaultName} label="Assembly" onClose={() => setExporting(false)} />}
      {preview && <PagePreviewModal pages={preview.pages} startIndex={preview.index} onClose={() => setPreview(null)} />}
    </div>
  )
}

function PageDetails({ page, selectedCount, pageNumber, onPreview }: { page: OutputPage | undefined; selectedCount: number; pageNumber: number; onPreview: (index: number) => void }) {
  const sources = useWorkspace((state) => state.sources)
  if (!page) return <p className="p-3 text-xs text-subtle">Select an output page to see where it came from. Double-click a page to read it at full size.</p>
  const entry = page.kind === 'blank' ? undefined : sources[page.sourceId]
  const info = page.kind === 'pdf' ? entry?.info?.pages[page.pageIndex] : page.kind === 'image' ? entry?.info?.pages[0] : undefined
  const aspect = info ? info.width / info.height : A4_ASPECT
  return (
    <div className="space-y-3 p-3">
      <button type="button" className="block w-full rounded-md bg-app p-2 hover:bg-hover" onClick={() => onPreview(pageNumber - 1)} aria-label={`Read page ${pageNumber} at a larger size`} title="Open larger preview">
        <PageThumb sourceId={page.kind === 'blank' ? undefined : page.sourceId} pageIndex={page.kind === 'pdf' ? page.pageIndex : null} aspect={aspect} rotation={page.rotation} blank={page.kind === 'blank'} box={{ width: 190, height: 190 }} />
      </button>
      <dl className="space-y-1.5 text-xs">
        <Detail label="Output page" value={selectedCount > 1 ? `${pageNumber} (${selectedCount} selected)` : String(pageNumber)} />
        <Detail label="Original file" value={page.kind === 'blank' ? 'Blank page' : (entry?.name ?? 'Removed')} />
        {page.kind === 'pdf' && <Detail label="Source page" value={String(page.pageIndex + 1)} />}
        {info && page.kind === 'pdf' && <Detail label="Size" value={formatPageSize(info.width, info.height)} />}
        {info && page.kind === 'image' && <Detail label="Pixels" value={`${info.width} × ${info.height}`} />}
        <Detail label="Added rotation" value={`${page.rotation}°`} />
      </dl>
    </div>
  )
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-subtle">{label}</dt>
      <dd className="selectable break-words text-fg">{value}</dd>
    </div>
  )
}

function OutputSummary({ pages }: { pages: OutputPage[] }) {
  const sources = useWorkspace((state) => state.sources)
  const summary = useMemo(() => {
    const byFile = new Map<string, number[]>()
    for (const page of pages) {
      if (page.kind === 'blank') continue
      const list = byFile.get(page.sourceId) ?? []
      if (page.kind === 'pdf') list.push(page.pageIndex)
      byFile.set(page.sourceId, list)
    }
    return [...byFile.entries()].map(([id, list]) => ({ id, name: sources[id]?.name ?? 'Removed', text: list.length ? `Pages ${formatPageList([...new Set(list)].sort((a, b) => a - b))}` : 'Image' }))
  }, [pages, sources])
  if (summary.length === 0) return null
  return (
    <div className="border-t border-line p-3">
      <h3 className="mb-1.5 text-[11px] text-subtle">In this document</h3>
      <ul className="space-y-1.5 text-xs">
        {summary.map((item) => (
          <li key={item.id}>
            <div className="truncate text-fg" title={item.name}>
              {item.name}
            </div>
            <div className="truncate text-[11px] text-subtle" title={item.text}>
              {item.text}
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
