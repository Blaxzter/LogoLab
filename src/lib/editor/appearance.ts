// The eyedropper's copy: one path's look onto another. Pure.
//
// What travels: the fill (solid, gradient or none), the fill opacity, and the
// whole stroke (colour, width, cap, join, miter limit, dash, opacity) — or its
// absence. What stays: the geometry and the fill RULE, which belongs to the
// shape's construction (which loops are holes), not to its paint.
//
// A gradient is placed in absolute coordinates, so copied as-is it would paint
// the target with the slice of the gradient that lies over the SOURCE. It is
// refitted instead: mapped from the source's box onto the target's, so the
// target shows the gradient the way the source does.

import type { DocItem, GradientFill, PathItem, Vec } from '../path/types.ts'
import { allPaths, isGroup } from '../path/docTree.ts'
import { itemHitBy } from './hitTest.ts'
import { itemBox, transformGradient, type Box } from './transform.ts'

/** Which part of the look to copy: everything, or the fill alone (Shift-click). */
export type AppearancePart = 'all' | 'fill'

/** The affine taking box `a` onto box `b`; a flat axis keeps its scale. */
function boxToBox(a: Box, b: Box): [number, number, number, number, number, number] {
  const sx = a.w > 1e-9 && b.w > 1e-9 ? b.w / a.w : 1
  const sy = a.h > 1e-9 && b.h > 1e-9 ? b.h / a.h : 1
  return [sx, 0, 0, sy, b.x - a.x * sx, b.y - a.y * sy]
}

/**
 * The path an eyedropper click on `item` at `p` samples. A path is itself; a
 * text (or any group the pick reported) gives the glyph run under the pointer,
 * front to back — a black-and-red text clicked on a red letter gives red —
 * and its first run when the click fell between the letters.
 */
export function sampledPath(item: DocItem, p: Vec, tol: number): PathItem | null {
  if (item.kind === 'path') return item
  if (!isGroup(item)) return null
  const runs = allPaths(item.children)
  for (let i = runs.length - 1; i >= 0; i--) if (itemHitBy(runs[i], p, tol)) return runs[i]
  return runs[0] ?? null
}

/**
 * `target` painted like `source`. Returns `target` itself when nothing would
 * change, so a click on a shape that already looks right costs no undo step.
 */
export function withAppearance(target: PathItem, source: PathItem, part: AppearancePart = 'all'): PathItem {
  if (target === source) return target
  const next: PathItem = { ...target, fill: source.fill }
  delete next.gradient
  if (source.gradient) {
    const from = itemBox(source)
    const to = itemBox(target)
    next.gradient = from && to ? transformGradient(source.gradient, boxToBox(from, to)) : cloneGradient(source)
    // The refit is float arithmetic: on a shape that already shows the source's
    // gradient (a moved copy) it lands a few ulps off the gradient the target
    // has, which is no change anyone can see and must not cost an undo step.
    const eps = 1e-6 * Math.max(to ? Math.max(to.w, to.h) : 0, 1)
    if (target.gradient && sameGradientPlaced(target.gradient, next.gradient, eps)) next.gradient = target.gradient
  }
  if (source.fillOpacity === undefined) delete next.fillOpacity
  else next.fillOpacity = source.fillOpacity
  if (part === 'all') {
    if (source.stroke) {
      next.stroke = { ...source.stroke }
      if (source.stroke.dash) next.stroke.dash = [...source.stroke.dash]
    } else delete next.stroke
  }
  return samePaintFields(target, next) ? target : next
}

/** Same kind, stops and placement, the placement to within `eps`. */
export function sameGradientPlaced(a: GradientFill, b: GradientFill, eps: number): boolean {
  if (a.type !== b.type || JSON.stringify(a.stops) !== JSON.stringify(b.stops)) return false
  const close = (x: number | undefined, y: number | undefined) =>
    x === undefined || y === undefined ? x === y : Math.abs(x - y) <= eps
  if (a.type === 'linear' && b.type === 'linear')
    return close(a.x1, b.x1) && close(a.y1, b.y1) && close(a.x2, b.x2) && close(a.y2, b.y2)
  if (a.type === 'radial' && b.type === 'radial')
    return close(a.cx, b.cx) && close(a.cy, b.cy) && close(a.r, b.r) && close(a.fx, b.fx) && close(a.fy, b.fy)
  return false
}

function cloneGradient(p: PathItem) {
  const g = p.gradient!
  return { ...g, stops: g.stops.map((s) => ({ ...s })) }
}

/** Whether the paint fields of two versions of one path agree (geometry is shared). */
function samePaintFields(a: PathItem, b: PathItem): boolean {
  return (
    a.fill === b.fill &&
    a.fillOpacity === b.fillOpacity &&
    JSON.stringify(a.gradient ?? null) === JSON.stringify(b.gradient ?? null) &&
    JSON.stringify(a.stroke ?? null) === JSON.stringify(b.stroke ?? null)
  )
}
