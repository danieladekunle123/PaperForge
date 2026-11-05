import { describe, expect, it } from 'vitest'
import { planSplit, sanitizeBaseName } from '../../src/shared/splitPlan'

describe('planSplit', () => {
  it('splits every page with padded names', () => {
    const plan = planSplit({ mode: 'each', baseName: 'Report.pdf', pageCount: 12 })
    expect(plan.ok && plan.groups.length).toBe(12)
    expect(plan.ok && plan.groups[0]).toEqual({ name: 'Report-page-01.pdf', pages: [0] })
    expect(plan.ok && plan.groups[11]).toEqual({ name: 'Report-page-12.pdf', pages: [11] })
  })

  it('splits custom ranges into one file per range', () => {
    const plan = planSplit({ mode: 'ranges', baseName: 'r', pageCount: 12, ranges: '1–3, 4-8, 9-12' })
    expect(plan.ok && plan.groups).toEqual([
      { name: 'r-pages-1-3.pdf', pages: [0, 1, 2] },
      { name: 'r-pages-4-8.pdf', pages: [3, 4, 5, 6, 7] },
      { name: 'r-pages-9-12.pdf', pages: [8, 9, 10, 11] }
    ])
  })

  it('reports invalid ranges', () => {
    const plan = planSplit({ mode: 'ranges', baseName: 'r', pageCount: 3, ranges: '1-9' })
    expect(plan).toEqual({ ok: false, error: 'Page 9 does not exist. This document has 3 pages.' })
  })

  it('splits every N pages, with a short final part', () => {
    const plan = planSplit({ mode: 'every', baseName: 'r', pageCount: 7, every: 3 })
    expect(plan.ok && plan.groups).toEqual([
      { name: 'r-part-1.pdf', pages: [0, 1, 2] },
      { name: 'r-part-2.pdf', pages: [3, 4, 5] },
      { name: 'r-part-3.pdf', pages: [6] }
    ])
  })

  it('rejects a bad N', () => {
    for (const every of [0, -1, 1.5, Number.NaN]) {
      expect(planSplit({ mode: 'every', baseName: 'r', pageCount: 7, every }).ok).toBe(false)
    }
  })

  it('extracts selected pages into one file', () => {
    const plan = planSplit({ mode: 'selected', baseName: 'r', pageCount: 7, selected: [1, 4] })
    expect(plan.ok && plan.groups).toEqual([{ name: 'r-extract.pdf', pages: [1, 4] }])
    expect(planSplit({ mode: 'selected', baseName: 'r', pageCount: 7, selected: [] }).ok).toBe(false)
  })

  it('produces names that never collide across modes', () => {
    const plan = planSplit({ mode: 'each', baseName: 'r', pageCount: 150 })
    if (!plan.ok) throw new Error(plan.error)
    expect(new Set(plan.groups.map((group) => group.name)).size).toBe(150)
    expect(plan.groups[0].name).toBe('r-page-001.pdf')
  })
})

describe('sanitizeBaseName', () => {
  it('strips the extension and unsafe characters and keeps Unicode', () => {
    expect(sanitizeBaseName('a/b:c*?.PDF')).toBe('a_b_c__')
    expect(sanitizeBaseName('résumé 文档.pdf')).toBe('résumé 文档')
    expect(sanitizeBaseName('name.. ')).toBe('name')
    expect(sanitizeBaseName('...')).toBe('document')
  })
})
