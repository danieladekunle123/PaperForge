export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

const POINTS_PER_MM = 72 / 25.4

export function formatPageSize(width: number, height: number): string {
  const mmW = Math.round(width / POINTS_PER_MM)
  const mmH = Math.round(height / POINTS_PER_MM)
  const named = namedPaper(width, height)
  return `${mmW} × ${mmH} mm${named ? ` (${named})` : ''}`
}

function namedPaper(width: number, height: number): string | null {
  const [short, long] = width < height ? [width, height] : [height, width]
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 2.5
  if (near(short, 595.28) && near(long, 841.89)) return 'A4'
  if (near(short, 612) && near(long, 792)) return 'Letter'
  if (near(short, 612) && near(long, 1008)) return 'Legal'
  if (near(short, 841.89) && near(long, 1190.55)) return 'A3'
  if (near(short, 419.53) && near(long, 595.28)) return 'A5'
  return null
}

/** PDF date strings look like D:20240131120000+01'00'. */
export function formatPdfDate(value: string): string {
  const match = /^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value)
  if (!match) return value
  const [, y, mo = '01', d = '01', h, mi] = match
  return h ? `${y}-${mo}-${d} ${h}:${mi ?? '00'}` : `${y}-${mo}-${d}`
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}
