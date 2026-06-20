// Shared primitive-fit math for BOTH beautifiers — the loop-level `beautify.ts`
// (crisp / potrace) and the edge-level `planarBeautify.ts` (planar). Extracted
// VERBATIM from beautify.ts so the two engines share ONE circle/ellipse fit,
// kappa-Bézier emit, single-linkage clustering, and concentric / equal-radius
// relation solver — there is no forked copy that can drift.
//
// Everything here is pure and deterministic (fixed sample/scan orders, no PRNG /
// Date), so it runs unchanged under `node --test`.

import type { PathNode, SubPath, Vec } from '../path/types'
import { segmentControls, segmentCount, cubicAt } from '../path/geometry.ts'
import { ellipseSubPaths } from '../path/model.ts'

/** Polyline samples per cubic segment when flattening a loop for fitting. */
export const FLATTEN_PER_SEG = 16

// ---------------------------------------------------------------------------
// Flattening + winding
// ---------------------------------------------------------------------------

/** Flatten a subpath's cubic segments to a dense polyline (raw-trace reference). */
export function flatten(sp: SubPath, perSeg = FLATTEN_PER_SEG): Vec[] {
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < perSeg; k++) pts.push(cubicAt(p0, c1, c2, p3, k / perSeg))
  }
  return pts
}

/** Signed area of a node ring's anchor polygon (sign = winding direction). */
export function anchorSignedArea(nodes: PathNode[]): number {
  let a = 0
  const n = nodes.length
  for (let i = 0; i < n; i++) {
    const p = nodes[i]
    const q = nodes[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Reverse a closed subpath in place (swap each node's handles). */
export function reverseSubPath(sp: SubPath): void {
  sp.nodes.reverse()
  for (const node of sp.nodes) {
    const h = node.hIn
    node.hIn = node.hOut
    node.hOut = h
  }
}

// ---------------------------------------------------------------------------
// Circle fit (algebraic, Kåsa/Coope — centred least squares)
// ---------------------------------------------------------------------------

export interface Circle {
  cx: number
  cy: number
  r: number
}

/**
 * Centred algebraic circle fit (Kåsa/Coope): minimise Σ(‖p−c‖²−r²)² in
 * centroid-centred coordinates via a 2×2 solve. Full closed contours (our case)
 * make the algebraic bias vs Taubin negligible. Returns null on a degenerate
 * (collinear / too-few-points) configuration.
 */
export function fitCircle(pts: Vec[]): Circle | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let uu = 0
  let vv = 0
  let uv = 0
  let uuu = 0
  let vvv = 0
  let uvv = 0
  let vuu = 0
  for (const p of pts) {
    const u = p.x - mx
    const v = p.y - my
    uu += u * u
    vv += v * v
    uv += u * v
    uuu += u * u * u
    vvv += v * v * v
    uvv += u * v * v
    vuu += v * u * u
  }
  const det = uu * vv - uv * uv
  if (Math.abs(det) < 1e-9) return null
  const b1 = (uuu + uvv) / 2
  const b2 = (vvv + vuu) / 2
  const uc = (b1 * vv - b2 * uv) / det
  const vc = (uu * b2 - uv * b1) / det
  const r2 = uc * uc + vc * vc + (uu + vv) / n
  if (!(r2 > 0)) return null
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(r2) }
}

/** Worst |‖p−c‖ − r| over the points (radial deviation from the circle). */
export function maxRadialDev(pts: Vec[], c: Circle): number {
  let m = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
    if (d > m) m = d
  }
  return m
}

// ---------------------------------------------------------------------------
// Axis-aligned ellipse fit (linear least squares, A + C = 2 constraint)
// ---------------------------------------------------------------------------

export interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}

/**
 * Axis-aligned ellipse fit. The conic A·x² + C·y² + D·x + E·y + F = 0 (no x·y
 * term ⇒ axes aligned to the grid) is fit by linear least squares under the
 * normalisation A + C = 2 (so a circle gives A = C = 1 and the trivial zero
 * solution is excluded). Returns null unless the result is a real ellipse
 * (A,C > 0, positive radii). Rotated ellipses are out of scope (deferred).
 */
export function fitEllipse(pts: Vec[]): Ellipse | null {
  if (pts.length < 5) return null
  // Substituting C = 2 − A: minimise Σ(A(x²−y²) + D·x + E·y + F + 2y²)² over
  // (A, D, E, F) — a 4×4 normal-equations solve.
  const M = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  const rhs = [0, 0, 0, 0]
  for (const p of pts) {
    const b = [p.x * p.x - p.y * p.y, p.x, p.y, 1]
    const t = -2 * p.y * p.y
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) M[i][j] += b[i] * b[j]
      rhs[i] += b[i] * t
    }
  }
  const sol = solve4(M, rhs)
  if (!sol) return null
  const [A, D, E, F] = sol
  const C = 2 - A
  if (!(A > 1e-6) || !(C > 1e-6)) return null
  const cx = -D / (2 * A)
  const cy = -E / (2 * C)
  const k = (D * D) / (4 * A) + (E * E) / (4 * C) - F
  const rx2 = k / A
  const ry2 = k / C
  if (!(rx2 > 0) || !(ry2 > 0)) return null
  return { cx, cy, rx: Math.sqrt(rx2), ry: Math.sqrt(ry2) }
}

/** Approximate worst radial deviation (px) of points from an axis-aligned ellipse. */
export function maxEllipseDev(pts: Vec[], e: Ellipse): number {
  let m = 0
  const rmin = Math.min(e.rx, e.ry)
  for (const p of pts) {
    const nx = (p.x - e.cx) / e.rx
    const ny = (p.y - e.cy) / e.ry
    // First-order distance estimate: (‖scaled‖ − 1) scaled back by the tighter
    // radius (a lower bound on the true Euclidean distance — conservative).
    const d = Math.abs(Math.hypot(nx, ny) - 1) * rmin
    if (d > m) m = d
  }
  return m
}

