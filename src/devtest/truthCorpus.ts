// The GROUND-TRUTH corpus + its gates, in a form BOTH the Node gate and the browser view
// import — the same trick traceCorpus.ts plays, and for the same reason: a view that
// re-declares the case list can silently drift from what actually gets scored.
//
// ---------------------------------------------------------------------------
// How this differs from GOLDEN_CORPUS, and why it exists
//
// GOLDEN_CORPUS traces PNGs and compares the result to the tracer's OWN previous output.
// It can tell you something CHANGED. It cannot tell you anything is WRONG — and because
// its gates are ±12% bands around whatever was last blessed, it actively FORBIDS large
// improvements (dropping headphones-flat below 8,476 nodes fails the build, no matter how
// much better the output is).
//
// This corpus inverts that. The source of truth is the authored SVG that PRODUCED the
// pixels, so every gate is an ABSOLUTE distance from correct — 0px boundary error,
// parsimony 1.0, every region recovered. Improvements move numbers DOWN and nothing needs
// re-blessing. Nothing here reads test/golden/trace-baseline.json.
//
// ---------------------------------------------------------------------------
// TIERS
//
//   0  our handcrafted cases — each isolates a NAMED failure mode of this tracer.
//   1  Microsoft Fluent Emoji "Color" (MIT) — authored multi-stop gradient art, the only
//      such ground truth that exists. Generated into ./fluentCorpus.ts by
//      src/devtest/vendorFluentEmoji.ts, which triages 1,595 candidates and vendors only the
//      109 whose visible boundary svgGround can actually reproduce.
//   2  the SAME Fluent glyphs authored FLAT — tier 1's `flatSvg` controls promoted to scored
//      cases in their own right. This is the tier that matters for the PRODUCT (flat logo
//      art), and it is where `regions recovered` actually runs: that gate is inapplicable on
//      all 109 gradient cases, so before this tier it measured 12 cases; now ~118.
//
// ONE list, both tiers, both consumers (the Node CLI and /labs/truth). A sibling array would
// have to be threaded through every filter, every gate and every view separately, and the
// first one anybody forgot would drift — which is the exact failure this file exists to
// prevent. `tier` gives the split for free.
// ---------------------------------------------------------------------------

import { FLUENT_CORPUS } from './fluentCorpus.ts'

/** One ground-truth case: an authored SVG we rasterize, trace, and score against itself. */
export interface TruthCase {
  name: string
  /** Repo-relative path to the authored SVG. */
  svg: string
  /** What this case is FOR — the failure mode it is meant to catch. */
  note: string
  /** Trace with gradient fitting on? (Flat art is scored with it off.) */
  gradients: boolean
  /**
   * 0 = our handcrafted cases; 1 = Fluent Emoji "Color" (MIT); 2 = the same Fluent glyphs
   * authored FLAT. The tier picks the TOLERANCES (see TIER_TOL) — soft-edged authored
   * gradient art is not gradeable at thresholds calibrated on crisp flat art, and pretending
   * otherwise would either fail tier 1 for being itself or quietly weaken tier 0.
   */
  tier: 0 | 1 | 2
  /**
   * Run in CI? Tracing is seconds per case, so the gate is a small fixed subset and the LAB
   * browses the rest. A truth gate that takes ten minutes gets switched off, and a gate that
   * is off is not a gate.
   */
  gated?: boolean
  /**
   * The same glyph, authored FLAT — the control for the flat↔gradient A/B
   * (src/devtest/fluentAbRun.ts). Tier 1 only.
   */
  flatSvg?: string
}

/**
 * TIER 0 — the handcrafted edge cases are the heart of this: each one isolates a named
 * failure mode of THIS tracer, which no public corpus does. bloom / nebula / petals / aurora
 * are the authored SVGs we happen to already own — note these are the SAME artworks whose
 * PNGs the old golden traces, except here we score against the vector art instead of against
 * the tracer's memory of itself.
 *
 * aurora is authored with STROKES: a stroked element's visible boundary is the outline of the
 * stroke, not its centerline, and svgGround refuses to guess at that — so it reports as
 * unscorable. (cross-bars, annulus and hairlines were re-authored as fills in genEdgeCases.ts
 * and are now scored.)
 *
 * `checker` was unscorable for the same KIND of reason, found while building tier 1: its two
 * rects were `fill="url(#pattern)"`, so the visible boundary was the pattern's tiling, not the
 * rects. It used to be scored against those two rects and "failed" at 26.7px chamfer /
 * parsimony 32× — a tracer that correctly recovered the checkerboard was being charged with
 * inventing it. That was a bug in the ANSWER SHEET, not in the tracer. Re-authored 2026-07-15
 * as 896 explicit filled squares (patterns are to fills what strokes are to fills — see
 * genEdgeCases.ts), it is scorable and passes every gate (0.38px chamfer @512).
 */
