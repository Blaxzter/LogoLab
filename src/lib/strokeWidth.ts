// How thick is the ink? — the number that decides whether a small mono raster
// needs more pixels before it is traced.
//
// The tracer places every edge to a roughly constant accuracy in NATIVE pixels
// (§30 of docs/vectorization-benchmarks.md), so a 1px stroke is a feature the
// lattice cannot hold: at 1× the threshold either drops it or fuses it with its
// neighbour (a page of sheet music traced at 499px lost every staff line into
// the note heads). Bilinear enlargement recovers the sub-pixel edge that the
// anti-aliasing encodes — measured on that page, 3× brought the staff back
// clean while 2× still broke it — but enlarging costs the square of the factor,
// so the factor should follow what the art needs, not the raster's size alone.
//
// The measure: for every ink pixel, the shorter of the vertical and horizontal
// ink runs through it — a stroke's local thickness, independent of its length.
// The distribution is weighted by pixels, and the reported thickness is a LOW
// quantile of it: the thinnest ink that still carries a meaningful share of the
// picture drives the decision, while a few specks of dust do not. A 45° stroke
// reads √2 too thick, which errs toward enlarging less, never more.
//
// Pure pixels in, one number out; mirrors the tracer's own mono cut so the
// thickness is that of the mask the tracer will actually see.

import { cutLuma, VISIBLE_ALPHA, type ImageDataLike } from './ink.ts'

/** Runs longer than this are "thick"; one bin holds them all. */
const THICKNESS_CAP = 64

/**
 * Share of the ink (by pixel) that a thin feature must carry to set the
 * thickness. Low on purpose: enlarging never made a trace worse in any
 * measurement here (the sheet's 3× is a strict improvement on 170px tiles) and
 * the raster cap bounds its cost, so the only ink worth ignoring is dust.
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

// The midpoint cut is the 50% coverage contour: the geometrically right edge for
// any stroke a pixel wide or more, and a bias on every edge if it is moved. But a
// stroke THINNER than a pixel never reaches 50% coverage — a 0.6px barline peaks at
// ~40% — so at the midpoint it does not exist, except where it crosses another
// stroke and the coverages add up (the "beads" on a staff line).
//
// The raster can tell us: a sub-pixel stroke is a RIDGE, a pixel darker than both
// its neighbours across some direction by a margin. A thick stroke's interior is
// flat and its anti-aliased edge is a monotonic ramp — neither is a ridge — so the
// ridge pixels are the centres of thin strokes and nothing else. Those at or above
// the cut are the ink the cut LOSES, and their share of the picture is the number
// the rule reads.
//
// WHAT the rule reads it into was measured, not reasoned (docs §38, `hairlineCutDiag`:
// two synthetic pages, a page of sheet music and the `hairlines` fixture at 400–800px,
// every cut from 128 to 200, each trace scored against the page's own VECTOR). The
// SSIM-optimal cut is NOT a quantile of the lost ridges' darkness — on the real page
// the faint text hairlines outnumber the darker barlines and drag every quantile up
// to 191, which the eye rejects as bold. It tracks the SHARE: ~168 when a quarter or
// more of the ink is sub-pixel, ~152 at 3–6%, the midpoint at 2.5%. A square root of
// the share, capped, reproduces the optimum to within 0.011 SSIM on every row (mean
// loss 0.0022 against 0.0167 for the midpoint). The gate keeps logos where they are:
// the highest share on 152 gallery marks @256/@512 is 1.2% (`boeing-wm`, `chanel`), and
// on those two a raise measured a wash or a hair worse against their own vectors, so
// the gate sits above them at 2% — which costs nothing on the calibration rows.

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

/** The raise, in luma, for a lost-ridge share — the measured curve. */
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
