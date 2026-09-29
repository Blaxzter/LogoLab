// Pure rasterizer: EditableDoc → RGBA pixels, with no DOM, so scores are
// identical in node and the browser.
//
// Flattens each cubic subpath to a polygon, scanline-fills with the item's
// winding rule (analytic horizontal coverage, 4× vertical supersampling),
// evaluates the paint per pixel and composites bottom-to-top over an opaque
// background. Supports the paint the tracer emits: flat fills and
// linear/radial gradients with optional focal point and per-stop opacity.

import type {
  EditableDoc,
  GradientFill,
  GradientStop,
  LinearGradient,
  PathItem,
  RadialGradient,
  SubPath,
  Vec,
} from '../path/types'
import { segmentControls } from '../path/geometry.ts'

/** Vertical supersampling factor (sub-scanlines per pixel row). */
const SS = 4

/** Bézier flattening tolerance (px): max chord deviation before subdividing. */
const FLATNESS = 0.2

export interface RasterOptions {
  /** Opaque background composited under everything, default white. */
  background?: [number, number, number]
  /**
   * Output pixels per user unit (default 1). Below 1 renders smaller than the
   * viewBox, which keeps scoring a large trace cheap (compositing is O(w·h) per
   * path); above 1 renders larger, e.g. for a cleaned SVG with a 24-unit viewBox.
   *
   * The flattening tolerance is divided by it, so chord error stays FLATNESS in
   * output pixels. Otherwise an upscaled small viewBox renders as a visible
   * polygon.
   */
  scale?: number
}

/**
 * Rasterize a document to an RGBA buffer of `width`×`height` over an opaque
 * background. Geometry is read in viewBox coordinates: output pixel (px,py)
 * samples user-space (viewBox.minX + (px + 0.5)/scale, viewBox.minY + (py + 0.5)/scale).
 */
export function rasterizeDoc(
  doc: EditableDoc,
  width: number,
  height: number,
  opts: RasterOptions = {},
): Uint8ClampedArray {
  const [vbx, vby] = doc.viewBox
  const bg = opts.background ?? [255, 255, 255]
  const scale = opts.scale ?? 1
  // Straight-alpha float accumulator, initialized to the opaque background.
  const R = new Float64Array(width * height).fill(bg[0])
  const G = new Float64Array(width * height).fill(bg[1])
  const B = new Float64Array(width * height).fill(bg[2])

  const cov = new Float64Array(width * height)
  for (const item of doc.items) {
    if (item.kind !== 'path' || !item.visible) continue
    // The fill, unless the path is stroke-only (`fill: 'none'` — a centreline trace, or
    // an outline drawn in the editor). parseHex would read 'none' as black.
    if (item.fill !== 'none') {
      cov.fill(0)
      const polys = flattenItem(item, vbx, vby, scale)
      fillCoverage(polys, item.fillRule, width, height, cov)
      const paint = item.gradient ? makeGradientPaint(item.gradient, vbx, vby, scale) : makeSolidPaint(item.fill)
      compositeCoverage(paint, item.fillOpacity ?? 1, width, height, cov, R, G, B)
    }
    // The stroke, painted over the fill as SVG does. Its coverage is the nonzero union of
    // the outline polygons `strokePolygons` builds, so overlaps at joins never double-count.
    const s = item.stroke
    if (s && s.width > 0) {
      cov.fill(0)
      fillCoverage(strokePolygons(item, vbx, vby, scale), 'nonzero', width, height, cov)
      compositeCoverage(makeSolidPaint(s.color), s.opacity ?? 1, width, height, cov, R, G, B)
    }
  }

  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    out[o] = R[i]
    out[o + 1] = G[i]
    out[o + 2] = B[i]
    out[o + 3] = 255
  }
  return out
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** Flatten every subpath of an item to closed polygons, offset+scaled into pixel space. */
export function flattenItem(item: PathItem, vbx: number, vby: number, scale = 1): Vec[][] {
  const polys: Vec[][] = []
  // Tolerance in USER units that yields FLATNESS px of chord error after scaling.
  const tol = FLATNESS / (scale || 1)
  for (const sp of item.subPaths) {
    if (sp.nodes.length < 2) continue
    const poly = flattenSubPath(sp, tol)
    if (poly.length >= 2) {
      for (const p of poly) {
        p.x = (p.x - vbx) * scale
        p.y = (p.y - vby) * scale
      }
      polys.push(poly)
    }
  }
  return polys
}

