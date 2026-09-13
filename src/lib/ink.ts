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

import { deltaE76, srgbToLab, type Lab } from './trace/lab.ts'
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
/** Fused inks holding less than this share of the ink are not a colour the art
 *  is made of. Applied AFTER fusion — see `probeInk`. */
const MIN_INK_SHARE = 0.02
/**
 * …and applied BEFORE it, only to bound the work: a 5-bit bucket this small
 * cannot move any ink's mean, and skipping the tail keeps the O(buckets × inks)
 * fusion off the 3000-bucket tails that shaded JPEG art produces.
 */
const MIN_BUCKET_SHARE = 0.0005
/**
 * Perpendicular distance (CIE76) within which a colour counts as a point on the
 * ramp between the paper and the dominant ink, rather than a second colour.
 *
 * Anti-aliasing and drop shadows MIX the ink with the paper, so they land on the
 * segment joining the two — the measured spread around it is 0–9 on real sheets,
 * against 13+ for the nearest genuine second colour.
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

/**
 * Is `c` a MIXTURE of the paper and the ink rather than a colour of its own?
 *
 * Every edge in an opaque raster is such a mixture: the renderer blended the two
 * before the pixels were saved, so the fringe of a black glyph on white is a run
 * of greys and the fringe of a white glyph on navy is a run of slate. Those land
 * on the straight segment `paper → ink` in Lab, which is what this measures —
 * perpendicular distance small, and the foot of the perpendicular between the two
 * ends (`t`, with a little slack for JPEG noise).
 *
 * The `t` bound is what keeps it honest: a colour that is the same HUE as the ink
 * but darker projects onto the line too, at t > 1 — the far side of the ink,
 * where no paper is mixed in. That is a second tone the art actually has (the
 * two-tone blue of the travel sheet's tile 01, t = 1.8), not an edge.
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

  // FUSE FIRST, then apply the share floor — not the other way round.
  //
  // These buckets are 5 bits per channel, and shaded art spreads one colour over
  // dozens of them: a red balloon with a highlight and a shadow is 20 buckets of
  // ~1% each, none of which clears a 2% floor on its own. Filtering here used to
  // throw away 71–84% of the ink on such a tile and leave only whatever WAS
  // concentrated — the flat grey of a card's border — so ten colourful icons
  // reported "1 ink" and traced as flat grey silhouettes. Fusion is what turns
  // those 20 buckets back into one 12% red, and the floor belongs after it.
  const entries = [...buckets.values()]
    .filter((e) => e.n >= inkPixels * MIN_BUCKET_SHARE)
    .map((e) => ({ n: e.n, r: e.r / e.n, g: e.g / e.n, b: e.b / e.n }))
    .sort((a, b) => b.n - a.n)
  if (entries.length === 0) return none

  // Greedy fusion, biggest first: a tonal variant joins the ink it belongs to.
  // (The host's Lab is cached and refreshed on merge — the whole tail runs
  // through this loop now, so recomputing it per comparison would be the cost.)
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
  // What survives as a colour of its own: enough of the ink to count, and not a
  // point on the paper→ink ramp (an edge or a drop shadow). The ramp test needs
  // a paper colour to mix WITH — on a transparent ground the edges are in the
  // alpha channel, and `data[i + 3] < 200` above already dropped them.
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

/* ------------------------------------------- putting the cut in a real gap */

// The midpoint above is only meaningful when the ink and the paper really ARE
// two populations. `estimateBackground` reads the paper off the border ring, and
// on full-bleed art — a gradient card, a photo — that ring does not agree with
// itself: nebula gives paper rgb(125,59,215) at 21% coverage, `uniform` false, so
// 79% of the image (the gradient) is counted as ink and the "dominant ink" comes
// back as the purple rather than the white ring drawn on it. The cut then lands
// at 98, halfway between the gradient and itself — INSIDE one population, which
// splits it down the middle and inks 62% of the square as one blob.
//
// The art is cleanly separable and the histogram says so: everything but the
// white marks sits below luma 112, so any cut from 130 to 254 traces the ring and
// the dot in 16 nodes. What is wrong with 98 is not that it is far from that
// range but that it has PIXELS ON IT. So that is the test, and the repair is to
// slide the cut to the nearest luminance the image genuinely leaves empty.

/** A luma bin holding less than this share of the visible pixels is a gap. */
const GAP_BIN_SHARE = 0.002
/** Narrower than this (luma units) and a gap is histogram noise, not a real one. */
const MIN_GAP_WIDTH = 12
/**
 * …and a gap only SEPARATES if both sides of it hold this much of the image. The
 * empty run below the darkest pixel is a gap by arithmetic and a cut placed there
 * selects nothing — the failure #47 exists to make visible.
 */
