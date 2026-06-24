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
