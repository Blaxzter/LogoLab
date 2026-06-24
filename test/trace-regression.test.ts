// Tracing regression gate (the "validation set"): re-trace the golden corpus and
// assert the output hasn't regressed in quality, node/path structure, or geometry.
//
// HARD asserts (fail the build):
//   • rendered fidelity within tolerance of golden (meanΔE, SSIM, seam),
//   • path / node counts within ±12% (catches structural blow-ups or collapse),
//   • determinism — a second trace is byte-identical.
// SOFT report (logged, never fails): the exact doc hash + node-position fingerprint,
//   so an intentional change shows precisely what moved. Bless changes with
//   `npm run gen:golden`.
//
// Slow cases (gradients-on photo) run only with INCLUDE_SLOW=1 so the default suite
// stays fast.
//
//   node --test test/trace-regression.test.ts
//   INCLUDE_SLOW=1 node --test test/trace-regression.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { hashDoc } from '../src/devtest/metrics.ts'
import { traceImage } from '../src/lib/trace/index.ts'
import {
  GOLDEN_CORPUS,
  caseAvailable,
  loadCase,
  recordCase,
  loadGolden,
  geomSignature,
} from '../src/devtest/traceGolden.ts'

ensureImageData()

const golden = loadGolden()
const includeSlow = process.env.INCLUDE_SLOW === '1'

// Tolerances — generous enough that a genuine improvement passes, tight enough that
// a real regression (muddy merge, exploded node count, drifted geometry) fails.
const TOL = {
  meanDeltaE: 0.6, // CIE76 ΔE units the render mean may worsen by
  ssim: 0.012, // SSIM the render may drop by
  seamMax: 2.0, // ΔE the worst smooth-field seam may worsen by
  countRatio: 0.12, // ±12% drift allowed in path / node counts
}

for (const c of GOLDEN_CORPUS) {
  const g = golden[c.name]
  // Skip cases whose (untracked) fixture or golden record is absent, and slow cases
  // unless explicitly opted in — so a fresh checkout still runs the always-present
  // nebula / petals guards.
  const run = (includeSlow || !c.slow) && caseAvailable(c) && g ? test : test.skip

  run(`regression: ${c.name} stays within tolerance of golden`, async () => {
    assert.ok(g, `no golden for "${c.name}" — run \`npm run gen:golden\` first`)

    const rec = await recordCase(c)

    // Quality must not regress beyond tolerance.
    assert.ok(
      rec.meanDeltaE <= g.meanDeltaE + TOL.meanDeltaE,
      `${c.name}: meanΔE ${rec.meanDeltaE} > golden ${g.meanDeltaE} + ${TOL.meanDeltaE}`,
    )
    assert.ok(
      rec.ssim >= g.ssim - TOL.ssim,
      `${c.name}: SSIM ${rec.ssim} < golden ${g.ssim} − ${TOL.ssim}`,
    )
    assert.ok(
      rec.seamMax <= g.seamMax + TOL.seamMax,
      `${c.name}: seam ${rec.seamMax} > golden ${g.seamMax} + ${TOL.seamMax}`,
    )

    // Structure (node / path counts) must not drift wildly.
    within(c.name, 'paths', rec.paths, g.paths)
    within(c.name, 'nodes', rec.nodes, g.nodes)

    // Geometry / exact-output drift: report, don't fail.
    if (rec.hash !== g.hash || rec.geomSig !== g.geomSig) {
      console.log(
        `  ↳ ${c.name}: output changed (hash ${g.hash}→${rec.hash}, geom ${g.geomSig}→${rec.geomSig}). ` +
        `Expected on intentional changes — run \`npm run gen:golden\` to bless.`,
      )
    }
  })

  run(`regression: ${c.name} is deterministic`, async () => {
    const img = loadCase(c)
    const a = await traceImage(img as unknown as ImageData, c.options)
    const b = await traceImage(img as unknown as ImageData, c.options)
    assert.equal(hashDoc(a), hashDoc(b), `${c.name}: re-trace must be byte-identical`)
    assert.equal(geomSignature(a), geomSignature(b), `${c.name}: node positions must be stable`)
  })
}

function within(name: string, label: string, got: number, want: number): void {
  const lo = Math.floor(want * (1 - TOL.countRatio))
  const hi = Math.ceil(want * (1 + TOL.countRatio))
  assert.ok(got >= lo && got <= hi, `${name}: ${label} ${got} outside golden ${want} ±${TOL.countRatio * 100}% [${lo}, ${hi}]`)
}
