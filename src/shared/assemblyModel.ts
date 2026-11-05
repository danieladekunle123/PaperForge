/**
 * The document assembly model. Pure functions over an immutable page list: nothing touches a file
 * until export. Every page instance has its own stable id, so duplicates of the same source page
 * behave independently through reordering, rotation, selection and undo.
 */

export type Rotation = 0 | 90 | 180 | 270

export type OutputPage =
  | { id: string; kind: 'pdf'; sourceId: string; pageIndex: number; rotation: Rotation }
  | { id: string; kind: 'image'; sourceId: string; rotation: Rotation }
  | { id: string; kind: 'blank'; rotation: Rotation }

export type NewPage =
  | { kind: 'pdf'; sourceId: string; pageIndex: number; rotation?: Rotation }
  | { kind: 'image'; sourceId: string; rotation?: Rotation }
  | { kind: 'blank'; rotation?: Rotation }

export type IdFactory = () => string

let counter = 0
export const defaultIdFactory: IdFactory = () => `p${Date.now().toString(36)}-${(counter++).toString(36)}`

export function instantiate(pages: NewPage[], makeId: IdFactory = defaultIdFactory): OutputPage[] {
  return pages.map((page) => ({ ...page, rotation: page.rotation ?? 0, id: makeId() }) as OutputPage)
}

/** Insert before ``index``. Out-of-range values clamp to the ends. */
export function insertAt(list: OutputPage[], index: number, added: OutputPage[]): OutputPage[] {
  const at = Math.max(0, Math.min(index, list.length))
  return [...list.slice(0, at), ...added, ...list.slice(at)]
}

/**
 * Move a group so it lands before the page currently at ``targetIndex``.
 * The group keeps its list order even when its members were selected in a different order or are
 * scattered through the list.
 */
export function movePages(list: OutputPage[], ids: Iterable<string>, targetIndex: number): OutputPage[] {
  const moving = new Set(ids)
  if (moving.size === 0) return list
  const target = Math.max(0, Math.min(targetIndex, list.length))
  const before = list.slice(0, target).filter((page) => !moving.has(page.id))
  const after = list.slice(target).filter((page) => !moving.has(page.id))
  const group = list.filter((page) => moving.has(page.id))
  const next = [...before, ...group, ...after]
  return next.every((page, i) => page === list[i]) ? list : next
}

/** Shift the selected pages one step up or down as a group. */
export function nudgePages(list: OutputPage[], ids: Iterable<string>, direction: -1 | 1): OutputPage[] {
  const moving = new Set(ids)
  const indices = list.flatMap((page, i) => (moving.has(page.id) ? [i] : []))
  if (indices.length === 0) return list
  const target = direction < 0 ? indices[0] - 1 : indices[indices.length - 1] + 2
  return movePages(list, moving, target)
}

export function normalizeRotation(value: number): Rotation {
  return (((value % 360) + 360) % 360) as Rotation
}

export function rotatePages(list: OutputPage[], ids: Iterable<string>, degrees: 90 | -90 | 180): OutputPage[] {
  const targets = new Set(ids)
  if (targets.size === 0) return list
  return list.map((page) =>
    targets.has(page.id) ? { ...page, rotation: normalizeRotation(page.rotation + degrees) } : page
  )
}

export function removePages(list: OutputPage[], ids: Iterable<string>): OutputPage[] {
  const targets = new Set(ids)
  if (targets.size === 0) return list
  return list.filter((page) => !targets.has(page.id))
}

/** Duplicate the group directly after its last member, keeping the group's order. */
export function duplicatePages(
  list: OutputPage[],
  ids: Iterable<string>,
  makeId: IdFactory = defaultIdFactory
): { pages: OutputPage[]; newIds: string[] } {
  const targets = new Set(ids)
  const group = list.filter((page) => targets.has(page.id))
  if (group.length === 0) return { pages: list, newIds: [] }
  const copies = group.map((page) => ({ ...page, id: makeId() }))
  const lastIndex = list.reduce((last, page, i) => (targets.has(page.id) ? i : last), -1)
  return { pages: insertAt(list, lastIndex + 1, copies), newIds: copies.map((page) => page.id) }
}

/** Remove pages whose source has gone away. */
export function removeSourcePages(list: OutputPage[], sourceId: string): OutputPage[] {
  return list.filter((page) => page.kind === 'blank' || page.sourceId !== sourceId)
}

export interface History {
  past: OutputPage[][]
  present: OutputPage[]
  future: OutputPage[][]
}

export const HISTORY_LIMIT = 200

export function createHistory(present: OutputPage[] = []): History {
  return { past: [], present, future: [] }
}

/** Record an edit. An edit that changes nothing does not create an undo step. */
export function commit(history: History, next: OutputPage[]): History {
  if (next === history.present) return history
  const past = [...history.past, history.present]
  if (past.length > HISTORY_LIMIT) past.shift()
  return { past, present: next, future: [] }
}

export function undo(history: History): History {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future]
  }
}

export function redo(history: History): History {
  if (history.future.length === 0) return history
  const [next, ...future] = history.future
  return { past: [...history.past, history.present], present: next, future }
}

export interface Selection {
  ids: Set<string>
  anchor: string | null
}

export const emptySelection = (): Selection => ({ ids: new Set(), anchor: null })

/** Click semantics: plain replaces, Ctrl toggles, Shift extends from the anchor. */
export function clickSelection(
  selection: Selection,
  orderedIds: string[],
  id: string,
  modifiers: { ctrl?: boolean; shift?: boolean }
): Selection {
  if (modifiers.shift && selection.anchor !== null) {
    const from = orderedIds.indexOf(selection.anchor)
    const to = orderedIds.indexOf(id)
    if (from !== -1 && to !== -1) {
      const [low, high] = from < to ? [from, to] : [to, from]
      const range = orderedIds.slice(low, high + 1)
      const ids = modifiers.ctrl ? new Set([...selection.ids, ...range]) : new Set(range)
      return { ids, anchor: selection.anchor }
    }
  }
  if (modifiers.ctrl) {
    const ids = new Set(selection.ids)
    if (ids.has(id)) ids.delete(id)
    else ids.add(id)
    return { ids, anchor: id }
  }
  return { ids: new Set([id]), anchor: id }
}

/** Drop ids that no longer exist, for example after an undo. */
export function pruneSelection(selection: Selection, pages: OutputPage[]): Selection {
  const present = new Set(pages.map((page) => page.id))
  const ids = new Set([...selection.ids].filter((id) => present.has(id)))
  const anchor = selection.anchor !== null && present.has(selection.anchor) ? selection.anchor : null
  return ids.size === selection.ids.size && anchor === selection.anchor ? selection : { ids, anchor }
}
