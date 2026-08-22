// GEOMETRIC scoring of a traced doc against ground-truth outlines.
//
// The point of this file: every metric here has a KNOWN OPTIMUM (0 error, ratio 1.0), so
// "did we improve" is answerable without re-blessing a baseline. That is the difference
// between a regression gate (which only knows "same as last time") and a truth gate.
//
// ---------------------------------------------------------------------------
// Two design decisions that carry the whole thing:
//
// 1. ARC-LENGTH RESAMPLING, POINT-TO-SEGMENT DISTANCE.
//    Im2Vec (CVPR 2021) argues Chamfer distance is a bad vectorization metric because it
//    "varies wildly depending on the sampling pattern" — a method that regresses the
//    ground truth's own parameterization scores well while looking worse. That objection
//    is the field's stated reason for retreating to raster-only metrics, and it kills any
//    naive node-to-node or uniform-in-t comparison.
//
//    We defuse it on both sides. Query points are resampled at a FIXED ARC-LENGTH SPACING
//    (not per-node, not uniform-in-t), so point density is a property of the curve's
//    length alone — independent of where the tracer chose to put nodes. And distance is
//    measured to the nearest SEGMENT of the target polyline, not the nearest target point,
//    so the target's own discretization density drops out too. Neither side can be gamed
//    by parameterization.
//
// 2. BOUNDARY DISTANCE IS COMPOSITION-INVARIANT; COUNTS ARE NOT.
//    An authored SVG's primitive count does not equal the region count a planar tracer
//    should recover. bloom.svg is 3 translucent circles → ~7 opaque composited regions
//    (correctly). nebula.svg is 4 paths of which 2 share a fill → 3 merged paths
//    (correctly). Scoring "recovered paths vs authored paths" would mark both as failures.
//    But the BOUNDARY CURVES agree exactly in both cases, whatever the compositing did.
//    So boundary distance leads, and parsimony is expressed as nodes per unit of boundary
//    LENGTH — scale-free, and blind to both the compositing split and the artist's choice
//    of how many nodes to spend on a circle.
//
// 3. THE MISSED SIDE COUNTS ONLY VISIBLE BOUNDARY.
//    An authored outline occluded by a later-painted shape made no pixels, so no tracer can
//    recover it — scoring it invents defects (§0 #1 was exactly that: taco "missed" 20px on
//    a pixel-perfect trace, because 45.5% of its authored outline is hidden overdraw). GT
//    query samples are kept only where the truth raster shows a colour change — see
//    makeVisibleAt below and docs/vectorization-benchmarks.md §9.6.
// ---------------------------------------------------------------------------

import { segmentCount, segmentControls } from '../lib/path/geometry.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'
import { srgbToLab, deltaE76 } from './color.ts'
import type { SubPath, EditableDoc, Vec } from '../lib/path/types.ts'
import type { GroundShape } from './svgGround.ts'

/** Chord tolerance (px) for flattening curves to polylines. Well under the ~0.5px
 *  resample spacing so flattening error never dominates the measurement. */
const FLATNESS = 0.05
/** Arc-length spacing (px) between query points. */
const SPACING = 0.5
/** Points within this distance of the canvas edge are dropped — see collectPolylines. */
const BORDER_EPS = 1.5

// ---------------------------------------------------------------------------
// Flattening + arc-length resampling
// ---------------------------------------------------------------------------

/** Recursive de Casteljau to a chord-flatness tolerance. Appends to `out` (excl. p0). */
function flattenCubic(p0: Vec, c1: Vec, c2: Vec, p3: Vec, out: Vec[], depth = 0): void {
  // Flatness = max control-point deviation from the chord.
  const dx = p3.x - p0.x, dy = p3.y - p0.y
  const d1 = Math.abs((c1.x - p3.x) * dy - (c1.y - p3.y) * dx)
  const d2 = Math.abs((c2.x - p3.x) * dy - (c2.y - p3.y) * dx)
  const dd = (d1 + d2) ** 2
  if (depth >= 20 || dd < FLATNESS * FLATNESS * (dx * dx + dy * dy)) {
    out.push(p3)
    return
  }
  const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  const p01 = mid(p0, c1), p12 = mid(c1, c2), p23 = mid(c2, p3)
  const p012 = mid(p01, p12), p123 = mid(p12, p23)
  const m = mid(p012, p123)
  flattenCubic(p0, p01, p012, m, out, depth + 1)
  flattenCubic(m, p123, p23, p3, out, depth + 1)
}

/** One subpath → a dense polyline (closed subpaths repeat the first point at the end). */
export function flattenSubPath(sp: SubPath): Vec[] {
  if (sp.nodes.length === 0) return []
  const out: Vec[] = [{ x: sp.nodes[0].x, y: sp.nodes[0].y }]
  const n = segmentCount(sp)
  for (let s = 0; s < n; s++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, s)
    flattenCubic(p0, c1, c2, p3, out)
  }
  return out
}

/** Straight-line length of a polyline. */
function polylineLength(pts: Vec[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

/** A query point plus the unit tangent of the segment it was sampled from — the tangent
 *  exists so the visibility test can step along the boundary NORMAL. */
interface QueryPt { x: number; y: number; tx: number; ty: number }

/**
 * Walk a polyline at a FIXED ARC-LENGTH step, emitting query points. This is the step that
 * makes the metric parameterization-invariant: density depends only on curve length, never
 * on node placement or curvature.
 */
function resampleByArcLength(pts: Vec[], spacing: number, out: QueryPt[]): void {
  if (pts.length < 2) return
  const l0 = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1
  out.push({ x: pts[0].x, y: pts[0].y, tx: (pts[1].x - pts[0].x) / l0, ty: (pts[1].y - pts[0].y) / l0 })
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    if (seg <= 0) continue
    const tx = (b.x - a.x) / seg, ty = (b.y - a.y) / seg
    let t = spacing - carry
    while (t <= seg) {
      const u = t / seg
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, tx, ty })
      t += spacing
    }
    carry = (carry + seg) % spacing
  }
}

