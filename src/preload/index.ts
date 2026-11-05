/** The renderer's whole view of the system. Every method maps to one validated IPC handler. */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC, type JobUpdate, type PaperForgeApi } from '../shared/types'

const api: PaperForgeApi = {
  importWithDialog: (kind = 'any') => ipcRenderer.invoke(IPC.importDialog, kind),
  importDropped: async (files) => {
    // Real File objects from a drop are the only way a path reaches the main process.
    const paths = files.filter((file) => file instanceof File).map((file) => webUtils.getPathForFile(file))
    return ipcRenderer.invoke(IPC.importPaths, paths.filter(Boolean))
  },
  importRecent: (displayPath) => ipcRenderer.invoke(IPC.importRecent, displayPath),
  releaseSource: (id) => ipcRenderer.invoke(IPC.releaseSource, id),
  documentUrl: (id) => `pfdoc://source/${encodeURIComponent(id)}`,

  chooseSaveTarget: (defaultName, filter) => ipcRenderer.invoke(IPC.chooseSave, defaultName, filter),
  chooseFolder: () => ipcRenderer.invoke(IPC.chooseFolder),
  findCollisions: (folderId, names) => ipcRenderer.invoke(IPC.findCollisions, folderId, names),
  revealOutput: (path) => ipcRenderer.invoke(IPC.reveal, path),

  submitJob: (job) => ipcRenderer.invoke(IPC.submitJob, job),
  cancelJob: (jobId) => ipcRenderer.invoke(IPC.cancelJob, jobId),
  interactive: (job, coalesceKey) => ipcRenderer.invoke(IPC.interactive, job, coalesceKey),
  onJobUpdate: (listener) => {
    const wrapped = (_event: unknown, update: JobUpdate): void => listener(update)
    ipcRenderer.on(IPC.jobUpdate, wrapped)
    return () => ipcRenderer.removeListener(IPC.jobUpdate, wrapped)
  },

  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  chooseDefaultExportDir: () => ipcRenderer.invoke(IPC.chooseExportDir),
  clearDefaultExportDir: () => ipcRenderer.invoke(IPC.clearExportDir),
  getRecentFiles: () => ipcRenderer.invoke(IPC.recentFiles),
  clearHistoryAndCache: () => ipcRenderer.invoke(IPC.clearHistory),

  writeClipboard: (text) => ipcRenderer.invoke(IPC.clipboard, text),
  openExternal: (link) => ipcRenderer.invoke(IPC.openExternal, link),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  getNotices: () => ipcRenderer.invoke(IPC.notices),
  setTitleBarTheme: (theme) => ipcRenderer.send(IPC.titleBar, theme)
}

contextBridge.exposeInMainWorld('paperforge', api)