/** Solve a 4×4 linear system by Gaussian elimination with partial pivoting. */
function solve4(M: number[][], b: number[]): number[] | null {
  const n = b.length
  const A = M.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    if (Math.abs(A[piv][c]) < 1e-12) return null
    const tmp = A[c]
    A[c] = A[piv]
    A[piv] = tmp
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k]
    }
  }
  return A.map((row, i) => row[n] / row[i])
}

// ---------------------------------------------------------------------------
// Primitive subpath builders (reuse the canonical kappa-Bézier forms)
// ---------------------------------------------------------------------------

/** A 4-node Bézier circle, oriented to match `positive` winding. */
export function makeCircleSubPath(cx: number, cy: number, r: number, positive: boolean): SubPath {
  return orient(ellipseSubPaths(cx, cy, r, r)![0], positive)
}

/** A 4-node Bézier axis-aligned ellipse, oriented to match `positive` winding. */
export function makeEllipseSubPath(cx: number, cy: number, rx: number, ry: number, positive: boolean): SubPath {
  return orient(ellipseSubPaths(cx, cy, rx, ry)![0], positive)
}

export function orient(sp: SubPath, positive: boolean): SubPath {
  if (anchorSignedArea(sp.nodes) > 0 !== positive) reverseSubPath(sp)
  return sp
}

// ---------------------------------------------------------------------------
// Single-linkage clustering
// ---------------------------------------------------------------------------

/**
 * Single-linkage clustering of items by a symmetric `related` predicate
 * (deterministic: input order preserved, union-find). Returns the partition.
 */
export function clusterBy<T>(items: T[], related: (a: T, b: T) => boolean): T[][] {
  const n = items.length
  const parent = new Array(n).fill(0).map((_, i) => i)
  const find = (x: number): number => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const nx = parent[x]
      parent[x] = r
      x = nx
    }
    return r
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (related(items[i], items[j])) {
        const ri = find(i)
        const rj = find(j)
        if (ri !== rj) parent[Math.max(ri, rj)] = Math.min(ri, rj)
      }
    }
  }
  const groups = new Map<number, T[]>()
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let g = groups.get(r)
    if (!g) groups.set(r, (g = []))
    g.push(items[i])
  }
  return [...groups.values()]
}

// ---------------------------------------------------------------------------
// Relation solver — concentric centres + equal radii (generic over edges/loops)
// ---------------------------------------------------------------------------

/** A circle the relation solver may reconcile: its centre/radius are mutated in
 *  place; `raw` is the RAW flattened trace it was fit to (the re-gate set). */
export interface RelationCircle {
  cx: number
  cy: number
  r: number
  raw: Vec[]
}

export interface RelationOptions {
  fidelity: number
  relationFrac: number
}

/**
 * Reconcile the snapped circles: concentric centres (radius-weighted mean) and
 * equal radii (mean), each accepted ONLY when it does not push that circle past
 * the fidelity knob — re-measured against the circle's RAW flattened trace,
 * never the snapped one. Mutates each circle's cx/cy/r IN PLACE and returns a
 * per-circle flag (aligned to input order) marking which actually moved, so the
 * caller regenerates only those. The detection window is `relationFrac` of the
 * document bbox long side.
 *
 * This is the exact two-pass math beautify.ts used privately; lifting it here
 * lets the planar edge-beautifier reuse it over disc-edge circles unchanged.
 */
export function relationSolveCircles(
  circles: RelationCircle[],
  opts: RelationOptions,
  longSide: number,
): boolean[] {
  const changed = circles.map(() => false)
  if (circles.length < 2) return changed
  const index = new Map<RelationCircle, number>()
  circles.forEach((c, i) => index.set(c, i))

  const tol = opts.relationFrac * longSide

  // --- Concentric clusters (union-find on centre distance) -----------------
  const cc = clusterBy(circles, (a, b) => Math.hypot(a.cx - b.cx, a.cy - b.cy) <= tol)
  for (const cluster of cc) {
    if (cluster.length < 2) continue
    // Radius-weighted mean centre (larger circles localise the centre better).
    let wsum = 0
    let sx = 0
    let sy = 0
    for (const c of cluster) {
      const w = c.r
      wsum += w
      sx += c.cx * w
      sy += c.cy * w
    }
    const tx = sx / wsum
    const ty = sy / wsum
    for (const c of cluster) {
      // Accept only if the re-centred circle still fits its raw trace.
      if (maxRadialDev(c.raw, { cx: tx, cy: ty, r: c.r }) <= opts.fidelity) {
        c.cx = tx
        c.cy = ty
        changed[index.get(c)!] = true
      }
    }
  }

  // --- Equal-radius clusters ------------------------------------------------
  const rc = clusterBy(circles, (a, b) => Math.abs(a.r - b.r) <= tol)
  for (const cluster of rc) {
    if (cluster.length < 2) continue
    let sr = 0
    for (const c of cluster) sr += c.r
    const tr = sr / cluster.length
    for (const c of cluster) {
      if (maxRadialDev(c.raw, { cx: c.cx, cy: c.cy, r: tr }) <= opts.fidelity) {
        c.r = tr
        changed[index.get(c)!] = true
      }
    }
  }

  return changed
}

// ---------------------------------------------------------------------------
// Misc geometry
// ---------------------------------------------------------------------------

/** Perpendicular distance of point p from the line through a and b. */
export function perpDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}
