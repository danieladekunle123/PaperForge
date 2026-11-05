import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { dismissToasts, importFiles, inspectPdf, launchApp, makeFixtures, mockOpenDialog, mockSaveDialog, tempFolder, waitForJob, type Launched } from './helpers'

let fixtures: string
let outDir: string
let launched: Launched

test.beforeAll(() => {
  fixtures = tempFolder('fixtures')
  outDir = tempFolder('out')
  makeFixtures(fixtures)
})

test.afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true })
  rmSync(outDir, { recursive: true, force: true })
})

test.beforeEach(async () => {
  launched = await launchApp()
})

test.afterEach(async () => {
  await launched.close()
})

const f = (name: string) => join(fixtures, name)
const REPORT = 'Annual report 2025.pdf'
const BRIEF = 'Études résumé 文档.pdf'
const PHOTO = 'harbour photo.jpg'

test('main journey: import, assemble, reorder, rotate, duplicate, undo, number, export, verify', async () => {
  const { page, app } = launched
  const consoleErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  // Local-only is a promise, so check it: nothing in this journey may touch the network.
  const networkRequests: string[] = []
  page.on('request', (request) => {
    if (/^(https?|wss?|ftp):/i.test(request.url())) networkRequests.push(request.url())
  })

  await importFiles(launched, [f(REPORT), f(BRIEF), f(PHOTO)])
  const rows = page.getByTestId('source-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('12 pages')
  await expect(rows.nth(1)).toContainText('8 pages')
  await expect(rows.nth(2)).toContainText('1600 × 1067 px')

  // Real thumbnails: pdf.js has drawn the first source page into a blob image.
  const sourceGrid = page.getByTestId('source-grid')
  await expect(sourceGrid.locator('[data-page-index="0"] img')).toHaveAttribute('src', /^blob:/, { timeout: 30_000 })

  // Pages 1-3 from the first PDF, by range.
  await page.getByTestId('range-input').fill('1-3')
  await page.getByTestId('range-add').click()
  await expect(page.getByTestId('output-count')).toContainText('3 pages')

  // A bad range explains itself.
  await page.getByTestId('range-input').fill('5-99')
  await page.getByTestId('range-add').click()
  await expect(page.getByText('Page 99 does not exist. This document has 12 pages.')).toBeVisible()
  await page.getByTestId('range-input').fill('')

  // Page 7 of the second PDF, by clicking.
  await rows.nth(1).locator('button').first().click()
  await expect(sourceGrid.getByRole('option')).not.toHaveCount(0)
  await sourceGrid.evaluate((element) => (element.scrollTop = 200))
  await page.locator('[data-testid="source-grid"] [data-page-index="6"]').click()
  await page.getByTestId('add-selected').click()
  await expect(page.getByTestId('output-count')).toContainText('4 pages')

  // The image.
  await rows.nth(2).locator('button').first().click()
  await page.getByTestId('add-all').click()
  await expect(page.getByTestId('output-count')).toContainText('5 pages')

  const output = page.getByTestId('output-grid')
  const cell = (index: number) => output.locator(`[data-page-index="${index}"]`)
  await expect(cell(0)).toContainText('Page 1')
  await expect(cell(3)).toContainText('Page 7')
  await expect(cell(4)).toContainText('harbour photo.jpg')
  await expect(cell(4).locator('img')).toHaveAttribute('src', /^blob:/, { timeout: 30_000 })

  // Reorder by dragging the image to the front.
  await cell(4).dragTo(cell(0), { targetPosition: { x: 4, y: 40 } })
  await expect(cell(0)).toContainText('harbour photo.jpg')
  await expect(cell(1)).toContainText('Annual report')

  // Move a group: pick pages at output 2 and 3, keep their order, drop them at the end.
  await cell(1).click()
  await cell(2).click({ modifiers: ['Control'] })
  await expect(page.getByTestId('output-count')).toContainText('2 selected')
  const box = (await cell(4).boundingBox())!
  const gridBox = (await output.boundingBox())!
  await cell(1).dragTo(output, { targetPosition: { x: box.x - gridBox.x + box.width + 4, y: box.y - gridBox.y + 60 } })
  const orderAfterGroup = await output.locator('[data-page-index]').evaluateAll((items) => items.map((item) => item.textContent))
  expect(orderAfterGroup[0]).toContain('harbour')
  expect(orderAfterGroup[1]).toContain('Page 3')
  expect(orderAfterGroup[3]).toContain('Page 1')
  expect(orderAfterGroup[4]).toContain('Page 2')

  // Rotate page 2 of the output, duplicate it.
  await cell(1).click()
  await page.getByTestId('rotate-right').click()
  await expect(cell(1)).toContainText('90°')
  await page.getByTestId('duplicate').click()
  await expect(page.getByTestId('output-count')).toContainText('6 pages')
  await expect(cell(2)).toContainText('Page 3')

  // A duplicate is independent of its original.
  await page.getByTestId('rotate-right').click()
  await expect(cell(2)).toContainText('180°')
  await expect(cell(1)).toContainText('90°')

  // Undo the extra rotation and the duplicate, then redo the duplicate.
  await page.keyboard.press('Control+z')
  await expect(cell(2)).not.toContainText('180°')
  await page.getByTestId('undo').click()
  await expect(page.getByTestId('output-count')).toContainText('5 pages')
  await page.getByTestId('redo').click()
  await expect(page.getByTestId('output-count')).toContainText('6 pages')
  await expect(cell(2)).toContainText('90°')

  // Delete key removes, and undo restores.
  await cell(5).click()
  await page.keyboard.press('Delete')
  await expect(page.getByTestId('output-count')).toContainText('5 pages')
  await page.keyboard.press('Control+z')
  await expect(page.getByTestId('output-count')).toContainText('6 pages')

  // Export with page numbers. Ctrl+S opens the dialog.
  const target = join(outDir, 'Journey résumé 出力.pdf')
  await mockSaveDialog(app, target)
  await output.click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+s')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Add page numbers').check()
  await dialog.getByLabel('Format').selectOption('n_of_total')
  await expect(page.getByTestId('worker-preview').locator('img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 30_000 })
  await page.getByTestId('export-confirm').click()
  await waitForJob(page)

  // Reopen independently and check everything.
  expect(existsSync(target)).toBe(true)
  const facts = inspectPdf(target)
  expect(facts.pageCount).toBe(6)
  expect(facts.pages[0].images).toBe(1)
  expect(facts.pages[1].text).toContain('REPORT-P3')
  expect(facts.pages[1].rotation).toBe(90)
  expect(facts.pages[2].text).toContain('REPORT-P3')
  expect(facts.pages[2].rotation).toBe(90)
  expect(facts.pages[3].text).toContain('BRIEF-P7')
  expect(facts.pages[4].text).toContain('REPORT-P1')
  expect(facts.pages[5].text).toContain('REPORT-P2')
  for (let i = 0; i < 6; i++) expect(facts.pages[i].text).toContain(`${i + 1} of 6`)
  // PDF pages stayed vector and text. The rotated page came through without any image.
  expect(facts.pages[1].images).toBe(0)
  // Nothing left behind, and no source changed.
  expect(readdirSync(outDir).filter((name) => name.startsWith('.paperforge-'))).toEqual([])
  expect(readFileSync(f(PHOTO)).length).toBeGreaterThan(0)

  expect(consoleErrors).toEqual([])
  expect(networkRequests).toEqual([])
})

test('dropping files imports them through the preload bridge, and unsupported files are refused', async () => {
  const { page } = launched
  // A real OS drag cannot be automated, but a file input yields the same real File objects, with paths.
  const handle = await page.evaluateHandle(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.style.display = 'none'
    document.body.appendChild(input)
    return input
  })
  await handle.asElement()!.setInputFiles([f(REPORT), f(BRIEF), f(PHOTO), f('notes.txt')])
  await page.evaluate((input) => {
    const transfer = new DataTransfer()
    for (const file of (input as HTMLInputElement).files!) transfer.items.add(file)
    window.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }))
  }, handle)
  const rows = page.getByTestId('source-row')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('12 pages')
  await expect(rows.nth(1)).toContainText('8 pages')
  await expect(page.getByTestId('toast-error').filter({ hasText: 'notes.txt' })).toBeVisible()
  await expect(page.getByText('Drop PDFs or images to import them')).toBeHidden()

  // The bridge only takes File objects, so a page script cannot pass it a path string.
  const smuggled = await page.evaluate(() => window.paperforge.importDropped(['C:\\Windows\\win.ini'] as unknown as File[]))
  expect(smuggled.files).toEqual([])
})