// ---------------------------------------------------------------------------
// Stroke outlining
// ---------------------------------------------------------------------------

/**
 * The polygons whose NONZERO union is the area a stroke paints: one quad per flattened
 * segment, a join polygon at every interior vertex (and every vertex of a closed
 * subpath), and a cap at each end of an open one. Every polygon is oriented the same
 * way, so wherever they overlap — at every join, and along a curve where consecutive
 * quads splay — the winding adds rather than cancelling to a hole.
 *
 * Joins: `round` is a disc; `bevel` the triangle across the outer corner; `miter` that
 * triangle extended to the miter point unless the SVG default miter limit (4) is
 * exceeded, where SVG itself falls back to bevel. Caps: `round` a disc, `square` a
 * half-width extension, `butt` nothing. Dashes are not modelled (the tracer never emits
 * them); a dashed stroke renders solid.
 */
function strokePolygons(item: PathItem, vbx: number, vby: number, scale: number): Vec[][] {
  const s = item.stroke!
  const hw = (s.width * scale) / 2
  const tol = FLATNESS / (scale || 1)
  const polys: Vec[][] = []
  const push = (poly: Vec[]): void => {
    if (poly.length >= 3) polys.push(ccw(poly))
  }
  const disc = (c: Vec): Vec[] => {
    // Chord error hw·(1−cos(π/n)) stays under ~0.05px for any stroke width, and the
    // area under 1.5% of the true disc's (an octagon on a 4 px cap was 10% short).
    const n = Math.max(12, Math.min(96, Math.ceil(hw * 4)))
    const out: Vec[] = []
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 2 * Math.PI
      out.push({ x: c.x + hw * Math.cos(a), y: c.y + hw * Math.sin(a) })
    }
    return out
  }
  for (const sp of item.subPaths) {
    if (sp.nodes.length < 2) continue
    const raw = flattenSubPath(sp, tol)
    const pts: Vec[] = []
    for (const p of raw) {
      const q = { x: (p.x - vbx) * scale, y: (p.y - vby) * scale }
      const last = pts[pts.length - 1]
      if (!last || Math.hypot(q.x - last.x, q.y - last.y) > 1e-9) pts.push(q)
    }
    // A closed subpath's flattening repeats its first point; drop it so the vertex list
    // is a ring, and the closing segment is added below.
    if (
      sp.closed &&
      pts.length > 1 &&
      Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9
    )
      pts.pop()
    const n = pts.length
    if (n < 2) {
      // A single point: only a round or square cap paints anything (SVG draws a dot).
      if (n === 1 && s.cap === 'round') push(disc(pts[0]))
      if (n === 1 && s.cap === 'square')
        push([
          { x: pts[0].x - hw, y: pts[0].y - hw },
          { x: pts[0].x + hw, y: pts[0].y - hw },
          { x: pts[0].x + hw, y: pts[0].y + hw },
          { x: pts[0].x - hw, y: pts[0].y + hw },
        ])
      continue
    }
    const segs = sp.closed ? n : n - 1
    const normal = (a: Vec, b: Vec): Vec => {
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      return { x: (-dy / len) * hw, y: (dx / len) * hw }
    }
    for (let i = 0; i < segs; i++) {
      const a = pts[i]
      const b = pts[(i + 1) % n]
      const nn = normal(a, b)
      push([
        { x: a.x + nn.x, y: a.y + nn.y },
        { x: b.x + nn.x, y: b.y + nn.y },
        { x: b.x - nn.x, y: b.y - nn.y },
        { x: a.x - nn.x, y: a.y - nn.y },
      ])
    }
    // Joins.
    const first = sp.closed ? 0 : 1
    const last = sp.closed ? n - 1 : n - 2
    for (let i = first; i <= last; i++) {
      const v = pts[i]
      const p = pts[(i - 1 + n) % n]
      const q = pts[(i + 1) % n]
      if (s.join === 'round') {
        push(disc(v))
        continue
      }
      const n1 = normal(p, v)
      const n2 = normal(v, q)
      // The outer side is where the two offset lines diverge: the side the turn is away from.
      const cross = (v.x - p.x) * (q.y - v.y) - (v.y - p.y) * (q.x - v.x)
      const sgn = cross > 0 ? -1 : 1
      const o1 = { x: v.x + sgn * n1.x, y: v.y + sgn * n1.y }
      const o2 = { x: v.x + sgn * n2.x, y: v.y + sgn * n2.y }
      if (s.join === 'miter') {
        // Miter length / stroke width = 1 / sin(θ/2) with θ the angle between the segments.
        const d1 = { x: v.x - p.x, y: v.y - p.y }
        const d2 = { x: q.x - v.x, y: q.y - v.y }
        const l1 = Math.hypot(d1.x, d1.y) || 1
        const l2 = Math.hypot(d2.x, d2.y) || 1
        const cosT = (d1.x * d2.x + d1.y * d2.y) / (l1 * l2)
        const theta = Math.acos(Math.max(-1, Math.min(1, cosT))) // turn angle
        const halfInner = (Math.PI - theta) / 2
        const ratio = halfInner > 1e-6 ? 1 / Math.sin(halfInner) : Infinity
        if (ratio <= 4) {
          // Miter point along the bisector of the outer normals.
          const bx = o1.x + o2.x - 2 * v.x
          const by = o1.y + o2.y - 2 * v.y
          const bl = Math.hypot(bx, by) || 1
          const m = { x: v.x + (bx / bl) * ratio * hw, y: v.y + (by / bl) * ratio * hw }
          push([v, o1, m, o2])
          continue
        }
      }
      push([v, o1, o2]) // bevel (and the miter fallback)
    }
    // Caps.
    if (!sp.closed) {
      for (const [end, prev] of [
        [pts[0], pts[1]],
        [pts[n - 1], pts[n - 2]],
      ] as [Vec, Vec][]) {
        if (s.cap === 'round') push(disc(end))
        else if (s.cap === 'square') {
          const dx = end.x - prev.x
          const dy = end.y - prev.y
          const len = Math.hypot(dx, dy) || 1
          const t = { x: (dx / len) * hw, y: (dy / len) * hw }
          const nn = { x: -t.y, y: t.x }
          push([
            { x: end.x + nn.x, y: end.y + nn.y },
            { x: end.x + nn.x + t.x, y: end.y + nn.y + t.y },
            { x: end.x - nn.x + t.x, y: end.y - nn.y + t.y },
            { x: end.x - nn.x, y: end.y - nn.y },
          ])
        }
      }
    }
  }
  return polys
}

