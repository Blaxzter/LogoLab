// Cubic Bézier fitting for exact vector geometry — the editor's Simplify and
// Outline stroke both end here.
//
// This is Schneider's fit ("An Algorithm for Automatically Fitting Digitized
// Curves", Graphics Gems I): least-squares handle lengths along FIXED end
// tangents, Newton reparameterisation, split at the worst point. The tracer has
// its own fitter (`src/lib/trace/curveFit.ts`), but that one reads anti-aliased
// pixel boundaries — key vertices by Douglas–Peucker, corner evidence from
// windows of noisy points — and fits closed loops only. Points sampled off a
// path that already exists have no noise to doubt and tangents that are known,
// so the plain method is the right one here, and it fits open runs too.
//
// Pure: no DOM, no paper.js.

import type { PathNode, Vec } from '../path/types.ts'

/** One cubic segment by its four control points. */
export interface Cubic {
  p0: Vec
  c1: Vec
  c2: Vec
  p3: Vec
}

/* --------------------------------------------------------------- vectors */

export const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
export const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
export const mul = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k })
export const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
export const cross = (a: Vec, b: Vec): number => a.x * b.y - a.y * b.x
export const len = (a: Vec): number => Math.hypot(a.x, a.y)
export const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/** Unit vector, or null for a zero one. */
export function unit(a: Vec): Vec | null {
  const l = len(a)
  return l > 1e-12 ? { x: a.x / l, y: a.y / l } : null
}

/** Angle between two directions, in degrees (0 = same way). */
export function angleBetween(a: Vec, b: Vec): number {
  return (Math.atan2(Math.abs(cross(a, b)), dot(a, b)) * 180) / Math.PI
}

/* ---------------------------------------------------------------- cubics */

export function cubicPoint(c: Cubic, t: number): Vec {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * c.p0.x + b * c.c1.x + d * c.c2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.c1.y + d * c.c2.y + e * c.p3.y,
  }
}

/** First derivative. */
export function cubicD1(c: Cubic, t: number): Vec {
  const u = 1 - t
  const a = 3 * u * u
  const b = 6 * u * t
  const d = 3 * t * t
  return {
    x: a * (c.c1.x - c.p0.x) + b * (c.c2.x - c.c1.x) + d * (c.p3.x - c.c2.x),
    y: a * (c.c1.y - c.p0.y) + b * (c.c2.y - c.c1.y) + d * (c.p3.y - c.c2.y),
  }
}

/** Second derivative. */
export function cubicD2(c: Cubic, t: number): Vec {
  const u = 1 - t
  return {
    x: 6 * u * (c.c2.x - 2 * c.c1.x + c.p0.x) + 6 * t * (c.p3.x - 2 * c.c2.x + c.c1.x),
    y: 6 * u * (c.c2.y - 2 * c.c1.y + c.p0.y) + 6 * t * (c.p3.y - 2 * c.c2.y + c.c1.y),
  }
}

/**
 * The unit tangent at t. A collapsed handle zeroes the derivative at its end, so
 * the end tangents fall back to the next control point that differs (the
 * direction the curve actually leaves in).
 */
export function cubicTangent(c: Cubic, t: number): Vec | null {
  const d = unit(cubicD1(c, t))
  if (d) return d
  if (t <= 0.5) return unit(sub(c.c2, c.p0)) ?? unit(sub(c.p3, c.p0))
  return unit(sub(c.p3, c.c1)) ?? unit(sub(c.p3, c.p0))
}

/** De Casteljau split at t. */
export function splitCubic(c: Cubic, t: number): [Cubic, Cubic] {
  const lerp = (a: Vec, b: Vec): Vec => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  const ab = lerp(c.p0, c.c1)
  const bc = lerp(c.c1, c.c2)
  const cd = lerp(c.c2, c.p3)
  const abc = lerp(ab, bc)
  const bcd = lerp(bc, cd)
  const m = lerp(abc, bcd)
  return [
    { p0: c.p0, c1: ab, c2: abc, p3: m },
    { p0: m, c1: bcd, c2: cd, p3: c.p3 },
  ]
}

/** The piece of a cubic between t0 and t1. */
export function cubicRange(c: Cubic, t0: number, t1: number): Cubic {
  if (t0 <= 0 && t1 >= 1) return c
  const right = t0 > 0 ? splitCubic(c, t0)[1] : c
  if (t1 >= 1) return right
  return splitCubic(right, (t1 - t0) / (1 - t0))[0]
}

