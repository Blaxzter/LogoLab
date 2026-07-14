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

  return { trueRegions: regions.length, recovered, missing, dropMask }
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
function makeVisibleAt(
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

  const G = collectBoundary(gt.map((s) => s.subPaths), w, h, makeVisibleAt(truthRaster))
  const D = collectBoundary(docSets, w, h)

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
    diagnostics: { gtPoints, docPoints },
  }
}
