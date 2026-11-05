import { describe, expect, it } from 'vitest'
import {
  clickSelection,
  commit,
  createHistory,
  duplicatePages,
  emptySelection,
  HISTORY_LIMIT,
  insertAt,
  instantiate,
  movePages,
  normalizeRotation,
  nudgePages,
  pruneSelection,
  redo,
  removePages,
  removeSourcePages,
  rotatePages,
  undo,
  type OutputPage
} from '../../src/shared/assemblyModel'

function counterIds(prefix = 'n'): () => string {
  let i = 0
  return () => `${prefix}${i++}`
}

function pdf(id: string, pageIndex = 0, sourceId = 'a'): OutputPage {
  return { id, kind: 'pdf', sourceId, pageIndex, rotation: 0 }
}

const ids = (list: OutputPage[]) => list.map((page) => page.id)

describe('instantiate', () => {
  it('gives every instance a new id, even for the same source page', () => {
    const made = instantiate(
      [
        { kind: 'pdf', sourceId: 'a', pageIndex: 3 },
        { kind: 'pdf', sourceId: 'a', pageIndex: 3 },
        { kind: 'blank' }
      ],
      counterIds()
    )
    expect(ids(made)).toEqual(['n0', 'n1', 'n2'])
    expect(made[0].rotation).toBe(0)
  })
})

