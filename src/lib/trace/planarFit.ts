// Phase 2 of the planar tracer: fit each PlanarEdge's lattice staircase polyline
// to a low-node chain of lines / cubic Béziers, ONCE. Junction endpoints are
// pinned (so the two edges meeting there share an exact anchor) and forced to
// corner. Reuses the crisp tracer's stable numerics — `fitSingleCubic` (Schneider
// + Newton) and `lineFit` from curveFit.ts — wrapped in an OPEN (acyclic) RDP +
// evidence-based corner score + linear DP that mirror fitClosedLoop's recipe
// without its cyclic wraparound. Pure-loop edges reuse `fitClosedLoop` directly.
//
// The crisp tracer gets smoothness from a coverage-field Gaussian before marching
// squares; a crack polyline has none, so we pre-smooth the interior (endpoints
// pinned) to melt the 90° staircase, and let the ε cubic-fit tolerance absorb the
// residual. Pure & deterministic (fixed iteration counts, no PRNG).

import type { PathNode, Vec } from '../path/types'
import { fitClosedLoop, fitSingleCubic, junctionCosts, lineFit, type CurveFitOptions } from './curveFit.ts'

export interface PlanarFitOptions {
  /** Curve-fit tolerance ε (px): RDP + cubic-discard, as in the crisp tracer. */
  epsilon: number
  /** Pre-smoothing passes over the staircase (endpoints pinned). */
  smoothPasses: number
  lineCost: number
  cubicCost: number
  /**
   * Macro-turn angle (deg) above which an interior staircase vertex is a CORNER and
   * is PINNED through pre-smoothing — so a sharp valley/point isn't melted into a
   * curve before the fitter sees it. 60° = the ONE definition of "sharp" the whole
   * pipeline shares (geomScore.sharpCorners and planarBeautify's CORNER_TURN both
   * call ≥60° a corner; the detector demanding 70° made every 60–70° authored
   * corner structurally invisible — gear-teeth's 67.3° roots, §10.6). Smooth shapes
   * stay untouched: even at 60° a clean arc trips the ±4px window only below
   * ~7.6px local radius, and a tiny closed blob collapses to <2 apexes, which the
   * cornered path already rejects. ≥180 disables (pre-smoothing pins only
   * endpoints, the legacy behaviour — used to assert byte-identity).
   */
  cornerTurnDeg: number
  /**
   * EXPERIMENTAL (off by default). Place each junction VERTEX at the sub-pixel
   * intersection of its incident edge arms instead of the integer lattice corner,
   * and weld two edges a region runs straight THROUGH a junction to a shared G¹
   * tangent (planarJunction.ts). An alternative to the co-circular arc snap (§1d)
   * for the ring "pull"; measured weaker + corpus-moving, kept behind this flag for
   * the Test view A/B. `false` ⇒ raw integer-lattice junctions (the shipped path).
   *
   * Re-measured against GROUND TRUTH 2026-07-14 (docs/vectorization-benchmarks.md
   * §9.3): a tradeoff, not a win — helps cross-bars/gradient-flat, hurts
   * aa-seam/bloom/petals; 10 better vs 14 worse on the 106 flat twins. Stays off.
   */
  refineJunctions: boolean
  /**
   * Co-circular open-arc snap (planarBeautify §1d): a ring split into arcs by band
   * junctions snaps to ONE circle so it stops kinking. On by default (it rides the
   * fidelity dial). `false` disables it — the pre-1d baseline, for the Test view A/B.
   */
  arcSnap: boolean
  /**
   * Junction re-seat (planarReseat.ts, §10.4): a degree-3 junction that SLID along
   * a near-tangent boundary crossing (the label map's colour needle is sub-pixel
   * thin there, so the lattice junction lands px away from the true crossing) is
   * moved to the intersection of its two strongest incident fitted primitives, and
   * the mangled terminal caps are re-emitted from those primitives. On by default
   * (rides the fidelity dial with the rest of planarBeautify); `false` disables —
   * the pre-§10.4 baseline, for the Test view A/B.
   */
  junctionReseat: boolean
  /**
   * EXPERIMENTAL scale-relative fidelity (§10 prototype; 0 = off = byte-identical).
   * The circle / ellipse / co-circular SNAP gates in planarBeautify accept a
   * primitive on RADIAL deviation ≤ `fidelity` — a purely SIZE-relative test, which
   * is exactly why an 8px checker cell (0.83px from its best-fit circle) rounds into
   * a blob (§9.8). When > 0, each snap's tolerance becomes
   * `min(fidelity, localScaleK · localScale)`, where `localScale` is the fitted
   * primitive's own radius — the disc/ring's medial radius, cheaply on hand. A big
   * shape keeps the full fidelity budget; a tiny one is held to a fraction of its own
   * size, so a small square's 0.83px deviation exceeds `k·r` and never snaps. This is
   * the concrete `ε_local = min(ε_abs, k·localScale)` of §10, realized for the snaps.
   */
  localScaleK: number
  /**
   * §14 contrast rank (default true). Where a WEAK colour boundary (a posterization
   * band seam) ends on a STRONG one that continues through, fit the strong boundary
   * THROUGH the junction as one chain and split the fitted curve at the junction's
   * projected position — instead of pinning a 100+px edge to the band seam's integer
   * lattice corner (planarThread.ts). Needs the palette: without one, or with this
   * false, nothing threads and the fit is byte-identical to the pre-§14 tracer.
   */
  fitThrough: boolean
  /**
   * EXPERIMENTAL (default true = the shipped §9.8 behaviour). The corner-turn veto in
   * planarBeautify that refuses to round a sharp-cornered loop (a checker cell's four
   * right angles) into a disc. Exposed so the scale-relative-ε prototype
   * (`localScaleK`) can be A/B'd as a REPLACEMENT for the veto — §10 claims a full
   * scale-relative ε SUBSUMES it. Leave true in production.
   */
  cornerVeto: boolean
}

export const DEFAULT_PLANAR_FIT: PlanarFitOptions = {
  epsilon: 1.0,
  smoothPasses: 2,
  // Conservative line/cubic balance (line marginally cheaper). The FLAT path bumps
  // lineCost above cubicCost in planarFitOptionsFor to de-facet curves; gradient
  // art keeps this value (the bump worsened the headphones-grad seam past tol).
  lineCost: 3.9,
  cubicCost: 4,
  cornerTurnDeg: 60,
  refineJunctions: false,
  arcSnap: true,
  junctionReseat: true,
  localScaleK: 0,
  cornerVeto: true,
  fitThrough: true,
}

/** Flat-art line cost: > cubicCost so the DP prefers a CUBIC on any span where a
 *  cubic fits within ε — borderline-curved spans become smooth cubics instead of
 *  kinked chords (Affinity ~14 lines vs our old ~67). ε-bounded ⇒ fidelity-safe;
 *  measured −24 chords on Schild at identical ΔE/SSIM/node-count. ≥4.5 saturates. */
export const FLAT_LINE_COST = 4.5

const MAX_SPAN = 20
const MAX_FIT_POINTS = 64
const MAX_EVIDENCE_WINDOW = 24
/** ±px window the macro-turn corner test looks across (spans the unit staircase). */
const CORNER_WINDOW = 4
/** Apex-merge distance for the loop/open corner detectors (§10.6): sits between
 *  the two scales it must separate — ABOVE a rasterized tip's shoulder pair
 *  (≤ ~2px), BELOW the smallest corner spacing the corpus asks the tracer to keep
 *  (gear-teeth's 7.5px chords). At the old 5 it fused real corner pairs 3–5px
 *  apart; 3 measured +5 recovered corners on gear-teeth, no spurious apexes. */
const CORNER_MERGE = 3

// --- vector helpers ---------------------------------------------------------
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y })
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

