// Web Worker that runs the vectorize trace OFF the main thread, so the UI stays
// responsive (and animations stay smooth) while a trace is computing.
//
// Only the CRISP engine is dispatched here — it's pure JS (Mumford–Shah segment →
// paint ladder → sub-pixel curve fit → beautify), with no DOM/WASM, so it runs
// cleanly in a worker. Potrace stays on the main thread (esm-potrace-wasm needs
// DOMParser, which workers don't have); the caller picks which path to take.
//
// Protocol: main posts { image:{width,height,data}, options } (data buffer
// transferred); worker posts { type:'progress', progress } during the run and
// { type:'result', doc } or { type:'error', message } at the end. Abort is done
// by the caller terminating the worker.

import { traceImage } from './index.ts'
import type { VectorizeOptions } from '../../types'

interface TraceRequest {
  image: { width: number; height: number; data: Uint8ClampedArray }
  options: VectorizeOptions
}

self.onmessage = async (e: MessageEvent<TraceRequest>) => {
  const { image, options } = e.data
  try {
    // Rebuild an ImageData from the transferred buffer (ImageData exists in workers).
    const imageData = new ImageData(image.width, image.height)
    imageData.data.set(image.data)
    const doc = await traceImage(imageData, options, (progress) =>
      self.postMessage({ type: 'progress', progress }),
    )
    self.postMessage({ type: 'result', doc })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
