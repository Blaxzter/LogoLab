// What to trace ONE tile with — the part that is pure, and therefore testable.
//
// (The gradient seeding on top of this lives in traceTile.ts, which reaches for
// the tracer and a Worker and so is browser-only.)

import { estimateBackground } from './detect.ts'
import { probeInk, type InkProbe } from './inkProbe.ts'
import type { ImageDataLike, SheetBackground } from './types'
import type { VectorizeOptions } from '../../types'

/** How the sheet decides colour vs mono: per tile, or forced. */
export type SheetColorMode = 'auto' | 'color' | 'mono'

/**
 * Raster size the `smoothing` slider was calibrated on (the single-logo path
 * traces at 1024–2048px).
 *
 * Smoothing is an ABSOLUTE curve-fit tolerance, and a sheet tile is a fraction of
 * that size — a 170px icon at the default 50 loses features a few pixels wide, so
 * the ring of a "hole/cup" glyph melts shut and the icon exports as a solid blob.
 * Measured over 54 real tiles: the traced ink area drifts from the source's by
 * 2.02pp at 50 and 0.77pp at 12, with the SAME node count (73 vs 75) — the
 * smoothing was buying nothing and costing interiors.
 */
const SMOOTHING_REFERENCE_PX = 1024
/** Never below this, or the fit chases anti-aliasing. */
const MIN_SMOOTHING = 8

/** Scale an absolute-pixel tolerance to what a tile of this size deserves. */
export function tileSmoothing(base: number, longSide: number): number {
  if (base <= 0) return 0
  const scaled = (base * longSide) / SMOOTHING_REFERENCE_PX
  return Math.round(Math.min(base, Math.max(MIN_SMOOTHING, scaled)))
}

/** Working resolution a tile is traced at (long side, px). */
const TRACE_TARGET_PX = 512
/** Beyond this the extra pixels stop paying for themselves (measured). */
const MAX_TRACE_SCALE = 3

/**
 * How much to enlarge a tile before tracing.
 *
 * Anti-aliasing encodes sub-pixel coverage that a pixel-lattice tracer cannot use
 * at 1:1. Measured over 54 real 170px tiles, rendering each result back down to
 * native for a fair comparison:
 *
 *   1×  ink-area drift 0.75pp, 4 tiles visibly wrong, 75 nodes, SSIM 0.864,  44ms
 *   2×                  0.41pp, 2 tiles,             102 nodes, SSIM 0.930,  77ms
 *   3×                  0.13pp, 0 tiles,             118 nodes, SSIM 0.946, 112ms
 *   4×                  0.14pp, 0 tiles,             135 nodes, SSIM 0.951, 142ms
 *
 * 4× buys nothing over 3×, so the target is ~512px and the factor is capped at 3.
 * (An earlier measurement said upscaling was catastrophic — that was an artifact:
 * `rasterizeDoc` renders one viewBox unit per output pixel, so scoring an enlarged
 * doc in a native-size buffer silently CROPPED it. Render at the doc's own size
 * and box-average down before comparing.)
 */
export function traceScale(longSide: number): number {
  if (longSide <= 0) return 1
  return Math.max(1, Math.min(MAX_TRACE_SCALE, Math.round(TRACE_TARGET_PX / longSide)))
}

/**
 * Where a mono trace cuts. The studio's default (128) assumes black ink on white
 * paper; a sheet knows both the ink and the paper, so the cut goes halfway
 * between them. Without this an orange ticket (luma 174) on cream paper (244)
 * sits ABOVE the default cut — on the paper side — and the tile traces to
 * nothing (0 paths on the travel example's tile 08).
 */
export function monoThreshold(probe: Pick<InkProbe, 'inkLuma' | 'paperLuma'>, fallback: number): number {
  if (probe.inkLuma == null) return fallback
  return Math.round((probe.inkLuma + probe.paperLuma) / 2)
}

export interface TileBasePlan {
  /** Options with the per-tile mode and smoothing applied. */
  opts: VectorizeOptions
  /** Repaint the traced doc to this fill (mono traces come back black). */
  recolor: string | null
  /** What the ink probe saw — surfaced so the UI can explain the choice. */
  inks: number
  /** True when the caller should still seed `gradients` from a probe. */
  color: boolean
  /** Enlarge the crop by this integer factor before tracing (see `traceScale`). */
  scale: number
}

/**
 * Choose mode and smoothing for one tile.
 *
 * The decision that matters is colour vs mono. A sheet icon is usually one ink on
 * paper, and that ink carries soft shading; the colour path keeps the shading's
 * tones as separate palette entries and carves every shape along the line where
 * the assignment flips (measured on a real sheet: a disc lost its upper-left arc,
 * 4 paths / 191 nodes). Mono has no palette to split — the same icon comes back as
 * one clean shape at 33 nodes. So: count the inks, and only take the colour path
 * when there really is more than one.
 */
export function planTileBase(
  pixels: ImageDataLike,
  base: VectorizeOptions,
  settings: { colorMode: SheetColorMode; background: SheetBackground | null; hiRes?: boolean },
): TileBasePlan {
  let probe: InkProbe
  try {
    probe = probeInk(pixels, settings.background ?? estimateBackground(pixels, 24))
  } catch {
    probe = { inks: 0, dominant: null, mono: false, monoInverted: false, inkLuma: null, paperLuma: 255 }
  }

  const long = Math.max(pixels.width, pixels.height)
  const wantMono =
    settings.colorMode === 'mono' || (settings.colorMode === 'auto' && (probe.mono || probe.monoInverted))
  // Light ink on dark paper: the same one-shape trace, with the cut flipped. A
  // forced mono gets it too — without it a white glyph on navy comes back as the
  // paper traced around a hole.
  const invert = wantMono && probe.inkLuma != null && probe.inkLuma > probe.paperLuma
  // Enlarging pays off for the MONO path, where a finer lattice buys sub-pixel
  // threshold placement. The colour path gains accuracy too, but at a price no
  // icon wants: measured on the same tiles, colour at 4× went from 93 to 1465
  // nodes and 69ms to 1193ms — the palette segmentation follows every
  // interpolated tone. So colour stays native.
  const scale = settings.hiRes !== false && wantMono ? traceScale(long) : 1
  const opts: VectorizeOptions = {
    // Smoothing follows the raster the tracer will actually see, so the two
    // scale corrections compose instead of fighting: at 3× a 170px tile gets
    // smoothing 25, which is exactly where the measured optimum sits.
    ...base,
    smoothing: tileSmoothing(base.smoothing, long * scale),
  }
  return wantMono
    ? // Mono paints #000; the sheet knows the ink's real colour, so hand it back.
      {
        opts: { ...opts, mode: 'mono', threshold: monoThreshold(probe, base.threshold), invert },
        recolor: probe.dominant,
        inks: probe.inks,
        color: false,
        scale,
      }
    : { opts: { ...opts, mode: 'color' }, recolor: null, inks: probe.inks, color: true, scale }
}
