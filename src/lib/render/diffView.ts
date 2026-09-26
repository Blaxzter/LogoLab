// The studio's Difference view: the picture and the under-cursor readout. Pure
// (no DOM) so it is testable; the pane only paints the buffers.
//
// The ΔE heat is laid over a dim greyscale ghost of the source so a hot spot
// has a location on the art. The ghost must not become a second measurement:
//  - From `HEAT_OPAQUE_DE` up the picture is the heat byte for byte; below it
//    the heat fades into the ghost in proportion to the same `de` field the
//    numbers came from. Nothing is recomputed or re-tinted.
//  - The ghost stays below `GHOST_MAX`, darker than every warm ramp stop.
//
// The readout (`probeDiff`) reports the scored bytes (source composited over
// white as the metric does, the render as scored, the field value), not a
// re-measurement of the screen.

import { HEAT_BG_RGB } from '../heat.ts'
import { HEAT_FULL_SCALE_DE, HEAT_FLOOR } from './fidelity.ts'

/** Brightest grey the ghost reaches (0–255). */
export const GHOST_MAX = 72

/** ΔE from which the heat is fully opaque over the ghost. Below it the heat mixes
 *  in proportionally down to the ramp's floor, under which a pixel is pure ghost. */
export const HEAT_OPAQUE_DE = 5

/** Rec.709 luma, 0–255 in, 0–255 out. */
const luma = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

/**
 * Compose the Difference picture: `heat` (RGBA from `deltaEHeat`) over a ghost of
 * `source` (RGBA, alpha intact), blended by `de` (one ΔE per pixel). Returns an
 * opaque RGBA buffer ready for `putImageData`.
 */
export function diffPicture(
  heat: Uint8ClampedArray,
  de: ArrayLike<number>,
  source: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8ClampedArray {
  const n = width * height
  const out = new Uint8ClampedArray(n * 4)
  const floorDe = HEAT_FLOOR * HEAT_FULL_SCALE_DE
  const span = HEAT_OPAQUE_DE - floorDe
  const [bgR, bgG, bgB] = HEAT_BG_RGB
  for (let i = 0; i < n; i++) {
    const o = i * 4
    // Ghost: alpha-weighted source luma, from the backdrop (transparent) up to
    // GHOST_MAX (white).
    const y = (luma(source[o], source[o + 1], source[o + 2]) / 255) * (source[o + 3] / 255)
    const gR = bgR + (GHOST_MAX - bgR) * y
    const gG = bgG + (GHOST_MAX - bgG) * y
    const gB = bgB + (GHOST_MAX - bgB) * y
    // Heat opacity from the field: 0 at the ramp's floor, 1 from HEAT_OPAQUE_DE.
    const a = Math.min(1, Math.max(0, (de[i] - floorDe) / span))
    out[o] = gR + (heat[o] - gR) * a
    out[o + 1] = gG + (heat[o + 1] - gG) * a
    out[o + 2] = gB + (heat[o + 2] - gB) * a
    out[o + 3] = 255
  }
  return out
}

/** What the readout says about one pixel. */
export interface DiffProbe {
  /** Pixel coordinates in the scored raster. */
  x: number
  y: number
  /** CIE76 ΔE at that pixel, straight from the field. */
  deltaE: number
  /** The source colour that was scored: its alpha composited over white, as the metric does. */
  source: [number, number, number]
  /** The rendered colour that was scored. */
  render: [number, number, number]
}

/** The buffers `probeDiff` reads — the relevant half of the studio's TraceScore. */
export interface DiffBuffers {
  width: number
  height: number
  de: ArrayLike<number>
  source: Uint8ClampedArray | Uint8Array
  render: Uint8ClampedArray | Uint8Array
}

/**
 * Read the field at a normalized position (0–1 across the scored raster, as a
 * pointer over the fitted box reports it). Null outside the raster.
 */
export function probeDiff(buf: DiffBuffers, nx: number, ny: number): DiffProbe | null {
  const x = Math.floor(nx * buf.width)
  const y = Math.floor(ny * buf.height)
  if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) return null
  const i = y * buf.width + x
  const o = i * 4
  const a = buf.source[o + 3] / 255
  const over = (c: number): number => Math.round(c * a + 255 * (1 - a))
  return {
    x,
    y,
    deltaE: buf.de[i],
    source: [over(buf.source[o]), over(buf.source[o + 1]), over(buf.source[o + 2])],
    render: [buf.render[o], buf.render[o + 1], buf.render[o + 2]],
  }
}