export const TRUTH_CORPUS: TruthCase[] = [
  // --- the tracer's own hard problems -------------------------------------------------
  { name: 'bg-ramp', svg: 'public/examples/edge-cases/bg-ramp.svg', note: 'posterized ramp — background reunification', gradients: true, tier: 0 },
  { name: 'bg-ramp-twin', svg: 'public/examples/edge-cases/bg-ramp-twin.svg', note: 'shape sharing a band colour — the colour-class DELETE risk', gradients: true, tier: 0 },
  { name: 'gradient-flat', svg: 'public/examples/edge-cases/gradient-flat.svg', note: 'gradient bg + crisp flats — the render gate must not absorb them', gradients: true, tier: 0 },
  { name: 'radial-glow', svg: 'public/examples/edge-cases/radial-glow.svg', note: 'radial vignette — 2-D gradient paint model', gradients: true, tier: 0 },

  // --- classic tracer failure modes ---------------------------------------------------
  { name: 'concentric', svg: 'public/examples/edge-cases/concentric.svg', note: 'concentric rings — circle snap, equal-radius solver', gradients: false, tier: 0 },
  { name: 'sharp-star', svg: 'public/examples/edge-cases/sharp-star.svg', note: 'sharp points — corner preservation', gradients: false, tier: 0 },
  { name: 'aa-seam', svg: 'public/examples/edge-cases/aa-seam.svg', note: 'soft diagonal between flats — the AA sliver', gradients: false, tier: 0 },
  { name: 'checker', svg: 'public/examples/edge-cases/checker.svg', note: 'fine checkerboard — high-frequency aliasing', gradients: false, tier: 0 },
  { name: 'overlap', svg: 'public/examples/edge-cases/overlap.svg', note: 'translucent discs — layer decomposition', gradients: false, tier: 0 },
  // The §10 DRIVER, authored deliberately red (2026-07-21): tooth chords ≥ 7.5px @512 (above
  // the CORNER_MIN_EDGE grading floor, cleanly resolved) but corner spacing 7.5–12.5px — inside
  // the wash zone of the fit's fixed ±4px corner window, so most corners melt while boundary
  // stays sub-tolerance (0.22/0.78). Only the distance-blind corner gate sees it. localScaleK
  // does not move it (it gates the SNAPS; this loss is in the FIT) — the case exists to demand
  // the scale-aware fit ε / detector windows of §10's open half.
  { name: 'gear-teeth', svg: 'public/examples/edge-cases/gear-teeth.svg', note: 'small sharp teeth + large smooth disc — scale-blind fit ε / corner window (§10.5)', gradients: false, tier: 0 },
  // The §0 #6b driver, authored deliberately red (2026-07-28, the gear-teeth §10.5 pattern):
  // butt-capped 7px bars at the AA phases where the cap corners bevel/blunt away — measured
  // 30/43 = 69.8% corner recall at HEAD (< 80%) while every boundary gate stays green. The
  // regime was located by a real-pipeline sweep (capDiag.ts): 7px = CORNER_MIN_EDGE, the
  // narrowest gradeable cap; w8+ is phase-robust and the in-case w8/w10 controls must stay
  // green through any fix. See genEdgeCases.ts for the per-bar (angle, phase) cells.
  { name: 'bar-caps', svg: 'public/examples/edge-cases/bar-caps.svg', note: 'butt-capped 7px bars at AA-losing phases — cap corner recall (§0 #6b)', gradients: false, tier: 0 },
  // The CONTRAST-RANK driver (user-reported 2026-07-30, /labs/gallery on the Affinity mark).
  // A weak colour boundary (ΔE 2.7–7.5) terminating on a strong one (ΔE 47–58) splits the
  // strong edge and pins it at a junction placed by the weak evidence: the bar's flanks tilt
  // and the plate's arc kinks where it joins its straight sides. Authored FLAT so the bands
  // are IN the answer sheet — the ramp art that exposed it cannot be scored at all (§13's
  // "the defect exists only on the path nothing measures"). The control square is crossed by
  // nothing and must stay green. genEdgeCases.ts documents the rack.
  { name: 'band-cross', svg: 'public/examples/edge-cases/band-cross.svg', note: 'weak boundaries landing on strong edges — contrast-ranked junctions', gradients: false, tier: 0 },

  // Issue #17's driver, authored deliberately red (the gear-teeth §10.5 / bar-caps §0 #6b
  // pattern). An ACUTE LENS counter has two CURVED arms; the apex snap fits a straight line
  // to each over [3..14]px and intersects them, and on a curved arm that line is a chord
  // leaning inward — the crossing lands px past the real tip, inside solid ink. Measured at
  // authoring (apexDiag.ts): 7 of 15 reconstructions overshoot the raster's own coverage by
  // > 2px, worst 6.47px. The bottom row is the CONTROL that makes the case a test rather
  // than a target: eroded ink spikes whose reconstruction is RIGHT (overshoot −1.08px, i.e.
  // still inside the evidence), so "stop reconstructing" cannot pass this case.
  { name: 'acute-counter', svg: 'public/examples/edge-cases/acute-counter.svg', note: 'acute lens counters — apex reconstructed past the ink (#17)', gradients: false, tier: 0 },

  // --- authored art we already own ----------------------------------------------------
  // All under public/ so the deployed view can fetch them — Vite's dev server also serves
  // the project root, which hid the fact that examples/*.svg would 404 in a real build.
  { name: 'bloom', svg: 'public/examples/bloom.svg', note: 'translucent circles — 7 composited regions from 3 shapes', gradients: false, tier: 0 },
  { name: 'nebula', svg: 'public/examples/nebula.svg', note: 'nested opaque shapes, two sharing a fill', gradients: false, tier: 0 },
  { name: 'petals', svg: 'public/examples/petals.svg', note: 'flat multi-region art', gradients: false, tier: 0 },
  { name: 'aurora', svg: 'public/examples/aurora.svg', note: 'posterized diagonal ramp — jagged band boundaries', gradients: false, tier: 0 },

  // --- unscorable today: authored with strokes (see the note above) --------------------
  { name: 'cross-bars', svg: 'public/examples/edge-cases/cross-bars.svg', note: 'crossing bars — junction weld', gradients: false, tier: 0 },
  { name: 'annulus', svg: 'public/examples/edge-cases/annulus.svg', note: 'rings with a hole — winding + alpha', gradients: false, tier: 0 },
  { name: 'hairlines', svg: 'public/examples/edge-cases/hairlines.svg', note: 'sub-pixel strokes — thin-feature preservation', gradients: false, tier: 0 },

  // --- TIER 1 — Fluent Emoji "Color" (MIT), generated; see ./fluentCorpus.ts ------------
  ...FLUENT_CORPUS,

  // --- TIER 2 — the same Fluent glyphs authored FLAT, derived (not duplicated) from
  // FLUENT_CORPUS so the pairing can never drift. Until now these 106 files were only the
  // `flatSvg` controls of the tier-1 A/B (fluentAbRun.ts) — never scored on their own, which
  // left `regions recovered` (the dropped-region gate, the failure raster fidelity is
  // structurally blind to) running on just the 12 flat tier-0 cases. Flat multi-region art is
  // exactly what the product traces, so the flat twins are scored in their own right:
  // `gradients: false`, region recovery applicable, boundary limits measured on THIS
  // population (TIER_TOL[2] — see calibrateTier2.ts).
  ...FLUENT_CORPUS.filter((c) => c.flatSvg).map(
    (c): TruthCase => ({
      name: `${c.name}-flat`,
      svg: c.flatSvg!,
      note: `${c.note.split(' — ')[0]} — authored flat twin`,
      gradients: false,
      tier: 2,
      // No flatSvg back-reference: the lab's A/B traces `flatSvg` with gradients OFF, which
      // would silently mis-trace the gradient original if it were pointed at here.
    }),
  ),
]

