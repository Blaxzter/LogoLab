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
 * `canTraceOffThread` is still consulted so an environment without Workers (tests, a
 * headless run) falls back to the main thread — the decision lives here rather than being
 * re-made at each call site.
 */
export function labTrace(image: ImageData, options: VectorizeOptions): Promise<EditableDoc> {
  return canTraceOffThread(options) ? traceImageOffThread(image, options) : traceImage(image, options)
}
