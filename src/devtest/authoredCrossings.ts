// AUTHORED CROSSINGS — the answer sheet for the §10.4 junction re-seat (issue #39).
//
// A re-seat junction is a degree-3 vertex where two AUTHORED boundaries cross (one shape's
// outline over another's). The tracer's job at that vertex is to land on the crossing point,
// and the crossing point is computable from the SVG alone: flatten every authored outline
// (svgGround gives the shapes, in artwork px after `toRasterSpace`) and intersect the
// polylines of different subpaths. Each crossing also records what the two boundaries ARE
// there — a straight segment or a curve, with the curve's local radius from the cubic's own
// curvature — and the angle they cross at, so an arm verdict ("this boundary is a circle of
// radius 157") can be checked against the art rather than against another raster.
//
// Occlusion is not modelled: a crossing hidden under a later-painted shape is still listed,
// and simply never gets matched by a traced junction. What matters is the other direction —
// every visible crossing IS in the list, because a visible crossing is an intersection of
// two authored outlines whatever was painted over the rest of them.

import { segmentCount, segmentControls } from '../lib/path/geometry.ts'
import type { Vec } from '../lib/path/types.ts'
import type { GroundShape } from './svgGround.ts'

/** Chord-flatness tolerance (px) — an order below anything the census scores. */
const FLATNESS = 0.02
/** Spatial-hash cell (px). */
const CELL = 8
/** A polyline vertex this close to another subpath's segment is a touching crossing (an
 *  authored corner placed ON another outline — a T, not an X). */
const TOUCH = 0.15
/** Crossings closer than this are one point (adjacent flattened pieces both hit it). */
const DEDUPE = 0.5

export interface BoundaryAt {
  shape: number
  sub: number
  seg: number
  kind: 'line' | 'curve'
  /** Local radius of curvature (px); Infinity for a line. */
  r: number
  /** Unit tangent at the crossing. */
  t: Vec
}

export interface Crossing {
  x: number
  y: number
  a: BoundaryAt
  b: BoundaryAt
  /** Crossing angle between the two tangents, in (0, 90]. */
  angleDeg: number
}

interface Piece {
  a: Vec
  b: Vec
  shape: number
  sub: number
  seg: number
  kind: 'line' | 'curve'
  t0: number
  t1: number
  /** Effective cubic controls of the authored segment this piece came from. */
  ctl: { p0: Vec; c1: Vec; c2: Vec; p3: Vec }
}

/** Flatten one cubic (with parameter tracking) to FLATNESS. */
function flattenCubic(ctl: Piece['ctl'], p0: Vec, c1: Vec, c2: Vec, p3: Vec, t0: number, t1: number, base: Omit<Piece, 'a' | 'b' | 't0' | 't1' | 'ctl'>, out: Piece[], depth = 0): void {
  const dx = p3.x - p0.x
  const dy = p3.y - p0.y
  const d1 = Math.abs((c1.x - p3.x) * dy - (c1.y - p3.y) * dx)
  const d2 = Math.abs((c2.x - p3.x) * dy - (c2.y - p3.y) * dx)
  const dd = (d1 + d2) ** 2
  if (depth >= 18 || dd < FLATNESS * FLATNESS * (dx * dx + dy * dy)) {
    out.push({ ...base, a: p0, b: p3, t0, t1, ctl })
    return
  }
  const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const p01 = mid(p0, c1)
  const p12 = mid(c1, c2)
  const p23 = mid(c2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const m = mid(p012, p123)
  const tm = (t0 + t1) / 2
  flattenCubic(ctl, p0, p01, p012, m, t0, tm, base, out, depth + 1)
  flattenCubic(ctl, m, p123, p23, p3, tm, t1, base, out, depth + 1)
}

/** Every authored segment of every subpath as flattened pieces. */
function pieces(shapes: GroundShape[]): Piece[] {
  const out: Piece[] = []
  shapes.forEach((sh, shape) => {
    sh.subPaths.forEach((sp, sub) => {
      const n = segmentCount(sp)
      for (let seg = 0; seg < n; seg++) {
        const ctl = segmentControls(sp, seg)
        const a = sp.nodes[seg]
        const b = sp.nodes[(seg + 1) % sp.nodes.length]
        const straight = !a.hOut && !b.hIn
        const base = { shape, sub, seg, kind: straight ? ('line' as const) : ('curve' as const) }
        if (straight) out.push({ ...base, a: ctl.p0, b: ctl.p3, t0: 0, t1: 1, ctl })
        else flattenCubic(ctl, ctl.p0, ctl.c1, ctl.c2, ctl.p3, 0, 1, base, out)
      }
    })
  })
  return out
}

/** Tangent (unit) and radius of curvature of the cubic at `t`. */
function cubicLocal(ctl: Piece['ctl'], t: number): { t: Vec; r: number } {
  const { p0, c1, c2, p3 } = ctl
  const u = 1 - t
  const dx = 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x)
  const dy = 3 * u * u * (c1.y - p0.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y)
  const ddx = 6 * u * (c2.x - 2 * c1.x + p0.x) + 6 * t * (p3.x - 2 * c2.x + c1.x)
  const ddy = 6 * u * (c2.y - 2 * c1.y + p0.y) + 6 * t * (p3.y - 2 * c2.y + c1.y)
  const l = Math.hypot(dx, dy)
  if (l < 1e-12) {
    const cx = p3.x - p0.x
    const cy = p3.y - p0.y
    const cl = Math.hypot(cx, cy) || 1
    return { t: { x: cx / cl, y: cy / cl }, r: Infinity }
  }
  const k = Math.abs(dx * ddy - dy * ddx) / (l * l * l)
  return { t: { x: dx / l, y: dy / l }, r: k < 1e-12 ? Infinity : 1 / k }
}