/** Drop consecutive duplicate points (keeps endpoints). */
function dedup(pts: Vec[]): Vec[] {
  const out: Vec[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || dist2(last, p) > 1e-12) out.push({ x: p.x, y: p.y })
  }
  return out
}

/**
 * Pre-smooth a polyline to melt the unit staircase. `pinEnds` keeps the first &
 * last point fixed (junction anchors); a closed loop smooths cyclically. `pinned`
 * holds extra indices that must NOT move — the detected sharp corners, so they
 * survive the melt. A few fixed passes of a [0.25, 0.5, 0.25] window —
 * deterministic, endpoint-preserving.
 */
export function presmooth(pts: Vec[], passes: number, pinEnds: boolean, pinned?: ReadonlySet<number>): Vec[] {
  if (pts.length < 3 || passes <= 0) return pts.map((p) => ({ x: p.x, y: p.y }))
  let cur = pts.map((p) => ({ x: p.x, y: p.y }))
  const n = cur.length
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.map((p) => ({ x: p.x, y: p.y }))
    const lo = pinEnds ? 1 : 0
    const hi = pinEnds ? n - 1 : n
    for (let i = lo; i < hi; i++) {
      if (pinned && pinned.has(i)) continue
      const a = cur[(i - 1 + n) % n]
      const b = cur[i]
      const c = cur[(i + 1) % n]
      next[i] = { x: 0.25 * a.x + 0.5 * b.x + 0.25 * c.x, y: 0.25 * a.y + 0.5 * b.y + 0.25 * c.y }
    }
    cur = next
  }
  return cur
}

/**
 * Indices of MACRO corners on a lattice staircase: vertices where the path
 * direction turns by more than `turnDeg`, measured over a ±`win` px window so the
 * unit stair-steps of a straight diagonal (constant macro direction) are NOT
 * corners but a genuine sharp valley/point IS. Non-max-suppressed within the
 * window. `closed` wraps the windows; otherwise the endpoint region (already
 * pinned by `presmooth`) is skipped. A smooth shape — even a tiny circle — returns
 * ∅ at the default threshold, so its pre-smoothing is unchanged. `turnDeg ≥ 180`
 * ⇒ ∅ (corner pinning disabled).
 */
export function detectCorners(
  pts: Vec[],
  turnDeg: number,
  closed: boolean,
  win = CORNER_WINDOW,
): Set<number> {
  const out = new Set<number>()
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return out
  const wrap = (i: number): number => ((i % n) + n) % n
  const before = (i: number): Vec => (closed ? pts[wrap(i - win)] : pts[Math.max(0, i - win)])
  const after = (i: number): Vec => (closed ? pts[wrap(i + win)] : pts[Math.min(n - 1, i + win)])
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const cos = new Float64Array(n)
  cos.fill(1)
  const lo = closed ? 0 : win
  const hi = closed ? n : n - win
  for (let i = lo; i < hi; i++) {
    const inDir = unit(sub(pts[i], before(i)))
    const outDir = unit(sub(after(i), pts[i]))
    cos[i] = inDir.x * outDir.x + inDir.y * outDir.y
  }
  for (let i = lo; i < hi; i++) {
    if (cos[i] >= thr) continue // not sharp enough
    let isLocalMin = true
    for (let j = i - win; j <= i + win; j++) {
      const k = closed ? wrap(j) : j
      if (k === i || (!closed && (k < lo || k >= hi))) continue
      if (cos[k] < cos[i]) {
        isLocalMin = false
        break
      }
    }
    if (isLocalMin) out.add(wrap(i))
  }
  return out
}

