// Mouse-wheel stepping for a value control (number fields, sliders): one notch
// is one step, Shift ten, Alt a tenth.
//
// A wheel only takes over once the pointer is RESTING on the control. A panel
// being scrolled past a control keeps scrolling — otherwise every field and
// slider in a rail would snag the wheel on the way down. That is decided by
// `lastForeignWheel`: when the last wheel event went to anything else less than
// SCROLL_LATCH_MS ago, this one is a scroll and is left alone.
//
// The listener is native: React's wheel handler is passive and can't stop the
// page scrolling.

import { useEffect, useRef } from 'react'

const MARK = 'data-wheel-step'
/** A scroll that started elsewhere within this long keeps scrolling. */
const SCROLL_LATCH_MS = 450

let lastForeignWheel = 0
let watching = false
function watchWheel() {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener(
    'wheel',
    (e) => {
      if (!(e.target instanceof Element) || !e.target.closest(`[${MARK}]`)) lastForeignWheel = Date.now()
    },
    { capture: true, passive: true },
  )
}

/** Shift: ten steps; Alt: a tenth of one. */
export const stepFactor = (e: { shiftKey: boolean; altKey: boolean }) => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1)

export function decimalsOf(step: number): number {
  if (step >= 1) return 0
  return Math.min(6, Math.ceil(-Math.log10(step) - 1e-9))
}

/** `from` moved by `n` steps of size `unit`, clamped, with float noise trimmed. */
export function stepped(from: number, n: number, unit: number, min?: number, max?: number): number {
  const v = Number((from + n * unit).toFixed(decimalsOf(unit) + 1))
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v))
}

export interface WheelStepOptions {
  value: number
  step: number
  min?: number
  max?: number
  /** Every value of a wheel burst — callers treat it as a live (merged) edit. */
  onChange: (v: number) => void
}

/** Attach the returned ref to the element the wheel should work over. */
export function useWheelStep<T extends HTMLElement>(opts: WheelStepOptions) {
  const ref = useRef<T | null>(null)
  const latest = useRef(opts)
  latest.current = opts

  useEffect(() => {
    watchWheel()
    const el = ref.current
    if (!el) return
    el.setAttribute(MARK, '')
    // Fast notches outrun the re-render that would bring the new `value`, so a
    // burst steps from its own running value.
    let burst: { value: number; timer: number } | null = null
    const onWheel = (e: WheelEvent) => {
      if (Date.now() - lastForeignWheel < SCROLL_LATCH_MS) return
      const dir = Math.sign(e.deltaY || e.deltaX)
      if (!dir) return
      e.preventDefault()
      const { value, step, min, max, onChange } = latest.current
      const from = burst ? burst.value : value
      const next = stepped(from, -dir, step * stepFactor(e), min, max)
      if (burst) clearTimeout(burst.timer)
      burst = { value: next, timer: window.setTimeout(() => (burst = null), 500) }
      if (next !== from) onChange(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      if (burst) clearTimeout(burst.timer)
    }
  }, [])

  return ref
}
