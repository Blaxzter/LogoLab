// Shape beautification (Stage 3 of the V3 vectorizer — plan §3.3 / §6 V3).
//
// A PURE post-processing pass over the traced contours, run AFTER the tracer and
// BEFORE the EditableDoc is assembled, so it works for BOTH engines (potrace and
// crisp). It does NOT re-segment — it only regularises the geometry the tracer
// already produced:
//
//   1. Per closed loop — snap to a primitive (circle / axis-aligned ellipse) when
//      the loop genuinely is one; straighten near-straight cubic runs to lines,
//      merge collinear vertices, and snap rectilinear edges to horizontal/vertical.
//   2. Cross-shape relation solver — detect concentric centres and equal radii
//      across all loops/items and reconcile them with one small mean adjustment.
//
// Every snap is gated by ONE user-facing tolerance — the FIDELITY knob: a snap is
// accepted only if the maximum deviation it introduces from the raw flattened
// trace stays ≤ `fidelity` px. This is the single knob that says how far from the
// source PNG the output may drift. `fidelity = 0` disables beautification.
//
// Pure and deterministic (fixed sample counts, fixed scan/cluster orders, no PRNG
// / Date): runs unchanged under `node --test`.

import type { SubPath, PathNode, Vec } from '../path/types'
import { segmentControls, segmentCount, cubicAt } from '../path/geometry.ts'
import { ellipseSubPaths } from '../path/model.ts'

export interface BeautifyOptions {
  /**
   * Max deviation (px) any snap may introduce from the raw trace — the user
   * fidelity knob. A snap is accepted only when its worst-case drift stays under
   * this. 0 disables all beautification (output is the raw trace).
   */
  fidelity: number
  /** Concentric-centre / equal-radius detection radius, as a fraction of the
   *  whole-document bbox long side (plan §3.3: ~1/10). */
  relationFrac: number
  /** Angle (deg) within which a straight edge snaps to horizontal/vertical. */
  hvAngleDeg: number
}

export const DEFAULT_BEAUTIFY_OPTIONS: BeautifyOptions = {
  fidelity: 1.5,
  relationFrac: 0.1,
  hvAngleDeg: 10,
}

/** Polyline samples per cubic segment when flattening a loop for fitting. */
const FLATTEN_PER_SEG = 16

/**
 * Drift ceiling (px) for the LINE cleanups — straighten, collinear-merge, H-V
 * snap. Deliberately a small value (well under 1 px) and NOT scaled up by the
 * fidelity knob. Each line cleanup repositions a single boundary vertex, so any
 * drift over ~1 px reads as a seam (the harness flags boundary moves the source
 * edge cannot account for) and second-guesses the tracer's own fit — measured to
 * regress petals' organic edges and aurora's translucent strokes when run at the
 * full 1.5 px budget. The knob's larger drift budget belongs to WHOLE-SHAPE
 * primitive snaps (circles/ellipses): there the deviation is distributed smoothly
 * around a perfect shape and the perceptual payoff justifies it, whereas nudging
 * one vertex never does. (`min(fidelity, …)` still lets a user tighten below it.)
 */
const LINE_POLISH_CAP = 0.3

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Beautify the traced subpaths of every item. `groups` is one `SubPath[]` per
 * item, in paint order; the return value has the same outer shape (each subpath
 * possibly replaced by a regularised one), so the caller reassembles items
 * unchanged. Loop winding (outer vs hole) is always preserved so nonzero/evenodd
 * fills keep rendering holes as holes.
 */
export function beautify(groups: SubPath[][], opts: BeautifyOptions): SubPath[][] {
  if (!(opts.fidelity > 0)) return groups

  // Whole-document bbox long side drives the relation-solver detection radius.
  const L = docLongSide(groups)

  // Per-loop pass: analyse every closed loop into a shape record (circle / poly).
  const records: ShapeRecord[][] = groups.map((g) =>
    g.map((sp) => analyseLoop(sp, opts)),
  )

  // Relation solver across all circle records (concentric centres, equal radii).
  relationSolve(records, opts, L)

  // Materialise the (possibly adjusted) records back into subpaths.
  return records.map((g) => g.map((rec) => rec.subPath))
}

