// Edge fitting for the planar tracer: fit each PlanarEdge's lattice staircase
// polyline, once, to a low-node chain of lines and cubic Béziers. Junction
// endpoints are pinned (so the edges meeting there share an exact anchor) and
// forced to corner. Uses the numerics in curveFit.ts — `fitSingleCubic` (Schneider
// + Newton) and `lineFit` — wrapped in an open (acyclic) RDP + evidence-based corner
// score + linear DP that mirrors fitClosedLoop's recipe without its cyclic
// wraparound. Pure-loop edges use `fitClosedLoop` directly.
//
// A crack polyline has no smoothness of its own, so the interior is pre-smoothed
// (endpoints and detected corners pinned) to melt the 90° staircase, and the ε
// cubic-fit tolerance absorbs the residual. Sharp corners are then localized to
// their sub-pixel apex from the two arm lines and the chain is fitted as open arcs
// between them.
//
// Pure and deterministic (fixed iteration counts, no PRNG).
// Design notes and measurements: docs/vectorization-benchmarks.md.

import type { PathNode, Vec } from '../path/types'
import { fitClosedLoop, fitSingleCubic, junctionCosts, lineFit, type CurveFitOptions } from './curveFit.ts'

export interface PlanarFitOptions {
  /** Curve-fit tolerance ε (px): RDP split threshold and cubic-discard bound. */
  epsilon: number
  /** Pre-smoothing passes over the staircase (endpoints pinned). */
  smoothPasses: number
  lineCost: number
  cubicCost: number
  /**
   * Macro-turn angle (deg) above which an interior staircase vertex is a corner and is
   * pinned through pre-smoothing, so a sharp point isn't melted into a curve before the
   * fitter sees it. 60° is the one definition of "sharp" the pipeline shares
   * (geomScore.sharpCorners and planarBeautify's CORNER_TURN use it too). A clean arc
   * trips the ±4px window only below ~7.6px local radius; small closed discs, whose
   * staircase can still read 2–5 corners, are handled by `discExplainsLoop`.
   * ≥180 disables corner pinning (only endpoints are pinned).
   */
  cornerTurnDeg: number
  /**
   * Opt-in junction refinement (planarJunction.ts): place each junction vertex at the
   * sub-pixel intersection of its incident edge arms instead of the integer lattice
   * corner, and give two edges a region runs straight through a junction a shared G¹
   * tangent. An alternative to the co-circular arc snap; it is a trade-off rather than
   * an improvement, so it stays off. `false` ⇒ integer-lattice junctions.
   */
  refineJunctions: boolean
  /** Co-circular open-arc snap (planarBeautify): a ring split into arcs by band junctions
   *  snaps to one circle so it stops kinking. */
  arcSnap: boolean
  /**
   * Junction re-seat (planarReseat.ts): a degree-3 junction that slid along a
   * near-tangent boundary crossing (the label map's colour needle is sub-pixel thin
   * there, so the lattice junction lands px away from the true crossing) is moved to the
   * intersection of its two strongest incident fitted primitives, and the mangled
   * terminal caps are re-emitted from those primitives. On by default.
   */
  junctionReseat: boolean
  /**
   * Scale-relative snap tolerance (0 = off). The circle / ellipse / co-circular snaps in
   * planarBeautify accept a primitive on radial deviation ≤ `fidelity`, an absolute px
   * test, which lets a small square cell round into a blob. When > 0 each snap's
   * tolerance becomes `min(fidelity, localScaleK · r)`, with r the fitted primitive's
   * radius, so a small shape is held to a fraction of its own size.
   */
  localScaleK: number
  /**
   * Contrast-rank threading (planarThread.ts). Where a weak colour boundary (a
   * posterization band seam) ends on a strong one that continues through, move the
   * junction onto a fit of the strong boundary across it, instead of pinning a long
   * edge to the seam's integer lattice corner. Needs the palette; without one, or with
   * this false, nothing moves.
   */
  fitThrough: boolean
  /**
   * Corner-junction placement, the other half of `fitThrough`: where the strong
   * boundary turns at the junction, place it at the intersection of the two strong arms'
   * own fitted lines instead of the integer lattice corner. Same preconditions as
   * `fitThrough`; `false` keeps the lattice corner.
   */
  cornerJunctions: boolean
  /** The corner-turn veto in planarBeautify that refuses to round a sharp-cornered loop
   *  into a disc. Exposed so `localScaleK` can be compared as a replacement for it. */
  cornerVeto: boolean
  /**
   * Through-chains: before the co-circular family pass clusters open arcs, join the ones
   * the topology says continue one another — at each junction, rank every pairing of the
   * incident arms by how straight the boundary runs across and take the matching. A ring
   * cut by crossings then arrives as one arc instead of fragments whose own circle fits
   * are noise.
   */
  chainArcs: boolean
  /**
   * Sub-pixel edge placement (planarSubpixel.ts): before fitting, displace each chain's
   * interior points from the crack lattice to the iso-0.5 crossing of the local
   * two-colour coverage profile, read from the source raster along the chain normal.
   * Only effective when tracePlanar is given the source image; label-only callers are
   * unaffected.
   */
  subpixelEdges: boolean
  /** Refuse the sub-pixel estimator at any chain point whose sample window is not fully
   *  inside the raster (see planarSubpixel's truncated-window guard). */
  subpixelWindowGuard: boolean
  /**
   * Internal, set per edge by assemblePlanar: pin each snapped apex's handle directions
   * onto its fitted arm lines. Only meaningful on a sub-pixel displaced chain, where the
   * arc fits' end tangents are free within ε and rotate toward the bisector (the
   * displaced evidence near an apex is genuinely smooth), which can drop a right angle
   * below the 60° sharp bar. The arm lines read the true flank directions, and the pin
   * restores the corner without moving it.
   */
  pinCornerTangents?: boolean
  /** Diagnostic sink, called once per tangent-pin candidate with the rotation the pin
   *  wants and how straight the arm is (`bench/pinDiag.ts`). Never changes the fit. */
  pinDiag?: PinDiag
  /** Diagnostic sink, called once per corner the apex snap considers: where the lattice
   *  put it, where the arm intersection wants it, which rule decided, and the arm evidence
   *  (`bench/apexDiag.ts`). Never changes the fit. */
  apexDiag?: ApexDiag
  /** Diagnostic overrides for corner-detection constants; each defaults to the module
   *  constant it names. Production never sets them. */
  cornerWindow?: number
  cornerMerge?: number
  /** Forces `armGap(steps)` to this value on every arm (censor and cap-trim). */
  armGapFixed?: number
  snapSpan?: number
  /** The short-arm bypass floor in samples per arm (default SHORT_ARM_SAMPLES). */
  shortArmSamples?: number
  /** Fewest samples both arms need before their line directions are handed to the
   *  tangent pin (default ARM_PIN_SAMPLES). */
  armPinSamples?: number
  /** A short-armed reconstruction is checked against the raster whenever it moved further
   *  than this (default SHORT_ARM_PROBE_MIN px); Infinity switches the probe off. */
  shortArmProbeMin?: number
  /** Refuse an apex reconstruction that lands further than APEX_OVERSHOOT_MAX past the
   *  coverage the source raster carries (see `apexReach`). Default true. */
  apexEvidence?: boolean
  /**
   * How far, in px, the corner's own region still has coverage in the source raster
   * walking from `from` toward `to`. Supplied per edge by assemblePlanar, which holds
   * the raster and the palette; absent (no image, no palette, an EXT side) ⇒ no raster
   * check, so label-only callers are unaffected.
   */
  apexReach?: ApexReach
  /** Diagnostic overrides for the apex evidence constants. */
  apexOvershootMax?: number
  apexReachFrac?: number
  /**
   * The apex snap's arm model. A line is right while the arm's samples sit on it; where
   * they bow off it, the line is a chord of a curve and the chord intersection slides
   * along the other arm (a small needle grows into a letterform's stems). Such an arm is
   * replaced by its tangent at the tip and the apex placed on the intersection of the
   * fitted primitives, with a near-parallel conditioning guard (PARALLEL_TIP_DEG).
   * `false` keeps the chord-only snap.
   */
  arcArms: boolean
  /** Diagnostic overrides for the arc-arm constants. `arcArmModel`: 'tangent' replaces a
   *  bent arm's chord with its anchored tangent line (the chord rotated by the measured
   *  chord-to-tangent angle — no radius estimate); 'circle' intersects fitted circles
   *  (exact on large clean arcs, unstable on ~8px windows). */
  arcArmBowMin?: number
  arcArmDevK?: number
  parallelTipDeg?: number
  arcArmModel?: 'tangent' | 'circle'
  /** false ⇒ the tangent pin keeps the chord directions while the apex still moves. */
  arcPin?: boolean
  /** Minimum arm samples before the reported dir switches to the model tangent (the
   *  tangent pin consumes it); shorter windows measure their tangent as noise. */
  arcPinMinN?: number
  /** Minimum arm samples before the arm may upgrade at all (model and pin both). */
  arcArmMinN?: number
  /** Minimum half-turn (deg) between the window's two half-fits before the arm counts as
   *  curved. A straight staircase's halves agree within ~5° of noise. */
  arcPhiMinDeg?: number
  /** Minimum chord-estimated tip angle (deg) for the model to apply. At an acute tip the
   *  intersection amplifies tangent noise by 1/sin(tip), and the chord model errs short
   *  there, which is the safe side. */
  arcTipMinDeg?: number
  /** Minimum corrected turn (deg) for the tangent dirs to reach the tangent pin. Tangents
   *  that leave the turn near the 60° sharp bar would rotate handles until the corner
   *  reads smooth. */
  arcPinTurnMinDeg?: number
  /** Diagnostic sink: one record per candidate the occluder-chord pass weighed, with the
   *  value each gate saw (`bench/chordDiag.ts`). */
  onChord?: import('./planarReseat.ts').ChordObserver
  /** Diagnostic sink: one record per degree-3 junction the re-seat weighed — each arm's
   *  verdict, the winning pair, the move (`bench/reseatDiag.ts`). */
  onReseatVerdict?: import('./planarReseat.ts').ReseatObserver
  /** Diagnostic overrides for the re-seat's arm-certification constants; every field
   *  defaults to the constant. */
  reseatTune?: import('./planarReseat.ts').ReseatTune
  /** Diagnostic sink: one record per region loop the co-circular arc snap weighed,
   *  naming the gate that declined it (`bench/ringDiag.ts`). */
  onArcLoop?: import('./planarBeautify.ts').ArcLoopObserver
}

