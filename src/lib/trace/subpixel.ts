// Sub-pixel contour tracer — the "crisp edges" alternative to potrace.
//
// potrace hard-thresholds each mask to black/white and traces the pixel-grid
// boundary, so anti-aliasing information is thrown away and a single global
// corner knob has to be both sharp on corners and smooth on curves. This tracer
// instead:
//   1. turns the mask into a CONTINUOUS coverage field (a small Gaussian melts
//      the staircase / lumpy noise into a smooth field),
//   2. extracts the iso=0.5 contour with MARCHING SQUARES, placing every vertex
//      at its true sub-pixel crossing,
//   3. simplifies each loop (Ramer–Douglas–Peucker), detects genuine CORNERS by
//      turn angle, and fits minimal cubic Béziers per smooth span with the
//      Schneider algorithm.
//
// The result is crisp, low-node curves with correct corners — and it is pure JS
// (no WASM, no GPL), so it also runs under `node --test`. Loops are emitted with
// consistent nesting and the path is filled even-odd, which renders holes
// correctly without caring about winding direction.

import type { SubPath, Vec } from '../path/types'
import { fitClosedLoop, type CurveFitOptions } from './curveFit.ts'
import { cubicAt, segmentControls, segmentCount } from '../path/geometry.ts'

export interface CrispOptions {
  /** Gaussian blur sigma (px) applied to the coverage field before contouring. */
  smooth: number
  /** Drop closed loops enclosing less area than this (despeckle). */
  turdsize: number
  /**
   * Curve-fit tolerance ε (px): the key-vertex Douglas–Peucker tolerance AND the
   * cubic-discard tolerance of the evidence-based fitter (curveFit, plan §4.2).
   * Fixed at the paper's 1.5 px.
   */
  keyEpsilon: number
}

const ISO = 0.5

/**
 * Trace a binary/coverage mask (opaque black shapes on opaque white, the same
 * input potrace takes) into sub-pixel cubic subpaths, in mask pixel space.
 */
export function traceMaskCrisp(mask: ImageData, opts: CrispOptions): SubPath[] {
  const { width, height } = mask
  const field = buildCoverage(mask, opts.smooth)
  const loops = marchingSquares(field, width, height)

  const fitOpts: CurveFitOptions = {
    epsilon: opts.keyEpsilon,
    lineCost: 3.9,
    cubicCost: 4,
  }
  const subPaths: SubPath[] = []
  for (const loop of loops) {
    if (Math.abs(signedArea(loop)) < opts.turdsize) continue
    // Fit the DENSE sub-pixel loop with the evidence-based key-vertex / soft-corner
    // / DP fitter (curveFit): it selects its own key vertices at ε and places C⁰
    // corners from competitive line/arc/wedge evidence instead of a turn-angle
    // threshold — preserving genuine sharp corners while staying low-node.
    const nodes = fitClosedLoop(loop, fitOpts)
    if (nodes && nodes.length >= 2) subPaths.push({ nodes, closed: true })
  }
  // Bleed boundaries that all-but-touch the image edge out to it. Marching
  // squares puts a full-bleed region's right/bottom boundary at ~w-0.5 / h-0.5
  // (out-of-bounds reads as outside), so the outer half of the last pixel row/
  // column goes uncovered and the page shows through as an edge seam. Snapping
  // near-border vertices to the exact edge makes the bottom layer truly full-bleed.
  for (const sp of subPaths) snapToImageEdge(sp, width, height)

  // Marching-squares walks adjacency in an arbitrary direction, so loop winding
  // is uncontrolled — fine for even-odd, but the pipeline now fills crisp output
  // with `nonzero` (it doesn't XOR near-coincident contours into hairline seams
  // the way even-odd does). Make winding consistent so holes still render as
  // holes: nested loops must alternate orientation.
  orientForNonzero(subPaths)
  return subPaths
}