// ---------------------------------------------------------------------------
// Nearest-segment distance, with a uniform grid
// ---------------------------------------------------------------------------

interface Seg { ax: number; ay: number; bx: number; by: number }

/** Squared distance from a point to a segment. */
function distSqToSeg(px: number, py: number, s: Seg): number {
  const vx = s.bx - s.ax, vy = s.by - s.ay
  const wx = px - s.ax, wy = py - s.ay
  const vv = vx * vx + vy * vy
  let t = vv > 0 ? (wx * vx + wy * vy) / vv : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = px - (s.ax + t * vx), dy = py - (s.ay + t * vy)
  return dx * dx + dy * dy
}

/** Uniform spatial hash over segments — expanding-ring query, exact nearest segment. */
class SegGrid {
  private cell: number
  private minX = Infinity; private minY = Infinity
  private cols = 0; private rows = 0
  private bins: Seg[][] = []

  constructor(segs: Seg[], cell = 8) {
    this.cell = cell
    let maxX = -Infinity, maxY = -Infinity
    for (const s of segs) {
      this.minX = Math.min(this.minX, s.ax, s.bx); this.minY = Math.min(this.minY, s.ay, s.by)
      maxX = Math.max(maxX, s.ax, s.bx); maxY = Math.max(maxY, s.ay, s.by)
    }
    if (!segs.length) { this.minX = this.minY = 0; maxX = maxY = 0 }
    this.cols = Math.max(1, Math.ceil((maxX - this.minX) / cell) + 1)
    this.rows = Math.max(1, Math.ceil((maxY - this.minY) / cell) + 1)
    this.bins = Array.from({ length: this.cols * this.rows }, () => [])
    for (const s of segs) {
      const c0 = this.cx(Math.min(s.ax, s.bx)), c1 = this.cx(Math.max(s.ax, s.bx))
      const r0 = this.cy(Math.min(s.ay, s.by)), r1 = this.cy(Math.max(s.ay, s.by))
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) this.bins[r * this.cols + c].push(s)
    }
  }
  private cx(x: number): number { return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell))) }
  private cy(y: number): number { return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell))) }

  /** Exact distance to the nearest segment; Infinity if the grid is empty. */
  nearest(px: number, py: number): number {
    if (!this.bins.length) return Infinity
    const c = this.cx(px), r = this.cy(py)
    let best = Infinity
    const maxRing = Math.max(this.cols, this.rows)
    for (let ring = 0; ring <= maxRing; ring++) {
      // Once the closest possible point in the next ring is farther than `best`, stop.
      if (best < Infinity && (ring - 1) * this.cell > Math.sqrt(best)) break
      for (let r2 = r - ring; r2 <= r + ring; r2++) {
        if (r2 < 0 || r2 >= this.rows) continue
        for (let c2 = c - ring; c2 <= c + ring; c2++) {
          if (c2 < 0 || c2 >= this.cols) continue
          // Only the ring's perimeter is new.
          if (ring > 0 && Math.abs(r2 - r) !== ring && Math.abs(c2 - c) !== ring) continue
          for (const s of this.bins[r2 * this.cols + c2]) {
            const d = distSqToSeg(px, py, s)
            if (d < best) best = d
          }
        }
      }
    }
    return Math.sqrt(best)
  }
}

// ---------------------------------------------------------------------------
// Collecting comparable boundaries
// ---------------------------------------------------------------------------

interface Boundary {
  /** Dense polylines, for use as a distance TARGET. */
  segs: Seg[]
  /** Arc-length-uniform points, for use as distance QUERIES. */
  queries: Vec[]
  /** Total boundary length (px) — the parsimony denominator. */
  length: number
  /** Anchor count. */
  nodes: number
}

/**
 * Flatten a set of subpaths into a comparable boundary.
 *
 * Border exclusion: a traced doc always carries a background region whose boundary runs
 * along the canvas edge, and authored art usually does not (bloom has no background rect).
 * That edge is an artifact of framing, not of the art, so points within BORDER_EPS of the
 * canvas rectangle are dropped from the QUERY set — otherwise the reverse distance would
 * be dominated by a boundary that has no counterpart by construction. Target segments keep
 * the border so a genuine shape that legitimately touches the edge still has something to
 * match against.
 *
 * `visibleAt` (GT side only): drop query points where the truth raster shows no edge —
 * see the visibility block above scoreGeometry. Only QUERIES are filtered; the target
 * segments, node counts and lengths stay whole, so parsimony and the spurious side are
 * untouched by construction.
 */
function collectBoundary(
  subPathSets: SubPath[][],
  w: number,
  h: number,
  visibleAt?: (q: QueryPt) => boolean,
): Boundary {
  const segs: Seg[] = []
  const queries: Vec[] = []
  let length = 0
  let nodes = 0

  const onBorder = (p: Vec): boolean =>
    p.x < BORDER_EPS || p.y < BORDER_EPS || p.x > w - BORDER_EPS || p.y > h - BORDER_EPS

  for (const set of subPathSets) {
    for (const sp of set) {
      nodes += sp.nodes.length
      const poly = flattenSubPath(sp)
      if (poly.length < 2) continue
      const pts = sp.closed && (poly[0].x !== poly[poly.length - 1].x || poly[0].y !== poly[poly.length - 1].y)
        ? [...poly, poly[0]]
        : poly
      length += polylineLength(pts)
      for (let i = 1; i < pts.length; i++) {
        segs.push({ ax: pts[i - 1].x, ay: pts[i - 1].y, bx: pts[i].x, by: pts[i].y })
      }
      const q: QueryPt[] = []
      resampleByArcLength(pts, SPACING, q)
      for (const p of q) if (!onBorder(p) && (!visibleAt || visibleAt(p))) queries.push({ x: p.x, y: p.y })
    }
  }
  return { segs, queries, length, nodes }
}

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