/** See PlanarFitOptions.apexReach. Returns Infinity when it cannot judge. */
export type ApexReach = (from: Vec, to: Vec) => number

export const DEFAULT_PLANAR_FIT: PlanarFitOptions = {
  epsilon: 1.0,
  smoothPasses: 2,
  // Conservative line/cubic balance (line marginally cheaper). The flat path raises
  // lineCost above cubicCost (FLAT_LINE_COST) to de-facet curves; gradient art keeps
  // this value, where the higher cost hurt band seams.
  lineCost: 3.9,
  cubicCost: 4,
  cornerTurnDeg: 60,
  refineJunctions: false,
  arcSnap: true,
  junctionReseat: true,
  localScaleK: 0,
  cornerVeto: true,
  chainArcs: true,
  fitThrough: true,
  cornerJunctions: true,
  subpixelEdges: true,
  subpixelWindowGuard: true,
  arcArms: true,
}

/** Flat-art line cost: > cubicCost so the DP prefers a cubic on any span where a
 *  cubic fits within ε — borderline-curved spans become smooth cubics instead of
 *  kinked chords. ε-bounded, so fidelity is unaffected; values above 4.5 change
 *  nothing further. */
export const FLAT_LINE_COST = 4.5

const MAX_SPAN = 20
const MAX_FIT_POINTS = 64
const MAX_EVIDENCE_WINDOW = 24
/** ±px window the macro-turn corner test looks across (spans the unit staircase). */
const CORNER_WINDOW = 4
/** Apex-merge distance (px) for the loop/open corner detectors. It sits between the two
 *  scales it must separate: above a rasterized tip's shoulder pair (≤ ~2px), below the
 *  spacing of real neighbouring corners. Raising it fuses corner pairs 3–5px apart. */
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
 * holds extra indices that must not move — the detected sharp corners, so they
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
 * The macro-turn cosine at every index — what all four readers (`detectCorners`,
 * `detectLoopCorners`, `detectOpenCorners`, `resolveLoopCaps`) test against their
 * threshold. Outside [lo, hi) the value is 1 (no turn).
 *
 * The reading is the angle between two chords taken ±`win` points along the chain.
 */
function readTurnCos(
  pts: Vec[],
  closed: boolean,
  win: number,
  lo: number,
  hi: number,
): Float64Array {
  const n = pts.length
  const cos = new Float64Array(n)
  cos.fill(1)
  const wrap = (i: number): number => ((i % n) + n) % n
  for (let i = lo; i < hi; i++) {
    const b = closed ? pts[wrap(i - win)] : pts[Math.max(0, i - win)]
    const a = closed ? pts[wrap(i + win)] : pts[Math.min(n - 1, i + win)]
    const inDir = unit(sub(pts[i], b))
    const outDir = unit(sub(a, pts[i]))
    cos[i] = inDir.x * outDir.x + inDir.y * outDir.y
  }
  return cos
}

/**
 * Indices of macro corners on a lattice staircase: vertices where the path
 * direction turns by more than `turnDeg`, measured over a ±`win` px window so the
 * unit stair-steps of a straight diagonal (constant macro direction) are not
 * corners but a genuine sharp valley/point is. Non-max-suppressed within the
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
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const lo = closed ? 0 : win
  const hi = closed ? n : n - win
  const cos = readTurnCos(pts, closed, win, lo, hi)
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

// --- evidence-based corner score over an open arc (clamped windows) ---------
/** Points dense[i-k .. i+k] clamped to [0, n-1] (side<0: i-k..i, side>0: i..i+k). */
function windowClamped(dense: Vec[], i: number, k: number, side = 0): Vec[] {
  const n = dense.length
  const lo = Math.max(0, side > 0 ? i : i - k)
  const hi = Math.min(n - 1, side < 0 ? i : i + k)
  const out: Vec[] = []
  for (let o = lo; o <= hi; o++) out.push(dense[o])
  return out
}

/** Least-squares circle through `pts` (Kasa), or null when degenerate. */
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
/** Max radial deviation of `pts` from their best-fit circle (null when degenerate). */
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
 * Fit an open dense polyline (junction→junction) to PathNodes. Endpoints are
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

  // Materialize to open PathNodes (no wrap). Anchor i shared between seg i-1/i.
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

// --- sharp-corner closed-loop fitting (anti-bevel) --------------------------
// `detectCorners` + corner-pinned presmooth keep a sharp apex from being melted,
// but the closed-loop fitter (fitClosedLoop) still places its key vertices on the
// rounded staircase around a tip — two nodes straddling the apex with a short
// segment cutting across it (a visible bevel). For a loop with ≥2 genuine sharp
// corners we instead localize each corner to its sub-pixel apex (the intersection
// of its two arms), split the loop there, and fit each arc as an open arc pinned
// at the snapped corners, so every corner is one exact sharp node. Smooth loops
// have <2 corners and never take this path.

const SNAP_GAP = 3 // skip this many px nearest the tip (the rounded part) per arm
const SNAP_SPAN = 14 // …and fit the arm line over up to this many px beyond the gap
/**
 * Fewest samples an arm may carry and still earn a reconstruction. Below it the arm line
 * is staircase noise and the corner keeps its lattice vertex; the displacement cap and
 * the raster evidence veto hold the noisy regime above it. Don't lower it: at 4 samples
 * the detector starts inventing corners on small arcs. Stated in samples, not steps, so
 * it stays consistent with the gap: a span clamped by an open chain's end with the full
 * 3px gap is 3 samples, not 6.
 */
const SHORT_ARM_SAMPLES = 5
/**
 * Floor at which a corner's arm line directions are trusted as tangents for the tangent
 * pin, on both sides. An intersection tolerates a bowed arm (two chords still cross near
 * the corner); a tangent does not — rotating a handle onto a long chord on a curved
 * letterform bows the adjacent arc. So a corner with a short side takes its apex from
 * the intersection and keeps the fit's own tangents.
 */
const ARM_PIN_SAMPLES = SNAP_GAP + 4
/**
 * How far (px) a short-armed reconstruction may move before the raster is asked whether
 * the corner is really out there (the `apexReach` probe, otherwise consulted only past
 * APEX_OVERSHOOT_MAX). Short arms admit detector false positives on tight smooth nodes,
 * whose chord lines cross outside the ink; an eroded true corner leaves a coverage trail
 * along the ray, a chord crossing on a convex arc leaves none.
 */
const SHORT_ARM_PROBE_MIN = 0.5

/**
 * Scale-aware snap gap. The fixed 3px gap is right for a long arm (skip the AA-rounded
 * tip, plenty of evidence beyond), but on a short inter-corner arc it discards most of
 * the arm and the fitted arm line misplaces the apex by px. The gap scales with the arc:
 * ≥13 steps keep the full 3px gap, an 8-step chord drops to 1. A corner whose arms are
 * that short has sub-px rounding anyway.
 */
function armGap(steps: number): number {
  return Math.min(SNAP_GAP, Math.max(1, ((steps - 1) / 4) | 0))
}

/**
 * Scale-aware smoothing for an inter-corner arc. presmooth exists to melt a long
 * staircase; a short arc between two snapped corners has almost none, and each pass
 * bends its few interior points inward, rotating the fitted end tangents until a real
 * joint reads below the corner bar. Full passes from 16 points up, one pass down to 9,
 * raw below.
 */
function arcSmoothPasses(passes: number, arcLen: number): number {
  return arcLen >= 16 ? passes : arcLen >= 9 ? Math.min(passes, 1) : 0
}

