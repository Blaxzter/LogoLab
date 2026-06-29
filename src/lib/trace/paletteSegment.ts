// Palette-first segmentation for FLAT art (gradients off) — the structural fix for
// anti-alias "blend regions". The Mumford–Shah segmenter (segment.ts) groups by
// SMOOTHNESS, so the ~1–2px anti-aliased ramp between two flat colours is itself a
// smooth field and becomes its OWN region with a blended colour (the olive sliver
// between orange and teal, the brown bands where a colour fades to black, …). No
// area- or detail-based merge removes them: a band runs the whole length of a
// contact edge, so its area clears any threshold.
//
// Palette-first inverts the order (this is the old V1 posterize path, rebuilt on
// quantize.ts): pick a small palette of the DOMINANT colours, then assign EVERY
// pixel — anti-aliased ones included — to the nearest palette colour. A blend pixel
// snaps to whichever real colour it is closest to, so the boundary collapses to a
// single clean edge at the 50% isophote and no intermediate region can exist. It is
// gated to flat art because assigning-to-nearest would band a real gradient (the MS
// path still owns gradient art, where the smooth-field grouping is correct).

import type { QuantizeResult } from './types'
import { quantize, dropMinorColors, modeFilter } from './quantize.ts'

export interface PaletteSegmentOptions {
  /** k-means cluster budget. Over-provisioned: dropMinorColors trims the extras,
   *  so this only needs to be ≥ the true colour count (logos: a handful). */
  maxColors: number
  /** Drop palette entries holding less than this share of the opaque pixels into
   *  their nearest survivor. AA blend bands are each a small share, so this is what
   *  removes the spurious blend colours; real flats are well above it. */
  minShare: number
  /** 3×3 majority-vote passes to melt the 1px stair-step the nearest-colour
   *  assignment leaves along each boundary (a clean single edge afterwards). */
  modePasses: number
  /** Connected components smaller than this (opaque px) are dissolved into the
   *  label that borders them most — kills salt-and-pepper specks / pinholes from
   *  source noise that would otherwise each become an extra traced loop. */
  minRegionArea: number
}

export const DEFAULT_PALETTE_SEGMENT: PaletteSegmentOptions = {
  maxColors: 16,
  minShare: 0.006,
  modePasses: 2,
  minRegionArea: 64,
}

/**
 * Dissolve connected components below `minArea` into the label that borders them
 * most. 4-connectivity, iterative scan-flood (deterministic order). A label class
 * can span many components; only the tiny ones are absorbed, so real shapes (text
 * bars, ring strokes — thousands of px) are untouched. Mutates a copy.
 */
function despeckleComponents(labels: Int32Array, w: number, h: number, minArea: number): Int32Array {
  if (minArea <= 0) return labels
  const n = w * h
  const out = labels.slice()
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let cid = 0
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || out[start] < 0) continue
    const lab = out[start]
    comp[start] = cid
    stack.length = 0
    stack.push(start)
    const pixels: number[] = []
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      const x = p % w, y = (p / w) | 0
      if (x > 0 && comp[p - 1] === -1 && out[p - 1] === lab) { comp[p - 1] = cid; stack.push(p - 1) }
      if (x < w - 1 && comp[p + 1] === -1 && out[p + 1] === lab) { comp[p + 1] = cid; stack.push(p + 1) }
      if (y > 0 && comp[p - w] === -1 && out[p - w] === lab) { comp[p - w] = cid; stack.push(p - w) }
      if (y < h - 1 && comp[p + w] === -1 && out[p + w] === lab) { comp[p + w] = cid; stack.push(p + w) }
    }
    if (pixels.length < minArea) {
      // Majority bordering label (≠ lab, ≥ 0); fall back to leaving it if isolated.
      const border = new Map<number, number>()
      for (const p of pixels) {
        const x = p % w, y = (p / w) | 0
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
        for (const q of nb) {
          if (q < 0) continue
          const l = out[q]
          if (l === lab || l < 0) continue
          border.set(l, (border.get(l) ?? 0) + 1)
        }
      }
      let best = -1, bestC = 0
      for (const [l, c] of border) if (c > bestC) { bestC = c; best = l }
      if (best >= 0) for (const p of pixels) out[p] = best
    }
    cid++
  }
  return out
}

export interface FlatPaletteResult extends QuantizeResult {
  /**
   * Fraction of opaque pixels whose ORIGINAL colour sits within a tight Δ of the
   * flat colour they were assigned. High (≈1) ⇒ the image really is flat regions +
   * thin AA (a logo) and palette-first is ideal. Low ⇒ continuous tone (a photo)
   * that a small palette would over-posterize — the caller should fall back to the
   * smoothness segmenter instead.
   */
  flatCoverage: number
}

/** RGB² distance under which a pixel counts as "is its flat colour" (not AA/tone). */
const FLAT_TIGHT2 = 32 * 32

/**
 * Segment flat art by palette-then-assign. Returns a QuantizeResult (labels are
 * colour classes, 0..palette.length-1, largest first) — drop-in for the planar /
 * stacked-mask tracers, exactly like segmentImage's output — plus a `flatCoverage`
 * suitability signal for the caller's flat-vs-photo gate.
 */
export function segmentFlatPalette(
  img: { width: number; height: number; data: Uint8ClampedArray },
  opts: PaletteSegmentOptions = DEFAULT_PALETTE_SEGMENT,
): FlatPaletteResult {
  // 1. Over-provisioned palette. quantize maps every DISTINCT colour (AA blends
  //    included) to its nearest centroid, so no pixel keeps a blend value.
  let q = quantize(img as ImageData, opts.maxColors)
  // 2. Dissolve the low-share entries (the blend smears) into their nearest real
  //    colour — this is what kills the olive/brown sliver colours.
  q = dropMinorColors(q, opts.minShare)

  // Suitability: how much of the image actually IS its assigned flat colour. AA
  // pixels and photo tones miss; flat-region interiors hit. Measured on the post-
  // drop labels (the colours we'd emit), before the boundary clean-up.
  let opaque = 0, flat = 0
  for (let i = 0; i < q.labels.length; i++) {
    const l = q.labels[i]
    if (l < 0) continue
    opaque++
    const o = i * 4
    const c = q.palette[l]
    const dr = img.data[o] - c.r, dg = img.data[o + 1] - c.g, db = img.data[o + 2] - c.b
    if (dr * dr + dg * dg + db * db <= FLAT_TIGHT2) flat++
  }
  const flatCoverage = opaque > 0 ? flat / opaque : 0

  // 3. Melt the residual 1px boundary stair-step into the dominant neighbour.
  const smoothed = modeFilter(q.labels, img.width, img.height, opts.modePasses)
  // 4. Dissolve sub-threshold specks/pinholes so they don't each become a loop.
  const labels = despeckleComponents(smoothed, img.width, img.height, opts.minRegionArea)

  // modeFilter can move pixels between labels → recompute counts so they stay exact
  // (downstream paint/order never depend on them here, but keep the contract honest).
  const counts = new Array<number>(q.palette.length).fill(0)
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l >= 0) counts[l]++
  }
  return { palette: q.palette, labels, counts, flatCoverage }
}