/** The polygon with a non-negative signed area (one consistent winding for the union). */
function ccw(poly: Vec[]): Vec[] {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    area += a.x * b.y - b.x * a.y
  }
  return area < 0 ? poly.slice().reverse() : poly
}

/** Flatten one subpath (closed implied) to a polyline of points. */
function flattenSubPath(sp: SubPath, tol: number): Vec[] {
  const pts: Vec[] = []
  const segCount = sp.closed ? sp.nodes.length : sp.nodes.length - 1
  pts.push({ x: sp.nodes[0].x, y: sp.nodes[0].y })
  for (let seg = 0; seg < segCount; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    flattenCubic(p0, c1, c2, p3, pts, 0, tol)
  }
  return pts
}

/** Recursive de Casteljau subdivision until the segment is flat enough. */
function flattenCubic(p0: Vec, c1: Vec, c2: Vec, p3: Vec, out: Vec[], depth: number, tol: number): void {
  // Flatness: max distance of the control points from the chord p0→p3.
  const d1 = pointLineDist(c1, p0, p3)
  const d2 = pointLineDist(c2, p0, p3)
  if (depth >= 16 || (d1 <= tol && d2 <= tol)) {
    out.push({ x: p3.x, y: p3.y })
    return
  }
  const p01 = mid(p0, c1)
  const p12 = mid(c1, c2)
  const p23 = mid(c2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const m = mid(p012, p123)
  flattenCubic(p0, p01, p012, m, out, depth + 1, tol)
  flattenCubic(m, p123, p23, p3, out, depth + 1, tol)
}

const mid = (a: Vec, b: Vec): Vec => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

function pointLineDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}

