// The sub-pixel centreline and the stroke width, read from the anti-aliasing.
//
// A skeleton pixel says where the stroke's centre is to within a pixel. The raster says
// more: across the stroke, the ink COVERAGE rises from 0 to 1 and back, and the two
// iso-0.5 crossings of that profile are the stroke's edges to a fraction of a pixel —
// the same contour the outline tracer's sub-pixel pass places its edges on
// (planarSubpixel.ts), so a stroke traced as a centreline and the same stroke traced as
// an outline agree about where its edges are. The centre is the midpoint of the two
// crossings; the width is the coverage integral between them (plus a pixel of margin on
// each side), which is exact for a uniform stroke however its edges fall on the grid.
//
// A stroke too thin to reach 0.5 coverage anywhere (a hairline) has no crossings: its
// centre is then the coverage centroid and its width the integral over a small window —
// which is still the right width, e.g. 0.5 for a half-pixel line.

import type { Vec } from '../../path/types'
import type { SkelChain, SkeletonGraph } from './graph.ts'

/** Ink coverage per pixel, 0 (paper) … 1 (ink), from the mono cut's composited image. */
export interface CoverageField {
  width: number
  height: number
  cov: Float32Array
}

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b

/**
 * Build the coverage field. `image` is the source composited over the paper (mono.ts);
 * `labels`/`inkLabel` say which pixels the cut called ink. The ink and paper lumas are
 * read robustly from the two populations (5th / 95th percentiles), not from the label
 * means — the ink mean is dragged light by the anti-aliased pixels the cut includes.
 */
export function coverageField(
  image: { data: Uint8ClampedArray; width: number; height: number },
  labels: Int32Array,
  inkLabel: number,
): CoverageField {
  const { width, height, data } = image
  const n = width * height
  const L = new Float32Array(n)
  const inkH = new Uint32Array(256)
  const paperH = new Uint32Array(256)
  let nInk = 0
  let nPaper = 0
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const l = luma(data[p], data[p + 1], data[p + 2])
    L[i] = l
    const bin = Math.max(0, Math.min(255, Math.round(l)))
    if (labels[i] === inkLabel) {
      inkH[bin]++
      nInk++
    } else {
      paperH[bin]++
      nPaper++
    }
  }
  const percentile = (h: Uint32Array, total: number, q: number, fallback: number): number => {
    if (total === 0) return fallback
    const want = q * total
    let acc = 0
    for (let b = 0; b < 256; b++) {
      acc += h[b]
      if (acc >= want) return b
    }
    return 255
  }
  const paperL = percentile(paperH, nPaper, 0.5, 255)
  // Ink: the darkest 5% if the ink is darker than the paper, the lightest 5% otherwise.
  const inkDarker = percentile(inkH, nInk, 0.5, 0) < paperL
  const inkL = inkDarker ? percentile(inkH, nInk, 0.05, 0) : percentile(inkH, nInk, 0.95, 255)
  const span = paperL - inkL
  const cov = new Float32Array(n)
  if (Math.abs(span) < 1) return { width, height, cov }
  for (let i = 0; i < n; i++) {
    const c = (paperL - L[i]) / span
    cov[i] = c < 0 ? 0 : c > 1 ? 1 : c
  }
  return { width, height, cov }
}

/** Bilinear coverage at a point in pixel-corner coordinates (pixel (x,y)'s centre is x+0.5). */
export function covAt(f: CoverageField, x: number, y: number): number {
  const { width, height, cov } = f
  const fx = x - 0.5
  const fy = y - 0.5
  const x0 = Math.floor(fx)
  const y0 = Math.floor(fy)
  const tx = fx - x0
  const ty = fy - y0
  const at = (px: number, py: number): number =>
    px < 0 || py < 0 || px >= width || py >= height ? 0 : cov[py * width + px]
  const a = at(x0, y0)
  const b = at(x0 + 1, y0)
  const c = at(x0, y0 + 1)
  const d = at(x0 + 1, y0 + 1)
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty
}

/** A chain as a sub-pixel polyline with a width at every point. */
export interface Centreline {
  pts: Vec[]
  /** Stroke width (px) read at each point; NaN where the profile was unreadable. */
  w: Float32Array
  /** Distance transform at each skeleton pixel (px) — the inscribed radius there. */
  dtAt: Float32Array
  a: number
  b: number
  closed: boolean
  /** The chain this came from. */
  chain: SkelChain
}

const PROFILE_STEP = 0.25

