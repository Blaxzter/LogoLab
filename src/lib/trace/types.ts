// Shared types for the raster → vector tracing pipeline.

/**
 * Progress update emitted while a trace runs — drives the studio's progress bar.
 * `fraction` is monotonic across a run (segmentation → paint → trace); `label` is the
 * human-readable status to show beside the bar.
 */
export interface TraceProgress {
  /** Coarse stage, for callers that want to branch on it. */
  phase: 'segment' | 'paint' | 'trace'
  /** Overall completion in [0,1], monotonic across the run. */
  fraction: number
  /** Human-readable status, e.g. "Merging regions (320 left)". */
  label: string
}

/** An RGB palette entry produced by quantization. */
export interface PaletteColor {
  r: number
  g: number
  b: number
  /**
   * Optional alpha 0–255. Undefined ⇒ fully opaque (the common case). Only the
   * FLAT palette path populates it — the auto path from each region's alpha MODE,
   * a locked palette from the user's RGBA swatches — and only when < 255, so opaque
   * art carries no alpha and serializes byte-identically. The Mumford–Shah path and
   * k-means quantize never set it.
   */
  a?: number
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
