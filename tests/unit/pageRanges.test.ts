import { describe, expect, it } from 'vitest'
import { formatPageList, parsePageRanges } from '../../src/shared/pageRanges'

function pages(input: string, count: number): number[] {
  const result = parsePageRanges(input, count)
  if (!result.ok) throw new Error(result.error)
  return result.pages
}

function error(input: string, count: number): string {
  const result = parsePageRanges(input, count)
  if (result.ok) throw new Error('expected a failure')
  return result.error
}

describe('parsePageRanges', () => {
  it('reads single pages and ranges, converting to zero-based', () => {
    expect(pages('1', 5)).toEqual([0])
    expect(pages('1-3', 5)).toEqual([0, 1, 2])
    expect(pages('1-2, 5', 5)).toEqual([0, 1, 4])
  })

  it('keeps the order the user wrote, including repeats', () => {
    expect(pages('5, 1-2, 1', 5)).toEqual([4, 0, 1, 0])
  })

  it('supports open-ended ranges', () => {
    expect(pages('4-', 5)).toEqual([3, 4])
    expect(pages('-2', 5)).toEqual([0, 1])
  })

  it('accepts typographic dashes, semicolons and stray spaces', () => {
    expect(pages(' 1 – 3 ; 5 ', 5)).toEqual([0, 1, 2, 4])
    expect(pages('1—2', 5)).toEqual([0, 1])
    expect(pages('1,,2,', 5)).toEqual([0, 1])
  })

  it('reports segments with labels for naming outputs', () => {
    const result = parsePageRanges('1-3, 7', 9)
    expect(result.ok && result.segments.map((segment) => segment.label)).toEqual(['1-3', '7'])
  })

  it('explains out-of-range pages using the document length', () => {
    expect(error('9', 5)).toBe('Page 9 does not exist. This document has 5 pages.')
    expect(error('2-9', 1)).toBe('Page 2 does not exist. This document has 1 page.')
  })

  it('explains other invalid input', () => {
    expect(error('', 5)).toContain('Enter at least one')
    expect(error('  ,  ', 5)).toContain('Enter at least one')
    expect(error('0', 5)).toBe('Page numbers start at 1.')
    expect(error('3-1', 5)).toContain('runs backwards')
    expect(error('abc', 5)).toContain('“abc” is not a page number')
    expect(error('1-2-3', 5)).toContain('not a page number')
    expect(error('-', 5)).toContain('not a page range')
    expect(error('1.5', 5)).toContain('not a page number')
    expect(error('1', 0)).toContain('no pages')
  })
})

describe('formatPageList', () => {
  it('collapses runs', () => {
    expect(formatPageList([0, 1, 2, 6])).toBe('1-3, 7')
    expect(formatPageList([4])).toBe('5')
    expect(formatPageList([])).toBe('')
  })
})
