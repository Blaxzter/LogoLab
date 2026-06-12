// Per-region gradient fitting: given the source pixels that fall inside one
// traced region, decide whether they read better as a SOLID color, a LINEAR
// ramp, or a RADIAL ramp, and (for the gradient cases) recover an SVG
// linear/radial gradient in viewBox coordinates.
//
// This is the piece that fixes "every gradient is just meh": potrace only ever
// emits flat fills, so a smooth ramp gets posterized into hard color bands.
// Here we look back at the ORIGINAL pixel colors of each region and fit a real
// gradient, emitting a standard SVG <linearGradient>/<radialGradient> instead.
//
// The math is small, closed-form linear algebra (least-squares plane fit per
// channel + structure-tensor axis for linear; 1-D radius regression over a few
// candidate centers for radial) — milliseconds for a 1024² logo, no model, no
// GPU. Pure and deterministic: no DOM, no imports with runtime side effects, so
// it runs unchanged in the browser and under `node --test`.

import type { GradientFill, GradientStop, LinearGradient, RadialGradient } from '../path/types'
import { srgbToOklab, oklabDeltaE } from './oklab.ts'

/** Tunables for the solid-vs-gradient decision. */
export interface GradientFitOptions {
  /** Fewer sampled pixels than this ⇒ never fit a gradient (too noisy). */
  minSamples: number
  /**
   * Solid RMS color error (0–441 RGB units) below this ⇒ the region is flat
   * enough; keep it solid regardless of how a gradient scores.
   */
  flatResidual: number
  /** A gradient must cut the solid residual to at most this fraction of it. */
  improveFraction: number
  /** …and its own residual must stay under this ceiling to be trusted. */
  maxGradResidual: number
}

export const DEFAULT_GRADIENT_FIT: GradientFitOptions = {
  minSamples: 48,
  flatResidual: 6,
  improveFraction: 0.7,
  maxGradResidual: 34,
}

/** Diagnostics + chosen fill from a region fit (handy for tests / tuning). */
export interface FitResult {
  kind: 'solid' | 'linear' | 'radial'
  /** Mean color of the region (the representative solid). */
  solid: [number, number, number]
  solidResidual: number
  linearResidual: number
  radialResidual: number
  /** The fitted gradient when kind !== 'solid', else null. */
  gradient: GradientFill | null
}

/** Flat sample columns for a region (parallel arrays, length `n`). */
export interface RegionSamples {
  xs: Float64Array
  ys: Float64Array
  rs: Float64Array
  gs: Float64Array
  bs: Float64Array
  n: number
}

/** Concatenate several regions' samples into one (for group refitting). */
export function concatSamples(list: RegionSamples[]): RegionSamples {
  let n = 0
  for (const s of list) n += s.n
  const xs = new Float64Array(n)
  const ys = new Float64Array(n)
  const rs = new Float64Array(n)
  const gs = new Float64Array(n)
  const bs = new Float64Array(n)
  let k = 0
  for (const s of list) {
    for (let i = 0; i < s.n; i++) {
      xs[k] = s.xs[i]
      ys[k] = s.ys[i]
      rs[k] = s.rs[i]
      gs[k] = s.gs[i]
      bs[k] = s.bs[i]
      k++
    }
  }
  return { xs, ys, rs, gs, bs, n }
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)

const hex2 = (n: number): string => {
  const s = Math.round(clamp255(n)).toString(16)
  return s.length < 2 ? '0' + s : s
}

/** Three 0–255 channels → '#rrggbb'. */
export function channelsToHex(r: number, g: number, b: number): string {
  return '#' + hex2(r) + hex2(g) + hex2(b)
}

const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

// ---------------------------------------------------------------------------
// Multi-stop emission: build the 1-D colour profile along a gradient parameter
// and place stops at the knots of its piecewise-linear approximation.
//
// The old fitter emitted exactly two stops (the colours at the axis extremes),
// so an eased or hue-rotating ramp — where the colour does NOT vary linearly
// along the axis — was reproduced as a straight 2-stop ramp and read wrong. Here
// we bin the actual colours along the parameter t∈[0,1], then RDP-simplify that
// profile with an Oklab-ΔE tolerance: a pure linear ramp collapses back to two
// stops, while a curved profile keeps the intermediate knots it needs. The doc
// model already supports N stops; only the fitter was the bottleneck.
// ---------------------------------------------------------------------------

