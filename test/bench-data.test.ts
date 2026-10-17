// /labs/bench's stats (src/components/labs/bench/benchData.ts): the leaderboard and the
// paired test are what a reader quotes, so their direction and their n must be right.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  METRIC_BY_KEY,
  caseTable,
  dist,
  paired,
  summarize,
  type BenchRow,
} from '../src/components/labs/bench/benchData.ts'

const row = (tool: string, caseId: string, extra: Record<string, unknown>): BenchRow => ({
  tool,
  caseId,
  corpus: 'c',
  heldOut: true,
  status: 'ok',
  lane: 'colour',
  ...extra,
})

test('dist ignores missing values and takes the middle', () => {
  const d = dist([3, 1, Number.NaN, 2])
  assert.equal(d.n, 3)
  assert.equal(d.median, 2)
  assert.equal(d.min, 1)
  assert.equal(d.max, 3)
})

test('summarize counts failures and medians per tool, only for its corpus', () => {
  const rows = [
    row('a', 'c/1', { meanDeltaE: 1 }),
    row('a', 'c/2', { meanDeltaE: 3, status: 'parse-failed' }),
    { ...row('a', 'd/1', { meanDeltaE: 99 }), corpus: 'd' },
  ]
  const [s] = summarize(rows, 'c', ['a', 'missing'])
  assert.equal(s.n, 2)
  assert.equal(s.failures, 1)
  assert.equal(s.metrics.meanDeltaE.median, 2)
})

test('paired: wins follow the metric direction, and a consistent gap is significant', () => {
  const de = METRIC_BY_KEY.get('meanDeltaE')
  const dino = METRIC_BY_KEY.get('sbDino')
  assert.ok(de && dino)
  const rows: BenchRow[] = []
  for (let i = 0; i < 30; i++) {
    rows.push(row('ref', `c/${i}`, { meanDeltaE: 1, sbDino: 0.9 }))
    rows.push(row('t', `c/${i}`, { meanDeltaE: 2 + (i % 3) * 0.01, sbDino: 0.95 }))
  }
  // one case only the reference scored: not paired
  rows.push(row('ref', 'c/x', { meanDeltaE: 1 }))
  const table = caseTable(rows, 'c')
  const pe = paired(table, 't', 'ref', de)
  assert.ok(pe)
  assert.equal(pe.n, 30)
  assert.equal(pe.wins, 0) // higher ΔE is worse
  assert.equal(pe.losses, 30)
  assert.ok(pe.significant && pe.lo > 0)
  const pd = paired(table, 't', 'ref', dino)
  assert.ok(pd)
  assert.equal(pd.wins, 30) // higher DINO is better
})

test('paired: noise around zero is not significant, and is reproducible', () => {
  const de = METRIC_BY_KEY.get('meanDeltaE')
  assert.ok(de)
  const rows: BenchRow[] = []
  for (let i = 0; i < 40; i++) {
    rows.push(row('ref', `c/${i}`, { meanDeltaE: 1 }))
    rows.push(row('t', `c/${i}`, { meanDeltaE: 1 + (i % 2 ? 0.5 : -0.5) }))
  }
  const table = caseTable(rows, 'c')
  const a = paired(table, 't', 'ref', de)
  const b = paired(table, 't', 'ref', de)
  assert.ok(a && b)
  assert.equal(a.significant, false)
  assert.deepEqual(a, b)
})
