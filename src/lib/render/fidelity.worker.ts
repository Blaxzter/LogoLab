// Web Worker that scores a traced document against the image it came from, OFF
// the main thread.
//
// It is here for the same reason the tracer's worker is: the work is O(w·h) per
// path and then O(w·h) again in CIELAB, which on a busy document at 1024px is a
// few hundred milliseconds — a visible hitch in a studio whose whole promise is
// that you can keep panning while it thinks. It also runs on EVERY committed node
// edit, so the main thread must never see it.
//
// Pure JS (no DOM), like the trace worker: rasterizeDoc renders the doc model
// directly rather than handing SVG to a canvas the worker doesn't have.

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
}

// `self` is typed as a Window in the app's tsconfig (no "webworker" lib), whose
// postMessage overloads take a targetOrigin rather than a transfer list. The heat
// is 4 bytes per pixel, so it is worth transferring rather than structured-cloning.
const post = self.postMessage as unknown as (message: unknown, transfer?: Transferable[]) => void

self.onmessage = (e: MessageEvent<ScoreReq>) => {
  const { doc, source, scale } = e.data
  try {
    const { width, height } = source
    const render = rasterizeDoc(doc, width, height, { scale })
    // ONE field feeds both answers, so the number in the status bar and the
    // picture in the Difference view can never disagree about the same trace.
    const { de } = deltaEField(source.data, render, width, height)
    const { meanDeltaE, p95DeltaE } = deltaEStats(de)
    const heat = deltaEHeat(de)
    const res: ScoreRes = { type: 'result', meanDeltaE, p95DeltaE, width, height, heat }
    post(res, [heat.buffer])
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
