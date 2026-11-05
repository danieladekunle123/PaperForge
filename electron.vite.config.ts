import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/** pdf.js loads fonts, character maps and decoders at runtime, so they ship as plain files. */
function copyPdfjsAssets(): Plugin {
  return {
    name: 'paperforge-copy-pdfjs-assets',
    buildStart() {
      const from = resolve('node_modules/pdfjs-dist')
      const to = resolve('src/renderer/public/pdfjs')
      mkdirSync(to, { recursive: true })
      for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
        if (existsSync(resolve(from, dir))) cpSync(resolve(from, dir), resolve(to, dir), { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    build: {
      // Sandboxed preload scripts must be CommonJS.
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    build: {
      target: 'chrome130',
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [copyPdfjsAssets(), tailwindcss(), react()]
  }
})
