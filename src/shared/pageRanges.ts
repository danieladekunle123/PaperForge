/** Parses and validates page range text such as "1-3, 7, 9-". Page numbers are one-based in text. */

export interface RangeSegment {
  /** Zero-based first page. */
  start: number
  /** Zero-based last page, inclusive. */
  end: number
  label: string
}

export type RangeParseResult =
  | { ok: true; segments: RangeSegment[]; pages: number[] }
  | { ok: false; error: string }

const DASHES = /[‐-―−]/g

export function parsePageRanges(input: string, pageCount: number): RangeParseResult {
  const text = input.replace(DASHES, '-').trim()
  if (!text) return { ok: false, error: 'Enter at least one page or range, such as 1-3, 7.' }
  if (pageCount < 1) return { ok: false, error: 'This document has no pages.' }

  const segments: RangeSegment[] = []
  for (const rawPart of text.split(/[,;]/)) {
    const part = rawPart.trim()
    if (!part) continue
    const match = /^(\d*)\s*-\s*(\d*)$/.exec(part)
    let first: number
    let last: number
    if (match) {
      if (!match[1] && !match[2]) return { ok: false, error: `“${part}” is not a page range.` }
      first = match[1] ? Number(match[1]) : 1
      last = match[2] ? Number(match[2]) : pageCount
    } else if (/^\d+$/.test(part)) {
      first = last = Number(part)
    } else {
      return { ok: false, error: `“${part}” is not a page number or range. Use a form like 1-3, 7.` }
    }
    if (first < 1 || last < 1) return { ok: false, error: 'Page numbers start at 1.' }
    if (first > pageCount) {
      return { ok: false, error: `Page ${first} does not exist. This document has ${pageCount} page${pageCount === 1 ? '' : 's'}.` }
    }
    if (last > pageCount) {
      return { ok: false, error: `Page ${last} does not exist. This document has ${pageCount} page${pageCount === 1 ? '' : 's'}.` }
    }
    if (first > last) return { ok: false, error: `“${part}” runs backwards. Write the lower page number first.` }
    segments.push({ start: first - 1, end: last - 1, label: first === last ? `${first}` : `${first}-${last}` })
  }
  if (segments.length === 0) return { ok: false, error: 'Enter at least one page or range, such as 1-3, 7.' }

  const pages: number[] = []
  for (const segment of segments) {
    for (let i = segment.start; i <= segment.end; i++) pages.push(i)
  }
  return { ok: true, segments, pages }
}

/** Compact text form of a page list, for example [0,1,2,6] becomes "1-3, 7". */
export function formatPageList(pages: number[]): string {
  const parts: string[] = []
  let i = 0
  while (i < pages.length) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++
    parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}-${pages[j] + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}
