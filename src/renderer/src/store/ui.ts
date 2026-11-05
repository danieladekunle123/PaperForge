import { create } from 'zustand'

export type ToolId =
  | 'assembly'
  | 'merge'
  | 'split'
  | 'compress'
  | 'images'
  | 'numbers'
  | 'watermark'
  | 'sign'
  | 'security'
  | 'text'
  | 'info'
  | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error' | 'warn'
  message: string
}

export interface PrimaryAction {
  label: string
  run: () => void
  enabled: boolean
}

interface UiState {
  tool: ToolId
  toasts: Toast[]
  primary: PrimaryAction | null
  modalDepth: number
  setTool(tool: ToolId): void
  notify(kind: Toast['kind'], message: string): void
  dismissToast(id: number): void
  setPrimary(action: PrimaryAction | null): void
  pushModal(): void
  popModal(): void
}

let nextToast = 1

export const useUi = create<UiState>((set, get) => ({
  tool: 'assembly',
  toasts: [],
  primary: null,
  modalDepth: 0,
  setTool: (tool) => set({ tool }),
  notify: (kind, message) => {
    const id = nextToast++
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, message }] }))
    if (kind !== 'error') setTimeout(() => get().dismissToast(id), 6000)
  },
  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  setPrimary: (primary) => set({ primary }),
  pushModal: () => set((state) => ({ modalDepth: state.modalDepth + 1 })),
  popModal: () => set((state) => ({ modalDepth: Math.max(0, state.modalDepth - 1) }))
}))

export const notify = (kind: Toast['kind'], message: string): void => useUi.getState().notify(kind, message)
