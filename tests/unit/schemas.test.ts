import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rendererJobSchema, settingsSchema, workerEventSchema, workerJobSchema } from '../../src/shared/schemas'

const fixtureDir = join(__dirname, '..', 'protocol-fixtures')

function fixtures(kind: 'valid' | 'invalid'): [string, unknown][] {
  return readdirSync(join(fixtureDir, kind)).map((name) => [name, JSON.parse(readFileSync(join(fixtureDir, kind, name), 'utf8'))])
}

describe('contract fixtures shared with the Python validator', () => {
  it.each(fixtures('valid'))('accepts %s', (_name, job) => {
    expect(workerJobSchema.safeParse(job).success).toBe(true)
  })

  it.each(fixtures('invalid'))('rejects %s', (_name, job) => {
    expect(workerJobSchema.safeParse(job).success).toBe(false)
  })
})

describe('renderer requests', () => {
  it('cannot name a path for a source or an output', () => {
    expect(
      rendererJobSchema.safeParse({
        op: 'save_text',
        params: { text: 'x', output: { path: 'C:\\evil.txt', overwrite: 'replace' } }
      }).success
    ).toBe(false)
    expect(
      rendererJobSchema.safeParse({
        op: 'extract_text',
        params: { source: { id: 'a', path: 'C:\\secret.pdf' }, pages: [0] }
      }).success
    ).toBe(false)
  })

  it('accepts opaque ids', () => {
    expect(rendererJobSchema.safeParse({ op: 'save_text', params: { text: 'x', output: { outputId: 'abc' } } }).success).toBe(true)
    expect(rendererJobSchema.safeParse({ op: 'probe', params: { source: { id: 'abc', password: 'p' } } }).success).toBe(true)
  })

  it('rejects unknown operations and extra fields', () => {
    expect(rendererJobSchema.safeParse({ op: 'shell', params: {} }).success).toBe(false)
    expect(rendererJobSchema.safeParse({ op: 'probe', params: { source: { id: 'a' }, extra: true } }).success).toBe(false)
  })

  it('validates colours', () => {
    const job = (color: string) => ({
      op: 'preview_apply',
      params: {
        source: { id: 'a' },
        pageNumbers: { position: 'top-left', start: 1, fontSize: 10, color, format: 'n' },
        previewIndex: 0,
        maxSize: 100
      }
    })
    expect(rendererJobSchema.safeParse(job('#aabbcc')).success).toBe(true)
    expect(rendererJobSchema.safeParse(job('red')).success).toBe(false)
  })
})

describe('worker events', () => {
  it('parses each event type', () => {
    for (const event of [
      { v: 1, type: 'ready', worker: '1', pymupdf: '2', mupdf: '3', pillow: '4' },
      { v: 1, type: 'progress', id: 'a', done: 1, total: 2 },
      { v: 1, type: 'result', id: 'a', data: {} },
      { v: 1, type: 'error', id: null, code: 'X', message: 'm' },
      { v: 1, type: 'cancelled', id: 'a' }
    ]) {
      expect(workerEventSchema.safeParse(event).success).toBe(true)
    }
  })

  it('rejects junk', () => {
    expect(workerEventSchema.safeParse({ v: 1, type: 'progress', id: 'a' }).success).toBe(false)
    expect(workerEventSchema.safeParse({ v: 2, type: 'cancelled', id: 'a' }).success).toBe(false)
    expect(workerEventSchema.safeParse('hello').success).toBe(false)
  })
})

describe('settings', () => {
  it('fills in defaults, with recent files off', () => {
    const settings = settingsSchema.parse({})
    expect(settings.theme).toBe('dark')
    expect(settings.recentFilesEnabled).toBe(false)
  })

  it('ignores unknown keys from an old settings file', () => {
    expect(settingsSchema.parse({ theme: 'light', old: 1 })).not.toHaveProperty('old')
  })
})
