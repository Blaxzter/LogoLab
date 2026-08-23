// The toolbar's shape control: one split button that draws the last shape you
// picked, plus a caret that opens the rest.
//
// Five shape buttons sitting inline next to Move/Node/Pen made the bar read as
// one undifferentiated row — "what does this do to my selection?" — so the ones
// that CREATE geometry collapse behind a single trigger. The main half stays a
// one-click draw (a shape tool falls back to Move after each drag, so making
// every shape cost a menu trip would be worse than the flat row it replaces),
// and the letter keys still select any shape directly without opening anything.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { Tooltip } from '../ui/Tooltip'
import { SHAPE_TOOLS, isDrawTool, type EditorTool } from './tools'
import { TOOL_ICON } from './toolIcons'

const MENU_W = 190

export function ShapeFlyout({
  tool,
  onPick,
}: {
  /** The editor's active tool (a shape tool lights the control up). */
  tool: EditorTool
  onPick: (tool: EditorTool) => void
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [shown, setShown] = useState<EditorTool>('rect')
  const [cursor, setCursor] = useState(0)
  const wrapRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const isShape = isDrawTool(tool)
  const def = SHAPE_TOOLS.find((t) => t.id === shown) ?? SHAPE_TOOLS[0]

  const pick = (id: EditorTool) => {
    setShown(id)
    setOpen(false)
    onPick(id)
  }

  // The trigger shows whatever shape you reached for last — including one picked
  // by its letter key, which never touches this menu.
  useEffect(() => {
    if (isShape) setShown(tool)
  }, [isShape, tool])

  // Any tool change (a shortcut, a click elsewhere in the bar) dismisses the menu.
  useEffect(() => setOpen(false), [tool])

  useLayoutEffect(() => {
    if (!open) return
    const b = wrapRef.current?.getBoundingClientRect()
    if (!b) return
    setPos({
      left: Math.max(8, Math.min(b.left, window.innerWidth - MENU_W - 8)),
      top: b.bottom + 6,
    })
    setCursor(Math.max(0, SHAPE_TOOLS.findIndex((t) => t.id === shown)))
    menuRef.current?.focus()
  }, [open, shown])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (menuRef.current?.contains(t) || wrapRef.current?.contains(t)) return
      setOpen(false)
    }
    // Capture the keyboard while the menu is up: the studio listens on window
    // for bare letters and arrows, and menu navigation must not nudge the
    // selection out from under the drawing.
    const onKey = (e: KeyboardEvent) => {
      const k = e.key
      const stop = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (k === 'Escape') {
        stop()
        setOpen(false)
        return
      }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        stop()
        setCursor((i) => (i + (k === 'ArrowDown' ? 1 : SHAPE_TOOLS.length - 1)) % SHAPE_TOOLS.length)
        return
      }
      if (k === 'Home' || k === 'End') {
        stop()
        setCursor(k === 'Home' ? 0 : SHAPE_TOOLS.length - 1)
        return
      }
      if (k === 'Enter' || k === ' ') {
        stop()
        pick(SHAPE_TOOLS[cursor].id)
        return
      }
      const byLetter = SHAPE_TOOLS.find((t) => t.key === k.toLowerCase())
      if (byLetter && !e.ctrlKey && !e.metaKey && !e.altKey) {
        stop()
        pick(byLetter.id)
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
  }, [open, cursor])

  return (
    <>
      <div
        ref={wrapRef}
        className={`flex items-center rounded-md transition-colors ${
          isShape ? 'bg-surface text-accent shadow-xs' : 'text-ink-2'
        }`}
      >
        <Tooltip label={`${def.label} (${def.key.toUpperCase()}) — ${def.hint}`}>
          <button
            type="button"
            aria-label={def.label}
            aria-pressed={isShape}
            onClick={() => pick(def.id)}
            className="flex h-8 w-8 items-center justify-center rounded-l-md pl-0.5 transition-colors hover:text-ink"
          >
            {TOOL_ICON[def.id]}
          </button>
        </Tooltip>
        <Tooltip label="Shape tools">
          <button
            type="button"
            aria-label="Shape tools"
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            className="flex h-8 w-4 items-center justify-center rounded-r-md pr-0.5 transition-colors hover:text-ink"
          >
            <ChevronDown size={11} strokeWidth={2.5} />
          </button>
        </Tooltip>
      </div>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            tabIndex={-1}
            aria-label="Shape tools"
            aria-activedescendant={`shape-tool-${SHAPE_TOOLS[cursor].id}`}
            className="fixed z-[55] rounded-xl border border-line bg-surface p-1 shadow-lg outline-none"
            style={{ left: pos.left, top: pos.top, width: MENU_W }}
          >
            {SHAPE_TOOLS.map((t, i) => (
              <button
                key={t.id}
                id={`shape-tool-${t.id}`}
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => pick(t.id)}
                onPointerEnter={() => setCursor(i)}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
                  i === cursor ? 'bg-surface-3' : ''
                } ${tool === t.id ? 'text-accent' : 'text-ink'}`}
              >
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">{TOOL_ICON[t.id]}</span>
                <span className="flex-1">{t.label}</span>
                <kbd className="rounded border border-line px-1 text-[0.65rem] text-faint">
                  {t.key.toUpperCase()}
                </kbd>
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