/** Snap an anchor within EDGE_SNAP px of an image edge onto that exact edge. */
const EDGE_SNAP = 1.5
function snapToImageEdge(sp: SubPath, w: number, h: number): void {
  // Skip a subpath that lives entirely inside the snap band on an axis — snapping
  // it would collapse that dimension to zero and degenerate the shape. Only a
  // boundary the region actually spans across should be bled to the edge.
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const n of sp.nodes) {
    if (n.x < minX) minX = n.x
    if (n.x > maxX) maxX = n.x
    if (n.y < minY) minY = n.y
    if (n.y > maxY) maxY = n.y
  }
  const spanX = maxX - minX > 2 * EDGE_SNAP
  const spanY = maxY - minY > 2 * EDGE_SNAP

  for (const node of sp.nodes) {
    // Snap the anchor, then carry its handles by the same delta so the tangent
    // geometry is preserved (handles can sit farther than EDGE_SNAP from the
    // anchor; snapping them independently would bend the curve).
    let nx = node.x
    let ny = node.y
    if (spanX) {
      if (node.x < EDGE_SNAP) nx = 0
      else if (node.x > w - EDGE_SNAP) nx = w
    }
    if (spanY) {
      if (node.y < EDGE_SNAP) ny = 0
      else if (node.y > h - EDGE_SNAP) ny = h
    }
    const dx = nx - node.x
    const dy = ny - node.y
    if (dx === 0 && dy === 0) continue
    node.x = nx
    node.y = ny
    if (node.hIn) {
      node.hIn.x += dx
      node.hIn.y += dy
    }
    if (node.hOut) {
      node.hOut.x += dx
      node.hOut.y += dy
    }
  }
}

/**
 * Force nonzero-consistent winding: a loop nested inside an even number of other
 * loops (an outer boundary) is oriented one way, one nested inside an odd number
 * (a hole) the opposite way. Under the nonzero rule this paints outers and
 * subtracts holes, matching the even-odd intent without relying on traversal
 * order. O(loops²), and loop counts are tiny.
 */
export function orientForNonzero(subPaths: SubPath[]): void {
  // Nest-test and wind on the FLATTENED curve, not the anchor polygon: the
  // evidence-based fitter emits very low-node loops (a circle can be two
  // semicircle cubics → a 2-anchor loop), whose anchor polygon badly under-covers
  // the true region. Testing the anchor polygon then misclassifies a hole near a
  // coarse outer boundary as a fill → a catastrophic crack (page bleeds through).
  // Flattening makes containment + winding exact regardless of node count.
  const polys = subPaths.map(flattenLoop)
  if (subPaths.length < 2) {
    if (subPaths.length === 1 && polySignedArea(polys[0]) < 0) reverseSubPath(subPaths[0])
    return
  }
  for (let i = 0; i < subPaths.length; i++) {
    let depth = 0
    for (let j = 0; j < subPaths.length; j++) {
      if (j !== i && loopInside(polys[i], polys[j])) depth++
    }
    const wantPositive = depth % 2 === 0
    if (polySignedArea(polys[i]) > 0 !== wantPositive) reverseSubPath(subPaths[i])
  }
}

/** Flatten a closed subpath's cubic segments into a dense polygon. */
function flattenLoop(sp: SubPath, perSeg = 8): Vec[] {
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < perSeg; k++) pts.push(cubicAt(p0, c1, c2, p3, k / perSeg))
  }
  return pts
}

/**
 * Whether loop `inner` is nested inside loop `outer`, by a majority vote over
 * several sample points of `inner`'s flattened polygon. A single test point can
 * sit right on `outer`'s boundary and misclassify; the majority makes it robust.
 */
function loopInside(inner: Vec[], outer: Vec[]): boolean {
  const samples = Math.min(9, inner.length)
  let inside = 0
  let total = 0
  for (let s = 0; s < samples; s++) {
    const k = Math.floor((s * inner.length) / samples)
    total++
    if (pointInPolygon(inner[k], outer)) inside++
  }
  return inside * 2 > total
}

/** Signed area of a closed polygon (sign = winding direction). */
function polySignedArea(poly: Vec[]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Reverse a closed subpath's direction in place (swap each node's handles). */
function reverseSubPath(sp: SubPath): void {
  sp.nodes.reverse()
  for (const node of sp.nodes) {
    const h = node.hIn
    node.hIn = node.hOut
    node.hOut = h
  }
}

/** Even-odd ray-cast point-in-polygon test. */
function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

// ---------------------------------------------------------------------------
// Coverage field
// ---------------------------------------------------------------------------

/**
 * Inside (black, lum < 128) → 1, else 0, then a small separable Gaussian with
 * edge-clamp so full-bleed regions keep their value at the border. Marching
 * squares treats out-of-bounds as 0, which closes border-touching loops exactly
 * at the image edge.
 */
function buildCoverage(mask: ImageData, sigma: number): Float32Array {
  const { width: w, height: h, data } = mask
  const f = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]
    f[i] = lum < 128 ? 1 : 0
  }
  if (sigma <= 0.01) return f
  return gaussianBlur(f, w, h, sigma)
}

