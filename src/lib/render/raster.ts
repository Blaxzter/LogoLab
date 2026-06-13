// Pure rasterizer for EditableDoc → RGBA pixels, for the evaluation harness.
//
// We do NOT parse the serialized SVG and hand it to a browser/canvas: that would
// (a) need a DOM and (b) make headless `node --test` impossible. Instead we
// rasterize the doc model directly — flatten each cubic subpath to a polygon,
// scanline-fill the compound path with its winding rule (analytic horizontal
// coverage + 4× vertical supersampling for anti-aliasing), evaluate the solid /
// linear / radial paint per pixel, and composite the items bottom-to-top over an
// opaque background. The output is deterministic and identical in Node and the
// browser, so the scoreboard numbers from either side are directly comparable.
//
// Only the paint features the pipeline can emit are supported (flat fills,
// linear/radial gradients with optional focal point and per-stop opacity). That
// is exactly the subset the tracer produces, which is the point.

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
}

/**
 * Rasterize a document to an RGBA buffer of `width`×`height` over an opaque
 * background. Geometry is read in viewBox coordinates: output pixel (px,py)
 * samples user-space (viewBox.minX + px + 0.5, viewBox.minY + py + 0.5).
 */
export function rasterizeDoc(
  doc: EditableDoc,
  width: number,
  height: number,
  opts: RasterOptions = {},
): Uint8ClampedArray {
  const [vbx, vby] = doc.viewBox
  const bg = opts.background ?? [255, 255, 255]
  // Straight-alpha float accumulator, initialized to the opaque background.
  const R = new Float64Array(width * height).fill(bg[0])
  const G = new Float64Array(width * height).fill(bg[1])
  const B = new Float64Array(width * height).fill(bg[2])

  const cov = new Float64Array(width * height)
  for (const item of doc.items) {
    if (item.kind !== 'path' || !item.visible) continue
    cov.fill(0)
    const polys = flattenItem(item, vbx, vby)
    fillCoverage(polys, item.fillRule, width, height, cov)
    compositeItem(item, vbx, vby, width, height, cov, R, G, B)
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

/** Flatten every subpath of an item to closed polygons, offset into pixel space. */
export function flattenItem(item: PathItem, vbx: number, vby: number): Vec[][] {
  const polys: Vec[][] = []
  for (const sp of item.subPaths) {
    if (sp.nodes.length < 2) continue
    const poly = flattenSubPath(sp)
    if (poly.length >= 2) {
      for (const p of poly) {
        p.x -= vbx
        p.y -= vby
      }
      polys.push(poly)
    }
  }
  return polys
}

/** Flatten one subpath (closed implied) to a polyline of points. */
function flattenSubPath(sp: SubPath): Vec[] {
  const pts: Vec[] = []
  const segCount = sp.closed ? sp.nodes.length : sp.nodes.length - 1
  pts.push({ x: sp.nodes[0].x, y: sp.nodes[0].y })
  for (let seg = 0; seg < segCount; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    flattenCubic(p0, c1, c2, p3, pts, 0)
  }
  return pts
}

/** Recursive de Casteljau subdivision until the segment is flat enough. */
function flattenCubic(p0: Vec, c1: Vec, c2: Vec, p3: Vec, out: Vec[], depth: number): void {
  // Flatness: max distance of the control points from the chord p0→p3.
  const d1 = pointLineDist(c1, p0, p3)
  const d2 = pointLineDist(c2, p0, p3)
  if (depth >= 16 || (d1 <= FLATNESS && d2 <= FLATNESS)) {
    out.push({ x: p3.x, y: p3.y })
    return
  }
  const p01 = mid(p0, c1)
  const p12 = mid(c1, c2)
  const p23 = mid(c2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const m = mid(p012, p123)
  flattenCubic(p0, p01, p012, m, out, depth + 1)
  flattenCubic(m, p123, p23, p3, out, depth + 1)
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

function compositeItem(
  item: PathItem,
  vbx: number,
  vby: number,
  width: number,
  height: number,
  cov: Float64Array,
  R: Float64Array,
  G: Float64Array,
  B: Float64Array,
): void {
  const fillOpacity = item.fillOpacity ?? 1
  const paint = item.gradient ? makeGradientPaint(item.gradient, vbx, vby) : makeSolidPaint(item.fill)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const i = py * width + px
      const c = cov[i]
      if (c <= 0) continue
      const col = paint(px + 0.5, py + 0.5)
      const a = Math.min(1, c) * fillOpacity * col[3]
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

function makeGradientPaint(g: GradientFill, vbx: number, vby: number): Paint {
  return g.type === 'linear' ? makeLinearPaint(g, vbx, vby) : makeRadialPaint(g, vbx, vby)
}

function makeLinearPaint(g: LinearGradient, vbx: number, vby: number): Paint {
  // Gradient coords are user-space; convert to the same pixel space as samples.
  const x1 = g.x1 - vbx
  const y1 = g.y1 - vby
  const dx = g.x2 - g.x1
  const dy = g.y2 - g.y1
  const len2 = dx * dx + dy * dy || 1
  const stops = prepStops(g.stops)
  return (x, y) => {
    let t = ((x - x1) * dx + (y - y1) * dy) / len2
    if (t < 0) t = 0
    else if (t > 1) t = 1
    return sampleStops(stops, t)
  }
}

function makeRadialPaint(g: RadialGradient, vbx: number, vby: number): Paint {
  const cx = g.cx - vbx
  const cy = g.cy - vby
  const r = g.r || 1
  const fx = (g.fx ?? g.cx) - vbx
  const fy = (g.fy ?? g.cy) - vby
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
function focalOffset(
  x: number,
  y: number,
  cx: number,
  cy: number,
  r: number,
  fx: number,
  fy: number,
): number {
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
    return [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ]
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
 * boundary. The seam metric maxes render-vs-source ΔE over this mask — that is
 * where cracks (page bleeding through) and patch seams concentrate, and where a
 * mean-error metric would average them away.
 */
export function boundaryMask(
  doc: EditableDoc,
  width: number,
  height: number,
  dilate = 1,
): Uint8Array {
  const [vbx, vby] = doc.viewBox
  const mask = new Uint8Array(width * height)
  for (const item of doc.items) {
    if (item.kind !== 'path' || !item.visible) continue
    const polys = flattenItem(item, vbx, vby)
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
function drawLine(mask: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number): void {
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
