// Where a tooltip bubble goes. Pure geometry, no React and no DOM.
//
// It lives in its own .ts file rather than inside Tooltip.tsx because node runs
// TypeScript by stripping types — which handles .ts and NOT .tsx — so anything
// a test needs to reach has to be out here. Gated by test/tooltip-place.test.ts.

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
 * Where the bubble goes — FLIP along the main axis, clamp only across it.
 *
 * Clamping both axes produced the one placement a tooltip must never take. A
 * header icon sits ~8px from the top of the viewport, so the default `top` side
 * computed a negative y, the clamp pulled it back to the viewport edge, and the
 * bubble landed ON the button it was describing — hiding the thing you were
 * pointing at. Flipping to the other side is what a tooltip is supposed to do
 * when its preferred side has no room.
 *
 * The cross axis still clamps: sliding along the trigger keeps the bubble on
 * screen and still beside what it describes.
 *
 * Pure, so `test/tooltip-place.test.ts` can pin it without a DOM.
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
  // Only flip when the other side is actually better: on a viewport too small
  // for either, the preferred side keeps its placement rather than ping-ponging
  // to an equally bad one.
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

