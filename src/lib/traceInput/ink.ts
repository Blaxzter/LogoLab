// Ink vs paper: how many colours the art is made of, and where a mono cut
// belongs. One-ink art with soft shading traces badly in colour (the palette
// splits each shape along its shading), so it goes mono instead. The sheet, the
// MCP server and the vectorize studio all read this one decision.
//
// Pure: no DOM, no Node APIs, plain pixels in.

import { deltaE76, srgbToLab, type Lab } from '../trace/lab.ts'
import { hairlineCut, type HairlineRead } from './strokeWidth.ts'
import type { VectorizeOptions } from '../../types'

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
    // rs/gs/bs are sorted by now, so this compares the distributions rather
    // than individual samples.
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
/** Fused inks holding less than this share of the ink are not a colour the art
 *  is made of. Applied after fusion (see `probeInk`). */
const MIN_INK_SHARE = 0.02
/**
 * Applied before fusion, only to bound the work: a bucket this small cannot move
 * any ink's mean, and skipping it keeps the O(buckets × inks) fusion off the
 * long tails that shaded JPEG art produces.
 */
const MIN_BUCKET_SHARE = 0.0005
/**
 * Perpendicular distance (CIE76) within which a colour counts as a point on the
 * ramp between the paper and the dominant ink, rather than a second colour.
 * Anti-aliasing and drop shadows mix ink with paper, so they land near the
 * segment joining the two.
 */
const RAMP_DE = 12
/** How far past either end of that segment a mixture may still sit (see `onRamp`). */
const RAMP_T_SLACK = 0.1
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
   * One ink, clearly lighter than the paper (white glyphs on a dark ground) ⇒
   * mono as well, with the cut inverted (`VectorizeOptions.invert`). The colour
   * path would keep the anti-aliasing band as a region of its own and leave dark
   * slivers around every shape.
   */
  monoInverted: boolean
  /**
   * Luminance (Rec.709, 0–255) of the dominant ink (null when there is none)
   * and of the paper: the two values a mono cut has to fall between.
   */
  inkLuma: number | null
  paperLuma: number
}

/** Rec.709 luminance, the weights the tracer's mono mask thresholds on. */
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/**
 * Is `c` a mixture of the paper and the ink rather than a colour of its own?
 *
 * Every anti-aliased edge in an opaque raster is such a mixture, so it lands on
 * the segment `paper → ink` in Lab: small perpendicular distance, with the foot
 * of the perpendicular between the two ends (`t`, with slack for JPEG noise).
 * The `t` bound matters: a darker tone of the same hue projects onto the line at
 * t > 1, beyond the ink, and is a real second tone rather than an edge.
 */
