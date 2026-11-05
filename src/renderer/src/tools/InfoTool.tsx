import { useEffect, useMemo, useState } from 'react'
import { Eraser, Save } from 'lucide-react'
import type { MetadataSpec } from '../../../shared/schemas'
import type { JobResult } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, Field, TextInput } from '../components/ui'
import { NoDocument, OutputSummary, saveAndRun, SourcePicker, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { formatBytes, formatPageSize, formatPdfDate, plural, stripExtension } from '../lib/format'

type Editable = Pick<MetadataSpec, 'title' | 'author' | 'subject' | 'keywords'>

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 py-1.5">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="selectable min-w-0 text-sm break-words">{value}</dd>
    </div>
  )
}

export default function InfoTool() {
  const { entry, ready, select } = usePdfSource()
  const [draft, setDraft] = useState<Editable>({})
  const [result, setResult] = useState<JobResult | null>(null)
  const gate = useSignatureGate(entry)
  const info = entry?.info

  useEffect(() => {
    setDraft({ title: info?.metadata?.title ?? '', author: info?.metadata?.author ?? '', subject: info?.metadata?.subject ?? '', keywords: info?.metadata?.keywords ?? '' })
    setResult(null)
  }, [entry?.id, info])

  const sizes = useMemo(() => {
    const groups = new Map<string, number>()
    for (const page of info?.pages ?? []) {
      const label = formatPageSize(page.width, page.height)
      groups.set(label, (groups.get(label) ?? 0) + 1)
    }
    return [...groups.entries()]
  }, [info])

  const changed = !!info?.metadata && (['title', 'author', 'subject', 'keywords'] as const).some((key) => (draft[key] ?? '') !== (info.metadata?.[key] ?? ''))
  const canSave = !!entry && changed && gate.ok

  const run = async (metadata: MetadataSpec, suffix: string) => {
    if (!entry) return
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-${suffix}.pdf`,
      label: 'Document properties',
      build: (outputId) => ({ op: 'apply', params: { source: sourceRef(entry.id), metadata, output: { outputId } } })
    })
    if (done) setResult(done)
  }

  usePrimaryAction('Save copy', canSave, () => void run({ mode: 'edit', ...draft }, 'edited'))

  const features = info?.features
  const featureList = features
    ? [
        features.tocEntries > 0 && plural(features.tocEntries, 'bookmark'),
        features.annotationPages > 0 && `Annotations on ${plural(features.annotationPages, 'page')}`,
        features.isForm && `Form fields on ${plural(features.formPages, 'page')}${features.xfa ? ' (XFA)' : ''}`,
        features.signed && 'Digital signature',
        features.attachments > 0 && plural(features.attachments, 'attachment'),
        features.layers > 0 && plural(features.layers, 'layer'),
        features.javascript && 'Scripts or open actions'
      ].filter(Boolean)
    : []

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="info-tool">
      <ToolHeader title="Document info" description="See what a PDF says about itself, and edit its ordinary properties in a new copy.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry || !info ? (
        <NoDocument title="Open a PDF to inspect">See page sizes, security status and document properties.</NoDocument>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto grid max-w-4xl gap-4 lg:grid-cols-2">
            <section className="rounded-lg border border-line bg-surface p-4">
              <h2 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">File</h2>
              <dl className="divide-y divide-line" data-testid="info-facts">
                <Row label="Filename" value={entry.name} />
                <Row label="File size" value={formatBytes(info.sizeBytes)} />
                <Row label="Pages" value={info.pageCount} />
                <Row
                  label="Page sizes"
                  value={
                    <ul>
                      {sizes.slice(0, 8).map(([label, count]) => (
                        <li key={label}>
                          {label}
                          {sizes.length > 1 ? ` · ${plural(count, 'page')}` : ''}
                        </li>
                      ))}
                      {sizes.length > 8 && <li className="text-subtle">and {sizes.length - 8} more sizes</li>}
                    </ul>
                  }
                />
                <Row label="Encryption" value={info.security?.encrypted ? info.security.encryption : 'Not encrypted'} />
                <Row label="PDF version" value={info.metadata?.format || 'Unknown'} />
                <Row label="Creator" value={info.metadata?.creator || 'Not set'} />
                <Row label="Producer" value={info.metadata?.producer || 'Not set'} />
                <Row label="Created" value={info.metadata?.creationDate ? formatPdfDate(info.metadata.creationDate) : 'Not set'} />
                <Row label="Modified" value={info.metadata?.modDate ? formatPdfDate(info.metadata.modDate) : 'Not set'} />
                <Row label="Contains" value={featureList.length ? featureList.join(', ') : 'No bookmarks, forms, attachments or signatures'} />
              </dl>
            </section>
            <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
              <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Properties</h2>
              {(['title', 'author', 'subject', 'keywords'] as const).map((key) => (
                <Field key={key} label={key[0].toUpperCase() + key.slice(1)}>
                  {(id) => <TextInput id={id} value={draft[key] ?? ''} onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.value }))} data-testid={`meta-${key}`} />}
                </Field>
              ))}
              {gate.notice}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Save size={14} />} disabled={!canSave} onClick={() => void run({ mode: 'edit', ...draft }, 'edited')} data-testid="meta-save">
                  Save a copy with changes
                </Button>
                <Button icon={<Eraser size={14} />} disabled={!gate.ok} onClick={() => void run({ mode: 'strip' }, 'no-properties')} data-testid="meta-strip">
                  Save a copy without properties
                </Button>
              </div>
              <Banner>
                Removing properties clears the document's title, author, subject, keywords, dates and XMP metadata. It is not full sanitisation: annotations, hidden layers, attachments, form data, file names in links and content such as headers can still identify people.
              </Banner>
              {result && <OutputSummary result={result} />}
            </section>
          </div>
        </div>
      )}
    </div>
  )
}