/** A straight arm may extend its sample window this far (see armSamples). */
const SNAP_SPAN_MAX = 40
/** Max perp deviation (px) for an extension point to count as "still the same
 *  straight arm" — just above the ±0.5px staircase quantization. */
const SNAP_COLLINEAR = 0.75

/**
 * An arm line with the evidence that says whether it is a tangent at all: the max
 * perpendicular deviation of its own samples (`bow`) and the window's chord length.
 * A straight arm's samples sit on the line (bow ≈ the ±0.5px staircase, far less on a
 * sub-pixel displaced chain); a curved arm's line is a chord, and its bow is the arc's
 * sagitta over that window. The tangent pin needs the distinction: a chord's direction
 * is not the boundary's direction at the apex.
 */
export interface ArmFit {
  /** Unit direction, oriented along the chain's travel by the caller. On a curved arm
   *  this is the model tangent at the snapped apex, else the fitted line's direction. */
  dir: Vec
  /** Max |perpendicular deviation| of the arm samples from the fitted line, px — the
   *  curvature evidence, kept line-based even when the arm upgrades to a curve model. */
  bow: number
  /** Distance between the first and last arm sample, px. */
  chord: number
  /** Number of samples in the window. */
  n: number
  /** Which arm model placed this arm's side of the apex. Absent = line. */
  kind?: 'line' | 'circle' | 'tangent'
}

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

/** `armLine` plus the straightness evidence (see ArmFit). `dir` is returned raw — the
 *  caller orients it along the chain's travel. */
function armFitOf(pts: Vec[]): { line: { c: Vec; d: Vec }; fit: ArmFit } {
  const line = armLine(pts)
  let bow = 0
  for (const p of pts) {
    const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
    if (dev > bow) bow = dev
  }
  return { line, fit: { dir: line.d, bow, chord: dist(pts[0], pts[pts.length - 1]), n: pts.length } }
}

/**
 * Which rule decided where a corner's apex ended up. Every value but `reconstructed`
 * (and `cap`) keeps the raw lattice/chain vertex — they are the snap's refusals.
 */
export type ApexOutcome =
  | 'reconstructed' //  the arm-line intersection, inside the displacement cap
  | 'short-arm' //      neighbours too close to fit an arm at all
  | 'few-samples' //    a window with < 2 points on one side
  | 'parallel' //       the two arm lines are near-collinear (no intersection)
  | 'over-cap' //       the intersection ran further than the geometric cap allows
  | 'past-evidence' //  it ran past the coverage the raster carries
  | 'cap' //            placed by the cap resolver (arm ∩ cap-chord), not the apex snap

/** One corner the apex snap considered (`bench/apexDiag.ts`). Observational only.
 *  See PlanarFitOptions.apexDiag. */
export interface ApexDiagRecord {
  /** Shared-edge id. Attached by assemblePlanar — the fitter does not know it. */
  edge?: number
  /** The chain vertex the corner was detected at (lattice, or sub-pixel displaced). */
  cx: number
  cy: number
  /** Where the apex ended up — equal to (cx,cy) on every outcome but `reconstructed`. */
  ax: number
  ay: number
  /** dist((ax,ay), (cx,cy)) — how far the reconstruction moved the apex. */
  moved: number
  outcome: ApexOutcome
  /** The displacement cap in force (0 when the snap bailed before computing one). */
  allow: number
  /** Arm windows in chain steps, as the caller capped them. */
  inSpan: number
  outSpan: number
  /** Per-side tip censor (`armGap`) the caller chose — the samples skipped nearest the
   *  apex before the arm window starts. */
  inGap: number
  outGap: number
  /** Arm evidence, −1 where the arm was never fitted. */
  inBow: number
  outBow: number
  inChord: number
  outChord: number
  inN: number
  outN: number
  /** The raw arm intersection the estimator proposed, before any selector (cap, evidence
   *  veto, short-arm bypass) decided — NaN where no intersection exists. On `short-arm` it
   *  is the plain base-window line∩line, computed for the record only. */
  hx: number
  hy: number
  /** Interior angle between the two fitted arm lines at the apex (deg); −1 without arms.
   *  Acute tips — where a slow convergence throws the intersection far — read small. */
  tipDeg: number
  /** How far the own region's coverage reaches along the reconstruction ray, px.
   *  −1 when no probe was attached or the snap never got as far as asking. */
  reach: number
  /** Which model placed each arm's side of the apex. Absent = line. */
  inKind?: 'line' | 'circle' | 'tangent'
  outKind?: 'line' | 'circle' | 'tangent'
}

export type ApexDiag = (r: ApexDiagRecord) => void

/** Max interior tip angle (deg) for a corner reconstruction. A fitted tip this close to
 *  straight contradicts the ≥60°-turn corner definition by ≥30°: the "corner" is a
 *  staircase jog whose intersection is ill-conditioned along the boundary, and the reach
 *  probe cannot refuse it because the ray runs along a real edge whose AA fringe reads as
 *  coverage. */
const PARALLEL_TIP_DEG = 150
/** An arm's samples must bow at least this far (px) off their fitted line before the
 *  line is treated as a chord of a curve. Below it the line is within the staircase's
 *  own noise (the same regime as SNAP_COLLINEAR). */
const ARC_ARM_BOW_MIN = 0.5
/** The fitted circle ('circle' model) must explain the samples: radial deviation at most
 *  this fraction of the line's own bow, floored at SNAP_COLLINEAR (±0.5px quantization
 *  means even a perfectly circular arm cannot fit below it) — or the arm keeps the line. */
const ARC_ARM_DEV_K = 0.5
/** See PlanarFitOptions.arcPinMinN / arcArmMinN / arcPhiMinDeg / arcTipMinDeg /
 *  arcPinTurnMinDeg. */
const ARC_PIN_MIN_N = 12
const ARC_ARM_MIN_N = 12
const ARC_PHI_MIN_DEG = 10
const ARC_TIP_MIN_DEG = 45
const ARC_PIN_TURN_MIN_DEG = 70

/** An arm circle (Kasa fit — see fitCircle). */
type ArmCircle = { cx: number; cy: number; r: number }

/** Box-smooth a window (endpoints pinned). The raw samples near a corner are ±0.5px
 *  staircase (the sub-pixel pass reverts displacement there), and any shape statistic
 *  read off them — a Kasa radius, a sagitta — is step noise otherwise. */
function boxSmooth(ptsArm: Vec[], passes = 2): Vec[] {
  let sm = ptsArm
  for (let pass = 0; pass < passes && sm.length >= 3; pass++) {
    const next = sm.slice()
    for (let i = 1; i < sm.length - 1; i++) {
      next[i] = {
        x: (sm[i - 1].x + sm[i].x + sm[i + 1].x) / 3,
        y: (sm[i - 1].y + sm[i].y + sm[i + 1].y) / 3,
      }
    }
    sm = next
  }
  return sm
}

/** The arm circle, when the samples earn it — null keeps the line model. */
function armCircle(sm: Vec[], fit: ArmFit, opts: PlanarFitOptions): ArmCircle | null {
  const circ = fitCircle(sm)
  if (!circ) return null
  let dev = 0
  for (const p of sm) {
    const d = Math.abs(Math.hypot(p.x - circ.cx, p.y - circ.cy) - circ.r)
    if (d > dev) dev = d
  }
  if (dev > Math.max(SNAP_COLLINEAR, (opts.arcArmDevK ?? ARC_ARM_DEV_K) * fit.bow)) return null
  return circ
}

/**
 * The 'tangent' arm model: the line the arm's own curve is travelling at the tip end of
 * the window. A bent arm's LSQ line is a chord — offset by the sagitta and rotated by the
 * chord-to-tangent angle, both of which displace the apex along the other arm.
 *
 * The window is split at its middle and each half gets its own LSQ line; on a uniform arc
 * the two half directions disagree by θ/2 (θ the window's arc turn), and the tangent at
 * the tip end is the tip half's direction continued by another θ/4. Everything is read as
 * a direction over ≥6 samples: a sagitta statistic reads step phase and AA fattening as
 * curvature, and a Kasa radius on an ~8px window is noise. A straight staircase arm's
 * halves agree within noise, so the model degrades to the chord and polygonal art keeps
 * its corners.
 */
interface ArmTangent {
  /** Anchored tangent line at the window's tip end — the intersection target, and the
   *  direction the tangent pin consumes. */
  c: Vec
  d: Vec
}

