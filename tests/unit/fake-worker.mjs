// A controllable stand-in for the Python worker, for testing how the host handles failures.
import { createInterface } from 'node:readline'

const send = (event) => process.stdout.write(JSON.stringify({ v: 1, ...event }) + '\n')
const mode = process.argv[2] ?? 'normal'

if (mode === 'die-on-start') process.exit(3)
if (mode !== 'never-ready') send({ type: 'ready', worker: '1', pymupdf: '2', mupdf: '3', pillow: '4' })

const rl = createInterface({ input: process.stdin })
let running = null

rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'cancel') {
    // 'stubborn' ignores cancel requests, like a worker stuck inside a long native call.
    if (message.id === running && mode !== 'stubborn') {
      running = null
      send({ type: 'cancelled', id: message.id })
    }
    return
  }
  const { id, op, params } = message
  switch (op) {
    case 'ok':
      send({ type: 'progress', id, done: 1, total: 2, stage: 'half' })
      send({ type: 'result', id, data: { echo: params, outputs: [] } })
      break
    case 'fail':
      send({ type: 'error', id, code: 'WRONG_PASSWORD', message: 'nope', details: {} })
      break
    case 'hang':
      running = id
      break
    case 'crash':
      process.exit(9)
      break
    case 'garbage':
      process.stdout.write('this is not json\n')
      break
    case 'split-lines': {
      const text = JSON.stringify({ v: 1, type: 'result', id, data: { text: 'é'.repeat(5000) } }) + '\n'
      const bytes = Buffer.from(text)
      process.stdout.write(bytes.subarray(0, 100))
      setTimeout(() => process.stdout.write(bytes.subarray(100)), 20)
      break
    }
    default:
      send({ type: 'error', id, code: 'INVALID_REQUEST', message: 'unknown' })
  }
})
rl.on('close', () => process.exit(0))