export interface GeomScore {
  /**
   * How many boundary sample points existed to compare AT ALL. Zero means the case has no
   * scorable interior boundary — e.g. bg-ramp is one full-canvas rect whose entire outline
   * IS the canvas border, which border-exclusion (correctly) drops.
   *
   * This field exists because without it `mean([]) === 0` and the case reports a PERFECT
   * boundary score for having measured nothing. A gate that passes because it found nothing
   * to check is worse than no gate. Callers must treat `samples === 0` as "not scorable",
   * never as "0px error".
   */
  samples: number
  /** Mean symmetric boundary distance (px). The headline number: 0 is perfect. */
  chamfer: number
  /** Max symmetric boundary distance (px) — worst single excursion. */
  hausdorff: number
  /** 95th-percentile symmetric distance (px). Hausdorff is brittle to one stray speck;
   *  this is the number to gate on. */
  p95: number
  /** Ground truth → traced. High ⇒ authored detail the tracer MISSED. */
  missedMean: number
  missedMax: number
  /** Traced → ground truth. High ⇒ boundary the tracer HALLUCINATED. */
  spuriousMean: number
  spuriousMax: number

  /** Anchor counts. */
  gtNodes: number
  docNodes: number
  /** Boundary length (px). */
  gtLength: number
  docLength: number
  /** Nodes per 100px of boundary — the scale-free parsimony measure. */
  gtDensity: number
  docDensity: number
  /** docDensity / gtDensity. 1.0 = as economical as the artist; 10 = staircasing. */
  parsimony: number

  gtShapes: number
  docPaths: number

  /** VISIBLE authored sharp corners (turn ≥ CORNER_MIN_TURN, occluded ones excluded). */
  gtCorners: number
  /** How many of those the trace reproduces as a sharp corner within CORNER_MATCH_R px.
   *  The check boundary DISTANCE cannot make: rounding a sharp corner into a smooth arc
   *  (a checker cell → a blob) barely moves chamfer at small scale but destroys the shape.
   *  cornersRecovered < gtCorners is exactly that defect (docs/vectorization-benchmarks.md
   *  §0 #7). Only meaningful when gtCorners is large enough — see evaluateTruthGates. */
  cornersRecovered: number
  /** Sharp corners the trace asserts that the authored art does not have — the PRECISION
   *  half of corner scoring, which this corpus was blind to until §23. `cornersRecovered`
   *  alone made INVENTING a corner free, and §22 shipped green because of it. */
  cornersInvented: number
  /** The worst invented corner's excess turn, deg over the authored boundary's own turn
   *  across ±KINK_WIN px. */
  worstInventedExcess: number
}

/** Turn angle (rad) at/above which a boundary vertex is a "sharp corner". 60°: a circle's
 *  4-node kappa fit turns ~5.6°/flatten-step, so genuine round art never trips it; a
 *  polygon corner (a square's 90°) always does. Matches planarBeautify's CORNER_TURN. */
const CORNER_MIN_TURN = Math.PI / 3
/** A GT corner counts as reproduced if a traced corner sits within this many px of it.
 *  Distance-tolerant on purpose: a corner shifted 2px is still a corner (this gate is about
 *  the corner EXISTING, not its sub-pixel placement — that is chamfer/p95's job). */
export const CORNER_MATCH_R = 2.5
/** A GT corner is only GRADED when BOTH its incident authored edges are at least this long:
 *  the gate judges rounding of RESOLVABLE shapes (an 8px checker cell), not the crispness of
 *  a sub-pixel sliver's cap. hairlines' bars are 0.5–6px wide, so every bar corner has one
 *  short cap edge and drops out here — thin-feature fidelity is chamfer/p95 + §9.5's job, not
 *  this gate's. Applied to GT corners only; any traced hard corner is a valid match target. */
export const CORNER_MIN_EDGE = 7

export interface Corner { x: number; y: number; itx: number; ity: number; otx: number; oty: number }

/**
 * SHARP corners of a set of subpath lists: a vertex where the boundary TANGENT turns by
 * ≥ CORNER_MIN_TURN — a C⁰ kink. The tangent into the node comes from the incoming curve
 * handle when the segment is a curve (cur − hIn, else prev.hOut, else the chord) and from
 * the chord when it is a line; mirrored on the way out. Reading TANGENTS instead of
 * requiring handle-free line-line joints matters on the flat path: FLAT_LINE_COST tunes the
 * fit DP to prefer cubics wherever one fits within ε, so a genuinely sharp star tip lands as
 * a C⁰ kink between two cubics whose handles lie along the straight arms — it renders
 * exactly as sharp as a line-line corner and must count as one (the old handle-free test
 * scored the fixed sharp-star 3/11 while all 10 tips were visually crisp, §10.2). The
 * failure this metric exists to catch is still caught: a corner MELTED into a blob (a
 * checker cell rounded over) is G¹ — its in/out tangents agree, the turn is ~0 — so it
 * never reads as sharp. Both the GT and the trace are read the same way, and authored
 * polygons carry no handles, so the GT side is unchanged for polygonal art.
 * Each corner carries its incoming/outgoing unit tangents so GT corners can be visibility-
 * tested against the truth raster. Open subpaths skip their two endpoints. `minEdge` gates
 * on CHORD length (feature size), never handle length.
 */