// --- open Ramer–Douglas–Peucker (endpoints always kept) ---------------------
function openRDP(pts: Vec[], eps: number): number[] {
  const n = pts.length
  if (n <= 2) return pts.map((_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    const a = pts[lo]
    const b = pts[hi]
    let maxD = -1
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(pts[i], a, b)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > eps && idx >= 0) {
      keep[idx] = 1
      stack.push([lo, idx], [idx, hi])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

// --- evidence-based corner score over an OPEN arc (clamped windows) ---------
/** Points dense[i-k .. i+k] clamped to [0, n-1] (side<0: i-k..i, side>0: i..i+k). */
function windowClamped(dense: Vec[], i: number, k: number, side = 0): Vec[] {
  const n = dense.length
  const lo = Math.max(0, side > 0 ? i : i - k)
  const hi = Math.min(n - 1, side < 0 ? i : i + k)
  const out: Vec[] = []
  for (let o = lo; o <= hi; o++) out.push(dense[o])
  return out
}

/** Least-squares circle through `pts` (Kasa), or null when degenerate. Exported for
 *  the §14 continuation test. */
export function fitCircle(pts: Vec[]): { cx: number; cy: number; r: number } | null {
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
  let uu = 0, vv = 0, uv = 0, uuu = 0, vvv = 0, uvv = 0, vuu = 0
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
/** Max radial deviation of `pts` from their best-fit circle (null when degenerate).
 *  Exported for the §14 continuation test — "does this boundary curve SMOOTHLY
 *  through the junction" is the same question the evidence score asks locally. */
export function circleMaxDev(pts: Vec[]): number | null {
  const c = fitCircle(pts)
  if (!c) return null
  let maxD = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
    if (d > maxD) maxD = d
  }
  return maxD
}
function coverage(dense: Vec[], i: number, eps: number, kind: 'line' | 'circle' | 'wedge'): number {
  const kMax = Math.min(dense.length, MAX_EVIDENCE_WINDOW)
  let cover = 1
  for (let k = 1; k <= kMax; k++) {
    if (kind === 'wedge') {
      const lf = lineFit(windowClamped(dense, i, k, -1))
      const rf = lineFit(windowClamped(dense, i, k, 1))
      if (!lf || !rf) break
      if (Math.max(lf.maxDev, rf.maxDev) > eps) break
    } else if (kind === 'circle') {
      const dev = circleMaxDev(windowClamped(dense, i, k))
      if (dev !== null && dev > eps) break
    } else {
      const fit = lineFit(windowClamped(dense, i, k))
      if (!fit) break
      if (fit.maxDev > eps) break
    }
    cover = 2 * k + 1
  }
  return cover
}
function softF(x: number): number {
  return 1 - 1 / (1 + 5 * (x - 1))
}
/** c ∈ [−1 smooth … +1 corner] at open-arc index i (mirrors cornerScoreAtIndex). */
function openCornerScore(dense: Vec[], i: number, eps: number): number {
  const L = coverage(dense, i, eps, 'line')
  const S = coverage(dense, i, eps, 'circle')
  const C = coverage(dense, i, eps, 'wedge')
  if (L >= S) return -L / Math.max(L, C)
  if (S >= C) return -softF((S + 1) / (C + 1))
  return softF((C + 1) / (S + 1))
}

/** One-sided tangent at an open-arc index, oriented forward (toward +i). */
function openTangent(dense: Vec[], i: number, eps: number): Vec {
  const n = dense.length
  const half = eps / 2
  const fwd = unit(sub(dense[Math.min(n - 1, i + 1)], dense[Math.max(0, i - 1)]))
  let best = fwd
  const kMax = Math.min(n, MAX_EVIDENCE_WINDOW)
  for (let k = 1; k <= kMax; k++) {
    const fit = lineFit(windowClamped(dense, i, k))
    if (!fit) break
    if (fit.rms > half) break
    best = fit.dir
  }
  return best.x * fwd.x + best.y * fwd.y < 0 ? neg(best) : best
}

// --- candidates + open DP ---------------------------------------------------
type Cont = 0 | 1
interface Candidate {
  a: number
  len: number
  line: boolean
  startCont: Cont
  endCont: Cont
  cost: number
  c1: Vec
  c2: Vec
}

function orient(t: Vec, ref: Vec): Vec {
  return t.x * ref.x + t.y * ref.y < 0 ? neg(t) : t
}
function subsample(arc: Vec[], cap: number): Vec[] {
  const n = arc.length
  if (n <= cap) return arc
  const out: Vec[] = []
  for (let i = 0; i < cap - 1; i++) out.push(arc[Math.floor((i * (n - 1)) / (cap - 1))])
  out.push(arc[n - 1])
  return out
}
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

/**
 * Fit an OPEN dense polyline (junction→junction) to PathNodes. Endpoints are
 * pinned and forced to corner; interior joins choose corner vs smooth from the
 * evidence score via a min-cost linear DP over an over-complete candidate set.
 */
export function fitOpenArc(densePts: Vec[], opts: PlanarFitOptions): PathNode[] {
  const dense = dedup(densePts)
  const n = dense.length
  if (n < 2) return []
  if (n === 2) {
    return [
      { x: dense[0].x, y: dense[0].y, hIn: null, hOut: null, kind: 'corner' },
      { x: dense[1].x, y: dense[1].y, hIn: null, hOut: null, kind: 'corner' },
    ]
  }
  const eps = opts.epsilon
  const keyIdx = openRDP(dense, eps)
  const m = keyIdx.length
  if (m < 2) {
    return [
      { x: dense[0].x, y: dense[0].y, hIn: null, hOut: null, kind: 'corner' },
      { x: dense[n - 1].x, y: dense[n - 1].y, hIn: null, hOut: null, kind: 'corner' },
    ]
  }
  const tangents = keyIdx.map((i) => openTangent(dense, i, eps))
  const scores = keyIdx.map((i) => openCornerScore(dense, i, eps))
  const junc = scores.map(junctionCosts)
  const delta = 1e-6 * eps

  // Candidate set: a line between adjacent key vertices, plus cubics between any
  // pair (≤ MAX_SPAN) for the four C⁰/G¹ endpoint combos, each discarded if its
  // deviation exceeds ε.
  const byStart: Candidate[][] = Array.from({ length: m }, () => [])
  for (let a = 0; a < m; a++) {
    const fromIdx = keyIdx[a]
    const maxLen = Math.min(m - 1 - a, MAX_SPAN)
    for (let len = 1; len <= maxLen; len++) {
      const b = a + len
      const toIdx = keyIdx[b]
      const arc = subsample(dense.slice(fromIdx, toIdx + 1), MAX_FIT_POINTS)
      if (arc.length < 2) break
      if (len === 1) {
        const ld = lineDeviation(arc)
        if (ld.maxDev <= eps) {
          byStart[a].push({ a, len, line: true, startCont: 0, endCont: 0, cost: opts.lineCost + delta * ld.sqErr, c1: arc[0], c2: arc[arc.length - 1] })
        }
      }
      const freeStart = unit(sub(dense[fromIdx + 1], dense[fromIdx]))
      const freeEnd = unit(sub(dense[toIdx - 1], dense[toIdx]))
      const startDirs: [Cont, Vec][] = [
        [0, freeStart],
        [1, orient(tangents[a], freeStart)],
      ]
      const endDirs: [Cont, Vec][] = [
        [0, freeEnd],
        [1, orient(neg(tangents[b]), freeEnd)],
      ]
      let interG1 = 0
      for (let p = 1; p < len; p++) interG1 += junc[a + p].g1
      let anyFit = false
      for (const [sc, sd] of startDirs) {
        for (const [ec, ed] of endDirs) {
          const fit = fitSingleCubic(arc, sd, ed)
          if (fit.maxDev > eps) continue
          anyFit = true
          byStart[a].push({ a, len, line: false, startCont: sc, endCont: ec, cost: opts.cubicCost + delta * fit.sqErr + interG1, c1: fit.c1, c2: fit.c2 })
        }
      }
      if (!anyFit && len > 1) break
    }
  }

  // Open linear DP. dp[p][cont] = min cost to reach key-vertex p arriving with
  // continuity `cont`. Endpoints (0 and m-1) are corners: the first candidate
  // starts C⁰, the last ends C⁰.
  const INF = Infinity
  const cost: number[][] = Array.from({ length: m }, () => [INF, INF])
  const back: ({ from: number; fromCont: Cont; cand: Candidate } | null)[][] = Array.from({ length: m }, () => [null, null])
  cost[0][0] = 0
  for (let p = 0; p < m - 1; p++) {
    for (const tin of [0, 1] as Cont[]) {
      const base = cost[p][tin]
      if (!Number.isFinite(base)) continue
      for (const c of byStart[p]) {
        const isFirst = p === 0
        let jcost = 0
        if (isFirst) {
          if (c.startCont !== 0) continue // endpoint is a forced corner
        } else {
          jcost = tin === 1 && c.startCont === 1 ? junc[p].g1 : junc[p].c0
        }
        const q = p + c.len
        if (q > m - 1) continue
        const total = base + jcost + c.cost
        if (total < cost[q][c.endCont]) {
          cost[q][c.endCont] = total
          back[q][c.endCont] = { from: p, fromCont: tin, cand: c }
        }
      }
    }
  }
  // Final endpoint must arrive as a corner (endCont 0).
  let endCont: Cont = 0
  if (!Number.isFinite(cost[m - 1][0])) {
    if (!Number.isFinite(cost[m - 1][1])) return polylineNodes(keyIdx, dense) // fallback: corner polyline
    endCont = 1
  }

  // Reconstruct the chosen candidates (forward order).
  const chosen: Candidate[] = []
  let p = m - 1
  let t: Cont = endCont
  while (p > 0) {
    const b = back[p][t]
    if (!b) break
    chosen.push(b.cand)
    p = b.from
    t = b.fromCont
  }
  chosen.reverse()
  if (chosen.length === 0) return polylineNodes(keyIdx, dense)

  // Materialize to OPEN PathNodes (no wrap). Anchor i shared between seg i-1/i.
  const segs = chosen.map((c) => ({
    p0: dense[keyIdx[c.a]],
    p3: dense[keyIdx[c.a + c.len]],
    hOut: c.line ? null : { x: c.c1.x, y: c.c1.y },
    hIn: c.line ? null : { x: c.c2.x, y: c.c2.y },
    startCont: c.startCont,
    endCont: c.endCont,
  }))
  const nodes: PathNode[] = []
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    const prev = s > 0 ? segs[s - 1] : null
    const smooth = prev !== null && seg.startCont === 1 && prev.endCont === 1
    nodes.push({
      x: seg.p0.x,
      y: seg.p0.y,
      hIn: prev && prev.hIn ? { x: prev.hIn.x, y: prev.hIn.y } : null,
      hOut: seg.hOut ? { x: seg.hOut.x, y: seg.hOut.y } : null,
      kind: smooth ? 'smooth' : 'corner',
    })
  }
  // Final endpoint anchor.
  const lastSeg = segs[segs.length - 1]
  nodes.push({
    x: lastSeg.p3.x,
    y: lastSeg.p3.y,
    hIn: lastSeg.hIn ? { x: lastSeg.hIn.x, y: lastSeg.hIn.y } : null,
    hOut: null,
    kind: 'corner',
  })
  return nodes
}

/** Fallback: straight polyline through the key vertices, all corners. */
function polylineNodes(keyIdx: number[], dense: Vec[]): PathNode[] {
  return keyIdx.map((i) => ({ x: dense[i].x, y: dense[i].y, hIn: null, hOut: null, kind: 'corner' as const }))
}

// --- sharp-corner CLOSED-loop fitting (anti-bevel) --------------------------
// `detectCorners` + corner-pinned presmooth keep a sharp apex from being MELTED,
// but the closed-loop fitter (fitClosedLoop) still places its key vertices on the
// rounded staircase AROUND a tip — two nodes straddling the apex with a short
// segment cutting across it (a visible bevel; the apex itself is never a node).
// For a loop that has ≥2 genuine sharp corners we instead localize each corner to
// its sub-pixel APEX (the intersection of its two arms), split the loop there, and
// fit each arc as an OPEN arc pinned at the snapped corners — so every corner is
// one exact sharp node. Smooth loops (circles, gradient blobs) have <2 corners and
// never take this path, so their fit is unchanged.

const SNAP_GAP = 3 // skip this many px nearest the tip (the rounded part) per arm
const SNAP_SPAN = 14 // …and fit the arm line over up to this many px beyond the gap

/**
 * SCALE-AWARE snap gap (§10.6): the fixed 3px gap is right for a long arm (skip
 * the AA-rounded tip, plenty of evidence beyond), but on a SHORT inter-corner arc
 * it discards most of the arm — a gear tooth's ~8-step chord keeps only ~5
 * phase-noise samples, and the fitted arm line misplaces the apex 2.6–4.4px (past
 * the scorer's 2.5px radius). The gap scales with the arc so short arms keep their
 * evidence: ≥13 steps keep the full 3px gap (long-arm behaviour byte-identical);
 * an 8-step chord drops to gap 1. The erosion risk the gap guards against shrinks
 * with the same scale — a corner whose arms are that short has sub-px rounding.
 */
function armGap(steps: number): number {
  return Math.min(SNAP_GAP, Math.max(1, ((steps - 1) / 4) | 0))
}

/**
 * SCALE-AWARE smoothing for an inter-corner arc (§10.6): presmooth exists to melt
 * a LONG staircase before fitting; a short arc between two snapped corners has
 * almost no staircase to melt, and each pass bends its few interior points inward
 * — the fitted end tangents rotate with them, and a 67° authored joint reads
 * < 60° (not-a-corner) off geometry the smoothing invented. Full passes from 16
 * points up (long-arc behaviour unchanged), one pass down to 9, raw below.
 */
function arcSmoothPasses(passes: number, arcLen: number): number {
  return arcLen >= 16 ? passes : arcLen >= 9 ? Math.min(passes, 1) : 0
}

/** A straight arm may extend its sample window this far (see armSamples). */
const SNAP_SPAN_MAX = 40
/** Max perp deviation (px) for an extension point to count as "still the same
 *  straight arm" — just above the ±0.5px staircase quantization. */
const SNAP_COLLINEAR = 0.75

/** Least-squares line through `pts` → a point on it (`c`) and a unit direction (`d`). */
export function armLine(pts: Vec[]): { c: Vec; d: Vec } {
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= pts.length
  my /= pts.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of pts) {
    const dx = p.x - mx
    const dy = p.y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { c: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } }
}

/**
 * Sub-pixel position of the corner at cyclic index `c`: intersect the two lines
 * fit to the arms flanking it (each sampled [gap..span] px away so the rounded tip
 * is excluded). `inSpan`/`outSpan` are capped by the caller so a short arc between
 * two close corners doesn't bleed past the neighbour. Returns the raw lattice
 * corner when the arms are near-parallel or the intersection runs away (a curved
 * arm), so a bad fit can never push the apex off into space.
 */
function snapCornerToArms(pts: Vec[], c: number, inGap: number, outGap: number, inSpan: number, outSpan: number, inMax = 0, outMax = 0): Vec {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  // Base window [gap..span], then extend up to `max` while the arm stays COLLINEAR.
  // A 1-in-14 staircase (a shallow star tip, slope ~0.07) shows less than ONE unit
  // step inside the base window, so its fitted slope is pure step-phase noise — and
  // at a ~4° tip angle every slope error multiplies ~1/tan(4°) ≈ 14× into AXIAL apex
  // error (the 2.78px left-tip overshoot). Straight arms earn the longer window
  // (3 steps nail the slope); a curved arm fails the collinearity test at its first
  // extension and keeps the base window, so ring/blob corners are unmoved.
  // Gaps are per-side (armGap): a short inter-corner arc keeps its evidence.
  const collect = (sign: -1 | 1, gap: number, span: number, max: number): Vec[] => {
    const out: Vec[] = []
    for (let o = gap; o <= span; o++) out.push(pts[wrap(c + sign * o)])
    let line = out.length >= 2 ? armLine(out) : null
    for (let o = span + 1; line && o <= max; o++) {
      const p = pts[wrap(c + sign * o)]
      const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
      if (dev > SNAP_COLLINEAR) break
      out.push(p)
      line = armLine(out)
    }
    return out
  }
  // SHORT-ARM bypass (§10.6): reconstruction (arm-line intersection) exists to
  // recover an apex the raster ERODED — a shallow tip whose true corner sits px
  // past the lattice. It needs arm evidence to earn that (slope error divides by
  // tan(tip angle)). A corner whose neighbours sit < ~8 steps away has arms too
  // short to fit and erosion too small to matter: its RAW cluster apex is already
  // sub-px correct (gear-teeth measured median 0.99px), while the reconstruction
  // from 3–5 phase-noise samples lands 2.6–7.9px off. Keep the lattice apex.
  // (The threshold was SWEPT: raising it to 11/14 collapses recall to 57–62% —
  // medium arms genuinely profit from reconstruction; only the shortest do not.)
  if (Math.min(inSpan, outSpan) < SNAP_GAP + 4) return { x: pts[c].x, y: pts[c].y }
  const inPts = collect(-1, inGap, inSpan, inMax)
  const outPts = collect(1, outGap, outSpan, outMax)
  if (inPts.length < 2 || outPts.length < 2) return { x: pts[c].x, y: pts[c].y }
  const a = armLine(inPts)
  const b = armLine(outPts)
  const det = a.d.x * -b.d.y - a.d.y * -b.d.x
  if (Math.abs(det) < 1e-6) return { x: pts[c].x, y: pts[c].y }
  const rx = b.c.x - a.c.x
  const ry = b.c.y - a.c.y
  const t = (rx * -b.d.y - ry * -b.d.x) / det
  const ix = a.c.x + t * a.d.x
  const iy = a.c.y + t * a.d.y
  // SCALE-AWARE displacement cap (§10.6): how far the reconstructed apex may move
  // off the lattice corner is bounded by the EVIDENCE. A long-armed corner (an
  // eroded shallow star tip) legitimately reconstructs several px past the lattice
  // vertex and its arm fits have the samples to earn that. A SHORT-armed corner is
  // the opposite on both counts: its arm lines are phase-noise (the intersection
  // wanders px off a corner whose raw vertex is already sub-px correct — a gear
  // tooth's lattice corner beats its own reconstruction), and a corner that small
  // carries sub-px erosion, so there is nothing to reconstruct. Past the cap we
  // keep the lattice corner.
  const shortSpan = Math.min(inSpan, outSpan)
  const allow = shortSpan >= SNAP_SPAN ? Math.max(inSpan, outSpan) : Math.max(2, 0.5 * shortSpan)
  if (dist({ x: ix, y: iy }, pts[c]) > allow) return { x: pts[c].x, y: pts[c].y }
  return { x: ix, y: iy }
}

/**
 * Indices of the sharp corners on a CLOSED staircase loop — ONE per corner. The
 * same ±`win` macro-turn test as `detectCorners`, but each cluster of sub-threshold
 * vertices is collapsed to its geometric APEX (the vertex farthest from its window
 * chord), and apexes within `mergeDist` px fuse (a rasterized tip is often a 1-px
 * plateau = two "shoulder" vertices, possibly split across the loop seam). Sorted
 * ascending. `turnDeg ≥ 180` ⇒ ∅ (disabled). See CORNER_MERGE for why the fuse
 * distance is 3. (Two §10.6 variants were tried and MEASURED WORSE on the real
 * pipeline: a two-scale win∪win−1 apex union — extra fine apexes poison their
 * neighbours' fitted tangents — and a ±2px fine-turn apex re-localization — a
 * staircase reads ~90° at ordinary step vertices too.)
 */
export function detectLoopCorners(pts: Vec[], turnDeg: number, win = CORNER_WINDOW, mergeDist = CORNER_MERGE): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const cos = new Float64Array(n)
  cos.fill(1)
  for (let i = 0; i < n; i++) {
    const inDir = unit(sub(pts[i], pts[wrap(i - win)]))
    const outDir = unit(sub(pts[wrap(i + win)], pts[i]))
    cos[i] = inDir.x * outDir.x + inDir.y * outDir.y
  }
  // Cluster consecutive sub-threshold (sharp) vertices; apex = max perp-to-chord.
  const used = new Uint8Array(n)
  const apexes: number[] = []
  for (let s = 0; s < n; s++) {
    if (cos[s] >= thr || used[s]) continue
    let best = s
    let bestDev = -1
    let i = s
    while (cos[wrap(i)] < thr && !used[wrap(i)]) {
      const k = wrap(i)
      used[k] = 1
      const dev = perpDistance(pts[k], pts[wrap(k - win)], pts[wrap(k + win)])
      if (dev > bestDev) {
        bestDev = dev
        best = k
      }
      i++
    }
    apexes.push(best)
  }
  apexes.sort((a, b) => a - b)
  if (apexes.length < 2) return apexes
  // Fuse near-coincident apexes (consecutive, plus the cyclic first/last pair).
  const merged: number[] = []
  for (const a of apexes) {
    const last = merged[merged.length - 1]
    if (last !== undefined && dist(pts[a], pts[last]) <= mergeDist) continue
    merged.push(a)
  }
  if (merged.length >= 2 && dist(pts[merged[0]], pts[merged[merged.length - 1]]) <= mergeDist) merged.pop()
  return merged
}