test('signed documents need acknowledgement before export', async () => {
  const { page, app } = launched
  await importFiles(launched, [f('signed contract.pdf')])
  await expect(page.getByTestId('source-row')).toContainText('1 page')
  await page.getByTestId('add-all').click()
  await page.getByTestId('export-button').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('digital signature')
  const confirm = page.getByTestId('export-confirm')
  await expect(confirm).toBeDisabled()
  await dialog.getByLabel('I understand existing digital signatures').check()
  await expect(confirm).toBeEnabled()
  const target = join(outDir, 'unsigned-copy.pdf')
  await mockSaveDialog(app, target)
  await confirm.click()
  await waitForJob(page)
  expect(inspectPdf(target).pages[0].text).toContain('SIGNED-P1')
})

test('cancelling a running job from the job bar stops it and leaves nothing behind', async () => {
  const { page, app } = launched
  const { mkdirSync } = await import('node:fs')
  await importFiles(launched, [f(REPORT)])
  await expect(page.getByTestId('source-row')).toContainText('12 pages')
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'PDF ↔ images' }).click()
  // Very high resolution over every page is slow enough to catch in the act.
  await page.getByLabel('Resolution (DPI)').fill('1200')
  const folder = join(outDir, 'cancelled-images')
  mkdirSync(folder, { recursive: true })
  await mockOpenDialog(app, [folder])
  await page.getByTestId('images-export').click()
  const job = page.getByTestId('job-line').first()
  await expect(job).toHaveAttribute('data-status', 'running', { timeout: 30_000 })
  await job.getByRole('button', { name: 'Cancel' }).click()
  await expect(job).toHaveAttribute('data-status', 'cancelled', { timeout: 30_000 })
  await expect(job).toContainText('No output was written')
  expect(readdirSync(folder)).toEqual([])

  // The worker is usable afterwards, whether it stopped by itself or was restarted.
  await page.getByLabel('Resolution (DPI)').fill('72')
  await page.getByTestId('images-export').click()
  await expect(page.getByTestId('job-line').first()).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  expect(readdirSync(folder)).toHaveLength(12)
})

