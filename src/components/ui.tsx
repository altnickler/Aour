import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react'
import { createPortal } from 'react-dom'
import { Link, useNavigate } from 'react-router'
import { ChevronLeft, X } from 'lucide-react'
import { cn } from '@/lib/cn'

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'butter' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const variantClass: Record<Variant, string> = {
  primary: 'bg-choc text-cream hover:bg-choc-soft shadow-press',
  secondary: 'bg-white text-choc ring-1 ring-line hover:bg-cream-deep',
  ghost: 'text-choc hover:bg-beige/60',
  butter: 'bg-butter text-choc hover:bg-gold shadow-press',
  danger: 'bg-white text-danger ring-1 ring-danger/25 hover:bg-danger/5',
}
const sizeClass: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5',
  md: 'h-11 px-5 text-[15px] gap-2',
  lg: 'h-14 px-6 text-base gap-2',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  block?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading, block, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'press inline-flex items-center justify-center rounded-full font-semibold whitespace-nowrap select-none disabled:opacity-50 disabled:pointer-events-none',
        variantClass[variant],
        sizeClass[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-4" /> : children}
    </button>
  )
})

export function IconButton({
  label,
  className,
  children,
  variant = 'ghost',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; variant?: 'ghost' | 'surface' | 'dark' }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'press inline-flex size-11 shrink-0 items-center justify-center rounded-full',
        variant === 'ghost' && 'text-choc hover:bg-beige/60',
        variant === 'surface' && 'bg-white/90 text-choc shadow-press ring-1 ring-line backdrop-blur',
        variant === 'dark' && 'bg-choc/70 text-cream backdrop-blur',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn('inline-block size-5 animate-spin rounded-full border-2 border-current border-r-transparent', className)}
    />
  )
}

// ---------------------------------------------------------------------------
// Chips & segmented controls
// ---------------------------------------------------------------------------
export function Chip({
  selected,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        'press inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold whitespace-nowrap',
        selected ? 'bg-choc text-cream' : 'bg-white text-choc ring-1 ring-line hover:bg-cream-deep',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  label: string
  className?: string
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('flex rounded-full bg-beige/70 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'press flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-3 text-sm font-semibold whitespace-nowrap',
            value === o.value ? 'bg-white text-choc shadow-press' : 'text-muted',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Badge({ className, children, tone = 'neutral' }: { className?: string; children: ReactNode; tone?: 'neutral' | 'butter' | 'success' | 'warn' | 'danger' | 'dark' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        tone === 'neutral' && 'bg-beige text-choc',
        tone === 'butter' && 'bg-butter text-choc',
        tone === 'success' && 'bg-success/12 text-success',
        tone === 'warn' && 'bg-gold/25 text-[#7a5410]',
        tone === 'danger' && 'bg-danger/10 text-danger',
        tone === 'dark' && 'bg-choc text-cream',
        className,
      )}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
export function Card({ className, children, as: As = 'div' }: { className?: string; children: ReactNode; as?: 'div' | 'section' | 'article' | 'li' }) {
  return <As className={cn('rounded-card bg-white shadow-card', className)}>{children}</As>
}

/** Sticky large-title header in the iOS style. */
export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  className,
}: {
  title: ReactNode
  subtitle?: ReactNode
  back?: boolean | string
  actions?: ReactNode
  className?: string
}) {
  const navigate = useNavigate()
  return (
    <header className={cn('pt-safe sticky top-0 z-20 bg-cream/90 backdrop-blur-xl', className)}>
      <div className="flex min-h-14 items-center gap-1 px-2">
        {back ? (
          typeof back === 'string' ? (
            <Link to={back} aria-label="Back" className="press inline-flex size-11 items-center justify-center rounded-full text-choc hover:bg-beige/60">
              <ChevronLeft className="size-6" />
            </Link>
          ) : (
            <IconButton label="Back" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}>
              <ChevronLeft className="size-6" />
            </IconButton>
          )
        ) : (
          <span className="w-3" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[22px] leading-tight font-extrabold tracking-tight text-choc">{title}</h1>
          {subtitle && <p className="truncate text-sm text-muted">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-1 pr-1">{actions}</div>}
      </div>
    </header>
  )
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('mt-6', className)}>
      {(title || action) && (
        <div className="mb-2.5 flex items-end justify-between gap-3 px-5">
          {title && <h2 className="text-lg font-extrabold tracking-tight text-choc">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function EmptyState({ icon, title, body, action, className }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center px-8 py-12 text-center', className)}>
      {icon && <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-butter-soft text-3xl text-choc">{icon}</div>}
      <h3 className="text-lg font-extrabold text-choc">{title}</h3>
      {body && <p className="mt-1.5 max-w-xs text-[15px] text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-tile', className)} />
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <EmptyState
      icon="😕"
      title="Something went wrong"
      body={error instanceof Error ? error.message : 'Please try again.'}
      action={retry && <Button variant="secondary" onClick={retry}>Try again</Button>}
    />
  )
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId()
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-sm font-semibold text-choc">
        {label}
      </label>
      {children(id)}
      {error ? <p className="text-sm text-danger">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  )
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-12 w-full rounded-tile bg-white px-4 text-espresso ring-1 ring-line placeholder:text-muted-soft focus:ring-2 focus:ring-gold focus:outline-none',
        className,
      )}
      {...rest}
    />
  )
})

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-24 w-full rounded-tile bg-white px-4 py-3 text-espresso ring-1 ring-line placeholder:text-muted-soft focus:ring-2 focus:ring-gold focus:outline-none',
        className,
      )}
      {...rest}
    />
  )
})

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: ReactNode }) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[15px] font-semibold text-choc">
          {label}
        </label>
        {description && <p className="text-sm text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn('relative h-8 w-13 shrink-0 rounded-full transition-colors', checked ? 'bg-choc' : 'bg-beige')}
      >
        <span className={cn('absolute top-1 left-1 size-6 rounded-full bg-white shadow-press transition-transform', checked && 'translate-x-5')} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bottom sheet (modal dialog)
// ---------------------------------------------------------------------------
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab' && panel.current) {
        const focusables = panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
        if (!focusables.length) return
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    requestAnimationFrame(() => panel.current?.focus())
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      previouslyFocused?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="animate-fade absolute inset-0 bg-espresso/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'animate-sheet pb-safe relative flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[1.75rem] bg-cream shadow-float focus:outline-none sm:rounded-[1.75rem]',
          className,
        )}
      >
        <div className="mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-beige" aria-hidden />
        <div className="flex items-center justify-between gap-2 px-5 pt-2 pb-1">
          <h2 id={titleId} className="text-lg font-extrabold text-choc">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2">
            <X className="size-5" />
          </IconButton>
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer && <div className="border-t border-line px-5 pt-3 pb-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

// ---------------------------------------------------------------------------
// Avatar
// ---------------------------------------------------------------------------
export function Avatar({ name, url, size = 40, className }: { name: string; url?: string | null; size?: number; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return url ? (
    <img src={url} alt="" width={size} height={size} loading="lazy" className={cn('shrink-0 rounded-full object-cover', className)} style={{ width: size, height: size }} />
  ) : (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center rounded-full bg-butter font-bold text-choc', className)}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {initials || '?'}
    </span>
  )
}
