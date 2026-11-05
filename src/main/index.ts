/** Electron main process: window, dialogs, file allow-list, worker lifecycle and scoped IPC. */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { z } from 'zod'
import { rendererJobSchema, settingsPatchSchema, type RendererJob } from '../shared/schemas'
import {
  IPC,
  type AppInfo,
  type ExternalLink,
  type ImportResult,
  type InteractiveResponse,
  type JobUpdate,
  type SaveDialogResponse,
  type SubmitResponse
} from '../shared/types'
import { resolveJob } from './resolveJob'
import { FileRegistry } from './registry'
import { installProtocols, registerSchemes } from './protocols'
import {
  APP_ORIGIN,
  applySessionPolicy,
  EXTERNAL_LINK_KEYS,
  hardenContents,
  isTrustedSender,
  openApprovedLink
} from './security'
import { SettingsStore } from './settings'
import { JobFailure, WorkerHost, type WorkerCommand } from './workerHost'

const here = dirname(fileURLToPath(import.meta.url))
const rendererUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined
const MAX_TRACKED_JOBS = 200
const OVERLAY_COLORS = {
  dark: { color: '#0f1114', symbolColor: '#b6bcc5' },
  light: { color: '#ebeae6', symbolColor: '#3b3f45' }
}

registerSchemes()
app.enableSandbox()

// Allow tests to isolate app data, so runs never touch a real profile.
if (process.env['PAPERFORGE_USER_DATA']) app.setPath('userData', process.env['PAPERFORGE_USER_DATA'])

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

const registry = new FileRegistry()
let settings: SettingsStore
let mainWindow: BrowserWindow | null = null
let jobsLane: WorkerHost
let interactiveLane: WorkerHost
const activeJobs = new Set<string>()

function log(message: string): void {
  if (!app.isPackaged || process.env['PAPERFORGE_DEBUG']) console.error(`[paperforge] ${message}`)
}

function workerCommand(): WorkerCommand {
  if (app.isPackaged) {
    const exe = join(process.resourcesPath, 'worker', 'paperforge-worker.exe')
    if (!existsSync(exe)) throw new Error('The processing worker is missing from this installation. Reinstall PaperForge.')
    return { command: exe, args: [] }
  }
  const root = app.getAppPath()
  const python = process.platform === 'win32' ? join(root, 'worker', '.venv', 'Scripts', 'python.exe') : join(root, 'worker', '.venv', 'bin', 'python')
  if (!existsSync(python)) throw new Error('The worker environment is missing. Run "npm run setup".')
  return {
    command: python,
    args: ['-m', 'paperforge_worker'],
    cwd: join(root, 'worker'),
    env: { PYTHONPATH: join(root, 'worker'), PYTHONDONTWRITEBYTECODE: '1' }
  }
}

/** Removes temp files left by a job whose worker was killed. Only names with our job prefix match. */
function sweepTemp(jobId: string, directories: string[]): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) return
  const prefix = `.paperforge-${jobId}-`
  for (const directory of directories) {
    try {
      for (const name of readdirSync(directory)) {
        if (name.startsWith(prefix) && name.endsWith('.tmp')) unlinkSync(join(directory, name))
      }
    } catch {
      /* The folder may be gone. */
    }
  }
}

function send(update: JobUpdate): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.jobUpdate, update)
}

function submitJob(job: RendererJob): SubmitResponse {
  if (activeJobs.size >= MAX_TRACKED_JOBS) {
    return { ok: false, error: { code: 'QUEUE_FULL', message: 'Too many jobs are waiting. Let some finish, then try again.' } }
  }
  let resolved
  try {
    resolved = resolveJob(job, registry)
  } catch (error) {
    if (error instanceof JobFailure) return { ok: false, error: error.toJobError() }
    throw error
  }
  const jobId = randomUUID().replaceAll('-', '')
  activeJobs.add(jobId)
  const { promise } = jobsLane.submit(resolved.op, resolved.params, {
    jobId,
    sweepDirectories: resolved.sweepDirectories,
    onStart: () => send({ jobId, status: 'running' }),
    onProgress: (done, total, stage) => send({ jobId, status: 'running', done, total, stage })
  })
  promise
    .then((result) => {
      for (const output of result.outputs ?? []) registry.rememberResult(output.path)
      send({ jobId, status: 'done', result })
    })
    .catch((failure: JobFailure) => {
      if (failure.code === 'CANCELLED') send({ jobId, status: 'cancelled' })
      else send({ jobId, status: 'failed', error: failure.toJobError() })
    })
    .finally(() => activeJobs.delete(jobId))
  send({ jobId, status: 'queued' })
  return { ok: true, jobId }
}

