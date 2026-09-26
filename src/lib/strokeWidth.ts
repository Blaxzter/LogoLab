// Ink thickness: decides whether a mono raster needs enlarging before tracing,
// and whether the mono cut should be raised for sub-pixel strokes.
//
// Edge placement is accurate to a roughly constant fraction of a native pixel,
// so 1px strokes get dropped or fused with their neighbours at 1×. Bilinear
// enlargement recovers the sub-pixel edge the anti-aliasing encodes, but costs
// the square of the factor, so the factor follows the art's thinnest ink.
//
// Measure: per ink pixel, the shorter of its vertical and horizontal ink runs
// (local stroke thickness). The reported thickness is a low pixel-weighted
// quantile, so the thin ink drives the decision but a few specks do not. A 45°
// stroke reads √2 too thick, which errs toward enlarging less.
//
// Pure. Uses the tracer's own mono cut, so it measures the mask the tracer sees.

import { cutLuma, VISIBLE_ALPHA, type ImageDataLike } from './ink.ts'

/** Runs longer than this are "thick"; one bin holds them all. */
const THICKNESS_CAP = 64

/**
 * Share of the ink (by pixel) that a thin feature must carry to set the
 * thickness. Low on purpose: enlarging does not hurt traces and the raster cap
 * bounds its cost, so only dust should be ignored.
 */
export const THIN_INK_SHARE = 0.1

/** The tracer's mono cut (`thresholdToMask` in trace/index.ts), as a 0/1 mask. */
export function inkMask(img: ImageDataLike, threshold: number, invert: boolean): Uint8Array {
  const { width, height, data } = img
  const mask = new Uint8Array(width * height)
  const cut = Math.max(0, Math.min(255, Math.round(threshold)))
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    if (data[p + 3] < VISIBLE_ALPHA) continue
    const lum = cutLuma(data, p, invert)
    if (invert ? lum > cut : lum < cut) mask[i] = 1
  }
  return mask
}

export interface InkThickness {
  /** Local stroke thickness in px at `quantile` of the ink, by pixel. */
  thickness: number
  /** Ink pixels measured. */
  inkPixels: number
  /** Pixel-weighted histogram of local thickness, index = px (last bin = ≥ cap). */
  histogram: Uint32Array
}

/** Local thickness (min of the vertical and horizontal run) per ink pixel, capped. */
function localThickness(mask: Uint8Array, width: number, height: number): Uint8Array {
  const t = new Uint8Array(mask.length).fill(THICKNESS_CAP)
  // Vertical runs.
  for (let x = 0; x < width; x++) {
    let start = -1
    for (let y = 0; y <= height; y++) {
      const ink = y < height && mask[y * width + x] === 1
      if (ink && start < 0) start = y
      else if (!ink && start >= 0) {
        const len = Math.min(THICKNESS_CAP, y - start)
        for (let yy = start; yy < y; yy++) {
          const i = yy * width + x
          if (len < t[i]) t[i] = len
        }
        start = -1
      }
    }
  }
  // Horizontal runs.
  for (let y = 0; y < height; y++) {
    const row = y * width
    let start = -1
    for (let x = 0; x <= width; x++) {
      const ink = x < width && mask[row + x] === 1
      if (ink && start < 0) start = x
      else if (!ink && start >= 0) {
        const len = Math.min(THICKNESS_CAP, x - start)
        for (let xx = start; xx < x; xx++) {
          const i = row + xx
          if (len < t[i]) t[i] = len
        }
        start = -1
      }
    }
  }
  return t
}

/**
 * The thickness of the picture's thin ink, or null when there is no ink at all.
 * `quantile` is the share of ink pixels at or below the reported thickness.
 */
export function inkThickness(
  img: ImageDataLike,
  threshold: number,
  invert: boolean,
  quantile = THIN_INK_SHARE,
): InkThickness | null {
  const { width, height } = img
  const mask = inkMask(img, threshold, invert)
  const t = localThickness(mask, width, height)
  const histogram = new Uint32Array(THICKNESS_CAP + 1)
  let inkPixels = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue
    histogram[t[i]]++
    inkPixels++
  }
  if (inkPixels === 0) return null
  return { thickness: thicknessAt(histogram, inkPixels, quantile), inkPixels, histogram }
}

/** The smallest thickness at or below which `quantile` of the ink lies. */
export function thicknessAt(histogram: Uint32Array, inkPixels: number, quantile: number): number {
  const want = Math.max(1, Math.ceil(inkPixels * quantile))
  let acc = 0
  for (let px = 1; px < histogram.length; px++) {
    acc += histogram[px]
    if (acc >= want) return px
  }
  return THICKNESS_CAP
}

