// The icon sheet's batch trace (src/state/sheetRun.ts, used by sheetStore.traceAll):
//
//   node --test test/sheet-run.test.ts
//
// 1. Deleting a box that was tracing aborts THAT tile; it used to `return` out
//    of the worker loop, so with one worker the batch stopped and every later
//    tile sat at 'queued' forever.
// 2. A trace that lands after its box moved (or its settings changed) is stale.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runPool, traceInputsMoved, type TileTraceInputs } from '../src/state/sheetRun.ts'

test('a per-item abort skips that item; the single worker keeps draining', async () => {
  const done: string[] = []
  await runPool(['a', 'b', 'c', 'd'], 1, async (id) => {
    if (id === 'b') return // aborted: removed mid-trace
    done.push(id)
  })
  assert.deepEqual(done, ['a', 'c', 'd'])
})

test("'stop' ends every worker of a dead run", async () => {
  const seen: number[] = []
  let dead = false
  await runPool([1, 2, 3, 4, 5, 6], 2, async (n) => {
    if (dead) return 'stop'
    seen.push(n)
    if (n === 2) dead = true
  })
  assert.deepEqual(seen, [1, 2])
})

test('every item runs exactly once across workers', async () => {
  const seen: number[] = []
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    await new Promise((r) => setTimeout(r, (n * 7) % 5))
    seen.push(n)
  })
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  )
})

const base = (): TileTraceInputs => ({
  rect: { x: 0, y: 0, w: 10, h: 10 },
  opts: null,
  traceOptions: {} as TileTraceInputs['traceOptions'],
  colorMode: 'auto' as TileTraceInputs['colorMode'],
  gradientMode: 'auto',
  hiRes: true,
  background: null,
})

test('unchanged inputs: the landing trace is current', () => {
  const s = base()
  assert.equal(traceInputsMoved(s, { ...s }), false)
})

test('a box moved mid-trace lands stale', () => {
  const s = base()
  assert.equal(traceInputsMoved(s, { ...s, rect: { x: 40, y: 0, w: 10, h: 10 } }), true)
  // A drag that ends where it began hands the store a NEW rect with the same box.
  assert.equal(traceInputsMoved(s, { ...s, rect: { ...s.rect } }), false)
})

test('a defaults change mid-trace makes a default-following tile stale, not a hand-tuned one', () => {
  const s = base()
  const moved = { ...s, traceOptions: { ...s.traceOptions } }
  assert.equal(traceInputsMoved(s, moved), true)
  assert.equal(traceInputsMoved(s, { ...s, gradientMode: 'rich' }), true)
  const tuned = { ...s, opts: {} as TileTraceInputs['traceOptions'] }
  assert.equal(traceInputsMoved(tuned, { ...tuned, traceOptions: { ...s.traceOptions } }), false)
  // Resolution changes every tile, hand-tuned ones included (setHiRes).
  assert.equal(traceInputsMoved(tuned, { ...tuned, hiRes: false }), true)
})