function armTangent(sm: Vec[], line: { c: Vec; d: Vec }, phiMinDeg: number): ArmTangent | null {
  if (sm.length < 8) return null
  const half = sm.length >> 1
  const tipHalf = sm.slice(0, half)
  const farHalf = sm.slice(half)
  const tip = armLine(tipHalf)
  const far = armLine(farHalf)
  // Orient both along the full line's direction so the signed turn between them is
  // well-defined (armLine's direction sign is arbitrary).
  const alignTo = (d: Vec, ref: Vec): Vec => (d.x * ref.x + d.y * ref.y >= 0 ? d : { x: -d.x, y: -d.y })
  const dTip = alignTo(tip.d, line.d)
  const dFar = alignTo(far.d, line.d)
  // Signed half-turn φ (far → tip); the end tangent continues the same turning by φ/2.
  const sin = dFar.x * dTip.y - dFar.y * dTip.x
  const cos = dFar.x * dTip.x + dFar.y * dTip.y
  const phi = Math.atan2(sin, cos)
  // The curvature gate: see PlanarFitOptions.arcPhiMinDeg.
  if (Math.abs(phi) < (phiMinDeg * Math.PI) / 180) return null
  const rot = phi / 2
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  return {
    // Anchor: the tip half's own line, evaluated at the tip-end sample's projection —
    // a denoised point on the boundary at the window's corner end.
    c: (() => {
      const t0 = (sm[0].x - tip.c.x) * dTip.x + (sm[0].y - tip.c.y) * dTip.y
      return { x: tip.c.x + t0 * dTip.x, y: tip.c.y + t0 * dTip.y }
    })(),
    d: { x: dTip.x * cr - dTip.y * sr, y: dTip.x * sr + dTip.y * cr },
  }
}

/** Intersection candidates (0–2) of two arm primitives, each a line or a circle. */
function armIntersections(
  aLine: { c: Vec; d: Vec }, aCirc: ArmCircle | null,
  bLine: { c: Vec; d: Vec }, bCirc: ArmCircle | null,
): Vec[] {
  const circleLine = (circ: ArmCircle, line: { c: Vec; d: Vec }): Vec[] => {
    const t0 = (circ.cx - line.c.x) * line.d.x + (circ.cy - line.c.y) * line.d.y
    const qx = line.c.x + t0 * line.d.x
    const qy = line.c.y + t0 * line.d.y
    const h2 = circ.r * circ.r - ((qx - circ.cx) ** 2 + (qy - circ.cy) ** 2)
    if (h2 < 0) return []
    const h = Math.sqrt(h2)
    return [
      { x: qx + h * line.d.x, y: qy + h * line.d.y },
      { x: qx - h * line.d.x, y: qy - h * line.d.y },
    ]
  }
  if (aCirc && bCirc) {
    const dx = bCirc.cx - aCirc.cx
    const dy = bCirc.cy - aCirc.cy
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return []
    const a = (aCirc.r * aCirc.r - bCirc.r * bCirc.r + d * d) / (2 * d)
    const h2 = aCirc.r * aCirc.r - a * a
    if (h2 < 0) return []
    const h = Math.sqrt(h2)
    const mx = aCirc.cx + (a * dx) / d
    const my = aCirc.cy + (a * dy) / d
    return [
      { x: mx + (h * -dy) / d, y: my + (h * dx) / d },
      { x: mx - (h * -dy) / d, y: my - (h * dx) / d },
    ]
  }
  if (aCirc) return circleLine(aCirc, bLine)
  if (bCirc) return circleLine(bCirc, aLine)
  return [] // line×line is handled by the caller
}

/** Unit tangent of `circ` at `at`, oriented to agree with `along`. */
function circleTangentAt(circ: ArmCircle, at: Vec, along: Vec): Vec {
  let tx = -(at.y - circ.cy)
  let ty = at.x - circ.cx
  const l = Math.hypot(tx, ty) || 1
  tx /= l
  ty /= l
  return tx * along.x + ty * along.y >= 0 ? { x: tx, y: ty } : { x: -tx, y: -ty }
}

/**
 * The corner snap: place the apex on the intersection of the two arm models flanking it
 * (each sampled [gap..span] px away so the rounded tip is excluded), also returning the
 * two fitted arm directions (unit, oriented along the chain's travel: `inArm` into the
 * apex, `outArm` away from it) whenever the reconstruction had usable arm evidence —
 * null on the lattice-fallback paths. The tangent pin consumes them: on a sub-pixel
 * displaced chain the fitted arcs' end tangents at an apex rotate toward the bisector,
 * while the arm models read the true flank directions. An arm is a line while its
 * samples sit on one and an anchored tangent where they measurably curve; `winding`
 * (±1 for loops, 0 for open chains) feeds the concavity test.
 */
