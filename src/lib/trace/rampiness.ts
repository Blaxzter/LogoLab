// Rampiness probe: a cheap pre-trace heuristic for whether an image contains
// smooth colour ramps or is flat-colour art. It seeds the default of the
// `gradients` toggle (the user can always override it).
//
// The primary signal is local colour slope, not a histogram: a histogram's peak
// count is inflated by anti-aliasing, slope is not. For each pixel the max
// per-channel step to a neighbour BASELINE px right/down is bucketed:
//
//   < RAMP_MIN               flat interior
//   RAMP_MIN .. EDGE_DELTA   ramp step (gentle, ongoing variation)
//   >= EDGE_DELTA            hard edge (shape boundary), excluded
//
// The baseline is wider than one pixel because a gentle gradient (< 1 level/px)
// rounds to a 0–1 delta between adjacent pixels. Over a few px a coherent ramp
// accumulates while noise does not.
//
// Slope alone cannot tell a soft edge (several px wide, common in AI-generated or
// high-res art) from a gentle gradient: both are a gradual change over a few px.
// So the suggestion also requires palette spread: flat art is a handful of
// dominant colours covering almost every pixel, while a real gradient spreads its
// pixels thinly across many colours. Gradients default on only when both hold.
//
// Heavy JPEG noise biases toward on, which is the safe direction: the per-region
// fit keeps noisy flat regions solid.

/** Per-channel step (0–255) at/above which a baseline delta is a hard edge, not
 *  a ramp — excluded so shape boundaries don't read as gradient. */
const EDGE_DELTA = 40
/** Per-channel step below which a baseline delta is flat (noise/AA-dither floor). */
const RAMP_MIN = 2
/** Px between the pixel and the neighbour it is compared to. Wider than 1 so a
 *  gentle (sub-level/px) ramp accumulates past the byte-quantisation floor. */
const BASELINE = 3
/** Neighbours where either pixel is more transparent than this are skipped, so a
 *  shape's fade-to-transparent edge isn't mistaken for an interior ramp. */
const MIN_ALPHA = 128
/** How many of the most-common (5-bit-quantised) colours define "the palette". */
const TOP_COLORS = 8
/** If the top colours cover more than this fraction of opaque pixels the palette
 *  is concentrated (flat art), so gradients stay off however rampy soft edges
 *  read. A real gradient spreads its pixels far below this. */
const MAX_FLAT_COVERAGE = 0.65

export interface RampinessResult {
  /** Fraction of non-edge opaque pixels that are ramp steps, in [0,1]. */
  rampiness: number
  /** Opaque non-edge neighbour pairs sampled (0 ⇒ result is undefined → treat flat). */
  samples: number
  /** Opaque interior pixels whose baseline delta is below the ramp floor (≈ flat). */
  flat: number
  /** …in the ramp band (gentle ongoing variation). */
  ramp: number
  /** …at/above the edge threshold (a hard shape boundary; excluded from the ratio). */
  edge: number
}

/**
 * Fraction of an image's non-edge interior that shows gentle ramp-like variation.
 * Near 0 ⇒ flat-colour art; higher ⇒ real gradients. `step` strides the sampled
 * pixels for speed (the neighbour delta is always measured at full resolution, so
 * gentle slopes survive); 1 = every pixel. Also returns the flat/ramp/edge bucket
 * counts (the slope "histogram") so the decision can be shown to the user.
 */
export function measureRampiness(img: ImageData, step = 1): RampinessResult {
  const { width: w, height: h, data } = img
  let ramp = 0
  let flat = 0
  let edge = 0
  for (let y = 0; y + BASELINE < h; y += step) {
    for (let x = 0; x + BASELINE < w; x += step) {
      const i = (y * w + x) * 4
      if (data[i + 3] < MIN_ALPHA) continue
      const right = i + BASELINE * 4
      const down = i + BASELINE * w * 4
      let d = 0
      if (data[right + 3] >= MIN_ALPHA) d = Math.max(d, chanDelta(data, i, right))
      if (data[down + 3] >= MIN_ALPHA) d = Math.max(d, chanDelta(data, i, down))
      if (d >= EDGE_DELTA) {
        edge++ // hard boundary — not interior, excluded from the ratio
        continue
      }
      if (d >= RAMP_MIN) ramp++
      else flat++
    }
  }
  const nonEdge = flat + ramp
  return { rampiness: nonEdge ? ramp / nonEdge : 0, samples: nonEdge, flat, ramp, edge }
}

