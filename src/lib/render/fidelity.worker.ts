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
  /**
   * The field itself, one ΔE per pixel. The Difference view reads it back under
   * the cursor and uses it to fade the heat into a ghost of the source, so the
   * readout and the picture quote the SAME field the two numbers came from —
   * never a second measurement. Float32: two decimals is all a readout shows.
   */
  de: Float32Array
  /** The render that was scored (opaque, over white) — the "trace" swatch. */
  render: Uint8ClampedArray
  /** The source pixels that were scored, alpha intact, handed back so the
   *  "original" swatch and the ghost are the bytes the number was measured on. */
  source: Uint8ClampedArray
}

// `self` is typed as a Window in the app's tsconfig (no "webworker" lib), whose
// postMessage overloads take a targetOrigin rather than a transfer list. Every
// buffer here is 4 bytes per pixel, so they are transferred, not structured-cloned.
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
