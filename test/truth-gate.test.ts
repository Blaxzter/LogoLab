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
import { scoreGeometry, scoreRegions, circleRecovery } from '../src/devtest/geomScore.ts'
import { scoreDoc } from '../src/devtest/scoreboard.ts'
import {
  GATED_CORPUS,
  LOWRES_CORPUS,
  LOWRES_RES,
  LOWRES_TOL,
  inventedMaxFor,
  circleSpreadMaxFor,
  TIER2_REGION_CORPUS,
  TIER2_REGION_RES,
  evaluateTruthGates,
  type TruthCase,
  type TruthTol,
} from '../src/devtest/truthCorpus.ts'

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
 * Verified NOT to be ground-truth artifacts: since 2026-07-15 the scorer itself excludes
 * OCCLUDED authored boundary from the missed side (geomScore.makeVisibleAt, §9.6) — the
 * flat twins carry up to 45% hidden overdraw, and before the exclusion that manufactured
 * phantom "missed boundary" failures (taco 20px on a pixel-perfect trace). What fails a
 * gate now is the tracer, not the answer sheet.
 */
const KNOWN_DEFECTS: Record<string, string> = {
  // --- tier 0 (docs/vectorization-benchmarks.md §7) ------------------------------------
  // bar-caps (the §0 #6b driver case, authored deliberately red 2026-07-28, "corners
  // 30/43 = 69.8% — 7px cap corners bevel/blunt at AA phases") was here for the span of
  // one commit: inside a cap narrower than ~2·CORNER_WINDOW the ±4px turn test cannot
  // separate the two 90° shoulders, so apex count and placement are staircase-phase
  // lottery (1 apex → far corner bevels; 3 apexes → every fitted node blunt at 38–52°;
  // 2 misplaced → cubic end-tangent wobble reads 45° at a true corner). Fixed by the
  // cap resolver in planarFit.ts (resolveLoopCaps + cap-aware snap + cap line pin):
  // 43/43 — docs/vectorization-benchmarks.md §10.7.
  // gear-teeth (the §10 driver case, authored deliberately red 2026-07-21, "corners 21/60
  // — fixed corner window melts well-resolved small teeth") was here until 2026-07-28:
  // the measured root cause was NOT the hypothesized apex-merge/window wash but (a) the
  // detector's 70° threshold sitting ABOVE the 60° the scorer and beautify define as
  // sharp — the gear's 67.3° roots were structurally invisible — and (b) the corner
  // snap's fixed 3px arm gap + unconditional reconstruction misplacing short-armed
  // corners whose raw lattice apex was already sub-px correct. Aligning the threshold at
  // 60° and making the snap scale-aware (armGap, short-arm bypass, displacement cap,
  // arc-scaled presmooth, CORNER_MERGE 3) took corners 21/60 → 51/60 (85%), chamfer
  // 0.22 → 0.18, p95 0.78 → 0.50 — docs/vectorization-benchmarks.md §10.6.
  // gradient-flat ("p95 6.3px — edge pulled on flats bordering the gradient bg") was here
  // until 2026-07-21: two compounding causes fixed together — the Step-3c step-fit merge
  // handed the gradient's corner band to the WHITE circle's colour class (unwitnessed-jump
  // veto, segment.ts), and the triangle apex on its junction-split OPEN edge got no corner
  // snap (fitCorneredOpen, planarFit.ts) — docs/vectorization-benchmarks.md §10.3.
  // cross-bars ("corners 6 short — the junction-weld defect read through the corner lens")
  // was here until 2026-07-21: the bar-end caps at the crossing live on OPEN edges, which
  // never got the §10.2 corner snap; fitCorneredOpen closed the corner-recall gap (§10.3).
  // bloom + petals were here ("2 of 7 regions dropped — low-contrast overlap merge") until
  // 2026-07-15: the real cause was dropMinorColors dissolving small-but-real palette entries
  // by share alone; flat-interior protection fixed both (docs/vectorization-benchmarks.md §9.4).
  // aa-seam ("chamfer 1.35px, p95 24.8px") and cross-bars ("chamfer 1.04px, p95 9.6px") were
  // here until 2026-07-15: their headline numbers were mostly OCCLUDED authored outline (the
  // seam under the circle, the red bar under the blue bar) — an answer-sheet artifact, not
  // tracer error. With the missed side scored on visible boundary only (§9.6) they pass:
  // aa-seam 0.22/0.74, cross-bars 0.34/0.54. Their REAL residues — the sliver's side-
  // assignment and the junction weld — are sub-tolerance, visible at 1×, tracked as §0 #2/#3.
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
  // shaded-ink (issue #15, authored deliberately RED 2026-08-23): the colour path keeps ONE
  // ink's shading as separate palette entries and cuts every shape where the nearest-colour
  // assignment flips. The worst excursion is at the CENTRE of a disc — a boundary drawn
  // straight across it, 57px from anything the artist drew, which is the reported
  // "a disc lost its upper-left arc" reproduced. The silhouette itself survives
  // (missedMax 1.95px); the damage is invented interior structure. The case carries its
  // own control: two GENUINELY distinct authored colours at ΔE 4.63 / RGB 13.4 (flute-flat's
  // regime) that must stay two regions — the shading's knife-edge pair is ΔE 4.44 / RGB 13.5,
  // so the fixture states on its face why a colour-DISTANCE threshold cannot be the fix.
  'shaded-ink': 'chamfer 3.41px, p95 35.5px — the colour path carves one shaded ink into pieces (#15)',
  // ring-cross (issue #10) was here for the span of one commit, authored deliberately RED
  // at circle recovery 0.78px: a ring cut by a crossing leaves a "C" whose ONE boundary
  // loop runs outer arc → cap → inner arc → cap, so §1d's co-circular snap was handed
  // points from two concentric circles and asked to fit one — and the ring's arcs were
  // spread over four separate faces besides, so no per-loop grouping could ever reach
  // them. Fixed by the co-circular FAMILY pass (planarBeautify: fit each open edge, cluster
  // them across the whole topology, snap each cluster to its refit) plus placing a junction
  // claimed by two snapped circles on their INTERSECTION: 0.78 → 0.07, with the case's own
  // untouched control ring unmoved — docs/vectorization-benchmarks.md §24.

}