function onRamp(c: Lab, paper: Lab, ink: Lab): boolean {
  const dx = ink[0] - paper[0]
  const dy = ink[1] - paper[1]
  const dz = ink[2] - paper[2]
  const len2 = dx * dx + dy * dy + dz * dz
  if (len2 < 1e-9) return false
  const t = ((c[0] - paper[0]) * dx + (c[1] - paper[1]) * dy + (c[2] - paper[2]) * dz) / len2
  if (t < -RAMP_T_SLACK || t > 1 + RAMP_T_SLACK) return false
  return Math.hypot(c[0] - (paper[0] + t * dx), c[1] - (paper[1] + t * dy), c[2] - (paper[2] + t * dz)) < RAMP_DE
}

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

  // Fuse first, then apply the share floor. Shaded art spreads one colour over
  // many small buckets, none of which clears the floor alone; filtering first
  // would discard most of that ink and leave only whatever was concentrated.
  const entries = [...buckets.values()]
    .filter((e) => e.n >= inkPixels * MIN_BUCKET_SHARE)
    .map((e) => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }))
    .sort((a, b) => b.n - a.n)
  if (entries.length === 0) return none

  // Greedy fusion, biggest first: a tonal variant joins the ink it belongs to.
  // Each host's Lab is cached and refreshed on merge.
  const inks: { n: number; r: number; g: number; b: number; lab: Lab }[] = []
  for (const e of entries) {
    const lab = srgbToLab(e.r, e.g, e.b)
    const host = inks.find((k) => deltaE76(k.lab, lab) < SAME_INK_DE)
    if (host) {
      // Weighted mean, so the dominant tone (not the shadow) names the ink.
      const total = host.n + e.n
      host.r = (host.r * host.n + e.r * e.n) / total
      host.g = (host.g * host.n + e.g * e.n) / total
      host.b = (host.b * host.n + e.b * e.n) / total
      host.n = total
      host.lab = srgbToLab(host.r, host.g, host.b)
    } else {
      inks.push({ ...e, lab })
    }
  }
  inks.sort((a, b) => b.n - a.n)

  const top = inks[0]
  // A colour of its own: enough of the ink to count, and not on the paper→ink
  // ramp (an edge or a drop shadow). On a transparent ground the edges live in
  // alpha and were already dropped by the `< 200` test above.
  const paperLab = bg.transparent ? null : srgbToLab(bg.r, bg.g, bg.b)
  const distinct = inks.filter(
    (k) =>
      k === top ||
      (k.n >= inkPixels * MIN_INK_SHARE && (paperLab == null || !onRamp(k.lab, paperLab, top.lab))),
  )
  const inkLuma = luma(top.r, top.g, top.b)
  return {
    inks: distinct.length,
    dominant: hex(top.r, top.g, top.b),
    // Mono thresholds dark-against-light; a light ink on dark paper needs the
    // cut flipped, which is what `monoInverted` asks the planner for.
    mono: distinct.length === 1 && paperLuma - inkLuma >= MIN_INK_CONTRAST,
    monoInverted: distinct.length === 1 && inkLuma - paperLuma >= MIN_INK_CONTRAST,
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
 * Where a mono trace cuts: halfway between the ink and the paper luminance, or
 * `fallback` when there is no ink. A fixed 128 assumes black on white and
 * misses light inks on light paper entirely.
 */
export function monoThreshold(probe: Pick<InkProbe, 'inkLuma' | 'paperLuma'>, fallback: number): number {
  if (probe.inkLuma == null) return fallback
  return Math.round((probe.inkLuma + probe.paperLuma) / 2)
}

/* ------------------------------------------- putting the cut in a real gap */

// The midpoint is only meaningful when ink and paper really are two
// populations. On full-bleed art (a gradient card, a photo) the border ring is
// not a clean paper sample, and the midpoint can land inside one population and
// split it into a blob. The test is whether the cut has pixels on it; the
// repair is to slide it to the nearest luminance the image leaves empty.

/** A luma bin holding less than this share of the visible pixels is a gap. */
const GAP_BIN_SHARE = 0.002
/** Narrower than this (luma units) and a gap is histogram noise, not a real one. */
const MIN_GAP_WIDTH = 12
/**
 * A gap only separates if both sides of it hold this much of the image; the
 * empty run below the darkest pixel is a gap too, but a cut there selects nothing.
 */
const MIN_GAP_SIDE_SHARE = 0.01
/** Mass within ±`GAP_PROBE_RADIUS` of the cut above which the cut is inside a
 *  population rather than between two, and gets moved. */
const CUT_ON_INK_SHARE = 0.02
const GAP_PROBE_RADIUS = 4
/** A move that would ink this much of the image yields a filled square rather
 *  than a shape, so it is refused. */
const DEGENERATE_SOLID = 0.9

/* ------------------------------------------------ what a mono cut looks at */

/** Below this alpha a pixel is invisible to the cut and to every readout that
 *  mirrors it. */
export const VISIBLE_ALPHA = 16

/**
 * The luminance a mono cut compares for pixel `i`: its Rec.709 luma composited
 * over the paper the cut assumes (white normally, black when `invert`). Opaque
 * pixels are untouched.
 *
 * This makes the cut a coverage cut on art over transparency, where the
 * anti-aliasing lives in alpha: a half-covered black pixel reads 128, so the
 * mask edge is the iso-0.5 coverage contour. Don't read the raw RGB luma
 * instead: every pixel with any alpha would count as ink and each stroke would
 * trace a pixel fatter than drawn.
 *
 * `thresholdToMask` (trace/index.ts), `inkMask` (strokeWidth.ts) and the three
 * readouts below all go through here so they cannot disagree with the mask.
 */
export function cutLuma(d: Uint8ClampedArray, i: number, invert: boolean): number {
  const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  const a = d[i + 3]
  if (a === 255) return lum
  const k = a / 255
  return invert ? lum * k : lum * k + 255 * (1 - k)
}

/** Histogram of `cutLuma` over the visible pixels, so the bins are the mask's own. */
function lumaHistogram(img: ImageDataLike, invert: boolean): { bins: Float64Array; visible: number } {
  const bins = new Float64Array(256)
  const d = img.data
  let visible = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < VISIBLE_ALPHA) continue
    bins[Math.round(cutLuma(d, i, invert))]++
    visible++
  }
  return { bins, visible }
}

