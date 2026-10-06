// Rounded polygons: a closed loop made of straight runs joined by tangent arcs.
//
// A rounded rectangle is four lines and four arcs, each arc tangent to the two lines it
// joins. The general loop fit cannot say that. Its line candidates are C⁰ at both ends, so
// every line→arc join is a hard node with whatever tangent break the two free fits left
// (3–24° at the flat cap on corner-free art), and the arc is whatever cubic stays within ε
// between two key vertices that RDP placed a few px inside the real arc. Below r ≈ 7px the
// corner detector fires instead and the arc becomes one sharp node on the arm intersection.
//
// Here the loop is read as primitives first. Straight runs are certified on the dense
// chain; between two consecutive runs the only circle that can join them G¹ is tangent to
// both lines, which leaves ONE free parameter (the radius; for parallel lines, the
// position along them), so the fit is a 1-D least squares against the chain's own points
// rather than a free circle fit over a short arc. A loop is taken only when every gap
// between its runs is such an arc or a sharp line–line corner, and at least one is an arc:
// anything else returns null and goes to the general fitters untouched.
//
// Pure and deterministic. Design notes and measurements: docs/vectorization-benchmarks.md §42.

import type { PathNode, Vec } from '../../path/types'
import { keyVertexIndices } from '../curveFit.ts'

/** Polygonalisation tolerance (px) for the run seeds: RDP at this ε leaves a straight side
 *  as one long chord and an arc as chords whose sagitta is at most this. */
const POLY_EPS = 0.3
/** A certified run keeps every point within this (px) of its own least-squares line. */
const RUN_TOL = 0.2
/** Shortest certified run (px). */
const RUN_MIN_LEN = 4
/**
 * A run next to an arc of radius r is WEAK when it would not visibly leave that arc's
 * circle: sagitta L²/8r under this (px). It has to sit above the bow a certified run can
 * hide — every point within `RUN_TOL` of one line allows a sagitta of 2·`RUN_TOL` — or a
 * chord of the arc's own circle passes as a side: at 0.5 the four flat extremes of an
 * r = 40 disc certified (12.5px of chord or more each) and the disc came back as a rounded
 * square.
 */
const RUN_SAG_MIN = 0.75
/** …and on a chain that was never measured, above what the lattice hides: a row of
 *  cracks stands for a boundary anywhere within its pixel, so the top of a disc is a
 *  dead-straight run until the circle has dropped a whole row. */
const RUN_SAG_MIN_LATTICE = 1.5
/** Two consecutive runs turning less than this are one line or nothing (deg). */
const MERGE_TURN_DEG = 6
/** …and they merge when one line holds every point of both, and between, within this. */
const MERGE_TOL = 0.3
/**
 * Smallest radius (px) emitted as an arc. Under it a rounded corner and a sharp one are
 * not reliably different in the raster: the radius this fit READS at a real corner is not
 * zero — 404 sharp corners on the fixtures give p50 0.43, p99 2.2 and a maximum of 2.8,
 * and on art enlarged ×3 bilinear the largest is 2.2 of the enlarged pixels.
 */
const FILLET_MIN_R = 3.5
/**
 * …and the arc must stand at least this far (px) off the corner it rounds, r·(sec(θ/2) − 1).
 * The radius alone says little at a shallow turn: at 45° an r = 4 arc leaves its corner by
 * a third of a pixel, which is what anti-aliasing does to a sharp one — a sharp 45° vertex
 * on a gallery mark read exactly r = 4.0.
 */
const FILLET_MIN_CUT = 1.0
/** Smallest turn (deg) an arc may make; a gentler bend between two lines is not a fillet. */
const FILLET_MIN_TURN_DEG = 15
/** Two corners of one loop are the SAME KIND of corner when they turn within this (deg)
 *  of each other and the smaller reads at least this share of the larger's radius. */
const ALIKE_TURN_DEG = 10
const ALIKE_RADIUS = 0.7
/** Every measured chain point of a gap must sit within this (px) of the line–arc–line it
 *  is replaced by. */
const ARC_TOL = 0.35
/**
 * …and every point the sub-pixel pass could not measure within this. Such a point is still
 * on the crack lattice, up to ~0.7px from the boundary it stands for, so it can only veto a
 * reading that is grossly wrong; it also counts for less in every fit (`LATTICE_WEIGHT`).
 */
