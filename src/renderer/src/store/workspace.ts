/** Imported files. Passwords live here in memory for the session and are never written anywhere. */
import { create } from 'zustand'
import type { ImportResult, ImportedFile, ProbeResult } from '../../../shared/types'
import { closeDocument, setAccessResolver } from '../lib/pdfEngine'
import { plural } from '../lib/format'
import { notify } from './ui'

export type SourceStatus = 'probing' | 'ready' | 'locked' | 'error'

export interface SourceEntry extends ImportedFile {
  status: SourceStatus
  info?: ProbeResult
  password?: string
  error?: string
}

interface WorkspaceState {
  sources: Record<string, SourceEntry>
  order: string[]
  passwordRequest: string | null
  acceptImport(result: ImportResult): Promise<string[]>
  importWithDialog(kind?: 'any' | 'pdf' | 'image'): Promise<string[]>
  importDropped(files: File[]): Promise<string[]>
  remove(id: string): void
  requestPassword(id: string | null): void
  submitPassword(id: string, password: string): Promise<string | null>
}

export const useWorkspace = create<WorkspaceState>((set, get) => {
  async function probe(id: string, password?: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    const response = await window.paperforge.interactive({
      op: 'probe',
      params: { source: { id, ...(password ? { password } : {}) } }
    })
    if (!response.ok) return { ok: false, code: response.error.code, message: response.error.message }
    const info = response.data as unknown as ProbeResult
    set((state) => {
      const entry = state.sources[id]
      if (!entry) return state
      return {
        sources: {
          ...state.sources,
          [id]: { ...entry, status: 'ready', info, password: password ?? entry.password, error: undefined }
        }
      }
    })
    return { ok: true }
  }

  function setFailed(id: string, status: SourceStatus, error: string | undefined): void {
    set((state) => {
      const entry = state.sources[id]
      if (!entry) return state
      return { sources: { ...state.sources, [id]: { ...entry, status, error } } }
    })
  }

  return {
    sources: {},
    order: [],
    passwordRequest: null,

    acceptImport: async (result) => {
      for (const rejected of result.rejected) notify('error', `${rejected.name}: ${rejected.reason}`)
      const fresh = result.files.filter((file) => !get().sources[file.id])
      if (result.files.length > fresh.length) {
        notify('info', `${plural(result.files.length - fresh.length, 'file was', 'files were')} already imported.`)
      }
      if (fresh.length) {
        set((state) => ({
          sources: {
            ...state.sources,
            ...Object.fromEntries(fresh.map((file) => [file.id, { ...file, status: 'probing' as const }]))
          },
          order: [...state.order, ...fresh.map((file) => file.id)]
        }))
      }
      await Promise.all(
        fresh.map(async (file) => {
          const outcome = await probe(file.id)
          if (outcome.ok) return
          if (outcome.code === 'PASSWORD_REQUIRED') {
            setFailed(file.id, 'locked', outcome.message)
            if (!get().passwordRequest) set({ passwordRequest: file.id })
          } else {
            setFailed(file.id, 'error', outcome.message)
            notify('error', outcome.message)
          }
        })
      )
      return result.files.map((file) => file.id)
    },

    importWithDialog: async (kind) => get().acceptImport(await window.paperforge.importWithDialog(kind)),
    importDropped: async (files) => get().acceptImport(await window.paperforge.importDropped(files)),

    remove: (id) => {
      closeDocument(id)
      void window.paperforge.releaseSource(id)
      set((state) => {
        const sources = { ...state.sources }
        delete sources[id]
        return { sources, order: state.order.filter((item) => item !== id) }
      })
    },

    requestPassword: (id) => set({ passwordRequest: id }),

    submitPassword: async (id, password) => {
      const outcome = await probe(id, password)
      if (outcome.ok) {
        // Reopen in pdf.js with the new credentials.
        closeDocument(id)
        const next = get().order.find((item) => item !== id && get().sources[item]?.status === 'locked')
        set({ passwordRequest: next ?? null })
        return null
      }
      return outcome.message
    }
  }
})

setAccessResolver((id) => {
  const entry = useWorkspace.getState().sources[id]
  if (!entry) return undefined
  return { url: window.paperforge.documentUrl(id), sizeBytes: entry.sizeBytes, password: entry.password }
})

/** A job reference for a source, including its password if it has one. */
export function sourceRef(id: string): { id: string; password?: string } {
  const entry = useWorkspace.getState().sources[id]
  return { id, ...(entry?.password ? { password: entry.password } : {}) }
}

export function readySources(sources: Record<string, SourceEntry>, order: string[], kind?: 'pdf' | 'image'): SourceEntry[] {
  return order.map((id) => sources[id]).filter((entry) => entry && entry.status === 'ready' && (!kind || entry.kind === kind))
}