/** A cubic whose handles lie on its chord: it draws a straight line. */
export function isStraight(c: Cubic, eps = 1e-9): boolean {
  const ch = sub(c.p3, c.p0)
  const L = len(ch)
  if (L < eps) return dist(c.c1, c.p0) < eps && dist(c.c2, c.p3) < eps
  const off = (p: Vec) => Math.abs(cross(ch, sub(p, c.p0))) / L
  const along = (p: Vec) => dot(ch, sub(p, c.p0)) / (L * L)
  const inside = (p: Vec) => along(p) >= -1e-9 && along(p) <= 1 + 1e-9
  return off(c.c1) < eps && off(c.c2) < eps && inside(c.c1) && inside(c.c2)
}

/** A straight cubic from a to b (handles on the anchors, so it serializes as a line). */
export function lineCubic(a: Vec, b: Vec): Cubic {
  return { p0: a, c1: a, c2: b, p3: b }
}

/* ------------------------------------------------------------- fitting */

export interface CubicFit {
  cubic: Cubic
  /** Largest distance of a point from its place on the curve. */
  err: number
  /** Index (into the full point array) of the worst point. */
  at: number
}

const MAX_REPARAM = 8

/**
 * Fit ONE cubic to pts[from..to] (inclusive), its end points pinned and its
 * handles along the unit tangents t0 (leaving the start) and t1 (arriving at the
 * end, pointing forward). The error is measured from each point to its own
 * parameter on the curve — an upper bound of the true distance, so a fit that
 * passes it is never worse than claimed.
 */
export function fitCubic(pts: readonly Vec[], from: number, to: number, t0: Vec, t1: Vec): CubicFit {
  const p0 = pts[from]
  const p3 = pts[to]
  const span = dist(p0, p3)
  if (to - from < 2) {
    const k = span / 3
    const cubic = { p0, c1: add(p0, mul(t0, k)), c2: sub(p3, mul(t1, k)), p3 }
    return { cubic, err: 0, at: from }
  }
  let u = chordParams(pts, from, to)
  let best: CubicFit | null = null
  for (let iter = 0; iter <= MAX_REPARAM; iter++) {
    const cubic = generate(pts, from, to, u, t0, t1)
    const { err, at } = maxError(pts, from, to, cubic, u)
    if (!best || err < best.err) best = { cubic, err, at }
    if (err < 1e-9) break
    u = reparameterize(pts, from, to, cubic, u)
  }
  return best!
}

/** Chord-length parameters for pts[from..to], 0 → 1. */
function chordParams(pts: readonly Vec[], from: number, to: number): number[] {
  const u = [0]
  for (let i = from + 1; i <= to; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]))
  const total = u[u.length - 1]
  return total > 0 ? u.map((v) => v / total) : u.map((_, i) => i / (u.length - 1))
}

/** Least-squares handle lengths along the fixed tangents (Schneider's `GenerateBezier`). */
function generate(pts: readonly Vec[], from: number, to: number, u: number[], t0: Vec, t1: Vec): Cubic {
  const p0 = pts[from]
  const p3 = pts[to]
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < u.length; i++) {
    const t = u[i]
    const s = 1 - t
    const b0 = s * s * s
    const b1 = 3 * s * s * t
    const b2 = 3 * s * t * t
    const b3 = t * t * t
    const a0 = mul(t0, b1)
    const a1 = mul(t1, -b2)
    c00 += dot(a0, a0)
    c01 += dot(a0, a1)
    c11 += dot(a1, a1)
    const p = pts[from + i]
    const tmp = {
      x: p.x - (p0.x * (b0 + b1) + p3.x * (b2 + b3)),
      y: p.y - (p0.y * (b0 + b1) + p3.y * (b2 + b3)),
    }
    x0 += dot(a0, tmp)
    x1 += dot(a1, tmp)
  }
  const det = c00 * c11 - c01 * c01
  const span = dist(p0, p3)
  let a = 0
  let b = 0
  if (Math.abs(det) > 1e-12) {
    a = (x0 * c11 - x1 * c01) / det
    b = (c00 * x1 - c01 * x0) / det
  }
  // A non-positive or vanishing handle is the least-squares answer to points
  // the tangents can't reach; Schneider's fallback (a third of the chord) keeps
  // the curve sane and lets the split find a better place.
  const floor = span * 1e-6
  if (!(a > floor) || !(b > floor)) {
    a = span / 3
    b = span / 3
  }
  return { p0, c1: add(p0, mul(t0, a)), c2: add(p3, mul(t1, -b)), p3 }
}

