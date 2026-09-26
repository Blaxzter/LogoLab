// Scores the result against the source off-thread: the ΔE readout and the Difference heat.

import { useEffect, useRef } from 'react'
import { getImageData } from '../../../lib/image'
import type { EditableDoc } from '../../../lib/path/types'
import { scoreOffThread, type TraceScore } from '../../../lib/render/scoreOffThread'
import { logError } from '../../../lib/report/errorLog'
import type { VectorizeSource } from './types'

/**
 * Long side of the raster the fidelity score and Difference heat are measured
 * on. Deliberately below the trace resolution (1024–4096): rasterizing costs
 * O(pixels) per path, and scoring at 1024px barely moves the mean ΔE.
 */
const SCORE_MAX_DIM = 1024

/** Settle time before a score is started. Longer than the trace debounce because
 *  this also fires on every committed node edit, and a drag commits per frame. */
const SCORE_DEBOUNCE_MS = 500

export function useFidelityScore({
  busy,
  canScore,
  derivedDoc,
  logo,
  setScore,
}: {
  busy: boolean
  canScore: boolean
  derivedDoc: EditableDoc | null
  logo: VectorizeSource
  setScore: (score: TraceScore | null) => void
}) {
  // The source decoded once at SCORE_MAX_DIM and kept: the score re-runs on every
  // edit, and re-decoding the image for each of them is the expensive half.
  const scoreSourceRef = useRef<{ src: string; img: ImageData } | null>(null)

  /**
   * Score the result against the source image.
   *
   * - The source is decoded like the tracer decodes it (`getImageData`, alpha
   *   intact) and composited over white inside the metric. Don't decode it onto a
   *   backdrop here, or art on transparency scores a correct trace as wrong.
   * - The scored document is `derivedDoc` (force colour included), the same doc
   *   the rest of the status bar describes.
   *
   * Skipped while a trace is running.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: setScore is the studio's, stable
  useEffect(() => {
    if (busy) return // run() cleared it; scoring a doc about to be replaced is waste
    if (!derivedDoc || !logo.src || !canScore) {
      setScore(null)
      return
    }
    const src = logo.src
    const svgSource = logo.isSvg ? logo.svgText : null
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let cached = scoreSourceRef.current
          if (cached?.src !== src) {
            const img = await getImageData(src, SCORE_MAX_DIM, svgSource)
            if (cancelled) return
            cached = { src, img }
            scoreSourceRef.current = cached
          }
          const img = cached.img
          const vbW = derivedDoc.viewBox[2]
          if (!(vbW > 0)) return
          // The doc's viewBox is the trace raster (or a cleaned SVG's own units);
          // `scale` renders it into the score raster's pixel space either way.
          const next = await scoreOffThread(derivedDoc, img, img.width / vbW, controller.signal)
          if (!cancelled) setScore(next)
        } catch (err) {
          if (cancelled || (err instanceof DOMException && err.name === 'AbortError')) return
          // A failed score just means no readout; the trace itself is fine.
          logError('fidelity', err)
          setScore(null)
        }
      })()
    }, SCORE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [busy, canScore, derivedDoc, logo.src, logo.isSvg, logo.svgText])
}