function snapCornerToArmsFull(
  pts: Vec[], c: number, inGap: number, outGap: number, inSpan: number, outSpan: number, inMax = 0, outMax = 0,
  opts: PlanarFitOptions = DEFAULT_PLANAR_FIT,
  winding = 0,
): { p: Vec; inArm: ArmFit | null; outArm: ArmFit | null; outcome: ApexOutcome; allow: number; hit: Vec | null } {
  const n = pts.length
  const keep = (outcome: ApexOutcome, inArm: ArmFit | null, outArm: ArmFit | null, allow = 0, hit: Vec | null = null) => ({
    p: { x: pts[c].x, y: pts[c].y }, inArm, outArm, outcome, allow, hit,
  })
  const wrap = (i: number): number => ((i % n) + n) % n
  // Base window [gap..span], then extend up to `max` while the arm stays collinear.
  // A shallow staircase (slope ~1/14) shows less than one unit step inside the base
  // window, so its fitted slope is step-phase noise, and at a narrow tip every slope
  // error multiplies by ~1/tan(tip) into apex error along the axis. Straight arms earn
  // the longer window; a curved arm fails the collinearity test at its first extension
  // and keeps the base window. Gaps are per side (armGap).
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
  // Short-arm bypass: reconstruction exists to recover an apex the raster eroded — a
  // shallow tip whose true corner sits px past the lattice — and needs arm evidence to
  // earn that. An arm with fewer than SHORT_ARM_SAMPLES samples is phase noise, and the
  // raw cluster apex, already sub-px correct on a feature that small, is kept.
  const inSamples = inSpan - inGap + 1
  const outSamples = outSpan - outGap + 1
  if (Math.min(inSamples, outSamples) < (opts.shortArmSamples ?? SHORT_ARM_SAMPLES)) {
    // Diagnostic only: what the plain base-window estimator would have said.
    let diagHit: Vec | null = null
    if (opts.apexDiag) {
      const a0 = collect(-1, inGap, inSpan, inSpan)
      const b0 = collect(1, outGap, outSpan, outSpan)
      if (a0.length >= 2 && b0.length >= 2) diagHit = lineIntersect(armLine(a0), armLine(b0))
    }
    return keep('short-arm', null, null, 0, diagHit)
  }
  const inPts = collect(-1, inGap, inSpan, inMax)
  const outPts = collect(1, outGap, outSpan, outMax)
  if (inPts.length < 2 || outPts.length < 2) return keep('few-samples', null, null)
  const aFit = armFitOf(inPts)
  const bFit = armFitOf(outPts)
  const a = aFit.line
  const b = bFit.line
  // Orient along chain travel: `a` was sampled before the apex (in), `b` after (out).
  const orient = (d: Vec, from: Vec, to: Vec): Vec => {
    const s = d.x * (to.x - from.x) + d.y * (to.y - from.y)
    return s >= 0 ? { x: d.x, y: d.y } : { x: -d.x, y: -d.y }
  }
  const inArm: ArmFit = { ...aFit.fit, dir: orient(a.d, pts[wrap(c - inSpan)], pts[c]) }
  const outArm: ArmFit = { ...bFit.fit, dir: orient(b.d, pts[c], pts[wrap(c + outSpan)]) }
  // The arms handed back are the tangent pin's evidence; a corner with a side under
  // ARM_PIN_SAMPLES places its apex (below) and pins nothing on either side.
  const pinMin = opts.armPinSamples ?? ARM_PIN_SAMPLES
  const pinOk = Math.min(inSamples, outSamples) >= pinMin
  const pinArm = (arm: ArmFit, _samples: number): ArmFit | null => (pinOk ? arm : null)
  // Near-parallel guard: interior angle between the two arms as rays leaving the apex —
  // a straight run reads 180°. See PARALLEL_TIP_DEG.
  if (opts.arcArms) {
    const cosI = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
    if ((Math.acos(cosI) * 180) / Math.PI > (opts.parallelTipDeg ?? PARALLEL_TIP_DEG)) {
      return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples))
    }
  }
  // Arm model: where an arm's samples measurably bow off their line, the line is a chord
  // of a curve and the chord intersection slides along the other arm. 'tangent' (default)
  // replaces the chord with the arm's anchored tangent line at the tip end of the window;
  // 'circle' intersects fitted circles instead. Straight arms keep the line either way.
  const bowMin = opts.arcArmBowMin ?? ARC_ARM_BOW_MIN
  const model = opts.arcArmModel ?? 'tangent'
  let aL: { c: Vec; d: Vec } = a
  let bL: { c: Vec; d: Vec } = b
  let circA: ArmCircle | null = null
  let circB: ArmCircle | null = null
  let tanA: ArmTangent | null = null
  let tanB: ArmTangent | null = null
  const armMinN = opts.arcArmMinN ?? ARC_ARM_MIN_N
  const phiMin = opts.arcPhiMinDeg ?? ARC_PHI_MIN_DEG
  // Tip floor: the chord-estimated interior angle (see PlanarFitOptions.arcTipMinDeg);
  // below it the chords stay. Concave corners (a notch into the loop's interior) are
  // exempt: both walls curve into the notch, so their chord tip under-reads badly, while
  // the acute tips the floor protects are convex corners of their region.
  const cosTip = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
  const turnCross = inArm.dir.x * outArm.dir.y - inArm.dir.y * outArm.dir.x
  const concave = winding !== 0 && turnCross * winding < 0
  const tipOk = concave || (Math.acos(cosTip) * 180) / Math.PI >= (opts.arcTipMinDeg ?? ARC_TIP_MIN_DEG)
  // Co-circular window extension: the line path grows a straight arm's evidence while
  // collinear (collect/inMax), but a curved arm's evidence would stop at the span cap
  // even where its arc continues cleanly, leaving the half-split φ at its noise floor.
  // So a bent arm may extend while new samples stay on its own fitted circle; a kinked
  // window breaks circle-consistency at once and extends nothing.
  const extendArc = (base: Vec[], sign: -1 | 1, span: number, max: number): Vec[] => {
    if (base.length < 8 || max <= span) return base
    const circ = fitCircle(boxSmooth(base))
    if (!circ) return base
    const out = base.slice()
    for (let o = span + 1; o <= max; o++) {
      const p = pts[wrap(c + sign * o)]
      if (Math.abs(Math.hypot(p.x - circ.cx, p.y - circ.cy) - circ.r) > 1.0) break
      out.push(p)
    }
    return out
  }
  if (opts.arcArms && tipOk && aFit.fit.bow > bowMin && aFit.fit.n >= armMinN) {
    const sm = boxSmooth(extendArc(inPts, -1, inSpan, inMax))
    if (model === 'circle') circA = armCircle(sm, aFit.fit, opts)
    else {
      tanA = armTangent(sm, a, phiMin)
      if (tanA) aL = tanA
    }
  }
  if (opts.arcArms && tipOk && bFit.fit.bow > bowMin && bFit.fit.n >= armMinN) {
    const sm = boxSmooth(extendArc(outPts, 1, outSpan, outMax))
    if (model === 'circle') circB = armCircle(sm, bFit.fit, opts)
    else {
      tanB = armTangent(sm, b, phiMin)
      if (tanB) bL = tanB
    }
  }
  const lineHit = (): Vec | null => {
    const det = aL.d.x * -bL.d.y - aL.d.y * -bL.d.x
    if (Math.abs(det) < 1e-6) return null
    const rx = bL.c.x - aL.c.x
    const ry = bL.c.y - aL.c.y
    const t = (rx * -bL.d.y - ry * -bL.d.x) / det
    return { x: aL.c.x + t * aL.d.x, y: aL.c.y + t * aL.d.y }
  }
  let hit: Vec | null
  if (!circA && !circB) hit = lineHit()
  else {
    // Two circles that fail to meet (fit noise on a near-tangent crotch) fall back to
    // the chord crossing; the caps below still bound whatever comes out.
    const cands = armIntersections(aL, circA, bL, circB)
    if (cands.length === 0) hit = lineHit()
    else {
      hit = cands[0]
      for (const p of cands) if (dist(p, pts[c]) < dist(hit, pts[c])) hit = p
    }
  }
  if (!hit) return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples))
  const ix = hit.x
  const iy = hit.y
  const hitOut: Vec = { x: ix, y: iy }
  // Report each arm's direction as the tangent at the apex; the tangent pin consumes it.
  const pinMinN = opts.arcPinMinN ?? ARC_PIN_MIN_N
  // Corrected turn: from the model tangents where they exist, else the chords.
  const dInF = tanA ? orient(tanA.d, pts[wrap(c - inSpan)], pts[c]) : circA ? circleTangentAt(circA, hit, inArm.dir) : inArm.dir
  const dOutF = tanB ? orient(tanB.d, pts[c], pts[wrap(c + outSpan)]) : circB ? circleTangentAt(circB, hit, outArm.dir) : outArm.dir
  const cosC = Math.min(1, Math.max(-1, -(dInF.x * dOutF.x + dInF.y * dOutF.y)))
  const turnC = 180 - (Math.acos(cosC) * 180) / Math.PI
  const pinTurnOk = turnC >= (opts.arcPinTurnMinDeg ?? ARC_PIN_TURN_MIN_DEG)
  const rePinA = opts.arcPin !== false && aFit.fit.n >= pinMinN && pinTurnOk
  const rePinB = opts.arcPin !== false && bFit.fit.n >= pinMinN && pinTurnOk
  if (circA) {
    if (rePinA) inArm.dir = circleTangentAt(circA, hit, inArm.dir)
    inArm.kind = 'circle'
  } else if (tanA) {
    if (rePinA) inArm.dir = orient(tanA.d, pts[wrap(c - inSpan)], pts[c])
    inArm.kind = 'tangent'
  }
  if (circB) {
    if (rePinB) outArm.dir = circleTangentAt(circB, hit, outArm.dir)
    outArm.kind = 'circle'
  } else if (tanB) {
    if (rePinB) outArm.dir = orient(tanB.d, pts[c], pts[wrap(c + outSpan)])
    outArm.kind = 'tangent'
  }
  // Re-check conditioning on the final tangents: a noisy shape model can rotate two
  // moderately-turning chords into near-collinearity, and such a "corner" both places
  // badly and reads smooth downstream. Same bound as the chord-side guard.
  if (opts.arcArms && (inArm.kind || outArm.kind)) {
    const cosF = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
    if ((Math.acos(cosF) * 180) / Math.PI > (opts.parallelTipDeg ?? PARALLEL_TIP_DEG)) {
      return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples), 0, hitOut)
    }
  }
  // Scale-aware displacement cap: how far the reconstructed apex may move off the
  // lattice corner is bounded by the evidence. A long-armed corner (an eroded shallow
  // tip) legitimately reconstructs several px past the lattice vertex. A short-armed
  // corner's arm lines are phase noise and it carries only sub-px erosion, so there is
  // little to reconstruct. Past the cap we keep the lattice corner.
  const shortSpan = Math.min(inSpan, outSpan)
  const allow = shortSpan >= (opts.snapSpan ?? SNAP_SPAN) ? Math.max(inSpan, outSpan) : Math.max(2, 0.5 * shortSpan)
  if (dist({ x: ix, y: iy }, pts[c]) > allow) return keep('over-cap', pinArm(inArm, inSamples), pinArm(outArm, outSamples), allow, hitOut)
  return { p: { x: ix, y: iy }, inArm: pinArm(inArm, inSamples), outArm: pinArm(outArm, outSamples), outcome: 'reconstructed', allow, hit: hitOut }
}

/** Intersection of two lines given as point + unit direction; null when parallel. */
function lineIntersect(a: { c: Vec; d: Vec }, b: { c: Vec; d: Vec }): Vec | null {
  const det = a.d.x * -b.d.y - a.d.y * -b.d.x
  if (Math.abs(det) < 1e-6) return null
  const rx = b.c.x - a.c.x
  const ry = b.c.y - a.c.y
  const t = (rx * -b.d.y - ry * -b.d.x) / det
  return { x: a.c.x + t * a.d.x, y: a.c.y + t * a.d.y }
}

/**
 * How far (px) past the raster's own evidence a reconstruction may land.
 *
 * The arm-line intersection is the right answer for a raster-eroded tip: a shallow point
 * genuinely sits px beyond the last labelled pixel. It is the wrong answer for an acute
 * curved counter, where each arm line is a chord leaning into the lens and the two chords
 * cross px past the real tip, inside solid ink.
 *
 * The two cases are indistinguishable by geometry (arm bow does not separate them). The
 * raster does: erosion leaves a decaying trail of partial coverage between the lattice
 * vertex and the true corner, while a counter reconstructed into its own stem has none —
 * coverage falls off a cliff at the lattice vertex. The rule bounds the overshoot past
 * that trail (`moved − reach`). Real eroded corners overshoot by under ~2px; tightening
 * this below 2.5 starts refusing them.
 */
const APEX_OVERSHOOT_MAX = 2.5

/**
 * The second half of the evidence rule. Overshoot alone does not separate the cases: a
 * genuinely eroded narrow spike at a coarse raster can overshoot the trail by more than
 * APEX_OVERSHOOT_MAX and still be right. What separates them is the fraction of the way
 * the raster's own material covers. Erosion hides only the last sliver of a tip, so the
 * trail runs most of the distance (≳0.63); an over-reconstruction leaves the shape at the
 * lattice vertex and keeps going, so the trail covers a minority (≲0.53).
 *
 * A reconstruction is corrected only when it both runs more than APEX_OVERSHOOT_MAX past
 * the evidence and the evidence covers less than this fraction of it.
 */
const APEX_REACH_FRAC = 0.6

/**
 * The apex snap, its raster-evidence veto, and the diagnostic emission — the one place
 * both cornered fitters get a corner from. `tipDeg` is the interior angle between the two
 * arms as rays leaving the apex (`inArm.dir` runs into the apex, `outArm.dir` away from
 * it), so a straight run reads 180° and an acute tip reads small: the shallower the tip,
 * the further a slope error in either arm throws their intersection along the bisector.
 */
