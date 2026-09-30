import type { ReactNode } from 'react'
import { Tooltip } from '../ui/Tooltip'

/**
 * Chrome shared by the Cleanup, Vectorize and Icon sheet studios so the three
 * stay visually consistent. Each studio composes its own controls into these
 * shells; the shells own the height, borders, safe-area, scroll behaviour, and
 * the breakpoint. The compact bars show below `lg` and the desktop toolbar from
 * `lg` up — `useIsStudioCompact` is the same line in JS.
 */

/** Desktop toolbar strip. A size CONTAINER, so a studio collapses its labels
 *  with `@min-[…]:` variants on the width the canvas column actually has (the
 *  rails take a different share at every viewport). Nothing in it shrinks or
 *  wraps; if the icons-only form still does not fit it scrolls — with a visible
 *  scrollbar, since a mouse has no other way to find out — rather than pushing
 *  the page sideways or painting over the next column. */
export function StudioDesktopToolbar({ children }: { children: ReactNode }) {
  return (
    <div className="@container hidden h-12 shrink-0 items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b border-line bg-surface px-3 [scrollbar-width:thin] lg:flex @min-[48rem]:gap-2 [&>*]:shrink-0">
      {children}
    </div>
  )
}

/** Sticky strip under the header: view-mode + tool + undo/redo + zoom. Scrolls
 *  horizontally rather than wrapping, so it never forces page width. */
export function StudioTopBar({ children }: { children: ReactNode }) {
  return (
    <div className="@container no-scrollbar flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-line bg-surface px-2 lg:hidden">
      {children}
    </div>
  )
}

/** In-flow bottom bar (so it never overlaps the canvas): primary action + the
 *  button(s) that open the control sheets. Clears the home indicator. */
export function StudioActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-line bg-surface px-3 py-2 pb-safe lg:hidden">
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
    <Tooltip label={title}>
      <button
        type="button"
        aria-label={title}
        onClick={onClick}
        disabled={disabled}
        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
          active ? 'bg-accent-soft text-accent' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
        }`}
      >
        {children}
      </button>
    </Tooltip>
  )
}