test('shortcuts: keys stay out of text fields, and other tools do not touch the assembly', async () => {
  const { page, app } = launched
  await importFiles(launched, [f(REPORT)])
  await expect(page.getByTestId('source-row')).toContainText('12 pages')
  await page.getByTestId('add-all').click()
  const count = page.getByTestId('output-count')
  await expect(count).toContainText('12 pages')

  // The primary action stays on screen at the smallest supported laptop size.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 768))
  await expect
    .poll(async () => {
      const button = (await page.getByTestId('export-button').boundingBox())!
      const section = (await page.getByRole('region', { name: 'Output document' }).boundingBox())!
      return button.x + button.width <= section.x + section.width
    })
    .toBe(true)

  // Ctrl+A in the output selects all. Delete removes. Ctrl+Z restores.
  await page.getByTestId('output-grid').locator('[data-page-index="0"]').click()
  await page.keyboard.press('Control+a')
  await expect(count).toContainText('12 selected')
  await page.keyboard.press('Escape')
  await expect(count).not.toContainText('selected')

  // In a text field, Ctrl+A and Delete edit the text and leave pages alone.
  await page.getByTestId('output-grid').locator('[data-page-index="1"]').click()
  const input = page.getByTestId('range-input')
  await input.fill('1-2')
  await input.press('Control+a')
  await input.press('Delete')
  await expect(input).toHaveValue('')
  await expect(count).toContainText('12 pages')

  // Assembly stays mounted behind other tools. Its Delete shortcut must not act from there.
  await page.getByTestId('output-grid').locator('[data-page-index="1"]').click()
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Settings' }).click()
  await page.keyboard.press('Delete')
  await page.keyboard.press('Control+z')
  await page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name: 'Document Assembly' }).click()
  await expect(count).toContainText('12 pages')
  await expect(count).toContainText('1 selected')
})