/** Bin count for the 1-D colour profile sampled along a gradient parameter. */
const PROFILE_BINS = 24
/** Oklab ΔE below which a profile knot is redundant (multi-stop RDP tolerance). */
const STOP_OKLAB_TOL = 0.012

interface ProfilePt {
  t: number
  r: number
  g: number
  b: number
}

/** Mean colour per non-empty bin of t∈[0,1]; endpoints pinned to 0 and 1. */
function binnedProfile(param: Float64Array, rs: Float64Array, gs: Float64Array, bs: Float64Array, n: number): ProfilePt[] {
  const sr = new Float64Array(PROFILE_BINS)
  const sg = new Float64Array(PROFILE_BINS)
  const sb = new Float64Array(PROFILE_BINS)
  const cnt = new Float64Array(PROFILE_BINS)
  for (let i = 0; i < n; i++) {
    let bin = Math.floor(param[i] * PROFILE_BINS)
    if (bin < 0) bin = 0
    else if (bin >= PROFILE_BINS) bin = PROFILE_BINS - 1
    sr[bin] += rs[i]
    sg[bin] += gs[i]
    sb[bin] += bs[i]
    cnt[bin]++
  }
  const pts: ProfilePt[] = []
  for (let bi = 0; bi < PROFILE_BINS; bi++) {
    if (cnt[bi] === 0) continue
    pts.push({ t: (bi + 0.5) / PROFILE_BINS, r: sr[bi] / cnt[bi], g: sg[bi] / cnt[bi], b: sb[bi] / cnt[bi] })
  }
  if (pts.length > 0) {
    pts[0].t = 0
    pts[pts.length - 1].t = 1
  }
  return pts
}

/** Oklab ΔE of a profile point from the sRGB-interpolated chord a→b at its t. */
function profileDeviation(p: ProfilePt, a: ProfilePt, b: ProfilePt): number {
  const span = b.t - a.t || 1
  const k = (p.t - a.t) / span
  const ir = a.r + (b.r - a.r) * k
  const ig = a.g + (b.g - a.g) * k
  const ib = a.b + (b.b - a.b) * k
  return oklabDeltaE(srgbToOklab(p.r, p.g, p.b), srgbToOklab(ir, ig, ib))
}

/** RDP-simplify a colour profile (deviation measured in Oklab ΔE). */
function rdpProfile(pts: ProfilePt[], tol: number): ProfilePt[] {
  if (pts.length <= 2) return pts
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    let maxD = -1
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = profileDeviation(pts[i], pts[lo], pts[hi])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > tol && idx >= 0) {
      keep[idx] = 1
      stack.push([lo, idx], [idx, hi])
    }
  }
  const out: ProfilePt[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** Stops from a per-sample parameter array (binned profile → Oklab RDP). */
function stopsAlong(param: Float64Array, rs: Float64Array, gs: Float64Array, bs: Float64Array, n: number): GradientStop[] {
  const profile = rdpProfile(binnedProfile(param, rs, gs, bs, n), STOP_OKLAB_TOL)
  if (profile.length < 2) {
    const c = profile[0] ?? { r: 0, g: 0, b: 0 }
    return [
      { offset: 0, color: channelsToHex(c.r, c.g, c.b) },
      { offset: 1, color: channelsToHex(c.r, c.g, c.b) },
    ]
  }
  return profile.map((p) => ({ offset: clamp01(p.t), color: channelsToHex(p.r, p.g, p.b) }))
}

/** Interpolate a stop list at parameter t∈[0,1] (sRGB, SVG-pad behaviour). */
function interpStops(stops: GradientStop[], t: number): [number, number, number] {
  let a = stops[0]
  let b = stops[stops.length - 1]
  if (t <= a.offset) return hexToRgb3(a.color)
  if (t >= b.offset) return hexToRgb3(b.color)
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i].offset && t <= stops[i + 1].offset) {
      a = stops[i]
      b = stops[i + 1]
      break
    }
  }
  const span = b.offset - a.offset || 1
  const k = (t - a.offset) / span
  const ca = hexToRgb3(a.color)
  const cb = hexToRgb3(b.color)
  return [ca[0] + (cb[0] - ca[0]) * k, ca[1] + (cb[1] - ca[1]) * k, ca[2] + (cb[2] - ca[2]) * k]
}