export function sharpCorners(sets: SubPath[][], minEdge = 0): Corner[] {
  const cosMax = Math.cos(CORNER_MIN_TURN) // turn ≥ MIN_TURN  ⇔  dot ≤ cos(MIN_TURN)
  const out: Corner[] = []
  for (const set of sets) {
    for (const sp of set) {
      const nodes = sp.nodes
      const n = nodes.length
      const closed = sp.closed !== false
      // A CLOSED 2-node loop is real geometry with up to two sharp corners — a lens
      // counter fitted as two arcs meeting at its chord ends (§19's letter-joins) is
      // exactly that, and skipping it scored a perfectly-placed corner as missing.
      // prev === next there, which the tangent reads below handle fine; an OPEN 2-node
      // path has no interior vertex and still needs 3.
      if (closed ? n < 2 : n < 3) continue
      const lo = closed ? 0 : 1
      const hi = closed ? n : n - 1
      for (let i = lo; i < hi; i++) {
        const cur = nodes[i]
        const prev = nodes[(i - 1 + n) % n]
        const next = nodes[(i + 1) % n]
        // Chord lengths gate feature size (a sub-pixel sliver's cap is not graded) …
        const li = Math.hypot(cur.x - prev.x, cur.y - prev.y)
        const lo2 = Math.hypot(next.x - cur.x, next.y - cur.y)
        if (li < 1e-6 || lo2 < 1e-6) continue
        if (li < minEdge || lo2 < minEdge) continue // corner on too-thin a feature to grade
        // … while the TURN is measured on tangents: the nearest non-degenerate control
        // point (own handle, far handle, anchor) defines each side's direction.
        const tin = pickCtrl(cur, cur.hIn, prev.hOut, prev)
        const tout = pickCtrl(cur, cur.hOut, next.hIn, next)
        let ix = cur.x - tin.x
        let iy = cur.y - tin.y
        let ox = tout.x - cur.x
        let oy = tout.y - cur.y
        const ln = Math.hypot(ix, iy)
        const lt = Math.hypot(ox, oy)
        if (ln < 1e-6 || lt < 1e-6) continue
        ix /= ln; iy /= ln; ox /= lt; oy /= lt
        if (ix * ox + iy * oy <= cosMax) out.push({ x: cur.x, y: cur.y, itx: ix, ity: iy, otx: ox, oty: oy })
      }
    }
  }
  return out
}

/** First control point that is meaningfully apart from `at` (a zero-length handle carries
 *  no direction), falling back to the far anchor — which always is, per the chord guard. */
function pickCtrl(
  at: { x: number; y: number },
  ...cands: ({ x: number; y: number } | null | undefined)[]
): { x: number; y: number } {
  for (const c of cands) {
    if (c && Math.hypot(c.x - at.x, c.y - at.y) >= 1e-6) return c
  }
  return at // unreachable: the last candidate is the far anchor, checked non-degenerate above
}

/** Count how many `gt` corners have a `doc` corner within R px (spatial-hash matched). */
function matchCorners(gt: Corner[], doc: Corner[], R: number): number {
  if (gt.length === 0) return 0
  const cell = Math.max(1, R)
  const grid = new Map<number, Corner[]>()
  const key = (gx: number, gy: number): number => gx * 73856093 + gy // sparse buckets
  for (const p of doc) {
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell))
    const a = grid.get(k)
    if (a) a.push(p); else grid.set(k, [p])
  }
  const R2 = R * R
  let hit = 0
  for (const g of gt) {
    const gx = Math.floor(g.x / cell)
    const gy = Math.floor(g.y / cell)
    let found = false
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (const p of grid.get(key(gx + dx, gy + dy)) ?? []) {
          const ddx = p.x - g.x
          const ddy = p.y - g.y
          if (ddx * ddx + ddy * ddy <= R2) { found = true; break }
        }
      }
    }
    if (found) hit++
  }
  return hit
}

// ---------------------------------------------------------------------------
// Region recovery — the check that boundary distance alone can miss
// ---------------------------------------------------------------------------

/**
 * Did the tracer recover every FLAT REGION the art actually contains?
 *
 * Truth comes from the ground-truth RASTER, not the SVG's fill list: alpha compositing and
 * painter-order occlusion mean the visible palette is not the authored palette (three
 * translucent circles produce seven visible colours, not three). Every colour occupying a
 * meaningful area of the composited raster is a region the tracer owes us.
 *
 * This is the metric that catches a dropped low-contrast region — the failure raster
 * fidelity is structurally blind to, because a small region merged into a neighbour whose
 * colour is close costs almost nothing in mean ΔE or SSIM while destroying the topology.
 */
export interface RegionScore {
  /** Distinct flat regions present in the composited raster. */
  trueRegions: number
  /** How many the trace paints the right colour AT THE REGION'S OWN PIXELS. */
  recovered: number
  /** Regions the trace gets wrong, worst first: what the art has, what the trace painted
   *  there instead, and how far apart they are. */
  missing: { hex: string; areaPx: number; paintedHex: string; deltaE: number }[]
  /** 1 where a pixel belongs to a DROPPED region — so the view can show you WHERE, not
   *  just tell you a count. Same dimensions as the raster. */
  dropMask: Uint8Array
  /**
   * INK KEPT per region: how much of the colour the trace actually paints, as
   * rendered px / source px (both counted at ΔE ≤ MATCH_DELTA_E of the region colour,
   * over the whole raster). 1.0 = the trace covers the region's area exactly.
   *
   * `recovered` above asks a question at the region's OWN pixels and answers it with a
   * MEDIAN — so it flips only once the collapse has eaten more than half the region.
   * §0 #14 is the failure that motivated this: the `#990838` doc item EXISTED, with a
   * plausible fill, and had pinched to a 77px² sliver of a 634px region. The median
   * caught that one (13.5% ink), but only because the collapse was near-total; a region
   * pinched to 45% keeps its median and every boundary number stays sub-tolerance,
   * because the boundary that IS traced is traced accurately. Ink is the direct
   * question, and it degrades continuously.
   */
  ink: { hex: string; srcPx: number; renderPx: number; kept: number }[]
  /** The worst `kept` over all regions — the gated number. 1 when there are none. */
  worstInk: number
}

