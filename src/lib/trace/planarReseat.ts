// Junction re-seat for the planar tracer: a planarBeautify pre-pass that moves a
// degree-3 junction to the intersection of the two strongest fitted primitives
// (line / circle) arriving at it, when the vertex lies close to both yet their
// intersection lies measurably away along them.
//
// Where a straight edge crosses a disc near-tangentially, the sliver of colour
// between the two boundaries is sub-pixel thin near the true crossing, so
// anti-aliasing and quantization give its pixels to a neighbouring class and the
// label-map junction lands several pixels along the tangent, where the sliver first
// becomes wide enough to survive. Every downstream fit honours the pinned vertex,
// so the line's last segment bends off to reach it. The raster no longer holds the
// true point, but the fitted primitives of the long incident boundaries do: their
// intersection restores the junction, and the mangled terminal caps are re-emitted
// from the primitives.
//
// Unlike planarJunction's sub-pixel refinement (which fits the raw lattice arms near
// the corner, i.e. the mangled evidence, and moves every junction a little), this
// pass fires only on a positively identified slide: vertex within NEAR_TOL of both
// primitives, correction ≥ MIN_MOVE, transversal incidence at the target.
//
// Deterministic (fixed vertex/edge order). Mutates `edges` / `vertices` in place;
// planarBeautify passes it cloned copies.

import type { EdgeRef, PathNode, SharedEdge, Vec, Vertex } from '../path/types'
import { armLine } from './planarFit.ts'
import { arcSlice, type Circle, fitCircle, maxRadialDev } from './circleFit.ts'
import { weldJunctionClusters } from './planarWeld.ts'

/** Vertex must lie within this (px) of both primitives; a junction far from a
 *  primitive is not a slide and must not be pulled onto it. */
const NEAR_TOL = 3.0
/** Hard cap on the correction distance (px). */
const MAX_SLIDE = 12
/** Corrections below this (px) are ordinary lattice noise, not a slide, and are
 *  skipped so correct junctions stay untouched. */
const MIN_MOVE = 1.5
/** Primitives must cross at least this transversally at the target (near-tangent
 *  intersections are numerically unstable along the shared tangent). */
const MIN_ANGLE_SIN = Math.sin((5 * Math.PI) / 180)
/** Arm evidence budget (px along the fitted boundary, from the vertex inward). */
const ARM_MAX = 110
/** A terminal segment no longer than this (px) may be a mangled cap — the fit
 *  chasing the misassigned pixels into the junction — and its arm may exclude it. */
const CAP_MAX = 24
/** Max perp deviation for a line arm / radial deviation for a circle arm. */
const LINE_TOL = 0.8
const CIRC_TOL = 0.9
/** Minimum arm length to claim a line / a circle (a circle needs enough sweep
 *  to pin its centre). */
const MIN_LINE_ARM = 8
const MIN_ARC_ARM = 24
/**
 * Through-pair veto (degrees). A re-seat target is the intersection of two different
 * boundaries, but at a degree-3 junction two of the arms may be the halves of one
 * boundary passing through while the third terminates on it; intersecting those two
 * halves (e.g. across a slight corner) moves the junction to a meaningless point.
 *
 * The turn between two arms is 180° minus the angle between their away-from-vertex
 * directions: 0° for a boundary continuing straight through, near 180° for the flanks of
 * a needle. The smallest-turn pair is taken as the through-boundary and refused as a
 * re-seat pair, but only when the third arm meets both its halves at least this
 * transversally — a T, not a needle. At a near-tangent crossing (the case this pass
 * exists for) all three arms lie close to one line and the smallest turn says nothing.
 */
const THROUGH_VETO_DEG = 45
/** Circle-radius sanity range for an arm primitive. */
const R_MIN = 6
const R_MAX = 2500
/** Stop collecting arm segments at a fitted corner turning sharper than this: the
 *  boundary beyond a corner is a different primitive. */
const CORNER_STOP_COS = Math.cos((30 * Math.PI) / 180)
/** The corner stop is bypassed at the first interior node when the terminal segment
 *  is at most this long (px): a tiny cap kinked into a long run is the mangle itself,
 *  and stopping there would leave the cap-skip nothing to fit. If the bypass does
 *  cross a real corner, the full-arm fit fails and the cap-skipped fit must still
 *  pass NEAR_TOL at the vertex. */
const CAP_STOP_BYPASS = 8
/** Samples per cubic segment when flattening an arm. */
const ARM_SAMPLES = 12
/** Chord straightening: the two junction line primitives must be this collinear
 *  (angle / mutual offset) to count as one continuing occluder line, */
const CHORD_COLLINEAR_SIN = Math.sin((3 * Math.PI) / 180)
const CHORD_COLLINEAR_OFF = 1.0
/** the edge between them must stay within this (px) of that line (looser than the
 *  arm tolerance, since it crosses the mangled zone), */
const CHORD_TOL = 2.5
/**
 * and the chord may be no longer than this times the two line arms' fitted lengths
 * (`Prim.conf`) summed. The arms are the observed straight runs either side of the
 * gap; straightening more span than was observed straight would be extrapolation
 * (e.g. two short straight feet either side of a gently curved arch). Both sides of
 * the bound are spans of art, so it behaves the same at every raster size.
 */
