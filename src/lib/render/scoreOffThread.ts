// Main-thread client for the fidelity worker. Same shape as traceOffThread: one
// worker per call, terminated on finish/error/abort, so cancelling is instant and
// there is no shared state to reset between two scores.

import type { EditableDoc } from '../path/types'
import type { ScoreReq, ScoreRes } from './fidelity.worker.ts'

/**
 * The studio's score: the two numbers, the heat, and the buffers the
 * Difference view reads back (see diffView.ts). All from one measurement.
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

/** False without Worker support; the score is then omitted rather than run on
 *  the main thread. */
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

    // Transfer a copy: the caller keeps its ImageData for the next score.
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
