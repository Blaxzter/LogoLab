import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { ReactElement, ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Side = 'top' | 'bottom' | 'left' | 'right'

/** Distance in px between the trigger and the bubble. */
const GAP = 8

type TriggerProps = {
  ref?: unknown
  onMouseEnter?: (e: unknown) => void
  onMouseLeave?: (e: unknown) => void
  onFocus?: (e: unknown) => void
  onBlur?: (e: unknown) => void
  onPointerDown?: (e: unknown) => void
}

const compose =
  (theirs: ((e: unknown) => void) | undefined, ours: (e: unknown) => void) =>
  (e: unknown) => {
    theirs?.(e)
    ours(e)
  }

/**
 * A lightweight, theme-aware hover/focus tooltip — a nicer replacement for the
 * native `title` attribute. Wrap any single interactive element:
 *
 *     <Tooltip label="Undo"><button …/></Tooltip>
 *
 * It clones the child to attach hover/focus handlers and a ref (no extra DOM
 * node, so toolbar layout — `ml-auto`, `shrink-0`, flex gaps — is untouched),
 * then portals the bubble to <body> with fixed positioning so an
 * `overflow-hidden` card or `overflow-x-auto` strip can't clip it. Appears on
 * hover (after a short delay) and immediately on keyboard focus; dismisses on
 * leave/blur/click and on scroll/resize (where a fixed bubble would drift from
 * its trigger).
 *
 * Accessibility: the bubble is purely visual (`aria-hidden`) — it deliberately
 * does NOT touch the trigger's accessible name, so a text button keeps its
 * label and we never trip WCAG 2.5.3 ("Label in Name"). Give icon-only triggers
 * their own `aria-label` (the label string is the obvious value).
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

  // Measure once mounted, then clamp inside the viewport. useLayoutEffect runs
  // before paint, so the bubble appears already positioned (no (0,0) flash).
  useLayoutEffect(() => {
    if (!open) return
    const trigger = triggerRef.current
    const tip = tipRef.current
    if (!trigger || !tip) return
    const r = trigger.getBoundingClientRect()
    const tw = tip.offsetWidth
    const th = tip.offsetHeight
    let left: number
    let top: number
    switch (side) {
      case 'bottom':
        left = r.left + r.width / 2 - tw / 2
        top = r.bottom + GAP
        break
      case 'left':
        left = r.left - GAP - tw
        top = r.top + r.height / 2 - th / 2
        break
      case 'right':
        left = r.right + GAP
        top = r.top + r.height / 2 - th / 2
        break
      default:
        left = r.left + r.width / 2 - tw / 2
        top = r.top - GAP - th
    }
    left = Math.max(GAP, Math.min(left, window.innerWidth - tw - GAP))
    top = Math.max(GAP, Math.min(top, window.innerHeight - th - GAP))
    setCoords({ left, top })
  }, [open, side, label])

  // A fixed bubble would float away from its trigger on scroll/resize — drop it.
  useEffect(() => {
    if (!open) return
    const dismiss = () => hide()
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
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

  // Nothing to label, or the child isn't a real element — pass it straight
  // through so the component is always safe to drop in.
  if (!isValidElement(children) || label == null || label === '') return children

  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    ref: setRef,
    onMouseEnter: compose(cp.onMouseEnter, () => show()),
    onMouseLeave: compose(cp.onMouseLeave, () => hide()),
    onFocus: compose(cp.onFocus, () => show(true)),
    onBlur: compose(cp.onBlur, () => hide()),
    onPointerDown: compose(cp.onPointerDown, () => hide()),
  } as Record<string, unknown>)

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