const LATTICE_TOL = 0.75
const LATTICE_WEIGHT = 0.2
/**
 * Outliers. One estimate in a few hundred lands 0.4px off for no reason the fit can use,
 * and a verdict that turns on the single worst point threw out a triangle whose three
 * radii read 48.01 / 48.03 / 48.04 against an authored 48 because one point sat 0.01 over.
 * So up to this share of the points a test reads may exceed their tolerance — none by more
 * than `OUTLIER_SLACK`. A wrong reading is not a few stray points: a squircle read as four
 * arcs misses by 1.2px along a whole corner.
 */
const OUTLIER_SHARE = 0.05
const OUTLIER_SLACK = 0.4
/** A run must be mostly measured points to be certified at their tolerance; below this
 *  share every point has to hold `RUN_TOL`, which on the lattice only an axis-aligned
 *  side does. */
const RUN_MEASURED_MIN = 0.6
/** Two tangent points on one run may overlap by this (px) and are then one node. */
const OVERLAP_TOL = 0.5
/**
 * Widest sweep (rad) one cubic carries. The quarter turn is the convention, but a measured
 * right angle reads 90.02° as often as 89.98°, and splitting on that puts a ninth node on
 * half the rounded rectangles in a drawing. At 100° the kappa cubic is still within
 * 0.0006·r of its circle.
 */
const PIECE_MAX = (100 * Math.PI) / 180

interface Line {
  cx: number
  cy: number
  dx: number
  dy: number
}

interface Run extends Line {
  /** First / last certified chain index (forward, cyclic, inclusive) and their count. */
  a: number
  b: number
  count: number
  /** Positions of those two points along the line, relative to (cx, cy). */
  s0: number
  s1: number
}

/** What one gap between two runs was read as. */
export interface FilletGap {
  kind: 'fillet' | 'corner' | 'unexplained'
  /** Turn between the two runs (deg). */
  turn: number
  /** Best-fit tangent radius (px); the fixed half-separation for parallel runs. */
  r: number
  /** Worst excess (px) of a chain point over its own tolerance, against the line–arc–line
   *  at that radius. ≤ 0 means every point holds. */
  res: number
  /** Arc centre (fillet) or line intersection (corner). */
  x: number
  y: number
  /** Tangent points on the two runs, in chain order. */
  t1: Vec
  t2: Vec
}

export interface FilletDiagRecord {
  /** Chain points and certified runs. */
  n: number
  runs: number
  verdict: 'emitted' | 'no-runs' | 'gap-unexplained' | 'no-fillet' | 'winding' | 'overlap'
  gaps: FilletGap[]
  /** Per run, in the order of `gaps` (run i precedes gap i): its certified length and
   *  what the tangent points on its two sides leave of it (px). */
  sides?: { len: number; straight: number }[]
}
export type FilletDiag = (r: FilletDiagRecord) => void

/** What the fits read: the chain, and which of its points the sub-pixel pass measured
 *  (null ⇒ none were — a lattice chain). */
interface Chain {
  pts: Vec[]
  measured: Uint8Array | null
}
/** A point still on the lattice inside a chain that was otherwise measured. */
const isStray = (ch: Chain, i: number): boolean => ch.measured !== null && ch.measured[i] !== 1
const weightOf = (ch: Chain, i: number): number => (isStray(ch, i) ? LATTICE_WEIGHT : 1)

const fwd = (from: number, to: number, n: number): number => (((to - from) % n) + n) % n
const dev = (L: Line, p: Vec): number => -(p.x - L.cx) * L.dy + (p.y - L.cy) * L.dx
const along = (L: Line, p: Vec): number => (p.x - L.cx) * L.dx + (p.y - L.cy) * L.dy

/** Weighted total-least-squares line through `count` chain points from `start`, directed
 *  along the chain. */