function boundaryAt(p: Piece, s: number): BoundaryAt {
  if (p.kind === 'line') {
    const dx = p.b.x - p.a.x
    const dy = p.b.y - p.a.y
    const l = Math.hypot(dx, dy) || 1
    return { shape: p.shape, sub: p.sub, seg: p.seg, kind: 'line', r: Infinity, t: { x: dx / l, y: dy / l } }
  }
  const loc = cubicLocal(p.ctl, p.t0 + (p.t1 - p.t0) * s)
  return { shape: p.shape, sub: p.sub, seg: p.seg, kind: 'curve', r: loc.r, t: loc.t }
}

const angleBetween = (a: Vec, b: Vec): number => {
  const c = Math.min(1, Math.abs(a.x * b.x + a.y * b.y))
  return (Math.acos(c) * 180) / Math.PI
}

/** Segment–segment intersection; returns the params (s on p, u on q) or null. */
function segX(p: Piece, q: Piece): { s: number; u: number } | null {
  const rx = p.b.x - p.a.x
  const ry = p.b.y - p.a.y
  const sx = q.b.x - q.a.x
  const sy = q.b.y - q.a.y
  const det = rx * sy - ry * sx
  if (Math.abs(det) < 1e-12) return null
  const qx = q.a.x - p.a.x
  const qy = q.a.y - p.a.y
  const s = (qx * sy - qy * sx) / det
  const u = (qx * ry - qy * rx) / det
  const e = 1e-9
  if (s < -e || s > 1 + e || u < -e || u > 1 + e) return null
  return { s, u }
}

/** Param of the point on segment `q` nearest `pt`, and the distance. */
function nearestOn(q: Piece, pt: Vec): { u: number; d: number } {
  const sx = q.b.x - q.a.x
  const sy = q.b.y - q.a.y
  const l2 = sx * sx + sy * sy
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((pt.x - q.a.x) * sx + (pt.y - q.a.y) * sy) / l2)) : 0
  return { u, d: Math.hypot(pt.x - (q.a.x + u * sx), pt.y - (q.a.y + u * sy)) }
}

/**
 * All crossings between DIFFERENT subpaths of the authored shapes (a subpath never crosses
 * itself here). Shapes are expected in the space the caller scores in — `toRasterSpace(gt,
 * 512)` for the census's artwork px.
 */
export function authoredCrossings(shapes: GroundShape[]): Crossing[] {
  const ps = pieces(shapes)
  const grid = new Map<string, number[]>()
  const key = (x: number, y: number): string => `${x},${y}`
  const cellsOf = (p: Piece): [number, number, number, number] => [
    Math.floor(Math.min(p.a.x, p.b.x) / CELL),
    Math.floor(Math.min(p.a.y, p.b.y) / CELL),
    Math.floor(Math.max(p.a.x, p.b.x) / CELL),
    Math.floor(Math.max(p.a.y, p.b.y) / CELL),
  ]
  ps.forEach((p, i) => {
    const [x0, y0, x1, y1] = cellsOf(p)
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        const k = key(cx, cy)
        let a = grid.get(k)
        if (!a) grid.set(k, (a = []))
        a.push(i)
      }
  })
  const sameSub = (p: Piece, q: Piece): boolean => p.shape === q.shape && p.sub === q.sub
  const found: Crossing[] = []
  const push = (x: number, y: number, p: Piece, s: number, q: Piece, u: number): void => {
    for (const c of found) if (Math.hypot(c.x - x, c.y - y) < DEDUPE) return
    const a = boundaryAt(p, s)
    const b = boundaryAt(q, u)
    found.push({ x, y, a, b, angleDeg: angleBetween(a.t, b.t) })
  }
  const seen = new Set<number>()
  ps.forEach((p, i) => {
    seen.clear()
    const [x0, y0, x1, y1] = cellsOf(p)
    for (let cx = x0; cx <= x1; cx++)
      for (let cy = y0; cy <= y1; cy++) {
        for (const j of grid.get(key(cx, cy)) ?? []) {
          if (j <= i || seen.has(j)) continue
          seen.add(j)
          const q = ps[j]
          if (sameSub(p, q)) continue
          const hit = segX(p, q)
          if (hit) {
            push(p.a.x + hit.s * (p.b.x - p.a.x), p.a.y + hit.s * (p.b.y - p.a.y), p, hit.s, q, hit.u)
            continue
          }
          // Touching: an endpoint of one piece on the other (an authored corner on an outline).
          for (const [pt, s] of [[p.a, 0], [p.b, 1]] as [Vec, number][]) {
            const n = nearestOn(q, pt)
            if (n.d <= TOUCH) push(pt.x, pt.y, p, s, q, n.u)
          }
          for (const [pt, u] of [[q.a, 0], [q.b, 1]] as [Vec, number][]) {
            const n = nearestOn(p, pt)
            if (n.d <= TOUCH) push(pt.x, pt.y, p, n.u, q, u)
          }
        }
      }
  })
  return found
}

/** The crossing nearest `p` within `radius`, or null. */
export function nearestCrossing(xs: Crossing[], p: Vec, radius: number): { c: Crossing; d: number } | null {
  let best: Crossing | null = null
  let bd = radius
  for (const c of xs) {
    const d = Math.hypot(c.x - p.x, c.y - p.y)
    if (d < bd) {
      bd = d
      best = c
    }
  }
  return best ? { c: best, d: bd } : null
}

/** Short label for what a boundary is at a crossing: `line`, `r=157`, `r=1.2e4`. */
export function boundaryLabel(b: BoundaryAt): string {
  if (b.kind === 'line' || !Number.isFinite(b.r)) return 'line'
  return b.r >= 1e4 ? `r=${b.r.toExponential(1)}` : `r=${b.r.toFixed(0)}`
}
