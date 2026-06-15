import type { ReactNode } from 'react'

/**
 * Mobile-only chrome shared by the Cleanup & Vectorize studios so the two stay
 * visually consistent. Each studio composes its own controls into these shells;
 * the shells own the height, borders, safe-area, scroll behaviour, and the
 * `md:hidden` gate (desktop keeps its original h-12 toolbar + h-9 footer).
 */

/** Sticky strip under the header: view-mode + tool + undo/redo + zoom. Scrolls
 *  horizontally rather than wrapping, so it never forces page width. */
export function StudioTopBar({ children }: { children: ReactNode }) {
  return (
    <div className="no-scrollbar flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-2 md:hidden">
      {children}
    </div>
  )
}

/** In-flow bottom bar (so it never overlaps the canvas): primary action + the
 *  button(s) that open the control sheets. Clears the home indicator. */
export function StudioActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2 pb-safe md:hidden">
      {children}
    </div>
  )
}

/** ≥44px touch-target icon button used inside the bars. */
export function BarIconButton({
  title,
  onClick,
  disabled,
  active,
  children,
}: {
  title: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
        active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}