function tlsLine(ch: Chain, start: number, count: number): Line | null {
  const pts = ch.pts
  const n = pts.length
  if (count < 2) return null
  let mx = 0
  let my = 0
  let sw = 0
  for (let k = 0; k < count; k++) {
    const i = (start + k) % n
    const w = weightOf(ch, i)
    mx += pts[i].x * w
    my += pts[i].y * w
    sw += w
  }
  mx /= sw
  my /= sw
  let sxx = 0
  let syy = 0
  let sxy = 0
  for (let k = 0; k < count; k++) {
    const i = (start + k) % n
    const w = weightOf(ch, i)
    const dx = pts[i].x - mx
    const dy = pts[i].y - my
    sxx += w * dx * dx
    syy += w * dy * dy
    sxy += w * dx * dy
  }
  if (sxx + syy < 1e-12) return null
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  let dx = Math.cos(th)
  let dy = Math.sin(th)
  const p0 = pts[start % n]
  const p1 = pts[(start + count - 1) % n]
  if ((p1.x - p0.x) * dx + (p1.y - p0.y) * dy < 0) {
    dx = -dx
    dy = -dy
  }
  return { cx: mx, cy: my, dx, dy }
}

/**
 * Certify the chain between two RDP key vertices as a straight run: fit its middle, then
 * keep the stretch around the middle whose every point holds its tolerance. What falls
 * off the ends has already left the line — it belongs to the arc that follows — and a key
 * vertex is exactly where that happens, so the ends are walked outward from the middle
 * rather than trimmed inward from a first point that may itself still sit on the line.
 */
function certifyRun(ch: Chain, a: number, b: number): Run | null {
  const pts = ch.pts
  const n = pts.length
  let start = a
  let count = fwd(a, b, n) + 1
  let line: Line | null = null
  const off = (L: Line, i: number, strict: boolean): boolean =>
    Math.abs(dev(L, pts[i])) > (!strict && isStray(ch, i) ? LATTICE_TOL : RUN_TOL)
  for (let pass = 0; pass < 3; pass++) {
    if (count < 3) return null
    const trim = pass === 0 ? Math.min(count >> 2, 8) : count > 6 ? 1 : 0
    line = tlsLine(ch, start + trim, count - 2 * trim)
    if (!line) return null
    const mid = count >> 1
    if (off(line, (start + mid) % n, false)) return null
    let lo = mid
    let hi = mid
    // An isolated outlier (see OUTLIER_SHARE) is stepped over; two in a row end the run.
    let spare = Math.floor(count * OUTLIER_SHARE)
    const L = line
    const slack = (i: number): boolean => Math.abs(dev(L, pts[i])) <= RUN_TOL + OUTLIER_SLACK
    while (lo > 0) {
      if (!off(L, (start + lo - 1) % n, false)) lo--
      else if (spare > 0 && lo > 1 && slack((start + lo - 1) % n) && !off(L, (start + lo - 2) % n, false)) {
        lo -= 2
        spare--
      } else break
    }
    while (hi < count - 1) {
      if (!off(L, (start + hi + 1) % n, false)) hi++
      else if (spare > 0 && hi < count - 2 && slack((start + hi + 1) % n) && !off(L, (start + hi + 2) % n, false)) {
        hi += 2
        spare--
      } else break
    }
    // A run may contain strays but does not END on them: their tolerance is wide enough
    // to carry a "line" well round a gentle arc.
    while (lo < mid && isStray(ch, (start + lo) % n)) lo++
    while (hi > mid && isStray(ch, (start + hi) % n)) hi--
    if (lo === 0 && hi === count - 1 && pass > 0) break
    start = (start + lo) % n
    count = hi - lo + 1
  }
  if (!line || count < 3) return null
  if (ch.measured !== null) {
    let got = 0
    for (let k = 0; k < count; k++) if (ch.measured[(start + k) % n] === 1) got++
    if (got < count * RUN_MEASURED_MIN)
      for (let k = 0; k < count; k++) if (off(line, (start + k) % n, true)) return null
  }
  const end = (start + count - 1) % n
  const s0 = along(line, pts[start])
  const s1 = along(line, pts[end])
  if (s1 - s0 < RUN_MIN_LEN) return null
  return { ...line, a: start, b: end, count, s0, s1 }
}

interface GapFit extends FilletGap {
  /** Which way the chain turns here: the sign of the centre's offset along run A's left
   *  normal. */
  side: number
  /** The corner the arc rounds — the two lines' intersection ahead of run A — or null
   *  where there is none (a U-turn, the long way round). */
  apex: Vec | null
  /** How far each tangent point sits inside its run, from the run's end on this gap's
   *  side (negative: past the end, in the gap). */
  cutA: number
  cutB: number
}

