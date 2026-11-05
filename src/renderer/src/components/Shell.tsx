/** Application chrome: title bar, tool navigation, job bar, toasts and the password prompt. */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  CircleAlert,
  CircleCheck,
  Combine,
  Eye,
  EyeOff,
  FileText,
  FolderOpen,
  Hash,
  Images,
  Info,
  Layers,
  LoaderCircle,
  LockKeyhole,
  Minimize2,
  PenLine,
  Scissors,
  Settings as SettingsIcon,
  ShieldCheck,
  Stamp,
  TriangleAlert,
  X
} from 'lucide-react'
import { useUi, type ToolId } from '../store/ui'
import { useJobs, type JobEntry } from '../store/jobs'
import { useWorkspace } from '../store/workspace'
import { BrandLockup } from './BrandLockup'
import { Button, cx, Field, IconButton, Modal, ProgressBar, TextInput } from './ui'
import { plural } from '../lib/format'

interface NavItem {
  id: ToolId
  label: string
  icon: ReactNode
}

const ICON = 16
const NAV: { group: string | null; items: NavItem[] }[] = [
  {
    group: null,
    items: [
      { id: 'assembly', label: 'Document Assembly', icon: <Layers size={ICON} /> },
      { id: 'merge', label: 'Merge PDFs', icon: <Combine size={ICON} /> },
      { id: 'split', label: 'Split & extract', icon: <Scissors size={ICON} /> }
    ]
  },
  {
    group: 'Convert & shrink',
    items: [
      { id: 'images', label: 'PDF ↔ images', icon: <Images size={ICON} /> },
      { id: 'compress', label: 'Compress', icon: <Minimize2 size={ICON} /> }
    ]
  },
  {
    group: 'Mark up',
    items: [
      { id: 'numbers', label: 'Page numbers', icon: <Hash size={ICON} /> },
      { id: 'watermark', label: 'Watermark', icon: <Stamp size={ICON} /> },
      { id: 'sign', label: 'Visual signature', icon: <PenLine size={ICON} /> }
    ]
  },
  {
    group: 'Inspect & protect',
    items: [
      { id: 'security', label: 'Password', icon: <LockKeyhole size={ICON} /> },
      { id: 'text', label: 'Extract text', icon: <FileText size={ICON} /> },
      { id: 'info', label: 'Document info', icon: <Info size={ICON} /> }
    ]
  }
]

function NavButton({ item }: { item: NavItem }) {
  const tool = useUi((state) => state.tool)
  const setTool = useUi((state) => state.setTool)
  const active = tool === item.id
  return (
    <button
      type="button"
      onClick={() => setTool(item.id)}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left transition-colors',
        active ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      )}
    >
      <span className="shrink-0">{item.icon}</span>
      <span className="truncate">{item.label}</span>
    </button>
  )
}

export function Sidebar() {
  return (
    <nav aria-label="Tools" className="flex w-[186px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-2">
        {NAV.map((section, index) => (
          <div key={index} className="space-y-0.5">
            {section.group && <div className="px-2.5 pt-1 pb-1 text-[11px] font-medium tracking-wide text-subtle">{section.group}</div>}
            {section.items.map((item) => (
              <NavButton key={item.id} item={item} />
            ))}
          </div>
        ))}
      </div>
      <div className="border-t border-line p-2">
        <NavButton item={{ id: 'settings', label: 'Settings', icon: <SettingsIcon size={ICON} /> }} />
      </div>
    </nav>
  )
}

export function TitleBar() {
  return (
    <header className="drag-region flex h-9 shrink-0 items-center border-b border-line bg-app pr-36 pl-[9px]">
      <BrandLockup />
    </header>
  )
}

function jobTone(job: JobEntry): string {
  if (job.status === 'failed') return 'text-danger'
  if (job.status === 'done') return 'text-ok'
  return 'text-muted'
}

function JobLine({ job, compact }: { job: JobEntry; compact?: boolean }) {
  const cancel = useJobs((state) => state.cancel)
  const dismiss = useJobs((state) => state.dismiss)
  const running = job.status === 'running' || job.status === 'queued' || job.status === 'cancelling'
  const outputs = job.result?.outputs ?? []
  const description = (() => {
    switch (job.status) {
      case 'queued':
        return 'Waiting…'
      case 'running':
        return job.stage ?? 'Working…'
      case 'cancelling':
        return 'Stopping…'
      case 'cancelled':
        return 'Cancelled. No output was written.'
      case 'failed':
        return job.error?.message ?? 'Failed.'
      case 'done':
        if (outputs.length === 0) return 'Finished.'
        return `${plural(outputs.length, 'file')} written${job.result?.verified ? ' and verified' : ''}.`
    }
  })()
  return (
    <div className="flex min-w-0 items-center gap-2.5" data-testid="job-line" data-status={job.status}>
      <span className={cx('shrink-0', jobTone(job))}>
        {running ? <LoaderCircle size={15} className="spin" /> : job.status === 'done' ? <CircleCheck size={15} /> : job.status === 'failed' ? <CircleAlert size={15} /> : <X size={15} />}
      </span>
      <span className="max-w-64 shrink-0 truncate font-medium">{job.label}</span>
      <span className={cx('min-w-0 truncate text-xs', job.status === 'failed' ? 'text-danger' : 'text-muted')} title={description}>
        {description}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {running && job.status !== 'queued' && !compact && (
          <ProgressBar className="w-40" done={job.done} total={job.total} indeterminate={!job.total || job.status === 'cancelling'} />
        )}
        {(job.status === 'running' || job.status === 'queued') && (
          <Button size="sm" variant="ghost" onClick={() => cancel(job.id)}>
            Cancel
          </Button>
        )}
        {job.status === 'done' && outputs[0] && (
          <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void window.paperforge.revealOutput(outputs[0].path)}>
            Show in folder
          </Button>
        )}
        {!running && (
          <IconButton label="Dismiss" className="h-6 w-6" onClick={() => dismiss(job.id)}>
            <X size={13} />
          </IconButton>
        )}
      </div>
    </div>
  )
}

