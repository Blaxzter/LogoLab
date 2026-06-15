import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Coffee, Heart } from 'lucide-react'
import { COFFEE_URL, SPONSOR_URL, GithubMark } from './navItems'

const POPOVER_W = 256

/**
 * The header's single "support" affordance: a heart icon that pops a small card
 * offering both ways to chip in — Buy Me a Coffee and GitHub Sponsors — so the
 * title bar carries one icon, not two. Portaled to <body> with fixed positioning
 * (so the header's own stacking/overflow can't clip it) and anchored below-right of
 * the trigger; closes on outside tap, Esc, scroll, resize — matching the
 * {@link PopoverSlider} conventions.
 */
export function SupportPopover() {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const b = btnRef.current?.getBoundingClientRect()
    if (!b) return
    // Right-align the card to the trigger, then clamp into the viewport so it
    // never spills past either edge on a narrow window.
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
        title="Support LogoLab"
        aria-label="Support LogoLab"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-3 ${
          open ? 'bg-surface-3 text-ink' : 'text-ink-2 hover:text-ink'
        }`}
      >
        <Coffee size={18} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="Support LogoLab"
            className="fixed z-[55] rounded-xl border border-line bg-surface p-4 shadow-lg"
            style={{ left: pos.left, top: pos.top, width: POPOVER_W }}
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Heart size={16} className="text-pink-500" />
              Enjoying LogoLab?
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              It's free and runs entirely in your browser. If it saved you some time, you can chip
              in — every bit keeps the project going.
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <a
                href={COFFEE_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className="btn btn-primary h-9 w-full gap-2 text-sm"
              >
                <Coffee size={16} />
                Buy me a coffee
              </a>
              <a
                href={SPONSOR_URL}
                target="_blank"
                rel="noreferrer"
                onClick={() => setOpen(false)}
                className="btn btn-secondary h-9 w-full gap-2 text-sm"
              >
                <GithubMark size={16} />
                Sponsor on GitHub
              </a>
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