/**
 * Trace + score one case at one resolution and assert its gates against a defect list.
 * Shared by the @512 loop and the @256 low-res lane — the ONLY differences between the
 * lanes are the raster size, the tolerance set, the defect list, and whether the corner
 * gate applies to tier 2 (see LOWRES_CORPUS's comment in truthCorpus.ts).
 */
async function runCase(
  c: TruthCase,
  res: number,
  knownDefects: Record<string, string>,
  defectsName: string,
  opts: { tol?: TruthTol; skipTier2Corners?: boolean } = {},
): Promise<void> {
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

  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: c.gradients,
  })
  const g = scoreGeometry(toRasterSpace(gt, img.width), doc, img.width, img.height, img)
  const r = scoreRegions(img, doc)
  // Paint fidelity (gradient tier 0 only): RENDER the trace and score the pixels
  // against the source. On gradient art the geometry gates are structurally blind
  // to a paint failure (radial-glow's re-centred glow kept every gate green, §10.3);
  // this is the gate that sees it. Skipped elsewhere — evaluateTruthGates would
  // report it n/a anyway, so the render cost is only paid where it can gate.
  const paint = c.gradients && c.tier === 0 ? scoreDoc(img, doc) : null
  const corners = opts.skipTier2Corners && c.tier === 2
    ? {}
    : { gtCorners: g.gtCorners, cornersRecovered: g.cornersRecovered }
  // §23's precision term, @512 only for now. Every radius in the corpus HALVES at 256, so
  // the metric's own question ("corner or curve?") is a different question there and its
  // allowances would be a different calibration; gating a brand-new lens for the first time
  // inside another lane's numbers is the misattribution §12 warned about with tier-2 corners.
  // Named in §23.3 as the next thing to extend.
  const precision = res === RES && !(opts.skipTier2Corners && c.tier === 2)
    ? { cornersInvented: g.cornersInvented, inventedMax: inventedMaxFor(c.name) }
    : {}
  // §24's circle recovery, @512 only for §23's reason (every radius halves at 256, so the
  // same relative error is half the pixels there — its own calibration, not this one's).
  const gtRaster = toRasterSpace(gt, img.width)
  const docSets = doc.items.filter((i) => i.kind === 'path' && i.visible !== false).map((i) => i.subPaths)
  const cr = res === RES && !c.gradients ? circleRecovery(gtRaster, docSets, img.width, img.height) : null
  const circle = cr
    ? { circles: cr.circles, circleSpread: cr.spread, circleSpreadMax: circleSpreadMaxFor(c.name) }
    : {}
  const gates = evaluateTruthGates({
    samples: g.samples, chamfer: g.chamfer, p95: g.p95, parsimony: g.parsimony,
    trueRegions: r.trueRegions, recovered: r.recovered,
    ...corners,
    ...precision,
    ...circle,
    paintMean: paint?.meanDeltaE, paintP95: paint?.p95DeltaE,
    // Ink kept (§0 #14): region recovery is a MEDIAN and only flips past 50% loss, so a
    // region can pinch to a sliver with every other gate green. Flat art only.
    worstInk: r.worstInk,
    // Region recovery is meaningless on gradient art — a smooth ramp's 8-bit quantisation
    // bands read as dozens of "flat regions", so a tracer that correctly fits ONE gradient
    // would look like it dropped sixty. evaluateTruthGates returns it applicable:false, and
    // an inapplicable gate is never counted as a pass.
    flatArt: !c.gradients,
    tier: c.tier,
    tol: opts.tol,
  })
  const failing = gates.filter((x) => x.applicable && !x.pass)
  const known = knownDefects[c.name]

  if (known) {
    assert.ok(
      failing.length > 0,
      `${c.name} is listed in ${defectsName} ("${known}") but now PASSES every gate @ ${res}px.\n` +
        `      That is good news — the defect is fixed. Delete its entry from ${defectsName}\n` +
        `      in test/truth-gate.test.ts to lock the improvement in.`,
    )
    return
  }

  assert.equal(
    failing.length,
    0,
    `${c.name} (tier ${c.tier}) fails ${failing.length} ground-truth gate(s) @ ${res}px:\n` +
      failing.map((x) => `        ✗ ${x.label}: ${x.value.toFixed(2)} exceeds ${x.limit} (${x.rule})`).join('\n') +
      `\n      This is measured against the AUTHORED SVG, not against a blessed baseline — so this\n` +
      `      is not drift, it is wrong. Either fix the tracer, or (if the defect is understood and\n` +
      `      accepted for now) add ${c.name} to ${defectsName} with a one-line reason.`,
  )
}

