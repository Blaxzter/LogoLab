// Main-thread client for the trace worker: a drop-in async replacement for
// traceImage() that runs the (crisp) pipeline off-thread so the UI stays
// responsive. One worker per call — created on start, terminated on
// finish/error/abort — so aborting is instant (terminate kills the in-flight
// computation) with no shared state to reset.

import type { EditableDoc } from '../path/types'
import type { VectorizeOptions } from '../../types'
import type { TraceProgress } from './types'

/** True when this engine/environment can run off the main thread. Crisp and
 *  planar are pure JS (worker-safe); only potrace needs DOMParser/WASM the worker
 *  lacks, so it alone stays on the main thread. */
export function canTraceOffThread(options: VectorizeOptions): boolean {
  return options.engine !== 'potrace' && typeof Worker !== 'undefined'
}

export function traceImageOffThread(
  imageData: ImageData,
  options: VectorizeOptions,
  onProgress?: (p: TraceProgress) => void,
  signal?: AbortSignal,
): Promise<EditableDoc> {
  return new Promise<EditableDoc>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' })

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
      const msg = e.data as
        | { type: 'progress'; progress: TraceProgress }
        | { type: 'result'; doc: EditableDoc }
        | { type: 'error'; message: string }
      if (msg.type === 'progress') onProgress?.(msg.progress)
      else if (msg.type === 'result') {
        cleanup()
        resolve(msg.doc)
      } else {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      cleanup()
      reject(new Error(e.message || 'Trace worker failed'))
    }

    // Copy the pixels so the caller's ImageData stays valid after we transfer.
    const data = new Uint8ClampedArray(imageData.data)
    worker.postMessage(
      { type: 'trace', image: { width: imageData.width, height: imageData.height, data }, options },
      [data.buffer],
    )
  })
}

/** Stage visualisations + result for the "How it works" explainer (off-thread). */
export interface OffThreadAnalysis {
  width: number
  height: number
  smoothed: Uint8ClampedArray
  disc: Uint8ClampedArray
  segs: Uint8ClampedArray
  fills: Uint8ClampedArray
  regionCount: number
  paints: ({ model: string; solid: [number, number, number] } | null)[]
  svg: string
  stats: { paths: number; nodes: number }
}

/**
 * Run the pipeline + intermediate stages off-thread for the explainer, so it
 * doesn't freeze the UI. Crisp-only (pure); the explainer always traces crisp.
 */
export function analyzeImageOffThread(
  imageData: ImageData,
  options: VectorizeOptions,
  signal?: AbortSignal,
): Promise<OffThreadAnalysis> {
  return new Promise<OffThreadAnalysis>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const worker = new Worker(new URL('./trace.worker.ts', import.meta.url), { type: 'module' })
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
      const msg = e.data as { type: 'analysis' } & OffThreadAnalysis | { type: 'error'; message: string }
      if (msg.type === 'analysis') {
        cleanup()
        resolve(msg)
      } else {
        cleanup()
        reject(new Error(msg.message))
      }
    }
    worker.onerror = (e) => {
      cleanup()
      reject(new Error(e.message || 'Analyze worker failed'))
    }
    const data = new Uint8ClampedArray(imageData.data)
    worker.postMessage(
      { type: 'analyze', image: { width: imageData.width, height: imageData.height, data }, options },
      [data.buffer],
    )
  })
}
