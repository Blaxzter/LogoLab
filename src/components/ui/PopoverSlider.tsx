import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Tooltip } from './Tooltip'

const POPOVER_W = 56
const POPOVER_H = 176

/**
 * A compact control that collapses a slider into a button; tapping it pops a
 * small vertical slider. Frees the horizontal space an inline slider would eat in
 * a tight toolbar / controls row. The popover is portaled to <body> with fixed
 * positioning so a `overflow-hidden` card or `overflow-x-auto` strip can't clip
 * it. Closes on outside tap, Esc, or scroll.
 */
export function PopoverSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  title,
  valueText,
  placement = 'top',
  className = '',
  children,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  title: string
  /** Optional readout shown above the slider (e.g. "60%"). */
  valueText?: string
  /** Which side of the trigger the popover opens toward. */
  placement?: 'top' | 'bottom'
  className?: string
  /** Trigger button content (icon and/or text). */
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    const left = Math.max(8, Math.min(b.left + b.width / 2 - POPOVER_W / 2, window.innerWidth - POPOVER_W - 8))
    const top = placement === 'top' ? b.top - POPOVER_H - 8 : b.bottom + 8
    setPos({ left, top })
  }, [open, placement])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    const close = () => setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  return (
    <>
      <Tooltip label={title}>
        <button
          ref={btnRef}
          type="button"
          aria-label={title}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`btn h-8 gap-1.5 px-2 text-xs ${open ? 'btn-primary' : 'btn-secondary'} ${className}`}
        >
          {children}
        </button>
      </Tooltip>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label={title}
            className="fixed z-[55] flex flex-col items-center rounded-xl border border-line bg-surface p-2.5 shadow-lg"
            style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
          >
            {valueText != null && (
              <span className="mb-1.5 font-mono text-[11px] tabular-nums text-ink-2">{valueText}</span>
            )}
            {/* The native range is laid out horizontally then absolutely centered
                and rotated to vertical — centering the box explicitly (rather than
                relying on grid alignment of an over-wide element) keeps the track
                and thumb dead-centre in the popover. `touch-none` is essential:
                without it a touch drag over the rotated slider reads as a vertical
                pan and the browser steals the gesture, so the thumb never moves on
                mobile (a tap can set the value, but dragging can't). */}
            <div className="relative h-32 w-9">
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                aria-label={title}
                className="absolute left-1/2 top-1/2 h-1.5 w-32 -translate-x-1/2 -translate-y-1/2 -rotate-90 cursor-pointer touch-none appearance-none rounded-full bg-line-strong"
              />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