// ---------------------------------------------------------------------------
// Scanline coverage
// ---------------------------------------------------------------------------

interface Edge {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Build the edge list of a polygon set (wrap each polygon closed). */
function buildEdges(polys: Vec[][]): Edge[] {
  const edges: Edge[] = []
  for (const poly of polys) {
    const n = poly.length
    for (let i = 0; i < n; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % n]
      if (a.y === b.y) continue // horizontal edges never cross a scanline
      edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y })
    }
  }
  return edges
}

/**
 * Accumulate fractional coverage (0–1) of the compound path into `cov`, using
 * the given winding rule. Vertical AA is 4× supersampled; horizontal coverage
 * within each sub-scanline is computed analytically at span boundaries.
 */
function fillCoverage(
  polys: Vec[][],
  fillRule: 'nonzero' | 'evenodd',
  width: number,
  height: number,
  cov: Float64Array,
): void {
  const edges = buildEdges(polys)
  if (edges.length === 0) return
  const w = 1 / SS
  const xs: number[] = []
  const dirs: number[] = []

  for (let row = 0; row < height; row++) {
    for (let s = 0; s < SS; s++) {
      const Y = row + (s + 0.5) / SS
      xs.length = 0
      dirs.length = 0
      for (const e of edges) {
        const below0 = e.y0 <= Y
        const below1 = e.y1 <= Y
        if (below0 === below1) continue
        const t = (Y - e.y0) / (e.y1 - e.y0)
        xs.push(e.x0 + (e.x1 - e.x0) * t)
        dirs.push(e.y1 > e.y0 ? 1 : -1)
      }
      if (xs.length < 2) continue
      // Sort crossings (and their directions) by x.
      const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b])
      let wind = 0
      const rowBase = row * width
      for (let k = 0; k < order.length - 1; k++) {
        wind += dirs[order[k]]
        const inside = fillRule === 'evenodd' ? k % 2 === 0 : wind !== 0
        if (!inside) continue
        addSpan(cov, rowBase, xs[order[k]], xs[order[k + 1]], width, w)
      }
    }
  }
}

/** Add `weight` of horizontal coverage over [xa, xb] into one scanline row. */
function addSpan(
  cov: Float64Array,
  rowBase: number,
  xaRaw: number,
  xbRaw: number,
  width: number,
  weight: number,
): void {
  let xa = xaRaw
  let xb = xbRaw
  if (xb <= xa) return
  if (xa < 0) xa = 0
  if (xb > width) xb = width
  if (xb <= xa) return
  const ixa = Math.floor(xa)
  const ixb = Math.floor(xb)
  if (ixa === ixb) {
    cov[rowBase + ixa] += weight * (xb - xa)
    return
  }
  cov[rowBase + ixa] += weight * (ixa + 1 - xa)
  for (let px = ixa + 1; px < ixb; px++) cov[rowBase + px] += weight
  if (ixb < width) cov[rowBase + ixb] += weight * (xb - ixb)
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

/** Composite one paint through a coverage buffer (a fill's or a stroke's) onto the accumulator. */
function compositeCoverage(
  paint: Paint,
  opacity: number,
  width: number,
  height: number,
  cov: Float64Array,
  R: Float64Array,
  G: Float64Array,
  B: Float64Array,
): void {
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = py * width + px
      const c = cov[i]
      if (c <= 0) continue
      const col = paint(px + 0.5, py + 0.5)
      const a = Math.min(1, c) * opacity * col[3]
      if (a <= 0) continue
      const ia = 1 - a
      R[i] = col[0] * a + R[i] * ia
      G[i] = col[1] * a + G[i] * ia
      B[i] = col[2] * a + B[i] * ia
    }
  }
}

