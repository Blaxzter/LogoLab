// Shared types for the raster → vector tracing pipeline.

/** Progress callback payloads emitted while a trace runs. */
export type TraceProgress =
  | { phase: 'quantize' }
  | { phase: 'trace'; layer: number; total: number }

/** An opaque RGB palette entry produced by quantization. */
export interface PaletteColor {
  r: number
  g: number
  b: number
}

/** Result of color quantization over an ImageData. */
export interface QuantizeResult {
  palette: PaletteColor[]
  /**
   * Per-pixel palette index (row-major, width × height); -1 marks transparent
   * pixels (alpha < 128) that belong to no layer.
   */
  labels: Int32Array
  /** Opaque-pixel count per palette entry (parallel to `palette`). */
  counts: number[]
}