function maxError(pts: readonly Vec[], from: number, to: number, c: Cubic, u: number[]): { err: number; at: number } {
  let err = 0
  let at = Math.floor((from + to) / 2)
  for (let i = 1; i < u.length - 1; i++) {
    const d = dist(cubicPoint(c, u[i]), pts[from + i])
    if (d > err) {
      err = d
      at = from + i
    }
  }
  return { err, at }
}

/** One Newton step per point toward its closest parameter on the curve. */
function reparameterize(pts: readonly Vec[], from: number, to: number, c: Cubic, u: number[]): number[] {
  const out = u.slice()
  for (let i = 1; i < u.length - 1; i++) {
    const t = u[i]
    const d = sub(cubicPoint(c, t), pts[from + i])
    const d1 = cubicD1(c, t)
    const d2 = cubicD2(c, t)
    const den = dot(d1, d1) + dot(d, d2)
    if (Math.abs(den) < 1e-12) continue
    out[i] = Math.min(1, Math.max(0, t - dot(d, d1) / den))
  }
  // Newton can swap two neighbours on a tight bend; parameters must stay ordered.
  for (let i = 1; i < out.length; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1]
  return out
}

/**
 * Fit pts[from..to] as a chain of cubics within `tol`, splitting at the worst
 * point. `tangentAt(i)` gives the forward tangent at a split point; without it
 * the tangent is read off the neighbouring points.
 */
export function fitCubics(
  pts: readonly Vec[],
  from: number,
  to: number,
  t0: Vec,
  t1: Vec,
  tol: number,
  tangentAt?: (i: number) => Vec | null,
): Cubic[] {
  const out: Cubic[] = []
  const rec = (a: number, b: number, ta: Vec, tb: Vec, depth: number) => {
    const fit = fitCubic(pts, a, b, ta, tb)
    if (fit.err <= tol || b - a < 2 || depth > 24) {
      out.push(fit.cubic)
      return
    }
    const m = Math.min(b - 1, Math.max(a + 1, fit.at))
    const tm = tangentAt?.(m) ?? unit(sub(pts[m + 1], pts[m - 1])) ?? ta
    rec(a, m, ta, tm, depth + 1)
    rec(m, b, tm, tb, depth + 1)
  }
  rec(from, to, t0, t1, 0)
  return out
}

/* ------------------------------------------------------------ to nodes */

const SMOOTH_DEG = 0.5

/**
 * A chain of cubics (each one's p3 the next one's p0) as path nodes. A
 * straight cubic gets null handles, so it stays a line in the document and in
 * the SVG. For a closed chain the last cubic ends on the first node.
 */
export function cubicsToNodes(cubics: readonly Cubic[], closed: boolean): PathNode[] {
  const n = cubics.length
  if (n === 0) return []
  const straight = cubics.map((c) => isStraight(c, 1e-9 * (1 + dist(c.p0, c.p3))))
  const nodes: PathNode[] = []
  const count = closed ? n : n + 1
  for (let i = 0; i < count; i++) {
    const outC = i < n ? cubics[i] : null
    const inIdx = i > 0 ? i - 1 : closed ? n - 1 : -1
    const inC = inIdx >= 0 ? cubics[inIdx] : null
    const at = outC ? outC.p0 : inC!.p3
    const hOut = outC && !straight[i] && dist(outC.c1, at) > 1e-12 ? { ...outC.c1 } : null
    const hIn = inC && !straight[inIdx] && dist(inC.c2, at) > 1e-12 ? { ...inC.c2 } : null
    let kind: PathNode['kind'] = 'corner'
    if (hIn && hOut) {
      const a = unit(sub(at, hIn))
      const b = unit(sub(hOut, at))
      if (a && b && angleBetween(a, b) < SMOOTH_DEG) kind = 'smooth'
    }
    nodes.push({ x: at.x, y: at.y, hIn, hOut, kind })
  }
  return nodes
}

/** The subpath's segments as cubics (null handles collapse onto the anchors). */
export function subPathCubics(nodes: readonly PathNode[], closed: boolean): Cubic[] {
  const out: Cubic[] = []
  const count = closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < count; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    const p0 = { x: a.x, y: a.y }
    const p3 = { x: b.x, y: b.y }
    out.push({ p0, c1: a.hOut ? { ...a.hOut } : p0, c2: b.hIn ? { ...b.hIn } : p3, p3 })
  }
  return out
}
