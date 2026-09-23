// What to trace ONE tile with — the part that is pure, and therefore testable.
//
// (The gradient seeding on top of this lives in traceTile.ts, which reaches for
// the tracer and a Worker and so is browser-only.)

import { decideInkMode, type InkColorMode } from '../ink.ts'
import { monoTraceScale, traceScale } from '../traceCaps.ts'
import type { ImageDataLike, SheetBackground } from './types'
import type { VectorizeOptions } from '../../types'

// The size rule lived here first; it moved next to the raster cap so the studio
// and the MCP server enlarge a small mono raster exactly as the sheet does.
export { traceScale }

/** How the sheet decides colour vs mono: per tile, or forced. The decision
 *  itself is `decideInkMode` (src/lib/ink.ts) — shared with the studio. */
export type SheetColorMode = InkColorMode

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
  const ink = decideInkMode(pixels, base.threshold, settings)
  const wantMono = ink.mode === 'mono'

  const long = Math.max(pixels.width, pixels.height)
  // Enlarging pays off for the MONO path, where a finer lattice buys sub-pixel
  // threshold placement — by the tile's size (toward ~512px) and by the thickness
  // of its thin ink (toward ~3px), whichever asks for more; see traceCaps.ts for
  // both measurements. The colour path gains accuracy too, but at a price no
  // icon wants: measured on the same tiles, colour at 4× went from 93 to 1465
  // nodes and 69ms to 1193ms — the palette segmentation follows every
  // interpolated tone. So colour stays native.
  const scale =
    settings.hiRes !== false && wantMono
      ? monoTraceScale(pixels, { ...base, mode: 'mono', threshold: ink.threshold, invert: ink.invert }).scale
      : 1
  const opts: VectorizeOptions = {
    // Smoothing follows the raster the tracer will actually see, so the two
    // scale corrections compose instead of fighting: at 3× a 170px tile gets
    // smoothing 25, which is exactly where the measured optimum sits.
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
