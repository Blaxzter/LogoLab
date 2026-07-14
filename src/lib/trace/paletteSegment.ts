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

import type { PaletteColor, QuantizeResult } from './types'
import { quantize, dropMinorColors, modeFilter } from './quantize.ts'

export interface PaletteSegmentOptions {
  /** k-means cluster budget. Over-provisioned: dropMinorColors trims the extras,
   *  so this only needs to be ≥ the true colour count (logos: a handful). */
  maxColors: number
  /** Drop palette entries holding less than this share of the opaque pixels into
   *  their nearest survivor. AA blend bands are each a small share, so this is what
   *  removes the spurious blend colours. Real flats are NOT always above it — a
   *  small genuine region (a pencil tip, a backpack) can hold less than a long
   *  edge's blend band — so entries with flat-interior evidence ≥ minRegionArea are
   *  exempted (see flatInteriorCounts). */
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

/**
 * Per-label count of FLAT-INTERIOR source pixels: a pixel whose 8 neighbours all
 * carry the exact same source colour. This is the evidence that separates a REAL
 * small region from an anti-alias blend smear, and area alone cannot: a blend band
 * runs the whole length of a contact edge (its pixel count clears any share
 * threshold a small region can clear) but every one of its pixels is a one-off
 * blend, essentially never surrounded by eight identical pixels — while a genuine
 * region interior always is. Measured on the tier-2 corpus: every real dropped
 * region had 300+ flat-interior pixels, every blend-smear entry had 0 (§9.1).
 * (Same criterion scoreRegions uses to count true regions, for the same reason.)
 */
function flatInteriorCounts(
  img: { width: number; height: number; data: Uint8ClampedArray },
  labels: Int32Array,
  paletteLen: number,
): Int32Array {
  const { width: w, height: h, data } = img
  const counts = new Int32Array(paletteLen)
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = labels[i]
      if (l < 0) continue
      const k = rgbAt(i)
      if (
        rgbAt(i - w - 1) === k && rgbAt(i - w) === k && rgbAt(i - w + 1) === k &&
        rgbAt(i - 1) === k && rgbAt(i + 1) === k &&
        rgbAt(i + w - 1) === k && rgbAt(i + w) === k && rgbAt(i + w + 1) === k
      ) counts[l]++
    }
  }
  return counts
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
 * Assign every kept pixel (alpha ≥ 128) to a palette colour; pixels below the alpha
 * mask (< 128) get -1. Used by the locked-palette path: the user supplies the
 * colours, so there is no clustering — just nearest-colour snapping over a fixed
 * palette.
 *
 * HUE is strict RGB-nearest; ALPHA only breaks ties among entries at the SAME RGB
 * distance (i.e. duplicate-RGB swatches), picking the one whose alpha is nearest the
 * pixel's. This keeps the two key behaviours decoupled: locking the SAME hue at two
 * opacities separates the more- and less-transparent pixels (the swatches share an
 * RGB so every pixel ties on RGB → alpha decides), while editing ONE swatch's alpha
 * never changes which region it owns (its RGB is unchanged, so the RGB-nearest set is
 * unchanged) — it just repaints that region's opacity. An all-opaque palette reduces
 * to plain RGB-nearest, identical to before.
 */
function assignNearest(
  img: { width: number; height: number; data: Uint8ClampedArray },
  palette: PaletteColor[],
): Int32Array {
  const { data } = img
  const n = img.width * img.height
  const labels = new Int32Array(n)
  const pa = palette.map((c) => c.a ?? 255)
  const rgbD = new Float64Array(palette.length)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (data[o + 3] < 128) {
      labels[i] = -1
      continue
    }
    const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3]
    let minD = Infinity
    for (let c = 0; c < palette.length; c++) {
      const dr = r - palette[c].r, dg = g - palette[c].g, db = b - palette[c].b
      const d = dr * dr + dg * dg + db * db
      rgbD[c] = d
      if (d < minD) minD = d
    }
    // Among the RGB-nearest entries (exact ties — duplicate-RGB swatches), the one
    // whose alpha is closest to the pixel's wins; otherwise the single nearest hue.
    let best = 0, bestAlphaD = Infinity
    for (let c = 0; c < palette.length; c++) {
      if (rgbD[c] !== minD) continue
      const da = a - pa[c]
      const ad = da * da
      if (ad < bestAlphaD) { bestAlphaD = ad; best = c }
    }
    labels[i] = best
  }
  return labels
}

/**
 * Per-label MODE of the source alpha (over kept pixels). A flat region's interior
 * is one constant alpha that dominates its anti-aliased rim, so the mode is the
 * region's true opacity — the alpha analogue of snapPaletteToModes. Returns 255 for
 * an empty label. Ties break to the lower alpha for determinism.
 */
function regionAlphaModes(labels: Int32Array, data: Uint8ClampedArray, paletteLen: number): number[] {
  const hist: Map<number, number>[] = Array.from({ length: paletteLen }, () => new Map<number, number>())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const a = data[i * 4 + 3]
    const h = hist[l]
    h.set(a, (h.get(a) ?? 0) + 1)
  }
  return hist.map((h) => {
    let bestA = 255, bestC = 0
    for (const [a, c] of h) {
      if (c > bestC || (c === bestC && a < bestA)) {
        bestC = c
        bestA = a
      }
    }
    return bestC > 0 ? bestA : 255
  })
}

/**
 * Snap each palette entry to the DOMINANT EXACT source colour among the pixels
 * assigned to it (the MODE), instead of the k-means count-weighted MEAN. A flat
 * region's interior is thousands of pixels of one true design colour while its
 * anti-aliased boundary pixels are each rare and distinct, so the mode lands on
 * the true design hex (#fc6304) rather than the centroid's drift (#fd6403).
 *
 * Each distinct source colour maps to exactly one cluster (nearest-centroid), so
 * no two labels can share a modal colour ⇒ the snapped palette has no colliding
 * entries. Ties break to the lower packed-RGB key for determinism. Pure: returns
 * a fresh palette; an empty label (no pixels) keeps its original entry.
 */
