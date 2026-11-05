import { describe, expect, it } from 'vitest'
import { buildPreservationReport } from '../../src/shared/preservation'
import type { PdfFeatures, PdfSecurity } from '../../src/shared/types'

const NONE: PdfFeatures = {
  tocEntries: 0,
  annotationPages: 0,
  formPages: 0,
  isForm: false,
  xfa: false,
  signed: false,
  attachments: 0,
  layers: 0,
  javascript: false
}

const source = (features: Partial<PdfFeatures>, security?: Partial<PdfSecurity>) => ({
  name: 'a.pdf',
  features: { ...NONE, ...features },
  security: security as PdfSecurity
})

describe('buildPreservationReport', () => {
  it('requires acknowledgement for signed documents', () => {
    const report = buildPreservationReport([source({ signed: true })], 'assemble-preserve')
    expect(report.breaksSignatures).toBe(true)
    expect(report.notes[0].level).toBe('warn')
    expect(report.notes[0].text).toContain('digital signature')
  })

  it('does not nag about signatures otherwise', () => {
    expect(buildPreservationReport([source({})], 'assemble-preserve').breaksSignatures).toBe(false)
  })

  it('says forms stay live when preserving, and flatten when fitting', () => {
    const preserve = buildPreservationReport([source({ formPages: 1 })], 'assemble-preserve')
    expect(preserve.notes.find((note) => note.text.includes('stay editable'))).toBeTruthy()
    const fit = buildPreservationReport([source({ formPages: 1 })], 'assemble-fit')
    expect(fit.notes.find((note) => note.text.includes('flattened'))?.level).toBe('warn')
  })

  it('warns about XFA, layers and lost encryption', () => {
    const report = buildPreservationReport([source({ xfa: true, layers: 2 }, { encrypted: true })], 'assemble-preserve')
    const text = report.notes.map((note) => note.text).join(' ')
    expect(text).toContain('XFA')
    expect(text).toContain('layers')
    expect(text).toContain('will not be')
  })

  it('stays quiet for a whole-document edit of a plain file', () => {
    expect(buildPreservationReport([source({ tocEntries: 3 })], 'whole-document').notes).toEqual([])
  })

  it('tolerates a source with no probe data', () => {
    expect(buildPreservationReport([{ name: 'x.pdf' }], 'assemble-preserve').breaksSignatures).toBe(false)
  })
})