const hexToRgb3 = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/** Evaluate any fitted gradient's colour at point (x, y), in pixel space. */
export function sampleGradient(g: GradientFill, x: number, y: number): [number, number, number] {
  if (g.type === 'linear') {
    const dx = g.x2 - g.x1
    const dy = g.y2 - g.y1
    const len2 = dx * dx + dy * dy || 1
    const t = clamp01(((x - g.x1) * dx + (y - g.y1) * dy) / len2)
    return interpStops(g.stops, t)
  }
  const fx = g.fx ?? g.cx
  const fy = g.fy ?? g.cy
  // Plain distance parameterization (centred); focal handled by the renderer.
  void fx
  void fy
  const t = clamp01(Math.hypot(x - g.cx, y - g.cy) / (g.r || 1))
  return interpStops(g.stops, t)
}

/** RMS RGB error of a gradient model over the samples. */
function modelResidualRgb(g: GradientFill, s: RegionSamples): number {
  let sq = 0
  for (let i = 0; i < s.n; i++) {
    const [pr, pg, pb] = sampleGradient(g, s.xs[i], s.ys[i])
    const dr = s.rs[i] - pr
    const dg = s.gs[i] - pg
    const db = s.bs[i] - pb
    sq += dr * dr + dg * dg + db * db
  }
  return Math.sqrt(sq / s.n)
}

/** RMS Oklab ΔE of a gradient model over the samples (perceptual fit quality). */
export function modelResidualOklab(g: GradientFill, s: RegionSamples): number {
  let sq = 0
  for (let i = 0; i < s.n; i++) {
    const [pr, pg, pb] = sampleGradient(g, s.xs[i], s.ys[i])
    const d = oklabDeltaE(srgbToOklab(s.rs[i], s.gs[i], s.bs[i]), srgbToOklab(pr, pg, pb))
    sq += d * d
  }
  return Math.sqrt(sq / s.n)
}

/**
 * Fit the best paint for a region's sampled pixels. Coordinates of the returned
 * gradient are in the SAME space as the input `xs`/`ys` (the tracing pipeline
 * works in pixel == viewBox space, so no rescaling is needed).
 */
export function fitRegionFill(
  s: RegionSamples,
  opts: GradientFitOptions = DEFAULT_GRADIENT_FIT,
): FitResult {
  const { xs, ys, rs, gs, bs, n } = s

  // --- solid (mean) ---------------------------------------------------------
  let mr = 0
  let mg = 0
  let mb = 0
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mr += rs[i]
    mg += gs[i]
    mb += bs[i]
    mx += xs[i]
    my += ys[i]
  }
  mr /= n
  mg /= n
  mb /= n
  mx /= n
  my /= n

  let solidSq = 0
  for (let i = 0; i < n; i++) {
    const dr = rs[i] - mr
    const dg = gs[i] - mg
    const db = bs[i] - mb
    solidSq += dr * dr + dg * dg + db * db
  }
  const solidResidual = Math.sqrt(solidSq / n)
  const solid: [number, number, number] = [mr, mg, mb]

  const result: FitResult = {
    kind: 'solid',
    solid,
    solidResidual,
    linearResidual: Infinity,
    radialResidual: Infinity,
    gradient: null,
  }

  if (n < opts.minSamples) return result

  const linear = fitLinear(s, mx, my, mr, mg, mb)
  if (linear) result.linearResidual = linear.residual

  const radial = fitRadial(s, mx, my)
  if (radial) result.radialResidual = radial.residual

  // --- model selection ------------------------------------------------------
  // Only graduate to a gradient when the region is genuinely non-flat AND the
  // ramp explains it markedly better than a single color.
  if (solidResidual >= opts.flatResidual) {
    let best: { residual: number; gradient: GradientFill; kind: 'linear' | 'radial' } | null = null
    if (linear) best = { residual: linear.residual, gradient: linear.gradient, kind: 'linear' }
    if (radial && radial.residual < (best?.residual ?? Infinity)) {
      best = { residual: radial.residual, gradient: radial.gradient, kind: 'radial' }
    }
    if (
      best &&
      best.residual <= opts.maxGradResidual &&
      best.residual <= solidResidual * opts.improveFraction
    ) {
      result.kind = best.kind
      result.gradient = best.gradient
    }
  }

  return result
}

