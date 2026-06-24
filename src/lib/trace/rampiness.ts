// "Rampiness" probe — a cheap pre-trace heuristic that answers ONE question:
// does this image actually contain smooth colour ramps, or is it flat-colour art?
//
// It exists to auto-default the `gradients` toggle. Flat logos (the common case
// for icon / sticker art) gain nothing from the gradient machinery and can hit
// the Step-3c over-merge edge cases, so when an image reads as flat we seed the
// toggle OFF — while leaving it a visible, user-overridable control.
//
// The signal is the local colour SLOPE, not a colour histogram. A histogram peak
// count is fooled by anti-aliasing (every edge spawns hundreds of transition
// colours); slope is not. For each pixel we measure the max per-channel step to a
// neighbour BASELINE px to the right/down and bucket it:
//
//   • ≈0 (< RAMP_MIN)      → flat interior
//   • RAMP_MIN..EDGE_DELTA → a RAMP step (gentle, ongoing variation)
//   • > EDGE_DELTA         → a hard edge (a shape boundary) — ignored
//
// The baseline matters: a real logo gradient can be gentle (< 1 level/px), which
// at byte resolution rounds to a 0–1 delta between ADJACENT pixels and reads as
// flat. Measured over a few px a coherent ramp ACCUMULATES (slope × baseline)
// while random noise does not, so a small baseline recovers gentle gradients
// without lowering the noise floor.
//
// Flat-with-AA art is bimodal: a sea of flat interiors plus a thin spike at hard
// edges. When the edges are SHARP (1–2 px) the ramp band is nearly empty — the
// transition reads as a full edge jump across the baseline and is excluded. But a
// SOFT edge (an AI-generated logo, or a high-res image whose colour borders span
// several px) is a gradual ramp that never trips the edge threshold, so the slope
// probe ALONE counts it as gradient — e.g. the flat "schild" logo reads 14% rampy
// purely from its soft colour borders. A soft edge and a gentle gradient are
// locally identical (both are a gradual colour change over a few px); slope can't
// tell them apart.
//
// So the decision uses a SECOND, orthogonal signal: PALETTE CONCENTRATION. Flat
// art is a handful of dominant colours (the soft borders add only thin, sub-0.1%
// transition colours), so a few colours cover almost everything; a real gradient
// spreads its pixels thinly across many colours. Measured: schild top-8 colours
// cover 97%, nebula's gradient only 30%. Gradients default ON only when BOTH hold —
// gentle slope present AND the palette is genuinely spread — which kills the
// soft-edge false-positive without losing real gradients.
//
// Pure and deterministic (no DOM) so it runs unchanged in the browser and under
// `node --test`. The toggle is only ever seeded, never locked, so the user can
// override; heavy JPEG noise still biases toward ON, but that is the SAFE direction
// (the per-region fit keeps noisy-flat regions solid, so the output stays flat).

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
/** If the top colours cover MORE than this fraction of opaque pixels the palette
 *  is concentrated (flat art), so gradients stay OFF however rampy the soft edges
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
      // Compare to neighbours BASELINE px to the right and down.
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
  /** Share of opaque pixels in the TOP_COLORS most-common colours, 0–1. High ⇒
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
 * neighbour resolution). The suggestion is ON only when BOTH a gentle slope is
 * present AND the palette is genuinely spread — so a flat logo with soft edges
 * (high rampiness, concentrated palette) correctly stays OFF. `suggestGradients`
 * is the boolean shorthand over this.
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