const CHORD_ARM_K = 1

/**
 * Diagnostic record for the chord pass: one per candidate edge, with the value each
 * gate saw and which gate stopped it. Output is identical with or without an observer.
 */
export interface ChordCandidate {
  edgeId: number
  /** `dist(a,b)` — the artwork span the length bound is compared against. */
  len: number
  /** Max deviation of the edge's own fit from the re-seat line (CHORD_TOL). */
  maxDev: number
  sameLine: boolean
  verdict: 'straightened' | 'too-long' | 'not-collinear' | 'dev-exceeded'
  /** Fitted arm length (px, `Prim.conf`) of the line primitive at each end. */
  armA: number
  armB: number
  /** Each sample's distance off the re-seat line against its arc distance `s` from the
   *  nearer endpoint. Empty unless `sameLine`. */
  profile: { s: number; dev: number }[]
}
export type ChordObserver = (c: ChordCandidate) => void

/**
 * Diagnostic record for the re-seat: one per degree-3 interior junction weighed — each
 * incident arm's primitive verdict (and why it was refused), the winning pair, and how far
 * the vertex moved. Nothing extra is computed without an observer.
 */
export interface ReseatVerdict {
  vertex: number
  /** The lattice position before any move. */
  x: number
  y: number
  arms: {
    kind: 'line' | 'circle' | null
    /** Fitted arm length (px): the primitive's `conf`, or the collected length when refused. */
    conf: number
    /** Fitted radius for a circle arm (NaN otherwise). */
    r: number
    skipCap: boolean
    /** Empty for an accepted primitive; the gate(s) that refused it otherwise. */
    why: string
    /** Length (px) of the arm's terminal fitted segment, the value `CAP_MAX` and
     *  `CAP_STOP_BYPASS` compare against. */
    segLen0: number
    /**
     * Every estimator with gates ignored: line and circle fitted to the full arm and to
     * the arm without its terminal segment, each with the deviation the tolerance gate
     * would read. Null when the fit is degenerate.
     */
    alt: ReseatArmAlt | null
  }[]
  /** Arm indices of the winning pair (null when no pair qualified). */
  pair: [number, number] | null
  /** The pair the through-pair veto refused at this junction (null when none was). */
  vetoed: [number, number] | null
  /** The pair's intersection — where the vertex goes (or would go, below MIN_MOVE); NaN
   *  with no pair. Unlike the lattice corner it is stable across raster sizes. */
  tx: number
  ty: number
  /** Distance the vertex moved (0 when it was not re-seated). */
  move: number
  reason: 'moved' | 'below MIN_MOVE' | 'no pair' | 'border'
}
export type ReseatObserver = (v: ReseatVerdict) => void

/** One ungated fit of an arm — see `ReseatVerdict.arms[].alt`. */
export interface ReseatArmAlt {
  /** Collected arm length (px) the fits below were made over. */
  len: number
  line: { prim: ReseatPrim; dev: number } | null
  circle: { prim: ReseatPrim; dev: number } | null
  /** The same two fits with the terminal segment excluded (null when the arm has one
   *  segment) — what the cap-skip branch would see, regardless of `CAP_MAX`. */
  noCap: {
    len: number
    line: { prim: ReseatPrim; dev: number } | null
    circle: { prim: ReseatPrim; dev: number } | null
  } | null
}

/**
 * Diagnostic overrides for the arm-certification constants. Each field defaults to the
 * module constant of the same name; not a product option.
 */
export interface ReseatTune {
  armMax?: number
  lineTol?: number
  circTol?: number
  minArcArm?: number
  capMax?: number
  /** `THROUGH_VETO_DEG`; 0 disables the through-pair veto. */
  throughVeto?: number
}

interface Cfg {
  armMax: number
  lineTol: number
  circTol: number
  minArcArm: number
  capMax: number
  throughVeto: number
}

const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)

/** A terminal primitive at one edge end. Line: point `a` + unit dir `d`.
 *  Circle: `c`. `conf` = arm length (px); `skipCap` = the terminal segment was
 *  excluded as a suspected mangled cap. Exported (as `ReseatPrim`) only so the
 *  diagnostic can intersect the ungated alternatives with `intersectPrims`. */
interface Prim {
  kind: 'line' | 'circle'
  a?: Vec
  d?: Vec
  c?: Circle
  conf: number
  skipCap: boolean
}
export type ReseatPrim = Prim

interface End {
  e: SharedEdge
  atEnd: boolean
}

/** Sample the cubic (p, h1, h2, q) at `n` interior steps, including both ends. */
function sampleCubic(p: Vec, h1: Vec | null, h2: Vec | null, q: Vec, n: number, out: Vec[]): void {
  const c1 = h1 ?? p
  const c2 = h2 ?? q
  for (let i = 0; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({
      x: u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x,
      y: u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y,
    })
  }
}