/**
 * Fit the best gradient model (linear or radial, multi-stop) to a region's
 * samples, ranked by Oklab ΔE. Used by the union-refit merge to decide whether a
 * SINGLE gradient explains the combined samples of several regions. Unlike
 * fitRegionFill it does NOT gate on solid-vs-gradient improvement — it returns the
 * best gradient and how well it fits perceptually, and the caller applies the ΔE
 * threshold.
 */
export function fitBestGradient(s: RegionSamples): { gradient: GradientFill; oklabResidual: number } | null {
  const { xs, ys, rs, gs, bs, n } = s
  if (n < 2) return null
  let mr = 0
  let mg = 0
  let mb = 0
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mr += rs[i]
    mg += gs[i]
    mb += bs[i]
    mx += xs[i]
    my += ys[i]
  }
  mr /= n
  mg /= n
  mb /= n
  mx /= n
  my /= n

  let best: { gradient: GradientFill; oklabResidual: number } | null = null
  const lin = fitLinear(s, mx, my, mr, mg, mb)
  if (lin) best = { gradient: lin.gradient, oklabResidual: modelResidualOklab(lin.gradient, s) }
  const rad = fitRadial(s, mx, my)
  if (rad) {
    const o = modelResidualOklab(rad.gradient, s)
    if (!best || o < best.oklabResidual) best = { gradient: rad.gradient, oklabResidual: o }
  }
  return best
}

// ---------------------------------------------------------------------------
// Stage 2 — paint-model ladder (plan §3.2 / paper §3.3): per macro-region, pick
// the cheapest model under an MDL score (Oklab error + λ·complexity) from
// solid → linear-multistop → radial-multistop, with the §3.2.2 rank-2 early-out.
// Fits run on the segmenter's SMOOTH (AA-free) samples, so a plain mean already
// approximates the paper's boundary-distance-weighted constant.
// ---------------------------------------------------------------------------

export interface PaintLadderOptions {
  /** Below this many samples a region is always solid (too little to fit). */
  minSamples: number
  /** Solid Oklab residual below this ⇒ flat; never graduate to a gradient. */
  flatResidual: number
  /** A gradient must fit under this Oklab residual to be chosen (else solid). */
  maxModelResidual: number
  /** MDL complexity weight λ: cost = residual + λ·(#params). */
  mdlLambda: number
  /** Structure-tensor anisotropy λ₂/λ₁ above which linear is doomed → prefer radial. */
  anisotropy2D: number
}

export const DEFAULT_PAINT_LADDER: PaintLadderOptions = {
  minSamples: 48,
  flatResidual: 0.02,
  maxModelResidual: 0.14,
  // λ is in Oklab-ΔE units per parameter: ~0.0015 ≈ 0.15 CIE76 ΔE per stop, enough
  // to prefer the simpler model on a near-tie but never to overrule a real fit.
  mdlLambda: 0.0015,
  anisotropy2D: 0.12,
}

export interface PaintLadderResult {
  model: 'solid' | 'linear' | 'radial'
  /** The chosen gradient, or null when the region is solid. */
  gradient: GradientFill | null
  /** Mean colour (the solid representative / swatch). */
  solid: [number, number, number]
  /** Oklab RMS residual of the chosen model. */
  residualOklab: number
  /** Diagnostics (per-model Oklab residuals + 2-D-ness) for tuning/tests. */
  debug?: { solidRes: number; linearRes: number; radialRes: number; anisotropy: number }
}

/** RMS Oklab ΔE of a constant colour over the samples. */
function solidResidualOklab(s: RegionSamples, mr: number, mg: number, mb: number): number {
  const mean = srgbToOklab(mr, mg, mb)
  let sq = 0
  for (let i = 0; i < s.n; i++) {
    const d = oklabDeltaE(srgbToOklab(s.rs[i], s.gs[i], s.bs[i]), mean)
    sq += d * d
  }
  return Math.sqrt(sq / s.n)
}

