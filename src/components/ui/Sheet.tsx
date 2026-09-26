import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import { Tooltip } from './Tooltip'

/** Written out in full so Tailwind's scanner sees each class as a literal. */
const HIDE_FROM = { md: 'md:hidden', lg: 'lg:hidden', xl: 'xl:hidden' } as const

/**
 * The app's mobile overlay: a slide-over (`right`) or bottom sheet (`bottom`)
 * with a shared backdrop, z-stack and dismiss/inert behaviour. Used by the
 * header menu, the appearance panel and the studio control rails.
 *
 * `hideFrom` is the breakpoint where the sheet goes `display:none`. It must
 * match the breakpoint of whatever opens it; otherwise the trigger opens an
 * invisible sheet and the body stays scroll-locked.
 *
 * `children` go straight into the panel's flex column below the title bar, so a
 * `flex-1 overflow-y-auto` body with a pinned footer scrolls correctly.
 */

export function Sheet({
  open,
  onClose,
  title,
  side = 'right',
  hideFrom = 'md',
  children,
  className = '',
}: {
  open: boolean
  onClose: () => void
  title: string
  side?: 'right' | 'bottom'
  /** Breakpoint from which the inline desktop layout takes over. */
  hideFrom?: keyof typeof HIDE_FROM
  children: ReactNode
  className?: string
}) {
  const hidden = HIDE_FROM[hideFrom]
  useBodyScrollLock(open)

  // Escape closes.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const isBottom = side === 'bottom'
  const panelGeom = isBottom
    ? `inset-x-0 bottom-0 max-h-[85vh] w-full rounded-t-2xl border-t ${open ? 'translate-y-0' : 'translate-y-full'}`
    : `inset-y-0 right-0 h-full w-[min(20rem,86vw)] border-l ${open ? 'translate-x-0' : 'translate-x-full'}`

  // Swipe down to dismiss the bottom sheet, armed only from the handle and title
  // bar so it doesn't fight the scrollable body.
  const dragStart = useRef<number | null>(null)
  const dragHandlers = isBottom
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          dragStart.current = e.clientY
        },
        onPointerMove: (e: React.PointerEvent) => {
          if (dragStart.current != null && e.clientY - dragStart.current > 70) {
            dragStart.current = null
            onClose()
          }
        },
        onPointerUp: () => {
          dragStart.current = null
        },
      }
    : {}

  // Portal to <body> so a transformed ancestor can't become the containing block
  // for these fixed overlays.
  return createPortal(
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-ink/40 transition-opacity duration-300 dark:bg-black/55 ${hidden} ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
        className={`fixed z-50 flex flex-col border-line bg-surface shadow-xl transition-transform duration-300 ease-in-out ${hidden} ${panelGeom} ${className}`}
      >
        {isBottom && (
          <div {...dragHandlers} className="flex shrink-0 cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing">
            <span aria-hidden className="h-1 w-9 rounded-full bg-line-strong" />
          </div>
        )}
        <div
          {...(isBottom ? dragHandlers : {})}
          className={`flex h-12 shrink-0 items-center justify-between border-b border-line px-4 ${isBottom ? 'touch-none' : ''}`}
        >
          <span className="text-sm font-semibold text-ink">{title}</span>
          <Tooltip label="Close">
            <button type="button" onClick={onClose} aria-label="Close" className="btn btn-ghost h-9 w-9 px-0">
              <X size={18} />
            </button>
          </Tooltip>
        </div>
        {children}
      </div>
    </>,
    document.body,
  )
}