/** Polyline length. */
function polyLen(pts: Vec[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += dist(pts[i - 1], pts[i])
  return l
}

interface Arm {
  /** Per fitted segment, flattened points ordered from the vertex inward
   *  (segPts[0][0] is the vertex-side anchor). */
  segPts: Vec[][]
  segLen: number[]
}

/**
 * Flatten the fitted segments of `e` from the `atEnd` endpoint inward, stopping
 * at ARM_MAX px or at an interior corner turning ≥ 30° (the boundary beyond a
 * corner belongs to a different primitive).
 */
function collectArm(e: SharedEdge, atEnd: boolean, cfg: Cfg): Arm {
  const nodes = e.nodes
  const m = nodes.length
  const segPts: Vec[][] = []
  const segLen: number[] = []
  let cum = 0
  let prevDir: Vec | null = null
  const count = m - 1
  for (let s = 0; s < count && cum < cfg.armMax; s++) {
    // Node closer to the vertex (`p`) and its inner neighbour (`q`), with the
    // handles facing each other in that orientation.
    const p = atEnd ? nodes[m - 1 - s] : nodes[s]
    const q = atEnd ? nodes[m - 2 - s] : nodes[s + 1]
    const h1 = atEnd ? p.hIn : p.hOut
    const h2 = atEnd ? q.hOut : q.hIn
    const pts: Vec[] = []
    sampleCubic(p, h1, h2, q, ARM_SAMPLES, pts)
    // Corner stop: direction entering `p` (from the previous segment) vs leaving.
    // Bypassed at the first interior node behind a very short cap — see CAP_STOP_BYPASS.
    if (prevDir && !(s === 1 && segLen[0] <= CAP_STOP_BYPASS)) {
      const d0 = pts[1] ?? pts[0]
      const dx = d0.x - p.x
      const dy = d0.y - p.y
      const l = Math.hypot(dx, dy)
      if (l > 1e-9) {
        const cos = (prevDir.x * dx + prevDir.y * dy) / l
        if (cos < CORNER_STOP_COS) break
      }
    }
    const last = pts[pts.length - 1]
    const penult = pts[pts.length - 2] ?? pts[0]
    const ex = last.x - penult.x
    const ey = last.y - penult.y
    const el = Math.hypot(ex, ey)
    prevDir = el > 1e-9 ? { x: ex / el, y: ey / el } : prevDir
    segPts.push(pts)
    const l = polyLen(pts)
    segLen.push(l)
    cum += l
  }
  return { segPts, segLen }
}

/** Max perp deviation of `pts` from the line (a, d). */
function lineMaxDev(pts: Vec[], a: Vec, d: Vec): number {
  let maxD = 0
  for (const p of pts) {
    const dev = Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x)
    if (dev > maxD) maxD = dev
  }
  return maxD
}

/** Fit `pts` (total length `len`) to a line, else a circle. `why` names the gate(s) that
 *  refused it (empty on success), for the diagnostic observer. */
function evalArm(pts: Vec[], len: number, cfg: Cfg): { prim: Prim | null; why: string } {
  if (pts.length < 2) return { prim: null, why: 'empty' }
  let why: string
  if (len >= MIN_LINE_ARM) {
    const l = armLine(pts)
    const dev = lineMaxDev(pts, l.c, l.d)
    if (dev <= cfg.lineTol) return { prim: { kind: 'line', a: l.c, d: l.d, conf: len, skipCap: false }, why: '' }
    why = `line-dev ${dev.toFixed(2)}`
  } else why = `short ${len.toFixed(0)}`
  if (len >= cfg.minArcArm) {
    const c = fitCircle(pts)
    if (!c) why += ' · no-circle'
    else if (c.r < R_MIN) why += ` · r ${c.r.toFixed(1)} < R_MIN`
    else if (c.r > R_MAX) why += ` · r ${c.r.toFixed(0)} > R_MAX`
    else {
      const rd = maxRadialDev(pts, c)
      if (rd <= cfg.circTol) return { prim: { kind: 'circle', c, conf: len, skipCap: false }, why: '' }
      why += ` · circ-dev ${rd.toFixed(2)} (r ${c.r.toFixed(0)})`
    }
  } else why += ` · arc-short ${len.toFixed(0)}`
  return { prim: null, why }
}

/** Both fits of an arm with every gate ignored (diagnostics only). */
function altFits(pts: Vec[], len: number): { line: ReseatArmAlt['line']; circle: ReseatArmAlt['circle'] } {
  if (pts.length < 2) return { line: null, circle: null }
  const l = armLine(pts)
  const line = {
    prim: { kind: 'line' as const, a: l.c, d: l.d, conf: len, skipCap: false },
    dev: lineMaxDev(pts, l.c, l.d),
  }
  const c = fitCircle(pts)
  const circle = c
    ? { prim: { kind: 'circle' as const, c, conf: len, skipCap: false }, dev: maxRadialDev(pts, c) }
    : null
  return { line, circle }
}

