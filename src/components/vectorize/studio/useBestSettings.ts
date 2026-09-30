// "Find best settings": trace each candidate on a reduced copy, score it, apply the winner.
//
// Explicit: it runs only when pressed. Opening an image already runs the ink and
// gradients probes; a second automatic round would change the trace a moment after
// it appears and fight the user's own settings. The candidates, the winner rule
// and the labels are pure (bestSettings.ts); this is the plumbing.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { getImageData } from '../../../lib/image'
import { docStats } from '../../../lib/path/model'
import { canScoreOffThread, scoreOffThread } from '../../../lib/render/scoreOffThread'
import { logError } from '../../../lib/report/errorLog'
import { toImageData, upscaleImageData } from '../../../lib/sheet/crop'
import { canTraceOffThread, traceImageOffThread } from '../../../lib/trace/traceOffThread'
import { monoTraceScale } from '../../../lib/traceInput/traceCaps'
import type { VectorizeOptions } from '../../../types'
import {
  buildCandidates,
  forceColorDoc,
  pickWinner,
  SEARCH_CONCURRENCY,
  SEARCH_MAX_DIM,
  TRACE_ORDER,
  type Candidate,
  type CandidateScore,
} from './bestSettings'
import type { VectorizeSource } from './types'

export interface ScoredCandidate extends CandidateScore {
  candidate: Candidate
}

export type BestSettingsState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  /** `ranked[0]` is the winner; the rest are the runners-up, best ΔE first. */
  | { status: 'done'; ranked: ScoredCandidate[]; ms: number }
  | { status: 'error'; message: string }

export function useBestSettings({
  logo,
  opts,
  probePixelsRef,
  applyCandidate,
}: {
  logo: VectorizeSource
  opts: VectorizeOptions
  /** The ink probe's raster; null when the probe has not run (the icon sheet's seeded tiles). */
  probePixelsRef: RefObject<ImageData | null>
  applyCandidate: (c: Candidate) => void
}) {
  const [state, setState] = useState<BestSettingsState>({ status: 'idle' })
  const abortRef = useRef<AbortController | null>(null)
  // The options the running search started from. Any other options mean the user
  // changed a setting (or a trace started from new ones), which cancels it.
  const startedFromRef = useRef<VectorizeOptions | null>(null)
  const applyRef = useRef(applyCandidate)
  applyRef.current = applyCandidate
  const available = canTraceOffThread(opts) && canScoreOffThread()

  const cancel = useCallback(() => {
    if (!abortRef.current) return
    abortRef.current.abort()
    abortRef.current = null
    startedFromRef.current = null
    setState({ status: 'idle' })
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies(probePixelsRef.current): a ref, read when the code runs
  const start = useCallback(async () => {
    if (!logo.src || !available) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const { signal } = controller
    startedFromRef.current = opts
    const t0 = performance.now()
    try {
      // Traced and scored at the SAME reduced size, so the comparison is fair and
      // the score's `scale` is simply the trace's own (after any mono enlargement).
      const img = await getImageData(logo.src, SEARCH_MAX_DIM, logo.isSvg ? logo.svgText : null)
      if (signal.aborted) return
      const candidates = buildCandidates(opts, probePixelsRef.current ?? img)
      setState({ status: 'running', done: 0, total: candidates.length })
      const scored: ScoredCandidate[] = []
      let done = 0
      const one = async (c: Candidate) => {
        // The production input policy: a small or thin-stroked mono raster is
        // enlarged first, as the full trace will be.
        const plan = monoTraceScale(img, c.opts)
        const input = plan.scale > 1 ? toImageData(upscaleImageData(img, plan.scale)) : img
        const traced = await traceImageOffThread(input, c.opts, undefined, signal)
        const doc = c.forceColorOn && c.forceColor ? forceColorDoc(traced, c.forceColor) : traced
        const vbW = doc.viewBox[2]
        const s = await scoreOffThread(doc, img, vbW > 0 ? img.width / vbW : 1, signal)
        scored.push({ id: c.id, meanDeltaE: s.meanDeltaE, nodes: docStats(doc).nodes, candidate: c })
        done++
        if (!signal.aborted) setState({ status: 'running', done, total: candidates.length })
      }
      // A small pool: each candidate is its own worker, so a few run side by side.
      const queue = [...candidates].sort((a, b) => TRACE_ORDER.indexOf(a.id) - TRACE_ORDER.indexOf(b.id))
      await Promise.all(
        Array.from({ length: Math.min(SEARCH_CONCURRENCY, queue.length) }, async () => {
          for (let c = queue.shift(); c; c = queue.shift()) {
            try {
              await one(c)
            } catch (err) {
              if (signal.aborted) throw err
              // One candidate failing (a trace error) drops that candidate, not the search.
              logError('best-settings', err)
              done++
            }
          }
        }),
      )
      if (signal.aborted) return
      const order = pickWinner(scored)
      const ranked = order.map((s) => scored.find((x) => x.id === s.id)!)
      abortRef.current = null
      startedFromRef.current = null
      if (!ranked.length) {
        setState({ status: 'error', message: 'None of the settings could trace this image.' })
        return
      }
      setState({ status: 'done', ranked, ms: performance.now() - t0 })
      applyRef.current(ranked[0].candidate)
    } catch (err) {
      if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return
      logError('best-settings', err)
      abortRef.current = null
      startedFromRef.current = null
      setState({ status: 'error', message: 'Could not compare settings for this image.' })
    }
  }, [logo.src, logo.isSvg, logo.svgText, opts, available])

  // A setting changed while the search ran: the user is steering by hand now.
  useEffect(() => {
    if (startedFromRef.current && startedFromRef.current !== opts) cancel()
  }, [opts, cancel])

  // A new image: cancel, and drop a scoreboard that described the old one.
  useEffect(() => {
    cancel()
    setState({ status: 'idle' })
  }, [logo.src, cancel])

  useEffect(() => () => abortRef.current?.abort(), [])

  const dismiss = useCallback(() => setState({ status: 'idle' }), [])

  return { state, start, cancel, dismiss, available }
}