function snapApex(
  pts: Vec[],
  c: number,
  inGap: number,
  outGap: number,
  inSpan: number,
  outSpan: number,
  inMax: number,
  outMax: number,
  opts: PlanarFitOptions,
  /** Loop orientation sign for the concavity test; 0 = open chain / unknown. */
  winding = 0,
): { p: Vec; inArm: ArmFit | null; outArm: ArmFit | null } {
  let full = snapCornerToArmsFull(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts, winding)
  let moved = dist(full.p, pts[c])
  // Only a reconstruction that already moved further than the bound can break it, so the
  // raster probe stays off the hot path for most corners.
  let reach = -1
  const overMax = opts.apexOvershootMax ?? APEX_OVERSHOOT_MAX
  const reachFrac = opts.apexReachFrac ?? APEX_REACH_FRAC
  // A short-armed reconstruction is asked the same question at a shorter range (see
  // SHORT_ARM_PROBE_MIN).
  const shortArmed = Math.min(inSpan - inGap, outSpan - outGap) + 1 < (opts.armPinSamples ?? ARM_PIN_SAMPLES)
  const probeMin = shortArmed ? Math.min(overMax, opts.shortArmProbeMin ?? SHORT_ARM_PROBE_MIN) : overMax
  if (opts.apexEvidence !== false && opts.apexReach && full.outcome === 'reconstructed' && moved > probeMin) {
    reach = opts.apexReach(pts[c], full.p)
    if (moved - reach > probeMin && reach < reachFrac * moved) {
      // Clamp to the evidence rather than fall back to the lattice vertex: where the tip
      // is partly eroded the truth lies between the two, and pinning to the lattice pulls
      // the whole adjacent arc in. `reach` is where the raster's own material stops.
      const k = reach / moved
      full = {
        p: { x: pts[c].x + (full.p.x - pts[c].x) * k, y: pts[c].y + (full.p.y - pts[c].y) * k },
        inArm: full.inArm, outArm: full.outArm, outcome: 'past-evidence', allow: full.allow, hit: full.hit,
      }
      moved = reach
    }
  }
  if (opts.apexDiag) {
    const a = full.inArm
    const b = full.outArm
    let tipDeg = -1
    if (a && b) {
      const cosI = Math.min(1, Math.max(-1, -(a.dir.x * b.dir.x + a.dir.y * b.dir.y)))
      tipDeg = (Math.acos(cosI) * 180) / Math.PI
    }
    opts.apexDiag({
      cx: pts[c].x, cy: pts[c].y,
      ax: full.p.x, ay: full.p.y,
      moved,
      outcome: full.outcome,
      allow: full.allow,
      inSpan, outSpan, inGap, outGap,
      hx: full.hit?.x ?? NaN, hy: full.hit?.y ?? NaN,
      inBow: a?.bow ?? -1, outBow: b?.bow ?? -1,
      inChord: a?.chord ?? -1, outChord: b?.chord ?? -1,
      inN: a?.n ?? -1, outN: b?.n ?? -1,
      tipDeg,
      reach,
      inKind: a?.kind ?? 'line', outKind: b?.kind ?? 'line',
    })
  }
  return { p: full.p, inArm: full.inArm, outArm: full.outArm }
}

/**
 * Indices of the sharp corners on a closed staircase loop — one per corner. The
 * same ±`win` macro-turn test as `detectCorners`, but each cluster of sub-threshold
 * vertices is collapsed to its geometric apex (the vertex farthest from its window
 * chord), and apexes within `mergeDist` px fuse (a rasterized tip is often a 1-px
 * plateau = two "shoulder" vertices, possibly split across the loop seam). Sorted
 * ascending. `turnDeg ≥ 180` ⇒ ∅ (disabled). Don't add finer-scale apexes: they
 * poison their neighbours' fitted tangents, and a staircase reads ~90° at ordinary step
 * vertices at small windows.
 */
export function detectLoopCorners(pts: Vec[], turnDeg: number, win = CORNER_WINDOW, mergeDist = CORNER_MERGE): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const cos = readTurnCos(pts, true, win, 0, n)
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

/** A loop is only offered to the disc reading when one circle fits its lattice samples
 *  this closely (px). A rasterized disc's staircase sits 0.4–0.9px off its own circle at
 *  every size measured; anything further is not a disc the ±win reading misread. */
const DISC_LOOP_MAX_DEV = 1.0

/**
 * Disc veto on a loop's corners. The ±`win` chord reading turns ≥60° on the staircase of
 * any disc under r ≈ 6px, so `detectLoopCorners` finds 2–5 "corners" on a small dot, the
 * loop is fitted corner-first, and planarBeautify's corner veto then refuses the circle
 * snap — small dots trace as lumpy polygons depending on sub-pixel phase.
 *
 * Radial deviation alone cannot decide it (a 6–8px square sits about as close to its
 * circle as a disc does), so the circle is asked to beat the polygon the corners claim:
 * a least-squares line through each arm's own samples. A real polygon's arms are straight
 * to the staircase's own noise; a disc's arms are arcs, and a line leaves their sagitta.
 * The arms are fitted rather than taken as apex-to-apex chords because the apex lands a
 * lattice step off a small square's corner, and that chord cuts across it. Squares ≤6px,
 * 6px triangles and small pentagons/hexagons still round — a circle already describes
 * them to within their staircase.
 */
export function discExplainsLoop(pts: Vec[], corners: number[]): boolean {
  const n = pts.length
  if (corners.length < 2 || n < 3) return false
  const c = fitCircle(pts)
  if (!c) return false
  let circMax = 0
  let circSq = 0
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
    if (e > circMax) circMax = e
    circSq += e * e
  }
  if (circMax > DISC_LOOP_MAX_DEV) return false
  // Five or more "corners" on a loop one circle already hugs to within a pixel: the
  // staircase of a 9px dot is a near-octagon whose short arms are straight, so the arm
  // test below cannot see it. No square, diamond or triangle reads ≥5 corners.
  if (corners.length >= 5) return true
  let armSq = 0
  let armN = 0
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const len = (((corners[(k + 1) % corners.length] - a) % n) + n) % n
    const arm: Vec[] = []
    for (let o = 0; o <= len; o++) arm.push(pts[(a + o) % n])
    if (arm.length < 2) continue
    // Total-least-squares line through the arm (principal axis of its samples).
    let mx = 0
    let my = 0
    for (const p of arm) {
      mx += p.x
      my += p.y
    }
    mx /= arm.length
    my /= arm.length
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const p of arm) {
      const dx = p.x - mx
      const dy = p.y - my
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const ux = Math.cos(th)
    const uy = Math.sin(th)
    for (const p of arm) {
      const e = -(p.x - mx) * uy + (p.y - my) * ux
      armSq += e * e
      armN++
    }
  }
  return armN > 0 && Math.sqrt(circSq / n) < Math.sqrt(armSq / armN)
}

/**
 * Bar-end cap resolver. Inside a cap narrower than ~2·CORNER_WINDOW the ±win turn test
 * cannot separate the two 90° shoulders: every vertex on the cap sees both shoulders
 * through the window and reads a diluted 60–90° turn, so the apex count and placement
 * depend on staircase phase (one apex with the far corner bevelled away, three blunt
 * ones, or two a px off the corners).
 *
 * The resolver re-reads each apex group (sub-threshold runs joined across gaps
 * ≤ CAP_JOIN_GAP) and classifies it as a cap on three pieces of evidence:
 *   • through-turn: travel direction reverses across the group (a bar end U-turns; a
 *     zigzag of corners nets a small turn and never qualifies);
 *   • chord: the group spans a cap-sized chord (a rasterized tip plateau is ≤2px and
 *     stays a tip; a wider cap already resolves into two clean shoulder runs);
 *   • flatness: every group vertex sits within CAP_FLAT px of the group chord (a star
 *     tip's V dips several px below its shoulder chord — this is what makes a cap a cap
 *     and a tip a tip).
 * A classified cap contributes exactly two corners — the group's outermost sub-threshold
 * vertices — and the arc between them is fitted as a straight line with both endpoints
 * snapped to the intersection of the adjacent long arm with the cap-chord line
 * (displacement capped at CAP_SNAP_MAX). Unclassified groups keep their detector apexes.
 */
// The constants below sit on a plateau (±1 notch changes nothing) except
// CAP_EXTEND_DEV: lower costs cap placement, higher starts eating real corners.
/** Arms must be anti-parallel within this (deg): a butt cap U-turns (~180°). */
const CAP_ANTIPARALLEL_DEG = 150
const CAP_CHORD_MIN = 3
const CAP_CHORD_MAX = 10
/** Max perp deviation (px) of the A..B interior from the A→B chord — what makes
 *  a cap a cap and a star-tip V a tip. */
