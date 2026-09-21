// Main-thread client for the fidelity worker. Same shape as traceOffThread: one
// worker per call, terminated on finish/error/abort, so cancelling is instant and
// there is no shared state to reset between two scores.

import type { EditableDoc } from '../path/types'
import type { ScoreReq, ScoreRes } from './fidelity.worker.ts'

/**
 * What the studio shows: the two numbers, the heat behind them, and the buffers
 * the Difference view reads back — the field under the cursor, and the source
 * and render pixels it was measured on (see lib/render/diffView.ts). All of one
 * measurement at one resolution, so nothing here can describe a different trace
 * than the number does.
 */
export interface TraceScore {
  /** Mean CIE76 ΔE, render vs source. */
  meanDeltaE: number
  /** 95th-percentile ΔE — the tail the mean hides. */
  p95DeltaE: number
  width: number
  height: number
  heat: Uint8ClampedArray
  /** ΔE per pixel (the field the heat and the numbers are computed from). */
  de: Float32Array
  /** The scored render, opaque over white. */
  render: Uint8ClampedArray
  /** The scored source, alpha intact. */
  source: Uint8ClampedArray
}

/** False where there is no Worker (a non-browser host). The score is an extra,
 *  not a result, so it is simply not offered rather than run on the main thread. */
export function canScoreOffThread(): boolean {
  return typeof Worker !== 'undefined'
}

export function scoreOffThread(
  doc: EditableDoc,
  source: ImageData,
  scale: number,
  signal?: AbortSignal,
): Promise<TraceScore> {
  return new Promise<TraceScore>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const worker = new Worker(new URL('./fidelity.worker.ts', import.meta.url), { type: 'module' })

    const onAbort = () => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    function cleanup() {
      worker.terminate()
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort)

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as ScoreRes | { type: 'error'; message: string }
      cleanup()
      if (msg.type === 'result') {
        const { meanDeltaE, p95DeltaE, width, height, heat, de, render, source } = msg
        resolve({ meanDeltaE, p95DeltaE, width, height, heat, de, render, source })
      } else {
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      cleanup()
      reject(new Error(e.message || 'Fidelity worker failed'))
    }

    // Copy the pixels so the caller's ImageData stays valid after we transfer —
    // the studio keeps this raster and scores against it again on the next edit.
    // (The worker hands the copy back with the result, as `source`.)
    const data = new Uint8ClampedArray(source.data)
    const req: ScoreReq = {
      type: 'score',
      doc,
      source: { width: source.width, height: source.height, data },
      scale,
    }
    worker.postMessage(req, [data.buffer])
  })
}