export function JobBar() {
  const jobs = useJobs((state) => state.jobs)
  const [expanded, setExpanded] = useState(false)
  const shown = jobs.slice(0, expanded ? 8 : 1)
  return (
    <footer className="shrink-0 border-t border-line bg-surface px-3" aria-label="Jobs" aria-live="polite">
      {jobs.length === 0 ? (
        <div className="flex h-9 items-center gap-2 text-xs text-subtle">
          <ShieldCheck size={14} aria-hidden />
          Everything runs on this computer. Nothing is uploaded.
        </div>
      ) : (
        <div className={cx('py-2', expanded && 'space-y-2')}>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 space-y-2">
              {shown.map((job) => (
                <JobLine key={job.id} job={job} />
              ))}
            </div>
            {jobs.length > 1 && (
              <Button size="sm" variant="ghost" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
                {expanded ? 'Less' : `${jobs.length} jobs`}
              </Button>
            )}
          </div>
        </div>
      )}
    </footer>
  )
}

export function Toasts() {
  const toasts = useUi((state) => state.toasts)
  const dismiss = useUi((state) => state.dismissToast)
  const icons = {
    info: <Info size={15} className="text-muted" />,
    success: <CircleCheck size={15} className="text-ok" />,
    warn: <TriangleAlert size={15} className="text-warn" />,
    error: <CircleAlert size={15} className="text-danger" />
  }
  return (
    <div className="pointer-events-none fixed right-4 bottom-14 z-[60] flex w-96 max-w-[90vw] flex-col gap-2" aria-live="assertive">
      {toasts.map((toast) => (
        <div key={toast.id} data-testid={`toast-${toast.kind}`} className="pointer-events-auto flex items-start gap-2 rounded-md border border-line-strong bg-raised px-3 py-2 text-xs shadow-xl">
          <span className="mt-px shrink-0">{icons[toast.kind]}</span>
          <span className="selectable min-w-0 flex-1 leading-relaxed">{toast.message}</span>
          <button type="button" aria-label="Dismiss" className="text-subtle hover:text-fg" onClick={() => dismiss(toast.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function PasswordField({ value, onChange, id, autoComplete, placeholder, label }: { value: string; onChange: (value: string) => void; id?: string; autoComplete?: string; placeholder?: string; label?: string }) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative">
      <TextInput id={id} aria-label={label} type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete ?? 'off'} placeholder={placeholder} spellCheck={false} className="pr-8" />
      <button type="button" className="absolute top-1.5 right-1.5 text-subtle hover:text-fg" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible((v) => !v)}>
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>
  )
}

export function PasswordPrompt() {
  const request = useWorkspace((state) => state.passwordRequest)
  const entry = useWorkspace((state) => (request ? state.sources[request] : undefined))
  const submit = useWorkspace((state) => state.submitPassword)
  const close = useWorkspace((state) => state.requestPassword)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setPassword('')
    setError(null)
  }, [request])

  if (!request || !entry) return null

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || busy) return
    setBusy(true)
    const failure = await submit(request, password)
    setBusy(false)
    setError(failure)
    if (failure) setPassword('')
  }

  const upgrading = entry.status === 'ready'

  return (
    <Modal title={upgrading ? 'Owner password' : 'Password required'} onClose={() => close(null)} width="max-w-md">
      <form onSubmit={(event) => void onSubmit(event)} className="space-y-3" data-testid="password-prompt">
        <p className="text-sm break-words text-muted">
          <span className="font-medium text-fg">{entry.name}</span>{' '}
          {upgrading ? 'opens with restricted permissions. Enter its owner password if you have it, to allow editing, assembly and text extraction.' : 'is protected. Enter its password to open it here.'} The password stays in memory for this session and is never saved.
        </p>
        <Field label="Password" error={error}>
          {(id) => <PasswordField id={id} value={password} onChange={setPassword} autoComplete="off" />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => close(null)}>{upgrading ? 'Cancel' : 'Skip for now'}</Button>
          <Button type="submit" variant="primary" disabled={!password || busy}>
            {busy ? 'Checking…' : 'Unlock'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

export function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div className="rounded-lg border-2 border-dashed border-accent bg-surface px-8 py-6 text-sm font-medium">Drop PDFs or images to import them</div>
    </div>
  )
}

export function ToolHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex min-h-12 shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2">
      <div className="min-w-0">
        <h1 className="text-[15px] leading-tight font-semibold">{title}</h1>
        {description && <p className="mt-0.5 max-w-3xl text-xs text-muted">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}
