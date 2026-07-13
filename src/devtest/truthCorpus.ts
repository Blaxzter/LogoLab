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
// ---------------------------------------------------------------------------

/** One ground-truth case: an authored SVG we rasterize, trace, and score against itself. */
export interface TruthCase {
  name: string
  /** Repo-relative path to the authored SVG. */
  svg: string
  /** What this case is FOR — the failure mode it is meant to catch. */
  note: string
  /** Trace with gradient fitting on? (Flat art is scored with it off.) */
  gradients: boolean
}

/**
 * The handcrafted edge cases are the heart of this: each one isolates a named failure mode
 * of THIS tracer, which no public corpus does. bloom / nebula / petals / aurora are the
 * authored SVGs we happen to already own — note these are the SAME artworks whose PNGs the
 * old golden traces, except here we score against the vector art instead of against the
 * tracer's memory of itself.
 *
 * cross-bars, annulus and hairlines are authored with STROKES. A stroked element's visible
 * boundary is the outline of the stroke, not its centerline, and svgGround refuses to guess
 * at that — so those cases currently report as unscorable. Re-author them as filled shapes
 * (genEdgeCases.ts) to bring them into the gate.
 */
export const TRUTH_CORPUS: TruthCase[] = [
  // --- the tracer's own hard problems -------------------------------------------------
  { name: 'bg-ramp', svg: 'public/examples/edge-cases/bg-ramp.svg', note: 'posterized ramp — background reunification', gradients: true },
  { name: 'bg-ramp-twin', svg: 'public/examples/edge-cases/bg-ramp-twin.svg', note: 'shape sharing a band colour — the colour-class DELETE risk', gradients: true },
  { name: 'gradient-flat', svg: 'public/examples/edge-cases/gradient-flat.svg', note: 'gradient bg + crisp flats — the render gate must not absorb them', gradients: true },
  { name: 'radial-glow', svg: 'public/examples/edge-cases/radial-glow.svg', note: 'radial vignette — 2-D gradient paint model', gradients: true },

  // --- classic tracer failure modes ---------------------------------------------------
  { name: 'concentric', svg: 'public/examples/edge-cases/concentric.svg', note: 'concentric rings — circle snap, equal-radius solver', gradients: false },
  { name: 'sharp-star', svg: 'public/examples/edge-cases/sharp-star.svg', note: 'sharp points — corner preservation', gradients: false },
  { name: 'aa-seam', svg: 'public/examples/edge-cases/aa-seam.svg', note: 'soft diagonal between flats — the AA sliver', gradients: false },
  { name: 'checker', svg: 'public/examples/edge-cases/checker.svg', note: 'fine checkerboard — high-frequency aliasing', gradients: false },
  { name: 'overlap', svg: 'public/examples/edge-cases/overlap.svg', note: 'translucent discs — layer decomposition', gradients: false },

  // --- authored art we already own ----------------------------------------------------
  // All under public/ so the deployed view can fetch them — Vite's dev server also serves
  // the project root, which hid the fact that examples/*.svg would 404 in a real build.
  { name: 'bloom', svg: 'public/examples/bloom.svg', note: 'translucent circles — 7 composited regions from 3 shapes', gradients: false },
  { name: 'nebula', svg: 'public/examples/nebula.svg', note: 'nested opaque shapes, two sharing a fill', gradients: false },
  { name: 'petals', svg: 'public/examples/petals.svg', note: 'flat multi-region art', gradients: false },
  { name: 'aurora', svg: 'public/examples/aurora.svg', note: 'posterized diagonal ramp — jagged band boundaries', gradients: false },

  // --- unscorable today: authored with strokes (see the note above) --------------------
  { name: 'cross-bars', svg: 'public/examples/edge-cases/cross-bars.svg', note: 'crossing bars — junction weld', gradients: false },
  { name: 'annulus', svg: 'public/examples/edge-cases/annulus.svg', note: 'rings with a hole — winding + alpha', gradients: false },
  { name: 'hairlines', svg: 'public/examples/edge-cases/hairlines.svg', note: 'sub-pixel strokes — thin-feature preservation', gradients: false },
]

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
export const TRUTH_TOL = {
  /** Mean symmetric boundary distance (px). Sub-pixel is the bar for authored flat art. */
  chamfer: 1.0,
  /** 95th-percentile boundary distance (px) — the gating number; max is too brittle. */
  p95: 2.5,
  /** Node density relative to the artist's. 3× is generous; 10× is staircasing. */
  parsimony: 3.0,
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
}): TruthGate[] {
  const hasBoundary = s.samples > 0
  const upper = (key: string, label: string, value: number, limit: number, digits: number, applicable = hasBoundary): TruthGate => ({
    key, label, rule: `≤ ${limit}`, value, limit,
    applicable,
    pass: applicable ? value <= limit : true,
    headroom: !applicable ? 1 : limit > 0 ? (limit - value) / limit : value <= 0 ? 1 : -1,
    digits,
  })

  return [
    upper('chamfer', 'boundary mean', s.chamfer, TRUTH_TOL.chamfer, 2),
    upper('p95', 'boundary p95', s.p95, TRUTH_TOL.p95, 2),
    upper('parsimony', 'node economy', s.parsimony, TRUTH_TOL.parsimony, 1),
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