/**
 * BAR-END CAP resolver (§0 #6b). Inside a cap narrower than ~2·CORNER_WINDOW the
 * ±win turn test cannot separate the two 90° shoulders: every vertex on the cap
 * sees BOTH shoulders through the window and reads a diluted 60–90° turn, so the
 * sub-threshold run structure — and with it the apex count and placement — is
 * staircase-phase lottery. Measured on the bar-caps rack @512 (capDiag.ts): a 7px
 * cap emits 1 apex (the far corner bevels away), 3 apexes (each fitted node
 * carries only 38–52° of the cap's turn — present but blunt, the exact failure
 * §10.6 rejected the two-scale union for), or 2 apexes a px off the corners
 * (cubic end-tangent wobble on the ≤7px arc reads 45° at a true corner).
 *
 * The resolver re-reads each apex GROUP (sub-threshold runs joined across gaps
 * ≤ joinGap) and classifies it as a CAP on three pieces of evidence:
 *   • through-turn: travel direction REVERSES across the group (≥ throughDeg —
 *     a bar end U-turns; a gear root→tip zigzag nets ~13° and never qualifies);
 *   • chord: the group spans a cap-sized chord (chordMin..chordMax px — a
 *     rasterized tip plateau is ≤2px and stays a tip; an 8px+ cap or a checker
 *     cell edge already resolves into two clean shoulder runs and is left alone);
 *   • flatness: every group vertex sits within `flat` px of the group chord (a
 *     sharp-star tip V dips several px below its shoulder chord and never
 *     qualifies — this is what makes a cap a cap and a tip a tip).
 * A classified cap contributes exactly TWO corners — the group's outermost
 * sub-threshold vertices — and the arc between them is fitted as a straight
 * LINE with both endpoints snapped to the intersection of the adjacent LONG arm
 * with the cap-chord line (the twin corners share one edge, so the whole group
 * interior is that edge's evidence; displacement is capped at snapMax so a bad
 * line can never carry a corner out of tolerance). Unclassified groups keep
 * their detector apexes untouched.
 */