/**
 * Terminal primitive at one edge end. Preference order: the arm including the
 * terminal segment; else, when the terminal segment is short enough to be a
 * mangled cap, the arm excluding it. `len` is the collected arm length either
 * way; `why` the refusal(s) when `prim` is null; `dir` the arm's overall
 * away-from-vertex direction (read by the through-pair veto).
 */
function endPrimitive(
  e: SharedEdge,
  atEnd: boolean,
  cfg: Cfg,
  wantAlt: boolean,
): { prim: Prim | null; len: number; why: string; segLen0: number; dir: Vec | null; alt: ReseatArmAlt | null } {
  const arm = collectArm(e, atEnd, cfg)
  if (arm.segPts.length === 0) return { prim: null, len: 0, why: 'no arm', segLen0: 0, dir: null, alt: null }
  const all: Vec[] = []
  for (const seg of arm.segPts) for (const p of seg) all.push(p)
  const total = arm.segLen.reduce((a, b) => a + b, 0)
  // Away-from-vertex direction of the whole arm: vertex → centroid of its samples.
  // Defined whether or not the arm certifies a primitive.
  let cx = 0
  let cy = 0
  for (const p of all) {
    cx += p.x
    cy += p.y
  }
  cx = cx / all.length - all[0].x
  cy = cy / all.length - all[0].y
  const cl = Math.hypot(cx, cy)
  const dir = cl > 1e-9 ? { x: cx / cl, y: cy / cl } : null
  const rest: Vec[] = []
  if (arm.segPts.length >= 2) for (let s = 1; s < arm.segPts.length; s++) for (const p of arm.segPts[s]) rest.push(p)
  let alt: ReseatArmAlt | null = null
  if (wantAlt) {
    alt = {
      len: total,
      ...altFits(all, total),
      noCap: rest.length ? { len: total - arm.segLen[0], ...altFits(rest, total - arm.segLen[0]) } : null,
    }
  }
  const pa = evalArm(all, total, cfg)
  if (pa.prim) return { prim: pa.prim, len: total, why: '', segLen0: arm.segLen[0], dir, alt }
  let why = pa.why
  if (arm.segPts.length >= 2 && arm.segLen[0] <= cfg.capMax) {
    const pb = evalArm(rest, total - arm.segLen[0], cfg)
    if (pb.prim) return { prim: { ...pb.prim, skipCap: true }, len: total, why: '', segLen0: arm.segLen[0], dir, alt }
    why += ` | cap-skipped: ${pb.why}`
  }
  return { prim: null, len: total, why, segLen0: arm.segLen[0], dir, alt }
}

/** Distance from `p` to a primitive. */
function primDist(p: Vec, pr: Prim): number {
  if (pr.kind === 'line') return Math.abs((p.x - pr.a!.x) * pr.d!.y - (p.y - pr.a!.y) * pr.d!.x)
  const c = pr.c!
  return Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
}

/** Unit tangent of a primitive at a point on (or near) it. */
function primTangent(p: Vec, pr: Prim): Vec {
  if (pr.kind === 'line') return pr.d!
  const c = pr.c!
  const dx = p.x - c.cx
  const dy = p.y - c.cy
  const l = Math.hypot(dx, dy) || 1
  return { x: -dy / l, y: dx / l }
}

/** Intersection points of two primitives (0, 1 or 2). Exported for the diagnostic only. */
export function intersectPrims(p1: Prim, p2: Prim): Vec[] {
  return intersect(p1, p2)
}
function intersect(p1: Prim, p2: Prim): Vec[] {
  if (p1.kind === 'line' && p2.kind === 'line') {
    const det = p1.d!.x * p2.d!.y - p1.d!.y * p2.d!.x
    if (Math.abs(det) < MIN_ANGLE_SIN) return []
    const rx = p2.a!.x - p1.a!.x
    const ry = p2.a!.y - p1.a!.y
    const t = (rx * p2.d!.y - ry * p2.d!.x) / det
    return [{ x: p1.a!.x + t * p1.d!.x, y: p1.a!.y + t * p1.d!.y }]
  }
  if (p1.kind === 'circle' && p2.kind === 'circle') {
    const c1 = p1.c!
    const c2 = p2.c!
    const dx = c2.cx - c1.cx
    const dy = c2.cy - c1.cy
    const d = Math.hypot(dx, dy)
    if (d < 1e-9 || d > c1.r + c2.r || d < Math.abs(c1.r - c2.r)) return []
    const a = (d * d + c1.r * c1.r - c2.r * c2.r) / (2 * d)
    const h2 = c1.r * c1.r - a * a
    if (h2 < 0) return []
    const h = Math.sqrt(h2)
    const mx = c1.cx + (a * dx) / d
    const my = c1.cy + (a * dy) / d
    const ox = (-dy * h) / d
    const oy = (dx * h) / d
    return [
      { x: mx + ox, y: my + oy },
      { x: mx - ox, y: my - oy },
    ]
  }
  const line = p1.kind === 'line' ? p1 : p2
  const circ = p1.kind === 'circle' ? p1 : p2
  const c = circ.c!
  const t0 = (c.cx - line.a!.x) * line.d!.x + (c.cy - line.a!.y) * line.d!.y
  const fx = line.a!.x + t0 * line.d!.x
  const fy = line.a!.y + t0 * line.d!.y
  const h2 = c.r * c.r - ((c.cx - fx) ** 2 + (c.cy - fy) ** 2)
  if (h2 < 0) return []
  const h = Math.sqrt(h2)
  return [
    { x: fx + h * line.d!.x, y: fy + h * line.d!.y },
    { x: fx - h * line.d!.x, y: fy - h * line.d!.y },
  ]
}

