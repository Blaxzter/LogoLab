// The geometry of a stroke, as closed pieces whose UNION is the painted area —
// the half of Outline stroke that needs no boolean engine (`outlineStroke.ts`
// does the union).
//
// The pieces are the ones `src/lib/render/raster.ts` paints a stroke with,
// except that they stay CURVES: a segment's two edges are its offsets, fitted
// as cubics within a tolerance (a straight segment is an exact rectangle), so
// the union paper.js computes comes back as a handful of editable curves, not
// as a polygon of thousands of points. Joins are the bevel triangle, the miter
// quad (unless the miter limit is exceeded, then the bevel) or the round wedge;
// caps the half disc or the square; a dash pattern is applied first, by arc
// length, and every dash is a piece of its own with its own caps.
//
// Every piece is wound the same way, which is what makes a plain union the
// right answer. That needs one care: where a curve bends tighter than half the
// stroke width, its inner offset folds over itself (a swallowtail). The fold
// winds the other way, so summed with anything it cancels — a U-turn's
// swallowtail lies over its own arms and cut a notch in them. Such a segment
// goes in stretches of a few degrees, each at worst a bow-tie that its OWN
// nonzero fill gets right (`StrokePiece.folds`: resolved alone, then united),
// its folding edge kept as the exact offset points rather than a curve fit.
//
// Pure: no DOM, no paper.js.

import type { PathItem, Stroke, SubPath, Vec } from '../path/types.ts'
import {
  type Cubic,
  add,
  cross,
  cubicD1,
  cubicD2,
  cubicPoint,
  cubicRange,
  cubicTangent,
  cubicsToNodes,
  dist,
  dot,
  fitCubics,
  isStraight,
  len,
  lineCubic,
  mul,
  sub,
  subPathCubics,
  unit,
} from './bezierFit.ts'

/** One run of centre line to stroke: a dash, or a whole subpath. */
export interface Centreline {
  cubics: Cubic[]
  closed: boolean
  /** A zero-length dash (or subpath): only a round or square cap paints, as SVG draws a dot. */
  dot?: { at: Vec; dir: Vec }
}

/** Below this length (viewBox units) a segment is a point. */
const POINT = 1e-9

/** Dashes per subpath before the pattern is given up on (a 0.01 dash on a long path). */
const MAX_DASHES = 4000

/** Max tangent turn (degrees) of one stretch of a folding segment. */
const FOLD_DEG = 10

/** Normal of a unit tangent: the tangent turned a quarter (+x → +y). */
const normal = (t: Vec): Vec => ({ x: -t.y, y: t.x })

const reverse = (c: Cubic): Cubic => ({ p0: c.p3, c1: c.c2, c2: c.c1, p3: c.p0 })

/** The stroke a path paints, or null when it paints none. */
export function paintedStroke(item: PathItem): Stroke | null {
  const s = item.stroke
  return s && s.width > 0 && (s.opacity ?? 1) > 0 ? s : null
}

/* ---------------------------------------------------------------- dashes */

/** Arc-length table of one cubic: cumulative length at uniform t. */
function lengthTable(c: Cubic, steps = 48): number[] {
  const out = [0]
  let prev = c.p0
  for (let k = 1; k <= steps; k++) {
    const p = cubicPoint(c, k / steps)
    out.push(out[k - 1] + dist(prev, p))
    prev = p
  }
  return out
}

/** The t at arc length s along a cubic, from its table. */
function tAtLength(table: number[], s: number): number {
  const steps = table.length - 1
  if (s <= 0) return 0
  if (s >= table[steps]) return 1
  let lo = 0
  let hi = steps
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (table[mid] < s) lo = mid
    else hi = mid
  }
  const span = table[hi] - table[lo]
  return (lo + (span > 0 ? (s - table[lo]) / span : 0)) / steps
}

/**
 * A subpath as the centre lines its stroke paints: itself when solid, else one
 * open run per dash. SVG's rules: an odd-length pattern repeats twice over, a
 * pattern of negatives or of zero total length draws solid, and a closed
 * subpath's dashing starts at its first node and does not wrap round into it.
 */
