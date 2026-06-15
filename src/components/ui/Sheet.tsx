import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'

/**
 * The single mobile overlay grammar for the whole app — a slide-over (`right`)
 * or a bottom sheet (`bottom`) with one backdrop, one z-stack, and one
 * dismiss/inert contract. Generalized from the original appearance drawer so the
 * header menu, the appearance panel, and every studio control rail share it.
 *
 * Always `md:hidden`: desktop never mounts it (the inline columns take over).
 * `children` are rendered directly into the panel's flex column after the title
 * bar, so a body using the `flex-1 overflow-y-auto` + pinned-footer pattern (like
 * SidebarBody) scrolls correctly in both variants.
 */
export function Sheet({
  open,
  onClose,
  title,
  side = 'right',
  children,
  className = '',
}: {
  open: boolean
  onClose: () => void
  title: string
  side?: 'right' | 'bottom'
  children: ReactNode
  className?: string
}) {
  useBodyScrollLock(open)

  // Esc closes (harmless on touch; helps a11y + desktop testing).
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

  // Swipe-down-to-dismiss for the bottom sheet, armed only from the grab handle /
  // title bar so it never fights the scrollable body.
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

  // Portal to <body> so a transformed ancestor (e.g. a studio's animate-in-fade,
  // or a parent sheet's slide transform) can't become the containing block and
  // trap these fixed overlays inside its box.
  return createPortal(
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-ink/40 transition-opacity duration-300 md:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!open}
        inert={!open}
        className={`fixed z-50 flex flex-col border-line bg-surface shadow-xl transition-transform duration-300 ease-in-out md:hidden ${panelGeom} ${className}`}
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
          <button onClick={onClose} title="Close" aria-label="Close" className="btn btn-ghost h-9 w-9 px-0">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </>,
    document.body,
  )
}
