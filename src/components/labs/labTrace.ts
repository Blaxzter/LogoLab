import { traceImage } from '../../lib/trace'
import { canTraceOffThread, traceImageOffThread } from '../../lib/trace/traceOffThread'
import type { EditableDoc } from '../../lib/path/types'
import type { VectorizeOptions } from '../../types'

/**
 * Trace one image for a lab, off the main thread when the engine allows it.
 *
 * The labs inherited `traceImage()` — a synchronous, main-thread pipeline — from the vanilla
 * pages they replaced. `useLabRun` yields BETWEEN cases so finished rows paint, but each
 * individual trace still froze the tab for its whole duration (seconds; far worse on the
 * golden corpus's headphones cases). The app itself never did this: the studio has traced
 * off-thread since traceOffThread.ts landed.
 *
 * Same pure pipeline, same module, same options ⇒ byte-identical documents — the worker just
 * runs it somewhere the UI isn't. Verified against the blessed golden records and the
 * ground-truth gates after the switch.
 *
 * Potrace is the one engine that CANNOT go off-thread (it needs DOMParser + WASM the worker
 * lacks), so `canTraceOffThread` sends it back to the main thread. That is why the Eval lab,
 * which scores potrace by design, still blocks — and why this decision lives here rather than
 * being re-made at each call site.
 */
export function labTrace(image: ImageData, options: VectorizeOptions): Promise<EditableDoc> {
  return canTraceOffThread(options)
    ? traceImageOffThread(image, options)
    : traceImage(image, options)
}