export function dashCentrelines(sp: SubPath, dash: readonly number[] | undefined): Centreline[] {
  const cubics = subPathCubics(sp.nodes, sp.closed).filter((c) => dist(c.p0, c.p3) > POINT || !isStraight(c))
  if (cubics.length === 0) {
    const n = sp.nodes[0]
    return n ? [{ cubics: [], closed: false, dot: { at: { x: n.x, y: n.y }, dir: { x: 1, y: 0 } } }] : []
  }
  const pattern = dash && dash.length % 2 === 1 ? [...dash, ...dash] : dash ? [...dash] : []
  const total = pattern.reduce((a, b) => a + b, 0)
  if (pattern.length === 0 || pattern.some((d) => !(d >= 0)) || !(total > 0)) return [{ cubics, closed: sp.closed }]

  const tables = cubics.map((c) => lengthTable(c))
  const starts: number[] = [0]
  for (const t of tables) starts.push(starts[starts.length - 1] + t[t.length - 1])
  const L = starts[starts.length - 1]

  /** The centre line between arc lengths s0 and s1. */
  const extract = (s0: number, s1: number): Centreline => {
    const out: Cubic[] = []
    for (let j = 0; j < cubics.length; j++) {
      const a = starts[j]
      const b = starts[j + 1]
      if (b <= s0 || a >= s1) continue
      const t0 = tAtLength(tables[j], Math.max(0, s0 - a))
      const t1 = tAtLength(tables[j], Math.min(b, s1) - a)
      if (t1 - t0 > 1e-12) out.push(cubicRange(cubics[j], t0, t1))
    }
    if (out.length === 0 || s1 - s0 <= POINT) {
      // A zero-length dash: a dot, facing the way the path runs there.
      let j = 0
      while (j < cubics.length - 1 && starts[j + 1] < s0) j++
      const t = tAtLength(tables[j], s0 - starts[j])
      return {
        cubics: [],
        closed: false,
        dot: { at: cubicPoint(cubics[j], t), dir: cubicTangent(cubics[j], t) ?? { x: 1, y: 0 } },
      }
    }
    return { cubics: out, closed: false }
  }

  const out: Centreline[] = []
  let s = 0
  let i = 0
  let on = true
  while (s < L && out.length < MAX_DASHES) {
    const e = Math.min(L, s + pattern[i])
    if (on) out.push(extract(s, e))
    s = e
    i = (i + 1) % pattern.length
    on = !on
  }
  return out
}

/* ---------------------------------------------------------------- pieces */

/** One closed piece of a stroke. */
export interface StrokePiece {
  piece: SubPath
  /**
   * The piece is a segment body whose inner edge folds over itself: under a
   * nonzero fill of ITSELF it is the right area, but it must be resolved alone
   * before the union, where its inside-out swallowtail would cancel a neighbour.
   */
  folds: boolean
}

/**
 * The closed pieces whose union is the area `stroke` paints along `sp`, wound
 * positively (counter-clockwise in a y-up frame). `tol` bounds how far a fitted
 * offset may stray from the true one.
 */
export function strokePieces(sp: SubPath, stroke: Stroke, tol: number): StrokePiece[] {
  const hw = stroke.width / 2
  if (!(hw > 0)) return []
  const chains: Cubic[][] = []
  const folded = new Set<Cubic[]>()
  for (const cl of dashCentrelines(sp, stroke.dash)) centrelinePieces(cl, stroke, hw, tol, chains, folded)
  const out: StrokePiece[] = []
  for (const chain of chains) {
    const area = chainArea(chain)
    if (!(Math.abs(area) > 1e-9 * hw * hw)) continue
    const oriented = area > 0 ? chain : chain.map(reverse).reverse()
    out.push({ piece: { nodes: cubicsToNodes(oriented, true), closed: true }, folds: folded.has(chain) })
  }
  return out
}

