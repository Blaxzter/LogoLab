// Ink vs paper: how many colours is this art actually made of, and where does a
// mono cut belong?
//
// This started life inside the icon-sheet splitter, because that is where the
// question first got asked: a sheet icon is usually ONE ink on paper, that ink
// carries soft shading (a light side and a shadow side, ΔE 4–11 apart), and the
// colour path keeps those as separate palette entries and CARVES every shape
// along the line where the assignment flips — the bite out of a disc that made
// the traces look broken. Mono has no palette to split, so the same icon comes
// out as one clean shape.
//
// None of that reasoning is sheet-specific. It is equally true of a single logo
// dropped on /vectorize, and the studio spent its whole life without it: mode
// defaulted to colour, the mono cut was a constant 128 ("black ink on white
// paper"), and `invert` had no control at all — so white line-art in Mono traced
// to nothing, silently (issue #46). So the decision lives here now, and the
// sheet, the MCP server and the studio all read the same one.
//
// Everything in this file is pure: no DOM, no Node APIs, plain pixels in.

import { deltaE76, srgbToLab } from './trace/lab.ts'
import type { VectorizeOptions } from '../types'

/** Anything shaped like a browser `ImageData` (the Node harness decodes into this too). */
export interface ImageDataLike {
  width: number
  height: number
  /** Row-major RGBA, 8 bits per channel. */
  data: Uint8ClampedArray
}

/**
 * The paper an image is drawn on — the background colour everything else is ink
 * against. (Named `SheetBackground` where the sheet code still says so.)
 */
export interface PaperColor {
  r: number
  g: number
  b: number
  a: number
  /** Fraction of the image within `threshold` of this colour. */
  coverage: number
  /** The paper is transparent and alpha alone separates the art. */
  transparent: boolean
  /** The border ring agreed with itself — a plain, flat background. */
  uniform: boolean
}

/** Default colour distance (0–255, max-channel) at which a pixel counts as ink. */
export const INK_THRESHOLD = 24

/* ------------------------------------------------------------------- paper */

function isNear(data: Uint8ClampedArray, i: number, r: number, g: number, b: number, threshold: number): boolean {
  return (
    Math.abs(data[i] - r) <= threshold &&
    Math.abs(data[i + 1] - g) <= threshold &&
    Math.abs(data[i + 2] - b) <= threshold
  )
}

/**
 * The paper colour, read off the border ring: art is laid out with a margin, so
 * the outermost pixels are background almost by definition. Median, not mean, so
 * a logo that bleeds into one corner cannot drag it.
 */
export function estimateBackground(img: ImageDataLike, threshold: number): PaperColor {
  const { width: W, height: H, data } = img
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const as: number[] = []
  const stepX = Math.max(1, Math.floor(W / 400))
  const stepY = Math.max(1, Math.floor(H / 400))
  const push = (x: number, y: number) => {
    const i = (y * W + x) * 4
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
    as.push(data[i + 3])
  }
  for (let x = 0; x < W; x += stepX) {
    push(x, 0)
    push(x, H - 1)
  }
  for (let y = 0; y < H; y += stepY) {
    push(0, y)
    push(W - 1, y)
  }
  const med = (a: number[]) => {
    a.sort((p, q) => p - q)
    return a.length ? a[a.length >> 1] : 0
  }
  const r = med(rs)
  const g = med(gs)
  const b = med(bs)
  const a = med(as)

  // Uniformity: how much of the ring agrees with its own median.
  let agree = 0
  for (let i = 0; i < rs.length; i++) {
    // rs/gs/bs are sorted now, so compare the *distribution* instead: count ring
    // samples within tolerance using the sorted arrays' quantiles.
    if (Math.abs(rs[i] - r) <= threshold && Math.abs(gs[i] - g) <= threshold && Math.abs(bs[i] - b) <= threshold) agree++
  }
  const transparent = a < 16

  let inside = 0
  const total = Math.ceil(W / stepX) * Math.ceil(H / stepY)
  for (let y = 0; y < H; y += stepY) {
    for (let x = 0; x < W; x += stepX) {
      const i = (y * W + x) * 4
      if (transparent ? data[i + 3] < 16 : isNear(data, i, r, g, b, threshold)) inside++
    }
  }

  return {
    r,
    g,
    b,
    a,
    coverage: total ? inside / total : 0,
    transparent,
    uniform: agree / Math.max(1, rs.length) > 0.8,
  }
}

/** True when this source pixel is ink (i.e. not the background). */
export function isInkPixel(data: Uint8ClampedArray, i: number, bg: PaperColor, threshold: number): boolean {
  const alpha = data[i + 3]
  if (bg.transparent) return alpha > 16
  if (alpha <= 16) return false
  // A pixel that is partly transparent over a background it doesn't match is ink
  // regardless of its colour distance — composite before comparing.
  return !isNear(data, i, bg.r, bg.g, bg.b, threshold) || alpha < 240
}

/* -------------------------------------------------------------- the probe */

/** Ink colours closer than this (CIE76) are one ink under shading, not two. */
const SAME_INK_DE = 14
/** Colour buckets holding less than this share of the ink are noise/AA. */
const MIN_INK_SHARE = 0.02
/** Mono needs the ink to be clearly darker than the paper (threshold traces dark). */
const MIN_INK_CONTRAST = 25