/** A paint samples an (x,y) in pixel space to an [r,g,b,a] (0–255 rgb, 0–1 a). */
type Paint = (x: number, y: number) => [number, number, number, number]

function makeSolidPaint(hex: string): Paint {
  const [r, g, b] = parseHex(hex)
  return () => [r, g, b, 1]
}

function makeGradientPaint(g: GradientFill, vbx: number, vby: number, scale: number): Paint {
  return g.type === 'linear' ? makeLinearPaint(g, vbx, vby, scale) : makeRadialPaint(g, vbx, vby, scale)
}

function makeLinearPaint(g: LinearGradient, vbx: number, vby: number, scale: number): Paint {
  // Gradient coords are user-space; convert to the same pixel space as samples.
  // `scale` is a similarity, so a ramp maps through it unchanged in shape.
  const x1 = (g.x1 - vbx) * scale
  const y1 = (g.y1 - vby) * scale
  const dx = (g.x2 - g.x1) * scale
  const dy = (g.y2 - g.y1) * scale
  const len2 = dx * dx + dy * dy || 1
  const stops = prepStops(g.stops)
  return (x, y) => {
    let t = ((x - x1) * dx + (y - y1) * dy) / len2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    return sampleStops(stops, t)
  }
}

function makeRadialPaint(g: RadialGradient, vbx: number, vby: number, scale: number): Paint {
  const cx = (g.cx - vbx) * scale
  const cy = (g.cy - vby) * scale
  const r = (g.r || 1) * scale
  const fx = ((g.fx ?? g.cx) - vbx) * scale
  const fy = ((g.fy ?? g.cy) - vby) * scale
  const stops = prepStops(g.stops)
  const focal = Math.hypot(fx - cx, fy - cy) > 1e-6
  return (x, y) => {
    let t: number
    if (!focal) {
      t = Math.hypot(x - cx, y - cy) / r
    } else {
      t = focalOffset(x, y, cx, cy, r, fx, fy)
    }
    if (t < 0) t = 0
    else if (t > 1) t = 1
    return sampleStops(stops, t)
  }
}

/**
 * SVG radial-gradient offset for a focal point F inside the circle (C, r):
 * the largest ω with P on the circle centered F+ω(C−F) of radius ω·r. Solves
 * the resulting quadratic and returns the geometrically valid (largest) root.
 */
function focalOffset(x: number, y: number, cx: number, cy: number, r: number, fx: number, fy: number): number {
  const cfx = cx - fx
  const cfy = cy - fy
  const pfx = x - fx
  const pfy = y - fy
  const A = cfx * cfx + cfy * cfy - r * r
  const Bc = -2 * (pfx * cfx + pfy * cfy)
  const C0 = pfx * pfx + pfy * pfy
  if (Math.abs(A) < 1e-9) {
    // Focal on the circle (rare); fall back to a linear ramp along the ray.
    return Math.abs(Bc) < 1e-9 ? 0 : C0 / -Bc
  }
  const disc = Bc * Bc - 4 * A * C0
  if (disc < 0) return 1
  const sq = Math.sqrt(disc)
  const r1 = (-Bc + sq) / (2 * A)
  const r2 = (-Bc - sq) / (2 * A)
  // P sits at gradient offset ω where ω is the larger non-negative root.
  const big = Math.max(r1, r2)
  const small = Math.min(r1, r2)
  if (big >= 0) return big
  return small >= 0 ? small : 1
}

