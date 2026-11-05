/**
 * Owns one worker process: spawn, restart, the JSON Lines protocol, a bounded queue and cancellation.
 * Jobs are handed to the worker one at a time, so waiting jobs stay cancellable here.
 * Request contents are never logged because they can include passwords.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { workerEventSchema, type WorkerEvent } from '../shared/schemas'
import type { JobError, JobResult } from '../shared/types'

export interface WorkerCommand {
  command: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface WorkerHostOptions {
  name: string
  resolveCommand: () => WorkerCommand
  log: (message: string) => void
  /** Removes temp files for a job that may have been killed mid-write. */
  sweep?: (jobId: string, directories: string[]) => void
  maxQueued?: number
  readyTimeoutMs?: number
  cancelGraceMs?: number
}

export interface SubmitOptions {
  jobId?: string
  /** A newer job with the same key replaces a waiting one. Used for live previews. */
  coalesceKey?: string
  /** Output folders to sweep if this job is interrupted. */
  sweepDirectories?: string[]
  onStart?: () => void
  onProgress?: (done: number, total: number, stage?: string) => void
}

export class JobFailure extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
  toJobError(): JobError {
    return { code: this.code, message: this.message }
  }
}

interface QueuedJob {
  id: string
  op: string
  params: unknown
  options: SubmitOptions
  resolve: (value: JobResult) => void
  reject: (reason: JobFailure) => void
  cancelRequested: boolean
  killTimer?: NodeJS.Timeout
}

export interface VersionInfo {
  worker: string
  pymupdf: string
  mupdf: string
  pillow: string
}

const MAX_LINE_BYTES = 512 * 1024 * 1024

export class WorkerHost {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private buffer: Buffer[] = []
  private bufferedBytes = 0
  private queue: QueuedJob[] = []
  private active: QueuedJob | null = null
  private readyTimer: NodeJS.Timeout | null = null
  private disposed = false
  private expectedExit = false
  versions: VersionInfo | null = null

  constructor(private readonly options: WorkerHostOptions) {}

  private get maxQueued(): number {
    return this.options.maxQueued ?? 64
  }

  /** Queue a job. Rejects with a JobFailure carrying a user-facing message. */
  submit(op: string, params: unknown, options: SubmitOptions = {}): { id: string; promise: Promise<JobResult> } {
    const id = options.jobId ?? randomUUID().replaceAll('-', '')
    const promise = new Promise<JobResult>((resolve, reject) => {
      if (this.disposed) {
        reject(new JobFailure('WORKER_UNAVAILABLE', 'The processing worker has shut down.'))
        return
      }
      if (options.coalesceKey) {
        const index = this.queue.findIndex((job) => job.options.coalesceKey === options.coalesceKey)
        if (index !== -1) {
          const [stale] = this.queue.splice(index, 1)
          stale.reject(new JobFailure('SUPERSEDED', 'A newer request replaced this one.'))
        }
      }
      if (this.queue.length >= this.maxQueued) {
        reject(new JobFailure('QUEUE_FULL', 'Too many jobs are waiting. Let some finish, then try again.'))
        return
      }
      this.queue.push({ id, op, params, options, resolve, reject, cancelRequested: false })
      this.pump()
    })
    return { id, promise }
  }

  /**
   * Ask for a job to stop. The job's promise only settles as cancelled once the worker confirms it
   * stopped, or once the worker has been terminated after the grace period.
   */
  cancel(id: string): 'dequeued' | 'requested' | 'unknown' {
    const index = this.queue.findIndex((job) => job.id === id)
    if (index !== -1) {
      const [job] = this.queue.splice(index, 1)
      job.reject(new JobFailure('CANCELLED', 'Cancelled before it started.'))
      return 'dequeued'
    }
    const job = this.active
    if (!job || job.id !== id) return 'unknown'
    if (job.cancelRequested) return 'requested'
    job.cancelRequested = true
    this.write({ v: 1, type: 'cancel', id })
    job.killTimer = setTimeout(() => {
      this.options.log(`${this.options.name}: job ${id} did not stop in time, terminating worker`)
      this.kill()
    }, this.options.cancelGraceMs ?? 5000)
    return 'requested'
  }

  isActive(id: string): boolean {
    return this.active?.id === id
  }

  get busy(): boolean {
    return this.active !== null || this.queue.length > 0
  }

  /** Start the process ahead of need. Failures surface on the next job. */
  warmUp(): void {
    if (!this.child && !this.disposed) this.start()
  }

  dispose(): void {
    this.disposed = true
    for (const job of this.queue.splice(0)) {
      job.reject(new JobFailure('WORKER_UNAVAILABLE', 'The application is closing.'))
    }
    if (this.child) {
      this.expectedExit = true
      this.child.stdin.end()
      const child = this.child
      setTimeout(() => {
        if (child.exitCode === null) child.kill()
      }, 1500).unref()
    }
  }

  private kill(): void {
    if (this.child) this.child.kill()
  }

