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
   * curve before the fitter sees it. 70° catches the genuinely sharp features yet
   * leaves smooth shapes (even tiny circles) untouched. ≥180 disables (pre-smoothing
   * pins only endpoints, the legacy behaviour — used to assert byte-identity).
   */
  cornerTurnDeg: number
  /**
   * EXPERIMENTAL (off by default). Place each junction VERTEX at the sub-pixel
   * intersection of its incident edge arms instead of the integer lattice corner,
   * and weld two edges a region runs straight THROUGH a junction to a shared G¹
   * tangent (planarJunction.ts). An alternative to the co-circular arc snap (§1d)
   * for the ring "pull"; measured weaker + corpus-moving, kept behind this flag for
   * the Test view A/B. `false` ⇒ raw integer-lattice junctions (the shipped path).
   */
  refineJunctions: boolean
  /**
   * Co-circular open-arc snap (planarBeautify §1d): a ring split into arcs by band
   * junctions snaps to ONE circle so it stops kinking. On by default (it rides the
   * fidelity dial). `false` disables it — the pre-1d baseline, for the Test view A/B.
   */
  arcSnap: boolean
}

export const DEFAULT_PLANAR_FIT: PlanarFitOptions = {
  epsilon: 1.0,
  smoothPasses: 2,
  // Conservative line/cubic balance (line marginally cheaper). The FLAT path bumps
  // lineCost above cubicCost in planarFitOptionsFor to de-facet curves; gradient
  // art keeps this value (the bump worsened the headphones-grad seam past tol).
  lineCost: 3.9,
  cubicCost: 4,
  cornerTurnDeg: 70,
  refineJunctions: false,
  arcSnap: true,
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
function snapCornerToArms(pts: Vec[], c: number, gap: number, inSpan: number, outSpan: number): Vec {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const inPts: Vec[] = []
  const outPts: Vec[] = []
  for (let o = gap; o <= inSpan; o++) inPts.push(pts[wrap(c - o)])
  for (let o = gap; o <= outSpan; o++) outPts.push(pts[wrap(c + o)])
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
  if (dist({ x: ix, y: iy }, pts[c]) > Math.max(inSpan, outSpan)) return { x: pts[c].x, y: pts[c].y }
  return { x: ix, y: iy }
}

/**
 * Indices of the sharp corners on a CLOSED staircase loop — ONE per corner. The
 * same ±`win` macro-turn test as `detectCorners`, but each cluster of sub-threshold
 * vertices is collapsed to its geometric APEX (the vertex farthest from its window
 * chord), and apexes within `mergeDist` px fuse (a rasterized tip is often a 1-px
 * plateau = two "shoulder" vertices, possibly split across the loop seam). Sorted
 * ascending. `turnDeg ≥ 180` ⇒ ∅ (disabled).
 */
export function detectLoopCorners(pts: Vec[], turnDeg: number, win = CORNER_WINDOW, mergeDist = 5): number[] {
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
 * Fit a closed loop that has sharp corners without beveling them: snap each corner
 * to its sub-pixel arm intersection, split the raw staircase at the corners, and
 * fit each arc as an open arc pinned at the snapped corners (so the arm staircase
 * still melts but the corners stay exact). Stitch the arcs into one closed node
 * list, each corner a single hard node. Falls back to `fitLoopEdge` if the corners
 * collapse to fewer than two distinct points.
 */
export function fitCorneredLoop(pts: Vec[], corners: number[], opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const C = corners.slice().sort((a, b) => a - b)
  // Snap each corner, capping arm samples to the gap to its neighbour corners.
  const snappedAll: Vec[] = C.map((c, k) => {
    const prev = C[(k - 1 + C.length) % C.length]
    const next = C[(k + 1) % C.length]
    const toPrev = wrap(c - prev)
    const toNext = wrap(next - c)
    const inSpan = Math.min(SNAP_SPAN, Math.max(SNAP_GAP + 1, toPrev - 1))
    const outSpan = Math.min(SNAP_SPAN, Math.max(SNAP_GAP + 1, toNext - 1))
    return snapCornerToArms(pts, c, SNAP_GAP, inSpan, outSpan)
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

  // Fit each arc between consecutive corners (snapped endpoints pinned & sharp).
  const arcs = idx.length
  const fitted: PathNode[][] = []
  for (let k = 0; k < arcs; k++) {
    const a = idx[k]
    const b = idx[(k + 1) % arcs]
    const arc: Vec[] = []
    let i = a
    while (true) {
      arc.push({ x: pts[i].x, y: pts[i].y })
      if (i === b) break
      i = wrap(i + 1)
    }
    arc[0] = { x: snap[k].x, y: snap[k].y }
    arc[arc.length - 1] = { x: snap[(k + 1) % arcs].x, y: snap[(k + 1) % arcs].y }
    fitted.push(fitOpenArc(presmooth(arc, opts.smoothPasses, true), opts))
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
