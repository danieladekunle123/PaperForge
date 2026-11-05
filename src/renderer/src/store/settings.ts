import { create } from 'zustand'
import { settingsSchema, type Settings, type SettingsPatch } from '../../../shared/schemas'

interface SettingsState {
  settings: Settings
  load(): Promise<void>
  update(patch: SettingsPatch): Promise<void>
  replace(settings: Settings): void
}

function applyTheme(theme: Settings['theme']): void {
  document.documentElement.dataset.theme = theme
  window.paperforge.setTitleBarTheme(theme)
}

export const useSettings = create<SettingsState>((set) => ({
  settings: settingsSchema.parse({}),
  load: async () => {
    const settings = await window.paperforge.getSettings()
    applyTheme(settings.theme)
    set({ settings })
  },
  update: async (patch) => {
    const settings = await window.paperforge.updateSettings(patch)
    applyTheme(settings.theme)
    set({ settings })
  },
  replace: (settings) => set({ settings })
}))
