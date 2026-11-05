// Smoke-tests the packaged application: launches the real .exe and runs a job through the frozen worker.
// Usage: npm run test:packaged [path to PaperForge.exe]
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('@playwright/test')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const exe = process.argv[2] ?? join(root, 'release', 'win-unpacked', 'PaperForge.exe')
if (!existsSync(exe)) {
  console.error(`Not found: ${exe}. Run "npm run build" first.`)
  process.exit(1)
}

const python = join(root, 'worker', '.venv', 'Scripts', 'python.exe')
const work = mkdtempSync(join(tmpdir(), 'paperforge-packaged-'))
const fixtures = join(work, 'fixtures')
mkdirSync(fixtures)
execFileSync(python, [join(root, 'scripts', 'make_test_fixtures.py'), fixtures], { stdio: 'inherit' })

function check(condition, message) {
  if (!condition) throw new Error(`Failed: ${message}`)
  console.log(`ok: ${message}`)
}

const app = await electron.launch({ executablePath: exe, args: [], env: { ...process.env, PAPERFORGE_USER_DATA: join(work, 'profile') } })
try {
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  check((await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)) === true, 'running as a packaged app')
  check(page.url().startsWith('paperforge://app/'), 'renderer served from the private scheme')

  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, [join(fixtures, 'Annual report 2025.pdf'), join(fixtures, 'Études résumé 文档.pdf'), join(fixtures, 'harbour photo.jpg')])
  await page.getByTestId('import-button').click()
  const rows = page.getByTestId('source-row')
  await rows.nth(2).waitFor({ timeout: 60000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="source-row"]').length === 3 && ![...document.querySelectorAll('[data-testid="source-row"]')].some((el) => el.textContent.includes('Reading')), null, { timeout: 90000 })
  check((await rows.nth(0).textContent()).includes('12 pages'), 'frozen worker probed a PDF')
  check((await rows.nth(1).textContent()).includes('8 pages'), 'Unicode filename handled')
  check((await rows.nth(2).textContent()).includes('1600'), 'frozen worker read an image with Pillow')

  await page.locator('[data-testid="source-grid"] [data-page-index="0"] img').waitFor({ timeout: 30000 })
  check(true, 'pdf.js thumbnails render from packaged assets')

  await page.getByTestId('range-input').fill('1-3')
  await page.getByTestId('range-add').click()
  await rows.nth(2).locator('button').first().click()
  await page.getByTestId('add-all').click()
  const target = join(work, 'packaged output.pdf')
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, target)
  await page.getByTestId('export-button').click()
  await page.getByRole('dialog').getByLabel('Add page numbers').check()
  await page.getByTestId('worker-preview').locator('img').waitFor({ timeout: 30000 })
  await page.getByTestId('export-confirm').click()
  await page.locator('[data-testid="job-line"][data-status="done"]').waitFor({ timeout: 60000 })
  check(existsSync(target) && statSync(target).size > 1000, 'exported a PDF through the frozen worker')

  const facts = JSON.parse(execFileSync(python, [join(root, 'scripts', 'inspect_pdf.py'), target], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }))
  check(facts.pageCount === 4, 'output has 4 pages')
  check(facts.pages[2].text.includes('REPORT-P3') && facts.pages[3].images === 1, 'output pages are in the right order')
  check(facts.pages[0].text.includes('1'), 'page numbers were written')

  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Settings' }).click()
  const about = await page.getByTestId('about').textContent()
  check(about.includes('2.1'), 'About reports the bundled PyMuPDF version')
  await page.getByTestId('show-notices').click()
  check((await page.getByRole('dialog', { name: 'Dependency notices' }).textContent()).includes('PyMuPDF'), 'dependency notices are bundled')
  console.log('\nPackaged application passed.')
} finally {
  await app.close()
  rmSync(work, { recursive: true, force: true })
}
