import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { CircleAlert, Info, TriangleAlert, X, CircleCheck } from 'lucide-react'
import { useUi } from '../store/ui'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  icon?: ReactNode
  size?: 'sm' | 'md'
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover font-semibold',
  secondary: 'bg-raised text-fg border border-line hover:bg-hover hover:border-line-strong',
  ghost: 'text-muted hover:text-fg hover:bg-hover',
  danger: 'bg-danger-soft text-danger border border-transparent hover:border-danger'
}

export function Button({ variant = 'secondary', icon, size = 'md', className, children, type = 'button', ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md whitespace-nowrap transition-colors disabled:opacity-45 disabled:pointer-events-none',
        size === 'sm' ? 'h-7 px-2 text-xs' : 'h-8 px-3',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
}

export function IconButton({ label, active, className, children, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-35 disabled:pointer-events-none',
        active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-hover hover:text-fg',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  )
}

const INPUT = 'h-8 w-full rounded-md border border-line bg-app px-2 text-fg placeholder:text-subtle hover:border-line-strong focus-visible:border-accent'

export function TextInput({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(INPUT, className)} {...props} />
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step,
  id,
  className,
  ...rest
}: {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  id?: string
  className?: string
  'aria-label'?: string
}) {
  return (
    <input
      id={id}
      type="number"
      className={cx(INPUT, className)}
      value={Number.isNaN(value) ? '' : value}
      min={min}
      max={max}
      step={step}
      onChange={(event) => onChange(event.target.value === '' ? Number.NaN : Number(event.target.value))}
      {...rest}
    />
  )
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  className,
  ...rest
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  id?: string
  className?: string
  'aria-label'?: string
}) {
  return (
    <select id={id} className={cx(INPUT, 'pr-1', className)} value={value} onChange={(event) => onChange(event.target.value as T)} {...rest}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label
}: {
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string }[]
  label: string
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full flex-wrap rounded-md border border-line bg-app p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx(
            'h-7 rounded px-2.5 text-xs transition-colors',
            value === option.value ? 'bg-raised font-medium text-fg shadow-sm' : 'text-muted hover:text-fg'
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-2 text-sm', disabled && 'opacity-50')}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--pf-accent)]" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="text-fg">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-subtle">{hint}</span>}
      </span>
    </label>
  )
}

export function ColorInput({ value, onChange, id }: { value: string; onChange: (value: string) => void; id?: string }) {
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="color" value={value} onChange={(event) => onChange(event.target.value)} className="h-8 w-10 cursor-pointer rounded-md border border-line bg-app p-0.5" />
      <span className="font-mono text-xs text-muted">{value.toUpperCase()}</span>
    </div>
  )
}

const BANNER = {
  info: { icon: Info, box: 'bg-raised border-line text-muted', tone: 'text-muted' },
  warn: { icon: TriangleAlert, box: 'bg-warn-soft border-transparent text-fg', tone: 'text-warn' },
  error: { icon: CircleAlert, box: 'bg-danger-soft border-transparent text-fg', tone: 'text-danger' },
  success: { icon: CircleCheck, box: 'bg-ok-soft border-transparent text-fg', tone: 'text-ok' }
}

export function Banner({ kind = 'info', children, className }: { kind?: keyof typeof BANNER; children: ReactNode; className?: string }) {
  const style = BANNER[kind]
  const Icon = style.icon
  return (
    <div role={kind === 'error' ? 'alert' : undefined} className={cx('flex gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed', style.box, className)}>
      <Icon size={15} className={cx('mt-px shrink-0', style.tone)} aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-6 text-center">
      {icon && <div className="mb-1 text-subtle">{icon}</div>}
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {children && <div className="max-w-sm text-xs leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  )
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 'max-w-lg',
  dismissable = true
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
  dismissable?: boolean
}) {
  const pushModal = useUi((state) => state.pushModal)
  const popModal = useUi((state) => state.popModal)
  const panel = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    pushModal()
    const previous = document.activeElement as HTMLElement | null
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button')
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissable) {
        event.stopPropagation()
        closeRef.current()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')].filter((el) => !el.hasAttribute('disabled'))
      if (items.length === 0) return
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      popModal()
      previous?.focus?.()
    }
  }, [dismissable, popModal, pushModal])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-5" onMouseDown={(event) => dismissable && event.target === event.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className={cx('flex max-h-full w-full flex-col rounded-lg border border-line bg-surface shadow-2xl', width)}>
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line pr-1.5 pl-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          {dismissable && (
            <IconButton label="Close" onClick={onClose}>
              <X size={16} />
            </IconButton>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function ProgressBar({ done, total, indeterminate, className }: { done?: number; total?: number; indeterminate?: boolean; className?: string }) {
  const pct = !indeterminate && total ? Math.min(100, Math.round(((done ?? 0) / total) * 100)) : null
  return (
    <div
      role="progressbar"
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cx('h-1.5 w-full overflow-hidden rounded-full bg-hover', pct === null && 'indeterminate', className)}
    >
      {pct !== null && <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${pct}%` }} />}
    </div>
  )
}
