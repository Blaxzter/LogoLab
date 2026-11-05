// The benchmark's headline number (benchData.ts: mean rank, Friedman, Nemenyi CD, Pareto).
// A leaderboard is the number that gets quoted, so every rule that decides a cell is pinned
// here on cases small enough to rank by hand: ties, a failed tool ranked last (not skipped),
// a ground-truth refusal dropped for everyone, ablation rows out of the headline. The tests
// themselves are checked against Demšar (2006): his worked example and his q table.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NEMENYI_Q,
  RANK_METRICS,
  cdGroups,
  chi2Sf,
  corpusKind,
  fSf,
  friedman,
  friedmanFromMeans,
  isAblationRow,
  leaderboard,
  meanRanks,
  nemenyiCD,
  paretoWins,
  rankCases,
  rankCell,
  type BenchRow,
  type RankMetric,
} from '../src/components/labs/bench/benchData.ts'

const row = (tool: string, c: string, extra: Record<string, unknown> = {}): BenchRow => ({
  tool,
  caseId: `c/${c}`,
  corpus: 'c',
  heldOut: true,
  status: 'ok',
  lane: 'colour',
  ...extra,
})

const DE: RankMetric = { key: 'meanDeltaE', label: 'ΔE', better: 'lower', ground: false }
const EDGE: RankMetric = { key: 'chamfer', label: 'Edge', better: 'lower', ground: true }
const DINO: RankMetric = { key: 'sbDino', label: 'DINO', better: 'higher', ground: false }

const close = (a: number, b: number, eps: number, what = '') =>
  assert.ok(Math.abs(a - b) <= eps, `${what} ${a} vs ${b} (±${eps})`)

test('rankCell: direction, shared average ranks, nulls tied last', () => {
  assert.deepEqual(rankCell([3, 1, 2], 'lower'), [3, 1, 2])
  assert.deepEqual(rankCell([3, 1, 2], 'higher'), [1, 3, 2])
  assert.deepEqual(rankCell([1, 1, 2, 5], 'lower'), [1.5, 1.5, 3, 4])
  // two failures share ranks 3 and 4
  assert.deepEqual(rankCell([null, 2, null, 1], 'lower'), [3.5, 2, 3.5, 1])
  // a failure is behind the worst scored value, whichever direction "better" is
  assert.deepEqual(rankCell([0.1, null], 'higher'), [1, 2])
})

test('meanRanks: hand-computed, a failed tool is ranked last and not skipped', () => {
  // case 1: ΔE a 1, b 2, c 3 → 1 2 3;  DINO a .9 b .9 c .8 → 1.5 1.5 3
  // case 2: c FAILED (its white-render ΔE 0.5 would win, and must not); a 2, b 1
  //         ΔE → a 2, b 1, c 3;  DINO a .7 b .8 → a 2 b 1 c 3
  const rows = [
    row('a', '1', { meanDeltaE: 1, sbDino: 0.9 }),
    row('b', '1', { meanDeltaE: 2, sbDino: 0.9 }),
    row('c', '1', { meanDeltaE: 3, sbDino: 0.8 }),
    row('a', '2', { meanDeltaE: 2, sbDino: 0.7 }),
    row('b', '2', { meanDeltaE: 1, sbDino: 0.8 }),
    row('c', '2', { meanDeltaE: 0.5, sbDino: 0.99, status: 'trace-failed' }),
  ]
  const mr = meanRanks(rows, { corpus: 'c', metrics: [DE, DINO] })
  const by = new Map(mr.ranking.map((r) => [r.tool, r]))
  assert.equal(mr.n, 2)
  assert.equal(by.get('a')?.mean, (1 + 1.5 + 2 + 2) / 4)
  assert.equal(by.get('b')?.mean, (2 + 1.5 + 1 + 1) / 4)
  assert.equal(by.get('c')?.mean, 3)
  assert.deepEqual(
    mr.ranking.map((r) => r.tool),
    ['b', 'a', 'c'],
  )
  assert.equal(by.get('a')?.perMetric.meanDeltaE, 1.5)
  assert.equal(by.get('c')?.perMetric.sbDino, 3)
  // the CI brackets the mean and is reproducible
  const again = meanRanks(rows, { corpus: 'c', metrics: [DE, DINO] })
  for (const r of mr.ranking) {
    assert.ok(r.lo <= r.mean && r.mean <= r.hi)
    assert.deepEqual(
      r,
      again.ranking.find((x) => x.tool === r.tool),
    )
  }
})