/* ---------------------------------------------------- the cut follows the thin ink */

// The midpoint cut is the 50% coverage contour: the right edge for any stroke
// at least a pixel wide. A stroke thinner than a pixel never reaches 50%
// coverage, so at the midpoint it vanishes except where it crosses another.
//
// A sub-pixel stroke shows up as a ridge: a pixel darker than both neighbours
// across some direction. Thick strokes have flat interiors and monotonic edges,
// so ridges are thin-stroke centres only. Ridges on the paper side of the cut
// are ink the cut loses, and their share of the ink sets how far the cut is
// raised: the square root of the share, capped (see docs/vectorization-
// benchmarks.md for the calibration). Below `HAIRLINE_MIN_SHARE` the cut is left
// alone, which keeps ordinary logos at the midpoint.

/** A ridge must be darker than both neighbours across it by this much (luma). */
export const HAIRLINE_RIDGE_MARGIN = 10
/** Ridges lighter than this are anti-aliasing dust, not strokes. */
export const HAIRLINE_FAINT = 240
/** Lost ridge ink below this share of the ink (by pixel) leaves the cut alone. */
export const HAIRLINE_MIN_SHARE = 0.02
/** At this share (and above) the raise is the full `HAIRLINE_MAX_RAISE`. */
export const HAIRLINE_FULL_SHARE = 0.3
/** The largest raise, as a fraction of the ink-to-paper span (40 luma on black/white). */
export const HAIRLINE_MAX_RAISE = 40 / 255

export interface HairlineRead {
  /** The cut to use — `from` when nothing moved. */
  cut: number
  /** The cut the probe placed before this read. */
  from: number
  /** Share of the ink (by pixel) that is a ridge the cut at `from` loses. */
  lostShare: number
  /** Median darkness (as a luma on the ink side) of those lost ridges; null when none. */
  ridgeLuma: number | null
}

/** The raise, in luma, for a lost-ridge share. */
export function hairlineRaise(lostShare: number, span = 255): number {
  if (lostShare < HAIRLINE_MIN_SHARE) return 0
  return Math.round(HAIRLINE_MAX_RAISE * span * Math.sqrt(Math.min(1, lostShare / HAIRLINE_FULL_SHARE)))
}

/**
 * Read the thin ink at `from` and, when the cut is losing a real share of it, raise
 * the cut toward the paper by `hairlineRaise`. Same axis conventions as
 * `thresholdToMask`: `invert` puts the light side in ink, `cut` is a luma either
 * way, and `span` is the ink-to-paper luma distance the probe measured.
 */
export function hairlineCut(img: ImageDataLike, from: number, invert: boolean, span = 255): HairlineRead {
  const { width: W, height: H, data } = img
  const none: HairlineRead = { cut: from, from, lostShare: 0, ridgeLuma: null }
  if (W < 3 || H < 3) return none
  // Darkness axis: ink is LOW whatever the paper. Invisible pixels read as paper.
  const d = new Float32Array(W * H).fill(255)
  for (let i = 0, p = 0; i < W * H; i++, p += 4) {
    if (data[p + 3] < VISIBLE_ALPHA) continue
    const l = cutLuma(data, p, invert)
    d[i] = invert ? 255 - l : l
  }
  const cutD = invert ? 255 - from : from
  let ink = 0
  const lost: number[] = []
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x
      const v = d[i]
      if (v < cutD) { ink++; continue }
      if (v >= HAIRLINE_FAINT) continue
      const m = v + HAIRLINE_RIDGE_MARGIN
      if (
        (m <= d[i - 1] && m <= d[i + 1]) ||
        (m <= d[i - W] && m <= d[i + W]) ||
        (m <= d[i - W - 1] && m <= d[i + W + 1]) ||
        (m <= d[i - W + 1] && m <= d[i + W - 1])
      )
        lost.push(v)
    }
  }
  if (lost.length === 0) return none
  const lostShare = lost.length / (ink + lost.length)
  lost.sort((a, b) => a - b)
  const q = lost[Math.floor(lost.length / 2)]
  const ridgeLuma = invert ? 255 - q : q
  const raise = hairlineRaise(lostShare, span)
  if (raise === 0) return { ...none, lostShare, ridgeLuma }
  const newD = Math.min(254, cutD + raise)
  return { cut: invert ? 255 - newD : newD, from, lostShare, ridgeLuma }
}