  private pump(): void {
    if (this.active || this.queue.length === 0 || this.disposed) return
    if (!this.child) {
      if (!this.start()) return
    }
    if (!this.ready) return
    const job = this.queue.shift()!
    this.active = job
    job.options.onStart?.()
    this.write({ v: 1, type: 'job', id: job.id, op: job.op, params: job.params })
  }

  private start(): boolean {
    let command: WorkerCommand
    try {
      command = this.options.resolveCommand()
    } catch (error) {
      this.failAll(new JobFailure('WORKER_UNAVAILABLE', (error as Error).message))
      return false
    }
    this.ready = false
    this.buffer = []
    this.bufferedBytes = 0
    this.expectedExit = false
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.command, command.args, {
        cwd: command.cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...command.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      })
    } catch (error) {
      this.failAll(new JobFailure('WORKER_UNAVAILABLE', `The processing worker could not start: ${(error as Error).message}`))
      return false
    }
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => this.onStdout(child, chunk))
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (line.trim()) this.options.log(`${this.options.name}: ${line}`)
      }
    })
    child.stdin.on('error', () => {
      /* The exit handler reports this. */
    })
    child.on('error', (error) => {
      this.options.log(`${this.options.name}: spawn error ${error.message}`)
      this.onExit(child, null)
    })
    child.on('exit', (code) => this.onExit(child, code))
    this.readyTimer = setTimeout(() => {
      this.options.log(`${this.options.name}: no ready event, terminating`)
      child.kill()
    }, this.options.readyTimeoutMs ?? 60_000)
    return true
  }

  private write(message: unknown): void {
    if (!this.child) return
    try {
      this.child.stdin.write(JSON.stringify(message) + '\n')
    } catch (error) {
      this.options.log(`${this.options.name}: write failed ${(error as Error).name}`)
    }
  }

  private onStdout(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
    if (child !== this.child) return
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(10, start)
      if (newline === -1) break
      this.buffer.push(chunk.subarray(start, newline))
      const line = Buffer.concat(this.buffer).toString('utf8')
      this.buffer = []
      this.bufferedBytes = 0
      this.onLine(line)
      start = newline + 1
    }
    if (start < chunk.length) {
      this.buffer.push(chunk.subarray(start))
      this.bufferedBytes += chunk.length - start
      if (this.bufferedBytes > MAX_LINE_BYTES) {
        this.protocolFailure('oversized message')
      }
    }
  }

  private onLine(line: string): void {
    let event: WorkerEvent
    try {
      event = workerEventSchema.parse(JSON.parse(line))
    } catch {
      // The content could be document data, so only the fact is logged.
      this.protocolFailure('invalid message')
      return
    }
    this.onEvent(event)
  }

  private protocolFailure(reason: string): void {
    this.options.log(`${this.options.name}: protocol failure (${reason}), restarting worker`)
    this.kill()
  }

  private onEvent(event: WorkerEvent): void {
    switch (event.type) {
      case 'ready':
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.ready = true
        this.versions = {
          worker: event.worker,
          pymupdf: event.pymupdf,
          mupdf: event.mupdf,
          pillow: event.pillow
        }
        this.pump()
        return
      case 'progress':
        if (this.active?.id === event.id) {
          this.active.options.onProgress?.(event.done, event.total, event.stage)
        }
        return
      case 'result':
        this.finish(event.id, (job) => job.resolve(event.data as JobResult))
        return
      case 'cancelled':
        this.finish(event.id, (job) => job.reject(new JobFailure('CANCELLED', 'Cancelled.')))
        return
      case 'error':
        if (event.id === null) {
          this.options.log(`${this.options.name}: worker rejected a message: ${event.code}`)
          return
        }
        this.finish(event.id, (job) => job.reject(new JobFailure(event.code, event.message)))
        return
    }
  }

  private finish(id: string, settle: (job: QueuedJob) => void): void {
    const job = this.active
    if (!job || job.id !== id) return
    if (job.killTimer) clearTimeout(job.killTimer)
    this.active = null
    settle(job)
    this.pump()
  }

  private onExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (child !== this.child) return
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.child = null
    this.ready = false
    if (!this.expectedExit && !this.disposed) {
      this.options.log(`${this.options.name}: worker exited with code ${code}`)
    }
    const job = this.active
    this.active = null
    if (job) {
      if (job.killTimer) clearTimeout(job.killTimer)
      this.options.sweep?.(job.id, job.options.sweepDirectories ?? [])
      if (job.cancelRequested) {
        job.reject(new JobFailure('CANCELLED', 'Cancelled. The worker was stopped.'))
      } else {
        job.reject(new JobFailure('WORKER_CRASHED', 'The processing worker stopped unexpectedly. Your source files are unchanged. Please try again.'))
      }
    } else if (!this.versions && !this.expectedExit && !this.disposed) {
      // Never reached ready, and nothing was running: waiting jobs would otherwise spin forever.
      this.failAll(new JobFailure('WORKER_UNAVAILABLE', 'The processing worker could not start. Reinstalling PaperForge may fix this.'))
      return
    }
    if (!this.disposed) this.pump()
  }

  private failAll(failure: JobFailure): void {
    for (const job of this.queue.splice(0)) job.reject(failure)
  }
}
