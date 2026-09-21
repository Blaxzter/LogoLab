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