/** Only the cases of one tier. */
export const tierCases = (tier: 0 | 1 | 2): TruthCase[] => TRUTH_CORPUS.filter((c) => c.tier === tier)

/**
 * What CI runs. Tier 0 in full (16 cases — it is the tracer's own failure-mode suite and
 * every case there is load-bearing), plus a small fixed slice of tier 1. The other ~99
 * gradient cases and the 106 tier-2 flat twins are browse-only in /labs/truth: a gate slow
 * enough to be annoying gets switched off, and a gate that is off is not a gate.
 */
export const GATED_CORPUS: TruthCase[] = TRUTH_CORPUS.filter((c) => c.gated ?? c.tier === 0)

/** Trace the same art at several raster sizes: a tracer whose GEOMETRY changes with input
 *  resolution is fragile, and only a resolution-independent source can reveal that. */
export const TRUTH_RESOLUTIONS = [256, 512, 1024]

/**
 * ABSOLUTE gates — the value at which a case is WRONG, not the value at which it CHANGED.
 *
 * These are first-cut and deliberately visible in the view so they can be calibrated
 * against real cases rather than guessed at in the dark. Unlike traceCorpus.TOL there is no
 * "golden" term anywhere: a tracer that improves simply moves further inside them.
 */
export const TRUTH_TOL: TruthTol = {
  /** Mean symmetric boundary distance (px). Sub-pixel is the bar for authored flat art. */
  chamfer: 1.0,
  /** 95th-percentile boundary distance (px) — the gating number; max is too brittle. */
  p95: 2.5,
  /** Node density relative to the artist's. 3× is generous; 10× is staircasing. */
  parsimony: 3.0,
}

export interface TruthTol {
  chamfer: number
  p95: number
  parsimony: number
}

