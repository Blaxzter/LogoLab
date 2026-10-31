// A run's progress on disk (bench/compare/progress.ts): an entry comes back only under the key
// it was saved with, --fresh sees none, and a file a killed run left half-written is redone,
// not read.
//
//   node --test test/bench-progress.test.ts

import test from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { progress, readSvgbenchRows } from '../bench/compare/progress.ts'

const scratch = (): string => mkdtempSync(join(tmpdir(), 'bench-progress-'))

test('an entry is reused only under its own key; --fresh reuses nothing', () => {
  const dir = scratch()
  try {
    const p = progress(dir, false)
    assert.equal(p.get('rows/logolab-auto', 'strokes-oss/feather-send', 'k1'), null)
    p.put('rows/logolab-auto', 'strokes-oss/feather-send', 'k1', { n: 1 })
    assert.deepEqual(p.get('rows/logolab-auto', 'strokes-oss/feather-send', 'k1'), { n: 1 })
    assert.equal(p.get('rows/logolab-auto', 'strokes-oss/feather-send', 'k2'), null, 'code or input changed')
    assert.equal(progress(dir, true).get('rows/logolab-auto', 'strokes-oss/feather-send', 'k1'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a half-written entry and a cut-off SVG-Bench line are dropped, not trusted', () => {
  const dir = scratch()
  try {
    const p = progress(dir, false)
    p.put('traces/x', 'a', 'k', { svg: '<svg/>' })
    writeFileSync(join(dir, 'progress', 'traces', 'x', 'a.json'), '{"key":"k","value":{"sv')
    assert.equal(p.get('traces/x', 'a', 'k'), null)

    const out = join(dir, 'svgbench.jsonl')
    writeFileSync(out, `${JSON.stringify({ meta: { device: 'cuda' } })}\n`)
    appendFileSync(out, `${JSON.stringify({ key: 't|a', digest: 'd1', dino: 0.9 })}\n`)
    appendFileSync(out, `${JSON.stringify({ key: 't|b', dino: 0.8 })}\n`) // no digest: an old pass
    appendFileSync(out, '{"key":"t|c","digest":"d3","di')
    const r = readSvgbenchRows(out)
    assert.deepEqual(r.meta, { device: 'cuda' })
    assert.deepEqual([...r.rows.keys()], ['t|a'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