async function interactive(job: RendererJob, coalesceKey?: string): Promise<InteractiveResponse> {
  try {
    const resolved = resolveJob(job, registry)
    const { promise } = interactiveLane.submit(resolved.op, resolved.params, { coalesceKey })
    return { ok: true, data: await promise }
  } catch (error) {
    if (error instanceof JobFailure) {
      return { ok: false, error: error.toJobError(), superseded: error.code === 'SUPERSEDED' }
    }
    throw error
  }
}

function saveFilters(filter: 'pdf' | 'txt'): Electron.FileFilter[] {
  return filter === 'pdf' ? [{ name: 'PDF document', extensions: ['pdf'] }] : [{ name: 'Text file', extensions: ['txt'] }]
}

async function chooseSaveTarget(defaultName: string, filter: 'pdf' | 'txt'): Promise<SaveDialogResponse> {
  const directory = settings.get().defaultExportDir
  const name = basename(defaultName) || `output.${filter}`
  const options = {
    title: 'Save As',
    defaultPath: directory && existsSync(directory) ? join(directory, name) : name,
    filters: saveFilters(filter),
    properties: ['showOverwriteConfirmation' as const]
  }
  const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return { status: 'cancelled' }
  let path = result.filePath
  if (!path.toLowerCase().endsWith(`.${filter}`)) path += `.${filter}`
  if (registry.isSourcePath(path)) {
    return {
      status: 'rejected',
      message: `“${basename(path)}” is one of your source files. PaperForge never overwrites a source, so choose a different name.`
    }
  }
  return { status: 'selected', target: { outputId: registry.addOutput(path), displayPath: path, name: basename(path) } }
}

async function importWithDialog(kind: 'any' | 'pdf' | 'image'): Promise<ImportResult> {
  const filters: Record<typeof kind, Electron.FileFilter[]> = {
    any: [{ name: 'PDFs and images', extensions: ['pdf', 'jpg', 'jpeg', 'png'] }],
    pdf: [{ name: 'PDF documents', extensions: ['pdf'] }],
    image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }]
  }
  const options: OpenDialogOptions = {
    title: 'Import files',
    properties: ['openFile', 'multiSelections'],
    filters: filters[kind]
  }
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return { files: [], rejected: [] }
  return registerImports(result.filePaths)
}

async function registerImports(paths: string[]): Promise<ImportResult> {
  const result = await registry.register(paths)
  settings.addRecent(result.files.map((file) => file.displayPath))
  return result
}

function loadNotices(): string {
  const candidates = [join(process.resourcesPath ?? '', 'THIRD_PARTY_NOTICES.md'), join(app.getAppPath(), 'THIRD_PARTY_NOTICES.md')]
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  return 'Dependency notices are not available in this build.'
}

function installIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, listener: (...args: A) => R | Promise<R>): void => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event.senderFrame?.url, mainWindow, rendererUrl)) {
        throw new Error('Rejected a request from an untrusted frame.')
      }
      return listener(...(args as A))
    })
  }
  const sourceId = z.string().min(1).max(128)

  handle(IPC.importDialog, (kind: unknown) => importWithDialog(z.enum(['any', 'pdf', 'image']).parse(kind ?? 'any')))
  // Dropped paths come only from preload, which reads them from real File objects.
  handle(IPC.importPaths, (paths: unknown) => registerImports(z.array(z.string().min(1).max(32_767)).max(2000).parse(paths)))
  handle(IPC.importRecent, (path: unknown) => {
    const value = z.string().parse(path)
    if (!settings.isRecent(value)) return { files: [], rejected: [{ name: basename(value), reason: 'This file is not in your recent list.' }] }
    return registerImports([value])
  })
  handle(IPC.releaseSource, (id: unknown) => registry.release(sourceId.parse(id)))
  handle(IPC.chooseSave, (name: unknown, filter: unknown) =>
    chooseSaveTarget(z.string().max(1024).parse(name), z.enum(['pdf', 'txt']).parse(filter))
  )
  handle(IPC.chooseFolder, async () => {
    const options: OpenDialogOptions = {
      title: 'Choose output folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get().defaultExportDir ?? undefined
    }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    return { folderId: registry.addFolder(result.filePaths[0]), displayPath: result.filePaths[0] }
  })
  handle(IPC.findCollisions, (folderId: unknown, names: unknown) =>
    registry.findCollisions(sourceId.parse(folderId), z.array(z.string().max(1024)).max(100_000).parse(names))
  )
  handle(IPC.reveal, async (path: unknown) => {
    const value = z.string().parse(path)
    if (!registry.isKnownResult(value)) return false
    shell.showItemInFolder(value)
    return true
  })
  handle(IPC.submitJob, (job: unknown) => {
    const parsed = rendererJobSchema.safeParse(job)
    if (!parsed.success) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'That request was not valid.' } } satisfies SubmitResponse
    }
    return submitJob(parsed.data)
  })
  handle(IPC.cancelJob, (jobId: unknown) => {
    const id = z.string().parse(jobId)
    if (jobsLane.cancel(id) === 'requested') send({ jobId: id, status: 'cancelling' })
  })
  handle(IPC.interactive, (job: unknown, key: unknown) => {
    const parsed = rendererJobSchema.safeParse(job)
    if (!parsed.success) {
      return { ok: false, error: { code: 'INVALID_REQUEST', message: 'That request was not valid.' } } satisfies InteractiveResponse
    }
    return interactive(parsed.data, key === undefined ? undefined : z.string().max(128).parse(key))
  })
  handle(IPC.getSettings, () => settings.get())
  handle(IPC.updateSettings, (patch: unknown) => settings.update(settingsPatchSchema.parse(patch)))
  handle(IPC.chooseExportDir, async () => {
    const options: OpenDialogOptions = { title: 'Default export folder', properties: ['openDirectory', 'createDirectory'] }
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options)
    if (!result.canceled && result.filePaths[0]) settings.setDefaultExportDir(result.filePaths[0])
    return settings.get()
  })
  handle(IPC.clearExportDir, () => settings.setDefaultExportDir(null))
  handle(IPC.recentFiles, () => settings.recentFiles())
  handle(IPC.clearHistory, async () => {
    settings.clearRecent()
    await session.defaultSession.clearCache()
  })
  handle(IPC.clipboard, (text: unknown) => clipboard.writeText(z.string().parse(text)))
  handle(IPC.openExternal, (link: unknown) =>
    openApprovedLink(z.enum(EXTERNAL_LINK_KEYS as [ExternalLink, ...ExternalLink[]]).parse(link))
  )
  handle(IPC.appInfo, async (): Promise<AppInfo> => {
    let available = true
    try {
      workerCommand()
    } catch {
      available = false
    }
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      workerAvailable: available,
      worker: interactiveLane.versions ?? jobsLane.versions ?? undefined,
      packaged: app.isPackaged
    }
  })
  handle(IPC.notices, () => loadNotices())
  ipcMain.on(IPC.titleBar, (event, theme: unknown) => {
    if (!isTrustedSender(event.senderFrame?.url, mainWindow, rendererUrl)) return
    const parsed = z.enum(['dark', 'light']).safeParse(theme)
    if (parsed.success && mainWindow && process.platform === 'win32') {
      mainWindow.setTitleBarOverlay({ ...OVERLAY_COLORS[parsed.data], height: 36 })
      mainWindow.setBackgroundColor(OVERLAY_COLORS[parsed.data].color)
    }
  })
}

function createWindow(): void {
  const theme = settings.get().theme
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    show: false,
    title: 'PaperForge',
    // A packaged app takes its window icon from the executable, so only development needs this.
    ...(app.isPackaged ? {} : { icon: join(here, '../../build/icon.ico') }),
    backgroundColor: OVERLAY_COLORS[theme].color,
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...OVERLAY_COLORS[theme], height: 36 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false
    }
  })
  hardenContents(mainWindow.webContents, rendererUrl)
  mainWindow.once('ready-to-show', () => {
    if (!process.env['PAPERFORGE_HIDE_WINDOW']) mainWindow?.show()
  })
  mainWindow.on('close', (event) => {
    if (!activeJobs.size || !mainWindow) return
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Keep working', 'Cancel jobs and quit'],
      defaultId: 0,
      cancelId: 0,
      title: 'Jobs are still running',
      message: 'PaperForge is still processing. Quitting stops those jobs, and unfinished outputs are discarded.'
    })
    if (choice === 0) event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadURL(rendererUrl ?? `${APP_ORIGIN}/index.html`)
}

void app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  settings = new SettingsStore(app.getPath('userData'))
  const lane = (name: string): WorkerHost =>
    new WorkerHost({ name, resolveCommand: workerCommand, log, sweep: sweepTemp })
  jobsLane = lane('jobs')
  interactiveLane = lane('interactive')
  applySessionPolicy(rendererUrl)
  installProtocols(resolve(here, '../renderer'), registry, rendererUrl)
  installIpc()
  createWindow()
  interactiveLane.warmUp()
})

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

app.on('web-contents-created', (_event, contents) => hardenContents(contents, rendererUrl))

app.on('window-all-closed', () => {
  jobsLane?.dispose()
  interactiveLane?.dispose()
  app.quit()
})
