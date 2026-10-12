// Where a context menu opens: its own .ts so a test can reach it (node strips types from .ts, not .tsx).

const MARGIN = 8

/**
 * Place a `w`×`h` menu opened at the pointer (`x`, `y`) in a `vw`×`vh` viewport.
 *
 * It opens down and to the right of the pointer, as every desktop menu does,
 * and FLIPS to the other side of the pointer on an axis where it would cross
 * the edge, so the corner it grows from stays on the point that was clicked.
 * Only a menu that fits on neither side is clamped (it then covers the point).
 */
export function placeMenu(x: number, y: number, w: number, h: number, vw: number, vh: number) {
  const axis = (p: number, size: number, view: number) => {
    if (p + size <= view - MARGIN) return p
    if (p - size >= MARGIN) return p - size
    return Math.max(MARGIN, Math.min(p, view - size - MARGIN))
  }
  return { left: axis(x, w, vw), top: axis(y, h, vh) }
}