/** A region counts as recovered if the trace paints it within this CIE76 ΔE of the truth. */
const MATCH_DELTA_E = 4
/** Ignore raster colours below this share of the image (stray pixels). */
const MIN_AREA_FRAC = 0.0005

const toHex = (c: [number, number, number]): string =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** Median of a small sample — robust to the odd pixel that lands on a traced edge. */
function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/**
 * `raster` is the ground-truth render.
 *
 * ⚠ FLAT ART ONLY. This metric asks "does every flat region survive tracing", which is
 * meaningless where the art has no flat regions. On a smooth ramp, neighbouring columns
 * quantise to the same 8-bit colour, so the flat-interior test below happily reports each
 * band as a "region" — bg-ramp yields 69 of them, and a tracer that correctly fits ONE
 * gradient is scored as having dropped 60. Callers must skip this for gradient cases (see
 * TruthCase.gradients); the right colour metric there is per-pixel ΔE against the truth
 * raster, which the existing fidelity() already provides.
 *
 * Only FLAT-INTERIOR pixels are counted — a pixel whose 8 neighbours all carry the exact
 * same colour. Area alone cannot separate a small region from an anti-aliased edge band:
 * on a large curved shape the AA blend along one boundary can occupy more pixels than a
 * genuine small region does, so a pure area threshold reports phantom regions at low
 * resolution (nebula@256 produced 13 of them). An AA pixel is a one-off blend and is
 * essentially never surrounded by eight identical pixels; a region interior always is.
 */
export function scoreRegions(
  raster: { width: number; height: number; data: Uint8ClampedArray },
  doc: EditableDoc,
): RegionScore {
  const { width, height, data } = raster
  const area = width * height
  const rgbAt = (i: number): number => {
    const o = i * 4
    return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
  }

  const hist = new Map<number, number>()
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const key = rgbAt(i)
      let flat = true
      for (let dy = -1; dy <= 1 && flat; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (rgbAt(i + dy * width + dx) !== key) { flat = false; break }
        }
      }
      if (flat) hist.set(key, (hist.get(key) ?? 0) + 1)
    }
  }

  const minArea = Math.max(16, area * MIN_AREA_FRAC)
  const regions = [...hist.entries()]
    .filter(([, n]) => n >= minArea)
    .map(([k, n]) => ({ key: k, rgb: [(k >> 16) & 255, (k >> 8) & 255, k & 255] as [number, number, number], areaPx: n }))
    .sort((a, b) => b.areaPx - a.areaPx)

  // Ask the trace what colour it paints AT EACH REGION'S OWN PIXELS, rather than looking for
  // a fill of a similar colour anywhere in the doc.
  //
  // Matching by colour is subtly wrong: it can pair a dropped region with an unrelated path
  // that merely happens to be a similar shade. bloom's dropped A∩C lens (#1e9feb) sits only
  // ΔE 4.7 from the traced B∩C fill (#309bdf) — a different region entirely, on the other
  // side of the image. A colour-matcher with a threshold of 5 would have called that
  // "recovered" and hidden a real defect. Location cannot lie: if the trace paints the wrong
  // colour where the region actually is, the region is not recovered.
  const render = rasterizeDoc(doc, width, height)
  const sampleOf = new Map<number, number[][]>()
  for (const r of regions) sampleOf.set(r.key, [])
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const bucket = sampleOf.get(rgbAt(i))
      if (!bucket) continue
      const o = i * 4
      bucket.push([render[o], render[o + 1], render[o + 2]])
    }
  }

  const missing: RegionScore['missing'] = []
  const droppedKeys = new Set<number>()
  let recovered = 0

  for (const r of regions) {
    const s = sampleOf.get(r.key) ?? []
    // Median per channel: robust to the few interior pixels that land on a traced edge.
    const got: [number, number, number] = [
      median(s.map((p) => p[0])), median(s.map((p) => p[1])), median(s.map((p) => p[2])),
    ]
    const d = Number.isFinite(got[0])
      ? deltaE76(srgbToLab(r.rgb[0], r.rgb[1], r.rgb[2]), srgbToLab(got[0], got[1], got[2]))
      : Infinity
    if (d <= MATCH_DELTA_E) recovered++
    else {
      missing.push({ hex: toHex(r.rgb), areaPx: r.areaPx, paintedHex: Number.isFinite(got[0]) ? toHex(got) : '—', deltaE: d })
      droppedKeys.add(r.key)
    }
  }
  missing.sort((a, b) => b.areaPx - a.areaPx)

  const dropMask = new Uint8Array(area)
  if (droppedKeys.size) {
    for (let i = 0; i < area; i++) if (droppedKeys.has(rgbAt(i))) dropMask[i] = 1
  }

  // INK KEPT — the same render, asked an AREA question instead of a median one. Both
  // sides count at ΔE ≤ MATCH_DELTA_E of the region colour, so AA fringes are counted
  // (or not) identically on the source and the render and the ratio stays ~1 on a
  // healthy trace. One pass over the pixels, with region membership memoised per
  // distinct packed RGB — a gradient raster has tens of thousands of distinct colours
  // and dozens of "regions", and the naive regions × pixels loop is 36M ΔE there.
  const regionLabs = regions.map((r) => srgbToLab(r.rgb[0], r.rgb[1], r.rgb[2]))
  const memberCache = new Map<number, number[]>()
  const membersOf = (packed: number): number[] => {
    let m = memberCache.get(packed)
    if (!m) {
      const lab = srgbToLab((packed >> 16) & 255, (packed >> 8) & 255, packed & 255)
      m = []
      for (let k = 0; k < regionLabs.length; k++) if (deltaE76(lab, regionLabs[k]) <= MATCH_DELTA_E) m.push(k)
      memberCache.set(packed, m)
    }
    return m
  }
  const srcCount = new Int32Array(regions.length)
  const renCount = new Int32Array(regions.length)
  for (let i = 0; i < area; i++) {
    const o = i * 4
    for (const k of membersOf(rgbAt(i))) srcCount[k]++
    for (const k of membersOf((render[o] << 16) | (render[o + 1] << 8) | render[o + 2])) renCount[k]++
  }
  const ink: RegionScore['ink'] = regions.map((r, k) => ({
    hex: toHex(r.rgb),
    srcPx: srcCount[k],
    renderPx: renCount[k],
    kept: srcCount[k] > 0 ? renCount[k] / srcCount[k] : 1,
  }))
  ink.sort((a, b) => a.kept - b.kept)

  return {
    trueRegions: regions.length,
    recovered,
    missing,
    dropMask,
    ink,
    worstInk: ink.length ? ink[0].kept : 1,
  }
}

