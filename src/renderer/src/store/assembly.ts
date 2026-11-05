/** Document Assembly state: the undoable page list and its selection. */
import { create } from 'zustand'
import {
  clickSelection,
  commit,
  createHistory,
  duplicatePages,
  emptySelection,
  insertAt,
  instantiate,
  movePages,
  nudgePages,
  pruneSelection,
  redo,
  removePages,
  removeSourcePages,
  rotatePages,
  undo,
  type History,
  type NewPage,
  type OutputPage,
  type Selection
} from '../../../shared/assemblyModel'

interface AssemblyState {
  history: History
  selection: Selection
  pages(): OutputPage[]
  add(pages: NewPage[], at?: number): void
  move(ids: string[], target: number): void
  nudge(direction: -1 | 1): void
  rotate(degrees: 90 | -90): void
  remove(): void
  duplicate(): void
  insertBlank(): void
  undo(): void
  redo(): void
  click(id: string, modifiers: { ctrl?: boolean; shift?: boolean }): void
  selectAll(): void
  clearSelection(): void
  dropSource(sourceId: string): void
}

export const useAssembly = create<AssemblyState>((set, get) => ({
  history: createHistory(),
  selection: emptySelection(),
  pages: () => get().history.present,

  add: (pages, at) =>
    set((state) => {
      const added = instantiate(pages)
      const target = at ?? state.history.present.length
      return {
        history: commit(state.history, insertAt(state.history.present, target, added)),
        selection: { ids: new Set(added.map((page) => page.id)), anchor: added[0]?.id ?? null }
      }
    }),

  move: (ids, target) =>
    set((state) => ({ history: commit(state.history, movePages(state.history.present, ids, target)) })),

  nudge: (direction) =>
    set((state) => ({ history: commit(state.history, nudgePages(state.history.present, state.selection.ids, direction)) })),

  rotate: (degrees) =>
    set((state) => ({ history: commit(state.history, rotatePages(state.history.present, state.selection.ids, degrees)) })),

  remove: () =>
    set((state) => {
      const next = removePages(state.history.present, state.selection.ids)
      return { history: commit(state.history, next), selection: pruneSelection(state.selection, next) }
    }),

  duplicate: () =>
    set((state) => {
      const { pages, newIds } = duplicatePages(state.history.present, state.selection.ids)
      return {
        history: commit(state.history, pages),
        selection: newIds.length ? { ids: new Set(newIds), anchor: newIds[0] } : state.selection
      }
    }),

  insertBlank: () =>
    set((state) => {
      const present = state.history.present
      const selectedIndexes = present.flatMap((page, i) => (state.selection.ids.has(page.id) ? [i] : []))
      const at = selectedIndexes.length ? selectedIndexes[selectedIndexes.length - 1] + 1 : present.length
      const added = instantiate([{ kind: 'blank' }])
      return {
        history: commit(state.history, insertAt(present, at, added)),
        selection: { ids: new Set([added[0].id]), anchor: added[0].id }
      }
    }),

  undo: () =>
    set((state) => {
      const history = undo(state.history)
      return { history, selection: pruneSelection(state.selection, history.present) }
    }),

  redo: () =>
    set((state) => {
      const history = redo(state.history)
      return { history, selection: pruneSelection(state.selection, history.present) }
    }),

  click: (id, modifiers) =>
    set((state) => ({
      selection: clickSelection(state.selection, state.history.present.map((page) => page.id), id, modifiers)
    })),

  selectAll: () =>
    set((state) => ({
      selection: { ids: new Set(state.history.present.map((page) => page.id)), anchor: state.history.present[0]?.id ?? null }
    })),

  clearSelection: () => set({ selection: emptySelection() }),

  dropSource: (sourceId) =>
    set((state) => {
      const next = removeSourcePages(state.history.present, sourceId)
      if (next.length === state.history.present.length) return state
      return { history: commit(state.history, next), selection: pruneSelection(state.selection, next) }
    })
}))
