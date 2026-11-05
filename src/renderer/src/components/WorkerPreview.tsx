/**
 * Live previews come from the worker running the real export code on one page, so what is shown is
 * what will be written. Requests are debounced, and a newer one replaces any still waiting.
 */
import { useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { PreviewResult, RendererJob } from '../../../shared/types'
import { Banner } from './ui'

let nextKey = 1

export function useWorkerPreview(job: RendererJob | null, debounceMs = 180) {
  const [result, setResult] = useState<PreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = useRef(`preview-${nextKey++}`)
  const serialized = job ? JSON.stringify(job) : null

  useEffect(() => {
    if (!serialized) {
      setResult(null)
      setError(null)
      setLoading(false)
      return
    }
    let live = true
    setLoading(true)
    const timer = setTimeout(() => {
      void window.paperforge.interactive(JSON.parse(serialized) as RendererJob, key.current).then((response) => {
        if (!live) return
        if (response.ok) {
          setResult(response.data as PreviewResult)
          setError(null)
          setLoading(false)
        } else if (!response.superseded) {
          setError(response.error.message)
          setLoading(false)
        }
      })
    }, debounceMs)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [debounceMs, serialized])

  return { result, error, loading }
}

export function WorkerPreviewImage({ job, emptyText, label }: { job: RendererJob | null; emptyText?: string; label: string }) {
  const { result, error, loading } = useWorkerPreview(job)
  return (
    <div className="relative flex h-full min-h-0 w-full items-center justify-center overflow-hidden" data-testid="worker-preview">
      {error ? (
        <Banner kind="error" className="max-w-sm">
          {error}
        </Banner>
      ) : result && job ? (
        <img src={`data:image/png;base64,${result.pngBase64}`} alt={label} draggable={false} className="max-h-full max-w-full bg-white object-contain shadow-lg" />
      ) : !job ? (
        <p className="p-6 text-center text-xs text-subtle">{emptyText}</p>
      ) : null}
      {loading && (
        <span className="absolute top-2 right-2 rounded bg-surface/80 p-1 text-muted">
          <LoaderCircle size={14} className="spin" aria-label="Updating preview" />
        </span>
      )}
    </div>
  )
}
