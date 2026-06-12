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
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { score } from '../src/devtest/scoreboard.ts'

ensureImageData()

for (const c of PNG_CORPUS) {
  test(`harness: ${c.name} (crisp) is deterministic with finite metrics`, async () => {
    const img = loadPng(c.path)
    const row = await score(c.name, 'crisp', img, () =>
      traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true }),
    )
    assert.equal(row.determinism, 'pass', 'same input + settings must yield a byte-identical doc')
    assert.ok(row.paths > 0, 'produced at least one path')
    assert.ok(
      Number.isFinite(row.l1Lab) && Number.isFinite(row.meanDeltaE) && Number.isFinite(row.ssim),
      'metrics are finite',
    )
    assert.ok(row.ssim > 0 && row.ssim <= 1 + 1e-9, `ssim in range, got ${row.ssim}`)
  })
}
