// A button that explains itself — including when you can't press it.

import type { ReactNode } from 'react'
import { TipLabel, Tooltip, type TooltipSide } from './Tooltip'

/** A control is unavailable exactly when it has a reason to be. */
export const isOff = (reason?: string | null): boolean => reason != null && reason !== ''

/**
 * `disabled` is deliberately NOT used here.
 *
 * The browser drops pointer and focus events on a disabled control, so a
 * tooltip attached to one never opens: the moment someone most wants an
 * explanation — "why is this greyed out?" — is exactly the moment the native
 * attribute guarantees silence. An unavailable button therefore stays live to
 * the DOM, reports its state with `aria-disabled` (what assistive tech reads),
 * and simply has no click wired up. It also stays in the tab order, so the
 * explanation is reachable from the keyboard rather than hover-only.
 *
 * `reason` is what makes a button unavailable, and it should say what WOULD
 * make it work, not merely that it doesn't. `note` is the same second line for
 * a button that IS available but whose behaviour is worth a sentence.
 *
 * Styling stays with the caller: each of these buttons is a different shape,
 * and Tailwind's `disabled:` variants no longer apply once the attribute is
 * gone, so the caller must dim and un-hover itself using `isOff(reason)`.
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