/**
 * Read one profile across the stroke at `p` along unit normal `n`: the iso-0.5 edges,
 * the centre offset and the width. `rGuess` bounds the search (px).
 */
export function readProfile(
  f: CoverageField,
  p: Vec,
  n: Vec,
  rGuess: number,
): { offset: number; width: number; crossed: boolean; lopsided: boolean } {
  // The search reach: one half-width and a little. Measured wider (2.5 r + 3, to let
  // a point thinning drifted off-centre find its far edge) it made every case WORSE —
  // bell 0.48 → 0.88 px, star 0.88 → 1.57 — because at a concave corner or a crossing
  // the walk then runs far along the other arm before it finds paper, and reads a
  // centre and a width that belong to nothing. Capped at r + 2.5 the profile is
  // bounded by the stroke it is on.
  const R = Math.max(2, rGuess + 2.5)
  const sample = (s: number): number => covAt(f, p.x + s * n.x, p.y + s * n.y)
  const c0 = sample(0)
  let sPlus = NaN
  let sMinus = NaN
  if (c0 >= 0.5) {
    // Walk out on each side to the first 0.5 crossing.
    for (const dir of [1, -1]) {
      let prev = c0
      let s = 0
      let hit = NaN
      while (s < R) {
        const s2 = s + PROFILE_STEP
        const c = sample(dir * s2)
        if (c < 0.5) {
          hit = s + ((prev - 0.5) / (prev - c)) * PROFILE_STEP
          break
        }
        prev = c
        s = s2
      }
      if (dir > 0) sPlus = hit
      else sMinus = hit
    }
  }
  if (Number.isFinite(sPlus) && Number.isFinite(sMinus)) {
    // A profile far longer on one side than the other did not cross a stroke: it ran
    // along the ink of a concave corner or into a crossing arm. Thinning's drift at a
    // bend is a few px on a symmetric stroke; this is the other thing.
    const lopsided = Math.abs(sPlus - sMinus) > Math.min(sPlus, sMinus) + 2
    // Integrate over the edges plus a pixel of anti-aliasing on each side.
    const lo = -sMinus - 1
    const hi = sPlus + 1
    let sum = 0
    let mom = 0
    for (let s = lo; s <= hi; s += PROFILE_STEP) {
      const c = sample(s)
      sum += c
      mom += c * s
    }
    sum *= PROFILE_STEP
    mom *= PROFILE_STEP
    const offset = sum > 1e-6 ? mom / sum : (sPlus - sMinus) / 2
    return { offset, width: sum, crossed: true, lopsided }
  }
  // Hairline (or a point off the ink): centroid and integral over the search window.
  let sum = 0
  let mom = 0
  for (let s = -R; s <= R; s += PROFILE_STEP) {
    const c = sample(s)
    sum += c
    mom += c * s
  }
  sum *= PROFILE_STEP
  mom *= PROFILE_STEP
  return { offset: sum > 1e-6 ? mom / sum : 0, width: sum, crossed: false, lopsided: false }
}

/**
 * Turn a skeleton chain into a sub-pixel centreline. The tangent at each pixel is read
 * over a short window of the (box-smoothed) pixel centres; each point is then moved
 * along its normal to the profile centre, and the widths are median-filtered. Points
 * whose normal reaches into a junction (within `r` of a node) keep their skeleton
 * position and a NaN width — assemble.ts re-derives that stretch from the arm lines.
 */