test('errors: corrupt files, unsupported types and passwords are explained', async () => {
  const { page, app } = launched
  await importFiles(launched, [f('corrupt.pdf'), f('notes.txt')])
  await expect(page.getByTestId('toast-error').filter({ hasText: 'notes.txt' })).toBeVisible()
  await expect(page.getByTestId('source-row').filter({ hasText: 'corrupt.pdf' })).toContainText('could not be read')
  await dismissToasts(page)

  await mockOpenDialog(app, [f('locked.pdf')])
  await page.getByTestId('import-button').click()
  const prompt = page.getByTestId('password-prompt')
  await expect(prompt).toBeVisible()
  await prompt.getByLabel('Password', { exact: true }).fill('not the password')
  await prompt.getByRole('button', { name: 'Unlock' }).click()
  await expect(prompt.getByRole('alert')).toContainText('does not open')
  await prompt.getByLabel('Password', { exact: true }).fill('open-sesame')
  await prompt.getByRole('button', { name: 'Unlock' }).click()
  await expect(prompt).toBeHidden()
  const row = page.getByTestId('source-row').filter({ hasText: 'locked.pdf' })
  await expect(row).toContainText('12 pages')
  await row.locator('button').first().click()
  await expect(page.locator('[data-testid="source-grid"] [data-page-index="0"] img')).toHaveAttribute('src', /^blob:/, { timeout: 30_000 })

  // A failed job reports clearly without losing the workspace: the password's permissions forbid assembly.
  await page.getByTestId('add-all').click()
  await mockSaveDialog(app, join(outDir, 'denied.pdf'))
  await page.getByTestId('export-button').click()
  await page.getByTestId('export-confirm').click()
  await waitForJob(page, 'failed')
  await expect(page.getByTestId('toast-error').filter({ hasText: 'do not allow' })).toBeVisible()
  await expect(page.getByTestId('output-count')).toContainText('12 pages')
  expect(existsSync(join(outDir, 'denied.pdf'))).toBe(false)
})

