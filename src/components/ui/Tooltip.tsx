import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { placeTooltip, type TooltipSide } from './tooltipPlace'

export type { TooltipSide } from './tooltipPlace'
type Side = TooltipSide

type TriggerProps = {
  ref?: unknown
  onMouseEnter?: (e: unknown) => void
  onMouseLeave?: (e: unknown) => void
  onFocus?: (e: unknown) => void
  onBlur?: (e: unknown) => void
  onPointerDown?: (e: unknown) => void
}

const compose = (theirs: ((e: unknown) => void) | undefined, ours: (e: unknown) => void) => (e: unknown) => {
  theirs?.(e)
  ours(e)
}

/**
 * Hover/focus tooltip; the app's replacement for the native `title` attribute
 * (don't add `title` attributes back). Wrap a single interactive element:
 *
 *     <Tooltip label="Undo"><button …/></Tooltip>
 *
 * The child is cloned to attach handlers and a ref, so no wrapper node affects
 * layout. The bubble is portalled to <body> with fixed positioning so overflow
 * containers can't clip it. Placement flips rather than clamps (see
 * tooltipPlace.ts); header tooltips pass `side="bottom"`.
 *
 * The bubble is `aria-hidden` and leaves the trigger's accessible name alone,
 * so icon-only triggers need their own `aria-label`. An empty label renders the
 * child alone.
 */
export function Tooltip({
  label,
  side = 'top',
  delay = 300,
  children,
}: {
  label: ReactNode
  side?: Side
  /** ms before the bubble appears on hover (keyboard focus shows immediately). */
  delay?: number
  children: ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = () => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const show = useCallback(
    (immediate = false) => {
      clearTimer()
      if (immediate || delay <= 0) setOpen(true)
      else timer.current = setTimeout(() => setOpen(true), delay)
    },
    [delay],
  )

  const hide = useCallback(() => {
    clearTimer()
    setOpen(false)
    setCoords(null)
  }, [])

  useEffect(() => () => clearTimer(), [])

  // Layout effect so the bubble is positioned before paint (no flash at 0,0).
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const { left, top } = placeTooltip(
      side,
      trigger.getBoundingClientRect(),
      tip.offsetWidth,
      tip.offsetHeight,
      window.innerWidth,
      window.innerHeight,
    )
    setCoords({ left, top })
  }, [open, side, label])

  // A fixed bubble would drift from its trigger on scroll/resize, so dismiss it.
  // Window blur catches focus leaving without the trigger's own blur firing
  // (window deactivated, trigger unmounted under the pointer).
  useEffect(() => {
    if (!open) return
    const dismiss = () => hide()
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [open, hide])

  const cp: TriggerProps = isValidElement(children) ? (children.props as TriggerProps) : {}

  const setRef = useCallback(
    (node: HTMLElement | null) => {
      triggerRef.current = node
      const orig = cp.ref
      if (typeof orig === 'function') (orig as (n: HTMLElement | null) => void)(node)
      else if (orig && typeof orig === 'object') (orig as { current: unknown }).current = node
    },
    [cp.ref],
  )

  // Nothing to label, or not an element: render the child as-is.
  if (!isValidElement(children) || label == null || label === '') return children

  const trigger = cloneElement(
    children as ReactElement<Record<string, unknown>>,
    {
      ref: setRef,
      onMouseEnter: compose(cp.onMouseEnter, () => show()),
      onMouseLeave: compose(cp.onMouseLeave, () => hide()),
      onFocus: compose(cp.onFocus, () => show(true)),
      onBlur: compose(cp.onBlur, () => hide()),
      onPointerDown: compose(cp.onPointerDown, () => hide()),
    } as Record<string, unknown>,
  )

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            aria-hidden
            className="animate-in-fade pointer-events-none fixed z-[200] max-w-[15rem] rounded-md bg-ink px-2 py-1 text-[11px] font-medium leading-snug text-surface shadow-lg"
            style={{
              left: coords?.left ?? 0,
              top: coords?.top ?? 0,
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  )
}

/**
 * Two-part tooltip label: the control's name and a muted detail line (why it's
 * disabled, or what it will do).
 */
export function TipLabel({ title, detail }: { title: ReactNode; detail?: ReactNode }) {
  if (!detail) return <>{title}</>
  return (
    <>
      <span className="block font-semibold">{title}</span>
      <span className="mt-0.5 block font-normal opacity-70">{detail}</span>
    </>
  )
}
