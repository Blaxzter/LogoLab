// Primitive shape construction for the SVG editor's draw tools.
//
// Everything returns SubPath[] in absolute viewBox units — the editor has no
// "rect object" that later becomes a path, because a second representation is a
// second thing to keep in sync and the model is already cubic-only. A rectangle
// drawn here is a path from the moment it exists, so node editing, boolean-free
// path ops and export all work on it with no conversion step.

import type { SubPath, Vec } from '../path/types.ts'
import { ellipseSubPaths } from '../path/model.ts'

/** Circular-arc → cubic magic number: 4/3 · tan(π/8). */
const KAPPA = 0.5522847498

/** A corner/straight node with both handles collapsed. */
function corner(x: number, y: number): SubPath['nodes'][number] {
  return { x, y, hIn: null, hOut: null, kind: 'corner' }
}

/** A rectangle from two opposite corners, optionally round-cornered. */
export function rectShape(a: Vec, b: Vec, radius = 0): SubPath[] {
  const x0 = Math.min(a.x, b.x)
  const y0 = Math.min(a.y, b.y)
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return []

  // Clamp to half the short side, matching SVG's own rx/ry clamping — a radius
  // larger than that has no meaning and would fold the corners through itself.
  const r = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
  if (r === 0) {
    return [
      { nodes: [corner(x0, y0), corner(x1, y0), corner(x1, y1), corner(x0, y1)], closed: true },
    ]
  }

  const k = r * KAPPA
  // Two nodes per corner (arc start / arc end), the arc carried by the handles
  // between them; the straight runs between corners have null handles.
  const nodes: SubPath['nodes'] = [
    { x: x0 + r, y: y0, hIn: null, hOut: null, kind: 'corner' },
    { x: x1 - r, y: y0, hIn: null, hOut: { x: x1 - r + k, y: y0 }, kind: 'corner' },
    { x: x1, y: y0 + r, hIn: { x: x1, y: y0 + r - k }, hOut: null, kind: 'corner' },
    { x: x1, y: y1 - r, hIn: null, hOut: { x: x1, y: y1 - r + k }, kind: 'corner' },
    { x: x1 - r, y: y1, hIn: { x: x1 - r + k, y: y1 }, hOut: null, kind: 'corner' },
    { x: x0 + r, y: y1, hIn: null, hOut: { x: x0 + r - k, y: y1 }, kind: 'corner' },
    { x: x0, y: y1 - r, hIn: { x: x0, y: y1 - r + k }, hOut: null, kind: 'corner' },
    { x: x0, y: y0 + r, hIn: null, hOut: { x: x0, y: y0 + r - k }, kind: 'corner' },
  ]
  // Close the loop: the last node curves back into the first.
  nodes[0].hIn = { x: x0 + r - k, y: y0 }
  return [{ nodes, closed: true }]
}

/** An ellipse inscribed in the box spanned by two opposite corners. */
export function ellipseShape(a: Vec, b: Vec): SubPath[] {
  const cx = (a.x + b.x) / 2
  const cy = (a.y + b.y) / 2
  const rx = Math.abs(b.x - a.x) / 2
  const ry = Math.abs(b.y - a.y) / 2
  return ellipseSubPaths(cx, cy, rx, ry) ?? []
}

/** An open two-node line segment. */
export function lineShape(a: Vec, b: Vec): SubPath[] {
  if (a.x === b.x && a.y === b.y) return []
  return [{ nodes: [corner(a.x, a.y), corner(b.x, b.y)], closed: false }]
}

/**
 * A regular polygon inscribed in the box's larger inscribed circle.
 * `rotation` is in radians; 0 puts the first vertex straight up.
 */
export function polygonShape(center: Vec, radius: number, sides: number, rotation = 0): SubPath[] {
  const n = Math.max(3, Math.round(sides))
  if (radius <= 0) return []
  const nodes = Array.from({ length: n }, (_, i) => {
    const t = rotation - Math.PI / 2 + (i * 2 * Math.PI) / n
    return corner(center.x + radius * Math.cos(t), center.y + radius * Math.sin(t))
  })
  return [{ nodes, closed: true }]
}

/**
 * A star: `points` outer vertices alternating with inner ones at
 * `innerRatio` × the outer radius.
 */
export function starShape(
  center: Vec,
  radius: number,
  points: number,
  innerRatio = 0.5,
  rotation = 0,
): SubPath[] {
  const n = Math.max(3, Math.round(points))
  if (radius <= 0) return []
  const inner = radius * Math.max(0.02, Math.min(0.98, innerRatio))
  const nodes: SubPath['nodes'] = []
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? radius : inner
    const t = rotation - Math.PI / 2 + (i * Math.PI) / n
    nodes.push(corner(center.x + r * Math.cos(t), center.y + r * Math.sin(t)))
  }
  return [{ nodes, closed: true }]
}

/**
 * The radius a polygon/star drawn by dragging a box should use — the box's
 * inscribed circle, so the shape stays inside the rubber band the user drew.
 */
export function boxRadius(a: Vec, b: Vec): { center: Vec; radius: number } {
  return {
    center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    radius: Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 2,
  }
}
