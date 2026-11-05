// Freezes the Python worker with PyInstaller, then checks the result actually starts.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = join(root, 'worker')
const python =
  process.platform === 'win32' ? join(workerDir, '.venv', 'Scripts', 'python.exe') : join(workerDir, '.venv', 'bin', 'python')

if (!existsSync(python)) {
  console.error('The worker environment is missing. Run "npm run setup" first.')
  process.exit(1)
}

const build = spawnSync(
  python,
  ['-m', 'PyInstaller', '--noconfirm', '--clean', '--distpath', 'dist', '--workpath', 'build', 'paperforge-worker.spec'],
  { cwd: workerDir, stdio: 'inherit' }
)
if (build.status !== 0) process.exit(build.status ?? 1)

const exe = join(workerDir, 'dist', 'paperforge-worker', process.platform === 'win32' ? 'paperforge-worker.exe' : 'paperforge-worker')
if (!existsSync(exe)) {
  console.error('PyInstaller finished, but the worker executable is missing.')
  process.exit(1)
}

// Smoke test: the frozen worker must announce itself, then exit when stdin closes.
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true })
let text = ''
const timer = setTimeout(() => {
  console.error('The frozen worker did not report ready within 60 seconds.')
  child.kill()
  process.exit(1)
}, 60_000)
child.stdout.on('data', (chunk) => {
  text += chunk
  if (text.includes('\n')) {
    const event = JSON.parse(text.split('\n')[0])
    if (event.type !== 'ready') {
      console.error('Unexpected first event from the frozen worker.')
      process.exit(1)
    }
    console.log(`Frozen worker OK: PyMuPDF ${event.pymupdf}, MuPDF ${event.mupdf}, Pillow ${event.pillow}`)
    child.stdin.end()
  }
})
child.on('exit', (code) => {
  clearTimeout(timer)
  process.exit(code ?? 1)
})