const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
const maxOf = (a: number[]): number => (a.length ? a.reduce((s, v) => (v > s ? v : s), 0) : 0)
const pct = (a: number[], p: number): number => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

/** A boundary sample and how far it sits from the other side's boundary — the raw material
 *  the view draws as a heat map, so a bad number can be LOCATED and not merely reported. */
export interface DistPoint { x: number; y: number; d: number }

export interface GeomDiagnostics {
  /** VISIBLE authored boundary (occluded outline excluded — see makeVisibleAt), coloured by
   *  distance to the nearest traced boundary. Hot ⇒ MISSED. */
  gtPoints: DistPoint[]
  /** Traced boundary, coloured by distance to the nearest authored boundary. Hot ⇒ INVENTED. */
  docPoints: DistPoint[]
}

/** How far to step along the boundary normal when testing visibility: outside the ~1.25px
 *  AA band, same probe §8.4 used. */
const VIS_PROBE = 2
/** Per-channel RGB tolerance for "these two pixels read the same colour". Flat fills render
 *  exactly equal; an edge's two sides differ by far more than 2 at ±2px. */
const VIS_SAME = 2

/**
 * Is there anything to SEE at this ground-truth boundary point?
 *
 * parseGroundTruth reads geometry only — deliberately, it never reimplements painter's-
 * algorithm occlusion — so every authored outline arrives here whether the composited render
 * shows it or not. Fluent's Flat twins are authored with heavy overdraw (taco's back shell is
 * a complete closed path almost entirely BEHIND the front shell — 45.5% of its outline is
 * invisible), and an edge that made no pixels is not something a tracer can be charged with
 * missing: scoring it produced the phantom "missed boundary on flat art" defect (§0 #1,
 * 20px "missed" on a pixel-perfect trace — docs/vectorization-benchmarks.md §9.6).
 *
 * So the missed side counts only VISIBLE boundary: a sample is visible when the truth raster
 * changes colour across it — read at ±VIS_PROBE px along the boundary normal, plus the point
 * itself (the centre term keeps features thinner than 2·VIS_PROBE visible: their two sides
 * match but their own pixels are the feature). Off-canvas probes count as visible rather
 * than guessed at. This is the same standard the refusal lists already enforce (strokes,
 * patterns, clips: the truth is the VISIBLE boundary) — occlusion is just the one case cheap
 * enough to resolve per-sample from the raster instead of refusing the whole file.
 *
 * Verified before adopting (§9.6): on the 106 tier-2 twins this collapses the missed tail
 * from mean 1.89px / max 20.10px to mean 0.23px / max 0.63px while leaving every genuinely
 * traced-wrong case intact (gradient-flat 6.31 → 6.31, hairlines 0.39 → 0.39); real dropped
 * regions stay caught because THEIR edges are visible in the truth render by definition.
 */
export function makeVisibleAt(
  raster: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
): (q: { x: number; y: number; tx: number; ty: number }) => boolean {
  const { width, height, data } = raster
  const at = (x: number, y: number): number => {
    const xi = Math.round(x), yi = Math.round(y)
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return -1
    const o = (yi * width + xi) * 4
    return (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
  }
  const same = (a: number, b: number): boolean =>
    Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)) <= VIS_SAME &&
    Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)) <= VIS_SAME &&
    Math.abs((a & 255) - (b & 255)) <= VIS_SAME
  return (q) => {
    // normal = tangent rotated 90°
    const a = at(q.x - VIS_PROBE * q.ty, q.y + VIS_PROBE * q.tx)
    const b = at(q.x + VIS_PROBE * q.ty, q.y - VIS_PROBE * q.tx)
    const c = at(q.x, q.y)
    if (a < 0 || b < 0 || c < 0) return true
    return !same(a, b) || !same(c, a) || !same(c, b)
  }
}

/**
 * Score a traced doc against ground-truth shapes. Both must already be in the SAME pixel
 * space (see svgGround.toRasterSpace) — `w`/`h` are the raster dimensions. `truthRaster`
 * is the rasterized ground truth (the same pixels the tracer was given): the missed side
 * is scored against its VISIBLE boundary only — see makeVisibleAt above. It is required,
 * not optional, because a scorer that silently falls back to counting occluded outline
 * would re-open §0 #1 the first time a caller forgot the argument.
 */
