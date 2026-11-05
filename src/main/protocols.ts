/**
 * Two private URL schemes:
 *  - paperforge://app/...  the built renderer
 *  - pfdoc://source/<id>   bytes of a file the user imported, with Range support for pdf.js
 * Neither can reach anything outside its allow-list.
 */
import { createReadStream, promises as fs } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { APP_ORIGIN, APP_SCHEME, cspFor, DOC_SCHEME } from './security'
import { CONTENT_TYPES, type FileRegistry } from './registry'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.icc': 'application/vnd.iccprofile',
  '.woff2': 'font/woff2'
}

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    },
    {
      scheme: DOC_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
    }
  ])
}

export function installProtocols(rendererRoot: string, registry: FileRegistry, rendererUrl: string | undefined): void {
  if (!rendererUrl) {
    protocol.handle(APP_SCHEME, async (request) => {
      const url = new URL(request.url)
      if (url.host !== 'app') return new Response('Not found', { status: 404 })
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const target = normalize(join(rendererRoot, relative))
      if (!target.startsWith(rendererRoot + sep)) return new Response('Not found', { status: 404 })
      try {
        const data = await fs.readFile(target)
        return new Response(data, {
          headers: {
            'Content-Type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
            'Content-Security-Policy': cspFor(undefined),
            'X-Content-Type-Options': 'nosniff',
            'Cross-Origin-Resource-Policy': 'same-origin'
          }
        })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    })
  }

  const allowOrigin = rendererUrl ? new URL(rendererUrl).origin : APP_ORIGIN
  protocol.handle(DOC_SCHEME, async (request) => {
    const url = new URL(request.url)
    const entry = url.host === 'source' ? registry.source(url.pathname.slice(1)) : undefined
    const corsHeaders = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length'
    }
    if (!entry) return new Response('Not found', { status: 404, headers: corsHeaders })
    let size: number
    try {
      size = (await fs.stat(entry.path)).size
    } catch {
      return new Response('File is no longer available', { status: 410, headers: corsHeaders })
    }
    const headers: Record<string, string> = {
      ...corsHeaders,
      'Content-Type': CONTENT_TYPES[extname(entry.path).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '')
    if (range) {
      const start = Number(range[1])
      const end = Math.min(range[2] ? Number(range[2]) : size - 1, size - 1)
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } })
      }
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      headers['Content-Length'] = String(end - start + 1)
      const stream = Readable.toWeb(createReadStream(entry.path, { start, end })) as ReadableStream
      return new Response(stream, { status: 206, headers })
    }
    headers['Content-Length'] = String(size)
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(Readable.toWeb(createReadStream(entry.path)) as ReadableStream, { status: 200, headers })
  })
}
