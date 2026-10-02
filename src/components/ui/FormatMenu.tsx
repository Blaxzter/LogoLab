// The download-format picker: a button that opens SVG / AI / DXF. Studios put
// it beside their one-click "Download SVG" as a caret, or (on a phone bar with
// no room for two) as the download button itself.

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Tooltip } from './Tooltip'
import { VECTOR_FORMATS, type VectorFormat } from '../../lib/export/vectorFormats'

const MENU_W = 264

export function FormatMenu({
  label,
  onPick,
  disabled,
  className,
  footnote,
  children,
}: {
  /** Tooltip and accessible name of the trigger. */
  label: string
  onPick: (format: VectorFormat) => void
  disabled?: boolean
  className?: string
  /** A line under the formats — what one of them will leave out. */
  footnote?: string | null
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [cursor, setCursor] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const b = triggerRef.current?.getBoundingClientRect()
    if (!b) return
    setPos({
      left: Math.max(8, Math.min(b.right - MENU_W, window.innerWidth - MENU_W - 8)),
      top: b.bottom + 6,
    })
    setCursor(0)
    menuRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false)
    }
    const close = () => setOpen(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const pick = (format: VectorFormat) => {
    setOpen(false)
    triggerRef.current?.focus()
    onPick(format)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = VECTOR_FORMATS.length
    if (e.key === 'ArrowDown') setCursor((c) => (c + 1) % n)
    else if (e.key === 'ArrowUp') setCursor((c) => (c - 1 + n) % n)
    else if (e.key === 'Home') setCursor(0)
    else if (e.key === 'End') setCursor(n - 1)
    else if (e.key === 'Enter' || e.key === ' ') pick(VECTOR_FORMATS[cursor].id)
    else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false)
      if (e.key === 'Escape') triggerRef.current?.focus()
      if (e.key === 'Tab') return
    } else return
    e.preventDefault()
  }

  return (
    <>
      {/* An empty label while open, so the bubble can't sit over the menu it opened. */}
      <Tooltip label={open ? '' : label} side="bottom">
        <button
          ref={triggerRef}
          type="button"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={className}
        >
          {children}
        </button>
      </Tooltip>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            aria-label="Download format"
            aria-activedescendant={`format-${VECTOR_FORMATS[cursor].id}`}
            onKeyDown={onKeyDown}
            className="fixed z-[55] rounded-xl border border-line bg-surface p-1 shadow-lg outline-none"
            style={{ left: pos.left, top: pos.top, width: MENU_W }}
          >
            {VECTOR_FORMATS.map((f, i) => (
              <button
                key={f.id}
                id={`format-${f.id}`}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => pick(f.id)}
                onPointerEnter={() => setCursor(i)}
                className={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs text-ink transition-colors ${
                  i === cursor ? 'bg-surface-3' : ''
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block">{f.label}</span>
                  <span className="block text-[0.65rem] leading-tight text-faint">{f.note}</span>
                </span>
                <span className="shrink-0 self-start rounded border border-line px-1 font-mono text-[0.65rem] text-faint">
                  .{f.ext}
                </span>
              </button>
            ))}
            {footnote && (
              <p className="border-t border-line px-2 pt-1.5 pb-1 text-[0.65rem] leading-tight text-faint">
                {footnote}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}