test('a refused OUTPUT is last on that metric; a refused GROUND TRUTH drops the cell for all', () => {
  const rows = [
    // case 1: a's geometry refused (no chamfer) → a last on Edge only
    row('a', '1', { meanDeltaE: 1, geomRefusal: 'stroked' }),
    row('b', '1', { meanDeltaE: 2, chamfer: 0.5 }),
    // case 2: the authored SVG is refused → Edge left out of the case for everyone
    row('a', '2', { meanDeltaE: 2, gtRefusal: 'clipped' }),
    row('b', '2', { meanDeltaE: 1, gtRefusal: 'clipped', chamfer: 0.1 }),
    // case 3: nobody has a chamfer (no interior boundary) → unmeasured, left out
    row('a', '3', { meanDeltaE: 1 }),
    row('b', '3', { meanDeltaE: 2 }),
  ]
  const rc = rankCases(rows, { corpus: 'c', metrics: [DE, EDGE] })
  assert.deepEqual(
    rc.cases.map((c) => c.metrics),
    [['meanDeltaE', 'chamfer'], ['meanDeltaE'], ['meanDeltaE']],
  )
  assert.deepEqual(rc.cases[0].ranks[1], [2, 1])
  assert.deepEqual(rc.dropped, { ground: 1, unmeasured: 1 })
  const mr = meanRanks(rows, { corpus: 'c', metrics: [DE, EDGE] })
  const a = mr.ranking.find((r) => r.tool === 'a')
  assert.ok(a)
  // cells: ΔE 1, Edge 2 | ΔE 2 | ΔE 1 → 6 / 4
  assert.equal(a.mean, 6 / 4)
  assert.equal(a.cells, 4)
  // per case (1.5, 2, 1) → 1.5: equal here only by coincidence of the numbers
  assert.equal(a.caseMean, (1.5 + 2 + 1) / 3)
})

test('ablation rows are never in the headline; the ablation view has them; a partial tool is excluded', () => {
  assert.ok(isAblationRow('logolab-abl-tiled-grad'))
  assert.ok(isAblationRow('logolab-gate')) // oracle
  assert.ok(isAblationRow('logolab-abl-stacked-grad'))
  assert.ok(isAblationRow('logolab-product')) // its name in local runs older than v8
  assert.ok(isAblationRow('vtracer-swept'))
  assert.ok(!isAblationRow('logolab-auto'))
  assert.ok(!isAblationRow('vtracer-default'))
  const rows: BenchRow[] = []
  for (const c of ['1', '2'])
    for (const [t, v] of [
      ['logolab-auto', 2],
      ['vtracer-default', 3],
      ['logolab-gate', 1],
      ['vtracer-swept', 0.5],
    ] as const)
      rows.push(row(t, c, { meanDeltaE: v }))
  rows.push(row('potrace', '1', { meanDeltaE: 0.1 })) // ran on one case of two
  const head = leaderboard(rows, { corpus: 'c', metrics: [DE] })
  assert.deepEqual(
    head.tools.map((t) => t.tool),
    ['logolab-auto', 'vtracer-default'],
  )
  assert.equal(head.tools[0].mean, 1)
  assert.deepEqual(
    head.excluded.map((e) => e.tool),
    ['potrace'],
  )
  const abl = leaderboard(rows, { corpus: 'c', metrics: [DE], view: 'ablation' })
  assert.deepEqual(
    abl.tools.map((t) => t.tool),
    ['vtracer-swept', 'logolab-gate', 'logolab-auto', 'vtracer-default'],
  )
})

