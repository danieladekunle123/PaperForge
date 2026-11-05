/**
 * Turns the facts probed from source documents into specific statements about what an output keeps.
 * The UI shows these before export, so limits are visible instead of being discovered afterwards.
 */
import type { PdfFeatures, PdfSecurity } from './types'

export interface PreservationNote {
  level: 'info' | 'warn'
  text: string
}

export interface SourceFacts {
  name: string
  features?: PdfFeatures
  security?: PdfSecurity
}

export type OperationKind = 'assemble-preserve' | 'assemble-fit' | 'whole-document' | 'rasterize'

export interface PreservationReport {
  notes: PreservationNote[]
  /** Existing digital signatures would become invalid, so the user must acknowledge this first. */
  breaksSignatures: boolean
}

function names(sources: SourceFacts[]): string {
  const list = sources.slice(0, 2).map((source) => `“${source.name}”`)
  if (sources.length > 2) list.push(`${sources.length - 2} more`)
  return list.join(', ')
}

export function buildPreservationReport(sources: SourceFacts[], operation: OperationKind): PreservationReport {
  const notes: PreservationNote[] = []
  const having = (test: (features: PdfFeatures) => boolean) => sources.filter((source) => source.features && test(source.features))
  const assembling = operation === 'assemble-preserve' || operation === 'assemble-fit'
  const signed = having((features) => features.signed)

  if (signed.length) {
    notes.push({
      level: 'warn',
      text: `${names(signed)} contains a digital signature. Any change to the file makes that signature invalid, and the output cannot prove the original was signed.`
    })
  }

  const forms = having((features) => features.formPages > 0)
  if (forms.length) {
    if (operation === 'assemble-fit' || operation === 'rasterize') {
      notes.push({ level: 'warn', text: `Form fields in ${names(forms)} are flattened: current values stay visible but can no longer be edited.` })
    } else if (assembling) {
      notes.push({ level: 'info', text: `Form fields in ${names(forms)} stay editable. Fields on duplicated pages are renamed so they remain independent.` })
    }
  }

  const xfa = having((features) => features.xfa)
  if (xfa.length && assembling) {
    notes.push({ level: 'warn', text: `${names(xfa)} uses an XFA form. XFA data is not carried over, so dynamic form behaviour is lost.` })
  }

  const annotated = having((features) => features.annotationPages > 0)
  if (annotated.length) {
    if (operation === 'assemble-fit' || operation === 'rasterize') {
      notes.push({ level: 'warn', text: `Annotations in ${names(annotated)} are flattened into page content.` })
    } else if (operation === 'assemble-preserve') {
      notes.push({ level: 'info', text: `Annotations in ${names(annotated)} are kept on their pages.` })
    }
  }

  const bookmarked = having((features) => features.tocEntries > 0)
  if (bookmarked.length && assembling) {
    notes.push({ level: 'info', text: 'Bookmarks are rebuilt for pages in the output and point to the top of each page. Bookmarks to removed pages are dropped.' })
  }

  const attached = having((features) => features.attachments > 0)
  if (attached.length && assembling) {
    notes.push({ level: 'info', text: `File attachments from ${names(attached)} are copied to the output.` })
  }

  const scripted = having((features) => features.javascript)
  if (scripted.length && assembling) {
    notes.push({ level: 'info', text: `Document-level scripts and open actions in ${names(scripted)} are not copied.` })
  }

  const layered = having((features) => features.layers > 0)
  if (layered.length && (assembling || operation === 'rasterize')) {
    notes.push({ level: 'warn', text: `${names(layered)} has optional content layers. Check layer visibility in the output.` })
  }

  const encrypted = sources.filter((source) => source.security?.encrypted)
  if (encrypted.length && (assembling || operation === 'rasterize')) {
    notes.push({ level: 'warn', text: `${names(encrypted)} is password protected, but this output will not be. Use the Password tool to protect it again.` })
  }

  if (assembling) {
    if (operation === 'assemble-preserve') {
      notes.push({ level: 'info', text: 'PDF pages are copied as they are: text stays selectable, vector content stays sharp, and links keep working where their target is in the output.' })
    } else {
      notes.push({ level: 'info', text: 'Pages are scaled onto the chosen paper size as vector content: text stays selectable and links keep working.' })
    }
    notes.push({ level: 'info', text: 'Document properties such as title and author are not inherited from the sources. Page labels are not kept.' })
  }

  return { notes, breaksSignatures: signed.length > 0 }
}
