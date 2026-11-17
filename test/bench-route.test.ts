// /labs/bench's address (src/components/labs/bench/benchRoute.ts): the tab is the path, what
// is on screen is the query.
//
//   node --test test/bench-route.test.ts
//
// What this guards looks fine in a screenshot either way: a tab link that drops the corpus
// opens Results on a different leaderboard than the one you were reading, and a link that
// writes the defaults stops following the newest run.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BENCH_SUBPATHS,
  BENCH_TABS,
  benchHref,
  benchPath,
  patchParams,
  pickCorpus,
  tabFromSegment,
} from '../src/components/labs/bench/benchRoute.ts'

const q = (s: string) => new URLSearchParams(s)

test('every tab has a path, and the path names the tab back', () => {
  for (const tab of BENCH_TABS) {
    const segment = benchPath(tab).slice('/labs/bench'.length + 1) || undefined
    assert.equal(tabFromSegment(segment), tab)
  }
  assert.equal(benchPath('overview'), '/labs/bench')
  assert.equal(benchPath('results'), '/labs/bench/results')
  assert.ok(!BENCH_SUBPATHS.includes('overview'), 'the Overview is the bare path, not /overview')
})

test('an unknown segment names no tab', () => {
  assert.equal(tabFromSegment('overview'), null)
  assert.equal(tabFromSegment('Results'), null)
  assert.equal(tabFromSegment('leaderboard'), null)
})

test('a tab link keeps the corpus, run, search and dev source', () => {
  const now = q('corpus=svgemoji-v0&run=v8&q=1f600&source=hub')
  assert.equal(benchHref('results', now), '/labs/bench/results?corpus=svgemoji-v0&run=v8&q=1f600&source=hub')
  assert.equal(benchHref('overview', q('')), '/labs/bench')
})

test("one tab's keys are dropped on the way to another and written on its own", () => {
  const onCompare = q('corpus=logos-cc0&a=logolab-auto&b=trazor-auto')
  assert.equal(benchHref('results', onCompare), '/labs/bench/results?corpus=logos-cc0')
  assert.equal(
    benchHref('compare', q('corpus=logos-cc0'), { a: 'logolab-auto', b: 'vtracer-default', other: 'v8' }),
    '/labs/bench/compare?corpus=logos-cc0&a=logolab-auto&b=vtracer-default',
    'Run’s key does not ride along to Compare',
  )
  assert.equal(benchHref('run', q('other=v8'), { other: 'v7' }), '/labs/bench/run?other=v7')
})

test('a default or empty value is not written', () => {
  const next = patchParams(
    q('corpus=svgemoji-v0&q=x'),
    { corpus: 'logos-cc0', run: 'v9' },
    { corpus: 'logos-cc0', run: 'v9' },
  )
  assert.equal(next.toString(), 'q=x')
  assert.equal(patchParams(q('other=v8'), { other: '' }).toString(), '')
  assert.equal(patchParams(q(''), { corpus: 'strokes-oss' }, { corpus: 'logos-cc0' }).toString(), 'corpus=strokes-oss')
})

test('the corpus is the linked one when the list has it, else the first', () => {
  const corpora = ['logos-cc0', 'svgemoji-v0', 'strokes-oss']
  assert.equal(pickCorpus('svgemoji-v0', corpora), 'svgemoji-v0')
  assert.equal(pickCorpus('truth0', corpora), 'logos-cc0', 'the Overview board ranks no in-sample corpus')
  assert.equal(pickCorpus(null, corpora), 'logos-cc0')
  assert.equal(pickCorpus(null, []), '')
})