/**
 * Read the gap between two consecutive runs. The circle that joins them G¹ is tangent to
 * both lines, so with the first tangent point at `u` px past run A's certified end the
 * radius is linear in `u`: r(u) = s·n₂·(T₁ − c_B) / (1 − cos θ). That holds for a U-turn
 * (θ = 180°: r is the half-separation and `u` slides the cap) and for an arc that goes the
 * long way round (a map pin's head), which a parametrisation by the line intersection
 * does not.
 *
 * Which way round is read off the chain itself, and a point's place — on run A, on the
 * arc, on run B — by its ORDER in the chain against the two tangent points. A half-plane
 * test cannot do that past 180°, where the arc comes back behind its own start.
 */
function solveGap(ch: Chain, A: Run, B: Run): GapFit | null {
  const pts = ch.pts
  const n = pts.length
  const cosT = A.dx * B.dx + A.dy * B.dy
  if (1 - cosT < 1e-4) return null

  // Zone: the gap and enough of each run to hold a tangent point that sits inside it.
  const between = fwd(A.b, B.a, n)
  const depth = Math.max(12, between + 8)
  const depthA = Math.min((A.count - 1) >> 1, depth)
  const depthB = Math.min((B.count - 1) >> 1, depth)
  const zoneStart = (A.b - depthA + n) % n
  const zoneCount = depthA + between + depthB + 1
  const ex = A.cx + A.s1 * A.dx
  const ey = A.cy + A.s1 * A.dy
  const fx = B.cx + B.s0 * B.dx
  const fy = B.cy + B.s0 * B.dy
  const zx = new Float64Array(zoneCount)
  const zy = new Float64Array(zoneCount)
  const zw = new Float64Array(zoneCount)
  const ztol = new Float64Array(zoneCount)
  /** Position of each zone point along run A past its end, and along run B past its start. */
  const ua = new Float64Array(zoneCount)
  const vb = new Float64Array(zoneCount)
  let uMax = 0
  for (let o = 0; o < zoneCount; o++) {
    const i = (zoneStart + o) % n
    zx[o] = pts[i].x
    zy[o] = pts[i].y
    zw[o] = weightOf(ch, i)
    // A lattice chain's arc points are all strays by nature: the staircase of a curve.
    ztol[o] = ch.measured === null || ch.measured[i] !== 1 ? LATTICE_TOL : ARC_TOL
    ua[o] = (zx[o] - ex) * A.dx + (zy[o] - ey) * A.dy
    vb[o] = (zx[o] - fx) * B.dx + (zy[o] - fy) * B.dy
    if (ua[o] > uMax) uMax = ua[o]
  }

  // The chain's own turning from run A to run B, summed over ≥ 2px chords so that no
  // single step can wrap: the principal angle between the two directions, or that ± 360°.
  const principal = Math.atan2(A.dx * B.dy - A.dy * B.dx, cosT)
  let total = 0
  {
    let px = zx[0]
    let py = zy[0]
    let dirx = A.dx
    let diry = A.dy
    for (let o = 1; o <= zoneCount; o++) {
      const last = o === zoneCount
      const qx = last ? px + B.dx * 4 : zx[o]
      const qy = last ? py + B.dy * 4 : zy[o]
      const cxd = qx - px
      const cyd = qy - py
      const len = Math.hypot(cxd, cyd)
      if (len < 2 && !last) continue
      total += Math.atan2(dirx * cyd - diry * cxd, dirx * cxd + diry * cyd)
      dirx = cxd / len
      diry = cyd / len
      px = qx
      py = qy
    }
  }
  let signed = principal
  if (total - signed > Math.PI) signed += 2 * Math.PI
  else if (signed - total > Math.PI) signed -= 2 * Math.PI
  const side = signed >= 0 ? 1 : -1
  const sweep = Math.abs(signed)
  const turn = (sweep * 180) / Math.PI

  const n1x = -A.dy
  const n1y = A.dx
  const n2x = -B.dy
  const n2y = B.dx
  const r0 = (side * (n2x * (ex - B.cx) + n2y * (ey - B.cy))) / (1 - cosT)
  const k = (side * (n2x * A.dx + n2y * A.dy)) / (1 - cosT)
  // r ≥ 0 bounds u on the side the lines meet: ahead (k < 0) for the short way round,
  // behind (k > 0) for the long way.
  const uApex = Math.abs(k) > 1e-9 ? -r0 / k : NaN
  let uLo = ua[0]
  let uHi = uMax
  if (k < -1e-9) uHi = Math.min(uHi, uApex)
  else if (k > 1e-9) uLo = Math.max(uLo, uApex)
  else if (r0 <= 0) return null
  if (!(uHi > uLo)) return null

  /** Sum of squared distances (weighted) at `u`; leaves how many points exceed their
   *  tolerance, and the worst excess, in `over` / `worst`. */
  let worst = 0
  let over = 0
  const cost = (u: number): number => {
    const r = r0 + u * k
    const t1x = ex + u * A.dx
    const t1y = ey + u * A.dy
    const cx = t1x + side * r * n1x
    const cy = t1y + side * r * n1y
    const v2 = (cx - side * r * n2x - fx) * B.dx + (cy - side * r * n2y - fy) * B.dy
    // First point past T₁ walking forward; last point before T₂ walking back.
    let arcStart = 0
    while (arcStart < zoneCount && ua[arcStart] <= u) arcStart++
    let arcEnd = zoneCount - 1
    while (arcEnd >= 0 && vb[arcEnd] >= v2) arcEnd--
    let sum = 0
    worst = -Infinity
    over = 0
    for (let o = 0; o < zoneCount; o++) {
      const px = zx[o]
      const py = zy[o]
      const d =
        o < arcStart
          ? Math.abs(-(px - A.cx) * A.dy + (py - A.cy) * A.dx)
          : o > arcEnd
            ? Math.abs(-(px - B.cx) * B.dy + (py - B.cy) * B.dx)
            : Math.abs(Math.hypot(px - cx, py - cy) - r)
      sum += zw[o] * d * d
      if (d > ztol[o]) over++
      if (d - ztol[o] > worst) worst = d - ztol[o]
    }
    return sum
  }
  // Coarse scan, then golden section around the best sample.
  const steps = Math.max(8, Math.min(96, Math.ceil((uHi - uLo) / 0.2)))
  const du = (uHi - uLo) / steps
  let best = uLo
  let bestCost = Infinity
  for (let i = 0; i <= steps; i++) {
    const u = uLo + i * du
    const c = cost(u)
    if (c < bestCost) {
      bestCost = c
      best = u
    }
  }
  let lo = Math.max(uLo, best - du)
  let hi = Math.min(uHi, best + du)
  const G = (Math.sqrt(5) - 1) / 2
  let x1 = hi - G * (hi - lo)
  let x2 = lo + G * (hi - lo)
  let f1 = cost(x1)
  let f2 = cost(x2)
  for (let it = 0; it < 24 && hi - lo > 1e-3; it++) {
    if (f1 < f2) {
      hi = x2
      x2 = x1
      f2 = f1
      x1 = hi - G * (hi - lo)
      f1 = cost(x1)
    } else {
      lo = x1
      x1 = x2
      f1 = f2
      x2 = lo + G * (hi - lo)
      f2 = cost(x2)
    }
  }
  const u = (lo + hi) / 2
  cost(u)
  // Holds (≤ 0) when no more than OUTLIER_SHARE of the zone is over tolerance and nothing
  // is over by more than OUTLIER_SLACK.
  const res = worst <= OUTLIER_SLACK && over <= Math.floor(zoneCount * OUTLIER_SHARE) ? Math.min(worst, 0) : worst
  const r = r0 + u * k
  const t1 = { x: ex + u * A.dx, y: ey + u * A.dy }
  const c = { x: t1.x + side * r * n1x, y: t1.y + side * r * n1y }
  const t2 = { x: c.x - side * r * n2x, y: c.y - side * r * n2y }
  const cutB = (t2.x - fx) * B.dx + (t2.y - fy) * B.dy
  // The short way round has a corner ahead of run A that the arc stands off from; a
  // U-turn and the long way round have none.
  const cornered = k < -1e-9 && sweep < Math.PI - 1e-3
  const apex = cornered ? { x: ex + uApex * A.dx, y: ey + uApex * A.dy } : null
  const base = { turn, r, res, t1, t2, side, apex, cutA: -u, cutB }
  if (res > 0) return { ...base, kind: 'unexplained', x: c.x, y: c.y }
  const cut = cornered ? r * (1 / Math.cos(sweep / 2) - 1) : Infinity
  if (r >= FILLET_MIN_R && cut >= FILLET_MIN_CUT) {
    return { ...base, kind: turn >= FILLET_MIN_TURN_DEG ? 'fillet' : 'unexplained', x: c.x, y: c.y }
  }
  // Under those two floors the arc is the raster's own rounding of a corner: the node
  // goes on the line intersection. A cap that thin has none, and is not read here.
  if (!apex) return { ...base, kind: 'unexplained', x: c.x, y: c.y }
  return { ...base, kind: 'corner', x: apex.x, y: apex.y }
}