/**
 * Fit the cheapest adequate paint model for a macro-region's samples (Stage 2).
 * Selection is MDL: cost = Oklab residual + λ·#params, minimised over
 * {solid, linear, radial}; linear is excluded when the structure tensor says the
 * field is genuinely 2-D (the rank-2 early-out) so a deceptively-low 1-D fit can't
 * win over the radial a glow actually needs. A gradient is taken only if it fits
 * under `maxModelResidual`; otherwise the region stays solid (the §3.4 fallback).
 */
export function fitPaintLadder(s: RegionSamples, opts: PaintLadderOptions = DEFAULT_PAINT_LADDER): PaintLadderResult {
  const { rs, gs, bs, xs, ys, n } = s
  let mr = 0
  let mg = 0
  let mb = 0
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) {
    mr += rs[i]; mg += gs[i]; mb += bs[i]; mx += xs[i]; my += ys[i]
  }
  if (n > 0) { mr /= n; mg /= n; mb /= n; mx /= n; my /= n }
  const solid: [number, number, number] = [mr, mg, mb]
  const solidRes = n > 0 ? solidResidualOklab(s, mr, mg, mb) : 0

  if (n < opts.minSamples || solidRes < opts.flatResidual) {
    return { model: 'solid', gradient: null, solid, residualOklab: solidRes, debug: { solidRes, linearRes: Infinity, radialRes: Infinity, anisotropy: 0 } }
  }

  const linear = fitLinear(s, mx, my, mr, mg, mb)
  const radial = fitRadial(s, mx, my)
  const anisotropy = linear ? linear.anisotropy : 0
  const linRes = linear ? modelResidualOklab(linear.gradient, s) : Infinity
  const radRes = radial ? modelResidualOklab(radial.gradient, s) : Infinity
  const debug = { solidRes, linearRes: linRes, radialRes: radRes, anisotropy }

  type Cand = { model: 'solid' | 'linear' | 'radial'; gradient: GradientFill | null; res: number; complexity: number }
  const cands: Cand[] = [{ model: 'solid', gradient: null, res: solidRes, complexity: 1 }]

  if (linear && linRes <= opts.maxModelResidual) {
    cands.push({ model: 'linear', gradient: linear.gradient, res: linRes, complexity: linear.gradient.stops.length })
  }
  if (radial && radRes <= opts.maxModelResidual) {
    // §3.2.2 rank-2 signal: on a genuinely 2-D field (high anisotropy) the radial
    // is the structurally-right model, so waive its extra centre-parameter cost so
    // it wins a near-tie over linear. This is a SOFT preference — it never discards
    // a markedly-better-fitting linear (a hard linear-drop was measured to force a
    // worse SOLID on a linearly-shaded petal). On a 1-D field the radial pays the
    // +1 and the lower-residual linear wins on merit.
    const twoD = anisotropy > opts.anisotropy2D
    cands.push({ model: 'radial', gradient: radial.gradient, res: radRes, complexity: radial.gradient.stops.length + (twoD ? 0 : 1) })
  }

  // MDL: cost = Oklab residual + λ·#params, with λ sized so complexity only breaks
  // near-ties (it must never let a flat colour beat a markedly-better gradient).
  let best = cands[0]
  let bestCost = best.res + opts.mdlLambda * best.complexity
  for (let i = 1; i < cands.length; i++) {
    const cost = cands[i].res + opts.mdlLambda * cands[i].complexity
    if (cost < bestCost) {
      best = cands[i]
      bestCost = cost
    }
  }
  return { model: best.model, gradient: best.gradient, solid, residualOklab: best.res, debug }
}

/** Solve the symmetric 2×2 system [[a,b],[b,c]]·x = (u,v); null if singular. */
function solveSym2(a: number, b: number, c: number, u: number, v: number): [number, number] | null {
  const det = a * c - b * b
  if (Math.abs(det) < 1e-9) return null
  return [(c * u - b * v) / det, (a * v - b * u) / det]
}

interface LinearFit {
  gradient: LinearGradient
  residual: number
  /**
   * Structure-tensor anisotropy λ₂/λ₁ ∈ [0,1]: 0 = a perfectly 1-D ramp (the
   * three channel gradients share one direction), →1 = a genuinely 2-D colour
   * field (channels ramp in different directions — nebula's glow). The §3.2.2
   * rank-2 early-out reads this to skip a doomed linear fit and prefer radial.
   */
  anisotropy: number
}

