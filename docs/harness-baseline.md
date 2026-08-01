# Vectorization harness — baseline scoreboard

Frozen reference numbers for the **pre-V1** pipeline, so every later phase shows a
diff against this. Captured 2026-06-12 on branch `feat/vectorize-structure-first`.

## How to reproduce

- **Headless (crisp engine, CI-gated):** `node src/devtest/runBaseline.ts` →
  rewrites `docs/harness-baseline.json` and prints the table. `npm test` runs
  `test/harness.test.ts`, which asserts determinism + finite metrics on the same
  corpus.
- **Browser (potrace engine):** `npm run dev`, open `/labs/eval` (was
  `/vectorize-test.html` before the labs were folded into the React app). potrace
  needs the WASM tracer + DOMParser, which the headless path doesn't have, so its
  numbers come from the browser scoreboard (`console.log` dumps `SCOREBOARD_JSON`).
  The pure rasterizer/metrics are shared, so crisp numbers from either side are
  byte-identical (verified: browser crisp == `harness-baseline.json`).

## Metric definitions

- **L1 Lab** — mean over pixels of `|ΔL|+|Δa|+|Δb|` (CIELAB, L 0–100). Render is
  composited over white; source likewise.
- **meanΔE / P95 ΔE** — CIE76 (Euclidean Lab) per-pixel error, mean and 95th pct.
- **SSIM** — Wang et al., 11×11 Gaussian windows on Rec.709 luma (1.0 = identical).
- **seam max / P99.5** — max and 99.5th-pct render-vs-source ΔE over boundary pixels
  **that lie in a smooth part of the source** (low local source gradient). Genuine
  high-contrast edges have a high source gradient and are excluded, so their
  unavoidable ~1px AA-placement error does not count. What remains is the
  crack/patch detector: a hairline where the page bleeds through a smooth field, or a
  mismatched gradient patch meeting a ramp — a rendered discontinuity where the
  source is continuous. A boundary pixel is excluded only where BOTH source and
  render have an edge within 1px (a correctly-reproduced edge, ± sub-pixel
  placement); a crack/patch/overshoot sitting near an edge is still counted.
  (Final form reached during V1; all seam numbers below are under it, recomputed
  for the V0 pipeline in a worktree so V0↔V1 is one metric.)
- **paths / nodes / grad** — visible PathItem count, total node count, distinct
  gradient paint-server count.
- **det** — `pass` iff a second identical trace produced a byte-identical doc.

## Baseline (512², `colors:8`, `gradients:on`, default smoothing/despeckle)

Headless crisp, final seam metric (`node src/devtest/runBaseline.ts` at commit
eff497d):

| image  | engine | L1 Lab | meanΔE | P95 ΔE | SSIM   | seam max | seam P99.5 | paths | nodes | grad | det  |
|--------|--------|-------:|-------:|-------:|-------:|---------:|-----------:|------:|------:|-----:|------|
| nebula | crisp  |  5.64  |  3.52  |  8.9   | 0.9600 |  116.9   |   101.4    |   7   |  410  |  4   | pass |
| petals | crisp  |  1.21  |  0.90  |  1.5   | 0.9831 |   12.6   |     5.9    |   7   |   83  |  0   | pass |

potrace (browser, initial run): nebula 8 paths / 4 bg gradients / visible
mismatched patches; petals 8 paths / 0 grad. Its exact seam was measured under an
earlier (edge-inclusive) metric and is not carried here; the headless crisp rows are
the authoritative V0 reference.

Headless crisp runtime: nebula ~224 ms, petals ~158 ms (Node). Browser runtimes are
heavily inflated by the automation extension's instrumentation and are not recorded
as performance figures.

## What the baseline shows (the V1 targets)

- **nebula is the failing case on both engines.** Path count is already single-digit
  (7–8), so the open problems are paint coherence and seams, not element count.
- **crisp seam P99.5 101.4 = the hairline white cracks + border bleed** (§1.2):
  independently simplified contours leave background slivers, and the full-bleed
  layer recedes ~0.5px from the image edge. Visible as a diagonal white line and an
  edge seam.
- **potrace shows the mismatched gradient patches** (§1.2): 4 separate fitted
  gradients on the background, each on a different local axis, meeting at visible
  colour discontinuities.
- **4 gradients on the nebula background, not 1.** The `assignGradients` axis-cluster
  + absorb mending splits the smooth 2-D field into several disagreeing linear fits.
- **petals** is near-parity (flat-ish logo); the bar there is "don't regress".

## V1 exit criterion (plan §6) — ✅ MET

nebula: **no cracks**, **single-digit path count**, background = **one gradient or
cleanly banded with no mismatched patches**; petals & flat cases ≥ parity.

V1 result (headless crisp, final metric — same instrument as the V0 table above;
`harness-baseline.json` tracks the current pipeline):

| image  | paths   | nodes      | grad    | SSIM (V0→V1)       | seam max (V0→V1) | seam P99.5 (V0→V1) |
|--------|--------:|-----------:|--------:|--------------------|------------------|--------------------|
| nebula | 7→**2** | 410→**35** | 4→**2** | 0.9600→**0.9685**  | 116.9→**83.2**   | 101.4→**40.9**     |
| petals | 7→**3** | 83→**38**  | 0→**2** | 0.9831→**0.9894**  | 12.6→21.7        | 5.9→9.7            |

nebula: the crack/patch/border seam collapses (P99.5 101.4→40.9) with 7→2 paths and
one coherent background gradient — both engines render with no visible crack
(potrace seam 19.7 in-browser). The residual crisp 83.2 is a ~12px sub-pixel
overshoot at the white ring's lower edge, not a crack/patch. nebula L1/meanΔE rise
(one linear over a 2-D glow trades colour accuracy for zero band seams — the plan's
"generous ΔE, zero seams"). petals: SSIM up and paths 7→3 (gradients now capture its
shading); seam max ticks up on a handful of curved-edge pixels (P99.5 stays < 10) —
net improvement, still ≥ parity.

## Determinism note

Before V0, `quantize()` seeded k-means++ with `Math.random()`, so the whole pipeline
was non-deterministic (`det: fail`) and the metrics above varied run-to-run. V0
replaced it with a mulberry32 PRNG seeded from an FNV-1a hash of the image bytes;
the table above and the JSON are now byte-stable across runs. The numbers are
therefore the *deterministic* baseline (V0 seeded-PRNG applied, no V1 algorithm
changes), which is the only kind of baseline a diff can be measured against.