// ---------------------------------------------------------------------------
// PRECISION: corners the trace INVENTS (§23)
//
// `cornersRecovered` is a RECALL number and has no precision term at all, so inventing a
// corner is free by it — and a corner invented within CORNER_MATCH_R of a real one even
// scores as recovering that one. Chamfer and p95 are nearly blind to a C⁰ kink on a short
// arc. §22 is the worked example: a change that put a visible kink in smooth boundary
// across ordinary art was green on every gate in this corpus, because the corpus could say
// a corner was LOST and never that one was INVENTED.
//
// The measurement, per traced sharp corner, is a like-for-like turn comparison at the
// CORNER's own scale: how much does the trace kink here, minus how much does the AUTHORED
// boundary turn across the same ±KINK_WIN px of arc length?
//
//     excess = (the traced node's C⁰ kink)  −  (authored turn over ±KINK_WIN px)
//
// A real corner gives excess ≈ 0 (both turn by the corner angle). A tight authored arc
// gives excess ≈ 0 as well — and that case is why the window has to be SMALL. Measured on
// the marks that reported §22 (instagram's glyph radii, chupa-chups' swirl), the sites a
// bad reading kinks are NOT flat boundary: the art there turns 12–45° per ±1px, i.e. a
// 1–5px radius. At ±5px such an arc has already turned 60–110°, so a wider window scores
// the kink as legitimate and sees nothing at all. ±1px is the scale at which "corner or
// curve" is actually a question.
//
// Four exemptions, each for boundary the trace is RIGHT to corner at:
//   • the canvas BORDER (framing, not art — `collectBoundary` drops it for the same reason);
//   • OCCLUDED authored boundary (the trace cannot reproduce what the raster does not show);
//   • a traced JUNCTION, degree ≥ 3 — where three regions meet, the boundary genuinely
//     corners even if each authored path through it is smooth (§14/§17's whole subject, and
//     where every posterization band seam lands);
//   • a CROSSING of two authored subpaths — a union's silhouette corners exactly there, and
//     `sharpCorners` cannot see it on the authored side because it reads one subpath at a
//     time.
// A traced corner further than KINK_NEAR from any authored boundary is invented BOUNDARY,
// which is `spuriousMax`'s job, and is not counted here.
// ---------------------------------------------------------------------------
/** Arc-length step the authored boundary is resampled at for the turn window. */
const KINK_STEP = 0.5
/** The window, in px of authored arc length, the authored turn is read over. */
export const KINK_WIN = 1
/** Excess turn (deg) at or above which a traced corner counts as INVENTED. */
export const KINK_EXCESS = 40
/** A traced corner further than this from authored boundary is `spuriousMax`'s business. */
const KINK_NEAR = 2.0
/** Two authored subpaths this close are crossing; the silhouette may corner there. */
const KINK_CROSS = 1.6
/** Distinct traced subpaths within this of a site; three or more is a junction. */
const KINK_JUNCTION = 1.6

interface TurnChain { pts: QueryPt[]; closed: boolean; shape: number }

/** Uniform arc-length resample of one subpath, with per-sample tangents. */
function turnChain(sp: SubPath, shape: number): TurnChain | null {
  const poly = flattenSubPath(sp)
  if (poly.length < 2) return null
  const closed = sp.closed !== false
  const pts = closed && (poly[0].x !== poly[poly.length - 1].x || poly[0].y !== poly[poly.length - 1].y)
    ? [...poly, poly[0]]
    : poly
  const out: QueryPt[] = []
  resampleByArcLength(pts, KINK_STEP, out)
  return out.length >= 3 ? { pts: out, closed, shape } : null
}

/** Turn of the chain's tangent across ±`win` px of arc length around sample `i`. */
function chainTurn(ch: TurnChain, i: number, win: number): number {
  const n = ch.pts.length
  const k = Math.max(1, Math.round(win / KINK_STEP))
  const idx = (j: number): number => (ch.closed ? ((j % n) + n) % n : Math.max(0, Math.min(n - 1, j)))
  const a = ch.pts[idx(i - k)]
  const b = ch.pts[idx(i + k)]
  return (Math.acos(Math.max(-1, Math.min(1, a.tx * b.tx + a.ty * b.ty))) * 180) / Math.PI
}

export interface InventedCorner { x: number; y: number; excess: number }

/**
 * Sharp corners the trace asserts that the authored art does not have, and the worst one's
 * excess turn. See the block comment above.
 */
