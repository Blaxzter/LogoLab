// How many colours does this icon actually use?
//
// Sheet icons are usually ONE ink on paper — line art. Tracing that as "colour"
// hands it to the palette segmenter, which is right for real multi-colour art but
// wrong here: the ink of a model-generated sheet carries soft shading (a light
// side and a shadow side, ΔE 4–11 apart), the palette keeps those as separate
// entries, and every shape is then CARVED along the line where the assignment
// flips — the bite out of a disc that made the traces look broken.
//
// Mono has no palette to split, so the same icon comes out as one clean shape.
// The catch is that mono is wrong for genuinely colourful icons, so the decision
// has to be per tile, and it has to be made on evidence: fuse the ink colours
// that are only tonal variants of each other and count what is left.

import { deltaE76, srgbToLab } from '../trace/lab.ts'
import { isInkPixel } from './detect.ts'
import type { ImageDataLike, SheetBackground } from './types'

/** Ink colours closer than this (CIE76) are one ink under shading, not two. */
const SAME_INK_DE = 14
/** Colour buckets holding less than this share of the ink are noise/AA. */
const MIN_INK_SHARE = 0.02
/** Mono needs the ink to be clearly darker than the paper (threshold traces dark). */
const MIN_INK_CONTRAST = 25

export interface InkProbe {
  /** Distinct inks after fusing tonal variants. 0 = nothing but paper. */
  inks: number
  /** The dominant ink as #rrggbb, or null when the tile holds no ink. */
  dominant: string | null
  /** One ink, clearly darker than the paper ⇒ trace it mono. */
  mono: boolean
  /**
   * One ink, clearly LIGHTER than the paper (white glyphs on a dark sheet) ⇒
   * mono as well, with the cut inverted (`VectorizeOptions.invert`). The colour
   * path on such a tile keeps the anti-aliasing band between glyph and paper as
   * a region of its own: dark slivers around every shape, worse the smaller the
   * tile (measured: 16/16 tiles at 184px).
   */
  monoInverted: boolean
  /**
   * Luminance (Rec.709, 0–255, the tracer's own mask weights) of the dominant
   * ink — null when the tile holds none — and of the paper: the two values a
   * mono cut has to fall between.
   */
  inkLuma: number | null
  paperLuma: number
}

/** Rec.709 luminance, the weights the tracer's mono mask thresholds on. */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function probeInk(img: ImageDataLike, bg: SheetBackground, threshold = 24): InkProbe {
  const { width: W, height: H, data } = img
  const paperLuma = bg.transparent ? 255 : luma(bg.r, bg.g, bg.b)
  const none: InkProbe = { inks: 0, dominant: null, mono: false, monoInverted: false, inkLuma: null, paperLuma }

  // 5 bits per channel: fine enough to separate real colours, coarse enough that
  // dithering and JPEG mush land in the same bucket.
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>()
  let inkPixels = 0
  const step = Math.max(1, Math.floor(Math.max(W, H) / 256))
  for (let y = 0; y < H; y += step) {
    for (let x = 0; x < W; x += step) {
      const i = (y * W + x) * 4
      if (!isInkPixel(data, i, bg, threshold)) continue
      // Partly-transparent edge pixels are the AA ramp, not a colour of their own.
      if (data[i + 3] < 200) continue
      inkPixels++
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)
      const e = buckets.get(key)
      if (e) {
        e.n++
        e.r += data[i]
        e.g += data[i + 1]
        e.b += data[i + 2]
      } else {
        buckets.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] })
      }
    }
  }
  if (inkPixels === 0) return none

  const entries = [...buckets.values()]
    .filter((e) => e.n >= inkPixels * MIN_INK_SHARE)
    .map((e) => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }))
    .sort((a, b) => b.n - a.n)
  if (entries.length === 0) return none

  // Greedy fusion, biggest first: a tonal variant joins the ink it belongs to.
  const inks: { n: number; r: number; g: number; b: number }[] = []
  for (const e of entries) {
    const lab = srgbToLab(e.r, e.g, e.b)
    const host = inks.find((k) => deltaE76(srgbToLab(k.r, k.g, k.b), lab) < SAME_INK_DE)
    if (host) {
      // Weighted mean, so the dominant tone (not the shadow) names the ink.
      const total = host.n + e.n
      host.r = (host.r * host.n + e.r * e.n) / total
      host.g = (host.g * host.n + e.g * e.n) / total
      host.b = (host.b * host.n + e.b * e.n) / total
      host.n = total
    } else {
      inks.push({ ...e })
    }
  }
  inks.sort((a, b) => b.n - a.n)

  const top = inks[0]
  const inkLuma = luma(top.r, top.g, top.b)
  return {
    inks: inks.length,
    dominant: hex(top.r, top.g, top.b),
    // Mono thresholds dark-against-light; a light ink on dark paper needs the
    // cut flipped, which is what `monoInverted` asks the planner for.
    mono: inks.length === 1 && paperLuma - inkLuma >= MIN_INK_CONTRAST,
    monoInverted: inks.length === 1 && inkLuma - paperLuma >= MIN_INK_CONTRAST,
    inkLuma,
    paperLuma,
  }
}

function hex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${c(r)}${c(g)}${c(b)}`
}
