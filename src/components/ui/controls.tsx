import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { isValidHex, normalizeHex, SWATCHES } from '../../lib/colorUtils'

/* ------------------------------------------------------------------ Field */

export function Field({
  label,
  hint,
  right,
  children,
}: {
  label: string
  hint?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="field-label">{label}</span>
        {right}
      </div>
      {children}
      {hint && <p className="text-xs text-muted leading-snug">{hint}</p>}
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
          <button
            key={opt.value}
            type="button"
            title={opt.title}
            onClick={() => onChange(opt.value)}
            className={`flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[7px] px-2 text-xs font-medium transition-all ${
              active
                ? 'bg-surface text-ink shadow-xs'
                : 'text-muted hover:text-ink-2'
            }`}
          >
            {opt.label}
          </button>
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
          <button
            type="button"
            title="Transparent"
            onClick={() => onChange(transparent ? '#ffffff' : 'transparent')}
            className={`btn ${transparent ? 'btn-primary' : 'btn-secondary'} h-9 px-2.5`}
          >
            <span className="text-xs">∅</span>
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            onClick={() => onChange(c)}
            className={`h-5 w-5 rounded-md border transition-transform hover:scale-110 ${
              normalizeHex(value) === c ? 'border-accent ring-2 ring-accent-soft' : 'border-line'
            }`}
            style={{ backgroundColor: c }}
          />
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