export function inventedCorners(
  gt: GroundShape[],
  docSets: SubPath[][],
  w: number,
  h: number,
  visible: (q: QueryPt) => boolean,
): { count: number; worstExcess: number; sites: InventedCorner[] } {
  const chains: TurnChain[] = []
  gt.forEach((sh, si) => {
    for (const sp of sh.subPaths) {
      const c = turnChain(sp, si)
      if (c) chains.push(c)
    }
  })
  if (!chains.length) return { count: 0, worstExcess: 0, sites: [] }
  const gtCorners = sharpCorners(gt.map((sh) => sh.subPaths), 0)
  const docPolys = docSets.flat().map((sp) => flattenSubPath(sp))

  // One physical corner is reported once per side of a shared edge; keep one of each.
  const uniq: Corner[] = []
  for (const c of sharpCorners(docSets.flat().map((sp) => [sp]), 0))
    if (!uniq.some((u) => Math.hypot(u.x - c.x, u.y - c.y) <= 0.35)) uniq.push(c)

  // A uniform bucket grid over the authored samples: without it this is
  // (traced corners × authored samples) per case, which is ~10^6 distance tests on a mark
  // like chupa-chups and OOMs a corpus sweep. Cell size is the query radius, so a 3×3
  // neighbourhood is exact for every question asked below.
  const CELL = Math.max(KINK_NEAR, KINK_CROSS) + 0.5
  const grid = new Map<number, { ch: TurnChain; i: number }[]>()
  const key = (gx: number, gy: number): number => gx * 100003 + gy
  for (const ch of chains) {
    for (let i = 0; i < ch.pts.length; i++) {
      const k = key(Math.floor(ch.pts[i].x / CELL), Math.floor(ch.pts[i].y / CELL))
      const bucket = grid.get(k)
      if (bucket) bucket.push({ ch, i })
      else grid.set(k, [{ ch, i }])
    }
  }

  const sites: InventedCorner[] = []
  for (const c of uniq) {
    if (c.x < BORDER_EPS || c.y < BORDER_EPS || c.x > w - BORDER_EPS || c.y > h - BORDER_EPS) continue
    let bch: TurnChain | null = null
    let bi = -1
    let bd = Infinity
    const gx = Math.floor(c.x / CELL)
    const gy = Math.floor(c.y / CELL)
    const near: { ch: TurnChain; i: number; d: number }[] = []
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const bucket = grid.get(key(gx + ox, gy + oy))
        if (!bucket) continue
        for (const e of bucket) {
          const d = Math.hypot(e.ch.pts[e.i].x - c.x, e.ch.pts[e.i].y - c.y)
          if (d <= CELL) near.push({ ...e, d })
          if (d < bd) {
            bd = d
            bch = e.ch
            bi = e.i
          }
        }
      }
    }
    if (!bch || bd > KINK_NEAR) continue
    // The nearest sample belonging to a DIFFERENT authored shape: two shapes this close are
    // crossing, and a union's silhouette legitimately corners where they do.
    let otherShape = Infinity
    for (const e of near) if (e.ch.shape !== bch.shape && e.d < otherShape) otherShape = e.d
    const s = bch.pts[bi]
    if (!visible({ x: s.x, y: s.y, tx: s.tx, ty: s.ty })) continue
    if (otherShape <= KINK_CROSS) continue
    let degree = 0
    for (const poly of docPolys) {
      for (const q of poly) {
        if (Math.hypot(q.x - c.x, q.y - c.y) <= KINK_JUNCTION) {
          degree++
          break
        }
      }
    }
    if (degree >= 3) continue
    if (gtCorners.some((g) => Math.hypot(g.x - c.x, g.y - c.y) <= CORNER_MATCH_R)) continue
    const kink = (Math.acos(Math.max(-1, Math.min(1, c.itx * c.otx + c.ity * c.oty))) * 180) / Math.PI
    const excess = kink - chainTurn(bch, bi, KINK_WIN)
    if (excess >= KINK_EXCESS) sites.push({ x: c.x, y: c.y, excess })
  }
  sites.sort((a, b) => b.excess - a.excess)
  return { count: sites.length, worstExcess: sites.length ? sites[0].excess : 0, sites }
}

export function scoreGeometry(
  gt: GroundShape[],
  doc: EditableDoc,
  w: number,
  h: number,
  truthRaster: { width: number; height: number; data: Uint8ClampedArray | Uint8Array },
): GeomScore & { diagnostics: GeomDiagnostics } {
  const docSets: SubPath[][] = []
  let docPaths = 0
  for (const item of doc.items) {
    if (item.kind !== 'path' || item.visible === false) continue
    docPaths++
    docSets.push(item.subPaths)
  }

  const visible = makeVisibleAt(truthRaster)
  const G = collectBoundary(gt.map((s) => s.subPaths), w, h, visible)
  const D = collectBoundary(docSets, w, h)

  // Corner recovery — a topology check boundary distance is structurally blind to. A GT
  // corner counts only if VISIBLE (occluded overdraw corners, like an under-bar tip, can't
  // be traced — same exclusion §9.6 applies to the missed side); it is recovered when the
  // trace has a sharp corner within CORNER_MATCH_R. A corner is visible if the truth raster
  // changes colour across EITHER of its two edges.
  const gtCornerAll = sharpCorners(gt.map((s) => s.subPaths), CORNER_MIN_EDGE)
  const gtCornerVis = gtCornerAll.filter(
    (c) => visible({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || visible({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
  )
  const cornersRecovered = matchCorners(gtCornerVis, sharpCorners(docSets), CORNER_MATCH_R)
  // …and the PRECISION half of the same question, blind in this corpus until §23.
  const invented = inventedCorners(gt, docSets, w, h, visible)

  const gGrid = new SegGrid(G.segs)
  const dGrid = new SegGrid(D.segs)

  // GT query → traced boundary: authored detail the tracer failed to reproduce.
  const gtPoints: DistPoint[] = G.queries.map((p) => ({ x: p.x, y: p.y, d: dGrid.nearest(p.x, p.y) })).filter((p) => Number.isFinite(p.d))
  // Traced query → GT boundary: boundary the tracer invented.
  const docPoints: DistPoint[] = D.queries.map((p) => ({ x: p.x, y: p.y, d: gGrid.nearest(p.x, p.y) })).filter((p) => Number.isFinite(p.d))

  const missed = gtPoints.map((p) => p.d)
  const spurious = docPoints.map((p) => p.d)

  const gtDensity = G.length > 0 ? (G.nodes / G.length) * 100 : 0
  const docDensity = D.length > 0 ? (D.nodes / D.length) * 100 : 0

  return {
    samples: gtPoints.length + docPoints.length,
    chamfer: (mean(missed) + mean(spurious)) / 2,
    hausdorff: Math.max(maxOf(missed), maxOf(spurious)),
    p95: Math.max(pct(missed, 0.95), pct(spurious, 0.95)),
    missedMean: mean(missed),
    missedMax: maxOf(missed),
    spuriousMean: mean(spurious),
    spuriousMax: maxOf(spurious),
    gtNodes: G.nodes,
    docNodes: D.nodes,
    gtLength: G.length,
    docLength: D.length,
    gtDensity,
    docDensity,
    parsimony: gtDensity > 0 ? docDensity / gtDensity : 0,
    gtShapes: gt.length,
    docPaths,
    gtCorners: gtCornerVis.length,
    cornersRecovered,
    cornersInvented: invented.count,
    worstInventedExcess: invented.worstExcess,
    diagnostics: { gtPoints, docPoints },
  }
}