/**
 * Slide `cut` to the nearest luminance the image leaves empty, when it is
 * sitting in the middle of a population.
 *
 * Conservative so a cut that already sits in a gap is never touched: it acts
 * only when there is real mass on the cut, moves to the nearest gap rather than
 * the widest, and refuses a move that would ink almost everything. A pure ramp
 * has no gap and keeps its cut.
 */
export function snapCutToGap(img: ImageDataLike, cut: number, invert: boolean): number {
  const { bins, visible } = lumaHistogram(img, invert)
  if (visible === 0) return cut

  let onCut = 0
  for (let i = Math.max(0, cut - GAP_PROBE_RADIUS); i <= Math.min(255, cut + GAP_PROBE_RADIUS); i++) onCut += bins[i]
  if (onCut < visible * CUT_ON_INK_SHARE) return cut

  const gapBin = visible * GAP_BIN_SHARE
  const side = visible * MIN_GAP_SIDE_SHARE
  const below = new Float64Array(257)
  for (let i = 0; i < 256; i++) below[i + 1] = below[i] + bins[i]

  let best = cut
  let bestDistance = Infinity
  let start = -1
  for (let i = 0; i <= 256; i++) {
    const sparse = i < 256 && bins[i] < gapBin
    if (sparse && start < 0) start = i
    if (!sparse && start >= 0) {
      const end = i - 1
      const separates = below[start] >= side && visible - below[end + 1] >= side
      if (separates && end - start + 1 >= MIN_GAP_WIDTH) {
        const distance = cut < start ? start - cut : cut > end ? cut - end : 0
        if (distance < bestDistance) {
          bestDistance = distance
          best = Math.round((start + end) / 2)
        }
      }
      start = -1
    }
  }
  if (best === cut || cutFraction(img, best, invert) >= DEGENERATE_SOLID) return cut
  return best
}

export interface InkModePlan {
  /** What the tracer should run as. */
  mode: 'color' | 'mono'
  /** Mono cut, between the ink and the paper. Meaningless in colour mode. */
  threshold: number
  /** Light ink on dark paper: flip the cut. Always false in colour mode. */
  invert: boolean
  /**
   * The ink's real colour (#rrggbb) to repaint the mono trace with (a mono trace
   * comes back `#000`). Null in colour mode, or when there is no ink.
   */
  recolor: string | null
  /** Distinct inks the probe saw, so the UI can explain the choice. */
  inks: number
  /** The probe itself, for callers that want to explain more than `inks`. */
  probe: InkProbe
  /**
   * What the thin-ink read did to the cut (strokeWidth.ts `hairlineCut`).
   * `cut !== from` means the cut was raised for hairlines. Null in colour mode.
   */
  hairlines: HairlineRead | null
}