/**
 * PER-TIER tolerances. TRUTH_TOL was calibrated on crisp, handcrafted FLAT art, and tier 1 is
 * not that: Fluent's Color glyphs are soft-edged authored gradient art, drawn at 32 units and
 * rasterized up, where a "boundary" between two gradient stops is a ramp several pixels wide
 * rather than a step. Holding them to tier 0's thresholds would fail them for being what they
 * are — and widening TRUTH_TOL to make them pass would silently weaken the 16 cases tier 0
 * depends on. So the tiers get their own numbers, and the view SAYS which it applied.
 *
 * Tier 1's values are MEASURED, not guessed — `node --experimental-strip-types
 * src/devtest/calibrateTier1.ts` prints the distribution they come from (109 cases @ 512px).
 * Each limit sits just above the corpus p90, which makes tier 1 a CATASTROPHE gate: it trips
 * when the tracer falls off a cliff, and it deliberately leaves ~10% of the corpus failing
 * TODAY, because those cases are real defects and hiding them behind a generous threshold
 * would defeat the point of having built the corpus.
 *
 * ⚠ These are "do not get worse" numbers, NOT "this is correct" numbers. Do not read a green
 * tier-1 gate as "the tracer is good at gradient art". It is not, yet:
 *
 *   • the tracer finds the authored SILHOUETTE very well — `missedMean` is sub-pixel on 45 of
 *     109 cases (black-circle: 0.18px);
 *   • almost all of the boundary error is INVENTED interior structure — it bands a smooth
 *     multi-gradient stack into regions that do not exist. black-circle is ONE circle painted
 *     with five stacked translucent gradients; the tracer emits THREE paths and 31px of
 *     invented edge. That is the tier-1 work item, and it is what drives the ugly p95 limit
 *     below.
 *   • a second, distinct failure: speaker-low-volume / chart-decreasing MISS ~16px of
 *     genuinely visible authored boundary (verified visible — only 1.9% of authored boundary
 *     in this corpus is occluded, so this is the tracer, not a phantom edge in the GT).
 *
 * Every one of these limits should come DOWN as those two defects are fixed.
 */
export const TIER_TOL: Record<0 | 1 | 2, TruthTol> = {
  0: TRUTH_TOL,
  1: {
    // observed p50 1.35 · p90 4.51 · max 15.74 (black-circle) — visible-only, 2026-07-15
    // (pre-§9.6: p50 1.87 · p90 5.65; occlusion exclusion moved tier 1 only modestly, as
    // §8.4's 1.9% predicted). Limits deliberately kept: catastrophe bounds, not targets.
    chamfer: 6.0,
    // observed p50 12.39 · p75 27.16 · p90 42.33 · max 160.90 (black-circle). Yes, this is a
    // terrible-looking limit. It is honest: p95 on gradient art is dominated by the invented
    // interior edges above, and setting it tight would paint the whole corpus red without
    // telling anyone anything they cannot already see in `missed` vs `invented`.
    p95: 60.0,
    // observed p50 1.23 · p90 3.03 · max 4.88. NOTE: parsimony is nearly FINE at tier 0's 3×
    // (97/109 pass) — the tracer spends FEWER nodes than the artist (mean 151 vs 252). The
    // assumption that emoji drawn at 32 units would make any tracer look profligate was wrong.
    parsimony: 5.0,
  },
  // MEASURED on the 106 flat twins @ 512px (calibrateTier2.ts) with the same recipe as
  // tier 1: boundary limits just above the corpus p90, parsimony just above the corpus max.
  // Same caveat too — "do not get worse" numbers, NOT "this is correct" numbers.
  //
  // What the calibration found on landing — and what became of it:
  //   • REGION RECOVERY, the zero-tolerance gate, failed 15 of 106 cases — 22 regions
  //     dropped, ΔE up to 115.2 (pencil's #402a32 graphite tip painted #f92f60 eraser-pink).
  //     Root cause was dropMinorColors dissolving small-but-real palette entries by share
  //     alone; FIXED 2026-07-15 by flat-interior protection (paletteSegment.ts) — now 1
  //     drop in 106 (flute, ΔE 4.5, a quantize MERGE_DISTANCE artifact). See
  //     docs/vectorization-benchmarks.md §9.1/§9.4.
  //   • the tracer INVENTS almost nothing on flat art (spurious p95 0.33px) but appeared to
  //     MISS real boundary (missed p90 5.43px, max 20.1px — taco). That was the answer
  //     sheet, not the tracer: the flat twins are authored with heavy overdraw, and the
  //     missed side was counting authored outline OCCLUDED behind later-painted shapes
  //     (taco: 45.5% of its outline). Since 2026-07-15 the scorer excludes invisible
  //     boundary (geomScore.makeVisibleAt, §9.6) and the limits below are RE-CALIBRATED on
  //     the visible-only distribution — ~6–30× tighter, and for the first time meaningful:
  //     the whole corpus now sits inside tier 0's own limits.
  2: {
    // observed (visible-only, 2026-07-15): p50 0.22 · p90 0.31 · p95 0.34 · max 0.48 (violin)
    chamfer: 0.35,
    // observed (visible-only, 2026-07-15): p50 0.62 · p90 1.02 · p95 1.22 · max 2.47 (mate)
    p95: 1.2,
    // observed p50 0.83 · p90 1.40 · max 4.23 (baguette-bread) — the tracer is usually MORE
    // economical than the artist on these (p50 below 1×). Untouched by the §9.6 change (the
    // visibility filter only drops QUERY samples; nodes and lengths stay whole).
    parsimony: 4.5,
  },
}

