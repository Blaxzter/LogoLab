// Evidence-based curve fitting for the crisp tracer (plan §4.2 / Stage A — the
// supplement's "soft-corner + dynamic-programming" curve-selection recipe).
//
// The crisp tracer used to place corners with a hard turn-angle threshold
// (detectCorners): one global knob that had to be both sharp on real corners and
// smooth on curves, so it rounded genuine sharp corners (summit's mountain peaks)
// and drifted the boundary off the source edge. This module replaces that with
// the supplement's evidence-driven pipeline, keeping the same Schneider cubic
// fitter as the inner primitive:
//
//   1. Key vertices  — Douglas–Peucker at ε on the dense loop; the retained
//      vertices are the ONLY allowed curve endpoints (§3.3.1).
//   2. Tangents      — at each key vertex, fit a line over a growing window until
//      its RMS exceeds ε/2; that direction is the G¹ tangent (§3.3.2).
//   3. Soft-corner   — a score c(j) ∈ [−1 smooth … +1 corner] from competitively
//      fitting a line, a circle and a two-line wedge over growing windows until
//      each exceeds ε; corners emerge from evidence, not a threshold (§3.3.3).
//   4. DP selection  — an over-complete candidate set (a line between adjacent
//      key vertices, plus Schneider cubics between ANY key-vertex pair for the
//      four C⁰/G¹ endpoint combinations), each ≤ ε, costed with junction
//      penalties from c(j); a min-cost path through the DAG picks where C⁰ corners
//      go based on global context (§3.3.4).
//
// Everything is pure and deterministic (fixed scan orders, no PRNG / Date), so it
// runs unchanged under `node --test`.

import type { PathNode, Vec } from '../path/types'

export interface CurveFitOptions {
  /** Key-vertex DP tolerance AND cubic-discard tolerance ε (px). Paper: 1.5. */
  epsilon: number
  /** Base cost of a line segment. Paper: 3.9. */
  lineCost: number
  /** Base cost of a cubic Bézier. Paper: 4. */
  cubicCost: number
}

export const DEFAULT_CURVE_FIT: CurveFitOptions = {
  epsilon: 1.5,
  lineCost: 3.9,
  cubicCost: 4,
}

// ---------------------------------------------------------------------------
// Public entry: fit one closed sub-pixel loop into cubic PathNodes
// ---------------------------------------------------------------------------

/**
 * Fit a dense, closed sub-pixel loop (marching-squares output) into a minimal
 * chain of lines / cubic Béziers, choosing corner vs smooth joins from evidence.
 * Returns the closed subpath's nodes, or null when the loop is degenerate.
 */
export function fitClosedLoop(denseRaw: Vec[], opts: CurveFitOptions = DEFAULT_CURVE_FIT): PathNode[] | null {
  const dense = dedupLoop(denseRaw)
  const N = dense.length
  if (N < 3) return null

  const eps = opts.epsilon
  const keyIdx = keyVertexIndices(dense, eps)
  const m = keyIdx.length
  if (m < 2) {
    // No corners survive simplification (a near-circle smaller than ε across, or
    // a tiny blob): fall back to a single smooth closed cubic chain.
    return null
  }

  // Per-key-vertex forward tangents (§3.3.2) and soft-corner scores (§3.3.3).
  const tangents = keyIdx.map((i) => tangentAtIndex(dense, i, eps))
  const scores = keyIdx.map((i) => cornerScoreAtIndex(dense, i, eps))
  const junc = scores.map(junctionCosts)

  // Over-complete candidate set + min-cost cyclic DP (§3.3.4).
  const cand = buildCandidates(dense, keyIdx, tangents, junc, opts)
  const tour = solveCyclicDP(m, cand, junc)
  if (!tour) return null

  return materialize(tour, keyIdx, dense)
}

// ---------------------------------------------------------------------------
// 1. Key vertices (Douglas–Peucker at ε, closed loop) → dense indices
// ---------------------------------------------------------------------------

/**
 * RDP on a closed loop, returning the KEPT dense indices in cyclic order. Anchors
 * the two farthest-apart points (stable), simplifies both arcs, and reports the
 * surviving indices — the only allowed curve endpoints (§3.3.1).
 */