const MIN_GAP_SIDE_SHARE = 0.01
/** Mass within ±`GAP_PROBE_RADIUS` of the cut above which the cut is inside a
 *  population rather than between two — the whole trigger for moving it. */
const CUT_ON_INK_SHARE = 0.02
const GAP_PROBE_RADIUS = 4
/** A move that would ink this much of the image produces no shape, just a filled
 *  square — refuse it and keep the cut where it was. */
const DEGENERATE_SOLID = 0.9

/** Rec.709 luma histogram of the VISIBLE pixels — the same weights and the same
 *  `alpha >= 16` gate as `thresholdToMask`, so the bins are the mask's own. */
function lumaHistogram(img: ImageDataLike): { bins: Float64Array; visible: number } {
  const bins = new Float64Array(256)
  const d = img.data
  let visible = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue
    bins[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++
    visible++
  }
  return { bins, visible }
}

/**
 * Slide `cut` to the nearest luminance the image leaves empty, when it is
 * sitting in the middle of a population.
 *
 * Deliberately conservative in three ways, because every case whose cut already
 * lands in a gap is one this must not touch: it only acts when there is real mass
 * ON the cut; it moves to the NEAREST gap rather than the widest (a cut one unit
 * below a gap belongs in that gap, not in a bigger one at the far end); and it
 * refuses a move that would ink almost everything. A pure ramp — the `bg-ramp`
 * fixtures, `radial-glow` — has no gap anywhere and keeps the cut it had.
 */
export function snapCutToGap(img: ImageDataLike, cut: number, invert: boolean): number {
  const { bins, visible } = lumaHistogram(img)
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

  const midpoint = monoThreshold({ inkLuma: probe.inkLuma, paperLuma: against }, fallbackThreshold)
  // Light ink on a dark ground: the same one-shape trace, with the cut flipped.
  // A FORCED mono gets it too — without it a white glyph on navy comes back as
  // the paper traced around a hole.
  const invert = probe.inkLuma != null && probe.inkLuma > against
  return {
    mode: 'mono',
    // …and on a TRANSPARENT ground, leave the cut where the branch above aimed
    // it: alpha is what separates the art there, so the luminance cut is only
    // required to stay clear of the ink, and a "gap" between tones of the ink is
    // not somewhere it should be pulled.
    threshold: opaqueGround ? snapCutToGap(pixels, midpoint, invert) : midpoint,
    invert,
    recolor: probe.dominant,
    inks: probe.inks,
    probe,
  }
}

/* ------------------------------------------------- what a mono cut admits */

// A mono cut is the one setting in the studio that can silently produce NOTHING:
// it is a single global threshold, and an image whose ink all sits on one side of
// it yields an empty mask. The tracer is right to return nothing — the user asked
// for pixels that do not exist — but a control that can reach such a state without
// saying so is the actual defect (#47). These two let the panel show the
// consequence on the control itself, so the blank is visible before it happens.

/**
 * Fraction of the image's VISIBLE pixels a mono cut turns solid, in [0,1].
 *
 * Mirrors `thresholdToMask` exactly — same Rec.709 weights, same `alpha >= 16`
 * gate, same strict comparison — because a readout that disagreed with the mask
 * by even one pixel at the boundary would be worse than no readout. One O(pixels)
 * pass; ~1.5 ms on a 512px raster, so it is fine to recompute while dragging.
 */
export function cutFraction(img: ImageDataLike, cut: number, invert = false): number {
  const d = img.data
  const c = Math.max(0, Math.min(255, Math.round(cut)))
  let visible = 0
  let solid = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue
    visible++
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    if (invert ? lum > c : lum < c) solid++
  }
  return visible === 0 ? 0 : solid / visible
}

/**
 * Luminance span of the visible pixels — the range a mono cut has to land inside
 * to select some of them but not all.
 *
 * With the cut OFF the ink is what falls BELOW it, so any cut at or under `min`
 * selects nothing; with it ON the ink is what rises above, so any cut at or over
 * `max` selects nothing. Those are the dead zones the Threshold slider shades.
 * Null when the image has no visible pixels at all.
 */
export function inkLumaRange(img: ImageDataLike): { min: number; max: number; visible: number } | null {
  const d = img.data
  let min = Infinity
  let max = -Infinity
  let visible = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 16) continue
    visible++
    const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    if (lum < min) min = lum
    if (lum > max) max = lum
  }
  return visible === 0 ? null : { min, max, visible }
}

/** `decideInkMode` applied straight onto a `VectorizeOptions`. */
export function applyInkMode(base: VectorizeOptions, plan: InkModePlan): VectorizeOptions {
  return plan.mode === 'mono'
    ? { ...base, mode: 'mono', threshold: plan.threshold, invert: plan.invert }
    : { ...base, mode: 'color' }
}
