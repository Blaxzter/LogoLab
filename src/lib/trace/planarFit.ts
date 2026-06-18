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
}

export const DEFAULT_PLANAR_FIT: PlanarFitOptions = {
  epsilon: 1.0,
  smoothPasses: 2,
  lineCost: 3.9,
  cubicCost: 4,
}

const MAX_SPAN = 20
const MAX_FIT_POINTS = 64
const MAX_EVIDENCE_WINDOW = 24

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
 * last point fixed (junction anchors); a closed loop smooths cyclically. A few
 * fixed passes of a [0.25, 0.5, 0.25] window — deterministic, endpoint-preserving.
 */
export function presmooth(pts: Vec[], passes: number, pinEnds: boolean): Vec[] {
  if (pts.length < 3 || passes <= 0) return pts.map((p) => ({ x: p.x, y: p.y }))
  let cur = pts.map((p) => ({ x: p.x, y: p.y }))
  const n = cur.length
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.map((p) => ({ x: p.x, y: p.y }))
    const lo = pinEnds ? 1 : 0
    const hi = pinEnds ? n - 1 : n
    for (let i = lo; i < hi; i++) {
      const a = cur[(i - 1 + n) % n]
      const b = cur[i]
      const c = cur[(i + 1) % n]
      next[i] = { x: 0.25 * a.x + 0.5 * b.x + 0.25 * c.x, y: 0.25 * a.y + 0.5 * b.y + 0.25 * c.y }
    }
    cur = next
  }
  return cur
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