// Calibration (swept one-at-a-time on the real pipeline against bar-caps +
// gear-teeth + sharp-star + checker + cross-bars + hairlines, 2026-07-28):
// every ±1-notch variation of these is measured IDENTICAL on the whole
// watchlist — the values sit on a plateau — except CAP_EXTEND_DEV, whose sweep
// bounds are real: 1.0 costs bar-caps chamfer (0.14 → 0.16), 1.4 starts eating
// gear-teeth corners (51 → 49/60). Only chordMax 0 (resolver OFF) reverts the
// bar-caps failure (43/43 → 30/43).
/** Arms must be ANTI-PARALLEL within this (deg): a butt cap U-turns (~180°). */
const CAP_ANTIPARALLEL_DEG = 150
const CAP_CHORD_MIN = 3
const CAP_CHORD_MAX = 10
/** Max perp deviation (px) of the A..B interior from the A→B chord — what makes
 *  a cap a cap and a star-tip V a tip. */
const CAP_FLAT = 1.3
const CAP_JOIN_GAP = 6
const CAP_SNAP_MAX = 2.5
/** Arm seed starts this many steps OUTSIDE the group center… */
const CAP_ARM_K = 10
/** …and spans this many vertices. Both sides must be straight (collinear). */
const CAP_ARM_SEED = 6
/** Arm-extension tolerance (px). Looser than SNAP_COLLINEAR: an AA edge at a
 *  half-pixel phase CHATTERS ±1px around its mean line (the isophote sits
 *  between two pixel columns), which is noise, not a corner — while the cap
 *  turn deviates 2px+ and still stops the extension. */
const CAP_EXTEND_DEV = 1.2

interface ResolvedCaps {
  /** Revised corner list (raw pts indices, ascending). */
  corners: number[]
  /** Corner index c (a pts index) such that the arc c → next corner is a cap. */
  capStarts: Set<number>
}

