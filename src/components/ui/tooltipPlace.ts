// Tooltip placement: pure geometry, no React or DOM. Kept out of Tooltip.tsx
// because node's type stripping handles .ts but not .tsx, and
// test/tooltip-place.test.ts needs to import it.

/** Distance in px between the trigger and the bubble. */
export const GAP = 8

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'
type Side = TooltipSide

/** Just the part of a DOMRect that placement needs, so tests need no DOM. */
export interface TriggerRect {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/**
 * Flips along the main axis and clamps only across it. Don't clamp both axes:
 * for a trigger near the viewport edge, clamping the main axis pushes the
 * bubble back on top of the trigger it describes.
 */
export function placeTooltip(
  side: Side,
  r: TriggerRect,
  tw: number,
  th: number,
  vw: number,
  vh: number,
): { side: Side; left: number; top: number } {
  const fits = (s: Side): boolean => {
    switch (s) {
      case 'top':
        return r.top - GAP - th >= GAP
      case 'bottom':
        return r.bottom + GAP + th <= vh - GAP
      case 'left':
        return r.left - GAP - tw >= GAP
      default:
        return r.right + GAP + tw <= vw - GAP
    }
  }
  // Flip only if the opposite side fits; if neither does, keep the preferred side.
  const placed = fits(side) || !fits(OPPOSITE[side]) ? side : OPPOSITE[side]

  let left: number
  let top: number
  switch (placed) {
    case 'bottom':
      left = r.left + r.width / 2 - tw / 2
      top = r.bottom + GAP
      break
    case 'left':
      left = r.left - GAP - tw
      top = r.top + r.height / 2 - th / 2
      break
    case 'right':
      left = r.right + GAP
      top = r.top + r.height / 2 - th / 2
      break
    default:
      left = r.left + r.width / 2 - tw / 2
      top = r.top - GAP - th
  }

  if (placed === 'top' || placed === 'bottom') {
    left = Math.max(GAP, Math.min(left, vw - tw - GAP))
  } else {
    top = Math.max(GAP, Math.min(top, vh - th - GAP))
  }
  return { side: placed, left, top }
}
