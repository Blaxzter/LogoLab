// Web Worker that scores a traced document against its source image. Scoring is
// O(w·h) per path and reruns on every committed node edit, so it stays off the
// main thread. No DOM needed: rasterizeDoc renders the doc model directly.

import { rasterizeDoc } from './raster.ts'
import { deltaEField, deltaEStats, deltaEHeat } from './fidelity.ts'
import type { EditableDoc } from '../path/types'

export interface ScoreReq {
  type: 'score'
  doc: EditableDoc
  /** The source raster, already at the scoring resolution. */
  source: { width: number; height: number; data: Uint8ClampedArray }
  /** Output pixels per viewBox unit — see RasterOptions.scale. */
  scale: number
}

export interface ScoreRes {
  type: 'result'
  meanDeltaE: number
  p95DeltaE: number
  width: number
  height: number
  /** ΔE painted on the shared cold→hot ramp, ready for putImageData. */
  heat: Uint8ClampedArray
  /**
   * The ΔE field, one value per pixel. The Difference view reads it for the
   * cursor readout and the ghost blend, so both quote the same field as the
   * numbers. Float32 is ample for a two-decimal readout.
   */
  de: Float32Array
  /** The render that was scored (opaque, over white) — the "trace" swatch. */
  render: Uint8ClampedArray
  /** The scored source pixels, alpha intact, for the swatch and the ghost. */
  source: Uint8ClampedArray
}

// `self` is typed as Window here (no "webworker" lib), so cast postMessage to
// the worker signature that takes a transfer list; the buffers are large.
const post = self.postMessage as unknown as (message: unknown, transfer?: Transferable[]) => void

self.onmessage = (e: MessageEvent<ScoreReq>) => {
  const { doc, source, scale } = e.data
  try {
    const { width, height } = source
    const render = rasterizeDoc(doc, width, height, { scale })
    // One field feeds both the numbers and the heat. Don't compute them
    // separately, or the status bar and the picture can disagree.
    const { de } = deltaEField(source.data, render, width, height)
    const { meanDeltaE, p95DeltaE } = deltaEStats(de)
    const heat = deltaEHeat(de)
    const de32 = Float32Array.from(de)
    const res: ScoreRes = {
      type: 'result',
      meanDeltaE,
      p95DeltaE,
      width,
      height,
      heat,
      de: de32,
      render,
      source: source.data,
    }
    post(res, [heat.buffer, de32.buffer, render.buffer, source.data.buffer])
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
