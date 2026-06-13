// Main-thread client for the trace worker: a drop-in async replacement for
// traceImage() that runs the (crisp) pipeline off-thread so the UI stays
// responsive. One worker per call — created on start, terminated on
// finish/error/abort — so aborting is instant (terminate kills the in-flight
// computation) with no shared state to reset.

import type { EditableDoc } from '../path/types'
import type { VectorizeOptions } from '../../types'
import type { TraceProgress } from './types'

/** True when this engine/environment can run off the main thread (crisp only —
 *  potrace needs DOMParser/WASM the worker doesn't have). */
export function canTraceOffThread(options: VectorizeOptions): boolean {
  return options.engine === 'crisp' && typeof Worker !== 'undefined'
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
      { image: { width: imageData.width, height: imageData.height, data }, options },
      [data.buffer],
    )
  })
}
