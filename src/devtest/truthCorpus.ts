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
   * 0 = our handcrafted cases; 1 = Fluent Emoji "Color" (MIT). The tier picks the TOLERANCES
   * (see TIER_TOL) — soft-edged authored gradient art is not gradeable at thresholds
   * calibrated on crisp flat art, and pretending otherwise would either fail tier 1 for
   * being itself or quietly weaken tier 0.
   */
  tier: 0 | 1
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
 * `checker` is unscorable for the same KIND of reason, found while building tier 1: its two
 * rects are `fill="url(#pattern)"`, so the visible boundary is the pattern's tiling, not the
 * rects. It used to be scored against those two rects and "failed" at 26.7px chamfer /
 * parsimony 32× — a tracer that correctly recovered the checkerboard was being charged with
 * inventing it. That was a bug in the ANSWER SHEET, not in the tracer.
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
]

/** Only the cases of one tier. */
export const tierCases = (tier: 0 | 1): TruthCase[] => TRUTH_CORPUS.filter((c) => c.tier === tier)

/**
 * What CI runs. Tier 0 in full (16 cases — it is the tracer's own failure-mode suite and
 * every case there is load-bearing), plus a small fixed slice of tier 1. The other ~99
 * gradient cases are browse-only in /labs/truth: a gate slow enough to be annoying gets
 * switched off, and a gate that is off is not a gate.
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
export const TIER_TOL: Record<0 | 1, TruthTol> = {
  0: TRUTH_TOL,
  1: {
    // observed p50 1.87 · p75 3.14 · p90 5.65 · max 15.74 (black-circle)
    chamfer: 6.0,
    // observed p50 14.44 · p75 30.64 · p90 52.88 · max 160.90 (black-circle). Yes, this is a
    // terrible-looking limit. It is honest: p95 on gradient art is dominated by the invented
    // interior edges above, and setting it tight would paint the whole corpus red without
    // telling anyone anything they cannot already see in `missed` vs `invented`.
    p95: 60.0,
    // observed p50 1.23 · p90 3.03 · max 4.88. NOTE: parsimony is nearly FINE at tier 0's 3×
    // (97/109 pass) — the tracer spends FEWER nodes than the artist (mean 151 vs 252). The
    // assumption that emoji drawn at 32 units would make any tracer look profligate was wrong.
    parsimony: 5.0,
  },
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
  /** False for gradient cases — see above. */
  flatArt: boolean
  /** Picks the tolerances (TIER_TOL). Defaults to tier 0, whose numbers are unchanged. */
  tier?: 0 | 1
}): TruthGate[] {
  const tol = TIER_TOL[s.tier ?? 0]
  const hasBoundary = s.samples > 0
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
  ]
}

/** Dev-server URL for a case's SVG (Vite serves public/ at /, project root at its own path). */
export function truthUrl(c: TruthCase): string {
  return c.svg.startsWith('public/') ? `/${c.svg.slice('public/'.length)}` : `/${c.svg}`
}