export function resolveLoopCaps(pts: Vec[], corners: number[], turnDeg: number, win = CORNER_WINDOW): ResolvedCaps {
  const n = pts.length
  const none = (): ResolvedCaps => ({ corners, capStarts: new Set() })
  if (corners.length < 1 || turnDeg >= 180 || n < 2 * win + 1) return none()
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const sharp = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const inDir = unit(sub(pts[i], pts[wrap(i - win)]))
    const outDir = unit(sub(pts[wrap(i + win)], pts[i]))
    if (inDir.x * outDir.x + inDir.y * outDir.y < thr) sharp[i] = 1
  }
  // Maximal cyclic runs of sub-threshold vertices, in loop order.
  const runs: { s: number; e: number }[] = []
  const seen = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!sharp[i] || seen[i]) continue
    let s = i
    while (sharp[wrap(s - 1)] && wrap(s - 1) !== i) s = wrap(s - 1)
    let e = s
    let len = 1
    seen[s] = 1
    while (sharp[wrap(e + 1)] && wrap(e + 1) !== s) {
      e = wrap(e + 1)
      seen[e] = 1
      len++
      if (len >= n) break
    }
    runs.push({ s, e })
  }
  if (runs.length === 0) return none()
  runs.sort((a, b) => a.s - b.s)
  // Join runs across gaps ≤ joinGap into GROUPS (cyclic — the last may wrap onto
  // the first). A group is one candidate feature: a cap's two shoulder runs, or a
  // fused cap run, or an ordinary lone corner cluster.
  const gap = (a: { e: number }, b: { s: number }): number => wrap(b.s - a.e) - 1
  const groups: { s: number; e: number }[] = []
  let cur = { ...runs[0] }
  for (let k = 1; k < runs.length; k++) {
    if (gap(cur, runs[k]) <= CAP_JOIN_GAP) cur.e = runs[k].e
    else {
      groups.push(cur)
      cur = { ...runs[k] }
    }
  }
  groups.push(cur)
  if (groups.length >= 2 && gap(groups[groups.length - 1], groups[0]) <= CAP_JOIN_GAP) {
    groups[0].s = groups[groups.length - 1].s
    groups.pop()
  }

  const out: number[] = []
  const capStarts = new Set<number>()
  const arcLen = (s: number, e: number): number => wrap(e - s) + 1
  const inGroup = (g: { s: number; e: number }, i: number): boolean => wrap(i - g.s) <= wrap(g.e - g.s)
  // One arm of the cap hypothesis: seed a line fit `armK` steps OUTSIDE the group
  // center (on the long edge, well clear of the confusion zone), then extend it
  // INWARD while collinear — the extension stops at the true corner. Returns the
  // stop vertex + the travel-oriented arm direction, or null when the seed itself
  // is not straight (a checker cell / gear tooth wraps other corners into the
  // seed window and fails here — exactly the art this resolver must not touch).
  const findArm = (m: number, sign: -1 | 1): { stop: number; dir: Vec } | null => {
    const seed: Vec[] = []
    for (let o = CAP_ARM_K + CAP_ARM_SEED - 1; o >= CAP_ARM_K; o--) seed.push(pts[wrap(m + sign * o)])
    let line = armLine(seed)
    for (const p of seed) {
      const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
      if (dev > SNAP_COLLINEAR) return null
    }
    // Extend inward RE-FITTING the line as each vertex joins (the snapCornerToArms
    // collect trick): a fixed seed slope is step-phase noise on a low-angle
    // staircase and would stop treads early; the refit converges on the true edge
    // and the stop lands at the corner.
    let stop = wrap(m + sign * CAP_ARM_K)
    const acc = seed.slice()
    for (let o = CAP_ARM_K - 1; o >= 0; o--) {
      const i = wrap(m + sign * o)
      const dev = Math.abs((pts[i].x - line.c.x) * line.d.y - (pts[i].y - line.c.y) * line.d.x)
      if (dev > CAP_EXTEND_DEV) break
      acc.push(pts[i])
      line = armLine(acc)
      stop = i
    }
    // Orient the fitted direction ALONG TRAVEL (ascending index order).
    const a = pts[wrap(m + sign * (CAP_ARM_K + CAP_ARM_SEED - 1))]
    const b = pts[wrap(m + sign * CAP_ARM_K)]
    const travel = sign === -1 ? sub(b, a) : sub(a, b)
    const d = travel.x * line.d.x + travel.y * line.d.y >= 0 ? line.d : neg(line.d)
    return { stop, dir: d }
  }
  for (const g of groups) {
    const members = corners.filter((c) => inGroup(g, c))
    const span = arcLen(g.s, g.e)
    // Classification — see the header comment. All evidence-gated; any failure
    // leaves the group's detector apexes exactly as they were.
    let cap: { a: number; b: number } | null = null
    if (span <= 24 && span < n - 2 * (CAP_ARM_K + CAP_ARM_SEED)) {
      const m = wrap(g.s + (span >> 1))
      const armIn = findArm(m, -1)
      const armOut = findArm(m, 1)
      if (armIn && armOut && armIn.stop !== armOut.stop) {
        const A = armIn.stop
        const B = armOut.stop
        const chord = dist(pts[A], pts[B])
        const cosT = armIn.dir.x * armOut.dir.x + armIn.dir.y * armOut.dir.y
        const uturn = (Math.acos(Math.max(-1, Math.min(1, cosT))) * 180) / Math.PI
        if (chord >= CAP_CHORD_MIN && chord <= CAP_CHORD_MAX && uturn >= CAP_ANTIPARALLEL_DEG) {
          let maxDev = 0
          for (let i = A; i !== B; i = wrap(i + 1)) maxDev = Math.max(maxDev, perpDistance(pts[i], pts[A], pts[B]))
          if (maxDev <= CAP_FLAT) cap = { a: A, b: B }
        }
      }
    }
    if (cap) {
      out.push(cap.a, cap.b)
      capStarts.add(cap.a)
    } else out.push(...members)
  }
  out.sort((a, b) => a - b)
  // Dedup (a group end could coincide with a member of a neighbouring group).
  const dedup: number[] = []
  for (const c of out) if (dedup[dedup.length - 1] !== c) dedup.push(c)
  return { corners: dedup, capStarts }
}

/** Least-squares line through the INTERIOR staircase vertices of a cap arc (its
 *  two corners excluded — they sit on the shoulder rounding). Falls back to the
 *  corner-to-corner chord when the interior is too short to fit. */
function capChordLine(pts: Vec[], cIn: number, cOut: number): { c: Vec; d: Vec } {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const interior: Vec[] = []
  for (let i = wrap(cIn + 1); i !== cOut; i = wrap(i + 1)) interior.push(pts[i])
  if (interior.length >= 2) return armLine(interior)
  const d = unit(sub(pts[cOut], pts[cIn]))
  return { c: { x: pts[cIn].x, y: pts[cIn].y }, d }
}

/** Snap one cap corner to the intersection of its LONG arm's fitted line with the
 *  shared cap-chord line. `sign` −1 ⇒ the long arm precedes the corner (an arc
 *  ENDS at this cap), +1 ⇒ it follows (an arc STARTS here). Falls back to the raw
 *  lattice vertex when the arm is degenerate or the intersection runs away. */
function snapCapCorner(pts: Vec[], c: number, sign: -1 | 1, toLong: number, capLine: { c: Vec; d: Vec }, snapMax: number): Vec {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const gapN = armGap(toLong)
  const span = Math.min(SNAP_SPAN, Math.max(gapN + 1, toLong - 1))
  const arm: Vec[] = []
  for (let o = gapN; o <= span; o++) arm.push(pts[wrap(c + sign * o)])
  if (arm.length < 2) return { x: pts[c].x, y: pts[c].y }
  const a = armLine(arm)
  const det = a.d.x * -capLine.d.y - a.d.y * -capLine.d.x
  if (Math.abs(det) < 1e-6) return { x: pts[c].x, y: pts[c].y }
  const rx = capLine.c.x - a.c.x
  const ry = capLine.c.y - a.c.y
  const t = (rx * -capLine.d.y - ry * -capLine.d.x) / det
  const ix = a.c.x + t * a.d.x
  const iy = a.c.y + t * a.d.y
  if (dist({ x: ix, y: iy }, pts[c]) > snapMax) return { x: pts[c].x, y: pts[c].y }
  return { x: ix, y: iy }
}

/**
 * Fit a closed loop that has sharp corners without beveling them: snap each corner
 * to its sub-pixel arm intersection, split the raw staircase at the corners, and
 * fit each arc as an open arc pinned at the snapped corners (so the arm staircase
 * still melts but the corners stay exact). Stitch the arcs into one closed node
 * list, each corner a single hard node. Falls back to `fitLoopEdge` if the corners
 * collapse to fewer than two distinct points.
 *
 * Cap arcs (resolveLoopCaps) are the exception to arc fitting: a classified cap
 * is emitted as a straight LINE between its two snapped corners — the evidence
 * says it IS a line, and a cubic fitted over ≤7 ragged points bends its end
 * tangents enough to read a true 90° corner as 45° (§0 #6b, capDiag).
 */