// ---------------------------------------------------------------------------
// Shape records
// ---------------------------------------------------------------------------

interface CircleRecord {
  kind: 'circle'
  subPath: SubPath
  cx: number
  cy: number
  r: number
  /** Sign of the original loop's winding, to regenerate with matching orientation. */
  positive: boolean
  /** The original flattened trace, so any later (relation) adjustment can be
   *  re-checked against the RAW trace, never against the snapped circle. */
  raw: Vec[]
}

interface PolyRecord {
  kind: 'poly'
  subPath: SubPath
}

type ShapeRecord = CircleRecord | PolyRecord

/**
 * Analyse one subpath: try a circle/ellipse primitive first; otherwise apply the
 * line/collinear/H-V polish. Open subpaths and tiny loops are left untouched.
 */
function analyseLoop(sp: SubPath, opts: BeautifyOptions): ShapeRecord {
  if (!sp.closed || sp.nodes.length < 3) return { kind: 'poly', subPath: sp }

  const raw = flatten(sp)
  const positive = anchorSignedArea(sp) > 0

  // --- Circle ---------------------------------------------------------------
  const circle = fitCircle(raw)
  if (circle && circle.r > 2 * opts.fidelity && maxRadialDev(raw, circle) <= opts.fidelity) {
    return {
      kind: 'circle',
      subPath: makeCircleSubPath(circle.cx, circle.cy, circle.r, positive),
      cx: circle.cx,
      cy: circle.cy,
      r: circle.r,
      positive,
      raw,
    }
  }

  // --- Axis-aligned ellipse -------------------------------------------------
  const ell = fitEllipse(raw)
  if (
    ell &&
    Math.min(ell.rx, ell.ry) > 2 * opts.fidelity &&
    maxEllipseDev(raw, ell) <= opts.fidelity
  ) {
    return { kind: 'poly', subPath: makeEllipseSubPath(ell.cx, ell.cy, ell.rx, ell.ry, positive) }
  }

  // --- Line / collinear / H-V polish ---------------------------------------
  return { kind: 'poly', subPath: polishLines(sp, opts) }
}

// ---------------------------------------------------------------------------
// Flattening + winding
// ---------------------------------------------------------------------------

/** Flatten a subpath's cubic segments to a dense polyline (raw-trace reference). */
function flatten(sp: SubPath, perSeg = FLATTEN_PER_SEG): Vec[] {
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < perSeg; k++) pts.push(cubicAt(p0, c1, c2, p3, k / perSeg))
  }
  return pts
}

