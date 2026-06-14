// Headless evaluation harness (plan §5/§6 V0). Traces the PNG corpus with the
// pure crisp engine, scores it against the source, and gates two invariants:
//   1. determinism — a byte-identical re-run (the seeded-PRNG fix), and
//   2. finite, in-range fidelity metrics with at least one emitted path.
//
// The full scoreboard (both engines, all numbers) is written by
// src/devtest/runBaseline.ts and rendered visually in vectorize-test.html; this
// test is the CI guardrail.
//
//   node --test test/harness.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData, loadPng, PNG_CORPUS } from '../src/devtest/nodeHarness.ts'
import { SYNTHETIC_CORPUS, syntheticSource } from '../src/devtest/lineArtCorpus.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { score, type SourceImage } from '../src/devtest/scoreboard.ts'

ensureImageData()

function gateRow(name: string, row: { determinism: string; paths: number; l1Lab: number; meanDeltaE: number; ssim: number }) {
  assert.equal(row.determinism, 'pass', 'same input + settings must yield a byte-identical doc')
  assert.ok(row.paths > 0, 'produced at least one path')
  assert.ok(
    Number.isFinite(row.l1Lab) && Number.isFinite(row.meanDeltaE) && Number.isFinite(row.ssim),
    'metrics are finite',
  )
  assert.ok(row.ssim > 0 && row.ssim <= 1 + 1e-9, `ssim in range, got ${row.ssim}`)
}

for (const c of PNG_CORPUS) {
  test(`harness: ${c.name} (crisp) is deterministic with finite metrics`, async () => {
    const img = loadPng(c.path)
    const row = await score(c.name, 'crisp', img, () =>
      traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true }),
    )
    gateRow(c.name, row)
  })
}

for (const c of SYNTHETIC_CORPUS) {
  test(`harness: ${c.name} (crisp, synthetic) is deterministic with finite metrics`, async () => {
    const src: SourceImage = syntheticSource(c)
    const row = await score(c.name, 'crisp', src, () =>
      traceImage(src as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true }),
    )
    gateRow(c.name, row)
    // Corner-preservation guard (the Stage-A headline): the sharp-cornered mountain
    // mark must trace with its boundary ON the source edges — no rounded-corner
    // drift. The old threshold-corner fitter left summit seam ≫ 0; evidence-based
    // corner placement keeps it ≈ 0.
    if (c.name === 'summit') {
      assert.ok(row.seamMax < 3, `summit corners must stay sharp (seam max ${row.seamMax} should be ≈ 0)`)
    }
  })
}