/*
 * ---------------------------------------------------------------------------
 * The LOW-RESOLUTION lane (§0 #6/#11)
 *
 * The main gate runs @512 and has to (its limits are in PIXELS, calibrated at that
 * raster) — which left everything below 512 ungated, and the scale-blindness family
 * invisible: the segmentation floors are absolute pixel counts, so a region that
 * survives @512 falls under them @256. This lane runs a fixed case set at LOWRES_RES
 * with its OWN calibrated tolerances (LOWRES_TOL). The @512 numbers are not shared and
 * not widened.
 *
 * Case selection (calibrateLowres.ts, 2026-07-28 — tier 0 in full + all 106 flat twins
 * swept @256):
 *  • all of tier 0 — the failure-mode suite graded at the resolution it was blind at.
 *    The sweep found exactly one tier-0 failure: `hairlines` (chamfer 0.93 / p95 9.69).
 *  • the three tier-2 cases the sweep caught dropping regions @256 — every one passes
 *    @512 (tier 2 is 437/437 there, §9.7), so each is a pure low-res driver:
 *      fluent-flute-flat        8/9  — #974827 176px painted #893925, ΔE 8.0 (§0 #11)
 *      fluent-parachute-flat    9/10 — #00a6ed  99px painted #5092ff, ΔE 28.7
 *      fluent-beverage-box-flat 6/7  — #d3f093 481px painted #c3ef3c, ΔE 36.4 (p95 8.24)
 *  • four healthy tier-2 CONTROLS pinning the calibrated tail, so a fix for the drivers
 *    cannot silently push the healthy population out: fluent-pencil-flat (the §9.4
 *    protected-tip case — its small dark tip must keep surviving @256 too),
 *    fluent-rugby-football-flat (p95 tail 2.53), fluent-nazar-amulet-flat (chamfer tail
 *    0.60), fluent-violin-flat.
 *
 * No tier-1 cases: gradient art is scoring infrastructure, not the product target, and
 * no low-res gradient defect is on the books to drive a lane entry.
 *
 * The CORNER gate is tier-0-only in this lane (the test passes gtCorners: undefined for
 * tier 2). Tier-2 corner recall is ungated at EVERY resolution today, and it measures
 * poorly at both (flute-flat: 3/10 @256, 0/9 @512 — Fluent art is drawn at 32 units, so
 * its "corners" are tiny rounded features at any raster). Gating it for the first time
 * inside the low-res lane would misattribute a resolution-INDEPENDENT behaviour to the
 * low-res family; if tier-2 corners ever get gated, that is its own calibration.
 */
export const LOWRES_RES = 256

const LOWRES_TIER2 = [
  'fluent-flute-flat',
  'fluent-parachute-flat',
  'fluent-beverage-box-flat',
  'fluent-pencil-flat',
  'fluent-rugby-football-flat',
  'fluent-nazar-amulet-flat',
  'fluent-violin-flat',
]

export const LOWRES_CORPUS: TruthCase[] = [
  ...TRUTH_CORPUS.filter((c) => c.tier === 0),
  ...TRUTH_CORPUS.filter((c) => LOWRES_TIER2.includes(c.name)),
]

/*
 * ---------------------------------------------------------------------------
 * The TIER-2 REGION lane @512 (§0 #14)
 *
 * The hole this closes is stated plainly in §12.4: "Tier 2 being ungated in CI is how a
 * 2-region regression survived five commits unnoticed." Tier 2 is browse-only @512 by
 * design (106 cases is too slow to gate, and a gate that is off is not a gate), and the
 * @256 lane added in §12 gates these same seven cases — but only at 256. #14 lived in
 * the gap: `fluent-beverage-box-flat`'s `#990838` collapsed to a sliver @512 while @256
 * stayed green, and nothing in CI was looking.
 *
 * WHY REGION + INK ONLY, and no boundary numbers. TIER_TOL[2] is a calibrated
 * CATASTROPHE gate that deliberately leaves ~10% of the twins red (§9.6's recipe: limits
 * just above the corpus p90), and beverage-box's own p95 sits in that tail at 1.28 vs
 * 1.20. Gating boundary here would therefore need either a KNOWN_DEFECTS entry — which
 * would make this lane BLIND to #14's return, since a listed case only has to fail
 * SOMETHING — or a second, looser p95 limit at the same resolution as TIER_TOL[2],
 * which is the tolerance-widening this corpus exists to prevent. Region recovery and ink
 * need no tolerance argument at all: one is zero-tolerance, the other is a ratio with a
 * 1.6× margin over the whole healthy population (INK_MIN). So the lane gates exactly the
 * two things #14 broke, and the boundary numbers stay where they were calibrated.
 *
 * Case selection: the SAME seven tier-2 cases the @256 lane runs — three region-fragile
 * drivers (flute, parachute, beverage-box) and four healthy controls (pencil, rugby-
 * football, nazar-amulet, violin). They were chosen in §12.1 by sweeping all 106 twins
 * for region loss; that is the same question this lane asks, so the selection carries
 * over unchanged rather than being re-argued.
 */
