// A button that explains itself — including when you can't press it.

import type { ReactNode } from 'react'
import { TipLabel, Tooltip, type TooltipSide } from './Tooltip'

/** A control is unavailable exactly when it has a reason to be. */
export const isOff = (reason?: string | null): boolean => reason != null && reason !== ''

/**
 * Don't use `disabled` here: the browser drops pointer and focus events on a
 * disabled control, so its tooltip could never explain why it's unavailable.
 * An unavailable button uses `aria-disabled`, has no click handler, and stays
 * in the tab order.
 *
 * `reason` makes the button unavailable and should say what would make it
 * work; `note` is the second tooltip line when it is available.
 *
 * Tailwind's `disabled:` variants don't apply, so callers style the off state
 * themselves via `isOff(reason)`.
 */
export function ActionButton({
  label,
  reason,
  note,
  onClick,
  className,
  side,
  pressed,
  ariaLabel,
  children,
}: {
  /** Tooltip title. Keep it starting with any visible text on the button. */
  label: string
  /** Non-empty ⇒ unavailable. Say what would make it work. */
  reason?: string | null
  /** Second tooltip line when the button IS available. */
  note?: string | null
  onClick: () => void
  className?: string
  side?: TooltipSide
  /** For toggles — renders `aria-pressed`. */
  pressed?: boolean
  /** Accessible name, when it should differ from the tooltip title. */
  ariaLabel?: string
  children: ReactNode
}) {
  const off = isOff(reason)
  return (
    <Tooltip label={<TipLabel title={label} detail={off ? reason : note} />} side={side}>
      <button
        type="button"
        aria-label={ariaLabel ?? label}
        aria-disabled={off || undefined}
        aria-pressed={pressed}
        onClick={off ? undefined : onClick}
        className={className}
      >
        {children}
      </button>
    </Tooltip>
  )
}
