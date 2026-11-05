// Captures README screenshots from the real, running application using synthetic documents.
// Usage: npm run screenshots
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { _electron: electron } = require('@playwright/test')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = process.argv[2] ?? join(root, 'docs', 'screenshots')
const python = join(root, 'worker', '.venv', 'Scripts', 'python.exe')
const work = mkdtempSync(join(tmpdir(), 'paperforge-shots-'))
const fixtures = join(work, 'fixtures')
const scratch = join(work, 'out')
mkdirSync(fixtures)
mkdirSync(scratch)
mkdirSync(outDir, { recursive: true })
execFileSync(python, [join(root, 'scripts', 'make_test_fixtures.py'), fixtures], { stdio: 'inherit' })

const f = (name) => join(fixtures, name)
const app = await electron.launch({ args: [root], env: { ...process.env, PAPERFORGE_USER_DATA: join(work, 'profile') } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  win.setSize(1440, 900)
  win.center()
})
await page.waitForTimeout(400)

const mockOpen = (paths) =>
  app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
const mockSave = (path) =>
  app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, path)
const tool = (name) => page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name }).click()
const shot = async (name) => {
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(outDir, `${name}.png`) })
  console.log(`captured ${name}`)
}
const REPORT = 'Annual report 2025.pdf (12 pages)'

await shot('empty-state')

await mockOpen([f('Annual report 2025.pdf'), f('Études résumé 文档.pdf'), f('harbour photo.jpg'), f('ridge line.jpg')])
await page.getByTestId('import-button').click()
await page.getByTestId('source-row').nth(3).waitFor()
await page.locator('[data-testid="source-grid"] [data-page-index="0"] img').waitFor({ timeout: 30000 })
const rows = page.getByTestId('source-row')
await page.getByTestId('range-input').fill('1-3')
await page.getByTestId('range-add').click()
await rows.nth(2).locator('button').first().click()
await page.getByTestId('add-all').click()
await rows.nth(1).locator('button').first().click()
await page.getByTestId('range-input').fill('2, 7')
await page.getByTestId('range-add').click()
await rows.nth(3).locator('button').first().click()
await page.getByTestId('add-all').click()
await rows.nth(0).locator('button').first().click()
await page.getByTestId('range-input').fill('5-8')
await page.getByTestId('range-add').click()
const cell = (index) => page.locator(`[data-testid="output-grid"] [data-page-index="${index}"]`)
await cell(4).click()
await page.getByTestId('rotate-right').click()
await page.locator('[data-testid="output-grid"] [data-page-index="0"]').click()
await cell(1).click({ modifiers: ['Control'] })
await page.waitForFunction(() => document.querySelectorAll('[data-testid="output-grid"] img').length >= 8, null, { timeout: 30000 })
await shot('document-assembly')

await mockSave(join(scratch, 'export.pdf'))
await page.getByTestId('export-button').click()
const dialog = page.getByRole('dialog')
await dialog.getByLabel('Add page numbers').check()
await dialog.getByLabel('Format').selectOption('n_of_total')
await page.getByTestId('worker-preview').locator('img').waitFor({ timeout: 30000 })
await shot('export-dialog')
await page.keyboard.press('Escape')

await mockOpen([f('scanned contract.pdf')])
await page.getByTestId('import-button').click()
await page.getByTestId('source-row').nth(4).waitFor()

await tool('Split & extract')
await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: REPORT })
await page.getByTestId('split-ranges').fill('1-3, 4-8, 9-')
await shot('split')

await tool('Watermark')
await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: REPORT })
await page.getByTestId('worker-preview').locator('img').waitFor({ timeout: 30000 })
await shot('watermark')

await tool('Compress')
await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'scanned contract.pdf (1 page)' })
await mockSave(join(scratch, 'smaller.pdf'))
await page.getByTestId('compress-run').click()
await page.getByTestId('compress-result').waitFor({ timeout: 60000 })
await shot('compress')

await tool('Visual signature')
await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: REPORT })
await page.getByTestId('sign-draw').click()
const pad = page.getByTestId('signature-pad')
const box = await pad.boundingBox()
await page.mouse.move(box.x + 60, box.y + 150)
await page.mouse.down()
for (let i = 0; i <= 80; i++) {
  const t = i / 80
  await page.mouse.move(box.x + 60 + t * (box.width - 120), box.y + 130 + Math.sin(t * 14) * 60 * (1 - t * 0.6))
}
await page.mouse.up()
await page.getByTestId('signature-done').click()
await shot('visual-signature')

await tool('Page numbers')
await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: REPORT })
await page.getByTestId('worker-preview').locator('img').waitFor({ timeout: 30000 })
await shot('page-numbers')

await tool('Document info')
await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: REPORT })
await shot('document-info')

await tool('Settings')
await page.getByLabel('Theme').getByRole('radio', { name: 'Light' }).click()
await tool('Document Assembly')
await shot('document-assembly-light')

await app.close()
rmSync(work, { recursive: true, force: true })