function centrelinePieces(
  cl: Centreline,
  stroke: Stroke,
  hw: number,
  tol: number,
  out: Cubic[][],
  folded: Set<Cubic[]>,
): void {
  if (cl.dot) {
    if (stroke.cap === 'round') out.push(circle(cl.dot.at, hw))
    else if (stroke.cap === 'square') out.push(squareCap(cl.dot.at, mul(cl.dot.dir, -1), hw, true))
    return
  }
  const cs = cl.cubics
  if (cs.length === 0) return
  // In PATH order — cap, body, join, body, …, cap — so neighbours in the list
  // touch on the page. The union pairs neighbours; with every body first and
  // every join after, a closed square's four joins became one operand of
  // their own and paper.js's ring ∪ joins lost the outer contour.
  if (!cl.closed) {
    const t0 = cubicTangent(cs[0], 0)
    if (t0) capPiece(cs[0].p0, mul(t0, -1), stroke.cap, hw, out)
  }
  const joins = cl.closed ? cs.length : cs.length - 1
  for (let i = 0; i < cs.length; i++) {
    segmentPieces(cs[i], hw, tol, out, folded)
    if (i >= joins) continue
    const tin = cubicTangent(cs[i], 1)
    const b = cs[(i + 1) % cs.length]
    const tout = cubicTangent(b, 0)
    if (tin && tout) joinPiece(b.p0, tin, tout, stroke, hw, out)
  }
  if (!cl.closed) {
    const t1 = cubicTangent(cs[cs.length - 1], 1)
    if (t1) capPiece(cs[cs.length - 1].p3, t1, stroke.cap, hw, out)
  }
}

/* -------------------------------------------------------------- segments */

const SAMPLES = 64

/** A segment's own pieces: its body between the two offsets. */
function segmentPieces(c: Cubic, hw: number, tol: number, out: Cubic[][], folded: Set<Cubic[]>): void {
  if (isStraight(c)) {
    const t = unit(sub(c.p3, c.p0))
    if (!t) return
    const n = mul(normal(t), hw)
    const a = add(c.p0, n)
    const b = add(c.p3, n)
    const d = sub(c.p3, n)
    const e = sub(c.p0, n)
    out.push([lineCubic(a, b), lineCubic(b, d), lineCubic(d, e), lineCubic(e, a)])
    return
  }
  // Which side (if any) folds: the inner side of a bend tighter than the half
  // width. Curvature is signed toward the normal.
  let foldsL = false
  let foldsR = false
  for (let k = 0; k <= SAMPLES; k++) {
    const t = k / SAMPLES
    const d1 = cubicD1(c, t)
    const l = len(d1)
    const kappa = l > 1e-12 ? cross(d1, cubicD2(c, t)) / (l * l * l) : Number.POSITIVE_INFINITY
    if (Math.abs(kappa) * hw < 1) continue
    if (kappa > 0) foldsL = true
    else foldsR = true
  }
  if (!foldsL && !foldsR) {
    out.push(bodyPiece(c, 0, 1, hw, tol, false, false))
    return
  }
  // A folding segment goes in short stretches. Each is a bow-tie at worst (its
  // inner edge crossing between its two end normals), which its own nonzero
  // fill gets right; the whole segment folded onto itself would not be — its
  // swallowtail can lie over its own body and cancel it.
  const cuts = [0]
  let acc = 0
  let prev = cubicTangent(c, 0)
  for (let k = 1; k <= SAMPLES; k++) {
    const t = k / SAMPLES
    const tt = cubicTangent(c, t)
    if (prev && tt) acc += (Math.atan2(Math.abs(cross(prev, tt)), dot(prev, tt)) * 180) / Math.PI
    prev = tt
    if (acc >= FOLD_DEG || k === SAMPLES) {
      // A bend that turns a lot within one sample step is cut finer still.
      const from = cuts[cuts.length - 1]
      const parts = Math.max(1, Math.ceil(acc / FOLD_DEG))
      for (let j = 1; j <= parts; j++) cuts.push(from + ((t - from) * j) / parts)
      acc = 0
    }
  }
  for (let i = 0; i + 1 < cuts.length; i++) {
    const chain = bodyPiece(c, cuts[i], cuts[i + 1], hw, tol, foldsL, foldsR)
    out.push(chain)
    folded.add(chain)
  }
}

/** The body of c over [t0, t1]: one offset forward, the end, the other back, the start. */
function bodyPiece(c: Cubic, t0: number, t1: number, hw: number, tol: number, polyL: boolean, polyR: boolean): Cubic[] {
  const side = (s: number, poly: boolean) =>
    poly ? offsetPolyline(c, t0, t1, s, hw) : offsetCurve(c, t0, t1, s, hw, tol)
  const left = side(1, polyL)
  const right = side(-1, polyR).map(reverse).reverse()
  const lEnd = left[left.length - 1].p3
  const rEnd = right[right.length - 1].p3
  return [...left, lineCubic(lEnd, right[0].p0), ...right, lineCubic(rEnd, left[0].p0)]
}