export const TIER2_REGION_RES = 512

export const TIER2_REGION_CORPUS: TruthCase[] = TRUTH_CORPUS.filter((c) => LOWRES_TIER2.includes(c.name))

/**
 * Tolerances for the @256 lane — MEASURED (calibrateLowres.ts, 2026-07-28), not copied.
 *
 * Tier 0 @256 (16 scorable cases, `hairlines` excluded as the known failure): chamfer
 * max 0.46 (cross-bars), p95 max 1.10 (gear-teeth), parsimony max 1.77 (cross-bars).
 * The @512 limits hold with ≥ 2× margin over that healthy population, so the lane keeps
 * the same absolute numbers — the same strictness in px, arrived at from @256 data, not
 * inherited. hairlines fails at 9.69 p95 (8.8× the healthy max).
 *
 * Tier 2 @256 (106 cases, the three droppers excluded): chamfer max 0.60
 * (nazar-amulet), p95 max 2.53 (rugby-football), parsimony max 1.43. Limits sit ~1.6×
 * above the healthy max — beverage-box's 8.24 p95 lands 2× outside. NOT tier 2's @512
 * numbers (0.35/1.2): at 256 the same authored art carries 2× the relative AA and the
 * whole population shifts up; holding the lane to @512's limits would fail 11 healthy
 * twins for being traced at 256.
 *
 * The paint gate's constants (PAINT_MEAN_MAX/PAINT_P95_MAX) are shared: measured @256
 * healthy values 1.06–1.23 mean / 2.11–2.44 p95 (vs limits 3.0/8.0, ≥ 2.4× margin) —
 * ΔE is the same scale at every raster size.
 */
export const LOWRES_TOL: Record<0 | 1 | 2, TruthTol> = {
  0: { chamfer: 1.0, p95: 2.5, parsimony: 3.0 },
  1: TIER_TOL[1], // no tier-1 case in the lane; present so the type stays total
  2: { chamfer: 1.0, p95: 4.0, parsimony: 3.0 },
}

export interface TruthGate {
  key: string
  label: string
  rule: string
  value: number
  limit: number
  /** False ⇒ this gate has nothing to measure on this case. Render as n/a, NOT as a pass. */
  applicable: boolean
  pass: boolean
  /** Fraction of the allowance unused: 1 = perfect, 0 = at the limit, <0 = failing. */
  headroom: number
  digits: number
}

/**
 * Corner-recovery gate calibration. Only applied to flat art with at least this many VISIBLE
 * authored corners — below that there is too little corner evidence to grade (a mostly-round
 * glyph), so the gate reports n/a rather than a noisy pass/fail. The recall floor is a
 * CATASTROPHE bound like the tier limits: a correct trace reproduces ~all authored corners
 * (checker: 99%), and only a gross rounding — a checker cell melted to a blob (§0 #7),
 * dropping the fine quadrant's corners — falls below it.
 *
 * 10, not 12: sharp-star — the corpus's CORNER-PRESERVATION case — has exactly 10 visible
 * authored corners (5 tips + 5 notches), and at 12 the one gate built for its failure mode
 * reported n/a while every tip traced as a beveled cap (§10.2). A 10-corner star is not
 * "mostly-round art"; the count floor only needs to exclude glyphs whose corner evidence is
 * genuinely too thin to grade.
 */
const CORNER_MIN_COUNT = 10
const CORNER_RECALL_MIN = 0.8

