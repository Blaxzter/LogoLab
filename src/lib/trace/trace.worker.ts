// Web Worker that runs vectorize work off the main thread, so the UI stays
// responsive while computing. Two jobs (the pipeline is pure JS, so worker-safe):
//   - 'trace':   run the full pipeline, return the EditableDoc (the studio result).
//   - 'analyze': run the pipeline and the intermediate stages, returning the
//                stage visualisations (regions / region fills as RGBA buffers, plus
//                smoothed / discontinuity when the smoothness segmenter ran) + paint
//                models + the final SVG, for the "How it works" explainer.

import { traceImage } from './index.ts'
import { analyzeStages } from './explainStages.ts'
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
      // Stage pictures from the segmentation the trace actually ran (explainStages.ts),
      // so the explainer's region count matches the output beside it.
      self.postMessage({ type: 'analysis', ...(await analyzeStages(imageData, options)) })
      return
    }
    let preMerge: { labels: Int32Array; width: number; height: number } | null = null
    const doc = await traceImage(
      imageData,
      options,
      (progress) => self.postMessage({ type: 'progress', progress }),
      undefined,
      (pm) => {
        preMerge = pm
      },
    )
    if (preMerge) {
      const pm = preMerge as { labels: Int32Array; width: number; height: number }
      self.postMessage({
        type: 'result',
        doc,
        preMergeLabels: pm.labels,
        preMergeWidth: pm.width,
        preMergeHeight: pm.height,
      })
    } else {
      self.postMessage({ type: 'result', doc })
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
