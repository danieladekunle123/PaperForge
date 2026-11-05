import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'

// No trailing separator: on Windows a trailing backslash would escape the argument's closing quote.
export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const PYTHON = join(ROOT, 'worker', '.venv', 'Scripts', 'python.exe')

export interface PdfFacts {
  pageCount: number
  needsPassword: boolean
  metadata: Record<string, string | null>
  pages: { text: string; rotation: number; width: number; height: number; images: number; drawnImages: number }[]
}

export function makeFixtures(folder: string): void {
  execFileSync(PYTHON, [join(ROOT, 'scripts', 'make_test_fixtures.py'), folder], { stdio: 'inherit' })
}

export function inspectPdf(path: string, password?: string): PdfFacts {
  const args = [join(ROOT, 'scripts', 'inspect_pdf.py'), path, ...(password ? [password] : [])]
  return JSON.parse(execFileSync(PYTHON, args, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })) as PdfFacts
}

export function tempFolder(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `paperforge-${prefix}-`))
}

export interface Launched {
  app: ElectronApplication
  page: Page
  userData: string
  close: () => Promise<void>
}

/** Launches the built app with its own profile. `executablePath` tests a packaged build. */
export async function launchApp(executablePath?: string): Promise<Launched> {
  const userData = tempFolder('profile')
  const app = await electron.launch({
    ...(executablePath ? { executablePath, args: [] } : { args: [ROOT] }),
    env: { ...process.env, PAPERFORGE_USER_DATA: userData, NODE_ENV: 'production' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.setViewportSize({ width: 1366, height: 768 }).catch(() => undefined)
  return {
    app,
    page,
    userData,
    close: async () => {
      await app.close()
      if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    }
  }
}

/** Native dialogs cannot be driven by a test, so replace them with canned answers in the main process. */
export async function mockOpenDialog(app: ElectronApplication, paths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths })) as typeof dialog.showOpenDialog
  }, paths)
}

export async function mockSaveDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath })) as typeof dialog.showSaveDialog
  }, path)
}

export async function importFiles(launched: Launched, paths: string[]): Promise<void> {
  await mockOpenDialog(launched.app, paths)
  await launched.page.getByTestId('import-button').click()
}

export async function waitForJob(page: Page, status: 'done' | 'failed' | 'cancelled' = 'done', timeout = 60_000): Promise<void> {
  await expect(page.locator(`[data-testid="job-line"][data-status="${status}"]`).first()).toBeVisible({ timeout })
}

export async function dismissToasts(page: Page): Promise<void> {
  const buttons = page.locator('[data-testid^="toast-"] button')
  while ((await buttons.count()) > 0) await buttons.first().click()
}