/** Offset points of c over [t0, t1] on one side, with the centre line's tangents. */
function offsetSamples(c: Cubic, t0: number, t1: number, side: number, hw: number) {
  const tan0 = cubicTangent(c, t0)
  // Enough samples that the fitter sees every wiggle: by turn and by length.
  let turn = 0
  let length = 0
  let prevT = tan0
  let prevP = cubicPoint(c, t0)
  for (let k = 1; k <= 16; k++) {
    const t = t0 + ((t1 - t0) * k) / 16
    const tt = cubicTangent(c, t)
    const p = cubicPoint(c, t)
    if (tt && prevT) turn += Math.atan2(Math.abs(cross(prevT, tt)), dot(prevT, tt))
    length += dist(prevP, p)
    prevT = tt
    prevP = p
  }
  const m = Math.min(160, Math.max(8, Math.ceil((turn * 180) / Math.PI / 2), Math.ceil(length / 4)))
  const pts: Vec[] = []
  const tangents: Vec[] = []
  for (let k = 0; k <= m; k++) {
    const t = t0 + ((t1 - t0) * k) / m
    const tt = cubicTangent(c, t) ?? tan0 ?? { x: 1, y: 0 }
    tangents.push(tt)
    pts.push(add(cubicPoint(c, t), mul(normal(tt), side * hw)))
  }
  return { pts, tangents }
}

/** One offset side of c over [t0, t1], fitted. */
function offsetCurve(c: Cubic, t0: number, t1: number, side: number, hw: number, tol: number): Cubic[] {
  const { pts, tangents } = offsetSamples(c, t0, t1, side, hw)
  return fitCubics(pts, 0, pts.length - 1, tangents[0], tangents[tangents.length - 1], tol, (i) => tangents[i])
}

/**
 * A folding side as a polyline of its exact offset points. It crosses itself
 * (the swallowtail), which no curve fit should try to follow; the piece is
 * resolved on its own before the union, and only the part of it that is the
 * stroke's real edge survives — fine enough that the weld pass smooths it.
 */
function offsetPolyline(c: Cubic, t0: number, t1: number, side: number, hw: number): Cubic[] {
  let turn = 0
  let prev = cubicTangent(c, t0)
  for (let k = 1; k <= 16; k++) {
    const tt = cubicTangent(c, t0 + ((t1 - t0) * k) / 16)
    if (tt && prev) turn += Math.atan2(Math.abs(cross(prev, tt)), dot(prev, tt))
    prev = tt
  }
  const m = Math.min(120, Math.max(4, Math.ceil((turn * 180) / Math.PI / 0.75)))
  const pts: Vec[] = []
  for (let k = 0; k <= m; k++) {
    const t = t0 + ((t1 - t0) * k) / m
    const tt = cubicTangent(c, t) ?? { x: 1, y: 0 }
    pts.push(add(cubicPoint(c, t), mul(normal(tt), side * hw)))
  }
  const out: Cubic[] = []
  for (let k = 0; k < m; k++) out.push(lineCubic(pts[k], pts[k + 1]))
  return out
}

/* -------------------------------------------------------- joins and caps */

/** Circular arc around `o` of radius r from angle a0 through `sweep` (radians), as cubics. */
function arc(o: Vec, r: number, a0: number, sweep: number): Cubic[] {
  const parts = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9))
  const step = sweep / parts
  const k = (4 / 3) * Math.tan(step / 4) * r
  const out: Cubic[] = []
  for (let i = 0; i < parts; i++) {
    const s = a0 + step * i
    const e = s + step
    const p0 = { x: o.x + r * Math.cos(s), y: o.y + r * Math.sin(s) }
    const p3 = { x: o.x + r * Math.cos(e), y: o.y + r * Math.sin(e) }
    out.push({
      p0,
      c1: { x: p0.x - k * Math.sin(s), y: p0.y + k * Math.cos(s) },
      c2: { x: p3.x + k * Math.sin(e), y: p3.y - k * Math.cos(e) },
      p3,
    })
  }
  return out
}