/**
 * Re-map a curved terminal segment onto a moved endpoint `H`, keeping its
 * curvature. A rigid shift keeps handles sized for the old span, so when the
 * correction shortens the segment the cubic bulges outward by the leftover
 * handle length.
 *
 * The control polygon is carried by the similarity that maps the old endpoint
 * onto `H` about the inner anchor, except that the component perpendicular to
 * the chord scales by k² rather than k: a circular arc's sagitta goes as
 * chord²/radius, so a pure similarity would inflate the radius as the chord
 * shrinks. Exact for a straight segment and for a circular arc.
 *
 * Only shrinking (k < 1) is corrected. A lengthened span leaves the handles too
 * short, flattening the segment toward its chord — the conservative error — while
 * scaling a near-straight fit's wobble by k² can turn it into a visible S-kink.
 * Returns false when the caller should apply the plain shift instead.
 */
/** Floor on `k` for the perpendicular term, so a near-collapsed span does not flatten
 *  the segment entirely to its chord. */
const RESHAPE_K_MIN = 0.25

function reshapeTerminalTo(T: PathNode, inner: PathNode, atEnd: boolean, H: Vec): boolean {
  const hT = atEnd ? T.hIn : T.hOut
  const hI = atEnd ? inner.hOut : inner.hIn
  // A straight terminal segment is already exact under a plain shift.
  if (!hT && !hI) return false
  const ux = T.x - inner.x
  const uy = T.y - inner.y
  const L0 = Math.hypot(ux, uy)
  const vx = H.x - inner.x
  const vy = H.y - inner.y
  const L1 = Math.hypot(vx, vy)
  if (L0 < 1e-6 || L1 < 1e-6) return false
  const k = L1 / L0
  if (k >= 1) return false // growth: the plain shift's flattening is the safe error
  const kPerp = k * Math.max(RESHAPE_K_MIN, k)
  // Orthonormal frames on the old and new chords (both rooted at `inner`).
  const oax = ux / L0
  const oay = uy / L0
  const nax = vx / L1
  const nay = vy / L1
  const remap = (h: Vec): void => {
    const dx = h.x - inner.x
    const dy = h.y - inner.y
    const along = (dx * oax + dy * oay) * k
    const perp = (dx * -oay + dy * oax) * kPerp
    h.x = inner.x + along * nax + perp * -nay
    h.y = inner.y + along * nay + perp * nax
  }
  if (hT) remap(hT)
  if (hI) remap(hI)
  T.x = H.x
  T.y = H.y
  return true
}

/** Move a node's anchor, carrying its handles by the same delta. */
function shiftNodeTo(n: PathNode, x: number, y: number): void {
  const dx = x - n.x
  const dy = y - n.y
  n.x = x
  n.y = y
  if (n.hIn) {
    n.hIn.x += dx
    n.hIn.y += dy
  }
  if (n.hOut) {
    n.hOut.x += dx
    n.hOut.y += dy
  }
}

/**
 * Sweep-side hint for a terminal arc re-emit. A terminal segment is junction-local
 * and can never lap the fitted circle, but on a mangled cap the sampled midpoint can
 * land on the wrong side of a tiny from→to span, and arcSlice would honour it as a
 * near-full-circle sweep. When the hinted sweep exceeds π, the hint is replaced by
 * the minor arc's midpoint (the chord midpoint projected radially onto the circle).
 * Antipodal from/to never reaches the projection: both sweeps are π.
 */
function junctionLocalMid(c: Circle, from: Vec, to: Vec, mid: Vec): Vec {
  const TWO_PI = Math.PI * 2
  const norm = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI
  const af = Math.atan2(from.y - c.cy, from.x - c.cx)
  const ccwSpan = norm(Math.atan2(to.y - c.cy, to.x - c.cx) - af) || TWO_PI
  const ccw = norm(Math.atan2(mid.y - c.cy, mid.x - c.cx) - af) <= ccwSpan
  const sweep = ccw ? ccwSpan : TWO_PI - ccwSpan
  if (sweep <= Math.PI) return mid
  const mx = (from.x + to.x) / 2 - c.cx
  const my = (from.y + to.y) / 2 - c.cy
  const d = Math.hypot(mx, my)
  if (d < 1e-9) return mid
  return { x: c.cx + (c.r * mx) / d, y: c.cy + (c.r * my) / d }
}