/**
 * Least-squares plane fit per channel (centered coords, so the intercept is the
 * channel mean), then the structure tensor of the three channel gradients gives
 * the dominant ramp axis. Stops are the fitted colors at the axis extremes.
 */
function fitLinear(
  s: RegionSamples,
  mx: number,
  my: number,
  mr: number,
  mg: number,
  mb: number,
): LinearFit | null {
  const { xs, ys, rs, gs, bs, n } = s

  let Sxx = 0
  let Sxy = 0
  let Syy = 0
  let Sxr = 0
  let Syr = 0
  let Sxg = 0
  let Syg = 0
  let Sxb = 0
  let Syb = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx
    const y = ys[i] - my
    Sxx += x * x
    Sxy += x * y
    Syy += y * y
    Sxr += x * rs[i]
    Syr += y * rs[i]
    Sxg += x * gs[i]
    Syg += y * gs[i]
    Sxb += x * bs[i]
    Syb += y * bs[i]
  }

  const cr = solveSym2(Sxx, Sxy, Syy, Sxr, Syr)
  const cg = solveSym2(Sxx, Sxy, Syy, Sxg, Syg)
  const cb = solveSym2(Sxx, Sxy, Syy, Sxb, Syb)
  if (!cr || !cg || !cb) return null
  const [ar, br] = cr
  const [ag, bg] = cg
  const [ab, bb] = cb

  // Structure tensor T = Σ_channel grad·gradᵀ; dominant eigenvector = axis.
  const Txx = ar * ar + ag * ag + ab * ab
  const Txy = ar * br + ag * bg + ab * bb
  const Tyy = br * br + bg * bg + bb * bb
  if (Txx + Tyy < 1e-12) return null
  const [ux, uy] = dominantEigenvector(Txx, Txy, Tyy)
  // Eigenvalues of T = squared singular values of the 3×2 channel Jacobian; their
  // ratio is the field's 2-D-ness (rank-2 early-out, §3.2.2).
  const half = (Txx + Tyy) / 2
  const disc = Math.hypot((Txx - Tyy) / 2, Txy)
  const lam1 = half + disc
  const lam2 = half - disc
  const anisotropy = lam1 > 1e-12 ? Math.max(0, lam2) / lam1 : 0

  // Project pixels onto the axis to find the ramp extent.
  let tmin = Infinity
  let tmax = -Infinity
  for (let i = 0; i < n; i++) {
    const t = (xs[i] - mx) * ux + (ys[i] - my) * uy
    if (t < tmin) tmin = t
    if (t > tmax) tmax = t
  }
  if (!(tmax - tmin > 1e-6)) return null

  // Per-sample normalized position along the axis, then multi-stop emission from
  // the binned colour profile (captures eased / hue-rotating ramps a 2-stop fit
  // flattens). The RMS residual is measured against the emitted stop model.
  const span = tmax - tmin
  const param = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    param[i] = ((xs[i] - mx) * ux + (ys[i] - my) * uy - tmin) / span
  }
  const stops = stopsAlong(param, rs, gs, bs, n)

  const gradient: LinearGradient = {
    type: 'linear',
    x1: mx + ux * tmin,
    y1: my + uy * tmin,
    x2: mx + ux * tmax,
    y2: my + uy * tmax,
    stops,
  }
  return { gradient, residual: modelResidualRgb(gradient, s), anisotropy }
}

/** Unit dominant eigenvector of the symmetric 2×2 [[a,b],[b,c]]. */
function dominantEigenvector(a: number, b: number, c: number): [number, number] {
  if (Math.abs(b) < 1e-12) return a >= c ? [1, 0] : [0, 1]
  const lambda = (a + c) / 2 + Math.hypot((a - c) / 2, b)
  const vx = b
  const vy = lambda - a
  const len = Math.hypot(vx, vy)
  if (len < 1e-12) return [1, 0]
  return [vx / len, vy / len]
}

interface RadialFit {
  gradient: RadialGradient
  residual: number
}

