import { useEffect, useState } from 'react'
import { Minimize2, TriangleAlert } from 'lucide-react'
import type { CompressResult } from '../../../shared/types'
import { sourceRef } from '../store/workspace'
import { useSettings } from '../store/settings'
import { ToolHeader } from '../components/Shell'
import { Banner, Button, cx, Toggle } from '../components/ui'
import { NoDocument, saveAndRun, SourcePicker, usePdfSource, usePrimaryAction, useSignatureGate } from '../components/toolKit'
import { formatBytes, stripExtension } from '../lib/format'

type Mode = 'lossless' | 'balanced' | 'strong' | 'rasterize'

const MODES: { id: Exclude<Mode, 'rasterize'>; title: string; body: string; quality: string }[] = [
  {
    id: 'lossless',
    title: 'Lossless optimisation',
    body: 'Removes unused objects and recompresses data streams. Pages look exactly the same.',
    quality: 'Image quality is not touched'
  },
  {
    id: 'balanced',
    title: 'Balanced image compression',
    body: 'Images above 200 DPI are reduced to 150 DPI and re-encoded at JPEG quality 75. Good for sharing.',
    quality: 'Reduces image quality slightly'
  },
  {
    id: 'strong',
    title: 'Stronger image compression',
    body: 'Images above 130 DPI are reduced to 96 DPI and re-encoded at JPEG quality 55. Good for email limits.',
    quality: 'Reduces image quality visibly'
  }
]

function ResultCard({ result }: { result: CompressResult }) {
  const smaller = result.outputSize < result.originalSize
  const percent = Math.abs(result.percentChange)
  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4" data-testid="compress-result">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Original size" value={formatBytes(result.originalSize)} />
        <Stat label="Result size" value={formatBytes(result.outputSize)} />
        <Stat label="Change" value={`${result.percentChange > 0 ? '+' : smaller ? '−' : ''}${percent.toFixed(1)}%`} tone={smaller ? 'text-ok' : 'text-warn'} />
      </div>
      {result.noImprovement ? (
        <Banner kind="info">
          This PDF is already well optimised for this mode: the result would not be smaller, so no file was written. Your original is fine as it is. A stronger mode may help if it contains large images.
        </Banner>
      ) : (
        <Banner kind="success">
          <p className="selectable break-all">Saved to {result.outputs?.[0]?.path}. Reopened and verified.</p>
        </Banner>
      )}
      <p className="text-xs text-muted" data-testid="compress-quality">
        {result.rasterized
          ? 'Whole pages were turned into images: text selection, links and vector sharpness are gone from this output.'
          : result.qualityReduced
            ? `Image quality was reduced: ${result.imagesRecompressed} image${result.imagesRecompressed === 1 ? ' was' : 's were'} re-encoded. Text and vector content were not changed.`
            : 'Image quality was not reduced.'}
      </p>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] text-subtle">{label}</div>
      <div className={cx('text-lg font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  )
}

export default function CompressTool() {
  const { entry, ready, select } = usePdfSource()
  const defaultMode = useSettings((state) => state.settings.defaultCompression)
  const [mode, setMode] = useState<Mode>(defaultMode)
  const [rasterAck, setRasterAck] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<CompressResult | null>(null)
  const gate = useSignatureGate(entry, mode === 'rasterize' ? 'rasterize' : 'whole-document')

  useEffect(() => setResult(null), [entry?.id, mode])

  const blocked = mode === 'rasterize' && !rasterAck
  const canRun = !!entry && !blocked && gate.ok && !running

  const run = async () => {
    if (!entry) return
    setRunning(true)
    setResult(null)
    const done = await saveAndRun({
      defaultName: `${stripExtension(entry.name)}-compressed.pdf`,
      label: 'Compress',
      build: (outputId) => ({ op: 'compress', params: { source: sourceRef(entry.id), mode, output: { outputId } } })
    })
    setRunning(false)
    if (done) setResult(done as CompressResult)
  }

  usePrimaryAction('Compress', canRun, () => void run())

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="compress-tool">
      <ToolHeader title="Compress" description="Make a smaller copy. PaperForge reports the real result, and writes nothing if the file would not shrink.">
        <SourcePicker entry={entry} ready={ready} select={select} />
      </ToolHeader>
      {!entry ? (
        <NoDocument title="Open a PDF to compress">Choose how far to go, then compare sizes after it runs.</NoDocument>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="mx-auto max-w-2xl space-y-4">
            <p className="text-sm">
              <span className="font-medium">{entry.name}</span> <span className="text-muted">· {formatBytes(entry.sizeBytes)}</span>
            </p>
            <div role="radiogroup" aria-label="Compression mode" className="space-y-2">
              {MODES.map((option) => (
                <ModeCard key={option.id} active={mode === option.id} onSelect={() => setMode(option.id)} title={option.title} body={option.body} tag={option.quality} testId={`mode-${option.id}`} />
              ))}
            </div>
            <div className="rounded-lg border border-line p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-warn">
                <TriangleAlert size={14} /> Destructive option
              </h3>
              <ModeCard
                active={mode === 'rasterize'}
                onSelect={() => setMode('rasterize')}
                title="Rasterise whole pages"
                body="Replaces every page with a 150 DPI image. Only use this when the other modes cannot shrink the file enough."
                tag="Removes selectable text, links and vector quality"
                danger
                testId="mode-rasterize"
              />
              {mode === 'rasterize' && (
                <div className="mt-2 px-1">
                  <Toggle checked={rasterAck} onChange={setRasterAck} label="I understand the output loses selectable text, links and vector quality." />
                </div>
              )}
            </div>
            {gate.notice}
            <div className="flex items-center gap-3">
              <Button variant="primary" icon={<Minimize2 size={14} />} disabled={!canRun} onClick={() => void run()} data-testid="compress-run">
                {running ? 'Compressing…' : 'Choose location and compress'}
              </Button>
            </div>
            {result && <ResultCard result={result} />}
          </div>
        </div>
      )}
    </div>
  )
}

function ModeCard({ active, onSelect, title, body, tag, danger, testId }: { active: boolean; onSelect: () => void; title: string; body: string; tag: string; danger?: boolean; testId?: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      data-testid={testId}
      className={cx('block w-full rounded-lg border p-3 text-left transition-colors', active ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:border-line-strong')}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-muted">{body}</span>
      <span className={cx('mt-1.5 block text-[11px] font-medium', danger ? 'text-danger' : 'text-subtle')}>{tag}</span>
    </button>
  )
}
