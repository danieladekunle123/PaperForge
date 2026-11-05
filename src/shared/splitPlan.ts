/** Works out which output files a split produces, so the user sees them before anything runs. */
import { parsePageRanges } from './pageRanges'

export interface SplitGroup {
  name: string
  pages: number[]
}

export type SplitMode = 'selected' | 'each' | 'ranges' | 'every'

export interface SplitRequest {
  mode: SplitMode
  baseName: string
  pageCount: number
  /** Zero-based pages for 'selected'. */
  selected?: number[]
  /** Range text for 'ranges'. Each comma-separated part becomes one file. */
  ranges?: string
  /** Pages per file for 'every'. */
  every?: number
}

export type SplitPlan = { ok: true; groups: SplitGroup[] } | { ok: false; error: string }

export function sanitizeBaseName(name: string): string {
  const cleaned = name
    .replace(/\.pdf$/i, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
  return cleaned || 'document'
}

function pad(value: number, total: number): string {
  return String(value).padStart(String(total).length, '0')
}

export function planSplit(request: SplitRequest): SplitPlan {
  const base = sanitizeBaseName(request.baseName)
  const { pageCount } = request
  if (pageCount < 1) return { ok: false, error: 'This document has no pages.' }

  switch (request.mode) {
    case 'selected': {
      const pages = request.selected ?? []
      if (pages.length === 0) return { ok: false, error: 'Select at least one page to extract.' }
      return { ok: true, groups: [{ name: `${base}-extract.pdf`, pages: [...pages] }] }
    }
    case 'each': {
      const groups: SplitGroup[] = []
      for (let i = 0; i < pageCount; i++) {
        groups.push({ name: `${base}-page-${pad(i + 1, pageCount)}.pdf`, pages: [i] })
      }
      return { ok: true, groups }
    }
    case 'ranges': {
      const parsed = parsePageRanges(request.ranges ?? '', pageCount)
      if (!parsed.ok) return parsed
      return {
        ok: true,
        groups: parsed.segments.map((segment) => {
          const pages: number[] = []
          for (let i = segment.start; i <= segment.end; i++) pages.push(i)
          return { name: `${base}-pages-${segment.label}.pdf`, pages }
        })
      }
    }
    case 'every': {
      const every = request.every ?? 0
      if (!Number.isInteger(every) || every < 1) {
        return { ok: false, error: 'Enter a whole number of pages per file, 1 or more.' }
      }
      const groups: SplitGroup[] = []
      const parts = Math.ceil(pageCount / every)
      for (let start = 0, part = 1; start < pageCount; start += every, part++) {
        const pages: number[] = []
        for (let i = start; i < Math.min(start + every, pageCount); i++) pages.push(i)
        groups.push({ name: `${base}-part-${pad(part, parts)}.pdf`, pages })
      }
      return { ok: true, groups }
    }
  }
}