/** Midpoint of the terminal segment (sweep-side hint for arcSlice). */
function terminalMid(e: SharedEdge, atEnd: boolean): Vec {
  const nodes = e.nodes
  const m = nodes.length
  const p = atEnd ? nodes[m - 1] : nodes[0]
  const q = atEnd ? nodes[m - 2] : nodes[1]
  const h1 = atEnd ? p.hIn : p.hOut
  const h2 = atEnd ? q.hOut : q.hIn
  const pts: Vec[] = []
  sampleCubic(p, h1, h2, q, 2, pts)
  return pts[1]
}

/**
 * Re-anchor one edge end on the corrected vertex position `H`.
 *  • pair member, line arm: the terminal anchor moves along its own line; a
 *    mangled cap (skipCap) is removed — its breakpoint node is dropped and the
 *    straight run extends to `H`.
 *  • pair member, circle arm: the terminal segment re-emits as an arc slice of
 *    the fitted circle into `H`, so the boundary keeps the circle's tangent.
 *  • third edge (no primitive used): the anchor moves to `H`; a curved terminal
 *    segment is re-mapped onto it curvature-preserving (reshapeTerminalTo), a
 *    straight one takes the plain shift.
 */
function applyEnd(end: End, H: Vec, prim: Prim | null): void {
  const { e, atEnd } = end
  let nodes = e.nodes
  let m = nodes.length
  if (m < 2) return
  if (!prim) {
    // Not in the winning pair: the anchor moves; a curved terminal segment is
    // re-mapped curvature-preserving, a straight one takes the plain shift.
    const T = atEnd ? nodes[m - 1] : nodes[0]
    if (!reshapeTerminalTo(T, atEnd ? nodes[m - 2] : nodes[1], atEnd, H)) shiftNodeTo(T, H.x, H.y)
    return
  }
  if (prim.kind === 'line') {
    if (prim.skipCap && m >= 3) {
      // Drop the cap breakpoint; the straight run extends to H.
      nodes.splice(atEnd ? m - 2 : 1, 1)
      m = nodes.length
    }
    const T = atEnd ? nodes[m - 1] : nodes[0]
    const inner = atEnd ? nodes[m - 2] : nodes[1]
    T.x = H.x
    T.y = H.y
    T.kind = 'corner'
    // The terminal segment is part of the line; keep it exactly straight.
    if (atEnd) {
      T.hIn = null
      inner.hOut = null
    } else {
      T.hOut = null
      inner.hIn = null
    }
    return
  }
  // Circle arm: re-emit the terminal segment as an arc slice into H.
  const c = prim.c!
  const mid = terminalMid(e, atEnd)
  const T = atEnd ? nodes[m - 1] : nodes[0]
  const inner = atEnd ? nodes[m - 2] : nodes[1]
  const from = atEnd ? { x: inner.x, y: inner.y } : { x: H.x, y: H.y }
  const to = atEnd ? { x: H.x, y: H.y } : { x: inner.x, y: inner.y }
  const arc = arcSlice(c.cx, c.cy, c.r, from, to, junctionLocalMid(c, from, to, mid))
  if (arc.length < 2) {
    shiftNodeTo(T, H.x, H.y)
    return
  }
  T.x = H.x
  T.y = H.y
  T.kind = 'corner'
  const interior = arc.slice(1, arc.length - 1)
  if (atEnd) {
    inner.hOut = arc[0].hOut
    T.hIn = arc[arc.length - 1].hIn
    if (interior.length) nodes.splice(m - 1, 0, ...interior)
  } else {
    T.hOut = arc[0].hOut
    inner.hIn = arc[arc.length - 1].hIn
    if (interior.length) nodes.splice(1, 0, ...interior)
  }
}

/**
 * Re-seat slid degree-3 junctions onto the intersection of their two strongest
 * incident fitted primitives. Mutates `edges` / `vertices` in place. `width` /
 * `height` (raster px) guard the canvas border: a border junction must stay on
 * the frame. Deterministic: vertices ascending, pairs ranked by summed arm
 * length.
 *
 * Returns:
 *  • `chords` — ids of edges straightened as occluder chords: an edge whose two
 *    endpoints were both re-seated against the same line primitive is that line
 *    continuing through the crossing (e.g. a straight edge occluding a disc). Its
 *    fit crossed the mangled zone, so it is re-emitted as the straight chord. The
 *    caller must keep the co-circular snap off any loop containing one: a disc cut
 *    by a chord is a "D", and absorbing the chord into the circle would be wrong.
 *  • `moved` — ids of the re-seated vertices, the evidence key for
 *    weldConvergedJunctions (which needs the region loops, so runs in the caller).
 */