for (const c of GATED_CORPUS) {
  test(`truth: ${c.name} (tier ${c.tier})`, () => runCase(c, RES, KNOWN_DEFECTS, 'KNOWN_DEFECTS'))
}

/**
 * The LOW-RESOLUTION lane (§0 #6/#11): the same absolute scoring at LOWRES_RES, against
 * tolerances calibrated at THAT raster (LOWRES_TOL — truthCorpus.ts documents the
 * calibration and the case selection). Nothing below 512 was gated before this lane, which
 * is exactly how the scale-blindness family (absolute segmentation floors eating features
 * that are 4× smaller @256) stayed open: the defects had no red number to beat.
 */
const KNOWN_DEFECTS_LOWRES: Record<string, string> = {
  // The lane landed with four entries, all closed the same day (2026-07-29, §12) —
  // each was a distinct low-res mechanism, and NONE was the hypothesized absolute
  // share/area floor itself:
  //   hairlines ("chamfer 0.93, p95 9.69 @256", §0 #6) — classifyBlends greedy ORDER
  //     inversion (the bars' blend cluster out-counts the pure bar colour at 256, so
  //     the blend was accepted before its endpoint existed), the mode-snap census
  //     renaming the bar entry to that grey, and the 45° diagonal being 4-DISCONNECTED
  //     (fragmenting under the restore/despeckle grouping). Fixed by the classify
  //     fixpoint + census exclusion + the 8-connected erosion-aware restore with
  //     pinch-fill: 0.31/0.74, parsimony 1.3.
  //   fluent-flute-flat (8/9) + fluent-parachute-flat (9/10) (§0 #11) — k-means
  //     starves a small colour cloud of a centroid at 256², so two authored colours
  //     share ONE cluster and §9.7's anchor veto has no merge event to refuse. Fixed
  //     by the anchor-guided cluster SPLIT in quantize: 9/9, 10/10.
  //   fluent-beverage-box-flat (6/7, p95 8.24) — the §10.4 converged-junction weld
  //     deleted a LOLLIPOP region outright (the straw's whole 129px outline shared its
  //     fused vertex pair with the 2.8px neck). Fixed by the weld length guard: 7/7,
  //     0.25/1.02.
  //
  // shaded-ink (issue #15, authored deliberately RED 2026-08-23) is listed at BOTH
  // resolutions, unlike `peak-drop`, and that difference is the point: peak-drop is
  // calibrated against an ABSOLUTE px floor and cannot straddle two rasters two octaves
  // apart, so it is excluded from this lane. This defect is a COLOUR one — the palette
  // separation of an ink's tones does not care about the raster — so it reproduces at 256
  // as it does at 512, and belongs on the list rather than out of the lane.
  'shaded-ink': 'the colour path carves one shaded ink into pieces at every raster (#15)',
}

