/**
 * A virtualised grid of pages. Only the rows on screen exist in the DOM, so a thousand-page document
 * costs the same as a ten-page one. It uses native drag and drop, and works out drop positions from
 * grid geometry so pages outside the DOM are still valid targets.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { cx } from './ui'

export const PAGE_DRAG_TYPE = 'application/x-paperforge-pages'
const GAP = 12
const CAPTION = 36
const PADDING = 12

export interface GridItem {
  id: string
}

export interface CellContext {
  cell: number
  boxHeight: number
}

interface PageGridProps<T extends GridItem> {
  items: T[]
  cell: number
  label: string
  selected: ReadonlySet<string>
  renderCell: (item: T, index: number, context: CellContext) => ReactNode
  onItemClick: (item: T, event: React.MouseEvent | KeyboardEvent, index: number) => void
  onItemDoubleClick?: (item: T, index: number) => void
  /** Payload set on drag start. Omit to make items not draggable. */
  dragPayload?: (item: T) => string | null
  /** Accept a drop of page payloads at an insertion index. */
  onDropPayload?: (payload: string, index: number) => void
  acceptDrops?: boolean
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void
  empty?: ReactNode
  testId?: string
}

export function PageGrid<T extends GridItem>({
  items,
  cell,
  label,
  selected,
  renderCell,
  onItemClick,
  onItemDoubleClick,
  dragPayload,
  onDropPayload,
  acceptDrops,
  onKeyDown,
  empty,
  testId
}: PageGridProps<T>) {
  const scroller = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [insertAt, setInsertAt] = useState<number | null>(null)
  const anchorIndex = useRef(0)

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setWidth(element.clientWidth))
    observer.observe(element)
    setWidth(element.clientWidth)
    return () => observer.disconnect()
  }, [])

  const inner = Math.max(0, width - PADDING * 2)
  const columns = Math.max(1, Math.floor((inner + GAP) / (cell + GAP)))
  const boxHeight = Math.round(cell * 1.3)
  const rowHeight = boxHeight + CAPTION + GAP
  const rowCount = Math.ceil(items.length / columns)

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowHeight,
    overscan: 3,
    paddingStart: PADDING,
    paddingEnd: PADDING
  })

  useEffect(() => {
    virtualizer.measure()
  }, [rowHeight, columns, virtualizer])

  const indexFromPoint = useCallback(
    (event: DragEvent): number => {
      const element = scroller.current!
      const box = element.getBoundingClientRect()
      const x = event.clientX - box.left - PADDING
      const y = event.clientY - box.top + element.scrollTop - PADDING
      const row = Math.max(0, Math.floor(y / rowHeight))
      const col = Math.max(0, Math.min(columns, Math.round(x / (cell + GAP))))
      return Math.min(items.length, row * columns + col)
    },
    [cell, columns, items.length, rowHeight]
  )

  const onDragOver = (event: DragEvent) => {
    if (!acceptDrops || !event.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setInsertAt(indexFromPoint(event))
    // Scroll while dragging near an edge.
    const element = scroller.current!
    const box = element.getBoundingClientRect()
    const margin = 48
    if (event.clientY < box.top + margin) element.scrollBy({ top: -18 })
    else if (event.clientY > box.bottom - margin) element.scrollBy({ top: 18 })
  }

  const onDrop = (event: DragEvent) => {
    if (!acceptDrops || !event.dataTransfer.types.includes(PAGE_DRAG_TYPE)) return
    event.preventDefault()
    event.stopPropagation()
    const payload = event.dataTransfer.getData(PAGE_DRAG_TYPE)
    const target = indexFromPoint(event)
    setInsertAt(null)
    if (payload) onDropPayload?.(payload, target)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }
    const step = steps[event.key]
    if (step && !event.altKey && items.length > 0) {
      event.preventDefault()
      const next = Math.max(0, Math.min(items.length - 1, anchorIndex.current + step))
      anchorIndex.current = next
      onItemClick(items[next], event, next)
      virtualizer.scrollToIndex(Math.floor(next / columns))
      return
    }
    onKeyDown?.(event)
  }

  const indicator =
    insertAt !== null && items.length > 0
      ? (() => {
          const atEnd = insertAt % columns === 0 && insertAt === items.length
          const row = atEnd ? Math.floor((insertAt - 1) / columns) : Math.floor(insertAt / columns)
          const col = atEnd ? (insertAt - 1) % columns : insertAt % columns
          const left = atEnd ? PADDING + (col + 1) * (cell + GAP) - GAP / 2 : PADDING + col * (cell + GAP) - GAP / 2
          return { left: left - 1, top: PADDING + row * rowHeight, height: boxHeight + CAPTION - 4 }
        })()
      : null

  return (
    <div
      ref={scroller}
      data-testid={testId}
      role="listbox"
      aria-label={label}
      aria-multiselectable="true"
      tabIndex={0}
      className={cx('relative h-full min-h-0 overflow-y-auto outline-offset-[-2px]', insertAt !== null && items.length === 0 && 'bg-accent-soft')}
      onKeyDown={handleKeyDown}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setInsertAt(null)
      }}
      onDrop={onDrop}
    >
      {items.length === 0 ? (
        empty
      ) : (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const start = row.index * columns
            return (
              <div key={row.key} className="absolute left-0 flex" style={{ top: row.start, left: PADDING, gap: GAP }}>
                {items.slice(start, start + columns).map((item, offset) => {
                  const index = start + offset
                  const isSelected = selected.has(item.id)
                  const payload = dragPayload ? true : undefined
                  return (
                    <div
                      key={item.id}
                      role="option"
                      aria-selected={isSelected}
                      data-page-id={item.id}
                      data-page-index={index}
                      draggable={payload}
                      onDragStart={(event) => {
                        const data = dragPayload?.(item)
                        if (!data) {
                          event.preventDefault()
                          return
                        }
                        event.dataTransfer.effectAllowed = 'copyMove'
                        event.dataTransfer.setData(PAGE_DRAG_TYPE, data)
                      }}
                      onDragEnd={() => setInsertAt(null)}
                      onClick={(event) => {
                        anchorIndex.current = index
                        onItemClick(item, event, index)
                      }}
                      onDoubleClick={() => onItemDoubleClick?.(item, index)}
                      className={cx(
                        'group relative flex shrink-0 cursor-default flex-col items-center rounded-md border p-1 transition-colors',
                        isSelected ? 'border-accent bg-accent-soft' : 'border-transparent hover:bg-hover'
                      )}
                      style={{ width: cell, height: boxHeight + CAPTION }}
                    >
                      {renderCell(item, index, { cell: cell - 10, boxHeight: boxHeight - 8 })}
                    </div>
                  )
                })}
              </div>
            )
          })}
          {indicator && <div className="pointer-events-none absolute z-10 w-[3px] rounded-full bg-accent" style={indicator} />}
        </div>
      )}
    </div>
  )
}