export function refineChain(
  g: SkeletonGraph,
  c: SkelChain,
  f: CoverageField,
  dt: Float32Array,
  nodeRadius: (nodeId: number) => number,
): Centreline {
  const w = g.width
  const n = c.pixels.length
  const raw: Vec[] = c.pixels.map((p) => ({ x: (p % w) + 0.5, y: ((p / w) | 0) + 0.5 }))
  // Two passes of 3-tap box smoothing for the tangent estimate only.
  const sm = boxSmooth(raw, 2, c.closed)
  const pts: Vec[] = new Array(n)
  const width = new Float32Array(n)
  const dtAt = Float32Array.from(c.pixels, (p) => dt[p])
  const nearA = c.a >= 0 ? nodeRadius(c.a) : 0
  const nearB = c.b >= 0 ? nodeRadius(c.b) : 0
  const A = c.a >= 0 ? g.nodes[c.a] : null
  const B = c.b >= 0 ? g.nodes[c.b] : null
  for (let k = 0; k < n; k++) {
    const h = Math.min(3, c.closed ? n >> 1 : Math.min(k, n - 1 - k))
    const kp = c.closed ? (k - h + n) % n : k - h
    const kn = c.closed ? (k + h) % n : k + h
    let tx = sm[kn].x - sm[kp].x
    let ty = sm[kn].y - sm[kp].y
    const tl = Math.hypot(tx, ty)
    if (tl < 1e-6) {
      pts[k] = raw[k]
      width[k] = NaN
      continue
    }
    tx /= tl
    ty /= tl
    const nrm = { x: -ty, y: tx }
    const rGuess = Math.max(0.5, dt[c.pixels[k]] - 0.5)
    const inA = A ? Math.hypot(raw[k].x - A.x - 0.5, raw[k].y - A.y - 0.5) < nearA + 1 : false
    const inB = B ? Math.hypot(raw[k].x - B.x - 0.5, raw[k].y - B.y - 0.5) < nearB + 1 : false
    if (inA || inB) {
      pts[k] = sm[k]
      width[k] = NaN
      continue
    }
    const prof = readProfile(f, sm[k], nrm, rGuess)
    if (prof.lopsided) {
      // Not a stroke's profile (a concave corner, a crossing): keep the skeleton point
      // and read no width here.
      pts[k] = sm[k]
      width[k] = NaN
      continue
    }
    // A centre more than a radius off the skeleton is a profile that ran into a
    // neighbouring stroke; keep the skeleton point rather than jump.
    const off = Math.abs(prof.offset) <= rGuess + 1 ? prof.offset : 0
    pts[k] = { x: sm[k].x + off * nrm.x, y: sm[k].y + off * nrm.y }
    width[k] = prof.width
  }
  medianFilterInPlace(width, 5, c.closed)
  return { pts, w: width, dtAt, a: c.a, b: c.b, closed: c.closed, chain: c }
}

/** Box-smooth a polyline (3-tap, `passes` times), endpoints fixed unless closed. */
export function boxSmooth(pts: Vec[], passes: number, closed: boolean): Vec[] {
  let cur = pts.map((p) => ({ x: p.x, y: p.y }))
  const n = cur.length
  if (n < 3) return cur
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.map((p) => ({ x: p.x, y: p.y }))
    const lo = closed ? 0 : 1
    const hi = closed ? n : n - 1
    for (let k = lo; k < hi; k++) {
      const a = cur[(k - 1 + n) % n]
      const b = cur[(k + 1) % n]
      next[k] = { x: (a.x + cur[k].x + b.x) / 3, y: (a.y + cur[k].y + b.y) / 3 }
    }
    cur = next
  }
  return cur
}

/** Median filter over the finite entries of `v` in a window of `win` (odd), in place. */
function medianFilterInPlace(v: Float32Array, win: number, closed: boolean): void {
  const n = v.length
  const src = Float32Array.from(v)
  const h = win >> 1
  const buf: number[] = []
  for (let k = 0; k < n; k++) {
    if (!Number.isFinite(src[k])) continue
    buf.length = 0
    for (let d = -h; d <= h; d++) {
      const j = closed ? (k + d + n) % n : k + d
      if (j < 0 || j >= n) continue
      if (Number.isFinite(src[j])) buf.push(src[j])
    }
    if (buf.length === 0) continue
    buf.sort((a, b) => a - b)
    v[k] = buf[buf.length >> 1]
  }
}

/** Gaussian smoothing of positions along the chain (σ in points), endpoints fixed unless closed. */
export function gaussSmooth(pts: Vec[], sigma: number, closed: boolean): Vec[] {
  const n = pts.length
  if (n < 3 || sigma <= 0.01) return pts.map((p) => ({ x: p.x, y: p.y }))
  const h = Math.max(1, Math.ceil(3 * sigma))
  const k: number[] = []
  for (let d = -h; d <= h; d++) k.push(Math.exp(-(d * d) / (2 * sigma * sigma)))
  const out: Vec[] = new Array(n)
  const lo = closed ? 0 : 1
  const hi = closed ? n : n - 1
  if (!closed) {
    out[0] = { x: pts[0].x, y: pts[0].y }
    out[n - 1] = { x: pts[n - 1].x, y: pts[n - 1].y }
  }
  for (let i = lo; i < hi; i++) {
    let sx = 0
    let sy = 0
    let sw = 0
    for (let d = -h; d <= h; d++) {
      let j = i + d
      if (closed) j = ((j % n) + n) % n
      else if (j < 0 || j >= n) continue
      const wgt = k[d + h]
      sx += pts[j].x * wgt
      sy += pts[j].y * wgt
      sw += wgt
    }
    out[i] = { x: sx / sw, y: sy / sw }
  }
  return out
}