export interface InkProbe {
  /** Distinct inks after fusing tonal variants. 0 = nothing but paper. */
  inks: number
  /** The dominant ink as #rrggbb, or null when the art holds no ink. */
  dominant: string | null
  /** One ink, clearly darker than the paper ⇒ trace it mono. */
  mono: boolean
  /**
   * One ink, clearly LIGHTER than the paper (white glyphs on a dark ground) ⇒
   * mono as well, with the cut inverted (`VectorizeOptions.invert`). The colour
   * path on such art keeps the anti-aliasing band between glyph and paper as a
   * region of its own: dark slivers around every shape, worse the smaller the
   * source (measured: 16/16 tiles at 184px).
   */
  monoInverted: boolean
  /**
   * Luminance (Rec.709, 0–255, the tracer's own mask weights) of the dominant
   * ink — null when there is none — and of the paper: the two values a mono cut
   * has to fall between.
   */
  inkLuma: number | null
  paperLuma: number
}

/** Rec.709 luminance, the weights the tracer's mono mask thresholds on. */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

export function probeInk(img: ImageDataLike, bg: PaperColor, threshold = INK_THRESHOLD): InkProbe {
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

/* ------------------------------------------------------------- the decision */

/** How colour vs mono gets decided: per image, or forced by the user. */
export type InkColorMode = 'auto' | 'color' | 'mono'

/**
 * Where a mono trace cuts. The old studio default (128) assumes black ink on
 * white paper; once both the ink and the paper are known the cut goes halfway
 * between them. Without this an orange ticket (luma 174) on cream paper (244)
 * sits ABOVE the default cut — on the paper side — and traces to nothing
 * (0 paths on the travel sheet's tile 08).
 */
export function monoThreshold(probe: Pick<InkProbe, 'inkLuma' | 'paperLuma'>, fallback: number): number {
  if (probe.inkLuma == null) return fallback
  return Math.round((probe.inkLuma + probe.paperLuma) / 2)
}

export interface InkModePlan {
  /** What the tracer should run as. */
  mode: 'color' | 'mono'
  /** Mono cut, between the ink and the paper. Meaningless in colour mode. */
  threshold: number
  /** Light ink on dark paper: flip the cut. Always false in colour mode. */
  invert: boolean
  /**
   * The ink's real colour (#rrggbb) when a mono trace should be repainted with
   * it — a mono trace comes back `#000`, and this is the only thing that knows
   * better. Null in colour mode, or when there is no ink.
   */
  recolor: string | null
  /** Distinct inks the probe saw — surfaced so the UI can explain the choice. */
  inks: number
  /** The probe itself, for callers that want to explain more than `inks`. */
  probe: InkProbe
}

/**
 * Colour vs mono, the mono cut, and whether to invert it — the whole decision,
 * from pixels.
 *
 * The one that matters is colour vs mono, and it is made on evidence: fuse the
 * ink colours that are only tonal variants of each other and count what is left.
 * Only take the colour path when there really is more than one ink.
 */
export function decideInkMode(
  pixels: ImageDataLike,
  fallbackThreshold: number,
  settings: { colorMode: InkColorMode; background?: PaperColor | null },
): InkModePlan {
  let probe: InkProbe
  let paper: PaperColor | null = null
  try {
    paper = settings.background ?? estimateBackground(pixels, INK_THRESHOLD)
    probe = probeInk(pixels, paper)
  } catch {
    probe = { inks: 0, dominant: null, mono: false, monoInverted: false, inkLuma: null, paperLuma: 255 }
  }

  const wantMono =
    settings.colorMode === 'mono' || (settings.colorMode === 'auto' && (probe.mono || probe.monoInverted))
  if (!wantMono) {
    return { mode: 'color', threshold: fallbackThreshold, invert: false, recolor: null, inks: probe.inks, probe }
  }

  // What the cut has to clear the ink AGAINST.
  //
  // Normally that is the paper. On a TRANSPARENT ground there is no paper
  // luminance to split against — `probeInk` reports 255 by fiat — so white
  // line-art gives ink 255 against paper 255 and a midpoint cut of exactly 255,
  // where whether anything traces at all comes down to floating-point noise
  // (`luma(255,255,255)` is 254.99999999999997, so it currently squeaks through
  // on the right side of `lum < 255` by 3e-14). Alpha already separates the art
  // there — `thresholdToMask` gates on it — so the cut only has to sit clear of
  // the ink on the correct side: aim it at the far end of the range instead.
  const opaqueGround = paper != null && !paper.transparent
  const against =
    opaqueGround || probe.inkLuma == null ? probe.paperLuma : probe.inkLuma >= 128 ? 0 : 255

  return {
    mode: 'mono',
    threshold: monoThreshold({ inkLuma: probe.inkLuma, paperLuma: against }, fallbackThreshold),
    // Light ink on a dark ground: the same one-shape trace, with the cut flipped.
    // A FORCED mono gets it too — without it a white glyph on navy comes back as
    // the paper traced around a hole.
    invert: probe.inkLuma != null && probe.inkLuma > against,
    recolor: probe.dominant,
    inks: probe.inks,
    probe,
  }
}

/** `decideInkMode` applied straight onto a `VectorizeOptions`. */
export function applyInkMode(base: VectorizeOptions, plan: InkModePlan): VectorizeOptions {
  return plan.mode === 'mono'
    ? { ...base, mode: 'mono', threshold: plan.threshold, invert: plan.invert }
    : { ...base, mode: 'color' }
}