function circle(o: Vec, r: number): Cubic[] {
  const out = arc(o, r, 0, 2 * Math.PI)
  out[out.length - 1].p3 = out[0].p0
  return out
}

/** Closed polygon through the points (duplicates dropped). */
function polygon(points: Vec[]): Cubic[] {
  const pts = points.filter((p, i) => dist(p, points[(i + points.length - 1) % points.length]) > POINT)
  return pts.map((p, i) => lineCubic(p, pts[(i + 1) % pts.length]))
}

/** The join at node v, on the outside of the turn from tin to tout. */
function joinPiece(v: Vec, tin: Vec, tout: Vec, stroke: Stroke, hw: number, out: Cubic[][]): void {
  const cr = cross(tin, tout)
  const dt = dot(tin, tout)
  const turn = Math.atan2(Math.abs(cr), dt)
  if (turn < 1e-6) return
  if (Math.abs(cr) < 1e-12) {
    // Doubling straight back: only a round join paints the turn.
    if (stroke.join === 'round') out.push(circle(v, hw))
    return
  }
  // The outside of the turn is the side the path turns away from.
  const side = cr > 0 ? -1 : 1
  const n1 = mul(normal(tin), side)
  const n2 = mul(normal(tout), side)
  const o1 = add(v, mul(n1, hw))
  const o2 = add(v, mul(n2, hw))
  if (stroke.join === 'round') {
    const a0 = Math.atan2(n1.y, n1.x)
    // The offset normal turns with the tangent.
    const sweep = cr > 0 ? turn : -turn
    const rim = arc(v, hw, a0, sweep)
    rim[0].p0 = o1
    rim[rim.length - 1].p3 = o2
    out.push([lineCubic(v, o1), ...rim, lineCubic(o2, v)])
    return
  }
  if (stroke.join === 'miter') {
    // Miter length / stroke width = 1 / sin(θ/2), θ the angle between the segments.
    const theta = Math.PI - turn
    const ratio = 1 / Math.sin(theta / 2)
    if (ratio <= (stroke.miterLimit ?? 4)) {
      const bis = unit(add(n1, n2))
      if (bis) {
        const tip = add(v, mul(bis, hw / Math.cos(turn / 2)))
        out.push(polygon([v, o1, tip, o2]))
        return
      }
    }
  }
  out.push(polygon([v, o1, o2]))
}

/** A cap at end point p, reaching out along unit direction d. */
function capPiece(p: Vec, d: Vec, cap: Stroke['cap'], hw: number, out: Cubic[][]): void {
  if (cap === 'butt') return
  if (cap === 'square') {
    out.push(squareCap(p, d, hw, false))
    return
  }
  const n = normal(d)
  const a = add(p, mul(n, hw))
  const b = sub(p, mul(n, hw))
  // From +n round through d to −n: a half turn the short way past d.
  const a0 = Math.atan2(n.y, n.x)
  const rim = arc(p, hw, a0, -Math.PI)
  rim[0].p0 = a
  rim[rim.length - 1].p3 = b
  out.push([...rim, lineCubic(b, a)])
}

/** A square cap: half a width beyond p along d (`whole` = a dot's square, both ways). */
function squareCap(p: Vec, d: Vec, hw: number, whole: boolean): Cubic[] {
  const n = mul(normal(d), hw)
  const fwd = mul(d, hw)
  const back = whole ? mul(d, -hw) : { x: 0, y: 0 }
  return polygon([add(add(p, n), back), add(add(p, n), fwd), add(sub(p, n), fwd), add(sub(p, n), back)])
}

/* ------------------------------------------------------------------ area */

/** Signed area of a closed cubic chain (positive = counter-clockwise in a y-up frame). */
export function chainArea(chain: readonly Cubic[]): number {
  let a = 0
  for (const c of chain) {
    if (isStraight(c)) {
      a += cross(c.p0, c.p3)
      continue
    }
    let prev = c.p0
    for (let k = 1; k <= 16; k++) {
      const p = cubicPoint(c, k / 16)
      a += cross(prev, p)
      prev = p
    }
  }
  return a / 2
}