test('tools: split, compress, protect, text and watermark run from their screens', async () => {
  const { page, app } = launched
  await importFiles(launched, [f(REPORT), f('scanned contract.pdf')])
  await expect(page.getByTestId('source-row')).toHaveCount(2)
  await expect(page.getByTestId('source-row').nth(1)).toContainText('1 page')

  const tool = async (name: string) => page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name }).click()

  // Split into custom ranges, with outputs previewed first.
  await tool('Split & extract')
  await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'Annual report 2025.pdf (12 pages)' })
  await page.getByTestId('split-ranges').fill('1-3, 4-8, 9-')
  await expect(page.getByTestId('split-count')).toContainText('Will create 3 files')
  await expect(page.getByTestId('split-plan')).toContainText('Annual report 2025-pages-4-8.pdf')
  const splitFolder = join(outDir, 'split')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(splitFolder, { recursive: true })
  await mockOpenDialog(app, [splitFolder])
  await page.getByTestId('split-run').click()
  await waitForJob(page)
  expect(readdirSync(splitFolder).sort()).toEqual([
    'Annual report 2025-pages-1-3.pdf',
    'Annual report 2025-pages-4-8.pdf',
    'Annual report 2025-pages-9-12.pdf'
  ])
  expect(inspectPdf(join(splitFolder, 'Annual report 2025-pages-4-8.pdf')).pages[0].text).toContain('REPORT-P4')

  // Running again meets the collision prompt.
  await page.getByTestId('split-run').click()
  await page.getByTestId('collision-replace').click()
  await expect(page.locator('[data-testid="job-line"]').first()).toHaveAttribute('data-status', 'done', { timeout: 30_000 })

  // Compress reports true numbers.
  await tool('Compress')
  await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'scanned contract.pdf (1 page)' })
  await page.getByTestId('mode-strong').click()
  const compressed = join(outDir, 'smaller.pdf')
  await mockSaveDialog(app, compressed)
  await page.getByTestId('compress-run').click()
  await expect(page.getByTestId('compress-result')).toBeVisible({ timeout: 60_000 })
  await expect(page.getByTestId('compress-quality')).toContainText('Image quality was reduced')
  expect(existsSync(compressed)).toBe(true)

  // Protect, then confirm the password is required by an independent reader.
  await tool('Password')
  await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'Annual report 2025.pdf (12 pages)' })
  await page.getByLabel('Open password', { exact: true }).fill('correct horse')
  await page.getByLabel('Confirm open password').fill('correct horse')
  const protectedFile = join(outDir, 'protected.pdf')
  await mockSaveDialog(app, protectedFile)
  await page.getByTestId('protect-run').click()
  await expect(page.getByTestId('toast-success').filter({ hasText: 'AES-256' })).toBeVisible({ timeout: 30_000 })
  expect(inspectPdf(protectedFile).needsPassword).toBe(true)
  expect(inspectPdf(protectedFile, 'correct horse').pages[0].text).toContain('REPORT-P1')

  // Text extraction names pages with no text.
  await tool('Extract text')
  await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'Annual report 2025.pdf (12 pages)' })
  await page.getByTestId('text-extract').click()
  await expect(page.getByTestId('text-preview')).toHaveValue(/--- Page 1 ---[\s\S]*REPORT-P1/, { timeout: 30_000 })

  // Watermark preview comes from the worker, then export writes real text.
  await tool('Watermark')
  await page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'Annual report 2025.pdf (12 pages)' })
  await page.getByTestId('watermark-text').fill('DRAFT COPY')
  await expect(page.getByTestId('worker-preview').locator('img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 30_000 })
  const marked = join(outDir, 'marked.pdf')
  await mockSaveDialog(app, marked)
  await page.getByTestId('watermark-run').click()
  await expect(page.getByText('reopened and verified')).toBeVisible({ timeout: 30_000 })
  expect(inspectPdf(marked).pages[11].text).toContain('DRAFT COPY')
})

