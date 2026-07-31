'use client'

/**
 * Hand-rolled UI kit — no Radix, no Base UI, no runtime surprises.
 * Everything is Tailwind v4 + native semantics, sized for a dense terminal.
 */
import { cn } from '@/lib/utils'
import { ChevronDown, X } from 'lucide-react'
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react'

/* ---------------------------------------------------------------- Button --- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type ButtonSize = 'sm' | 'md' | 'icon'

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-bull/15 text-bull border border-bull/40 hover:bg-bull/25',
  secondary: 'bg-card-2 text-foreground border border-border hover:border-border-strong hover:bg-muted',
  ghost: 'text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent',
  danger: 'bg-bear/12 text-bear border border-bear/40 hover:bg-bear/20',
  outline: 'border border-border-strong text-foreground hover:bg-muted/40',
}

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-7 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  icon: 'h-7 w-7 justify-center',
}

export function Button({
  variant = 'secondary',
  size = 'sm',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      {...props}
      className={cn(
        'inline-flex items-center rounded-md font-medium transition-colors duration-150 active:translate-y-px',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
        'disabled:pointer-events-none disabled:opacity-45',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    />
  )
}

/* ----------------------------------------------------------------- Panel --- */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  ...rest
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
} & { 'data-testid'?: string }) {
  return (
    <section
      {...rest}
      className={cn('flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card', className)}
    >
      {(title || actions) && (
        <header className="flex min-h-[38px] shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-2">
          <div className="min-w-0">
            {title && <h2 className="truncate text-[13px] font-medium tracking-tight">{title}</h2>}
            {subtitle && <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      <div className={cn('min-w-0 flex-1 p-3', bodyClassName)}>{children}</div>
    </section>
  )
}

/* ----------------------------------------------------------------- Badge --- */

type Tone = 'bull' | 'bear' | 'neutral' | 'warning' | 'veto' | 'info' | 'plain'

const TONES: Record<Tone, string> = {
  bull: 'border-bull/35 bg-bull/12 text-bull',
  bear: 'border-bear/35 bg-bear/12 text-bear',
  neutral: 'border-border bg-muted/40 text-muted-foreground',
  warning: 'border-warning/35 bg-warning/12 text-warning',
  veto: 'border-veto/40 bg-veto/12 text-veto',
  info: 'border-info/35 bg-info/12 text-info',
  plain: 'border-border bg-card-2 text-foreground',
}

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...rest
}: { tone?: Tone; className?: string; children: ReactNode } & { 'data-testid'?: string; title?: string }) {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Chip({
  tone = 'neutral',
  className,
  children,
  ...rest
}: { tone?: Tone; className?: string; children: ReactNode } & { 'data-testid'?: string; title?: string }) {
  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

export function Dot({ tone = 'neutral', pulse }: { tone?: Tone; pulse?: boolean }) {
  const map: Record<Tone, string> = {
    bull: 'bg-bull',
    bear: 'bg-bear',
    neutral: 'bg-muted-foreground',
    warning: 'bg-warning',
    veto: 'bg-veto',
    info: 'bg-info',
    plain: 'bg-foreground',
  }
  return <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', map[tone], pulse && 'pulse-dot')} />
}

/* ----------------------------------------------------------------- Input --- */

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={cn(
        'h-8 w-full rounded-md border border-border bg-background px-2.5 text-sm text-foreground placeholder:text-muted-foreground/70',
        'focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25',
        className,
      )}
    />
  )
}

export function NumberInput({
  value,
  onChangeValue,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: number
  onChangeValue: (v: number) => void
}) {
  const [text, setText] = useState(String(value))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(String(value))
  }, [value])
  return (
    <input
      {...props}
      type="number"
      value={text}
      onFocus={() => (focused.current = true)}
      onBlur={() => {
        focused.current = false
        const n = Number(text)
        if (Number.isFinite(n)) onChangeValue(n)
        else setText(String(value))
      }}
      onChange={(e) => {
        setText(e.target.value)
        const n = Number(e.target.value)
        if (Number.isFinite(n) && e.target.value !== '') onChangeValue(n)
      }}
      className={cn(
        'num h-8 w-full rounded-md border border-border bg-background px-2 text-right text-sm',
        'focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25',
        className,
      )}
    />
  )
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          'h-8 w-full appearance-none rounded-md border border-border bg-background pl-2.5 pr-7 text-sm text-foreground',
          'focus:border-ring/60 focus:outline-none focus:ring-2 focus:ring-ring/25',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  )
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  ...rest
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  disabled?: boolean
} & { 'data-testid'?: string }) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-2', disabled && 'cursor-not-allowed opacity-50')}>
      <button
        {...rest}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => !disabled && onChange(!checked)}
        className={cn(
          'relative h-4 w-7 shrink-0 rounded-full border transition-colors duration-150',
          checked ? 'border-bull/50 bg-bull/30' : 'border-border bg-muted',
        )}
      >
        <span
          className={cn(
            'absolute top-[1px] h-3 w-3 rounded-full transition-all duration-150',
            checked ? 'left-[13px] bg-bull' : 'left-[1px] bg-muted-foreground',
          )}
        />
      </button>
      {label && <span className="select-none text-xs text-muted-foreground">{label}</span>}
    </label>
  )
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
  ...rest
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  className?: string
} & { 'data-testid'?: string }) {
  return (
    <input
      {...rest}
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted',
        '[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:appearance-none',
        '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-bull [&::-webkit-slider-thumb]:shadow',
        '[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-bull',
        className,
      )}
    />
  )
}

