import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bug, ExternalLink } from 'lucide-react'
import { LAB_VIEWS } from './navItems'

const POPOVER_W = 320

/**
 * Header entry to the vectorizer's dev harnesses (see {@link LAB_VIEWS}). They're
 * standalone HTML entries rather than React routes, so every item is a plain link
 * opened in a new tab — the studio keeps its state while you go poke at a trace.
 * Positioning/dismissal mirror {@link SupportPopover}: portaled to <body> with
 * fixed coords so the header's stacking can't clip it, closing on outside tap,
 * Esc, scroll and resize.
 */
export function LabPopover() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    const left = Math.max(8, Math.min(b.right - POPOVER_W, window.innerWidth - POPOVER_W - 8))
    setPos({ left, top: b.bottom + 8 })
  }, [open])

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
      <button
        ref={btnRef}
        type="button"
        aria-label="Dev views"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-3 ${
          open ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:text-ink'
        }`}
      >
        <Bug size={18} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Dev views"
            className="fixed z-[55] rounded-xl border border-line bg-surface p-2 shadow-lg"
            style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
          >
            <div className="px-2 pb-1.5 pt-1">
              <div className="text-sm font-semibold text-ink">Under the hood</div>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                The harnesses the vectorizer is built and tested against. Each opens in a new tab.
              </p>
            </div>
            <div className="flex flex-col">
              {LAB_VIEWS.map((v) => (
                <a
                  key={v.href}
                  href={v.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setOpen(false)}
                  className="group flex gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-surface-3"
                >
                  <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center text-muted group-hover:text-accent">
                    {v.icon}
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1 text-[0.8rem] font-medium text-ink">
                      {v.label}
                      <ExternalLink size={11} className="text-faint" />
                    </span>
                    <span className="mt-0.5 block text-[0.7rem] leading-snug text-muted">
                      {v.blurb}
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