function chanDelta(data: Uint8ClampedArray, a: number, b: number): number {
  const dr = Math.abs(data[a] - data[b])
  const dg = Math.abs(data[a + 1] - data[b + 1])
  const db = Math.abs(data[a + 2] - data[b + 2])
  return dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db
}

export interface ColorSpread {
  /** Distinct 5-bit/channel colours holding ≥0.1% of opaque pixels (real fills). */
  distinctColors: number
  /** Share of opaque pixels in the TOP_COLORS most common colours, 0–1. High ⇒
   *  a few flats dominate (flat art); low ⇒ pixels spread thin (a gradient). */
  topCoverage: number
}

/**
 * Palette concentration over the opaque pixels: quantise to 5 bits/channel (so
 * anti-alias transition colours collapse toward their nearest flat and don't
 * inflate the count), then measure how concentrated the colour mass is. `step`
 * strides for speed. This is the orthogonal signal to slope — robust to soft
 * edges, which add only thin transition colours and leave the flats dominant.
 */
export function colorSpread(img: ImageData, step = 1): ColorSpread {
  const { width: w, height: h, data } = img
  const counts = new Map<number, number>()
  let opaque = 0
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4
      if (data[i + 3] < MIN_ALPHA) continue
      opaque++
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  if (!opaque) return { distinctColors: 0, topCoverage: 1 }
  const sorted = [...counts.values()].sort((a, b) => b - a)
  let top = 0
  for (let k = 0; k < TOP_COLORS && k < sorted.length; k++) top += sorted[k]
  const distinctColors = sorted.filter((c) => c >= opaque * 0.001).length
  return { distinctColors, topCoverage: top / opaque }
}

/** Fraction of non-edge interior above which an image is judged to hold real
 *  gradients (so the `gradients` toggle should default ON). Below ⇒ flat art. */
export const RAMPINESS_GRADIENT_THRESHOLD = 0.05

export interface RampinessReport extends RampinessResult, ColorSpread {
  /** Slope alone clears the rampiness threshold (gentle variation is present). */
  slopePresent: boolean
  /** Palette is spread, not a few dominant flats (topCoverage ≤ MAX_FLAT_COVERAGE). */
  paletteSpread: boolean
  /** Suggested `gradients` default = slopePresent AND paletteSpread. */
  suggestion: boolean
  /** The rampiness threshold (for display). */
  threshold: number
  /** The max top-colour coverage for "spread" (for display). */
  coverageMax: number
}

/**
 * Full gradient-detection analysis for one image: the slope buckets, the palette
 * concentration, and the resulting `gradients` suggestion. Strides large images
 * down to ~512 px on the long side for speed (slope is still measured at full
 * neighbour resolution). The suggestion is on only when a gentle slope is present
 * and the palette is spread, so a flat logo with soft edges stays off.
 * `suggestGradients` is the boolean shorthand over this.
 */
export function analyzeRampiness(img: ImageData): RampinessReport {
  const step = Math.max(1, Math.floor(Math.max(img.width, img.height) / 512))
  const result = measureRampiness(img, step)
  const spread = colorSpread(img, step)
  const slopePresent = result.rampiness >= RAMPINESS_GRADIENT_THRESHOLD
  const paletteSpread = spread.topCoverage <= MAX_FLAT_COVERAGE
  return {
    ...result,
    ...spread,
    slopePresent,
    paletteSpread,
    suggestion: slopePresent && paletteSpread,
    threshold: RAMPINESS_GRADIENT_THRESHOLD,
    coverageMax: MAX_FLAT_COVERAGE,
  }
}

/**
 * Suggested default for the `gradients` toggle: true ⇒ fit smooth gradients,
 * false ⇒ flat art, keep it off.
 */
export function suggestGradients(img: ImageData): boolean {
  return analyzeRampiness(img).suggestion
}