test('corpus kind and metric sets are explicit', () => {
  assert.equal(corpusKind('strokes-oss'), 'line')
  assert.equal(corpusKind('svgemoji-v0'), 'fill')
  assert.equal(corpusKind('logos-cc0'), 'fill')
  assert.deepEqual(
    RANK_METRICS.fill.map((m) => m.key),
    ['meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks', 'sbDino'],
  )
  assert.deepEqual(
    RANK_METRICS.line.map((m) => m.key),
    ['clCentre', 'clMissed', 'clWidthErr', 'clPathsDelta', 'clTurns', 'meanDeltaE', 'docNodes'],
  )
  // |paths Δ|: one path too many and one too few are equally wrong
  const rows = [row('a', '1', { clPathsDelta: -2 }), row('b', '1', { clPathsDelta: 1 })]
  const pd = RANK_METRICS.line.filter((m) => m.key === 'clPathsDelta')
  assert.deepEqual(rankCases(rows, { corpus: 'c', metrics: pd }).cases[0].ranks[0], [2, 1])
})

test('Friedman and Iman–Davenport reproduce Demšar 2006 §3.2.2 (k = 4, N = 14)', () => {
  // Demšar's worked example: average ranks 3.143, 2.000, 2.893, 1.964 over 14 data sets
  // give χ²_F = 9.28 and F_F = 3.69 (critical F(3, 39) at α .05 is 2.85).
  const f = friedmanFromMeans([3.143, 2.0, 2.893, 1.964], 14)
  assert.ok(f)
  close(f.chi2, 9.28, 0.01, 'χ²')
  close(f.ff, 3.69, 0.01, 'F_F')
  assert.equal(f.df1, 3)
  assert.equal(f.df2, 39)
  assert.ok(f.pF < 0.05 && f.pF > 0.01)
  // CD at α .05: 2.569 · √(4·5 / (6·14)) = 1.25 (Demšar's figure)
  close(nemenyiCD(4, 14) ?? 0, 1.25, 0.005, 'CD')
})

test('Friedman on a rank matrix, hand-computed', () => {
  // rank sums 5, 8, 11 over 4 blocks: χ² = 12/(4·3·4) · 210 − 3·4·4 = 4.5
  const f = friedman([
    [1, 2, 3],
    [1, 2, 3],
    [1, 3, 2],
    [2, 1, 3],
  ])
  assert.ok(f)
  close(f.chi2, 4.5, 1e-9, 'χ²')
  close(f.p, Math.exp(-4.5 / 2), 1e-7, 'p (df 2: e^{-x/2})')
  close(f.ff, (3 * 4.5) / (4 * 2 - 4.5), 1e-9, 'F_F')
  // perfect agreement: F_F is infinite, its p is 0
  const g = friedman([
    [1, 2],
    [1, 2],
  ])
  assert.ok(g)
  assert.equal(g.pF, 0)
})

test('the distribution tails are right', () => {
  close(chi2Sf(3.841459, 1), 0.05, 1e-6, 'χ²(1)')
  close(chi2Sf(18.307038, 10), 0.05, 1e-6, 'χ²(10)')
  close(fSf(2.845, 3, 39), 0.05, 1e-3, 'F(3,39)') // Demšar: "the critical value … is 2.85"
  close(fSf(4.964603, 1, 10), 0.05, 1e-6, 'F(1,10)')
})

/** P(range of k standard normals ≤ q), the studentized range with ∞ df. */
function rangeCdf(q: number, k: number): number {
  const erf = (x: number): number => {
    const s = Math.sign(x)
    const a = Math.abs(x)
    if (a >= 3) {
      // erfc's continued fraction: the series below cancels catastrophically out here
      let f = 0
      for (let n = 60; n >= 1; n--) f = n / 2 / (a + f)
      return s * (1 - Math.exp(-a * a) / Math.sqrt(Math.PI) / (a + f))
    }
    let sum = a
    let t = a
    for (let n = 1; n < 200; n++) {
      t *= (-a * a) / n
      sum += t / (2 * n + 1)
    }
    return ((s * 2) / Math.sqrt(Math.PI)) * sum
  }
  const Phi = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2))
  let s = 0
  const h = 0.005
  for (let z = -8; z <= 8; z += h)
    s += (Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI)) * (Phi(z + q) - Phi(z)) ** (k - 1) * h
  return k * s
}

