// Applying an affine to a selection, and the transform-box handle math behind
// the eight drag handles + rotation.
//
// Transforms are BAKED, never accumulated as a `transform` attribute on the
// item (see the GroupItem doc comment for why): scaling a group rewrites its
// descendants' coordinates. The one exception is a RawItem, whose markup is
// opaque to us — there the affine composes onto its captured `transform`
// string, which is the only place in the model where a matrix survives.

import type {
  Affine,
  DocItem,
  GradientFill,
  PathItem,
  Stroke,
  SubPath,
  Vec,
} from '../path/types.ts'
import {
  affineScale,
  affineToString,
  applyAffine,
  composeAffine,
  parseTransformAttr,
  subPathsTightBounds,
  transformSubPaths,
} from '../path/geometry.ts'
import { isGroup } from '../path/docTree.ts'

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/* --------------------------------------------------------------- builders */

export function translation(dx: number, dy: number): Affine {
  return [1, 0, 0, 1, dx, dy]
}

/** Scale about a fixed point, so the anchor corner stays put during a drag. */
export function scaleAbout(origin: Vec, sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, origin.x - sx * origin.x, origin.y - sy * origin.y]
}

/** Rotate by `angle` radians about a point. */
export function rotateAbout(origin: Vec, angle: number): Affine {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [
    c,
    s,
    -s,
    c,
    origin.x - c * origin.x + s * origin.y,
    origin.y - s * origin.x - c * origin.y,
  ]
}

/** Mirror across the box's vertical (axis 'x') or horizontal ('y') midline. */
export function flipAbout(box: Box, axis: 'x' | 'y'): Affine {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return axis === 'x' ? scaleAbout({ x: cx, y: cy }, -1, 1) : scaleAbout({ x: cx, y: cy }, 1, -1)
}

/* ------------------------------------------------------------ application */

function transformGradient(g: GradientFill, m: Affine): GradientFill {
  if (g.type === 'linear') {
    const p1 = applyAffine(m, { x: g.x1, y: g.y1 })
    const p2 = applyAffine(m, { x: g.x2, y: g.y2 })
    return { ...g, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y }
  }
  const c = applyAffine(m, { x: g.cx, y: g.cy })
  const next: GradientFill = { ...g, cx: c.x, cy: c.y, r: g.r * affineScale(m) }
  if (g.fx !== undefined && g.fy !== undefined) {
    const f = applyAffine(m, { x: g.fx, y: g.fy })
    next.fx = f.x
    next.fy = f.y
  }
  return next
}

/**
 * The single factor an affine scales by, or null when the two axes disagree.
 * Shear counts as non-uniform, which `hypot` of each column captures.
 */
export function uniformScale(m: Affine): number | null {
  const sx = Math.hypot(m[0], m[1])
  const sy = Math.hypot(m[2], m[3])
  if (sx < 1e-9 || sy < 1e-9) return null
  return Math.abs(sx - sy) <= 1e-6 * Math.max(sx, sy) ? sx : null
}

/**
 * Scale a stroke's scalar lengths — but ONLY under a uniform scale.
 *
 * A stroke width is one number describing a distance in every direction, so a
 * squash simply has no correct answer: the outline should get thinner top-and-
 * bottom and stay put left-and-right, which one width cannot say. Picking
 * √|det| (the area-preserving compromise) meant dragging the top edge down to
 * flatten a shape ALSO silently thinned its outline — a number the user never
 * touched, changing by an amount they could not predict.
 *
 * So: follow a uniform scale, and leave the width alone otherwise. Scaling an
 * icon up still thickens its strokes as expected; squashing one keeps the
 * weight the designer chose.
 */
function transformStroke(s: Stroke, m: Affine): Stroke {
  const k = uniformScale(m)
  if (k === null || k === 1) return s
  const next: Stroke = { ...s, width: s.width * k }
  if (s.dash && s.dash.length > 0) next.dash = s.dash.map((d) => d * k)
  return next
}

/** Apply an affine to one item, recursing into groups. */
export function transformItem(item: DocItem, m: Affine): DocItem {
  if (isGroup(item)) {
    return { ...item, children: item.children.map((c) => transformItem(c, m)) }
  }
  if (item.kind === 'path') {
    const next: PathItem = { ...item, subPaths: transformSubPaths(item.subPaths, m) }
    if (item.gradient) next.gradient = transformGradient(item.gradient, m)
    if (item.stroke) next.stroke = transformStroke(item.stroke, m)
    // A transformed region no longer matches the shared-edge graph it came
    // from, so drop the planar link and let it live as an independent path.
    // Keeping `loops` would have the next rematerialize silently undo the move.
    delete next.loops
    return next
  }
  const composed = composeAffine(m, parseTransformAttr(item.transform))
  return { ...item, transform: affineToString(composed) }
}

/** Apply an affine to every listed id (and everything inside those groups). */
export function transformItems(
  items: readonly DocItem[],
  ids: ReadonlySet<string>,
  m: Affine,
): DocItem[] {
  return items.map((it) => {
    if (ids.has(it.id)) return transformItem(it, m)
    if (isGroup(it)) {
      const kids = transformItems(it.children, ids, m)
      return kids === it.children ? it : { ...it, children: kids }
    }
    return it
  })
}

/* ---------------------------------------------------------------- bounds */

