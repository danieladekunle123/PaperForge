/** Tracks long-running jobs. A job reads as cancelled only after the main process confirms it. */
import { create } from 'zustand'
import type { JobError, JobResult, JobStatus, JobUpdate, RendererJob } from '../../../shared/types'

export interface JobEntry {
  id: string
  label: string
  status: JobStatus
  done?: number
  total?: number
  stage?: string
  result?: JobResult
  error?: JobError
  startedAt: number
}

export class JobCancelledError extends Error {}

export class JobFailedError extends Error {
  constructor(readonly jobError: JobError) {
    super(jobError.message)
  }
}

interface Waiter {
  resolve: (result: JobResult) => void
  reject: (reason: Error) => void
}

const waiters = new Map<string, Waiter>()
const earlyUpdates = new Map<string, JobUpdate>()
const MAX_HISTORY = 30

interface JobsState {
  jobs: JobEntry[]
  run(job: RendererJob, label: string): Promise<JobResult>
  cancel(id: string): void
  dismiss(id: string): void
  applyUpdate(update: JobUpdate): void
}

function settle(update: JobUpdate): boolean {
  const waiter = waiters.get(update.jobId)
  if (!waiter) return false
  if (update.status === 'done') waiter.resolve(update.result ?? {})
  else if (update.status === 'cancelled') waiter.reject(new JobCancelledError('Cancelled'))
  else if (update.status === 'failed') waiter.reject(new JobFailedError(update.error ?? { code: 'UNKNOWN', message: 'The job failed.' }))
  else return false
  waiters.delete(update.jobId)
  return true
}

export const useJobs = create<JobsState>((set, get) => ({
  jobs: [],

  run: async (job, label) => {
    const response = await window.paperforge.submitJob(job)
    if (!response.ok) throw new JobFailedError(response.error)
    const { jobId } = response
    set((state) => ({
      jobs: state.jobs.some((entry) => entry.id === jobId)
        ? state.jobs.map((entry) => (entry.id === jobId ? { ...entry, label } : entry))
        : [{ id: jobId, label, status: 'queued' as const, startedAt: Date.now() }, ...state.jobs].slice(0, MAX_HISTORY)
    }))
    return new Promise<JobResult>((resolve, reject) => {
      waiters.set(jobId, { resolve, reject })
      const early = earlyUpdates.get(jobId)
      if (early) {
        earlyUpdates.delete(jobId)
        settle(early)
      }
    })
  },

  cancel: (id) => void window.paperforge.cancelJob(id),

  dismiss: (id) => set((state) => ({ jobs: state.jobs.filter((entry) => entry.id !== id) })),

  applyUpdate: (update) => {
    const exists = get().jobs.some((entry) => entry.id === update.jobId)
    const patch = (entry: JobEntry): JobEntry => ({
      ...entry,
      status: entry.status === 'cancelling' && update.status === 'running' ? 'cancelling' : update.status,
      done: update.done ?? entry.done,
      total: update.total ?? entry.total,
      stage: update.stage ?? entry.stage,
      result: update.result ?? entry.result,
      error: update.error ?? entry.error
    })
    set((state) => ({
      jobs: exists
        ? state.jobs.map((entry) => (entry.id === update.jobId ? patch(entry) : entry))
        : [patch({ id: update.jobId, label: 'Working', status: update.status, startedAt: Date.now() }), ...state.jobs].slice(0, MAX_HISTORY)
    }))
    if (['done', 'failed', 'cancelled'].includes(update.status) && !settle(update)) {
      earlyUpdates.set(update.jobId, update)
    }
  }
}))

export function installJobListener(): () => void {
  return window.paperforge.onJobUpdate((update) => useJobs.getState().applyUpdate(update))
}

export const runJob = (job: RendererJob, label: string): Promise<JobResult> => useJobs.getState().run(job, label)