export function fitCorneredLoop(pts: Vec[], corners: number[], opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const resolved = resolveLoopCaps(pts, corners.slice().sort((a, b) => a - b), opts.cornerTurnDeg)
  const C = resolved.corners
  // Cap pairing BEFORE the coincident-drop below: start → its twin (the next
  // corner). A pair whose members don't both survive the drop reverts to normal.
  const capPartner = new Map<number, number>()
  const capLineOf = new Map<number, { c: Vec; d: Vec }>()
  for (const s of resolved.capStarts) {
    const k = C.indexOf(s)
    const partner = C[(k + 1) % C.length]
    capPartner.set(s, partner)
    capLineOf.set(s, capChordLine(pts, s, partner))
  }
  // Snap each corner, capping arm samples to the gap to its neighbour corners.
  const snappedAll: Vec[] = C.map((c, k) => {
    const prev = C[(k - 1 + C.length) % C.length]
    const next = C[(k + 1) % C.length]
    const toPrev = wrap(c - prev)
    const toNext = wrap(next - c)
    // Cap corners: intersection of the LONG arm with the shared cap-chord line
    // (snapCapCorner). The long arm is on the non-cap side.
    if (capPartner.has(c)) return snapCapCorner(pts, c, -1, toPrev, capLineOf.get(c)!, CAP_SNAP_MAX)
    if (capPartner.get(prev) === c) return snapCapCorner(pts, c, 1, toNext, capLineOf.get(prev)!, CAP_SNAP_MAX)
    const inGap = armGap(toPrev)
    const outGap = armGap(toNext)
    const inSpan = Math.min(SNAP_SPAN, Math.max(inGap + 1, toPrev - 1))
    const outSpan = Math.min(SNAP_SPAN, Math.max(outGap + 1, toNext - 1))
    // Collinear straight arms may grow their evidence window up to SNAP_SPAN_MAX,
    // still never past the neighbouring corner.
    const inMax = Math.min(SNAP_SPAN_MAX, Math.max(inGap + 1, toPrev - 1))
    const outMax = Math.min(SNAP_SPAN_MAX, Math.max(outGap + 1, toNext - 1))
    return snapCornerToArms(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax)
  })
  // Drop corners whose snapped point coincides with the previous (a shoulder pair
  // that both resolved onto the same apex) — incl. the cyclic first/last pair.
  const idx: number[] = []
  const snap: Vec[] = []
  for (let k = 0; k < C.length; k++) {
    const last = snap[snap.length - 1]
    if (last && dist(last, snappedAll[k]) < 1) continue
    idx.push(C[k])
    snap.push(snappedAll[k])
  }
  if (snap.length >= 2 && dist(snap[0], snap[snap.length - 1]) < 1) {
    idx.pop()
    snap.pop()
  }
  if (idx.length < 2) return fitLoopEdge(presmooth(pts, opts.smoothPasses, false), opts)
  // A cap arc is line-pinned only while its start and twin are still ADJACENT
  // survivors — a drop that touched either reverts the pair to a normal arc.
  const capStarts = new Set<number>()
  for (const [s, partner] of capPartner) {
    const k = idx.indexOf(s)
    if (k >= 0 && idx[(k + 1) % idx.length] === partner) capStarts.add(s)
  }

  // Fit each arc between consecutive corners (snapped endpoints pinned & sharp).
  const arcs = idx.length
  const fitted: PathNode[][] = []
  for (let k = 0; k < arcs; k++) {
    const a = idx[k]
    const b = idx[(k + 1) % arcs]
    if (capStarts.has(a)) {
      // Classified cap: a straight line between the two snapped corners. The
      // group interior IS this line's evidence (capChordLine), and a cubic over
      // ≤7 ragged points would wobble its end tangents (§0 #6b).
      const A = snap[k]
      const B = snap[(k + 1) % arcs]
      fitted.push([
        { x: A.x, y: A.y, hIn: null, hOut: null, kind: 'corner' },
        { x: B.x, y: B.y, hIn: null, hOut: null, kind: 'corner' },
      ])
      continue
    }
    const arc: Vec[] = []
    let i = a
    while (true) {
      arc.push({ x: pts[i].x, y: pts[i].y })
      if (i === b) break
      i = wrap(i + 1)
    }
    // Censor the cap remnants before pinning: the gap staircase points nearest
    // each corner are the rounded/eroded part — the exact points snapCornerToArms
    // skips when placing the apex. Left in, they sit laterally OFF the apex→arm
    // line (an eroded shallow tip keeps a 1px plateau there), so the fit chases
    // them and arrives at the snapped corner from the wrong side — sharp-star's
    // right tip rendered as an S-hook with an extra node. The trim mirrors the
    // scale-aware armGap (a short arc's snap kept its near-corner evidence, so
    // the arc fit keeps it too), and only while ≥ 2 interior points survive so
    // short arcs (a small checker cell edge) keep their evidence.
    const trim = Math.min(armGap(arc.length - 1), Math.max(0, (arc.length - 4) >> 1))
    const kept = arc.slice(trim, arc.length - trim)
    kept[0] = { x: snap[k].x, y: snap[k].y }
    kept[kept.length - 1] = { x: snap[(k + 1) % arcs].x, y: snap[(k + 1) % arcs].y }
    fitted.push(fitOpenArc(presmooth(kept, arcSmoothPasses(opts.smoothPasses, kept.length), true), opts))
  }

  // Stitch into a closed node list: each shared corner is one node carrying the
  // arriving arc's hIn and the leaving arc's hOut, tagged corner.
  const out: PathNode[] = []
  for (let k = 0; k < arcs; k++) {
    const cur = fitted[k]
    if (cur.length < 2) continue
    const start = cur[0]
    const prev = out[out.length - 1]
    if (prev) prev.hOut = start.hOut ? { x: start.hOut.x, y: start.hOut.y } : null
    else out.push({ x: start.x, y: start.y, hIn: null, hOut: start.hOut ? { x: start.hOut.x, y: start.hOut.y } : null, kind: 'corner' })
    for (let j = 1; j < cur.length - 1; j++) out.push(cur[j])
    const last = cur[cur.length - 1]
    if (k === arcs - 1) out[0].hIn = last.hIn ? { x: last.hIn.x, y: last.hIn.y } : null
    else out.push({ x: last.x, y: last.y, hIn: last.hIn ? { x: last.hIn.x, y: last.hIn.y } : null, hOut: null, kind: 'corner' })
  }
  return out.length >= 2 ? out : fitLoopEdge(presmooth(pts, opts.smoothPasses, false), opts)
}

/**
 * Indices of the sharp corners INTERIOR to an OPEN staircase polyline — ONE per
 * corner. `detectLoopCorners` with the cyclic wrap replaced by clamped windows:
 * each cluster of sub-threshold vertices collapses to its geometric apex (max
 * perp deviation from the window chord) and apexes within `mergeDist` px fuse,
 * so a vertex's two staircase shoulders never yield two corners. The endpoint
 * regions (± `win`, junction anchors) are excluded, as in `detectCorners`.
 */
export function detectOpenCorners(pts: Vec[], turnDeg: number, win = CORNER_WINDOW, mergeDist = CORNER_MERGE): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const lo = win
  const hi = n - win
  const cos = new Float64Array(n)
  cos.fill(1)
  for (let i = lo; i < hi; i++) {
    const inDir = unit(sub(pts[i], pts[i - win]))
    const outDir = unit(sub(pts[i + win], pts[i]))
    cos[i] = inDir.x * outDir.x + inDir.y * outDir.y
  }
  const apexes: number[] = []
  for (let s = lo; s < hi; s++) {
    if (cos[s] >= thr) continue
    let best = s
    let bestDev = -1
    let i = s
    while (i < hi && cos[i] < thr) {
      const dev = perpDistance(pts[i], pts[Math.max(0, i - win)], pts[Math.min(n - 1, i + win)])
      if (dev > bestDev) {
        bestDev = dev
        best = i
      }
      i++
    }
    apexes.push(best)
    s = i // resume after the cluster (loop's s++ steps past it)
  }
  // Fuse near-coincident apexes (consecutive; keep the first, as the loop does).
  const merged: number[] = []
  for (const a of apexes) {
    const last = merged[merged.length - 1]
    if (last !== undefined && dist(pts[a], pts[last]) <= mergeDist) continue
    merged.push(a)
  }
  return merged
}