function snapPaletteToModes(
  palette: PaletteColor[],
  labels: Int32Array,
  data: Uint8ClampedArray,
): PaletteColor[] {
  const hist: Map<number, number>[] = palette.map(() => new Map<number, number>())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    const h = hist[l]
    h.set(key, (h.get(key) ?? 0) + 1)
  }
  return palette.map((c, l) => {
    let bestKey = -1, bestCount = 0
    for (const [key, count] of hist[l]) {
      if (count > bestCount || (count === bestCount && key < bestKey)) {
        bestCount = count
        bestKey = key
      }
    }
    if (bestKey < 0) return { r: c.r, g: c.g, b: c.b } // empty label — keep centroid
    return { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff }
  })
}

/**
 * Segment flat art by palette-then-assign. Returns a QuantizeResult (labels are
 * colour classes, 0..palette.length-1, largest first) — drop-in for the planar /
 * stacked-mask tracers, exactly like segmentImage's output — plus a `flatCoverage`
 * suitability signal for the caller's flat-vs-photo gate.
 *
 * When `lockedPalette` is supplied (the user-edited palette), quantization is
 * skipped entirely: every pixel snaps to the nearest GIVEN colour, the colours are
 * emitted verbatim (no mode-snap — the user's hex is authoritative), and the count
 * is whatever the user chose. Otherwise the dominant palette is extracted
 * automatically and each entry is snapped to its true design hex (mode).
 */
export function segmentFlatPalette(
  img: { width: number; height: number; data: Uint8ClampedArray },
  opts: PaletteSegmentOptions = DEFAULT_PALETTE_SEGMENT,
  lockedPalette?: PaletteColor[],
): FlatPaletteResult {
  const locked = lockedPalette && lockedPalette.length > 0 ? lockedPalette : null
  let palette: PaletteColor[]
  let labels: Int32Array
  if (locked) {
    // User-locked palette: no clustering — assign every pixel to the nearest of
    // the user's colours (RGBA) and keep them exactly as given. Opaque entries omit
    // `a` so they serialize without a redundant fill-opacity.
    palette = locked.map((c) => (c.a !== undefined && c.a < 255 ? { r: c.r, g: c.g, b: c.b, a: c.a } : { r: c.r, g: c.g, b: c.b }))
    labels = assignNearest(img, palette)
  } else {
    // 1. Over-provisioned palette. quantize maps every DISTINCT colour (AA blends
    //    included) to its nearest centroid, so no pixel keeps a blend value.
    let q = quantize(img as ImageData, opts.maxColors)
    // 2. Dissolve the low-share entries (the blend smears) into their nearest real
    //    colour — this is what kills the olive/brown sliver colours. PROTECT any
    //    entry with enough flat-interior evidence to be a real region: share alone
    //    cannot tell a small region from a blend band, and dropping a real region
    //    repaints it with the nearest SURVIVING colour — arbitrarily wrong for an
    //    isolated dark detail (§9.1: pencil's tip painted eraser-pink, ΔE 76).
    //    The floor is minRegionArea: anything smaller is dissolved by despeckle
    //    below anyway, so protecting it would be pointless — and the floor scales
    //    with the user's Despeckle dial like the rest of the cleanup.
    const flat = flatInteriorCounts(img, q.labels, q.palette.length)
    q = dropMinorColors(q, opts.minShare, Array.from(flat, (c) => c >= opts.minRegionArea))
    palette = q.palette
    labels = q.labels
  }

  // Suitability: how much of the image actually IS its assigned flat colour. AA
  // pixels and photo tones miss; flat-region interiors hit. Measured on the post-
  // drop labels (the colours we'd emit), before the boundary clean-up — and before
  // the mode-snap, so the flat-vs-photo gate stays calibrated on the centroids.
  let opaque = 0, flat = 0
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    opaque++
    const o = i * 4
    const c = palette[l]
    const dr = img.data[o] - c.r, dg = img.data[o + 1] - c.g, db = img.data[o + 2] - c.b
    if (dr * dr + dg * dg + db * db <= FLAT_TIGHT2) flat++
  }
  const flatCoverage = opaque > 0 ? flat / opaque : 0

  // Snap the AUTO palette to true design hex (mode, not mean) and tag each region
  // with its alpha MODE so a flat semi-transparent region round-trips its opacity
  // (only when < 255 — opaque art stays alpha-free → byte-identical). A locked
  // palette is left verbatim: the user's chosen colours + alphas are authoritative.
  if (!locked) {
    palette = snapPaletteToModes(palette, labels, img.data)
    const alphas = regionAlphaModes(labels, img.data, palette.length)
    palette = palette.map((c, l) => (alphas[l] < 255 ? { ...c, a: alphas[l] } : c))
  }

  // 3. Melt the residual 1px boundary stair-step into the dominant neighbour.
  const smoothed = modeFilter(labels, img.width, img.height, opts.modePasses)
  // 4. Dissolve sub-threshold specks/pinholes so they don't each become a loop.
  const cleaned = despeckleComponents(smoothed, img.width, img.height, opts.minRegionArea)

  // modeFilter can move pixels between labels → recompute counts so they stay exact
  // (downstream paint/order never depend on them here, but keep the contract honest).
  const counts = new Array<number>(palette.length).fill(0)
  for (let i = 0; i < cleaned.length; i++) {
    const l = cleaned[i]
    if (l >= 0) counts[l]++
  }
  return { palette, labels: cleaned, counts, flatCoverage }
}
