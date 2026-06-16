import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronDown, Info } from 'lucide-react'
import { isValidHex, normalizeHex, SWATCHES } from '../../lib/colorUtils'
import { Tooltip } from './Tooltip'

/* ------------------------------------------------------------------ Field */

export function Field({
  label,
  hint,
  right,
  onInfo,
  children,
}: {
  label: string
  hint?: string
  right?: ReactNode
  /** When set, renders an (i) button after the label that opens an info dialog. */
  onInfo?: () => void
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          <span className="field-label">{label}</span>
          {onInfo && (
            <Tooltip label={`What does ${label} do?`}>
              <button
                type="button"
                onClick={onInfo}
                aria-label={`What does ${label} do?`}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted transition-colors hover:text-accent"
              >
                <Info size={13} />
              </button>
            </Tooltip>
          )}
        </span>
        {right}
      </div>
      {children}
      {hint && <p className="text-xs text-muted leading-snug">{hint}</p>}
    </div>
  )
}

/* ------------------------------------------------------------- Collapsible */

/**
 * A titled disclosure section. Collapsed by default; when collapsed it can show
 * a one-line `summary` of the current values so the panel stays glanceable.
 */
export function Collapsible({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  title: string
  summary?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-surface-2"
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium text-ink">{title}</span>
          {summary && !open && (
            <span className="truncate text-[11px] text-muted">{summary}</span>
          )}
        </span>
        <ChevronDown
          size={16}
          className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="flex flex-col gap-5 border-t border-line px-3 py-4">{children}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ Slider */

export function Slider({
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  format,
}: {
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  onChange: (v: number) => void
  format?: (v: number) => string
}) {
  const display = format ? format(value) : `${value}${unit}`
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong"
      />
      <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-ink-2">
        {display}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ Toggle */

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="group flex items-center gap-2.5"
    >
      <span
        className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-accent' : 'bg-line-strong'
        }`}
      >
        <span
          className={`inline-block h-[18px] w-[18px] transform rounded-full bg-white shadow-sm transition-transform ${
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
          }`}
        />
      </span>
      {label && <span className="text-sm text-ink">{label}</span>}
    </button>
  )
}

/* -------------------------------------------------------- SegmentedControl */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-lg bg-surface-3 p-0.5">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <Tooltip key={opt.value} label={opt.title ?? ''}>
            <button
              type="button"
              onClick={() => onChange(opt.value)}
              className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[12px] px-2 text-xs font-medium transition-all ${
                active
                  ? 'bg-surface text-ink shadow-xs'
                  : 'text-muted hover:text-ink-2'
              }`}
            >
              {opt.label}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}

/* --------------------------------------------------------------- ColorField */

export function ColorField({
  value,
  onChange,
  allowTransparent = false,
}: {
  value: string
  onChange: (v: string) => void
  allowTransparent?: boolean
}) {
  const [text, setText] = useState(value)
  const transparent = value === 'transparent'

  useEffect(() => {
    setText(value)
  }, [value])

  const commit = (raw: string) => {
    const norm = normalizeHex(raw)
    if (norm) onChange(norm)
    else setText(value)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="relative h-9 w-9 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-line-strong shadow-xs">
          <span
            className={`block h-full w-full ${transparent ? 'checkerboard' : ''}`}
            style={transparent ? undefined : { backgroundColor: value }}
          />
          <input
            type="color"
            value={transparent ? '#ffffff' : (normalizeHex(value) ?? '#ffffff')}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label="Pick color"
          />
        </label>
        <input
          className="input font-mono text-xs"
          value={transparent ? 'transparent' : text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => commit(text)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          spellCheck={false}
        />
        {allowTransparent && (
          <Tooltip label="Transparent">
            <button
              type="button"
              aria-label="Transparent"
              onClick={() => onChange(transparent ? '#ffffff' : 'transparent')}
              className={`btn ${transparent ? 'btn-primary' : 'btn-secondary'} h-9 px-2.5`}
            >
              <span className="text-xs">∅</span>
            </button>
          </Tooltip>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {SWATCHES.map((c) => (
          <Tooltip key={c} label={c}>
            <button
              type="button"
              aria-label={c}
              onClick={() => onChange(c)}
              className={`h-5 w-5 rounded-md border transition-transform hover:scale-110 ${
                normalizeHex(value) === c ? 'border-accent ring-2 ring-accent-soft' : 'border-line'
              }`}
              style={{ backgroundColor: c }}
            />
          </Tooltip>
        ))}
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- TextField */

export function TextField({
  value,
  onChange,
  placeholder,
  maxLength,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  maxLength?: number
}) {
  return (
    <input
      className="input"
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/* small helper so callers can validate before committing custom hex */
export { isValidHex }

/* Tiny mount-once helper used by panels for entrance animation timing. */
export function useMounted() {
  const ref = useRef(false)
  useEffect(() => {
    ref.current = true
  }, [])
  return ref.current
}
