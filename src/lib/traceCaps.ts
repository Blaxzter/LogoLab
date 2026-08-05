// Long-side cap for the raster the tracer sees.
//
// Flat art (mono, or colour with gradients OFF) traces at full 2048 for crisp
// corners / sub-pixel edges; colour art WITH gradients stays at 1024 to bound the
// O(S²) Step-3c field-merge (which froze on complex photos — see memory +
// crispness-study). Measured on Schild.png: 1024→2048 cut meanΔE 0.96→0.78 and
// lifted SSIM +0.024, at ~4× trace time.
//
// This is a UI-side policy, not a tracer parameter (`VectorizeOptions.traceDetail`
// is read here and nowhere inside src/lib/trace) — it lives in its own module so
// the vectorize studio and the icon-sheet batch cap identically.

import type { VectorizeOptions } from '../types'

export const RASTER_MAX_DIM = 1024
export const RASTER_MAX_DIM_FLAT = 2048
/**
 * "High" detail cap for flat art (gradients-off / mono). Bounded — not native —
 * so a huge upload can't blow up trace time/memory. Rasters are never upscaled,
 * so this only bites when the source's longest side exceeds RASTER_MAX_DIM_FLAT.
 */
export const RASTER_MAX_DIM_HIGH = 4096

export function rasterCapFor(opts: VectorizeOptions): number {
  const isFlat = opts.mode === 'mono' || opts.gradients === false
  const flatCap = opts.traceDetail === 'high' ? RASTER_MAX_DIM_HIGH : RASTER_MAX_DIM_FLAT
  return isFlat ? flatCap : RASTER_MAX_DIM
}
