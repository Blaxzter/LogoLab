// A number input you can SCRUB: drag its label sideways, roll the wheel over
// it, or press ↑/↓ — as in Affinity, Figma and Blender. Typing still works.
//
// Shift moves 10 steps at a time, Alt a tenth of one. A drag or a wheel burst
// reports every value with `live = true` and nothing more at the end, so the
// caller can fold the whole gesture into ONE undo step (the editor's
// `commitLive`); a typed value or an arrow key reports `live = false`.
//
// The wheel only takes over when the pointer has been resting on the field
// (`useWheelStep`, shared with the sliders): a panel scrolled past a field keeps
// scrolling.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TipLabel, Tooltip } from './Tooltip'
import { decimalsOf, stepFactor as factor, stepped, useWheelStep } from './useWheelStep'

/** Pointer travel before a press on the label counts as a scrub, not a click. */
const SCRUB_THRESHOLD_PX = 3

export interface NumberFieldProps {
  label: ReactNode
  /** Tooltip title for the input; defaults to the label when it is a string. */
  name?: string
  value: number
  /** `live` is true for every value of a drag or wheel burst. */
  onCommit: (v: number, live: boolean) => void
  min?: number
  max?: number
  /** One arrow press / one pixel of drag / one wheel notch. */
  step?: number
  tip: string
  /** Width class of the label column. */
  labelClass?: string
}

export function NumberField({
  label,
  name,
  value,
  onCommit,
  min,
  max,
  step = 1,
  tip,
  labelClass = 'w-8',
}: NumberFieldProps) {
  const shown = String(Number(value.toFixed(Math.max(2, decimalsOf(step)))))
  const [draft, setDraft] = useState(shown)
  const [scrubbing, setScrubbing] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  // The latest props for the native wheel listener, which is bound once.
  const live = useRef({ value, onCommit, min, max, step })
  live.current = { value, onCommit, min, max, step }

  useEffect(() => setDraft(shown), [shown])

  const rootRef = useWheelStep<HTMLLabelElement>({
    value,
    step,
    min,
    max,
    onChange: (v) => {
      setDraft(String(v))
      onCommit(v, true)
    },
  })

  /* ---- typing ---- */
  const commitDraft = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max)) {
      if (n !== value) onCommit(n, false)
    } else setDraft(shown)
  }

  /* ---- dragging the label ---- */
  const onLabelDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startValue = value
    let active = false
    let last = value
    const el = e.currentTarget as HTMLElement
    const id = e.pointerId
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!active) {
        if (Math.abs(dx) < SCRUB_THRESHOLD_PX) return
        active = true
        setScrubbing(true)
        try {
          el.setPointerCapture(id)
        } catch {
          /* capture unavailable */
        }
        inputRef.current?.blur()
      }
      const unit = live.current.step * factor(ev)
      const next = stepped(startValue, Math.round(dx), unit, live.current.min, live.current.max)
      if (next !== last) {
        last = next
        setDraft(String(next))
        live.current.onCommit(next, true)
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (active) setScrubbing(false)
      // A click without a drag is a click on the label: focus the input.
      else inputRef.current?.focus()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    e.preventDefault()
  }

  const title = name ?? (typeof label === 'string' ? label : '')

  return (
    <label ref={rootRef} className="flex items-center gap-1.5">
      <span
        onPointerDown={onLabelDown}
        className={`${labelClass} shrink-0 cursor-ew-resize select-none text-[0.7rem] ${
          scrubbing ? 'text-accent' : 'text-muted hover:text-ink'
        }`}
      >
        {label}
      </span>
      <Tooltip
        label={scrubbing ? '' : <TipLabel title={title} detail={`${tip} Drag the label or scroll to adjust.`} />}
      >
        <input
          ref={inputRef}
          value={draft}
          inputMode="decimal"
          aria-label={title}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              setDraft(shown)
              e.currentTarget.blur()
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
              e.preventDefault()
              const base = Number(draft)
              const next = stepped(
                Number.isFinite(base) ? base : value,
                e.key === 'ArrowUp' ? 1 : -1,
                step * factor(e),
                min,
                max,
              )
              setDraft(String(next))
              onCommit(next, false)
            }
            e.stopPropagation()
          }}
          className="input h-8 min-w-0 flex-1 text-xs tabular-nums"
        />
      </Tooltip>
    </label>
  )
}