/**
 * Try a handful of candidate centers (centroid, bbox center, the extreme-luma
 * pixels), fit color as a 1-D linear function of distance-from-center at each,
 * and keep the best. A linear ramp is the limit of a radial whose center is far
 * away, so this also catches near-linear cases — model selection picks whichever
 * residual is lower.
 */
function fitRadial(s: RegionSamples, mx: number, my: number): RadialFit | null {
  const { xs, ys, rs, gs, bs, n } = s

  let minLuma = Infinity
  let maxLuma = -Infinity
  let loX = mx
  let loY = my
  let hiX = mx
  let hiY = my
  let bbMinX = Infinity
  let bbMinY = Infinity
  let bbMaxX = -Infinity
  let bbMaxY = -Infinity
  for (let i = 0; i < n; i++) {
    const L = luma(rs[i], gs[i], bs[i])
    if (L < minLuma) {
      minLuma = L
      loX = xs[i]
      loY = ys[i]
    }
    if (L > maxLuma) {
      maxLuma = L
      hiX = xs[i]
      hiY = ys[i]
    }
    if (xs[i] < bbMinX) bbMinX = xs[i]
    if (xs[i] > bbMaxX) bbMaxX = xs[i]
    if (ys[i] < bbMinY) bbMinY = ys[i]
    if (ys[i] > bbMaxY) bbMaxY = ys[i]
  }

  const centers: [number, number][] = [
    [mx, my],
    [(bbMinX + bbMaxX) / 2, (bbMinY + bbMaxY) / 2],
    [loX, loY],
    [hiX, hiY],
  ]

  let best: RadialFit | null = null
  for (const [cx, cy] of centers) {
    const fit = fitRadialAt(s, cx, cy)
    if (fit && (!best || fit.residual < best.residual)) best = fit
  }
  return best

  function fitRadialAt(samples: RegionSamples, cx: number, cy: number): RadialFit | null {
    let maxD = 0
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(samples.xs[i] - cx, samples.ys[i] - cy)
      if (d > maxD) maxD = d
    }
    if (maxD < 1e-6) return null

    // Multi-stop emission along the radius profile (captures non-linear radial
    // ramps the old intercept+slope fit flattened). Residual vs the stop model.
    const param = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      param[i] = clamp01(Math.hypot(samples.xs[i] - cx, samples.ys[i] - cy) / maxD)
    }
    const stops = stopsAlong(param, rs, gs, bs, n)
    const gradient: RadialGradient = { type: 'radial', cx, cy, r: maxD, stops }
    return { gradient, residual: modelResidualRgb(gradient, samples) }
  }
}

// ---------------------------------------------------------------------------
// SVG emission (shared by the editor renderer and the serializer)
// ---------------------------------------------------------------------------

const fmt = (v: number, precision = 2): string => String(Number(v.toFixed(precision)))

function stopsMarkup(stops: GradientStop[]): string {
  let out = ''
  for (const st of stops) {
    out += `<stop offset="${fmt(st.offset, 4)}" stop-color="${st.color}"`
    if (st.opacity !== undefined && st.opacity < 1) out += ` stop-opacity="${fmt(st.opacity, 4)}"`
    out += '/>'
  }
  return out
}

/**
 * Serialize a gradient to its SVG paint-server element markup (the thing that
 * lives in <defs>), with the given id. userSpaceOnUse so the coordinates match
 * the path geometry directly.
 */
export function gradientToSvgDef(g: GradientFill, id: string, precision = 2): string {
  const p = (v: number) => fmt(v, precision)
  if (g.type === 'linear') {
    return (
      `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" ` +
      `x1="${p(g.x1)}" y1="${p(g.y1)}" x2="${p(g.x2)}" y2="${p(g.y2)}">` +
      stopsMarkup(g.stops) +
      '</linearGradient>'
    )
  }
  let attrs =
    `id="${id}" gradientUnits="userSpaceOnUse" ` +
    `cx="${p(g.cx)}" cy="${p(g.cy)}" r="${p(g.r)}"`
  if (g.fx !== undefined && g.fy !== undefined) attrs += ` fx="${p(g.fx)}" fy="${p(g.fy)}"`
  return `<radialGradient ${attrs}>${stopsMarkup(g.stops)}</radialGradient>`
}
