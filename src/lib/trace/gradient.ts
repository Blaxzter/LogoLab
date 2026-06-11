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

/** Solve the symmetric 2×2 system [[a,b],[b,c]]·x = (u,v); null if singular. */
function solveSym2(a: number, b: number, c: number, u: number, v: number): [number, number] | null {
  const det = a * c - b * b
  if (Math.abs(det) < 1e-9) return null
  return [(c * u - b * v) / det, (a * v - b * u) / det]
}

interface LinearFit {
  gradient: LinearGradient
  residual: number
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

  // Project pixels onto the axis to find the ramp extent and the RMS residual.
  let tmin = Infinity
  let tmax = -Infinity
  let sq = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i] - mx
    const y = ys[i] - my
    const t = x * ux + y * uy
    if (t < tmin) tmin = t
    if (t > tmax) tmax = t
    const er = rs[i] - (mr + ar * x + br * y)
    const eg = gs[i] - (mg + ag * x + bg * y)
    const eb = bs[i] - (mb + ab * x + bb * y)
    sq += er * er + eg * eg + eb * eb
  }
  if (!(tmax - tmin > 1e-6)) return null
  const residual = Math.sqrt(sq / n)

  // Channel rate along the axis, and the stop colors at each extreme.
  const slopeR = ar * ux + br * uy
  const slopeG = ag * ux + bg * uy
  const slopeB = ab * ux + bb * uy
  const stop0: GradientStop = {
    offset: 0,
    color: channelsToHex(mr + slopeR * tmin, mg + slopeG * tmin, mb + slopeB * tmin),
  }
  const stop1: GradientStop = {
    offset: 1,
    color: channelsToHex(mr + slopeR * tmax, mg + slopeG * tmax, mb + slopeB * tmax),
  }

  const gradient: LinearGradient = {
    type: 'linear',
    x1: mx + ux * tmin,
    y1: my + uy * tmin,
    x2: mx + ux * tmax,
    y2: my + uy * tmax,
    stops: [stop0, stop1],
  }
  return { gradient, residual }
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
    let Sd = 0
    let Sdd = 0
    let maxD = 0
    let Sr = 0
    let Sg = 0
    let Sb = 0
    let Sdr = 0
    let Sdg = 0
    let Sdb = 0
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(samples.xs[i] - cx, samples.ys[i] - cy)
      if (d > maxD) maxD = d
      Sd += d
      Sdd += d * d
      Sr += rs[i]
      Sg += gs[i]
      Sb += bs[i]
      Sdr += d * rs[i]
      Sdg += d * gs[i]
      Sdb += d * bs[i]
    }
    if (maxD < 1e-6) return null
    const denom = n * Sdd - Sd * Sd
    if (Math.abs(denom) < 1e-9) return null
    const fitChannel = (Sc: number, Sdc: number): [number, number] => {
      const m = (n * Sdc - Sd * Sc) / denom
      const k = (Sc - m * Sd) / n
      return [k, m] // intercept (at d=0), slope per unit distance
    }
    const [kr, mr_] = fitChannel(Sr, Sdr)
    const [kg, mg_] = fitChannel(Sg, Sdg)
    const [kb, mb_] = fitChannel(Sb, Sdb)

    let sq = 0
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(samples.xs[i] - cx, samples.ys[i] - cy)
      const er = rs[i] - (kr + mr_ * d)
      const eg = gs[i] - (kg + mg_ * d)
      const eb = bs[i] - (kb + mb_ * d)
      sq += er * er + eg * eg + eb * eb
    }
    const residual = Math.sqrt(sq / n)
    const gradient: RadialGradient = {
      type: 'radial',
      cx,
      cy,
      r: maxD,
      stops: [
        { offset: 0, color: channelsToHex(kr, kg, kb) },
        { offset: 1, color: channelsToHex(kr + mr_ * maxD, kg + mg_ * maxD, kb + mb_ * maxD) },
      ],
    }
    return { gradient, residual }
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