describe('movePages', () => {
  const list = [pdf('a'), pdf('b'), pdf('c'), pdf('d'), pdf('e')]

  it('moves a single page forward and back', () => {
    expect(ids(movePages(list, ['a'], 3))).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(ids(movePages(list, ['d'], 0))).toEqual(['d', 'a', 'b', 'c', 'e'])
    expect(ids(movePages(list, ['a'], 5))).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('keeps a scattered group in list order, whatever order it was selected in', () => {
    expect(ids(movePages(list, ['d', 'b'], 5))).toEqual(['a', 'c', 'e', 'b', 'd'])
    expect(ids(movePages(list, ['e', 'a', 'c'], 2))).toEqual(['b', 'a', 'c', 'e', 'd'])
  })

  it('leaves the list identical when nothing actually moves', () => {
    expect(movePages(list, ['b'], 1)).toBe(list)
    expect(movePages(list, ['b'], 2)).toBe(list)
    expect(movePages(list, [], 2)).toBe(list)
    expect(movePages(list, ['a', 'b'], 1)).toBe(list)
  })

  it('clamps out-of-range targets', () => {
    expect(ids(movePages(list, ['a'], 99))).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(ids(movePages(list, ['e'], -4))).toEqual(['e', 'a', 'b', 'c', 'd'])
  })

  it('treats two copies of one source page as separate pages', () => {
    const copies = [pdf('x', 2), pdf('y', 2), pdf('z', 5)]
    expect(ids(movePages(copies, ['y'], 3))).toEqual(['x', 'z', 'y'])
  })
})

describe('nudgePages', () => {
  const list = [pdf('a'), pdf('b'), pdf('c'), pdf('d')]

  it('shifts a group one step as a unit', () => {
    expect(ids(nudgePages(list, ['b', 'c'], 1))).toEqual(['a', 'd', 'b', 'c'])
    expect(ids(nudgePages(list, ['b', 'c'], -1))).toEqual(['b', 'c', 'a', 'd'])
  })

  it('does nothing at the ends', () => {
    expect(nudgePages(list, ['a'], -1)).toBe(list)
    expect(nudgePages(list, ['d'], 1)).toBe(list)
  })
})

describe('rotatePages', () => {
  it('rotates in 90 degree steps and wraps', () => {
    const list = [pdf('a')]
    expect(rotatePages(list, ['a'], 90)[0].rotation).toBe(90)
    expect(rotatePages(list, ['a'], -90)[0].rotation).toBe(270)
    let next = list
    for (let i = 0; i < 4; i++) next = rotatePages(next, ['a'], 90)
    expect(next[0].rotation).toBe(0)
  })

  it('rotates one duplicate and not the other', () => {
    const list = [pdf('x', 2), pdf('y', 2)]
    const rotated = rotatePages(list, ['y'], 90)
    expect(rotated[0].rotation).toBe(0)
    expect(rotated[1].rotation).toBe(90)
  })

  it('normalises', () => {
    expect(normalizeRotation(-90)).toBe(270)
    expect(normalizeRotation(450)).toBe(90)
  })
})

describe('duplicatePages', () => {
  it('places copies after the last selected page, in order, with new ids', () => {
    const list = [pdf('a', 0), pdf('b', 1), pdf('c', 2)]
    const { pages, newIds } = duplicatePages(list, ['c', 'a'], counterIds())
    expect(ids(pages)).toEqual(['a', 'b', 'c', 'n0', 'n1'])
    expect(newIds).toEqual(['n0', 'n1'])
    const copyOfA = pages[3]
    expect(copyOfA.kind === 'pdf' && copyOfA.pageIndex).toBe(0)
  })

  it('copies rotation', () => {
    const list = rotatePages([pdf('a')], ['a'], 90)
    const { pages } = duplicatePages(list, ['a'], counterIds())
    expect(pages[1].rotation).toBe(90)
  })

  it('is a no-op for an empty selection', () => {
    const list = [pdf('a')]
    expect(duplicatePages(list, [], counterIds()).pages).toBe(list)
  })
})

describe('removal', () => {
  it('removes pages by instance, not by source page', () => {
    const list = [pdf('x', 2), pdf('y', 2)]
    expect(ids(removePages(list, ['x']))).toEqual(['y'])
  })

  it('drops every page of a removed source but keeps blanks', () => {
    const list: OutputPage[] = [pdf('a', 0, 's1'), { id: 'b', kind: 'blank', rotation: 0 }, pdf('c', 0, 's2'), { id: 'i', kind: 'image', sourceId: 's1', rotation: 0 }]
    expect(ids(removeSourcePages(list, 's1'))).toEqual(['b', 'c'])
  })
})

describe('insertAt', () => {
  it('inserts and clamps', () => {
    const list = [pdf('a'), pdf('b')]
    expect(ids(insertAt(list, 1, [pdf('n')]))).toEqual(['a', 'n', 'b'])
    expect(ids(insertAt(list, 99, [pdf('n')]))).toEqual(['a', 'b', 'n'])
    expect(ids(insertAt(list, -1, [pdf('n')]))).toEqual(['n', 'a', 'b'])
  })
})

describe('undo and redo', () => {
  it('walks a realistic edit sequence both ways', () => {
    let history = createHistory()
    const first = [pdf('a'), pdf('b'), pdf('c')]
    history = commit(history, first)
    history = commit(history, movePages(history.present, ['c'], 0))
    history = commit(history, rotatePages(history.present, ['a'], 90))
    const { pages } = duplicatePages(history.present, ['b'], counterIds())
    history = commit(history, pages)
    expect(ids(history.present)).toEqual(['c', 'a', 'b', 'n0'])

    history = undo(history)
    expect(ids(history.present)).toEqual(['c', 'a', 'b'])
    expect(history.present[1].rotation).toBe(90)
    history = undo(history)
    expect(history.present[1].rotation).toBe(0)
    history = undo(history)
    expect(ids(history.present)).toEqual(['a', 'b', 'c'])
    history = redo(history)
    expect(ids(history.present)).toEqual(['c', 'a', 'b'])
    history = redo(history)
    history = redo(history)
    expect(ids(history.present)).toEqual(['c', 'a', 'b', 'n0'])
    expect(history.present[1].rotation).toBe(90)
  })

  it('clears redo after a new edit', () => {
    let history = commit(createHistory(), [pdf('a')])
    history = undo(history)
    history = commit(history, [pdf('z')])
    expect(history.future).toEqual([])
    expect(redo(history)).toBe(history)
  })

  it('ignores edits that change nothing', () => {
    const start = commit(createHistory(), [pdf('a'), pdf('b')])
    const next = commit(start, movePages(start.present, ['a'], 0))
    expect(next).toBe(start)
    expect(next.past).toHaveLength(1)
  })

  it('does nothing at the ends of history', () => {
    const history = createHistory()
    expect(undo(history)).toBe(history)
    expect(redo(history)).toBe(history)
  })

  it('bounds its memory', () => {
    let history = createHistory()
    for (let i = 0; i < HISTORY_LIMIT + 50; i++) history = commit(history, [pdf(`p${i}`)])
    expect(history.past).toHaveLength(HISTORY_LIMIT)
  })
})

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd', 'e']

  it('plain click replaces', () => {
    const selected = clickSelection(clickSelection(emptySelection(), order, 'a', {}), order, 'c', {})
    expect([...selected.ids]).toEqual(['c'])
    expect(selected.anchor).toBe('c')
  })

  it('ctrl click toggles', () => {
    let selected = clickSelection(emptySelection(), order, 'a', {})
    selected = clickSelection(selected, order, 'c', { ctrl: true })
    expect([...selected.ids].sort()).toEqual(['a', 'c'])
    selected = clickSelection(selected, order, 'a', { ctrl: true })
    expect([...selected.ids]).toEqual(['c'])
  })

  it('shift click selects a range in either direction', () => {
    let selected = clickSelection(emptySelection(), order, 'b', {})
    selected = clickSelection(selected, order, 'd', { shift: true })
    expect([...selected.ids]).toEqual(['b', 'c', 'd'])
    selected = clickSelection(selected, order, 'a', { shift: true })
    expect([...selected.ids]).toEqual(['a', 'b'])
  })

  it('ctrl+shift adds a range to the selection', () => {
    let selected = clickSelection(emptySelection(), order, 'a', {})
    selected = clickSelection(selected, order, 'c', { ctrl: true })
    selected = clickSelection(selected, order, 'e', { ctrl: true, shift: true })
    expect([...selected.ids].sort()).toEqual(['a', 'c', 'd', 'e'])
  })

  it('shift click with no anchor behaves like a click', () => {
    const selected = clickSelection(emptySelection(), order, 'c', { shift: true })
    expect([...selected.ids]).toEqual(['c'])
  })

  it('prune removes ids that an undo took away', () => {
    const selected = { ids: new Set(['a', 'gone']), anchor: 'gone' }
    const pruned = pruneSelection(selected, [pdf('a')])
    expect([...pruned.ids]).toEqual(['a'])
    expect(pruned.anchor).toBeNull()
    const unchanged = { ids: new Set(['a']), anchor: 'a' }
    expect(pruneSelection(unchanged, [pdf('a')])).toBe(unchanged)
  })
})