export function keyVertexIndices(dense: Vec[], eps: number): number[] {
  const n = dense.length
  if (n < 3) return dense.map((_, i) => i)

  // Two farthest-apart points as stable anchors (mirrors subpixel.rdpClosed).
  let iB = 0
  let best = -1
  for (let i = 1; i < n; i++) {
    const d = dist2(dense[0], dense[i])
    if (d > best) {
      best = d
      iB = i
    }
  }
  let iA = 0
  best = -1
  for (let i = 0; i < n; i++) {
    const d = dist2(dense[iB], dense[i])
    if (d > best) {
      best = d
      iA = i
    }
  }

  const keep = new Uint8Array(n)
  keep[iA] = 1
  keep[iB] = 1
  rdpMark(dense, iA, iB, eps, keep) // arc A→B forward
  rdpMark(dense, iB, iA, eps, keep) // arc B→A forward (wraps)

  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

/** Mark RDP-retained indices on the forward cyclic arc from `from` to `to`. */
function rdpMark(dense: Vec[], from: number, to: number, eps: number, keep: Uint8Array): void {
  const n = dense.length
  const len = (to - from + n) % n // steps from→to (forward)
  if (len < 2) return
  // Iterative DP over offsets [lo, hi] within the arc (offset 0 = from).
  const stack: [number, number][] = [[0, len]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    const a = dense[(from + lo) % n]
    const b = dense[(from + hi) % n]
    let maxD = -1
    let idx = -1
    for (let o = lo + 1; o < hi; o++) {
      const d = perpDistance(dense[(from + o) % n], a, b)
      if (d > maxD) {
        maxD = d
        idx = o
      }
    }
    if (maxD > eps && idx >= 0) {
      keep[(from + idx) % n] = 1
      stack.push([lo, idx], [idx, hi])
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Tangents (§3.3.2)
// ---------------------------------------------------------------------------

/**
 * Forward tangent at the dense index `i`: fit a total-least-squares line to
 * `dense[i-k..i+k]` for growing k until its RMS exceeds ε/2, then return the last
 * good line's direction oriented along the loop's forward traversal.
 */
export function tangentAtIndex(dense: Vec[], i: number, eps: number): Vec {
  const n = dense.length
  const half = eps / 2
  let bestDir = forwardDir(dense, i)
  for (let k = 1; k <= (n >> 1); k++) {
    const pts = windowPoints(dense, i, k)
    const fit = lineFit(pts)
    if (!fit) break
    if (fit.rms > half) break
    bestDir = fit.dir
  }
  // Orient along forward traversal so G¹-joined cubics share one tangent.
  const fwd = forwardDir(dense, i)
  if (bestDir.x * fwd.x + bestDir.y * fwd.y < 0) return { x: -bestDir.x, y: -bestDir.y }
  return bestDir
}

/** Local forward direction at index i (chord across its immediate neighbours). */
function forwardDir(dense: Vec[], i: number): Vec {
  const n = dense.length
  const a = dense[(i - 1 + n) % n]
  const b = dense[(i + 1) % n]
  const d = unit(sub(b, a))
  if (d.x === 0 && d.y === 0) return unit(sub(dense[(i + 1) % n], dense[i]))
  return d
}

// ---------------------------------------------------------------------------
// 3. Soft-corner score (§3.3.3)
// ---------------------------------------------------------------------------

/**
 * Soft-corner score c ∈ [−1 (smooth) … +1 (corner)] at dense index `i`.
 * Competitively grows a line, a circle and a two-line wedge over windows
 * `[i-k, i+k]` until each's max deviation exceeds ε; L, S, C are the point counts
 * each shape covered. The score then follows the supplement's heuristic.
 */
export function cornerScoreAtIndex(dense: Vec[], i: number, eps: number): number {
  const L = lineCoverage(dense, i, eps)
  const S = circleCoverage(dense, i, eps)
  const C = wedgeCoverage(dense, i, eps)

  if (L >= S) return -L / Math.max(L, C)
  // L < S
  if (S >= C) return -softF((S + 1) / (C + 1))
  return softF((C + 1) / (S + 1))
}

/** f(x) = 1 − 1/(1 + 5(x−1)); maps a shape ratio (x ≥ 1) into [0, 1). */
function softF(x: number): number {
  return 1 - 1 / (1 + 5 * (x - 1))
}

/** Largest line window (point count 2k+1) around i fitting within ε. */
function lineCoverage(dense: Vec[], i: number, eps: number): number {
  const n = dense.length
  let cover = 1
  for (let k = 1; k <= (n >> 1); k++) {
    const pts = windowPoints(dense, i, k)
    const fit = lineFit(pts)
    if (!fit) break
    if (fit.maxDev > eps) break
    cover = 2 * k + 1
  }
  return cover
}

/** Largest circle window around i fitting within ε (3 points always fit). */
function circleCoverage(dense: Vec[], i: number, eps: number): number {
  const n = dense.length
  let cover = 1
  for (let k = 1; k <= (n >> 1); k++) {
    const pts = windowPoints(dense, i, k)
    const dev = circleMaxDev(pts)
    if (dev === null) {
      // Collinear: a line (infinite-radius circle) fits perfectly.
      cover = 2 * k + 1
      continue
    }
    if (dev > eps) break
    cover = 2 * k + 1
  }
  return cover
}

/** Largest two-line-wedge window around i fitting within ε. */
function wedgeCoverage(dense: Vec[], i: number, eps: number): number {
  const n = dense.length
  let cover = 1
  for (let k = 1; k <= (n >> 1); k++) {
    const left = windowPoints(dense, i, k, -1) // [i-k .. i]
    const right = windowPoints(dense, i, k, 1) // [i .. i+k]
    const lf = lineFit(left)
    const rf = lineFit(right)
    if (!lf || !rf) break
    const dev = Math.max(lf.maxDev, rf.maxDev)
    if (dev > eps) break
    cover = 2 * k + 1
  }
  return cover
}

/** Points dense[i-k .. i+k] (side<0: i-k..i, side>0: i..i+k), cyclic. */
function windowPoints(dense: Vec[], i: number, k: number, side = 0): Vec[] {
  const n = dense.length
  const out: Vec[] = []
  const lo = side > 0 ? 0 : -k
  const hi = side < 0 ? 0 : k
  for (let o = lo; o <= hi; o++) out.push(dense[(i + o + n * (k + 1)) % n])
  return out
}

// ---------------------------------------------------------------------------
// Junction costs (§3.3.4)
// ---------------------------------------------------------------------------

export interface JunctionCost {
  /** Cost of a C⁰ (corner) join at this key vertex. */
  c0: number
  /** Cost of a G¹ (smooth) join at this key vertex. */
  g1: number
}

/** Map a cornerness score c into the (C⁰, G¹) junction costs (§3.3.4). */
export function junctionCosts(c: number): JunctionCost {
  if (c > 0.25) return { c0: 10 / (1 + softG(c, 0.25)), g1: 10 * softG(c, 0.25) }
  if (c < 0) return { c0: 10 + 10 * softG(-c, 0), g1: 0 }
  return { c0: 10, g1: 0 }
}

/** g(c, α) = 1/(1 − min(c/(1+α), 0.99))² − 1. */
function softG(c: number, alpha: number): number {
  const t = Math.min(c / (1 + alpha), 0.99)
  return 1 / ((1 - t) * (1 - t)) - 1
}

// ---------------------------------------------------------------------------
// 4. Candidate set + DP (§3.3.4)
// ---------------------------------------------------------------------------

type Cont = 0 | 1 // 0 = C⁰ (free tangent), 1 = G¹ (key-vertex tangent)

interface Candidate {
  /** Forward key-vertex start position (0..m-1). */
  a: number
  /** Number of forward key-vertex steps spanned (1..m-1). */
  len: number
  /** True for a straight line (handles dropped); else a cubic. */
  line: boolean
  startCont: Cont
  endCont: Cont
  /** Base curve cost incl. δ·E and intermediate-junction G¹ penalties. */
  cost: number
  /** Control points (absolute), for materialization. */
  c1: Vec
  c2: Vec
}

interface CandidateTable {
  /** byStart[a] = candidates beginning at key-vertex position a. */
  byStart: Candidate[][]
}

/**
 * Build the over-complete candidate set: a line between each adjacent key-vertex
 * pair, and Schneider cubics between any pair for the four C⁰/G¹ endpoint
 * combinations, each discarded if its max deviation exceeds ε.
 */
function buildCandidates(
  dense: Vec[],
  keyIdx: number[],
  tangents: Vec[],
  junc: JunctionCost[],
  opts: CurveFitOptions,
): CandidateTable {
  const m = keyIdx.length
  const eps = opts.epsilon
  const delta = 1e-6 * eps
  const byStart: Candidate[][] = Array.from({ length: m }, () => [])

  // Cumulative G¹ penalty of intermediate key vertices spanned by a cubic.
  const interG1 = (a: number, len: number): number => {
    let s = 0
    for (let p = 1; p < len; p++) s += junc[(a + p) % m].g1
    return s
  }

  for (let a = 0; a < m; a++) {
    const maxLen = m - 1
    for (let len = 1; len <= maxLen; len++) {
      const b = (a + len) % m
      const arc = denseArc(dense, keyIdx[a], keyIdx[b])
      if (arc.length < 2) break

      // Adjacent pair: also offer a straight line (C⁰ both ends).
      if (len === 1) {
        const ld = lineDeviation(arc)
        if (ld.maxDev <= eps) {
          byStart[a].push({
            a,
            len,
            line: true,
            startCont: 0,
            endCont: 0,
            cost: opts.lineCost + delta * ld.sqErr,
            c1: arc[0],
            c2: arc[arc.length - 1],
          })
        }
      }

      // Cubics: free start dir, free end dir (into the arc), or the key tangent.
      const freeStart = unit(sub(arc[1], arc[0]))
      const freeEnd = unit(sub(arc[arc.length - 2], arc[arc.length - 1]))
      const startDirs: [Cont, Vec][] = [
        [0, freeStart],
        [1, orient(tangents[a], freeStart)],
      ]
      const endDirs: [Cont, Vec][] = [
        [0, freeEnd],
        [1, orient(neg(tangents[b]), freeEnd)],
      ]

      let anyFit = false
      const interCost = interG1(a, len)
      for (const [sc, sd] of startDirs) {
        for (const [ec, ed] of endDirs) {
          const fit = fitSingleCubic(arc, sd, ed)
          if (fit.maxDev > eps) continue
          anyFit = true
          byStart[a].push({
            a,
            len,
            line: false,
            startCont: sc,
            endCont: ec,
            cost: opts.cubicCost + delta * fit.sqErr + interCost,
            c1: fit.c1,
            c2: fit.c2,
          })
        }
      }
      // If even the freest (C⁰/C⁰) cubic over this arc failed, a longer arc will
      // not fit either — stop growing this start to bound the work.
      if (!anyFit && len > 1) break
    }
  }
  return { byStart }
}

/** Orient an (undirected) tangent so it points the same way as `ref`. */
function orient(t: Vec, ref: Vec): Vec {
  return t.x * ref.x + t.y * ref.y < 0 ? neg(t) : t
}

interface TourCurve {
  cand: Candidate
}

/**
 * Min-cost cyclic tour through the candidates. The cycle has at least one break
 * (junction); we try each key vertex as the forced seam and, at that seam, each
 * (end-type, start-type) pairing, running a linear DP around the cycle. O(m³)
 * over precomputed candidate costs.
 */
function solveCyclicDP(m: number, cand: CandidateTable, junc: JunctionCost[]): TourCurve[] | null {
  let bestCost = Infinity
  let bestTour: TourCurve[] | null = null

  for (let seam = 0; seam < m; seam++) {
    for (const startCont of [0, 1] as Cont[]) {
      const dp = linearDP(m, seam, startCont, cand, junc)
      for (const endCont of [0, 1] as Cont[]) {
        const reached = dp.cost[m][endCont]
        if (!Number.isFinite(reached)) continue
        // Closing junction at the seam between the last curve (endCont) and the
        // first curve (startCont).
        const closeJ = endCont === 1 && startCont === 1 ? junc[seam].g1 : junc[seam].c0
        const total = reached + closeJ
        if (total < bestCost) {
          bestCost = total
          bestTour = reconstruct(dp, m, endCont)
        }
      }
    }
  }
  return bestTour
}

interface DPState {
  /** cost[p][t] = min cost to reach position p with arrival continuity t. */
  cost: number[][]
  /** back[p][t] = {fromPos, fromCont, cand} that achieved cost[p][t]. */
  back: ({ fromPos: number; fromCont: Cont; cand: Candidate } | null)[][]
  seam: number
  startCont: Cont
}

/**
 * Linear DP around the cycle starting/ending at `seam`, with the first curve's
 * start continuity fixed to `startCont`. Positions 0..m map to key vertices
 * seam, seam+1, …, seam (back to start). cost[m][t] is the min cost of covering
 * the whole cycle, arriving back at the seam with continuity t (internal
 * junctions paid; the closing seam junction is added by the caller).
 */
function linearDP(m: number, seam: number, startCont: Cont, cand: CandidateTable, junc: JunctionCost[]): DPState {
  const INF = Infinity
  const cost: number[][] = Array.from({ length: m + 1 }, () => [INF, INF])
  const back: DPState['back'] = Array.from({ length: m + 1 }, () => [null, null])

  // Place the first curve from position 0 (no internal junction at the seam).
  placeFrom(0, 0 as Cont, true, 0)

  for (let p = 1; p < m; p++) {
    for (const tin of [0, 1] as Cont[]) {
      if (!Number.isFinite(cost[p][tin])) continue
      placeFrom(p, tin, false, cost[p][tin])
    }
  }

  return { cost, back, seam, startCont }

  function placeFrom(p: number, tin: Cont, isFirst: boolean, base: number): void {
    const kv = (seam + p) % m
    const list = cand.byStart[kv]
    for (const c of list) {
      // First curve must start with the fixed seam continuity; later curves pay
      // the junction between the arriving and the departing continuity.
      let junctionCost = 0
      if (isFirst) {
        if (c.startCont !== startCont) continue
      } else {
        junctionCost = tin === 1 && c.startCont === 1 ? junc[kv].g1 : junc[kv].c0
      }
      const q = p + c.len
      if (q > m) continue // a curve may not overshoot the seam
      const total = base + junctionCost + c.cost
      if (total < cost[q][c.endCont]) {
        cost[q][c.endCont] = total
        back[q][c.endCont] = { fromPos: p, fromCont: tin, cand: c }
      }
    }
  }
}

/** Walk the DP backpointers from (m, endCont) to the seam, in forward order. */
function reconstruct(dp: DPState, m: number, endCont: Cont): TourCurve[] {
  const curves: TourCurve[] = []
  let p = m
  let t = endCont
  while (p > 0) {
    const b = dp.back[p][t]
    if (!b) break
    curves.push({ cand: b.cand })
    p = b.fromPos
    t = b.fromCont
  }
  curves.reverse()
  return curves
}

// ---------------------------------------------------------------------------
// Materialization → PathNodes
// ---------------------------------------------------------------------------

/**
 * Turn a chosen tour of curves into closed-subpath nodes. Anchors sit at the
 * curves' shared key vertices; a junction is tagged 'smooth' when both meeting
 * endpoints are G¹, else 'corner'. Lines drop their handles.
 */
function materialize(tour: TourCurve[], keyIdx: number[], dense: Vec[]): PathNode[] | null {
  const m = keyIdx.length
  if (tour.length === 0) return null

  // Resolve each curve's endpoint anchors. Each candidate carries its absolute
  // start key-vertex position in `a`, so endpoints are direct lookups.
  const segs: {
    p0: Vec
    p3: Vec
    hOut: Vec | null
    hIn: Vec | null
    startCont: Cont
    endCont: Cont
  }[] = []
  for (const tc of tour) {
    const c = tc.cand
    const p0 = dense[keyIdx[c.a]]
    const p3 = dense[keyIdx[(c.a + c.len) % m]]
    segs.push({
      p0,
      p3,
      hOut: c.line ? null : { x: c.c1.x, y: c.c1.y },
      hIn: c.line ? null : { x: c.c2.x, y: c.c2.y },
      startCont: c.startCont,
      endCont: c.endCont,
    })
  }

  const nodes: PathNode[] = []
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    const prev = segs[(s - 1 + segs.length) % segs.length]
    // The anchor at the start of this segment is shared with prev's end.
    const smooth = seg.startCont === 1 && prev.endCont === 1
    nodes.push({
      x: seg.p0.x,
      y: seg.p0.y,
      hIn: prev.hIn ? { x: prev.hIn.x, y: prev.hIn.y } : null,
      hOut: seg.hOut ? { x: seg.hOut.x, y: seg.hOut.y } : null,
      kind: smooth ? 'smooth' : 'corner',
    })
  }
  if (nodes.length < 2) return null
  return nodes
}

// ---------------------------------------------------------------------------
// Schneider single-cubic fit + line fit
// ---------------------------------------------------------------------------

interface CubicFit {
  c1: Vec
  c2: Vec
  maxDev: number
  sqErr: number
}

/**
 * Fit a SINGLE cubic Bézier to the open arc with prescribed unit end tangents
 * (tHat1 pointing into the arc at the start, tHat2 pointing into the arc at the
 * end), using Schneider's least-squares solve + a few Newton reparameterizations.
 * Returns the interior control points and the fit's max/squared deviation.
 */
export function fitSingleCubic(arc: Vec[], tHat1: Vec, tHat2: Vec): CubicFit {
  const n = arc.length
  const p0 = arc[0]
  const p3 = arc[n - 1]
  if (n === 2) {
    const d = dist(p0, p3) / 3
    return {
      c1: add(p0, scale(tHat1, d)),
      c2: add(p3, scale(tHat2, d)),
      maxDev: 0,
      sqErr: 0,
    }
  }
  let u = chordLengthParameterize(arc)
  let bez = generateBezier(arc, u, tHat1, tHat2)
  let err = cubicError(arc, bez, u)
  for (let it = 0; it < 4 && err.maxDev > 1e-9; it++) {
    const uPrime = u.map((ui, i) => newtonRaphson(bez, arc[i], ui))
    const b2 = generateBezier(arc, uPrime, tHat1, tHat2)
    const e2 = cubicError(arc, b2, uPrime)
    if (e2.maxDev >= err.maxDev) break
    u = uPrime
    bez = b2
    err = e2
  }
  return { c1: bez.c1, c2: bez.c2, maxDev: err.maxDev, sqErr: err.sqErr }
}

interface Bezier {
  p0: Vec
  c1: Vec
  c2: Vec
  p3: Vec
}

function generateBezier(d: Vec[], u: number[], tHat1: Vec, tHat2: Vec): Bezier {
  const n = d.length
  const A: [Vec, Vec][] = []
  for (let i = 0; i < n; i++) {
    A.push([
      scale(tHat1, 3 * u[i] * (1 - u[i]) * (1 - u[i])),
      scale(tHat2, 3 * u[i] * u[i] * (1 - u[i])),
    ])
  }
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < n; i++) {
    c00 += dot(A[i][0], A[i][0])
    c01 += dot(A[i][0], A[i][1])
    c11 += dot(A[i][1], A[i][1])
    const ui = u[i]
    const b0 = (1 - ui) ** 3
    const b1 = 3 * ui * (1 - ui) ** 2
    const b2 = 3 * ui * ui * (1 - ui)
    const b3 = ui ** 3
    const tmp = sub(d[i], add(scale(d[0], b0 + b1), scale(d[n - 1], b2 + b3)))
    x0 += dot(A[i][0], tmp)
    x1 += dot(A[i][1], tmp)
  }
  const det = c00 * c11 - c01 * c01
  let alphaL = 0
  let alphaR = 0
  if (Math.abs(det) > 1e-12) {
    alphaL = (x0 * c11 - x1 * c01) / det
    alphaR = (c00 * x1 - c01 * x0) / det
  }
  const segLength = dist(d[0], d[n - 1])
  const epsilon = 1e-6 * segLength
  if (alphaL < epsilon || alphaR < epsilon) {
    const d3 = segLength / 3
    return { p0: d[0], c1: add(d[0], scale(tHat1, d3)), c2: add(d[n - 1], scale(tHat2, d3)), p3: d[n - 1] }
  }
  return { p0: d[0], c1: add(d[0], scale(tHat1, alphaL)), c2: add(d[n - 1], scale(tHat2, alphaR)), p3: d[n - 1] }
}

/** Max + summed-squared deviation of arc points from the cubic at params u. */
function cubicError(d: Vec[], bez: Bezier, u: number[]): { maxDev: number; sqErr: number } {
  let maxD2 = 0
  let sq = 0
  for (let i = 0; i < d.length; i++) {
    const p = bezierAt(bez, u[i])
    const d2 = dist2(p, d[i])
    sq += d2
    if (d2 > maxD2) maxD2 = d2
  }
  return { maxDev: Math.sqrt(maxD2), sqErr: sq }
}

function newtonRaphson(bez: Bezier, point: Vec, u: number): number {
  const q = bezierAt(bez, u)
  const q1 = [scale(sub(bez.c1, bez.p0), 3), scale(sub(bez.c2, bez.c1), 3), scale(sub(bez.p3, bez.c2), 3)]
  const q2 = [scale(sub(q1[1], q1[0]), 2), scale(sub(q1[2], q1[1]), 2)]
  const qu = bezier2At(q1, u)
  const quu = bezier1At(q2, u)
  const num = (q.x - point.x) * qu.x + (q.y - point.y) * qu.y
  const den = qu.x * qu.x + qu.y * qu.y + (q.x - point.x) * quu.x + (q.y - point.y) * quu.y
  if (Math.abs(den) < 1e-12) return u
  let next = u - num / den
  if (next < 0) next = 0
  else if (next > 1) next = 1
  return next
}

function chordLengthParameterize(d: Vec[]): number[] {
  const u = [0]
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + dist(d[i], d[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((v) => v / total)
}

function bezierAt(b: Bezier, t: number): Vec {
  const mt = 1 - t
  const a = mt * mt * mt
  const c = 3 * mt * mt * t
  const e = 3 * mt * t * t
  const g = t * t * t
  return {
    x: a * b.p0.x + c * b.c1.x + e * b.c2.x + g * b.p3.x,
    y: a * b.p0.y + c * b.c1.y + e * b.c2.y + g * b.p3.y,
  }
}
function bezier2At(p: Vec[], t: number): Vec {
  const mt = 1 - t
  return { x: mt * mt * p[0].x + 2 * mt * t * p[1].x + t * t * p[2].x, y: mt * mt * p[0].y + 2 * mt * t * p[1].y + t * t * p[2].y }
}
function bezier1At(p: Vec[], t: number): Vec {
  return { x: (1 - t) * p[0].x + t * p[1].x, y: (1 - t) * p[0].y + t * p[1].y }
}

// ---------------------------------------------------------------------------
// Line / circle fits (for tangents, soft-corner, and line candidates)
// ---------------------------------------------------------------------------

interface LineFit {
  dir: Vec
  maxDev: number
  rms: number
}

/** Total-least-squares line through points; direction + max/RMS deviation. */
export function lineFit(pts: Vec[]): LineFit | null {
  const n = pts.length
  if (n < 2) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (const p of pts) {
    const dx = p.x - mx
    const dy = p.y - my
    sxx += dx * dx
    syy += dy * dy
    sxy += dx * dy
  }
  // Principal axis = eigenvector of the covariance for the larger eigenvalue.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  const dir = { x: Math.cos(theta), y: Math.sin(theta) }
  // Deviations: perpendicular distance to the line through (mx,my) along dir.
  const nx = -dir.y
  const ny = dir.x
  let maxD = 0
  let sq = 0
  for (const p of pts) {
    const d = Math.abs((p.x - mx) * nx + (p.y - my) * ny)
    sq += d * d
    if (d > maxD) maxD = d
  }
  return { dir, maxDev: maxD, rms: Math.sqrt(sq / n) }
}

/** Max deviation of points from their least-squares circle; null if collinear. */
function circleMaxDev(pts: Vec[]): number | null {
  const c = fitCircle(pts)
  if (!c) return null
  let maxD = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
    if (d > maxD) maxD = d
  }
  return maxD
}

/** Kåsa/Coope centred algebraic circle fit; null on a degenerate config. */
function fitCircle(pts: Vec[]): { cx: number; cy: number; r: number } | null {
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

/** Max + summed-squared perpendicular deviation of an arc from its chord. */
function lineDeviation(arc: Vec[]): { maxDev: number; sqErr: number } {
  const a = arc[0]
  const b = arc[arc.length - 1]
  let maxD = 0
  let sq = 0
  for (let i = 1; i < arc.length - 1; i++) {
    const d = perpDistance(arc[i], a, b)
    sq += d * d
    if (d > maxD) maxD = d
  }
  return { maxDev: maxD, sqErr: sq }
}

// ---------------------------------------------------------------------------
// Loop helpers + small vector math
// ---------------------------------------------------------------------------

/** Drop consecutive duplicate points and any closing duplicate. */
function dedupLoop(loop: Vec[]): Vec[] {
  const out: Vec[] = []
  for (const p of loop) {
    const last = out[out.length - 1]
    if (!last || dist2(last, p) > 1e-12) out.push({ x: p.x, y: p.y })
  }
  while (out.length > 1 && dist2(out[0], out[out.length - 1]) <= 1e-12) out.pop()
  return out
}

/** Dense points from index `from` forward to `to` (inclusive), cyclic. */
function denseArc(dense: Vec[], from: number, to: number): Vec[] {
  const n = dense.length
  const out: Vec[] = []
  let i = from
  while (true) {
    out.push(dense[i])
    if (i === to) break
    i = (i + 1) % n
  }
  return out
}

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s })
const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y })
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
function unit(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}
function perpDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return dist(p, a)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}
