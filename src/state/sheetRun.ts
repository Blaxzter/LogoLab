// The batch-trace bookkeeping behind sheetStore.traceAll, kept pure (type-only
// imports) so test/sheet-run.test.ts can reach it without the store's graph.

import type { Rect, SheetBackground } from '../lib/sheet'
import type { SheetColorMode } from '../lib/sheet/traceTile'
import type { VectorizeOptions } from '../types'

/**
 * Drain `queue` with `workers` concurrent loops. `step` returning 'stop' ends
 * THAT worker (the run is dead — every worker will see the same); anything else,
 * a skipped or aborted item included, moves on to the next item. A per-item
 * abort must not end the loop: deleting a box that was tracing used to retire
 * its worker for the rest of the batch, and with one worker the batch stopped
 * with every later tile left 'queued'.
 */
export async function runPool<T>(
  queue: readonly T[],
  workers: number,
  step: (item: T) => Promise<'stop' | undefined>,
): Promise<void> {
  let cursor = 0
  const next = async (): Promise<void> => {
    while (cursor < queue.length) {
      if ((await step(queue[cursor++])) === 'stop') return
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, queue.length) }, next))
}

/** Everything a tile's trace was cut from: the box, and the settings it followed. */
export interface TileTraceInputs {
  rect: Rect
  opts: VectorizeOptions | null
  traceOptions: VectorizeOptions
  colorMode: SheetColorMode
  gradientMode: string
  hiRes: boolean
  background: SheetBackground | null
}

/**
 * True when what a finished trace was cut from no longer matches the tile — the
 * box moved, or the settings it followed changed while it traced. The box is
 * compared by VALUE (a drag that ends where it started still hands the store a
 * new rect); the settings by identity, since every setter replaces the object it
 * changes. A trace that
 * lands under changed inputs is STALE, not done: otherwise "Trace stale" skips
 * it and the export writes the old crop under the tile's name.
 */
export function traceInputsMoved(start: TileTraceInputs, now: TileTraceInputs): boolean {
  if (!sameRect(now.rect, start.rect) || now.opts !== start.opts) return true
  if (now.hiRes !== start.hiRes || now.background !== start.background) return true
  // A hand-tuned tile ignores the sheet's defaults (setTraceOptions & co. skip it too).
  if (start.opts) return false
  return (
    now.traceOptions !== start.traceOptions ||
    now.colorMode !== start.colorMode ||
    now.gradientMode !== start.gradientMode
  )
}

function sameRect(a: Rect, b: Rect): boolean {
  return a === b || (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h)
}