/* ------------------------------------------------------------------ Tabs --- */

const TabsCtx = createContext<{ value: string; set: (v: string) => void }>({ value: '', set: () => {} })

export function Tabs({
  value,
  onChange,
  children,
  className,
}: {
  value: string
  onChange: (v: string) => void
  children: ReactNode
  className?: string
}) {
  return (
    <TabsCtx.Provider value={{ value, set: onChange }}>
      <div className={className}>{children}</div>
    </TabsCtx.Provider>
  )
}

export function TabList({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="tablist"
      className={cn('flex gap-1 overflow-x-auto border-b border-border px-1 pb-px [scrollbar-width:none]', className)}
    >
      {children}
    </div>
  )
}

export function Tab({ id, children, count }: { id: string; children: ReactNode; count?: number }) {
  const { value, set } = useContext(TabsCtx)
  const active = value === id
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      data-testid={`tab-${id}`}
      onClick={() => set(id)}
      className={cn(
        'relative whitespace-nowrap px-2.5 py-1.5 text-xs font-medium transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {count != null && <span className="num ml-1 text-[10px] text-muted-foreground">{count}</span>}
      {active && <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-bull" />}
    </button>
  )
}

export function TabPanel({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const { value } = useContext(TabsCtx)
  if (value !== id) return null
  return (
    <div role="tabpanel" className={className}>
      {children}
    </div>
  )
}

/* -------------------------------------------------------------- Progress --- */

export function Gauge({
  value,
  tone = 'bull',
  ticks = true,
  className,
  ...rest
}: { value: number; tone?: Tone; ticks?: boolean; className?: string } & { 'data-testid'?: string }) {
  const pct = Math.max(0, Math.min(100, value))
  const bar: Record<Tone, string> = {
    bull: 'bg-bull',
    bear: 'bg-bear',
    neutral: 'bg-muted-foreground',
    warning: 'bg-warning',
    veto: 'bg-veto',
    info: 'bg-info',
    plain: 'bg-foreground',
  }
  return (
    <div
      {...rest}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <div className={cn('h-full rounded-full transition-all duration-300', bar[tone])} style={{ width: `${pct}%` }} />
      {ticks && (
        <>
          {[25, 50, 75].map((t) => (
            <span key={t} className="absolute top-0 h-full w-px bg-background/70" style={{ left: `${t}%` }} />
          ))}
        </>
      )}
    </div>
  )
}

/** Signed -100..100 contribution bar, centred on zero. */
export function SignedBar({ value, className }: { value: number; className?: string }) {
  const v = Math.max(-100, Math.min(100, value))
  const w = Math.abs(v) / 2
  return (
    <div className={cn('relative h-1.5 w-full overflow-hidden rounded-sm bg-muted/60', className)}>
      <span className="absolute left-1/2 top-0 h-full w-px bg-border-strong" />
      <div
        className={cn('absolute top-0 h-full rounded-sm', v >= 0 ? 'bg-bull/80' : 'bg-bear/80')}
        style={v >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- Dialog --- */

export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg',
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: string
}) {
  const id = useId()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-[8vh]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={cn('w-full rounded-xl border border-border bg-card shadow-float', width)}
      >
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h3 id={id} className="text-sm font-medium">
            {title}
          </h3>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close" data-testid="dialog-close">
            <X className="h-3.5 w-3.5" />
          </Button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- helpers --- */

export function Row({
  label,
  value,
  hint,
  tone,
  className,
  mono = true,
}: {
  label: ReactNode
  value: ReactNode
  hint?: ReactNode
  tone?: 'bull' | 'bear' | 'neutral' | 'warning'
  className?: string
  mono?: boolean
}) {
  const toneClass =
    tone === 'bull'
      ? 'text-bull'
      : tone === 'bear'
        ? 'text-bear'
        : tone === 'warning'
          ? 'text-warning'
          : 'text-foreground'
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-[3px]', className)}>
      <span className="min-w-0 truncate text-[11px] text-muted-foreground">{label}</span>
      <span className={cn('shrink-0 text-right text-xs', mono && 'num', toneClass)}>
        {value}
        {hint && <span className="ml-1 text-[10px] text-muted-foreground">{hint}</span>}
      </span>
    </div>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-md', className)} />
}

export function EmptyState({
  icon,
  title,
  children,
  className,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-10 text-center', className)}>
      {icon && <div className="text-muted-foreground/60">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <p className="max-w-md text-xs leading-relaxed text-muted-foreground">{children}</p>}
    </div>
  )
}

export function ErrorNote({ message, className }: { message: string; className?: string }) {
  return (
    <div className={cn('rounded-md border border-bear/30 bg-bear/10 px-3 py-2 text-xs text-bear', className)}>
      {message}
    </div>
  )
}
