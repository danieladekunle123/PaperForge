// Creates worker/.venv and installs the hash-locked dependencies from worker/requirements.lock.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const venv = join(root, 'worker', '.venv')
const python = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    console.error(`Command failed: ${command} ${args.join(' ')}`)
    process.exit(1)
  }
}

if (!existsSync(python)) {
  const candidates = process.platform === 'win32' ? [['py', ['-3.12']], ['python', []]] : [['python3', []]]
  const found = candidates.find(([cmd, pre]) => {
    const probe = spawnSync(cmd, [...pre, '--version'])
    return !probe.error && probe.status === 0
  })
  if (!found) {
    console.error('Python 3.11 or newer is required to build the worker. See README for details.')
    process.exit(1)
  }
  run(found[0], [...found[1], '-m', 'venv', venv])
}
run(python, ['-m', 'pip', 'install', '--require-hashes', '--no-deps', '-r', join('worker', 'requirements.lock')])
console.log('Worker environment ready.')