/**
 * Paint-fidelity gate calibration (GRADIENT tier 0 only): the traced doc is RENDERED
 * (scoreboard.scoreDoc → the harness rasterizer) and compared against the source raster,
 * mean / p95 CIE76 ΔE over all pixels. This is the gate §10.3's radial-glow regression
 * proved missing: on gradient art every other gate scores boundary GEOMETRY — and
 * radial-glow's authored geometry is just the canvas frame — so its re-centred,
 * ring-banded glow (a pure PAINT failure, caused by a merge-ORDER change re-striding the
 * samples Stage 2 fits on) kept every gate green and was caught only by eye in /labs/ab.
 *
 * Calibrated @512 on 2026-07-21 — healthy tracer: bg-ramp 1.05/1.80, bg-ramp-twin
 * 1.12/2.15, gradient-flat 1.34/3.47, radial-glow 1.12/2.22 (mean/p95). The regressed
 * tracer (the jump veto without its flat-flank condition, the exact state the user saw):
 * radial-glow 9.14/23.95. The limits sit ~2× above the healthy maximum and ~3× below the
 * failure — absolute "this is wrong" bounds, not drift bands.
 *
 * Tier 0 only: tier 1's soft multi-gradient paint is a known, deliberately-deprioritised
 * defect family (§0 #9/#10) whose paint numbers are not yet calibrated; gating it here
 * would paint the slice red without new information. Flat art is excluded because region
 * recovery + boundary + palette already pin its paint.
 */
const PAINT_MEAN_MAX = 3.0
const PAINT_P95_MAX = 8.0

/**
 * INK-KEPT floor (flat art): the fraction of a region's colour AREA the trace still
 * paints (geomScore.scoreRegions.worstInk — rendered px / source px, both at ΔE ≤ 4).
 *
 * The gate §0 #14 proved missing on the *other* side of region recovery. That defect was
 * not a dropped region: the `#990838` doc item existed, carried the right fill, and had
 * pinched to a 77px² sliver of a 651px region (13.5% ink). Recovery caught it only
 * because the median flips once MORE THAN HALF the region is gone; a region pinched to
 * 45% keeps its median, and every boundary number stays sub-tolerance because the
 * boundary that IS traced is traced accurately. Ink degrades continuously, so it sees
 * the collapse coming.
 *
 * MEASURED (calibrateLowres.ts, 2026-08-06) — worst ink per case over the healthy
 * population, at both resolutions and both tiers:
 *   tier 2 @512 (106 twins): min 89.8% (ginger-root) · p05 93.7% · p50 99.7%
 *   tier 2 @256 (106 twins): min 81.7% (donkey)      · p05 86.5% · p50 99.1%
 *   tier 0 + controls @512:  min 93.4% (flute)       · p50 99.4%
 *   tier 0 + controls @256:  min 86.1% (flute)       · p50 98.9%
 * The §0 #14 collapse measures 13.5%. 0.5 sits 1.6× below the healthiest-worst case and
 * 3.7× above the defect — a catastrophe bound like the paint gate's, not a drift band.
 * A RATIO, so unlike every boundary limit it is resolution-free and shared by all lanes.
 */
const INK_MIN = 0.5

/**
 * Evaluate every gate for one scored case. Pure arithmetic — no assertions.
 *
 * Two gates can be INAPPLICABLE rather than passing, and saying so is the whole point:
 *
 *  • boundary gates need `samples > 0`. bg-ramp is a single full-canvas rect, so its entire
 *    authored outline is the canvas border, which border-exclusion drops — leaving nothing
 *    to compare. Reported naively that is `mean([]) === 0`, i.e. a PERFECT boundary score
 *    for having measured nothing.
 *  • region recovery needs FLAT art. On gradient art the flat-region count is an artifact of
 *    8-bit quantisation (bg-ramp "has" 69 regions), so a tracer that correctly fits one
 *    gradient looks like it dropped 60.
 *  • corner recovery needs FLAT art with enough authored corners — see CORNER_MIN_COUNT.
 *
 * A gate that silently passes because it had nothing to check is worse than no gate at all,
 * so those come back `applicable: false` and callers must render them as n/a — never as ✓.
 */
