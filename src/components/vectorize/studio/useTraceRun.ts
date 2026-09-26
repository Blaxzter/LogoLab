// Runs the trace (or the SVG clean): progress, errors, Stop, and the debounced auto-run.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { getImageData } from '../../../lib/image'
import { parseSvg } from '../../../lib/path/model'
import type { EditableDoc } from '../../../lib/path/types'
import type { TraceScore } from '../../../lib/render/scoreOffThread'
import { logError } from '../../../lib/report/errorLog'
import { clearFailure, raiseFailure } from '../../../lib/report/failureNotice'
import { toImageData, upscaleImageData } from '../../../lib/sheet/crop'
import { cleanSvg } from '../../../lib/export/svgClean'
import { traceImage } from '../../../lib/trace'
import { canTraceOffThread, traceImageOffThread } from '../../../lib/trace/traceOffThread'
import { aiUpscale, aiUpscaleFactor } from '../../../lib/traceInput/aiUpscale'
import { monoTraceScale, rasterCapFor, type MonoUpscalePlan } from '../../../lib/traceInput/traceCaps'
import type { VectorizeOptions } from '../../../types'
import type { VectorizeSource } from './types'

const DEBOUNCE_MS = 400

export function useTraceRun({
  logo,
  opts,
  precision,
  cleanFromExisting,
  cleanPrecision,
  historyReset,
  handleSelectPath,
  setSelectedNodes,
  dirtyRef,
  skipRetraceRef,
  setScore,
}: {
  logo: VectorizeSource
  opts: VectorizeOptions
  precision: number
  cleanFromExisting: boolean
  cleanPrecision: number
  historyReset: (next: EditableDoc | null) => void
  handleSelectPath: (id: string | null) => void
  setSelectedNodes: (keys: ReadonlySet<string>) => void
  dirtyRef: RefObject<boolean>
  skipRetraceRef: RefObject<boolean>
  setScore: (score: TraceScore | null) => void
}) {
  const [staleEdits, setStaleEdits] = useState(false)
  // Settings changed since the last completed trace but not applied: set when a
  // trace is stopped mid-flight.
  const [staleOpts, setStaleOpts] = useState(false)

  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  // Determinate progress in [0,1] from the tracer; 0 ⇒ indeterminate (show the sweep).
  const [progressFraction, setProgressFraction] = useState(0)
  // Pre-merge region map (fine regions before the gradient field-merge) from the
  // last trace — drives the region hover-highlight while placing markers.
  const [preMerge, setPreMerge] = useState<{ labels: Int32Array; width: number; height: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The error object behind the status message, kept for bug reports: the worker
  // catches its own failures, so otherwise there would be nothing to attach.
  const [failure, setFailure] = useState<unknown>(null)
  // What Auto enlargement did on the last run, so the Upscale control can say
  // "×3 — its strokes are 1px" instead of leaving the user to guess.
  const [autoUpscale, setAutoUpscale] = useState<MonoUpscalePlan | null>(null)
  const runIdRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  // Pending debounced auto-run timer, shared so Stop can cancel it (otherwise a
  // re-trace armed just before Stop fires ~DEBOUNCE_MS later and clobbers the doc).
  const autoRunTimerRef = useRef<number | null>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: the setters, dirtyRef and precision are the studio's, stable
  const run = useCallback(async () => {
    if (!logo.src) return
    const runId = ++runIdRef.current
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)
    setFailure(null)
    // Drop the old score; the scoring effect starts a new one when this run lands.
    setScore(null)
    // A new attempt clears the previous failure prompt without recording it as
    // dismissed, since the user never answered it.
    clearFailure()
    setStaleOpts(false) // we're applying the current settings now
    setProgress(cleanFromExisting ? 'Cleaning SVG…' : 'Tracing…')
    setProgressFraction(0)
    try {
      let next: EditableDoc | null
      if (cleanFromExisting && logo.svgText) {
        // Yield a macrotask so the busy state paints before the sync clean.
        await new Promise((r) => setTimeout(r))
        if (runId !== runIdRef.current) return
        const cleaned = cleanSvg(logo.svgText, {
          precision,
          stripDimensions: true,
          // Force color is applied at render/serialize time, not baked here.
          forceFill: null,
          removeBackground: opts.removeBackground,
        })
        next = parseSvg(cleaned.svg)
        if (!next) throw new Error('SVG could not be parsed')
      } else {
        // Gradient/photo colour art keeps the 1024 cap (the gradient merge is
        // costly); mono and flat colour trace at full resolution. The Detail preset
        // lifts the flat cap to 4096.
        let imageData = await getImageData(logo.src, rasterCapFor(opts), logo.isSvg ? logo.svgText : null)
        if (runId !== runIdRef.current) return
        // Opt-in AI super-resolution for small rasters only (SVG sources are already
        // rasterized at full detail). The doc comes back in the enlarged pixel space;
        // markers are normalized and the overlay fits by aspect, so nothing downstream
        // cares. Size rule: src/lib/traceInput/aiUpscale.ts.
        setAutoUpscale(null)
        const upscaleBy =
          opts.upscale === 'ai' && !logo.isSvg ? aiUpscaleFactor(Math.max(imageData.width, imageData.height)) : 0
        if (upscaleBy) {
          setProgress(`Upscaling ×${upscaleBy}…`)
          imageData = await aiUpscale(
            imageData,
            upscaleBy,
            (p) => {
              if (runId !== runIdRef.current) return
              setProgress(
                p.phase === 'download'
                  ? `Downloading upscaler${p.percent != null ? ` — ${p.percent}%` : '…'}`
                  : `Upscaling ×${p.factor}…`,
              )
            },
            controller.signal,
          )
          if (runId !== runIdRef.current) return
          setProgress('Tracing…')
        } else if (!logo.isSvg) {
          // Auto: a small or thin-stroked mono raster is enlarged bilinearly
          // first (size and stroke rules in traceCaps.ts). Factor 1 for colour,
          // Off, or when the raster is already near the cap. Also reached with
          // `upscale: 'ai'` when the AI path declined the raster.
          const plan = monoTraceScale(imageData, opts)
          setAutoUpscale(plan)
          if (plan.scale > 1) {
            setProgress(`Enlarging ×${plan.scale}…`)
            // Yield so the label paints before the synchronous resample.
            await new Promise((r) => setTimeout(r))
            if (runId !== runIdRef.current) return
            imageData = toImageData(upscaleImageData(imageData, plan.scale))
            setProgress('Tracing…')
          }
        }
        // The tracer runs in a Web Worker (pure JS) so the UI stays responsive;
        // `canTraceOffThread` only says no where there is no Worker at all.
        const runTrace = canTraceOffThread(opts) ? traceImageOffThread : traceImage
        next = await runTrace(
          imageData,
          opts,
          (p) => {
            if (runId !== runIdRef.current) return
            setProgress(p.label)
            setProgressFraction(p.fraction)
          },
          controller.signal,
          (pm) => {
            if (runId === runIdRef.current) setPreMerge(pm)
          },
        )
      }
      if (runId !== runIdRef.current) return
      historyReset(next)
      handleSelectPath(null)
      setSelectedNodes(new Set())
      dirtyRef.current = false
      setStaleEdits(false)
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return
      logError('trace', err)
      if (runId === runIdRef.current) {
        const message = 'Could not vectorize this image — try different settings or another file.'
        setError(message)
        setFailure(err)
        // Also ask whether to report it; the status line alone is easy to miss.
        raiseFailure('the vectorizer', message, err)
      }
    } finally {
      if (runId === runIdRef.current) {
        setBusy(false)
        setProgress('')
        setProgressFraction(0)
      }
    }
  }, [logo.src, logo.isSvg, logo.svgText, opts, cleanFromExisting, cleanPrecision, historyReset, handleSelectPath])

  // Cancel an in-flight trace: clear any pending debounced auto-run (it would
  // otherwise replace the doc shortly after), bump the run id so late results are
  // ignored, abort the worker, and clear the busy UI. The previous document stays;
  // `staleOpts` marks the result as lagging the settings so the controls offer a
  // re-trace.
  const stop = useCallback(() => {
    if (autoRunTimerRef.current !== null) {
      window.clearTimeout(autoRunTimerRef.current)
      autoRunTimerRef.current = null
    }
    runIdRef.current++
    abortRef.current?.abort()
    abortRef.current = null
    setBusy(false)
    setProgress('')
    setProgressFraction(0)
    setStaleOpts(true)
  }, [])

  // Auto-run (debounced) whenever the source or parameters change — unless
  // the user has hand-edited paths, in which case their edits win.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are the studio's, stable
  useEffect(() => {
    // An opacity-only palette edit already recoloured the canvas live (geometry
    // is unchanged), so the trace would be wasted work — skip this one run.
    if (skipRetraceRef.current) {
      skipRetraceRef.current = false
      return
    }
    if (dirtyRef.current) {
      setStaleEdits(true)
      return
    }
    const id = window.setTimeout(() => {
      autoRunTimerRef.current = null
      void run()
    }, DEBOUNCE_MS)
    autoRunTimerRef.current = id
    return () => {
      window.clearTimeout(id)
      autoRunTimerRef.current = null
    }
  }, [run])

  useEffect(() => () => abortRef.current?.abort(), [])

  return {
    staleEdits,
    staleOpts,
    busy,
    progress,
    progressFraction,
    preMerge,
    error,
    setError,
    failure,
    setFailure,
    autoUpscale,
    run,
    stop,
  }
}