interface PreppedStop {
  offset: number
  r: number
  g: number
  b: number
  a: number
}

function prepStops(stops: GradientStop[]): PreppedStop[] {
  const list = stops.map((s) => {
    const [r, g, b] = parseHex(s.color)
    return { offset: s.offset, r, g, b, a: s.opacity ?? 1 }
  })
  if (list.length === 0) return [{ offset: 0, r: 0, g: 0, b: 0, a: 1 }]
  // SVG requires non-decreasing offsets; enforce it so interpolation is sane.
  list.sort((p, q) => p.offset - q.offset)
  return list
}

function sampleStops(stops: PreppedStop[], t: number): [number, number, number, number] {
  if (t <= stops[0].offset) return [stops[0].r, stops[0].g, stops[0].b, stops[0].a]
  const last = stops[stops.length - 1]
  if (t >= last.offset) return [last.r, last.g, last.b, last.a]
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i]
    const b = stops[i + 1]
    if (t >= a.offset && t <= b.offset) {
      const span = b.offset - a.offset || 1
      const k = (t - a.offset) / span
      return [a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k, a.a + (b.a - a.a) * k]
    }
  }
  return [last.r, last.g, last.b, last.a]
}

/** Parse #rgb / #rrggbb to [r,g,b] (0–255). Unknown input → black. */
export function parseHex(hex: string): [number, number, number] {
  const h = hex.trim()
  if (h.length === 7 && h[0] === '#') {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
  }
  if (h.length === 4 && h[0] === '#') {
    const r = parseInt(h[1], 16)
    const g = parseInt(h[2], 16)
    const b = parseInt(h[3], 16)
    return [r * 17, g * 17, b * 17]
  }
  return [0, 0, 0]
}

// ---------------------------------------------------------------------------
// Boundary mask (for the seam metric)
// ---------------------------------------------------------------------------

/**
 * A 0/1 mask of pixels lying on (and within `dilate` px of) any traced path
 * boundary, where the seam metric looks for cracks and patch seams.
 */
export function boundaryMask(doc: EditableDoc, width: number, height: number, dilate = 1, scale = 1): Uint8Array {
  const [vbx, vby] = doc.viewBox
  const mask = new Uint8Array(width * height)
  for (const item of doc.items) {
    if (item.kind !== 'path' || !item.visible) continue
    // Same `scale` the render used, or the mask marks the wrong pixels. A stroke's
    // boundary is its outline, not its centreline.
    const polys = item.fill !== 'none' ? flattenItem(item, vbx, vby, scale) : []
    if (item.stroke && item.stroke.width > 0) polys.push(...strokePolygons(item, vbx, vby, scale))
    for (const poly of polys) {
      const n = poly.length
      for (let i = 0; i < n; i++) {
        const a = poly[i]
        const b = poly[(i + 1) % n]
        drawLine(mask, width, height, a.x, a.y, b.x, b.y)
      }
    }
  }
  if (dilate > 0) return dilateMask(mask, width, height, dilate)
  return mask
}

/** Mark the pixels under a line segment (DDA). */
function drawLine(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const dx = x1 - x0
  const dy = y1 - y0
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))))
  for (let i = 0; i <= steps; i++) {
    const x = Math.floor(x0 + (dx * i) / steps)
    const y = Math.floor(y0 + (dy * i) / steps)
    if (x >= 0 && x < width && y >= 0 && y < height) mask[y * width + x] = 1
  }
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let cur = mask
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!cur[y * width + x]) continue
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) next[ny * width + nx] = 1
          }
        }
      }
    }
    cur = next
  }
  return cur
}
