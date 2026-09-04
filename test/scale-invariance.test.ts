// CROSS-RESOLUTION gate: the same artwork must produce the same SHAPE at every raster size.
//
//   node --test test/scale-invariance.test.ts
//
// ---------------------------------------------------------------------------
// The hole this closes
//
// truth-gate.test.ts scores @512. Its LOWRES lane scores @256. Both are ABSOLUTE gates
// against the authored SVG, and both are honest — but each grades ONE resolution against
// tolerances calibrated at THAT raster, in that raster's pixels. So nothing anywhere
// asserts that the two agree, and a tracer whose geometry is a function of the RASTER
// rather than of the ARTWORK passes both, at every size, forever.
//
// It is not a hypothetical. The planar engine places every boundary sample on the INTEGER
// crack lattice between label regions (planarNetwork.ts); only junctions are refined
// sub-pixel (planarJunction / planarThread). Measured at HEAD with `scaleDiag --lattice`,
// the raw crack chains sit 0.223 / 0.224 / 0.226 px from the authored geometry at
// 256 / 512 / 1024 — a CONSTANT in the lane's own pixels, which is precisely the
// quantization floor of integer-lattice sampling. In the artwork's units that error
// therefore falls 1:1 with the raster, and every downstream number follows it: tier-0
// median drift 4.69× over a 4× lattice, i.e. at the pure-lattice line.
//
// ---------------------------------------------------------------------------
// What it asserts, and the contract
//
// One number per case: `drift` = boundary error at the coarsest lane ÷ the same error at
// the finest, BOTH measured in one reference space (scaleScore.ts explains the affine that
// makes that comparison legitimate). 1.0 = a function of the artwork. 4.0 = a function of
// the lattice, over this 4× span.
//
// KNOWN_DEFECTS is the same BOOLEAN contract truth-gate.test.ts uses, and for the same
// reason: this gate is RED across the board on the day it lands (that is the finding), and
// a permanently-red gate gets switched off. So the failures are ENUMERATED, never
// accommodated:
//   • a case NOT listed must pass — a new failure breaks the build;
//   • a case listed must still FAIL — if it starts passing, the build breaks and tells you
//     to delete the entry.
// There is no tolerance band and no recorded "current value", so the tracer can improve
// without asking anyone's permission. SCALE_DRIFT_MAX is NOT to be widened to make a case
// pass — §0's rules exist because that is the failure mode that killed earlier benchmarks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { measureScale, SCALE_CORPUS, SCALE_DRIFT_MAX, SCALE_SIGNAL_FLOOR } from '../src/devtest/scaleScore.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** The two ends of the span. Drift is defined by them; the middle lane is the CLI's job. */
const RESOLUTIONS = [256, 1024]

/**
 * Cases whose geometry is a function of the LATTICE today. Every entry is the same
 * mechanism — boundary samples quantized to the integer crack lattice before anything is
 * fitted (§0 #8) — measured per case with `scaleDiag --lattice`, not assumed.
 *
 * Landed 2026-08-04 with the instrument that produced the numbers. The values quoted are
 * @256 vs @1024 over the 3-lane sweep; the gate's own 2-lane run reproduces them.
 *
 * ⚠ `annulus` is deliberately NOT here, and that is the point of including it: at 1.69 it
 * already passes, because its boundary is fitted to a resolution-FREE primitive (the circle
 * snap) rather than to lattice samples. It is the existence proof that drift falls toward 1
 * when the representation stops being the lattice — and the guard that a fix elsewhere must
 * not cost it.
 */