/** Separable Gaussian blur with clamped borders. */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  // Horizontal.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k))
        acc += src[y * w + xx] * kernel[k + radius]
      }
      tmp[y * w + x] = acc
    }
  }
  // Vertical.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k))
        acc += tmp[yy * w + x] * kernel[k + radius]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Marching squares → closed sub-pixel loops
// ---------------------------------------------------------------------------

/**
 * Extract iso=0.5 contours as closed polylines (sub-pixel vertices). Cells are
 * iterated over a one-cell-padded grid (out-of-bounds field = 0) so loops close
 * at the image border. Crossings are keyed by grid-edge identity, so segments
 * from adjacent cells share endpoints exactly and stitch into clean loops.
 */
function marchingSquares(field: Float32Array, w: number, h: number): Vec[][] {
  const F = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x]

  const pts = new Map<string, Vec>()
  // adjacency: edgeId -> connected edgeIds (degree ≤ 2 ⇒ pure loops)
  const adj = new Map<string, string[]>()

  const hKey = (x: number, y: number) => 'h:' + x + ':' + y
  const vKey = (x: number, y: number) => 'v:' + x + ':' + y

  // Lazily compute & cache a crossing point on a grid edge.
  const hPoint = (x: number, y: number): string => {
    const id = hKey(x, y)
    if (!pts.has(id)) {
      const a = F(x, y)
      const b = F(x + 1, y)
      const t = (ISO - a) / (b - a || 1e-12)
      pts.set(id, { x: x + clamp01(t), y })
    }
    return id
  }
  const vPoint = (x: number, y: number): string => {
    const id = vKey(x, y)
    if (!pts.has(id)) {
      const a = F(x, y)
      const b = F(x, y + 1)
      const t = (ISO - a) / (b - a || 1e-12)
      pts.set(id, { x, y: y + clamp01(t) })
    }
    return id
  }

  const link = (a: string, b: string) => {
    let la = adj.get(a)
    if (!la) adj.set(a, (la = []))
    let lb = adj.get(b)
    if (!lb) adj.set(b, (lb = []))
    la.push(b)
    lb.push(a)
  }

  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = F(x, y) >= ISO
      const tr = F(x + 1, y) >= ISO
      const bl = F(x, y + 1) >= ISO
      const br = F(x + 1, y + 1) >= ISO
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
      if (code === 0 || code === 15) continue

      // Edges of this cell.
      const T = () => hPoint(x, y)
      const B = () => hPoint(x, y + 1)
      const L = () => vPoint(x, y)
      const R = () => vPoint(x + 1, y)

      switch (code) {
        case 1: link(L(), B()); break
        case 2: link(B(), R()); break
        case 3: link(L(), R()); break
        case 4: link(T(), R()); break
        case 6: link(T(), B()); break
        case 7: link(L(), T()); break
        case 8: link(T(), L()); break
        case 9: link(T(), B()); break
        case 11: link(T(), R()); break
        case 12: link(L(), R()); break
        case 13: link(B(), R()); break
        case 14: link(L(), B()); break
        case 5: {
          // Saddle: TR+BL inside. Resolve by cell average.
          const avg = (F(x, y) + F(x + 1, y) + F(x, y + 1) + F(x + 1, y + 1)) / 4
          if (avg >= ISO) {
            link(L(), T()); link(B(), R())
          } else {
            link(T(), R()); link(L(), B())
          }
          break
        }
        case 10: {
          // Saddle: TL+BR inside.
          const avg = (F(x, y) + F(x + 1, y) + F(x, y + 1) + F(x + 1, y + 1)) / 4
          if (avg >= ISO) {
            link(T(), R()); link(L(), B())
          } else {
            link(L(), T()); link(B(), R())
          }
          break
        }
      }
    }
  }

  // Stitch loops by walking the degree-2 adjacency.
  const visited = new Set<string>()
  const loops: Vec[][] = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const loop: Vec[] = []
    let prev = ''
    let cur = start
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      loop.push(pts.get(cur)!)
      const neighbors = adj.get(cur) ?? []
      const next = neighbors.find((n) => n !== prev && !visited.has(n))
      prev = cur
      cur = next ?? ''
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** Signed area of a closed polyline (shoelace). */
function signedArea(p: Vec[]): number {
  let a = 0
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n]
    a += p[i].x * q.y - q.x * p[i].y
  }
  return a / 2
}
