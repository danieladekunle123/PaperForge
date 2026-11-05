// Regenerates the shared request fixtures that both Zod and the Python validator must agree on.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'protocol-fixtures')
const source = { id: 's1', path: 'C:\\docs\\input file.pdf' }
const output = { path: 'C:\\docs\\out.pdf', overwrite: 'error' }
const options = { pageSizing: 'preserve', fitSize: 'A4', blankSize: 'Letter', imageFit: 'contain' }
const numbers = { position: 'bottom-center', start: 1, fontSize: 11, color: '#112233', format: 'n_of_total' }
const pdfPage = { kind: 'pdf', sourceId: 's1', pageIndex: 0, rotation: 90 }

const valid = {
  probe: { op: 'probe', params: { source: { ...source, kind: 'pdf', password: 'x' } } },
  assemble_all_kinds: {
    op: 'assemble',
    params: {
      sources: [source],
      pages: [pdfPage, { kind: 'image', sourceId: 's1', rotation: 0 }, { kind: 'blank', rotation: 270 }],
      options: { ...options, pageNumbers: numbers, metadata: { mode: 'edit', title: 'T' }, keepAttachments: false },
      output
    }
  },
  split: {
    op: 'split',
    params: { source, groups: [{ name: 'a.pdf', pages: [0, 1] }], folder: { path: 'C:\\out', overwrite: 'rename' } }
  },
  compress: { op: 'compress', params: { source, mode: 'rasterize', output } },
  pdf_to_images: {
    op: 'pdf_to_images',
    params: { source, pages: [0], format: 'jpg', dpi: 150, jpegQuality: 80, baseName: 'x', folder: output }
  },
  images_to_pdf: {
    op: 'images_to_pdf',
    params: {
      sources: [source],
      images: ['s1'],
      layout: { pageSize: 'image', orientation: 'auto', marginPt: 0, fit: 'cover' },
      output
    }
  },
  apply_everything: {
    op: 'apply',
    params: {
      source,
      imageSources: [{ id: 'sig', path: 'C:\\sig.png' }],
      pageNumbers: { ...numbers, pages: [0, 2], marginPt: 30 },
      watermark: {
        text: 'DRAFT',
        fontSize: 48,
        color: '#ff0000',
        opacity: 0.3,
        rotation: 45,
        position: 'center',
        layer: 'background',
        pages: [1]
      },
      overlays: [
        { kind: 'image', pageIndex: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1, imageSourceId: 'sig', knockoutWhite: true },
        { kind: 'image', pageIndex: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.1, pngBase64: 'iVBORw0KGgo=' },
        { kind: 'text', pageIndex: 1, x: 0.5, y: 0.5, text: 'Hello', fontSize: 12, color: '#000000' }
      ],
      metadata: { mode: 'strip' },
      output
    }
  },
  preview_apply: {
    op: 'preview_apply',
    params: { source, watermark: undefined, pageNumbers: numbers, previewIndex: 0, maxSize: 600 }
  },
  protect: {
    op: 'protect',
    params: {
      source,
      userPassword: 'a',
      ownerPassword: 'b',
      permissions: {
        print: true,
        printHighQuality: false,
        modify: false,
        copy: false,
        annotate: false,
        fillForms: true,
        assemble: false
      },
      output
    }
  },
  unprotect: { op: 'unprotect', params: { source: { ...source, password: 'p' }, output } },
  extract_text: { op: 'extract_text', params: { source, pages: [0, 1] } },
  save_text: { op: 'save_text', params: { text: 'héllo', output } }
}

const invalid = {
  probe_missing_kind: { op: 'probe', params: { source } },
  assemble_no_pages: { op: 'assemble', params: { sources: [source], pages: [], options, output } },
  assemble_bad_rotation: {
    op: 'assemble',
    params: { sources: [source], pages: [{ ...pdfPage, rotation: 45 }], options, output }
  },
  assemble_negative_page: {
    op: 'assemble',
    params: { sources: [source], pages: [{ ...pdfPage, pageIndex: -1 }], options, output }
  },
  assemble_extra_field: {
    op: 'assemble',
    params: { sources: [source], pages: [pdfPage], options, output, shell: 'rm -rf /' }
  },
  compress_bad_mode: { op: 'compress', params: { source, mode: 'magic', output } },
  split_empty_group: {
    op: 'split',
    params: { source, groups: [{ name: 'a.pdf', pages: [] }], folder: output }
  },
  images_negative_margin: {
    op: 'images_to_pdf',
    params: {
      sources: [source],
      images: ['s1'],
      layout: { pageSize: 'A4', orientation: 'auto', marginPt: -3, fit: 'contain' },
      output
    }
  },
  output_bad_policy: { op: 'save_text', params: { text: 'x', output: { path: 'a', overwrite: 'maybe' } } },
  watermark_zero_opacity: {
    op: 'apply',
    params: {
      source,
      watermark: {
        text: 'x',
        fontSize: 10,
        color: '#000000',
        opacity: 0,
        rotation: 0,
        position: 'center',
        layer: 'foreground'
      },
      output
    }
  }
}

for (const [kind, set] of Object.entries({ valid, invalid })) {
  mkdirSync(join(root, kind), { recursive: true })
  for (const [name, value] of Object.entries(set)) {
    writeFileSync(join(root, kind, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
  }
}
