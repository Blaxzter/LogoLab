// Web Worker that runs vectorize work OFF the main thread, so the UI stays
// responsive (and animations stay smooth) while computing.
//
// Two jobs, both crisp-engine / pure-JS (no DOM/WASM, so worker-safe):
//   - 'trace':   run the full pipeline, return the EditableDoc (the studio result).
//   - 'analyze': run the pipeline AND the intermediate stages, returning the
//                stage visualisations (smoothed / discontinuity / regions / region
//                fills as RGBA buffers) + paint models + the final SVG — for the
//                user-facing "How it works" explainer, so it no longer freezes.
//
// Potrace stays on the main thread (esm-potrace-wasm needs DOMParser); the caller
// only dispatches the crisp engine here.

import { traceImage, segmentOptionsFor } from './index.ts'
import { segmentImage } from './segment.ts'
import { fitPaintLadder } from './gradient.ts'
import { serializeDoc, docStats } from '../path/model.ts'
import { smoothedToRgba, discontinuityToRgba, segmentsToRgba, regionFillsToRgba } from './stageViz.ts'
import type { VectorizeOptions } from '../../types'

interface Req {
  type: 'trace' | 'analyze'
  image: { width: number; height: number; data: Uint8ClampedArray }
  options: VectorizeOptions
}

function toImageData(image: Req['image']): ImageData {
  const id = new ImageData(image.width, image.height)
  id.data.set(image.data)
  return id
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { type, image, options } = e.data
  try {
    const imageData = toImageData(image)
    if (type === 'analyze') {
      // Same segmentation the pipeline uses (honours regionDetail), so the
      // explainer's region count matches the actual output.
      const seg = segmentImage(
        imageData as unknown as { width: number; height: number; data: Uint8ClampedArray },
        segmentOptionsFor(options),
      )
      const gradientsOn = options.gradients !== false
      const paints = gradientsOn ? seg.regionSamples.map((s) => fitPaintLadder(s)) : seg.regionSamples.map(() => null)
      const doc = await traceImage(imageData, options)
      const st = docStats(doc)
      const w = seg.ms.width
      const h = seg.ms.height
      self.postMessage({
        type: 'analysis',
        width: w,
        height: h,
        smoothed: smoothedToRgba(seg.ms),
        disc: discontinuityToRgba(seg.ms),
        segs: segmentsToRgba(seg.labels, w, h),
        fills: regionFillsToRgba(seg.labels, seg.palette, w, h),
        regionCount: seg.palette.length,
        paints: paints.map((p) => (p ? { model: p.model, solid: p.solid } : null)),
        svg: serializeDoc(doc, 2),
        stats: { paths: st.paths, nodes: st.nodes },
      })
      return
    }
    const doc = await traceImage(imageData, options, (progress) => self.postMessage({ type: 'progress', progress }))
    self.postMessage({ type: 'result', doc })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