test('more tools: merge, images both ways, page numbers, visual signature, document info', async () => {
  const { page, app } = launched
  const { mkdirSync } = await import('node:fs')
  const tool = async (name: string) => page.getByRole('navigation', { name: 'Tools' }).getByRole('button', { name }).click()
  const selectReport = () => page.getByRole('combobox', { name: 'Document' }).selectOption({ label: 'Annual report 2025.pdf (12 pages)' })

  // Readable preview from the assembly workspace.
  await importFiles(launched, [f(REPORT), f('mixed sizes.pdf')])
  await expect(page.getByTestId('source-row')).toHaveCount(2)
  await page.getByTestId('add-all').click()
  await page.getByTestId('output-grid').locator('[data-page-index="0"]').dblclick()
  await expect(page.getByTestId('page-preview').locator('canvas')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('page-preview')).toBeHidden()

  // Merge: reorder files, limit one to a range, export through the shared engine.
  await tool('Merge PDFs')
  await mockOpenDialog(app, [f(REPORT), f(BRIEF)])
  await page.getByTestId('merge-add').click()
  const items = page.getByTestId('merge-item')
  await expect(items).toHaveCount(2)
  await expect(page.getByTestId('merge-total')).toContainText('20 pages')
  await items.nth(1).getByRole('button', { name: 'Choose pages' }).click()
  await items.nth(1).getByRole('textbox').fill('7-8')
  await expect(page.getByTestId('merge-total')).toContainText('14 pages')
  await items.nth(1).getByRole('button', { name: 'Move up' }).click()
  const merged = join(outDir, 'merged.pdf')
  await mockSaveDialog(app, merged)
  await page.getByTestId('merge-export').click()
  await page.getByTestId('export-confirm').click()
  await expect(page.getByTestId('toast-success').filter({ hasText: 'merged.pdf' })).toBeVisible({ timeout: 30_000 })
  const mergedFacts = inspectPdf(merged)
  expect(mergedFacts.pageCount).toBe(14)
  expect(mergedFacts.pages[0].text).toContain('BRIEF-P7')
  expect(mergedFacts.pages[2].text).toContain('REPORT-P1')
  await dismissToasts(page)

  // Page numbers: preview, then real output.
  await tool('Page numbers')
  await selectReport()
  await page.getByLabel('Format').selectOption('page_n')
  await expect(page.getByTestId('worker-preview').locator('img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 30_000 })
  const numbered = join(outDir, 'numbered.pdf')
  await mockSaveDialog(app, numbered)
  await page.getByTestId('numbers-run').click()
  await expect(page.getByText('reopened and verified')).toBeVisible({ timeout: 30_000 })
  expect(inspectPdf(numbered).pages[11].text).toContain('Page 12')

  // PDF to images.
  await tool('PDF ↔ images')
  await selectReport().catch(() => undefined)
  const imageFolder = join(outDir, 'images')
  mkdirSync(imageFolder, { recursive: true })
  await page.getByRole('radio', { name: 'Choose pages' }).click()
  await page.getByTestId('pages-input').fill('1, 3')
  await page.getByRole('radio', { name: 'JPG: smaller' }).click()
  await mockOpenDialog(app, [imageFolder])
  await page.getByTestId('images-export').click()
  await expect(page.locator('[data-testid="job-line"]').first()).toHaveAttribute('data-status', 'done', { timeout: 60_000 })
  expect(readdirSync(imageFolder).sort()).toEqual(['Annual report 2025-page-01.jpg', 'Annual report 2025-page-03.jpg'])

  // Images to PDF, with a preview that comes from the worker.
  await page.getByRole('radio', { name: 'Images to PDF' }).click()
  await mockOpenDialog(app, [f('ridge line.jpg'), f(PHOTO)])
  await page.getByTestId('images-add').click()
  await expect(page.getByTestId('image-item')).toHaveCount(2)
  await expect(page.getByTestId('worker-preview').locator('img')).toHaveAttribute('src', /^data:image\/png/, { timeout: 30_000 })
  await page.getByTestId('image-item').nth(1).getByRole('button', { name: 'Move up' }).click()
  const imagesPdf = join(outDir, 'from-images.pdf')
  await mockSaveDialog(app, imagesPdf)
  await page.getByTestId('images-create').click()
  await expect(page.getByText('reopened and verified')).toBeVisible({ timeout: 30_000 })
  const imageFacts = inspectPdf(imagesPdf)
  expect(imageFacts.pageCount).toBe(2)
  expect(imageFacts.pages[0].width).toBeGreaterThan(imageFacts.pages[0].height)
  expect(imageFacts.pages[1].width).toBeLessThan(imageFacts.pages[1].height)

  // Visual signature: draw, place, add text, save, and find the result on the page.
  await tool('Visual signature')
  await selectReport()
  await expect(page.getByText('This is a visual signature only.')).toBeVisible()
  await page.getByTestId('sign-draw').click()
  const pad = page.getByTestId('signature-pad')
  const padBox = (await pad.boundingBox())!
  await page.mouse.move(padBox.x + 40, padBox.y + 60)
  await page.mouse.down()
  await page.mouse.move(padBox.x + 300, padBox.y + 120, { steps: 8 })
  await page.mouse.move(padBox.x + 420, padBox.y + 50, { steps: 8 })
  await page.mouse.up()
  await page.getByTestId('signature-done').click()
  await expect(page.getByTestId('placed-item')).toHaveCount(1)
  await page.getByTestId('sign-text').click()
  await page.getByTestId('sign-text-input').fill('Approved by test')
  await expect(page.getByTestId('placed-item')).toHaveCount(2)
  const signed = join(outDir, 'signed.pdf')
  await mockSaveDialog(app, signed)
  await page.getByTestId('sign-save').click()
  await expect(page.getByText('reopened and verified')).toBeVisible({ timeout: 30_000 })
  const signedFacts = inspectPdf(signed)
  expect(signedFacts.pages[0].drawnImages).toBe(1)
  expect(signedFacts.pages[0].text).toContain('Approved by test')
  expect(signedFacts.pages[1].drawnImages).toBe(0)
  expect(signedFacts.pages[1].text).not.toContain('Approved by test')

  // Document info shows real facts, and edits land in a new copy.
  await tool('Document info')
  await selectReport()
  await expect(page.getByTestId('info-facts')).toContainText('210 × 297 mm (A4)')
  await page.getByTestId('meta-title').fill('Renamed by test')
  const edited = join(outDir, 'edited.pdf')
  await mockSaveDialog(app, edited)
  await page.getByTestId('meta-save').click()
  await expect(page.getByText('reopened and verified')).toBeVisible({ timeout: 30_000 })
  expect(inspectPdf(edited).metadata.title).toBe('Renamed by test')

  // Settings persist and switch theme.
  await tool('Settings')
  await expect(page.getByTestId('about')).toContainText('2.1')
  await page.getByRole('radio', { name: 'Light' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await page.getByTestId('show-notices').click()
  await expect(page.getByRole('dialog', { name: 'Dependency notices' })).toContainText('PyMuPDF')
})

test('security: navigation is blocked and the renderer has no node access', async () => {
  const { page, app } = launched
  await expect(page.getByTestId('assembly-tool')).toBeVisible()
  const exposed = await page.evaluate(() => ({
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
    api: Object.keys(window.paperforge).sort().length > 0
  }))
  expect(exposed.require).toBe('undefined')
  expect(exposed.process).toBe('undefined')
  expect(exposed.api).toBe(true)

  const before = page.url()
  await page.evaluate(() => {
    window.location.href = 'https://example.com/'
  })
  await page.waitForTimeout(500)
  expect(page.url()).toBe(before)

  const popup = await page.evaluate(() => window.open('https://example.com/') === null)
  expect(popup).toBe(true)

  // Remote code cannot load: the CSP blocks an injected script.
  const blocked = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const script = document.createElement('script')
        script.src = 'https://example.com/x.js'
        script.onerror = () => resolve(true)
        script.onload = () => resolve(false)
        document.head.appendChild(script)
      })
  )
  expect(blocked).toBe(true)

  // Unregistered ids are refused, and the document protocol has no file access of its own.
  const status = await page.evaluate(() => fetch('pfdoc://source/not-a-real-id').then((response) => response.status))
  expect(status).toBe(404)

  // The renderer cannot hand the main process a path for a job.
  const response = await page.evaluate(() =>
    window.paperforge.submitJob({
      op: 'save_text',
      params: { text: 'x', output: { path: 'C:\\evil.txt', overwrite: 'replace' } }
    } as never)
  )
  expect(response.ok).toBe(false)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})