/** Tight curve bounds of one item; null when it draws nothing measurable. */
export function itemBox(item: DocItem): Box | null {
  if (isGroup(item)) return unionBoxes(item.children.map(itemBox))
  if (item.kind === 'path') return subPathsTightBounds(item.subPaths)
  // A RawItem's geometry lives in markup we deliberately never parse, so it has
  // no measurable box. Callers treat it as unselectable-by-marquee rather than
  // guessing a box that would be wrong.
  return null
}

export function unionBoxes(boxes: readonly (Box | null)[]): Box | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    if (!b) continue
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Union box of a set of ids, resolved against the tree. */
export function selectionBox(items: readonly DocItem[], ids: ReadonlySet<string>): Box | null {
  const boxes: (Box | null)[] = []
  const walk = (list: readonly DocItem[]) => {
    for (const it of list) {
      if (ids.has(it.id)) boxes.push(itemBox(it))
      else if (isGroup(it)) walk(it.children)
    }
  }
  walk(items)
  return unionBoxes(boxes)
}

/* --------------------------------------------------------- transform box */

/** The eight scale grips, named by compass point. */
export type Grip = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export const GRIPS: Grip[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

/** Where a grip sits on a box. */
export function gripPoint(box: Box, grip: Grip): Vec {
  const midX = box.x + box.w / 2
  const midY = box.y + box.h / 2
  const right = box.x + box.w
  const bottom = box.y + box.h
  switch (grip) {
    case 'nw': return { x: box.x, y: box.y }
    case 'n': return { x: midX, y: box.y }
    case 'ne': return { x: right, y: box.y }
    case 'e': return { x: right, y: midY }
    case 'se': return { x: right, y: bottom }
    case 's': return { x: midX, y: bottom }
    case 'sw': return { x: box.x, y: bottom }
    case 'w': return { x: box.x, y: midY }
  }
}

/** The point a grip drag holds fixed — the opposite corner/edge. */
export function gripAnchor(box: Box, grip: Grip): Vec {
  const opposite: Record<Grip, Grip> = {
    nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e',
  }
  return gripPoint(box, opposite[grip])
}

export interface ScaleGripOptions {
  /** Lock the aspect ratio (Shift). */
  uniform?: boolean
  /** Scale about the box centre instead of the opposite grip (Alt). */
  fromCenter?: boolean
  /**
   * Smallest allowed absolute scale factor. Below this a drag would collapse
   * the geometry to a line it can never be recovered from, since the transform
   * is baked into coordinates rather than kept as an undoable matrix.
   */
  minScale?: number
}

/**
 * The affine for dragging `grip` from its home position to `to`.
 *
 * Edge grips scale one axis only; corner grips scale both. Dragging a grip past
 * its anchor produces a negative factor — a mirror — which is the behaviour
 * every vector editor has and costs nothing to allow here.
 */
export function scaleFromGrip(
  box: Box,
  grip: Grip,
  to: Vec,
  opts: ScaleGripOptions = {},
): Affine {
  const minScale = opts.minScale ?? 1e-3
  const origin = opts.fromCenter
    ? { x: box.x + box.w / 2, y: box.y + box.h / 2 }
    : gripAnchor(box, grip)
  const from = gripPoint(box, grip)

  const spanX = from.x - origin.x
  const spanY = from.y - origin.y
  const movesX = grip !== 'n' && grip !== 's'
  const movesY = grip !== 'e' && grip !== 'w'

  let sx = movesX && Math.abs(spanX) > 1e-9 ? (to.x - origin.x) / spanX : 1
  let sy = movesY && Math.abs(spanY) > 1e-9 ? (to.y - origin.y) / spanY : 1

  if (opts.uniform && movesX && movesY) {
    // Follow the axis the pointer pushed hardest, and carry its sign to the
    // other — otherwise a uniform drag through the anchor flips only one axis
    // and the shape shears instead of mirroring.
    const k = Math.max(Math.abs(sx), Math.abs(sy))
    sx = k * Math.sign(sx || 1)
    sy = k * Math.sign(sy || 1)
  }

  const clamp = (v: number) => (Math.abs(v) < minScale ? minScale * Math.sign(v || 1) : v)
  return scaleAbout(origin, clamp(sx), clamp(sy))
}

/** Angle of `p` about `origin`, in radians. */
export function angleOf(origin: Vec, p: Vec): number {
  return Math.atan2(p.y - origin.y, p.x - origin.x)
}

/** Snap an angle to the nearest `stepDeg` multiple (Shift while rotating). */
export function snapAngle(angle: number, stepDeg = 15): number {
  const step = (stepDeg * Math.PI) / 180
  return Math.round(angle / step) * step
}

/** Scale a doc's contents so its artwork fits a new viewBox size. */
export function fitScale(box: Box, target: Box, margin = 0): Affine {
  const availW = Math.max(1e-6, target.w - margin * 2)
  const availH = Math.max(1e-6, target.h - margin * 2)
  const k = Math.min(availW / Math.max(box.w, 1e-6), availH / Math.max(box.h, 1e-6))
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const tx = target.x + target.w / 2
  const ty = target.y + target.h / 2
  return composeAffine(translation(tx - cx * k, ty - cy * k), [k, 0, 0, k, 0, 0])
}

/** Convenience for tests / callers that want a plain point mapping. */
export function mapPoint(m: Affine, p: Vec): Vec {
  return applyAffine(m, p)
}

/** Re-exported so editor code has one import site for these primitives. */
export { transformSubPaths, affineScale }
export type { SubPath }
