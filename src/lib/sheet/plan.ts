// Pure per-tile trace planning. Gradient seeding on top of this lives in the
// browser-only traceTile.ts.

import { decideInkMode, type InkColorMode } from '../traceInput/ink.ts'
import { monoTraceScale, traceScale } from '../traceInput/traceCaps.ts'
import type { ImageDataLike, SheetBackground } from './types'
import type { VectorizeOptions } from '../../types'

export { traceScale }

/** Colour vs mono: per tile (`decideInkMode`, shared with the studio) or forced. */
export type SheetColorMode = InkColorMode

/**
 * Raster size the `smoothing` slider was calibrated on. Smoothing is an absolute
 * curve-fit tolerance, so on a small tile it is scaled down; otherwise features
 * a few pixels wide (the hole of a ring) melt shut.
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
 * Choose mode and smoothing for one tile. A sheet icon is usually one shaded ink
 * on paper; the colour path would split the shading into palette entries and
 * carve the shape along them, so the colour path is taken only when there is
 * more than one ink.
 */
export function planTileBase(
  pixels: ImageDataLike,
  base: VectorizeOptions,
  settings: { colorMode: SheetColorMode; background: SheetBackground | null; hiRes?: boolean },
): TileBasePlan {
  const ink = decideInkMode(pixels, base.threshold, settings)
  const wantMono = ink.mode === 'mono'

  const long = Math.max(pixels.width, pixels.height)
  // Only mono tiles are enlarged (see traceCaps.ts); colour segmentation would
  // follow every interpolated tone.
  const scale =
    settings.hiRes !== false && wantMono
      ? monoTraceScale(pixels, { ...base, mode: 'mono', threshold: ink.threshold, invert: ink.invert }).scale
      : 1
  const opts: VectorizeOptions = {
    // Smoothing follows the raster the tracer actually sees, so enlargement and
    // smoothing scaling compose.
    ...base,
    smoothing: tileSmoothing(base.smoothing, long * scale),
  }
  return wantMono
    ? // Mono paints #000; the probe knows the ink's real colour, so hand it back.
      {
        opts: { ...opts, mode: 'mono', threshold: ink.threshold, invert: ink.invert },
        recolor: ink.recolor,
        inks: ink.inks,
        color: false,
        scale,
      }
    : { opts: { ...opts, mode: 'color' }, recolor: null, inks: ink.inks, color: true, scale }
}
