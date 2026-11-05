// Runs the worker virtual environment's Python with the given arguments.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python =
  process.platform === 'win32'
    ? join(root, 'worker', '.venv', 'Scripts', 'python.exe')
    : join(root, 'worker', '.venv', 'bin', 'python')

if (!existsSync(python)) {
  console.error('The worker environment is missing. Run "npm run setup" first.')
  process.exit(1)
}

const result = spawnSync(python, process.argv.slice(2), {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
})
process.exit(result.status ?? 1)
