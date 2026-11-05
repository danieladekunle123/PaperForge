import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JobFailure, WorkerHost, type WorkerHostOptions } from '../../src/main/workerHost'

const script = join(__dirname, 'fake-worker.mjs')
const hosts: WorkerHost[] = []

function host(mode = 'normal', options: Partial<WorkerHostOptions> = {}) {
  const logs: string[] = []
  const worker = new WorkerHost({
    name: 'test',
    resolveCommand: () => ({ command: process.execPath, args: [script, mode] }),
    log: (message) => logs.push(message),
    cancelGraceMs: 150,
    readyTimeoutMs: 800,
    ...options
  })
  hosts.push(worker)
  return { worker, logs }
}

async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  try {
    await promise
  } catch (error) {
    return error as JobFailure
  }
  throw new Error('expected the job to fail')
}

afterEach(() => {
  for (const worker of hosts.splice(0)) worker.dispose()
})

describe('WorkerHost', () => {
  it('runs a job, passing params and reporting progress', async () => {
    const { worker } = host()
    const progress = vi.fn()
    const started = vi.fn()
    const { promise } = worker.submit('ok', { a: 1 }, { onProgress: progress, onStart: started })
    const result = await promise
    expect(result.echo).toEqual({ a: 1 })
    expect(progress).toHaveBeenCalledWith(1, 2, 'half')
    expect(started).toHaveBeenCalledOnce()
    expect(worker.versions?.pymupdf).toBe('2')
  })

  it('reassembles messages split across chunks, including multi-byte text', async () => {
    const { worker } = host()
    const result = await worker.submit('split-lines', {}).promise
    expect(result.text).toBe('é'.repeat(5000))
  })

  it('reports worker errors with their code', async () => {
    const { worker } = host()
    const error = await failure(worker.submit('fail', {}).promise)
    expect(error).toBeInstanceOf(JobFailure)
    expect(error.code).toBe('WRONG_PASSWORD')
  })

  it('runs jobs strictly one at a time, in order', async () => {
    const { worker } = host()
    const order: number[] = []
    await Promise.all([1, 2, 3].map((n) => worker.submit('ok', { n }, { onStart: () => order.push(n) }).promise))
    expect(order).toEqual([1, 2, 3])
  })

  it('reports a crash as a failure, then recovers on the next job', async () => {
    const { worker } = host()
    const sweep = vi.fn()
    const crash = new WorkerHost({
      name: 'crash',
      resolveCommand: () => ({ command: process.execPath, args: [script] }),
      log: () => undefined,
      sweep
    })
    hosts.push(crash)
    const error = await failure(crash.submit('crash', {}, { jobId: 'job1', sweepDirectories: ['C:\\out'] }).promise)
    expect(error.code).toBe('WORKER_CRASHED')
    expect(sweep).toHaveBeenCalledWith('job1', ['C:\\out'])
    await expect(crash.submit('ok', { again: true }).promise).resolves.toBeTruthy()
    await worker.submit('ok', {}).promise
  })

  it('treats invalid protocol output as a failure and restarts', async () => {
    const { worker, logs } = host()
    const error = await failure(worker.submit('garbage', {}).promise)
    expect(error.code).toBe('WORKER_CRASHED')
    expect(logs.join(' ')).toContain('protocol failure')
    expect(logs.join(' ')).not.toContain('this is not json')
    await expect(worker.submit('ok', {}).promise).resolves.toBeTruthy()
  })

  it('cancels a waiting job immediately, without the worker seeing it', async () => {
    const { worker } = host()
    const first = worker.submit('hang', {})
    const second = worker.submit('ok', {})
    expect(worker.cancel(second.id)).toBe('dequeued')
    expect((await failure(second.promise)).code).toBe('CANCELLED')
    worker.cancel(first.id)
    expect((await failure(first.promise)).code).toBe('CANCELLED')
  })

  it('does not report cancellation until the worker confirms it', async () => {
    const { worker } = host()
    const job = worker.submit('hang', {}, { jobId: 'cooperative' })
    await new Promise((resolve) => setTimeout(resolve, 200))
    let settled = false
    void job.promise.catch(() => (settled = true))
    expect(worker.cancel('cooperative')).toBe('requested')
    expect(settled).toBe(false)
    expect((await failure(job.promise)).code).toBe('CANCELLED')
    await expect(worker.submit('ok', {}).promise).resolves.toBeTruthy()
  })

  it('terminates a worker that ignores cancel, sweeps temp files, and restarts', async () => {
    const sweep = vi.fn()
    const { worker } = host('stubborn', { sweep })
    const job = worker.submit('hang', {}, { jobId: 'stuck', sweepDirectories: ['C:\\out'] })
    await new Promise((resolve) => setTimeout(resolve, 200))
    worker.cancel('stuck')
    const error = await failure(job.promise)
    expect(error.code).toBe('CANCELLED')
    expect(sweep).toHaveBeenCalledWith('stuck', ['C:\\out'])
    await expect(worker.submit('ok', {}).promise).resolves.toBeTruthy()
  })

  it('replaces a waiting preview with a newer one', async () => {
    const { worker } = host()
    const blocker = worker.submit('hang', {}, { jobId: 'blocker' })
    const stale = worker.submit('ok', { n: 1 }, { coalesceKey: 'preview' })
    const fresh = worker.submit('ok', { n: 2 }, { coalesceKey: 'preview' })
    expect((await failure(stale.promise)).code).toBe('SUPERSEDED')
    worker.cancel('blocker')
    await failure(blocker.promise)
    expect((await fresh.promise).echo).toEqual({ n: 2 })
  })

  it('bounds its queue', async () => {
    const { worker } = host('normal', { maxQueued: 2 })
    let started: () => void = () => undefined
    const running = new Promise<void>((resolve) => (started = resolve))
    const blocker = worker.submit('hang', {}, { jobId: 'blocker2', onStart: () => started() })
    await running
    const waiting = [worker.submit('ok', {}), worker.submit('ok', {})]
    const overflow = worker.submit('ok', {})
    expect((await failure(overflow.promise)).code).toBe('QUEUE_FULL')
    worker.cancel('blocker2')
    await failure(blocker.promise)
    await Promise.all(waiting.map((job) => job.promise))
  })

  it('reports a worker that cannot start', async () => {
    const { worker } = host('die-on-start')
    expect((await failure(worker.submit('ok', {}).promise)).code).toBe('WORKER_UNAVAILABLE')
  })

  it('reports a missing worker command', async () => {
    const worker = new WorkerHost({
      name: 'none',
      resolveCommand: () => {
        throw new Error('The worker is missing.')
      },
      log: () => undefined
    })
    hosts.push(worker)
    const error = await failure(worker.submit('ok', {}).promise)
    expect(error.code).toBe('WORKER_UNAVAILABLE')
    expect(error.message).toContain('missing')
  })

  it('gives up on a worker that never becomes ready', async () => {
    const { worker } = host('never-ready', { readyTimeoutMs: 200 })
    expect((await failure(worker.submit('ok', {}).promise)).code).toBe('WORKER_UNAVAILABLE')
  })

  it('never logs request contents', async () => {
    const { worker, logs } = host()
    await worker.submit('ok', { password: 'TOPSECRET' }).promise
    expect(logs.join(' ')).not.toContain('TOPSECRET')
  })
})