export function reseatJunctions(
  edges: SharedEdge[],
  vertices: Vertex[],
  width?: number,
  height?: number,
  onChord?: ChordObserver,
  onVerdict?: ReseatObserver,
  tune?: ReseatTune,
): { chords: Set<number>; moved: Set<number> } {
  const cfg: Cfg = {
    armMax: tune?.armMax ?? ARM_MAX,
    lineTol: tune?.lineTol ?? LINE_TOL,
    circTol: tune?.circTol ?? CIRC_TOL,
    minArcArm: tune?.minArcArm ?? MIN_ARC_ARM,
    capMax: tune?.capMax ?? CAP_MAX,
    throughVeto: tune?.throughVeto ?? THROUGH_VETO_DEG,
  }
  const incident = new Map<number, End[]>()
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2) continue
    if (e.startVertex != null && e.startVertex >= 0) {
      let a = incident.get(e.startVertex)
      if (!a) incident.set(e.startVertex, (a = []))
      a.push({ e, atEnd: false })
    }
    if (e.endVertex != null && e.endVertex >= 0) {
      let a = incident.get(e.endVertex)
      if (!a) incident.set(e.endVertex, (a = []))
      a.push({ e, atEnd: true })
    }
  }

  // Line primitives each re-seated vertex was corrected against (chord detection).
  const lineAt = new Map<number, Prim[]>()
  const moved = new Set<number>()

  for (const v of vertices) {
    const ends = incident.get(v.id)
    if (!ends || ends.length !== 3) continue
    const at = { x: v.x, y: v.y }
    if (width != null && height != null && (v.x <= 1 || v.y <= 1 || v.x >= width - 1 || v.y >= height - 1)) {
      onVerdict?.({
        vertex: v.id,
        ...at,
        arms: [],
        pair: null,
        vetoed: null,
        tx: NaN,
        ty: NaN,
        move: 0,
        reason: 'border',
      })
      continue
    }

    // Fresh primitives per vertex (an earlier re-seat may have touched an edge).
    const armV = ends.map((end) => endPrimitive(end.e, end.atEnd, cfg, onVerdict != null))
    const prims = armV.map((a) => a.prim)
    const verdict = (
      pair: [number, number] | null,
      H: Vec | null,
      move: number,
      reason: ReseatVerdict['reason'],
    ): void =>
      onVerdict?.({
        vertex: v.id,
        ...at,
        arms: armV.map((a) => ({
          kind: a.prim?.kind ?? null,
          conf: a.prim?.conf ?? a.len,
          r: a.prim?.c?.r ?? NaN,
          skipCap: a.prim?.skipCap ?? false,
          why: a.why,
          segLen0: a.segLen0,
          alt: a.alt,
        })),
        pair,
        vetoed,
        tx: H?.x ?? NaN,
        ty: H?.y ?? NaN,
        move,
        reason,
      })

    // Through-boundary: the smallest-turn arm pair, vetoed as a re-seat pair when the
    // third arm meets both its halves transversally (see THROUGH_VETO_DEG).
    const dirs = armV.map((a) => a.dir)
    const turn = (i: number, j: number): number => {
      const a = dirs[i]
      const b = dirs[j]
      if (!a || !b) return Infinity
      return 180 - (Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180) / Math.PI
    }
    let vetoed: [number, number] | null = null
    if (cfg.throughVeto > 0) {
      let minTurn = Infinity
      for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
          const t = turn(i, j)
          if (t < minTurn) {
            minTurn = t
            vetoed = [i, j]
          }
        }
      if (vetoed) {
        const k = 3 - vetoed[0] - vetoed[1]
        if (Math.min(turn(vetoed[0], k), turn(vetoed[1], k)) < cfg.throughVeto) vetoed = null
      }
    }

    // Best qualifying pair by summed arm confidence.
    let best: { i: number; j: number; H: Vec; conf: number } | null = null
    for (let i = 0; i < 3; i++) {
      const pi = prims[i]
      if (!pi) continue
      if (primDist(v, pi) > NEAR_TOL) continue
      for (let j = i + 1; j < 3; j++) {
        const pj = prims[j]
        if (!pj) continue
        if (primDist(v, pj) > NEAR_TOL) continue
        if (vetoed && vetoed[0] === i && vetoed[1] === j) continue
        let H: Vec | null = null
        let hd = Infinity
        for (const cand of intersect(pi, pj)) {
          const d = dist(cand, v)
          if (d < hd) {
            hd = d
            H = cand
          }
        }
        if (!H || hd > MAX_SLIDE) continue
        // A circle arm must not slide the junction a large fraction of its own
        // radius (a near-full tiny circle offers no stable direction).
        if (pi.kind === 'circle' && hd > 0.5 * pi.c!.r) continue
        if (pj.kind === 'circle' && hd > 0.5 * pj.c!.r) continue
        // Transversality at the target.
        const t1 = primTangent(H, pi)
        const t2 = primTangent(H, pj)
        if (Math.abs(t1.x * t2.y - t1.y * t2.x) < MIN_ANGLE_SIN) continue
        const conf = pi.conf + pj.conf
        if (!best || conf > best.conf) best = { i, j, H, conf }
      }
    }
    if (!best) {
      verdict(null, null, 0, 'no pair')
      continue
    }
    const hd = dist(best.H, v)
    if (hd < MIN_MOVE) {
      verdict([best.i, best.j], best.H, hd, 'below MIN_MOVE')
      continue
    }
    verdict([best.i, best.j], best.H, hd, 'moved')

    v.x = best.H.x
    v.y = best.H.y
    moved.add(v.id)
    for (let k = 0; k < 3; k++) {
      applyEnd(ends[k], best.H, k === best.i || k === best.j ? prims[k] : null)
    }
    lineAt.set(
      v.id,
      [best.i, best.j].map((k) => prims[k]!).filter((p) => p.kind === 'line'),
    )
  }

  // --- occluder-chord straightening ----------------------------------------
  // An edge whose two endpoints were both re-seated against one and the same
  // line is that line's continuation through the crossing: re-emit it as the
  // straight chord between the corrected vertices.
  const straightened = new Set<number>()
  for (const e of edges) {
    if (e.closed || e.nodes.length < 2) continue
    if (e.startVertex == null || e.endVertex == null) continue
    const l1s = lineAt.get(e.startVertex)
    const l2s = lineAt.get(e.endVertex)
    if (!l1s?.length || !l2s?.length) continue
    const a = e.nodes[0]
    const b = e.nodes[e.nodes.length - 1]
    const len = dist(a, b)
    const armOf = (ls: Prim[]): number => ls.reduce((m, l) => Math.max(m, l.conf), 0)
    const armA = armOf(l1s)
    const armB = armOf(l2s)
    const tooLong = len > CHORD_ARM_K * (armA + armB)
    // Without an observer, stop here. With one, the remaining gates are still evaluated
    // for the record, but the mutation below is behind the same condition.
    if (tooLong && !onChord) continue
    const sameLine = l1s.some((l1) =>
      l2s.some(
        (l2) =>
          Math.abs(l1.d!.x * l2.d!.y - l1.d!.y * l2.d!.x) <= CHORD_COLLINEAR_SIN &&
          primDist(l2.a!, l1) <= CHORD_COLLINEAR_OFF,
      ),
    )
    if (!sameLine) {
      onChord?.({
        edgeId: e.id,
        len,
        maxDev: NaN,
        sameLine: false,
        verdict: tooLong ? 'too-long' : 'not-collinear',
        armA,
        armB,
        profile: [],
      })
      continue
    }
    // The edge's own fit must sit near the chord, so a genuinely different boundary
    // between the two junctions survives.
    const line = l1s[0]
    let maxDev = 0
    // Observer only: each sample's deviation against its arc position along the edge.
    const raw: { cum: number; dev: number }[] | null = onChord ? [] : null
    let cum = 0
    for (let s = 0; s + 1 < e.nodes.length; s++) {
      const p = e.nodes[s]
      const q = e.nodes[s + 1]
      const pts: Vec[] = []
      sampleCubic(p, p.hOut, q.hIn, q, ARM_SAMPLES, pts)
      const d = lineMaxDev(pts, line.a!, line.d!)
      if (d > maxDev) maxDev = d
      if (raw) {
        for (let k = 0; k < pts.length; k++) {
          if (k > 0) cum += dist(pts[k - 1], pts[k])
          raw.push({ cum, dev: Math.abs((pts[k].x - line.a!.x) * line.d!.y - (pts[k].y - line.a!.y) * line.d!.x) })
        }
      }
    }
    const verdict = tooLong ? 'too-long' : maxDev > CHORD_TOL ? 'dev-exceeded' : 'straightened'
    onChord?.({
      edgeId: e.id,
      len,
      maxDev,
      sameLine: true,
      verdict,
      armA,
      armB,
      profile: raw ? raw.map((r) => ({ s: Math.min(r.cum, cum - r.cum), dev: r.dev })) : [],
    })
    if (verdict !== 'straightened') continue
    e.nodes = [
      { x: a.x, y: a.y, hIn: null, hOut: null, kind: 'corner' },
      { x: b.x, y: b.y, hIn: null, hOut: null, kind: 'corner' },
    ]
    straightened.add(e.id)
  }
  return { chords: straightened, moved }
}