/**
 * Colour vs mono, the mono cut, and whether to invert it, decided from pixels.
 * Tonal variants of one ink are fused first; the colour path is taken only when
 * more than one ink remains.
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
    return { mode: 'color', threshold: fallbackThreshold, invert: false, recolor: null, inks: probe.inks, probe, hairlines: null }
  }

  // What the cut separates the ink from: normally the paper. On a transparent
  // ground `probeInk` reports paper luma 255 by fiat, so white line-art would get
  // a midpoint cut of exactly 255 and trace only by floating-point luck
  // (luma(255,255,255) is 254.99999999999997). Don't simplify this back to the
  // plain midpoint. Alpha already separates the art there, so aim the cut at the
  // far end of the range instead.
  const opaqueGround = paper != null && !paper.transparent
  const against =
    opaqueGround || probe.inkLuma == null ? probe.paperLuma : probe.inkLuma >= 128 ? 0 : 255

  const midpoint = monoThreshold({ inkLuma: probe.inkLuma, paperLuma: against }, fallbackThreshold)
  // Light ink on a dark ground: flip the cut. A forced mono needs this too, or a
  // white glyph on navy traces as the paper around a hole.
  const invert = probe.inkLuma != null && probe.inkLuma > against
  // On a transparent ground keep the aimed cut: alpha separates the art, and a
  // gap between tones of the ink is not somewhere to pull it.
  const placed = opaqueGround ? snapCutToGap(pixels, midpoint, invert) : midpoint
  // Strokes thinner than a pixel never reach 50% coverage and would vanish, so
  // the hairline read may raise the cut (strokeWidth.ts, hairlineCut).
  const hairlines = hairlineCut(pixels, placed, invert, probe.inkLuma == null ? 255 : Math.abs(against - probe.inkLuma))
  return {
    mode: 'mono',
    threshold: hairlines.cut,
    invert,
    recolor: probe.dominant,
    inks: probe.inks,
    probe,
    hairlines,
  }
}

/* ------------------------------------------------- what a mono cut admits */

// A mono cut can select nothing (all ink on one side of the threshold) and
// yield an empty trace. These readouts let the panel show that on the control
// itself, before the blank happens.

/**
 * Fraction of the image's visible pixels a mono cut turns solid, in [0,1].
 * Mirrors `thresholdToMask` exactly (same `cutLuma`, visibility gate and strict
 * comparison): a readout that disagrees with the mask is worse than none. One
 * O(pixels) pass, cheap enough to recompute while dragging.
 */
export function cutFraction(img: ImageDataLike, cut: number, invert = false): number {
  const d = img.data
  const c = Math.max(0, Math.min(255, Math.round(cut)))
  let visible = 0
  let solid = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < VISIBLE_ALPHA) continue
    visible++
    const lum = cutLuma(d, i, invert)
    if (invert ? lum > c : lum < c) solid++
  }
  return visible === 0 ? 0 : solid / visible
}

/**
 * Luminance span of the visible pixels: the range a mono cut must land inside
 * to select some of them but not all. Without invert a cut at or under `min`
 * selects nothing; with invert a cut at or over `max` does. Those are the dead
 * zones the Threshold slider shades. Each end is read with the matching
 * `cutLuma` compositing. Null when no pixel is visible.
 */
export function inkLumaRange(img: ImageDataLike): { min: number; max: number; visible: number } | null {
  const d = img.data
  let min = Infinity
  let max = -Infinity
  let visible = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < VISIBLE_ALPHA) continue
    visible++
    const off = cutLuma(d, i, false)
    const on = cutLuma(d, i, true)
    if (off < min) min = off
    if (on > max) max = on
  }
  return visible === 0 ? null : { min, max, visible }
}

/** `decideInkMode` applied straight onto a `VectorizeOptions`. */
export function applyInkMode(base: VectorizeOptions, plan: InkModePlan): VectorizeOptions {
  return plan.mode === 'mono'
    ? { ...base, mode: 'mono', threshold: plan.threshold, invert: plan.invert }
    : { ...base, mode: 'color' }
}