/** Signed area of a subpath's anchor polygon (sign = winding direction). */
function anchorSignedArea(sp: SubPath): number {
  let a = 0
  const n = sp.nodes.length
  for (let i = 0; i < n; i++) {
    const p = sp.nodes[i]
    const q = sp.nodes[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Reverse a closed subpath in place (swap each node's handles). */
function reverseSubPath(sp: SubPath): void {
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

interface Circle {
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
function fitCircle(pts: Vec[]): Circle | null {
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
function maxRadialDev(pts: Vec[], c: Circle): number {
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

interface Ellipse {
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
function fitEllipse(pts: Vec[]): Ellipse | null {
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
function maxEllipseDev(pts: Vec[], e: Ellipse): number {
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
function makeCircleSubPath(cx: number, cy: number, r: number, positive: boolean): SubPath {
  return orient(ellipseSubPaths(cx, cy, r, r)![0], positive)
}

/** A 4-node Bézier axis-aligned ellipse, oriented to match `positive` winding. */
function makeEllipseSubPath(cx: number, cy: number, rx: number, ry: number, positive: boolean): SubPath {
  return orient(ellipseSubPaths(cx, cy, rx, ry)![0], positive)
}

function orient(sp: SubPath, positive: boolean): SubPath {
  if (anchorSignedArea(sp) > 0 !== positive) reverseSubPath(sp)
  return sp
}

// ---------------------------------------------------------------------------
// Line / collinear / H-V polish (for loops that are not a primitive)
// ---------------------------------------------------------------------------

/**
 * Polish a non-primitive loop: straighten near-straight cubic segments to true
 * lines, merge collinear vertices, then snap near-axis-aligned edges to
 * horizontal/vertical. Every step is fidelity-gated and winding-preserving;
 * genuine curves (handles far off the chord) are untouched.
 */
function polishLines(sp: SubPath, opts: BeautifyOptions): SubPath {
  // All three line cleanups share the sub-fidelity drift cap (see LINE_POLISH_CAP)
  // so they only tidy near-exact cases and never move a true edge into a seam.
  const cap = Math.min(opts.fidelity, LINE_POLISH_CAP)
  let nodes = sp.nodes.map(cloneNode)

  // 1. Straighten: a cubic segment whose curve already sits within `cap` of its
  //    chord becomes a true line (both incident handles dropped).
  const count = sp.closed ? nodes.length : nodes.length - 1
  for (let seg = 0; seg < count; seg++) {
    const a = nodes[seg]
    const b = nodes[(seg + 1) % nodes.length]
    if (!a.hOut && !b.hIn) continue // already a line
    if (cubicChordDev(a, b) <= cap) {
      a.hOut = null
      b.hIn = null
    }
  }

  // 2. Merge collinear vertices: drop an anchor sitting (within `cap`) on the
  //    straight chord between its line-neighbours — a node-count win on
  //    rectilinear / pixel-staircase contours.
  nodes = mergeCollinear(nodes, sp.closed, cap)

  // 3. Snap near-axis-aligned straight edges to exact H/V (within `cap`; only
  //    near-exact axis edges fit the budget — aggressive angle-snapping would
  //    move long edges far enough to seam).
  snapAxisAligned(nodes, sp.closed, opts, cap)

  return { nodes, closed: sp.closed }
}

function cloneNode(n: PathNode): PathNode {
  return {
    x: n.x,
    y: n.y,
    hIn: n.hIn ? { x: n.hIn.x, y: n.hIn.y } : null,
    hOut: n.hOut ? { x: n.hOut.x, y: n.hOut.y } : null,
    kind: n.kind,
  }
}

/** Worst deviation of a cubic from its chord (a→b), sampled. */
function cubicChordDev(a: PathNode, b: PathNode): number {
  const p0: Vec = { x: a.x, y: a.y }
  const p3: Vec = { x: b.x, y: b.y }
  const c1 = a.hOut ?? p0
  const c2 = b.hIn ?? p3
  let m = 0
  for (let k = 1; k < FLATTEN_PER_SEG; k++) {
    const p = cubicAt(p0, c1, c2, p3, k / FLATTEN_PER_SEG)
    const d = perpDistance(p, p0, p3)
    if (d > m) m = d
  }
  return m
}

/** Drop anchors that lie on the straight chord between their two line-neighbours. */
function mergeCollinear(nodes: PathNode[], closed: boolean, fid: number): PathNode[] {
  const minNodes = closed ? 3 : 2
  let changed = true
  while (changed && nodes.length > minNodes) {
    changed = false
    for (let i = 0; i < nodes.length; i++) {
      const prevI = (i - 1 + nodes.length) % nodes.length
      const nextI = (i + 1) % nodes.length
      if (!closed && (i === 0 || i === nodes.length - 1)) continue
      const prev = nodes[prevI]
      const cur = nodes[i]
      const next = nodes[nextI]
      // Both incident segments must be straight (line into and out of `cur`).
      if (prev.hOut || cur.hIn || cur.hOut || next.hIn) continue
      if (perpDistance(cur, prev, next) <= fid) {
        nodes.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return nodes
}

/**
 * Snap near-axis-aligned straight edges to exact H/V. For each straight edge
 * within `hvAngleDeg` of an axis, the two endpoints' minor coordinate is set to
 * their midpoint — but only when both endpoint moves stay ≤ `fidelity`. A rect
 * corner shared by a horizontal and a vertical edge gets its y from the former
 * and its x from the latter, yielding a clean axis-aligned rectangle.
 */
function snapAxisAligned(nodes: PathNode[], closed: boolean, opts: BeautifyOptions, fid: number): void {
  const tan = Math.tan((opts.hvAngleDeg * Math.PI) / 180)
  const count = closed ? nodes.length : nodes.length - 1
  for (const axis of ['h', 'v'] as const) {
    for (let seg = 0; seg < count; seg++) {
      const a = nodes[seg]
      const b = nodes[(seg + 1) % nodes.length]
      if (a.hOut || b.hIn) continue // only straight edges
      const dx = b.x - a.x
      const dy = b.y - a.y
      if (axis === 'h') {
        // Near-horizontal: |dy| small relative to |dx|.
        if (Math.abs(dx) < 1e-6 || Math.abs(dy) > Math.abs(dx) * tan) continue
        const my = (a.y + b.y) / 2
        if (Math.abs(my - a.y) > fid || Math.abs(my - b.y) > fid) continue
        shiftAnchorY(a, my)
        shiftAnchorY(b, my)
      } else {
        if (Math.abs(dy) < 1e-6 || Math.abs(dx) > Math.abs(dy) * tan) continue
        const mx = (a.x + b.x) / 2
        if (Math.abs(mx - a.x) > fid || Math.abs(mx - b.x) > fid) continue
        shiftAnchorX(a, mx)
        shiftAnchorX(b, mx)
      }
    }
  }
}

function shiftAnchorX(n: PathNode, x: number): void {
  const d = x - n.x
  n.x = x
  if (n.hIn) n.hIn.x += d
  if (n.hOut) n.hOut.x += d
}
function shiftAnchorY(n: PathNode, y: number): void {
  const d = y - n.y
  n.y = y
  if (n.hIn) n.hIn.y += d
  if (n.hOut) n.hOut.y += d
}

// ---------------------------------------------------------------------------
// Relation solver — concentric centres + equal radii
// ---------------------------------------------------------------------------

/**
 * Reconcile the snapped circles across all items. Two relations are detected and
 * resolved, each only when it does NOT push any circle past the fidelity knob
 * (re-measured against that circle's RAW flattened trace, never the snapped one):
 *   • Concentric — circles whose centres lie within `relationFrac` of the doc
 *     bbox long side are moved to their common (radius-weighted) mean centre.
 *   • Equal radii — circles whose radii agree within the same window are set to
 *     their mean radius.
 * Adjusted circles are regenerated as fresh 4-node Bézier subpaths in place.
 */
function relationSolve(records: ShapeRecord[][], opts: BeautifyOptions, longSide: number): void {
  const circles: CircleRecord[] = []
  for (const g of records) for (const rec of g) if (rec.kind === 'circle') circles.push(rec)
  if (circles.length < 2) return

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
        c.subPath = makeCircleSubPath(c.cx, c.cy, c.r, c.positive)
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
        c.subPath = makeCircleSubPath(c.cx, c.cy, c.r, c.positive)
      }
    }
  }
}

/**
 * Single-linkage clustering of items by a symmetric `related` predicate
 * (deterministic: input order preserved, union-find). Returns the partition.
 */
function clusterBy<T>(items: T[], related: (a: T, b: T) => boolean): T[][] {
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
// Misc geometry
// ---------------------------------------------------------------------------

/** Long side of the bbox over every anchor of every loop in the document. */
function docLongSide(groups: SubPath[][]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const g of groups) {
    for (const sp of g) {
      for (const n of sp.nodes) {
        if (n.x < minX) minX = n.x
        if (n.x > maxX) maxX = n.x
        if (n.y < minY) minY = n.y
        if (n.y > maxY) maxY = n.y
      }
    }
  }
  if (minX === Infinity) return 0
  return Math.max(maxX - minX, maxY - minY)
}

/** Perpendicular distance of point p from the line through a and b. */
function perpDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}