/**
 * Fuse junction pairs the re-seat converged into one vertex. A rasterized degree-4
 * crossing splits into two degree-3 junctions joined by a micro-edge; once the
 * re-seat has driven them onto the true crossing, the micro-edge is pure
 * rasterization and is contracted (`weldJunctionClusters` does the graph work).
 * Gated on re-seat evidence rather than shortness alone: only micro-edges
 * (≤ RESEAT_WELD_LEN fitted px) with a re-seated endpoint qualify, because an
 * untouched micro-edge can be a real thin feature. Mutates topology and loops in place.
 */
export function weldConvergedJunctions(
  vertices: Vertex[],
  edges: SharedEdge[],
  loopsByLabel: Map<number, EdgeRef[][]>,
  width: number,
  height: number,
  moved: ReadonlySet<number>,
): void {
  if (moved.size === 0) return
  weldJunctionClusters(
    vertices,
    edges,
    loopsByLabel,
    width,
    height,
    RESEAT_WELD_LEN,
    (e) => (e.startVertex != null && moved.has(e.startVertex)) || (e.endVertex != null && moved.has(e.endVertex)),
  )
}

/** Max fitted length (px) of a micro-edge the converged-pair weld may contract. Covers
 *  a one-sided pair (one endpoint moved onto the crossing, the other already within
 *  MIN_MOVE of it) while staying below real thin features. */
const RESEAT_WELD_LEN = 2.0