for (const c of LOWRES_CORPUS) {
  test(`truth @${LOWRES_RES}: ${c.name} (tier ${c.tier})`, () =>
    runCase(c, LOWRES_RES, KNOWN_DEFECTS_LOWRES, 'KNOWN_DEFECTS_LOWRES', {
      tol: LOWRES_TOL[c.tier],
      skipTier2Corners: true,
    }))
}

/**
 * The TIER-2 REGION lane @512 (§0 #14): does every flat region of a tier-2 twin SURVIVE
 * at the resolution the main gate runs at? Tier 2 is browse-only @512 (too slow to gate
 * whole), and that gap is how a §10.4 regression collapsed beverage-box's `#990838` to a
 * sliver for five commits with CI green — the case is gated @256, where it passed.
 *
 * Two gates only, both tolerance-free: region recovery (zero tolerance) and ink kept
 * (a ratio, INK_MIN). truthCorpus.ts's TIER2_REGION_CORPUS comment says why the boundary
 * numbers are deliberately NOT gated here.
 */
const KNOWN_DEFECTS_TIER2_512: Record<string, string> = {
  // Empty, and it landed empty — the defect this lane exists for (§0 #14) had already
  // been closed, incidentally and unnoticed, by §15's sub-pixel edge placement. The lane
  // was verified RED against the tracer that had the defect: at 88ef5a2 (and at HEAD with
  // `planarFit.subpixelEdges: false`, which restores the lattice chains §10.4's re-seat
  // mis-reads) beverage-box measures 6/7 regions and 13.9% ink. See §12.4/§16.
}

async function runRegionCase(c: TruthCase): Promise<void> {
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const img = decodePng(
    new Resvg(svg, { fitTo: { mode: 'width', value: TIER2_REGION_RES }, background: 'white' }).render().asPng(),
  )
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: c.gradients,
  })
  const r = scoreRegions(img, doc)
  const gates = evaluateTruthGates({
    // Boundary is not gated in this lane (see TIER2_REGION_CORPUS): samples 0 reports
    // those gates n/a, and geometry is not scored at all, which is most of the runtime.
    samples: 0, chamfer: 0, p95: 0, parsimony: 0,
    trueRegions: r.trueRegions, recovered: r.recovered,
    worstInk: r.worstInk,
    flatArt: !c.gradients,
    tier: c.tier,
  })
  const failing = gates.filter((x) => x.applicable && !x.pass)
  const known = KNOWN_DEFECTS_TIER2_512[c.name]

  if (known) {
    assert.ok(
      failing.length > 0,
      `${c.name} is listed in KNOWN_DEFECTS_TIER2_512 ("${known}") but now PASSES @ ${TIER2_REGION_RES}px.\n` +
        `      Delete its entry in test/truth-gate.test.ts to lock the improvement in.`,
    )
    return
  }

  assert.equal(
    failing.length,
    0,
    `${c.name} (tier ${c.tier}) fails ${failing.length} region gate(s) @ ${TIER2_REGION_RES}px:\n` +
      failing.map((x) => `        ✗ ${x.label}: ${x.value.toFixed(x.digits)} vs ${x.rule}`).join('\n') +
      (r.missing.length
        ? `\n      dropped: ${r.missing.map((m) => `${m.hex} (${m.areaPx}px) painted ${m.paintedHex}, ΔE ${m.deltaE.toFixed(1)}`).join('; ')}`
        : '') +
      `\n      worst ink: ${r.ink[0]?.hex} ${(r.worstInk * 100).toFixed(1)}% (${r.ink[0]?.renderPx} rendered px of ${r.ink[0]?.srcPx}).\n` +
      `      A region can keep its colour and lose its AREA — that is §0 #14's mechanism.`,
  )
}

for (const c of TIER2_REGION_CORPUS) {
  test(`truth regions @${TIER2_REGION_RES}: ${c.name} (tier ${c.tier})`, () => runRegionCase(c))
}