const KNOWN_DEFECTS: Record<string, string> = {
  overlap: 'drift 6.96× — two soft-edged discs; boundary is pure lattice staircase (lattice 0.22px/lane at every res)',
  // concentric was here ("drift 4.28× — circle boundaries sampled on the lattice") until
  // 2026-08-04, the day §15's sub-pixel edge placement landed: @256 chamfer fell 0.045px
  // in-lane (0.179 ref-px), regularized drift 1.19×. Deleted by the CI contract.
  // sharp-star was here ("drift 4.69× — straight arms ride the lattice") until the same
  // day, closed by the same §15 pass once the anchor-flatness guard stopped its thin-arm
  // anchors being polluted: chamfer 0.264 → 0.068 ref-px, regularized drift 1.76×.
  // §24 took this from 3.98× to 2.01×, and it still fails — by a whisker, and for a reason
  // the note above already predicts. The family pass makes the FINE end resolution-free
  // (chamfer @1024 0.288 → 0.263 ref-px) while @256 stays on the lattice at 0.529, and this
  // gate is a RATIO: improving one lane and not the other raises it. That is the same
  // mechanism `annulus` is kept here to demonstrate, seen from its unhappy side — drift
  // falls toward 1 only once BOTH lanes stop being lattice samples. The absolute error is
  // strictly better than when this entry read 3.98×; the entry can only shrink further.
  petals: 'drift 2.01× — @1024 is now resolution-free (0.263 ref-px) but @256 still rides the lattice at 0.529; a ratio gate reads that as drift (§24)',
  'aa-seam': 'drift 4.98× — the diagonal blend band; @1024 stalls at 0.228 on the §0 #3 sliver residue, so the ratio understates it',
  'band-cross': 'drift 3.69× — the §14 control; weak boundaries are harmless but the strong edges still ride the lattice',
}

for (const c of SCALE_CORPUS) {
  test(`scale: ${c.name} @${RESOLUTIONS[0]} vs @${RESOLUTIONS[1]}`, async () => {
    const r = await measureScale(c.name, join(root, c.svg), { gradients: c.gradients, resolutions: RESOLUTIONS })
    const fine = r.lanes[r.lanes.length - 1]

    if (!(fine.samples > 0) || !Number.isFinite(fine.chamfer) || !Number.isFinite(r.lanes[0].chamfer)) {
      console.log(`    ${c.name}: not gradeable — no boundary samples`)
      return
    }

    // The REGULARIZED drift test — coarse ≤ MAX · max(fine, floor). scaleScore.ts derives
    // the floor from the kappa-circle representation error; without it a case whose fine
    // end reaches the representation floor fails on a ratio of two noise terms.
    const gatedDrift = r.lanes[0].chamfer / Math.max(fine.chamfer, SCALE_SIGNAL_FLOOR)

    const known = KNOWN_DEFECTS[c.name]
    const detail =
      `drift ${gatedDrift.toFixed(2)}× (raw ${r.drift.toFixed(2)}×) over a ${r.ratio}× lattice ` +
      `(chamfer ${r.lanes[0].chamfer.toFixed(3)} → ${fine.chamfer.toFixed(3)} ref-px; ` +
      `self ${r.selfChamfer.toFixed(3)}px)`

    if (known) {
      assert.ok(
        gatedDrift > SCALE_DRIFT_MAX,
        `${c.name} is listed in KNOWN_DEFECTS ("${known}") but now PASSES the scale gate: ${detail}.\n` +
          `      That is good news — the trace is no longer a function of the raster. Delete its\n` +
          `      entry from KNOWN_DEFECTS in test/scale-invariance.test.ts to lock the improvement in.`,
      )
      return
    }

    assert.ok(
      gatedDrift <= SCALE_DRIFT_MAX,
      `${c.name} fails the cross-resolution gate: ${detail}, limit ≤ ${SCALE_DRIFT_MAX}.\n` +
        `      Boundary error must improve LESS than proportionally to the raster — otherwise the\n` +
        `      geometry is being chosen by the lattice, not by the artwork. This is measured against\n` +
        `      the AUTHORED SVG at both sizes, so it is not drift from a baseline, it is wrong.\n` +
        `      Either fix the tracer, or (if understood and accepted for now) add ${c.name} to\n` +
        `      KNOWN_DEFECTS with a one-line reason. Do NOT widen SCALE_DRIFT_MAX.`,
    )
  })
}
