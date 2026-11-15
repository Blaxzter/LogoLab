// /labs/ab's verdict against the source (src/components/labs/abSource.ts).

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  byWorstShift,
  deltaENote,
  meanDeltaEVsSource,
  SOURCE_TIE_DE,
  signedDelta,
  sourceVerdict,
  worstShift,
  type SourceScore,
} from '../src/components/labs/abSource.ts'

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4)
  return { data, width: w, height: h }
}

test('a render scores against its source, transparency composited over white', () => {
  assert.equal(meanDeltaEVsSource(solid(8, 8, [10, 20, 30, 255]), solid(8, 8, [10, 20, 30, 255])), 0)
  // A transparent source IS white to the metric.
  assert.equal(meanDeltaEVsSource(solid(8, 8, [0, 0, 0, 0]), solid(8, 8, [255, 255, 255, 255])), 0)
  assert.ok((meanDeltaEVsSource(solid(8, 8, [0, 0, 0, 255]), solid(8, 8, [255, 255, 255, 255])) ?? 0) > 90)
})

test('a row of rounding between the two rasterizers is cropped; a different picture is not scored', () => {
  assert.equal(meanDeltaEVsSource(solid(8, 8, [9, 9, 9, 255]), solid(8, 7, [9, 9, 9, 255])), 0)
  assert.equal(meanDeltaEVsSource(solid(8, 8, [9, 9, 9, 255]), solid(8, 5, [9, 9, 9, 255])), null)
})

const s = (lane: string, base: number, head: number): SourceScore => ({
  lane: lane as SourceScore['lane'],
  label: lane,
  base,
  head,
})

test('closer, further, or a tie within the scoring noise', () => {
  assert.equal(sourceVerdict(s('flat', 0.4, 0.2)), 'closer')
  assert.equal(sourceVerdict(s('flat', 0.2, 0.4)), 'further')
  assert.equal(sourceVerdict(s('flat', 0.2, 0.2 + SOURCE_TIE_DE / 2)), 'same')
})

test('the worst lane is the one that moved furthest from the source', () => {
  assert.equal(worstShift(undefined), null)
  assert.equal(worstShift([s('flat', 0.5, 0.1), s('mono', 0.3, 0.31), s('grad', 0.9, 0.4)])?.lane, 'mono')
})

test('worst first: regressions lead, improvements follow, unscored rows keep their order last', () => {
  const rows = [
    { id: 'quiet', sc: undefined },
    { id: 'better', sc: [s('flat', 0.5, 0.2)] },
    { id: 'worse', sc: [s('flat', 0.1, 0.3)] },
    { id: 'mixed', sc: [s('flat', 0.5, 0.2), s('mono', 0.1, 0.15)] },
    { id: 'failed', sc: undefined },
  ]
  assert.deepEqual(
    byWorstShift(rows, (r) => r.sc).map((r) => r.id),
    ['worse', 'mixed', 'better', 'quiet', 'failed'],
  )
})

test('the panel note gives the score and the change from its partner', () => {
  assert.equal(deltaENote(undefined, 0.3), '')
  assert.equal(deltaENote(0.384, undefined), ' · ΔE 0.384')
  assert.equal(deltaENote(0.198, 0.384), ' · ΔE 0.198 (−0.186)')
  assert.equal(deltaENote(0.4, 0.3), ' · ΔE 0.400 (+0.100)')
  assert.equal(deltaENote(0.3, 0.3), ' · ΔE 0.300')
})

test('a change too small to print is ±0.000, never −0.000', () => {
  assert.equal(signedDelta(-0.0001), '±0.000')
  assert.equal(signedDelta(0.008), '+0.008')
  assert.equal(signedDelta(-1.024), '−1.024')
})
