import { memo, useEffect, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { requestThumbnail } from '../lib/pdfEngine'
import { cx } from './ui'

/**
 * Draws a page fitted inside its box. Pages render once at their own rotation and added rotation is a
 * CSS transform, so rotating a page in the workspace is instant and needs no re-render.
 */
export const PageThumb = memo(function PageThumb({
  sourceId,
  pageIndex,
  aspect,
  rotation,
  box,
  blank
}: {
  sourceId?: string
  /** Null for an image source. */
  pageIndex?: number | null
  /** Width over height of the page as displayed before added rotation. */
  aspect: number
  rotation: number
  box: { width: number; height: number }
  blank?: boolean
}) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (blank || !sourceId) return
    setUrl(null)
    setFailed(false)
    return requestThumbnail(
      sourceId,
      pageIndex ?? null,
      (ready) => setUrl(ready),
      () => setFailed(true)
    )
  }, [blank, pageIndex, sourceId])

  const turned = rotation === 90 || rotation === 270
  const shownAspect = turned ? 1 / aspect : aspect
  const scale = Math.min(box.width / shownAspect, box.height)
  const shownHeight = scale
  const shownWidth = scale * shownAspect
  const sheetWidth = turned ? shownHeight : shownWidth
  const sheetHeight = turned ? shownWidth : shownHeight

  return (
    <div className="flex items-center justify-center" style={{ width: box.width, height: box.height }}>
      <div className="relative shrink-0" style={{ width: shownWidth, height: shownHeight }}>
        <div
          className={cx('checker absolute top-1/2 left-1/2 overflow-hidden rounded-[2px] shadow-[0_1px_4px_rgb(0_0_0/0.35)] transition-transform duration-150')}
          style={{
            width: sheetWidth,
            height: sheetHeight,
            transform: `translate(-50%, -50%) rotate(${rotation}deg)`
          }}
        >
          {url && <img src={url} alt="" draggable={false} className="h-full w-full object-fill" />}
          {!blank && !url && !failed && <div className="h-full w-full animate-pulse bg-black/5" />}
          {failed && (
            <div className="flex h-full w-full items-center justify-center text-neutral-400" title="Preview unavailable">
              <ImageOff size={18} aria-label="Preview unavailable" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
