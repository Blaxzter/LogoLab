# Vectorization harness — baseline scoreboard

Frozen reference numbers for the **pre-V1** pipeline, so every later phase shows a
diff against this. Captured 2026-06-12 on branch `feat/vectorize-structure-first`.

## How to reproduce

- **Headless (crisp engine, CI-gated):** `node src/devtest/runBaseline.ts` →
  rewrites `docs/harness-baseline.json` and prints the table. `npm test` runs
  `test/harness.test.ts`, which asserts determinism + finite metrics on the same
  corpus.
- **Browser (potrace engine):** `npm run dev`, open `/vectorize-test.html`. potrace
  needs the WASM tracer + DOMParser, which the headless path doesn't have, so its
  numbers come from the browser scoreboard (`console.log` dumps `SCOREBOARD_JSON`).
  The pure rasterizer/metrics are shared, so crisp numbers from either side are
  byte-identical (verified: browser crisp == `harness-baseline.json`).

## Metric definitions

- **L1 Lab** — mean over pixels of `|ΔL|+|Δa|+|Δb|` (CIELAB, L 0–100). Render is
  composited over white; source likewise.
- **meanΔE / P95 ΔE** — CIE76 (Euclidean Lab) per-pixel error, mean and 95th pct.
- **SSIM** — Wang et al., 11×11 Gaussian windows on Rec.709 luma (1.0 = identical).
- **seam max / P99.5** — max and 99.5th-pct ΔE over pixels within 1px of a traced
  boundary. This is the crack/patch detector: a hairline where the page bleeds
  through, or a flat patch meeting a ramp, spikes here while mean error hides it.
- **paths / nodes / grad** — visible PathItem count, total node count, distinct
  gradient paint-server count.
- **det** — `pass` iff a second identical trace produced a byte-identical doc.

## Baseline (512², `colors:8`, `gradients:on`, default smoothing/despeckle)

| image  | engine  | L1 Lab | meanΔE | P95 ΔE | SSIM   | seam max | seam P99.5 | paths | nodes | grad | det  |
|--------|---------|-------:|-------:|-------:|-------:|---------:|-----------:|------:|------:|-----:|------|
| nebula | potrace |  5.07  |  3.18  |  8.7   | 0.9724 |   70.1   |    45.6    |   8   |  615  |  4   | pass |
| nebula | crisp   |  5.64  |  3.52  |  8.9   | 0.9600 |  116.9   |    94.5    |   7   |  410  |  4   | pass |
| petals | potrace |  1.00  |  0.76  |  1.5   | 0.9890 |   66.5   |    34.1    |   8   |  132  |  0   | pass |
| petals | crisp   |  1.21  |  0.90  |  1.5   | 0.9831 |   79.4   |    63.8    |   7   |   83  |  0   | pass |

Headless crisp runtime: nebula ~224 ms, petals ~158 ms (Node). Browser runtimes are
heavily inflated by the automation extension's instrumentation and are not recorded
as performance figures.

## What the baseline shows (the V1 targets)

- **nebula is the failing case on both engines.** Path count is already single-digit
  (7–8), so the open problems are paint coherence and seams, not element count.
- **crisp seam max 116.9 = the hairline white cracks** (§1.2): independently
  simplified evenodd contours XOR out background slivers. Visible as a diagonal white
  line across the nebula background.
- **potrace seam max 70.1 = the mismatched gradient patches** (§1.2): 4 separate
  fitted gradients on the background (`grad:4`), each on a different local axis, meet
  at visible color discontinuities.
- **4 gradients on the nebula background, not 1.** The `assignGradients` axis-cluster
  + absorb mending splits the smooth 2-D field into several disagreeing linear fits.
- **petals** is near-parity (flat-ish logo); the bar there is "don't regress".

## V1 exit criterion (plan §6)

nebula: **no cracks** (seam max collapses toward petals-level), **single-digit path
count** (already met — hold it), and a background that is **one gradient or cleanly
banded with no mismatched patches** (`grad` → 1 on the background, or coherent bands;
seam P99.5 down sharply). petals and flat cases must stay ≥ parity.

## Determinism note

Before V0, `quantize()` seeded k-means++ with `Math.random()`, so the whole pipeline
was non-deterministic (`det: fail`) and the metrics above varied run-to-run. V0
replaced it with a mulberry32 PRNG seeded from an FNV-1a hash of the image bytes;
the table above and the JSON are now byte-stable across runs. The numbers are
therefore the *deterministic* baseline (V0 seeded-PRNG applied, no V1 algorithm
changes), which is the only kind of baseline a diff can be measured against.
