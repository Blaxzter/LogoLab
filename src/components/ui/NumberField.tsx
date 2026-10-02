// A number input you can SCRUB: drag its label sideways, roll the wheel over
// it, or press ↑/↓ — as in Affinity, Figma and Blender. Typing still works.
//
// Shift moves 10 steps at a time, Alt a tenth of one. A drag or a wheel burst
// reports every value with `live = true` and nothing more at the end, so the
// caller can fold the whole gesture into ONE undo step (the editor's
// `commitLive`); a typed value or an arrow key reports `live = false`.
//
// The wheel only takes over when the pointer has been resting on the field: a
// panel being scrolled past a field keeps scrolling (`lastForeignWheel`), or
// every number in a rail would snag the scroll wheel on the way down.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { TipLabel, Tooltip } from './Tooltip'

/** Last time a wheel event went to something other than a number field. */
let lastForeignWheel = 0
let wheelWatch = false
function watchWheel() {
  if (wheelWatch || typeof window === 'undefined') return
  wheelWatch = true
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('[data-number-field]')) lastForeignWheel = Date.now()
    },
    { capture: true, passive: true },
  )
}
/** A scroll that started elsewhere within this long keeps scrolling. */
const SCROLL_LATCH_MS = 450
/** A wheel burst ends (and its undo step closes) after this much quiet. */
const WHEEL_IDLE_MS = 500
/** Pointer travel before a press on the label counts as a scrub, not a click. */
const SCRUB_THRESHOLD_PX = 3

function decimalsOf(step: number): number {
  if (step >= 1) return 0
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9))
}

/** Shift: ten steps; Alt: a tenth of one. */
const factor = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)

/** `from` moved by `n` steps of size `unit`, clamped, with float noise trimmed. */
function stepped(from: number, n: number, unit: number, min?: number, max?: number): number {
  const v = Number((from + n * unit).toFixed(decimalsOf(unit) + 1))
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
}

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
  const rootRef = useRef<HTMLLabelElement | null>(null)
  // The latest props for the native wheel listener, which is bound once.
  const live = useRef({ value, onCommit, min, max, step })
  live.current = { value, onCommit, min, max, step }

  useEffect(() => setDraft(shown), [shown])
  useEffect(watchWheel, [])

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

  /* ---- the wheel (native: React's is passive and can't stop the scroll) ---- */
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    let burst: { value: number; timer: number } | null = null
    const onWheel = (e: WheelEvent) => {
      if (Date.now() - lastForeignWheel < SCROLL_LATCH_MS) return
      const dir = Math.sign(e.deltaY || e.deltaX)
      if (!dir) return
      e.preventDefault()
      const from = burst ? burst.value : live.current.value
      const next = stepped(from, -dir, live.current.step * factor(e), live.current.min, live.current.max)
      if (burst) clearTimeout(burst.timer)
      burst = { value: next, timer: window.setTimeout(() => (burst = null), WHEEL_IDLE_MS) }
      if (next !== from) {
        setDraft(String(next))
        live.current.onCommit(next, true)
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (burst) clearTimeout(burst.timer)
    }
  }, [])

  const title = name ?? (typeof label === 'string' ? label : '')

  return (
    <label ref={rootRef} data-number-field className="flex items-center gap-1.5">
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