const CAP_FLAT = 1.3
const CAP_JOIN_GAP = 6
const CAP_SNAP_MAX = 2.5
/** Arm seed starts this many steps outside the group center… */
const CAP_ARM_K = 10
/** …and spans this many vertices. Both sides must be straight (collinear). */
const CAP_ARM_SEED = 6
/** Arm-extension tolerance (px). Looser than SNAP_COLLINEAR: an AA edge at a half-pixel
 *  phase chatters ±1px around its mean line, which is noise, while the cap turn deviates
 *  2px+ and still stops the extension. */
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
  // Must be the same reading the detector used: a group here is a run of `sharp`
  // vertices, and a corner that falls in no group is dropped below.
  const cos = readTurnCos(pts, true, win, 0, n)
  const sharp = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (cos[i] < thr) sharp[i] = 1
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
  // Join runs across gaps ≤ CAP_JOIN_GAP into groups (cyclic — the last may wrap onto
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
  // One arm of the cap hypothesis: seed a line fit CAP_ARM_K steps outside the group
  // center (on the long edge, clear of the confusion zone), then extend it inward while
  // collinear — the extension stops at the true corner. Returns the stop vertex + the
  // travel-oriented arm direction, or null when the seed itself is not straight (small
  // cells and teeth wrap other corners into the seed window and must not be touched).
  const findArm = (m: number, sign: -1 | 1): { stop: number; dir: Vec } | null => {
    const seed: Vec[] = []
    for (let o = CAP_ARM_K + CAP_ARM_SEED - 1; o >= CAP_ARM_K; o--) seed.push(pts[wrap(m + sign * o)])
    let line = armLine(seed)
    for (const p of seed) {
      const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
      if (dev > SNAP_COLLINEAR) return null
    }
    // Extend inward, re-fitting the line as each vertex joins: a fixed seed slope is
    // step-phase noise on a low-angle staircase and would stop early; the refit
    // converges on the true edge and the stop lands at the corner.
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
    // Orient the fitted direction along travel (ascending index order).
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

/** Least-squares line through the interior staircase vertices of a cap arc (its
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

/** Snap one cap corner to the intersection of its long arm's fitted line with the
 *  shared cap-chord line. `sign` −1 ⇒ the long arm precedes the corner (an arc
 *  ends at this cap), +1 ⇒ it follows (an arc starts here). Falls back to the raw
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
 * is emitted as a straight line between its two snapped corners — a cubic fitted
 * over ≤7 ragged points bends its end tangents enough to read a true 90° corner
 * as 45°.
 */
/** Max rotation (deg) the tangent pin may apply to an apex handle. Beyond this the arm
 *  line and the fitted tangent genuinely disagree — a curved arm — and pinning would
 *  flatten real curvature at the corner. */
const PIN_ROTATE_MAX_DEG = 30

/**
 * The same rule in the units the curve feels. An angle cap alone bounds the wrong
 * quantity: rotating a handle moves the curve in proportion to the handle's length, so
 * the same 29° that is a harmless nudge on a 2px handle swings a 26px one 13px sideways
 * (enough to close a letter's counter).
 *
 * The pin exists to correct a tangent, so its side effect is bounded by the fit's own
 * tolerance: moving one cubic control point by d moves the curve by at most
 * max{3t(1−t)²} = 4/9 of d, and a correction that moves the curve further than ε is a
 * re-fit onto evidence the fit itself rejected. Derived, not calibrated; ordinary pins
 * sit well inside it.
 */
const PIN_CURVE_BASIS = 4 / 9

/** One tangent-pin candidate (`bench/pinDiag.ts`). Observational only.
 *  See PlanarFitOptions.pinDiag. */
export interface PinDiagRecord {
  /** Apex position. */
  x: number
  y: number
  /** Which handle of the apex node. */
  side: 'in' | 'out'
  /** Angle between the fitted handle and the arm-line direction (deg). */
  rotDeg: number
  /** Max deviation of the arm samples from their own line — 0 = a straight arm. */
  bow: number
  /** Chord length of the arm window (px) and its sample count. */
  chord: number
  n: number
  /** Handle length (px) — the pin keeps it and rotates only the direction. */
  handle: number
  /** Did the pin actually rotate this handle. */
  applied: boolean
}

export type PinDiag = (r: PinDiagRecord) => void

/** Rotate one handle of an apex node onto `arm.dir` (unit, oriented along chain travel),
 *  keeping its length. `hIn` sits behind the apex along the incoming direction; `hOut`
 *  ahead along the outgoing one. No-op on absent handles, past PIN_ROTATE_MAX, and past the
 *  curve-displacement bound (PIN_CURVE_BASIS). */
function pinHandle(node: PathNode, which: 'hIn' | 'hOut', arm: ArmFit, eps: number, diag?: PinDiag): void {
  const h = node[which]
  if (!h) return
  const vx = h.x - node.x
  const vy = h.y - node.y
  const len = Math.hypot(vx, vy)
  if (len < 1e-9) return
  const dir = arm.dir
  const sx = which === 'hIn' ? -dir.x : dir.x
  const sy = which === 'hIn' ? -dir.y : dir.y
  const cos = Math.min(1, Math.max(-1, (vx * sx + vy * sy) / len))
  const rotDeg = (Math.acos(cos) * 180) / Math.PI
  // How far the rotation moves the control point (the chord of the rotation), and through
  // it the curve. The angle cap says the arm line disagrees with the fit; the curve cap
  // says the disagreement matters at this handle's reach.
  const shift = 2 * len * Math.sin((rotDeg * Math.PI) / 360)
  const applied = cos >= Math.cos((PIN_ROTATE_MAX_DEG * Math.PI) / 180) && PIN_CURVE_BASIS * shift <= eps
  diag?.({ x: node.x, y: node.y, side: which === 'hIn' ? 'in' : 'out', rotDeg, bow: arm.bow, chord: arm.chord, n: arm.n, handle: len, applied })
  if (!applied) return
  node[which] = { x: node.x + len * sx, y: node.y + len * sy }
}

export function fitCorneredLoop(pts: Vec[], corners: number[], opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const resolved = resolveLoopCaps(pts, corners.slice().sort((a, b) => a - b), opts.cornerTurnDeg, opts.cornerWindow ?? CORNER_WINDOW)
  const snapSpan = opts.snapSpan ?? SNAP_SPAN
  const gapOf = (steps: number): number => opts.armGapFixed ?? armGap(steps)
  // Diagnostic only: a cap-resolved corner is placed by the resolver, not the apex snap,
  // but still gets a record.
  const capRecord = (c: number, p: Vec, toPrev: number, toNext: number): void => {
    if (!opts.apexDiag) return
    opts.apexDiag({
      cx: pts[c].x, cy: pts[c].y, ax: p.x, ay: p.y, moved: dist(p, pts[c]), outcome: 'cap', allow: CAP_SNAP_MAX,
      inSpan: Math.min(snapSpan, Math.max(gapOf(toPrev) + 1, toPrev - 1)), outSpan: Math.min(snapSpan, Math.max(gapOf(toNext) + 1, toNext - 1)),
      inGap: gapOf(toPrev), outGap: gapOf(toNext), hx: NaN, hy: NaN,
      inBow: -1, outBow: -1, inChord: -1, outChord: -1, inN: -1, outN: -1, tipDeg: -1, reach: -1, inKind: 'line', outKind: 'line',
    })
  }
  const C = resolved.corners
  // Cap pairing before the coincident-drop below: start → its twin (the next
  // corner). A pair whose members don't both survive the drop reverts to normal.
  const capPartner = new Map<number, number>()
  const capLineOf = new Map<number, { c: Vec; d: Vec }>()
  for (const s of resolved.capStarts) {
    const k = C.indexOf(s)
    const partner = C[(k + 1) % C.length]
    capPartner.set(s, partner)
    capLineOf.set(s, capChordLine(pts, s, partner))
  }
  // Loop orientation for the concavity test (signed shoelace area; y-down).
  let area2 = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    area2 += p.x * q.y - q.x * p.y
  }
  const winding = area2 > 0 ? 1 : area2 < 0 ? -1 : 0
  // Snap each corner, capping arm samples to the gap to its neighbour corners.
  // Arm directions ride along for the tangent pin (null wherever the snap fell back
  // to the lattice or the corner is cap-resolved — those get no pin).
  const armDirsAll: ({ inArm: ArmFit | null; outArm: ArmFit | null } | null)[] = []
  const snappedAll: Vec[] = C.map((c, k) => {
    const prev = C[(k - 1 + C.length) % C.length]
    const next = C[(k + 1) % C.length]
    const toPrev = wrap(c - prev)
    const toNext = wrap(next - c)
    // Cap corners: intersection of the long arm with the shared cap-chord line
    // (snapCapCorner). The long arm is on the non-cap side.
    if (capPartner.has(c)) {
      armDirsAll.push(null)
      const p = snapCapCorner(pts, c, -1, toPrev, capLineOf.get(c)!, CAP_SNAP_MAX)
      capRecord(c, p, toPrev, toNext)
      return p
    }
    if (capPartner.get(prev) === c) {
      armDirsAll.push(null)
      const p = snapCapCorner(pts, c, 1, toNext, capLineOf.get(prev)!, CAP_SNAP_MAX)
      capRecord(c, p, toPrev, toNext)
      return p
    }
    const inGap = gapOf(toPrev)
    const outGap = gapOf(toNext)
    const inSpan = Math.min(snapSpan, Math.max(inGap + 1, toPrev - 1))
    const outSpan = Math.min(snapSpan, Math.max(outGap + 1, toNext - 1))
    // Collinear straight arms may grow their evidence window up to SNAP_SPAN_MAX,
    // still never past the neighbouring corner.
    const inMax = Math.min(SNAP_SPAN_MAX, Math.max(inGap + 1, toPrev - 1))
    const outMax = Math.min(SNAP_SPAN_MAX, Math.max(outGap + 1, toNext - 1))
    const full = snapApex(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts, winding)
    armDirsAll.push({ inArm: full.inArm, outArm: full.outArm })
    return full.p
  })
  // Drop corners whose snapped point coincides with the previous (a shoulder pair
  // that both resolved onto the same apex) — incl. the cyclic first/last pair.
  const idx: number[] = []
  const snap: Vec[] = []
  const armDirs: ({ inArm: ArmFit | null; outArm: ArmFit | null } | null)[] = []
  for (let k = 0; k < C.length; k++) {
    const last = snap[snap.length - 1]
    if (last && dist(last, snappedAll[k]) < 1) continue
    idx.push(C[k])
    snap.push(snappedAll[k])
    armDirs.push(armDirsAll[k])
  }
  if (snap.length >= 2 && dist(snap[0], snap[snap.length - 1]) < 1) {
    idx.pop()
    snap.pop()
    armDirs.pop()
  }
  if (idx.length < 2) return fitLoopEdge(presmooth(pts, opts.smoothPasses, false), opts)
  // A cap arc is line-pinned only while its start and twin are still adjacent
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
      // group interior is this line's evidence (capChordLine), and a cubic over
      // ≤7 ragged points would wobble its end tangents.
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
    // Censor the cap remnants before pinning: the gap staircase points nearest each
    // corner are the rounded/eroded part the apex snap skips. Left in, they sit
    // laterally off the apex→arm line, so the fit chases them and arrives at the
    // snapped corner from the wrong side (an S-hook with an extra node). The trim
    // mirrors armGap, and only while ≥ 2 interior points survive so short arcs keep
    // their evidence.
    const trim = Math.min(gapOf(arc.length - 1), Math.max(0, (arc.length - 4) >> 1))
    const kept = arc.slice(trim, arc.length - trim)
    kept[0] = { x: snap[k].x, y: snap[k].y }
    kept[kept.length - 1] = { x: snap[(k + 1) % arcs].x, y: snap[(k + 1) % arcs].y }
    fitted.push(fitOpenArc(presmooth(kept, arcSmoothPasses(opts.smoothPasses, kept.length), true), opts))
  }

  // Tangent pin (pinCornerTangents — set only for sub-pixel displaced chains). Rotate
  // each apex-adjacent handle onto its fitted arm-line direction, keeping the handle's
  // length and the apex position. On a displaced chain the arc fit's end tangent rotates
  // toward the bisector and the corner's turn softens below the 60° sharp bar; the arm
  // line is the same evidence the apex position already trusts. pinHandle caps the
  // correction where the arm is genuinely curved.
  if (opts.pinCornerTangents) {
    for (let k = 0; k < arcs; k++) {
      const dirs = armDirs[k]
      if (!dirs) continue
      const arriving = fitted[(k - 1 + arcs) % arcs]
      const leaving = fitted[k]
      if (dirs.inArm && arriving.length >= 2) pinHandle(arriving[arriving.length - 1], 'hIn', dirs.inArm, opts.epsilon, opts.pinDiag)
      if (dirs.outArm && leaving.length >= 2) pinHandle(leaving[0], 'hOut', dirs.outArm, opts.epsilon, opts.pinDiag)
    }
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
 * Indices of the sharp corners interior to an open staircase polyline — one per
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
  const cos = readTurnCos(pts, false, win, lo, hi)
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
 * Open-edge counterpart of `fitCorneredLoop`: sharp corners interior to a
 * junction→junction edge get the same sub-pixel arm snap + cap-trim, so a tip that a
 * junction happened to split onto an open edge doesn't keep its raw lattice vertex
 * and hook around the eroded cap remnants. Differences from the loop version, both
 * forced by openness:
 *   • arm windows clamp at the endpoints instead of wrapping;
 *   • the edge's own endpoints are never snapped and never trimmed — they are
 *     junction anchors that must stay byte-coincident with sibling edges.
 */
export function fitCorneredOpen(pts: Vec[], pinned: ReadonlySet<number>, opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const fallback = (): PathNode[] => fitOpenArc(presmooth(pts, opts.smoothPasses, true, pinned), opts)
  // Clustered corners (one per feature, like the loop path) — the raw `pinned`
  // set has both staircase shoulders of a vertex, which must not become two
  // breakpoints (a 2-node chamfer where the art has one corner).
  let C = detectOpenCorners(pts, opts.cornerTurnDeg, opts.cornerWindow ?? CORNER_WINDOW, opts.cornerMerge ?? CORNER_MERGE)
  if (n < 2 * SNAP_GAP + 3) return fallback()
  const snapSpan = opts.snapSpan ?? SNAP_SPAN
  const gapOf = (steps: number): number => opts.armGapFixed ?? armGap(steps)

  // Prune-and-refit loop: a detected corner whose fitted junction comes out
  // nearly straight was a local staircase jog (e.g. the boundary bending into a
  // junction's AA neighbourhood), not a real corner — forcing a hard breakpoint
  // there asserts geometry the art doesn't have. Detection can't tell (the ±win
  // raw turn is above threshold); the fit can. Each pass drops the weak
  // breakpoints and refits without them; terminates because C strictly shrinks.
  for (;;) {
    if (C.length === 0) return fallback()

    const armDirsAll: { inArm: ArmFit | null; outArm: ArmFit | null }[] = []
    const snappedAll: Vec[] = C.map((c, k) => {
      const toPrev = c - (k > 0 ? C[k - 1] : 0)
      const toNext = (k < C.length - 1 ? C[k + 1] : n - 1) - c
      const inGap = gapOf(toPrev)
      const outGap = gapOf(toNext)
      // Same spans as the loop version, additionally clamped so no window index
      // leaves [0, n-1] (open: there is nothing to wrap onto).
      const inSpan = Math.min(snapSpan, Math.max(inGap + 1, toPrev - 1), c)
      const outSpan = Math.min(snapSpan, Math.max(outGap + 1, toNext - 1), n - 1 - c)
      const inMax = Math.min(SNAP_SPAN_MAX, Math.max(inGap + 1, toPrev - 1), c)
      const outMax = Math.min(SNAP_SPAN_MAX, Math.max(outGap + 1, toNext - 1), n - 1 - c)
      const full = snapApex(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts)
      armDirsAll.push({ inArm: full.inArm, outArm: full.outArm })
      return full.p
    })
    // Drop corners whose snap collapsed onto the previous breakpoint or an endpoint.
    const idx: number[] = []
    const snap: Vec[] = []
    const armDirs: { inArm: ArmFit | null; outArm: ArmFit | null }[] = []
    for (let k = 0; k < C.length; k++) {
      const prevPin = snap[snap.length - 1] ?? pts[0]
      if (dist(prevPin, snappedAll[k]) < 1 || dist(pts[n - 1], snappedAll[k]) < 1) continue
      idx.push(C[k])
      snap.push(snappedAll[k])
      armDirs.push(armDirsAll[k])
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
      const pieceGap = gapOf(piece.length - 1)
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

    // Tangent pin, as in fitCorneredLoop. It matters more here: the weak-turn prune
    // below reads these tangents, so a displaced chain's softened tangents would get a
    // genuine corner pruned outright, not just rounded.
    if (opts.pinCornerTangents) {
      for (let k = 0; k < idx.length; k++) {
        const dirs = armDirs[k]
        if (!dirs) continue
        const arriving = fitted[k]
        const leaving = fitted[k + 1]
        if (dirs.inArm && arriving.length >= 2) pinHandle(arriving[arriving.length - 1], 'hIn', dirs.inArm, opts.epsilon, opts.pinDiag)
        if (dirs.outArm && leaving && leaving.length >= 2) pinHandle(leaving[0], 'hOut', dirs.outArm, opts.epsilon, opts.pinDiag)
      }
    }

    // Stitch: each interior breakpoint is one hard node — arriving hIn, leaving
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
    // detection accepts turns ≥ cornerTurnDeg; a jog fits nearly straight.
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
 * Fit a pure closed-loop edge (no junction) with curveFit's `fitClosedLoop`.
 * Returns closed-loop nodes, or a coarse fallback.
 */
export function fitLoopEdge(densePts: Vec[], opts: PlanarFitOptions): PathNode[] {
  const fitOpts: CurveFitOptions = { epsilon: opts.epsilon, lineCost: opts.lineCost, cubicCost: opts.cubicCost }
  const nodes = fitClosedLoop(densePts, fitOpts)
  if (nodes && nodes.length >= 2) return nodes
  // Degenerate tiny loop: keep its dedup'd polygon as corners.
  const d = dedup(densePts)
  return d.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const }))
}
