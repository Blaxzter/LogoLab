// A right-click menu at a screen point: a portal, the keyboard, and closing on
// anything that moves the world under it.
//
// It is a SHORTCUT to commands that also live somewhere visible (a toolbar, a
// rail, a key), never their only home: a phone has no right button, and a
// command only a context menu offers is a command most people never find.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check } from './icons'
import { placeMenu } from './menuPlace'

export type MenuEntry =
  | {
      kind: 'item'
      id: string
      label: string
      /** Shown right-aligned, e.g. "Ctrl+D". */
      shortcut?: string
      /** Why it can't be used right now; null/absent when it can. Shown while the item is active. */
      reason?: string | null
      danger?: boolean
      /** A toggle's state: a check mark when on. */
      checked?: boolean
      onSelect: () => void
    }
  | { kind: 'sep' }

export function ContextMenu({
  at,
  entries,
  label,
  onClose,
}: {
  /** Viewport point the menu opens from. */
  at: { x: number; y: number }
  entries: MenuEntry[]
  /** Accessible name of the menu. */
  label: string
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(-1)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setPos(placeMenu(at.x, at.y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight))
  }, [at.x, at.y])

  // Focus moves into the menu, and back to wherever it was when the menu goes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const close = () => onCloseRef.current()
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('wheel', close, { passive: true })
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('wheel', close)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [])

  const enabled = (i: number) => {
    const e = entries[i]
    return e?.kind === 'item' && !e.reason
  }
  const selectable = (i: number) => entries[i]?.kind === 'item'

  const pick = (i: number) => {
    const e = entries[i]
    if (e?.kind !== 'item' || e.reason) return
    onClose()
    e.onSelect()
  }

  const step = (from: number, dir: 1 | -1) => {
    const n = entries.length
    for (let k = 1; k <= n; k++) {
      const i = (((from + dir * k) % n) + n) % n
      if (selectable(i)) return i
    }
    return from
  }

  // On the WINDOW, in the capture phase: focus is not reliably in the menu (a
  // right-click's own mouseup can move it), and the editor's shortcuts listen
  // on window too, so its Escape would clear the selection under the menu.
  // While the menu is open every key is the menu's.
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') setActive((a) => step(a, 1))
    else if (e.key === 'ArrowUp') setActive((a) => step(a < 0 ? 0 : a, -1))
    else if (e.key === 'Home') setActive(step(-1, 1))
    else if (e.key === 'End') setActive(step(0, -1))
    else if (e.key === 'Enter' || e.key === ' ') {
      if (enabled(active)) pick(active)
    } else if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'ContextMenu') onClose()
    else return
    e.preventDefault()
  }

  const keyRef = useRef(onKeyDown)
  keyRef.current = onKeyDown
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const current = entries[active]
  const reason = current?.kind === 'item' ? current.reason : null

  return createPortal(
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      aria-label={label}
      aria-activedescendant={active >= 0 ? `ctx-item-${active}` : undefined}
      onContextMenu={(e) => e.preventDefault()}
      className="animate-in-fade fixed z-[60] w-60 rounded-xl border border-line bg-surface p-1 shadow-lg outline-none"
      // Measured unplaced on the first frame, then shown where it fits.
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {entries.map((e, i) =>
        e.kind === 'sep' ? (
          <hr key={`sep-${i}`} className="mx-1 my-1 h-px border-0 bg-line" />
        ) : (
          <button
            key={e.id}
            id={`ctx-item-${i}`}
            type="button"
            {...(e.checked === undefined
              ? { role: 'menuitem' }
              : { role: 'menuitemcheckbox', 'aria-checked': e.checked })}
            aria-disabled={e.reason ? true : undefined}
            tabIndex={-1}
            onClick={() => pick(i)}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive((a) => (a === i ? -1 : a))}
            className={`flex h-7 w-full items-center gap-2 rounded-lg px-2 text-left text-xs transition-colors ${
              e.reason
                ? 'cursor-default text-faint'
                : e.danger
                  ? `text-bad ${i === active ? 'bg-bad/10' : ''}`
                  : `text-ink ${i === active ? 'bg-surface-3' : ''}`
            }`}
          >
            <span className="flex w-3.5 shrink-0 justify-center text-accent">{e.checked && <Check size={12} />}</span>
            <span className="min-w-0 flex-1 truncate">{e.label}</span>
            {e.shortcut && <span className="shrink-0 font-mono text-[0.65rem] text-faint">{e.shortcut}</span>}
          </button>
        ),
      )}
      {reason && (
        <p className="mx-1 mt-1 border-t border-line px-1 pt-1.5 pb-0.5 text-[0.65rem] leading-snug text-muted">
          {reason}
        </p>
      )}
    </div>,
    document.body,
  )
}