/**
 * Open-edge counterpart of `fitCorneredLoop`: sharp corners INTERIOR to a
 * junction→junction edge get the same sub-pixel arm snap + cap-trim. Without
 * this, an outline tip that a junction happened to split onto an open edge (the
 * gradient-flat triangle apex — its left arm crosses the white circle) kept its
 * raw pinned lattice vertex, and the DP fit around the AA-eroded cap remnants —
 * arriving from the wrong side as a short hook with an extra smooth node, the
 * exact pathology the cap-trim note in fitCorneredLoop describes. Differences
 * from the loop version, both forced by openness:
 *   • arm windows CLAMP at the endpoints instead of wrapping;
 *   • the edge's own endpoints are never snapped and never trimmed — they are
 *     junction anchors that must stay byte-coincident with sibling edges.
 */
export function fitCorneredOpen(pts: Vec[], pinned: ReadonlySet<number>, opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const fallback = (): PathNode[] => fitOpenArc(presmooth(pts, opts.smoothPasses, true, pinned), opts)
  // Clustered corners (one per feature, like the loop path) — the raw `pinned`
  // set has BOTH staircase shoulders of a vertex, which must not become two
  // breakpoints (a 2-node chamfer where the art has one corner).
  let C = detectOpenCorners(pts, opts.cornerTurnDeg)
  if (n < 2 * SNAP_GAP + 3) return fallback()

  // Prune-and-refit loop: a detected corner whose FITTED junction comes out
  // nearly straight was a local staircase jog (e.g. the boundary bending into a
  // junction's AA neighbourhood), not a real corner — forcing a hard breakpoint
  // there asserts geometry the art doesn't have. Detection can't tell (the ±win
  // raw turn IS above threshold); the fit can. Each pass drops the weak
  // breakpoints and refits without them; terminates because C strictly shrinks.
  for (;;) {
    if (C.length === 0) return fallback()

    const snappedAll: Vec[] = C.map((c, k) => {
      const toPrev = c - (k > 0 ? C[k - 1] : 0)
      const toNext = (k < C.length - 1 ? C[k + 1] : n - 1) - c
      const inGap = armGap(toPrev)
      const outGap = armGap(toNext)
      // Same spans as the loop version, additionally clamped so no window index
      // leaves [0, n-1] (open: there is nothing to wrap onto).
      const inSpan = Math.min(SNAP_SPAN, Math.max(inGap + 1, toPrev - 1), c)
      const outSpan = Math.min(SNAP_SPAN, Math.max(outGap + 1, toNext - 1), n - 1 - c)
      const inMax = Math.min(SNAP_SPAN_MAX, Math.max(inGap + 1, toPrev - 1), c)
      const outMax = Math.min(SNAP_SPAN_MAX, Math.max(outGap + 1, toNext - 1), n - 1 - c)
      return snapCornerToArms(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax)
    })
    // Drop corners whose snap collapsed onto the previous breakpoint or an endpoint.
    const idx: number[] = []
    const snap: Vec[] = []
    for (let k = 0; k < C.length; k++) {
      const prevPin = snap[snap.length - 1] ?? pts[0]
      if (dist(prevPin, snappedAll[k]) < 1 || dist(pts[n - 1], snappedAll[k]) < 1) continue
      idx.push(C[k])
      snap.push(snappedAll[k])
    }
    if (idx.length === 0) return fallback()

    // Fit each piece between consecutive breakpoints. Corner ends are cap-trimmed
    // (censor the SNAP_GAP eroded points, as in fitCorneredLoop) and pinned to the
    // snapped apex; endpoint ends keep the exact junction anchor untrimmed.
    const bounds = [0, ...idx, n - 1]
    const pins: Vec[] = [pts[0], ...snap, pts[n - 1]]
    const fitted: PathNode[][] = []
    for (let k = 0; k + 1 < bounds.length; k++) {
      const piece = pts.slice(bounds[k], bounds[k + 1] + 1)
      const pieceGap = armGap(piece.length - 1)
      let trimS = k > 0 ? pieceGap : 0
      let trimE = k + 1 < bounds.length - 1 ? pieceGap : 0
      // Trim only while ≥ 2 interior points survive (short pieces keep evidence).
      while (trimS + trimE > Math.max(0, piece.length - 4)) {
        if (trimE >= trimS && trimE > 0) trimE--
        else if (trimS > 0) trimS--
        else break
      }
      const kept = piece.slice(trimS, piece.length - trimE).map((p) => ({ x: p.x, y: p.y }))
      kept[0] = { x: pins[k].x, y: pins[k].y }
      kept[kept.length - 1] = { x: pins[k + 1].x, y: pins[k + 1].y }
      fitted.push(fitOpenArc(presmooth(kept, arcSmoothPasses(opts.smoothPasses, kept.length), true), opts))
    }

    // Stitch: each interior breakpoint is ONE hard node — arriving hIn, leaving
    // hOut — remembering where each landed for the weak-turn check below.
    const out: PathNode[] = []
    const jointAt: number[] = [] // out[] index of breakpoint k (parallel to idx)
    let ok = true
    for (const cur of fitted) {
      if (cur.length < 2) {
        ok = false
        break
      }
      if (out.length === 0) {
        for (const nd of cur) out.push({ x: nd.x, y: nd.y, hIn: nd.hIn ? { ...nd.hIn } : null, hOut: nd.hOut ? { ...nd.hOut } : null, kind: nd.kind })
      } else {
        const joint = out[out.length - 1]
        jointAt.push(out.length - 1)
        joint.hOut = cur[0].hOut ? { x: cur[0].hOut.x, y: cur[0].hOut.y } : null
        joint.kind = 'corner'
        for (let j = 1; j < cur.length; j++) {
          const nd = cur[j]
          out.push({ x: nd.x, y: nd.y, hIn: nd.hIn ? { ...nd.hIn } : null, hOut: nd.hOut ? { ...nd.hOut } : null, kind: nd.kind })
        }
      }
    }
    if (!ok || out.length < 2) return fallback()

    // Weak-turn prune: fitted tangents at each breakpoint. A real corner that
    // detection accepts turns ≥ cornerTurnDeg (70°); a jog fits nearly straight.
    const weak = new Set<number>()
    for (let k = 0; k < jointAt.length; k++) {
      const i = jointAt[k]
      const nd = out[i]
      const inFrom = nd.hIn ?? { x: out[i - 1].x, y: out[i - 1].y }
      const outTo = nd.hOut ?? { x: out[i + 1].x, y: out[i + 1].y }
      const a = unit(sub(nd, inFrom))
      const b = unit(sub(outTo, nd))
      const cosT = a.x * b.x + a.y * b.y
      if (cosT > COS_WEAK_CORNER) weak.add(idx[k])
    }
    if (weak.size === 0) return out
    C = C.filter((c) => !weak.has(c))
  }
}

/** Fitted-turn floor for an open-edge breakpoint (30°): well below any true
 *  detected corner (the detector's own floor is 60°), well above the ~3° of a
 *  smoothly absorbed jog. */
const COS_WEAK_CORNER = Math.cos((30 * Math.PI) / 180)

/**
 * Fit a pure closed-loop edge (no junction) reusing the crisp tracer's
 * `fitClosedLoop`. Returns closed-loop nodes, or a coarse fallback.
 */
export function fitLoopEdge(densePts: Vec[], opts: PlanarFitOptions): PathNode[] {
  const fitOpts: CurveFitOptions = { epsilon: opts.epsilon, lineCost: opts.lineCost, cubicCost: opts.cubicCost }
  const nodes = fitClosedLoop(densePts, fitOpts)
  if (nodes && nodes.length >= 2) return nodes
  // Degenerate tiny loop: keep its dedup'd polygon as corners.
  const d = dedup(densePts)
  return d.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const }))
}