/** The arc of one fillet as nodes: the two tangent points and, past `PIECE_MAX`, evenly
 *  spaced nodes between, each a kappa piece. All smooth; the tangent points carry one
 *  handle. */
function arcNodes(g: GapFit, d1: Vec, d2: Vec): PathNode[] {
  const cx = g.x
  const cy = g.y
  const r = g.r
  const a1 = Math.atan2(g.t1.y - cy, g.t1.x - cx)
  const sweep = (g.turn * Math.PI) / 180
  // Rotation sense: the travel tangent at T₁ is run A's direction.
  const w = -Math.sin(a1) * d1.x + Math.cos(a1) * d1.y >= 0 ? 1 : -1
  const pieces = Math.max(1, Math.ceil(sweep / PIECE_MAX))
  const step = sweep / pieces
  const h = (4 / 3) * Math.tan(step / 4) * r
  const out: PathNode[] = []
  for (let i = 0; i <= pieces; i++) {
    const a = a1 + w * step * i
    const p = i === 0 ? g.t1 : i === pieces ? g.t2 : { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
    const t = i === 0 ? d1 : i === pieces ? d2 : { x: -Math.sin(a) * w, y: Math.cos(a) * w }
    out.push({
      x: p.x,
      y: p.y,
      hIn: i === 0 ? null : { x: p.x - t.x * h, y: p.y - t.y * h },
      hOut: i === pieces ? null : { x: p.x + t.x * h, y: p.y + t.y * h },
      kind: 'smooth',
    })
  }
  return out
}

/**
 * Fit a closed chain as a rounded polygon, or return null when it is not one. `pts` is the
 * sub-pixel chain WITHOUT the corner self-guard's lattice reverts (an arc under r ≈ 9px
 * trips that guard, and the staircase it leaves is the one stretch this fit needs to
 * read); `measured[i]` is 1 where the estimator placed point i. Absent ⇒ a lattice chain.
 */
export function fitFilletLoop(pts: Vec[], measured?: Uint8Array | null, diag?: FilletDiag): PathNode[] | null {
  const n = pts.length
  const ch: Chain = { pts, measured: measured ?? null }
  const say = (
    verdict: FilletDiagRecord['verdict'],
    runs: number,
    gaps: FilletGap[] = [],
    sides?: FilletDiagRecord['sides'],
  ): null => {
    diag?.({ n, runs, verdict, gaps, sides })
    return null
  }
  if (n < 12) return null
  // Seeds come from the MEASURED points alone. On a slanted side the estimator declines at
  // the inside corner of every stair step, one point in three or four, and each of those
  // strays is half a pixel off the line: polygonalised with them in, a 20° side is all
  // 3px chords and not one seed.
  let key: number[]
  if (ch.measured === null) key = keyVertexIndices(pts, POLY_EPS)
  else {
    const idx: number[] = []
    for (let i = 0; i < n; i++) if (ch.measured[i] === 1) idx.push(i)
    if (idx.length < 12) return null
    key = keyVertexIndices(
      idx.map((i) => pts[i]),
      POLY_EPS,
    ).map((q) => idx[q])
  }
  const m = key.length
  if (m < 2) return null
  let runs: Run[] = []
  for (let j = 0; j < m; j++) {
    const a = key[j]
    const b = key[(j + 1) % m]
    if (Math.hypot(pts[b].x - pts[a].x, pts[b].y - pts[a].y) < RUN_MIN_LEN) continue
    const run = certifyRun(ch, a, b)
    if (run) runs.push(run)
  }
  if (runs.length < 2) return say('no-runs', runs.length)

  // Consecutive runs that do not turn are one run (RDP split a long side, or one stray
  // point cut it). When no single line holds the two, the shorter is not a side: it is
  // the last chord of an arc coming into its tangent point (4px at 4.8° off a 178px side,
  // on an r = 32 corner), and it goes back to being gap.
  const mergeCos = Math.cos((MERGE_TURN_DEG * Math.PI) / 180)
  for (let i = 0; runs.length >= 2 && i < runs.length; ) {
    const A = runs[i]
    const j = (i + 1) % runs.length
    const B = runs[j]
    if (A.dx * B.dx + A.dy * B.dy < mergeCos) {
      i++
      continue
    }
    const count = fwd(A.a, B.b, n) + 1
    const line = tlsLine(ch, A.a, count)
    let holds = line !== null
    let spare = Math.floor(count * OUTLIER_SHARE)
    for (let q = 0; holds && q < count; q++) {
      const idx = (A.a + q) % n
      const d = Math.abs(dev(line!, pts[idx])) - (isStray(ch, idx) ? LATTICE_TOL : MERGE_TOL)
      if (d > OUTLIER_SLACK || (d > 0 && --spare < 0)) holds = false
    }
    if (holds) {
      const merged: Run = { ...line!, a: A.a, b: B.b, count, s0: along(line!, pts[A.a]), s1: along(line!, pts[B.b]) }
      if (j > i) runs.splice(i, 2, merged)
      else runs = [merged, ...runs.slice(1, runs.length - 1)] // the wrap pair
    } else {
      runs.splice(A.s1 - A.s0 <= B.s1 - B.s0 ? i : j, 1)
    }
    i = 0
  }
  if (runs.length < 2) return say('no-runs', runs.length)

  const cache = new Map<number, GapFit | null>()
  const gapOf = (A: Run, B: Run): GapFit | null => {
    const id = A.a * n + B.a
    let g = cache.get(id)
    if (g === undefined) cache.set(id, (g = solveGap(ch, A, B)))
    return g
  }

  // Weak runs. A run may be a chord of the arc beside it rather than a side — RDP
  // certifies a 5px chord in the middle of an r = 12 corner, and the flat extremes of a
  // disc. Two signs, either is enough: it would not visibly leave that arc's circle
  // (RUN_SAG_MIN), or the tangent points the arcs on its two sides ask for leave less
  // than a run's length of it (two arcs of one circle touch a chord at the same point).
  // Weak runs go back to being gap, all at once and again until none is left: what
  // remains must then be explained by the strong runs alone, and a disc is left with
  // none. A weak run is never KEPT. It cannot be told from a chord by its own points, and
  // every rule tried for keeping one turned on a few hundredths of a pixel — the same
  // test kept the 4px flat between a narrow rounded rect's two corners (right) and three
  // chords of a plain circle (a disc drawn as a rounded triangle).
  const sagMin = ch.measured === null ? RUN_SAG_MIN_LATTICE : RUN_SAG_MIN
  for (;;) {
    const R = runs.length
    const strong = runs.filter((run, i) => {
      const len = run.s1 - run.s0
      const before = gapOf(runs[(i - 1 + R) % R], run)
      const after = gapOf(run, runs[(i + 1) % R])
      let rAdj = 0
      let straight = len
      if (before && before.r >= FILLET_MIN_R) {
        rAdj = before.r
        straight -= before.cutB
      }
      if (after && after.r >= FILLET_MIN_R) {
        rAdj = Math.max(rAdj, after.r)
        straight -= after.cutA
      }
      return !(rAdj > 0 && ((len * len) / (8 * rAdj) < sagMin || straight < RUN_MIN_LEN))
    })
    if (strong.length === R) break
    if (strong.length < 2) return say('no-runs', strong.length)
    runs = strong
  }

  const R = runs.length
  const gaps: GapFit[] = []
  for (let i = 0; i < R; i++) {
    const g = gapOf(runs[i], runs[(i + 1) % R])
    if (!g) return say('gap-unexplained', R, gaps)
    gaps.push(g)
  }
  if (gaps.some((g) => g.kind === 'unexplained')) return say('gap-unexplained', R, gaps)

  // One loop, one answer per kind of corner. The two floors cut a continuous reading, so
  // six corners of one hexagon that read r = 5.8–6.5 came back as five sharp and one
  // round. Where a corner the floors left sharp reads nearly the radius of one they
  // rounded, at the same turn, both are sharp: the floors are what counts as evidence.
  for (const g of gaps) {
    if (g.kind !== 'fillet' || !g.apex) continue
    const twin = gaps.some(
      (h) => h.kind === 'corner' && h.apex && Math.abs(h.turn - g.turn) <= ALIKE_TURN_DEG && h.r >= ALIKE_RADIUS * g.r,
    )
    if (twin) {
      g.kind = 'corner'
      g.x = g.apex.x
      g.y = g.apex.y
    }
  }
  if (!gaps.some((g) => g.kind === 'fillet')) return say('no-fillet', R, gaps)

  // A sharp corner needs two runs that could not be chords of one arc through it. Were a
  // run a chord of a circle turning θ per chord length, its sagitta would be L·θ/8, and a
  // certified run cannot hide `sagMin`: so a 9° vertex needs 37px of line each side (the
  // bend in a SoundCloud bar has 70) while a 90° one needs 4. Without this a gently
  // curved side is read as a polygon of its own chords, with a kink at every joint.
  for (let i = 0; i < R; i++) {
    const g = gaps[i]
    if (g.kind !== 'corner') continue
    const theta = (g.turn * Math.PI) / 180
    for (const run of [runs[i], runs[(i + 1) % R]])
      if (((run.s1 - run.s0) * theta) / 8 < sagMin) return say('gap-unexplained', R, gaps)
  }
  // The turns must close the loop once. A gap is read as the SHORT arc between its two
  // runs, and the radial residual cannot tell that from the long way round the same
  // circle — which is what the last two chords of a disc have between them.
  let winding = 0
  for (const g of gaps) winding += g.side * g.turn
  if (Math.abs(Math.abs(winding) - 360) > 1) return say('winding', R, gaps)

  // The two tangent points on a run must not cross.
  const sides = runs.map((run, i) => {
    const before = gaps[(i - 1 + R) % R]
    const after = gaps[i]
    const from = before.kind === 'fillet' ? before.cutB : 0
    const to = after.kind === 'fillet' ? after.cutA : 0
    return { len: run.s1 - run.s0, straight: run.s1 - run.s0 - from - to }
  })
  if (sides.some((sd) => sd.straight < -OVERLAP_TOL)) return say('overlap', R, gaps, sides)

  const out: PathNode[] = []
  for (let i = 0; i < R; i++) {
    const g = gaps[i]
    const A = runs[i]
    const B = runs[(i + 1) % R]
    if (g.kind === 'fillet') out.push(...arcNodes(g, { x: A.dx, y: A.dy }, { x: B.dx, y: B.dy }))
    else out.push({ x: g.x, y: g.y, hIn: null, hOut: null, kind: 'corner' })
  }
  // Two tangent points that met on one run (a stadium's short side) are one smooth node.
  const joinable = (p: PathNode, q: PathNode): boolean =>
    p.kind === 'smooth' && q.kind === 'smooth' && !p.hOut && !q.hIn && Math.hypot(p.x - q.x, p.y - q.y) <= OVERLAP_TOL
  const join = (p: PathNode, q: PathNode): PathNode => {
    const x = (p.x + q.x) / 2
    const y = (p.y + q.y) / 2
    return {
      x,
      y,
      hIn: p.hIn ? { x: p.hIn.x + x - p.x, y: p.hIn.y + y - p.y } : null,
      hOut: q.hOut ? { x: q.hOut.x + x - q.x, y: q.hOut.y + y - q.y } : null,
      kind: 'smooth',
    }
  }
  const nodes: PathNode[] = []
  for (const nd of out) {
    const last = nodes[nodes.length - 1]
    if (last && joinable(last, nd)) nodes[nodes.length - 1] = join(last, nd)
    else nodes.push(nd)
  }
  if (nodes.length >= 2 && joinable(nodes[nodes.length - 1], nodes[0])) {
    nodes[0] = join(nodes[nodes.length - 1], nodes[0])
    nodes.pop()
  }
  if (nodes.length < 3) return say('overlap', R, gaps, sides)
  diag?.({ n, runs: R, verdict: 'emitted', gaps, sides })
  return nodes
}