export function evaluateTruthGates(s: {
  samples: number
  chamfer: number
  p95: number
  parsimony: number
  trueRegions: number
  recovered: number
  /** VISIBLE authored sharp corners and how many the trace reproduced (geomScore). Omitted
   *  ⇒ the corner gate reports n/a (a caller that has not measured them). */
  gtCorners?: number
  cornersRecovered?: number
  /** Render-vs-source mean / p95 CIE76 ΔE (scoreboard.scoreDoc: meanDeltaE / p95DeltaE).
   *  Omitted ⇒ the paint gates report n/a (a caller that has not rendered the trace).
   *  Only consulted on GRADIENT tier-0 cases — see PAINT_MEAN_MAX. */
  paintMean?: number
  paintP95?: number
  /** Worst per-region ink kept (geomScore.scoreRegions.worstInk). Omitted ⇒ the ink gate
   *  reports n/a (a caller that has not rendered the trace). Flat art only — see INK_MIN. */
  worstInk?: number
  /** False for gradient cases — see above. */
  flatArt: boolean
  /** Picks the tolerances (TIER_TOL). Defaults to tier 0, whose numbers are unchanged. */
  tier?: 0 | 1 | 2
  /** Override the tier's boundary tolerances — the @256 lane passes LOWRES_TOL[tier]
   *  here (its limits are calibrated at ITS raster; TIER_TOL's are @512-only). */
  tol?: TruthTol
}): TruthGate[] {
  const tol = s.tol ?? TIER_TOL[s.tier ?? 0]
  const hasBoundary = s.samples > 0
  const gtCorners = s.gtCorners ?? 0
  const cornersRecovered = s.cornersRecovered ?? 0
  const cornerApplicable = s.flatArt && gtCorners >= CORNER_MIN_COUNT
  const cornerRecall = gtCorners > 0 ? cornersRecovered / gtCorners : 1
  const paintApplicable =
    !s.flatArt && (s.tier ?? 0) === 0 && s.paintMean !== undefined && s.paintP95 !== undefined
  const upper = (key: string, label: string, value: number, limit: number, digits: number, applicable = hasBoundary): TruthGate => ({
    key, label, rule: `≤ ${limit}`, value, limit,
    applicable,
    pass: applicable ? value <= limit : true,
    headroom: !applicable ? 1 : limit > 0 ? (limit - value) / limit : value <= 0 ? 1 : -1,
    digits,
  })

  return [
    upper('chamfer', 'boundary mean', s.chamfer, tol.chamfer, 2),
    upper('p95', 'boundary p95', s.p95, tol.p95, 2),
    upper('parsimony', 'node economy', s.parsimony, tol.parsimony, 1),
    // Render-vs-source paint fidelity — the gate that would have caught radial-glow's
    // re-centred glow (§10.3): a pure PAINT failure is invisible to every geometry
    // gate on gradient art, where region/corner recovery are n/a by construction.
    upper('paintMean', 'paint mean ΔE', s.paintMean ?? 0, PAINT_MEAN_MAX, 2, paintApplicable),
    upper('paintP95', 'paint p95 ΔE', s.paintP95 ?? 0, PAINT_P95_MAX, 2, paintApplicable),
    {
      // Zero tolerance. A region present in the art and absent from the trace is a bug, and
      // it is the exact failure raster fidelity cannot see: merging a small low-contrast
      // region into its neighbour barely moves ΔE or SSIM while destroying the topology.
      // (bloom drops two overlap lenses this way and the old golden passes it.)
      key: 'regions',
      label: 'regions recovered',
      rule: 'all',
      value: s.trueRegions - s.recovered,
      limit: 0,
      applicable: s.flatArt,
      pass: !s.flatArt || s.recovered >= s.trueRegions,
      headroom: !s.flatArt || s.recovered >= s.trueRegions ? 1 : -1,
      digits: 0,
    },
    {
      // A region can be RECOVERED and still be mostly gone: recovery is a median at the
      // region's own pixels, so it only flips past 50% loss, and boundary error stays
      // sub-tolerance because the surviving boundary is traced accurately. §0 #14 is the
      // case — a 634px region pinched to a 77px² sliver whose doc item still carried the
      // right fill. This gate asks the area question directly.
      key: 'ink',
      label: 'ink kept (worst region)',
      rule: `≥ ${Math.round(INK_MIN * 100)}%`,
      value: s.worstInk ?? 1,
      limit: INK_MIN,
      applicable: s.flatArt && s.worstInk !== undefined,
      pass: !(s.flatArt && s.worstInk !== undefined) || s.worstInk >= INK_MIN,
      headroom:
        !(s.flatArt && s.worstInk !== undefined) ? 1 : (s.worstInk - INK_MIN) / (1 - INK_MIN),
      digits: 2,
    },
    {
      // Zero-distance defect: the tracer keeps every region and every boundary within
      // tolerance yet ROUNDS the shape — a fine checkerboard's cells melt from squares to
      // blobs (§0 #7). chamfer/p95 cannot see it (a corner rounded at 8px scale moves the
      // boundary < 1px) and region recovery cannot (the colour and topology are intact). The
      // authored corners simply stop being corners. This gate catches exactly that: the
      // fraction of visible authored corners the trace still renders sharp.
      key: 'corners',
      label: 'corners recovered',
      rule: `≥ ${Math.round(CORNER_RECALL_MIN * 100)}%`,
      value: gtCorners - cornersRecovered,
      limit: Math.floor(gtCorners * (1 - CORNER_RECALL_MIN)),
      applicable: cornerApplicable,
      pass: !cornerApplicable || cornerRecall >= CORNER_RECALL_MIN,
      headroom: !cornerApplicable ? 1 : (cornerRecall - CORNER_RECALL_MIN) / (1 - CORNER_RECALL_MIN),
      digits: 0,
    },
  ]
}

/** Dev-server URL for a case's SVG (Vite serves public/ at /, project root at its own path). */
export function truthUrl(c: TruthCase): string {
  return c.svg.startsWith('public/') ? `/${c.svg.slice('public/'.length)}` : `/${c.svg}`
}
