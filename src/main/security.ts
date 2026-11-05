/** Window hardening: navigation, permissions, and the content security policy. */
import { session, shell, type BrowserWindow, type WebContents } from 'electron'
import type { ExternalLink } from '../shared/types'

export const APP_SCHEME = 'paperforge'
export const DOC_SCHEME = 'pfdoc'
export const APP_ORIGIN = `${APP_SCHEME}://app`

const PRODUCTION_CSP = [
  "default-src 'none'",
  // pdf.js decodes JPEG 2000 and JBIG2 through WebAssembly bundled with the app.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' blob: data: ${DOC_SCHEME}:`,
  `connect-src 'self' ${DOC_SCHEME}:`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'"
].join('; ')

function developmentCsp(rendererUrl: string): string {
  const origin = new URL(rendererUrl).origin
  const socket = origin.replace(/^http/, 'ws')
  return [
    `default-src 'self' ${origin}`,
    `script-src 'self' ${origin} 'unsafe-inline' 'wasm-unsafe-eval'`,
    `worker-src 'self' ${origin} blob:`,
    `style-src 'self' ${origin} 'unsafe-inline'`,
    `img-src 'self' ${origin} blob: data: ${DOC_SCHEME}:`,
    `connect-src 'self' ${origin} ${socket} ${DOC_SCHEME}:`,
    `font-src 'self' ${origin} data:`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

export function cspFor(rendererUrl: string | undefined): string {
  return rendererUrl ? developmentCsp(rendererUrl) : PRODUCTION_CSP
}

export function applySessionPolicy(rendererUrl: string | undefined): void {
  const ses = session.defaultSession
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.on('will-download', (event) => event.preventDefault())
  if (rendererUrl) {
    const csp = cspFor(rendererUrl)
    ses.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }
}

/** Only the app's own page may load. There is no way to navigate this window anywhere else. */
export function hardenContents(contents: WebContents, rendererUrl: string | undefined): void {
  const allowedOrigin = rendererUrl ? new URL(rendererUrl).origin : APP_ORIGIN
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!url.startsWith(allowedOrigin)) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

const EXTERNAL_LINKS: Record<ExternalLink, string> = {
  repository: 'https://github.com/danieladekunle123/PaperForge',
  agpl: 'https://www.gnu.org/licenses/agpl-3.0.html',
  'pymupdf-licensing': 'https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright',
  pymupdf: 'https://github.com/pymupdf/PyMuPDF',
  pillow: 'https://python-pillow.github.io/',
  pdfjs: 'https://mozilla.github.io/pdf.js/',
  electron: 'https://www.electronjs.org/'
}

/** External links come from a fixed list. The renderer names a link, it never supplies a URL. */
export async function openApprovedLink(link: ExternalLink): Promise<void> {
  const url = EXTERNAL_LINKS[link]
  if (url) await shell.openExternal(url)
}

export function isTrustedSender(frameUrl: string | undefined, window: BrowserWindow | null, rendererUrl: string | undefined): boolean {
  if (!frameUrl || !window) return false
  const allowed = rendererUrl ? new URL(rendererUrl).origin : APP_ORIGIN
  return frameUrl.startsWith(allowed)
}

export const EXTERNAL_LINK_KEYS = Object.keys(EXTERNAL_LINKS) as ExternalLink[]