test('Nemenyi q: Demšar Table 5(a) as printed, and every entry is the studentized range / √2', () => {
  const demsar05 = [1.96, 2.343, 2.569, 2.728, 2.85, 2.949, 3.031, 3.102, 3.164]
  const demsar10 = [1.645, 2.052, 2.291, 2.459, 2.589, 2.693, 2.78, 2.855, 2.92]
  assert.deepEqual(NEMENYI_Q['0.05'].slice(0, 9), demsar05)
  assert.deepEqual(NEMENYI_Q['0.10'].slice(0, 9), demsar10)
  assert.equal(NEMENYI_Q['0.05'].length, 20) // k = 2..21
  assert.equal(NEMENYI_Q['0.10'].length, 20)
  assert.equal(NEMENYI_Q['0.05'][4 - 2], 2.569) // k = 4, α .05
  for (const [alpha, qs] of [
    [0.05, NEMENYI_Q['0.05']],
    [0.1, NEMENYI_Q['0.10']],
  ] as const)
    for (const k of [2, 6, 10, 13, 16, 19, 21]) {
      // the tabled q sits where the range's CDF crosses 1 − α (to the table's 3 decimals)
      const q = qs[k - 2] * Math.SQRT2
      assert.ok(rangeCdf(q - 0.0015 * Math.SQRT2, k) < 1 - alpha, `k=${k} α=${alpha} low`)
      assert.ok(rangeCdf(q + 0.0015 * Math.SQRT2, k) > 1 - alpha, `k=${k} α=${alpha} high`)
    }
  assert.equal(nemenyiCD(1, 10), null)
  assert.equal(nemenyiCD(22, 10), null)
})

test('cdGroups joins the maximal runs closer than CD', () => {
  // 1.5 → 2.6 is under 1.2, 1.5 → 2.8 is not: three overlapping bars, none nested
  assert.deepEqual(cdGroups([1, 1.5, 2.6, 2.8, 5], 1.2), [
    [0, 1],
    [1, 2],
    [2, 3],
  ])
  assert.deepEqual(cdGroups([1, 1.2, 1.4, 4], 1), [[0, 2]])
  assert.deepEqual(cdGroups([1, 3, 5], 1), [])
})

test('paretoWins: dominate, lose, trade, tie', () => {
  // case 1: a better on both → a beats b and c; b vs c trade (incomparable)
  // case 2: everyone level → ties
  const rows = [
    row('a', '1', { meanDeltaE: 1, sbDino: 0.9 }),
    row('b', '1', { meanDeltaE: 2, sbDino: 0.5 }),
    row('c', '1', { meanDeltaE: 3, sbDino: 0.6 }),
    row('a', '2', { meanDeltaE: 1, sbDino: 0.9 }),
    row('b', '2', { meanDeltaE: 1, sbDino: 0.9 }),
    row('c', '2', { meanDeltaE: 1, sbDino: 0.9 }),
  ]
  const p = new Map(paretoWins(rows, { corpus: 'c', metrics: [DE, DINO] }).map((x) => [x.tool, x]))
  assert.deepEqual(p.get('a'), { tool: 'a', pairs: 4, win: 0.5, loss: 0, incomparable: 0, tie: 0.5 })
  assert.deepEqual(p.get('b'), { tool: 'b', pairs: 4, win: 0, loss: 0.25, incomparable: 0.25, tie: 0.5 })
  // a failed tool loses to every scored one
  const f = paretoWins([row('a', '1', { meanDeltaE: 9 }), row('b', '1', { status: 'trace-failed' })], {
    corpus: 'c',
    metrics: [DE],
  })
  assert.equal(f[0].win, 1)
  assert.equal(f[1].loss, 1)
})
