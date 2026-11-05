/** Types shared by the main process, preload and renderer. */
import type { JobOp, RendererJob, Settings, SettingsPatch } from './schemas'

export type { JobOp, RendererJob, Settings, SettingsPatch }

export type SourceKind = 'pdf' | 'image'

export interface ImportedFile {
  id: string
  name: string
  displayPath: string
  kind: SourceKind
  sizeBytes: number
  /** True when this file was already imported and the existing entry was reused. */
  reused: boolean
}

export interface RejectedFile {
  name: string
  reason: string
}

export interface ImportResult {
  files: ImportedFile[]
  rejected: RejectedFile[]
}

export interface RecentFile {
  displayPath: string
  name: string
}

export interface PageInfo {
  width: number
  height: number
  rotation: number
}

export interface PdfFeatures {
  tocEntries: number
  annotationPages: number
  formPages: number
  isForm: boolean
  xfa: boolean
  signed: boolean
  attachments: number
  layers: number
  javascript: boolean
}

export interface PdfSecurity {
  encrypted: boolean
  encryption: string
  needsPassword: boolean
  fullAccess: boolean
  permissions: {
    print: boolean
    printHighQuality: boolean
    modify: boolean
    copy: boolean
    annotate: boolean
    fillForms: boolean
    assemble: boolean
  }
}

export interface PdfMetadata {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
  creationDate: string
  modDate: string
  format: string
}

export interface ProbeResult {
  kind: SourceKind
  name: string
  sizeBytes: number
  pageCount: number
  pages: PageInfo[]
  metadata?: PdfMetadata
  security?: PdfSecurity
  features?: PdfFeatures
  image?: { width: number; height: number; hasAlpha: boolean }
}

export interface OutputFile {
  path: string
  pages: number
  sizeBytes: number
}

export interface JobResult {
  outputs?: OutputFile[]
  verified?: boolean
  warnings?: string[]
  [key: string]: unknown
}

export interface CompressResult extends JobResult {
  originalSize: number
  outputSize: number
  percentChange: number
  imagesRecompressed: number
  qualityReduced: boolean
  rasterized: boolean
  wroteOutput: boolean
  noImprovement?: boolean
}

export interface TextPageResult {
  index: number
  text: string
  hasText: boolean
  hasImages: boolean
}

export interface ExtractTextResult extends JobResult {
  pages: TextPageResult[]
}

export interface PreviewResult extends JobResult {
  pngBase64: string
  width: number
  height: number
  pageWidth: number
  pageHeight: number
}

export interface JobError {
  code: string
  message: string
}

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'failed' | 'cancelled'

export interface JobUpdate {
  jobId: string
  status: JobStatus
  done?: number
  total?: number
  stage?: string
  result?: JobResult
  error?: JobError
}

/** `{ ok: false }` is a normal result for interactive calls, so errors keep their code over IPC. */
export type InteractiveResponse =
  | { ok: true; data: JobResult }
  | { ok: false; error: JobError; superseded?: boolean }

export type SubmitResponse = { ok: true; jobId: string } | { ok: false; error: JobError }

export interface SaveTarget {
  outputId: string
  displayPath: string
  name: string
}

export type SaveFilter = 'pdf' | 'txt'

export type SaveDialogResponse =
  | { status: 'selected'; target: SaveTarget }
  | { status: 'cancelled' }
  | { status: 'rejected'; message: string }

export interface FolderTarget {
  folderId: string
  displayPath: string
}

export interface AppInfo {
  version: string
  electron: string
  chromium: string
  node: string
  workerAvailable: boolean
  worker?: { worker: string; pymupdf: string; mupdf: string; pillow: string }
  packaged: boolean
}

export type ExternalLink = 'repository' | 'agpl' | 'pymupdf-licensing' | 'pymupdf' | 'pillow' | 'pdfjs' | 'electron'

export interface PaperForgeApi {
  importWithDialog(kind?: 'any' | 'pdf' | 'image'): Promise<ImportResult>
  importDropped(files: File[]): Promise<ImportResult>
  importRecent(displayPath: string): Promise<ImportResult>
  releaseSource(id: string): Promise<void>
  documentUrl(id: string): string

  chooseSaveTarget(defaultName: string, filter: SaveFilter): Promise<SaveDialogResponse>
  chooseFolder(): Promise<FolderTarget | null>
  findCollisions(folderId: string, names: string[]): Promise<string[]>
  revealOutput(path: string): Promise<boolean>

  submitJob(job: RendererJob): Promise<SubmitResponse>
  cancelJob(jobId: string): Promise<void>
  interactive(job: RendererJob, coalesceKey?: string): Promise<InteractiveResponse>
  onJobUpdate(listener: (update: JobUpdate) => void): () => void

  getSettings(): Promise<Settings>
  updateSettings(patch: SettingsPatch): Promise<Settings>
  chooseDefaultExportDir(): Promise<Settings>
  clearDefaultExportDir(): Promise<Settings>
  getRecentFiles(): Promise<RecentFile[]>
  clearHistoryAndCache(): Promise<void>

  writeClipboard(text: string): Promise<void>
  openExternal(link: ExternalLink): Promise<void>
  getAppInfo(): Promise<AppInfo>
  getNotices(): Promise<string>
  setTitleBarTheme(theme: 'dark' | 'light'): void
}

declare global {
  interface Window {
    paperforge: PaperForgeApi
  }
}

export const IPC = {
  importDialog: 'files:import-dialog',
  importPaths: 'files:import-dropped',
  importRecent: 'files:import-recent',
  releaseSource: 'files:release',
  chooseSave: 'dialog:save',
  chooseFolder: 'dialog:folder',
  findCollisions: 'files:find-collisions',
  reveal: 'files:reveal',
  submitJob: 'job:submit',
  cancelJob: 'job:cancel',
  interactive: 'job:interactive',
  jobUpdate: 'job:update',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  chooseExportDir: 'settings:choose-export-dir',
  clearExportDir: 'settings:clear-export-dir',
  recentFiles: 'settings:recent',
  clearHistory: 'settings:clear-history',
  clipboard: 'app:clipboard',
  openExternal: 'app:open-external',
  appInfo: 'app:info',
  notices: 'app:notices',
  titleBar: 'app:title-bar'
} as const
