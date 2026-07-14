// GROUND-TRUTH gate: trace each case and score it against THE ART THAT MADE THE PIXELS.
//
//   node --test test/truth-gate.test.ts
//
// This is the absolute gate, and it is the opposite of trace-regression.test.ts. That one
// compares the tracer to its OWN previous output: it can see that something CHANGED, never
// that something is WRONG, and its ±12% bands actively forbid improvement. Here every number
// is an absolute distance from correct (0px boundary error, parsimony 1.0, every region
// recovered), so an improvement simply moves further inside the limit and NOTHING ever needs
// re-blessing.
//
// ---------------------------------------------------------------------------
// Why there is a KNOWN_DEFECTS list, and why it is not a blessed baseline
//
// The tracer does not pass this corpus today. Seven of the sixteen tier-0 cases fail a gate —
// bloom and petals each drop two overlap regions, hairlines loses its sub-pixel bars, and so
// on (docs/vectorization-benchmarks.md §7). A gate asserting "everything passes" would
// therefore be red on the day it lands, and a permanently-red gate gets switched off.
//
// So the failures are enumerated instead of accommodated. The alternative — widening the
// tolerances until today's output squeaks through — would hide exactly the defects the corpus
// was built to expose.
//
// What this list blesses is a BOOLEAN, never a number:
//   • a case NOT on the list must pass every applicable gate — a new failure breaks the build;
//   • a case ON the list must still fail — if it starts passing, the build breaks and tells
//     you to delete the entry. The list can only shrink, and it costs one line to shrink it.
// There is no tolerance band and no "current value" recorded anywhere, so the tracer can
// improve without asking anyone's permission.
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { decodePng } from '../src/devtest/png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../src/devtest/svgGround.ts'
import { scoreGeometry, scoreRegions } from '../src/devtest/geomScore.ts'
import { GATED_CORPUS, evaluateTruthGates } from '../src/devtest/truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The gate runs at ONE resolution, and it has to: every boundary limit is in PIXELS, and pixel
 * error scales with the raster (black-circle is 7.8px at 256 and 33.1px at 1024 — the same
 * trace, three different numbers). 512 is the lab's default and the resolution TIER_TOL and
 * TIER_TOL[1] were both calibrated at. Changing it invalidates every limit.
 */
const RES = 512

/**
 * Cases that FAIL a gate today, and why. Each is a real, understood defect — not a rounding
 * problem, and not a fault in the answer sheet. Delete an entry the moment its case passes;
 * the test will tell you when that happens.
 *
 * This list is the machine-checked STATUS; the ranked working list of ALL open defects —
 * including ones with no gated case, which structurally cannot appear here — is
 * docs/vectorization-benchmarks.md §0.
 *
 * Verified NOT to be ground-truth artifacts: only 1.9% of authored boundary in tier 1 is
 * occluded (invisible), and excluding it moves the corpus mean by 0.1px — so these are the
 * tracer, not phantom edges in the SVG.
 */
const KNOWN_DEFECTS: Record<string, string> = {
  // --- tier 0 (docs/vectorization-benchmarks.md §7) ------------------------------------
  'gradient-flat': 'p95 6.3px — the crisp flats bordering the gradient bg get their edge pulled',
  'aa-seam': 'chamfer 1.35px, p95 24.8px — the anti-aliased diagonal sliver',
  // bloom + petals were here ("2 of 7 regions dropped — low-contrast overlap merge") until
  // 2026-07-15: the real cause was dropMinorColors dissolving small-but-real palette entries
  // by share alone; flat-interior protection fixed both (docs/vectorization-benchmarks.md §9.4).
  'cross-bars': 'chamfer 1.04px, p95 9.6px — the junction weld',
  // hairlines was here ("chamfer 3.73px, p95 55.9px — the sub-pixel bars are simply gone")
  // until 2026-07-14: the bars died in the flat-palette stage, not the fit — blend-line
  // classification + endpoint routing + modeFilter-erasure restore fixed it (0.39/0.78 @512;
  // docs/vectorization-benchmarks.md §9.5). CAUTION from the exit: the boundary gates were
  // briefly satisfied by a ZERO-AREA path (bar 7 fitted as a degenerate 2-node loop that
  // renders as nothing) — a passing gate here does not prove the case RENDERS right; the
  // area guard in planarAssemble now prevents that collapse, but judge renders too.

  // --- tier 1 (Fluent Emoji) ------------------------------------------------------------
  // The gradient-banding defect: Fluent stacks several translucent gradients on ONE path, and
  // the tracer splits that smooth shading into regions the art does not contain. It is the
  // headline tier-1 finding — see docs/vectorization-benchmarks.md §8.
  'fluent-olive': 'chamfer 7.0px, p95 97px — invents interior edges across a 3-gradient stack',
}

for (const c of GATED_CORPUS) {
  test(`truth: ${c.name} (tier ${c.tier})`, async () => {
    const svg = readFileSync(join(root, c.svg), 'utf8')
    const gt = parseGroundTruth(svg)
    const why = unscorable(gt)
    if (why) {
      // Not a pass and not a failure — the CASE has no usable ground truth. Saying so is the
      // whole design: a case scored against geometry the renderer never drew is worse than an
      // unscored one. (aurora is stroked; checker was pattern-filled until re-authored as
      // explicit squares.)
      console.log(`    ${c.name}: not scorable — ${why}`)
      return
    }

    const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
    const doc = await traceImage(img as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: c.gradients,
    })
    const g = scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height)
    const r = scoreRegions(img, doc)
    const gates = evaluateTruthGates({
      samples: g.samples, chamfer: g.chamfer, p95: g.p95, parsimony: g.parsimony,
      trueRegions: r.trueRegions, recovered: r.recovered,
      // Region recovery is meaningless on gradient art — a smooth ramp's 8-bit quantisation
      // bands read as dozens of "flat regions", so a tracer that correctly fits ONE gradient
      // would look like it dropped sixty. evaluateTruthGates returns it applicable:false, and
      // an inapplicable gate is never counted as a pass.
      flatArt: !c.gradients,
      tier: c.tier,
    })
    const failing = gates.filter((x) => x.applicable && !x.pass)
    const known = KNOWN_DEFECTS[c.name]

    if (known) {
      assert.ok(
        failing.length > 0,
        `${c.name} is listed in KNOWN_DEFECTS ("${known}") but now PASSES every gate.\n` +
          `      That is good news — the defect is fixed. Delete its entry from KNOWN_DEFECTS\n` +
          `      in test/truth-gate.test.ts to lock the improvement in.`,
      )
      return
    }

    assert.equal(
      failing.length,
      0,
      `${c.name} (tier ${c.tier}) fails ${failing.length} ground-truth gate(s) @ ${RES}px:\n` +
        failing.map((x) => `        ✗ ${x.label}: ${x.value.toFixed(2)} exceeds ${x.limit} (${x.rule})`).join('\n') +
        `\n      This is measured against the AUTHORED SVG, not against a blessed baseline — so this\n` +
        `      is not drift, it is wrong. Either fix the tracer, or (if the defect is understood and\n` +
        `      accepted for now) add ${c.name} to KNOWN_DEFECTS with a one-line reason.`,
    )
  })
}
