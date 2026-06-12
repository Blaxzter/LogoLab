# Vectorization: diagnosis & recommendation plan

*Status: recommendation only — no implementation. Written 2026-06-12 against branch
`feat/vectorize-gradients-crisp-engine` (4ffaf14).*

## TL;DR

The current pipeline is **posterize-then-mend**: k-means slices the image into flat
color bands, traces every band, and then tries to reconstruct smooth gradients by
fitting and merging per-band gradients after the fact. That reconstruction is
fundamentally fragile — once quantization has shredded a smooth 2-D color field into
noise-shaped blobs, no amount of axis-clustering and absorbing puts it back together.

The recommendation is to invert the order: **segment by smoothness first, fit paint
models per macro-region second, trace geometry last** ("structure-first"). This is the
architecture of every system that actually solves this problem: the academic line
(ARDECO 2006 → Photo2ClipArt 2017 → Gradient-Layer Decomposition SIGGRAPH 2023 →
**Adobe's "Image Vectorization via Gradient Reconstruction", Eurographics 2025** —
the apparent basis of Illustrator's 2025 gradient-aware Image Trace) and the
commercial leader Vectorizer.AI. On top of it, add a **shape beautification pass**
(circle/line/symmetry snapping) — the user-stated goal is *useful, designer-like*
output, not pixel truth, and snapping traced blobs to perfect primitives is the single
biggest perceived-quality win for logos.

---

## 1. What the evidence shows

### 1.1 The failing test case, measured

`public/examples/nebula.png` (512²) — purple backdrop, white ring + dot. Sampling a
6×6 grid of the actual pixels:

```
(104, 87,215) (120, 97,222) (129, 98,227) (130, 91,231) (130, 79,234) (130, 66,238)
(117, 93,221) (135,107,228) (145,110,233) (167,131,240) (143, 85,241) (147, 67,219)
(123, 92,226) (140,103,232) (146,103,235) (149, 95,240)    white      (158, 60,198)
(125, 84,230) (163,126,239) (147, 92,240) (155, 82,221)    white      (174, 54,180)
(125, 72,233) (138, 79,240)    white         white      (176, 58,182) (188, 45,158)
(126, 60,237) (144, 61,218) (159, 59,200) (173, 52,179) (188, 45,158) (202, 41,137)
```

The G channel along the top row goes **87 → 97 → 98 → 91 → 79 → 66**: up, then down.
The backdrop is *not* a linear ramp. It is a diagonal indigo→pink base **plus at least
one lighter-violet radial glow** (peak around x≈0.55w, y≈0.2h and another near
x≈0.2w, y≈0.55h) — a typical "blurred blobs" designer background. Iso-color contours
are curved; **no single SVG linear gradient of any stop count can represent it**, and
no two regions of it share one linear axis exactly.

### 1.2 Why each visible artifact happens

| Artifact in the screenshot | Root cause |
|---|---|
| Giant mismatched gradient patches | Per-band linear fits (`fitLinear`, `src/lib/trace/gradient.ts:196`) each lock onto a *different* local axis because the true field is curved. The axis-parallel clustering (`AXIS_PARALLEL_DOT = 0.9`, `src/lib/trace/index.ts:44`) then splits the background into several "shared gradient" groups, each refit independently → adjacent patches disagree in both angle and color. |
| Torn-paper / coastline region edges | k-means in RGB over a smooth field puts band boundaries wherever sensor noise / dither crosses the cluster midpoint — the boundary shape *is* noise. The mode filter softens but cannot straighten it, and the tracer then faithfully reproduces the jagged contour. |
| Hairline white cracks | Crisp engine: each stacked layer's contour is Gaussian-smoothed, RDP-simplified, and Bézier-fit **independently**, then composited with `fillRule: 'evenodd'`. Two near-coincident contours that cross after simplification XOR out to background slivers. (Potrace's pixel-exact stacked masks can't do this; the crisp ones can.) The general mechanism is well documented: wherever two paths abut rather than overlap, the renderer anti-aliases each edge against the *page*, not the neighbor — every abutting boundary is a latent seam. |
| Flat patches "painted over" the ramp | The absorb step (`ABSORB_COLOR_TOL = 70` RGB units, `src/lib/trace/index.ts:214`) compares one centroid sample against one of several inconsistent shared gradients — wrong gradient nearby ⇒ wrong absorb decision in both directions. |
| Different output every run | `quantize()` seeds k-means++ with `Math.random()` (`src/lib/trace/quantize.ts:26`) — the whole pipeline is non-deterministic, which also makes regression testing impossible. |

### 1.3 The deeper architectural lesson

Phase 2's per-region fitting *can* work when the truth is one clean linear ramp (it
"verified on nebula" before, presumably with settings whose bands happened to merge).
But it inverts the information flow: quantization first **destroys** the smooth-field
signal, then the gradient stage tries to **infer it back** from fragments. Every
heuristic added (axis clustering, union refits, absorb tolerance) is a patch over that
inversion, and each has image-dependent failure modes. The fix is not better mending —
it is to *detect smooth regions before anything quantizes them*.

For reference, Affinity Designer's auto-trace of this image (`examples/nebula.svg`)
gives up on the gradient entirely: 4 stacked paths, flat purple background. Clean
geometry, wrong paint. The bar to clear is: **Affinity's geometry + a faithful smooth
background**.

---

## 2. What "good" means here (acceptance criteria)

The product goal is *useful* vectorization — what a designer would redraw — not
pixel fidelity. Concretely, for a logo like nebula:

1. **Few elements.** ~4–6 paths (full-bleed background + ring + dot + node), not 8–24
   bands. Element count should resemble the hand-made source SVG.
2. **One coherent background paint.** A single multi-stop gradient (or a small stack of
   soft radial overlays — see §3.2) that *reads* like the original. ΔE error tolerance
   is generous; seams/patches tolerance is zero.
3. **Regular geometry.** Circles come out as perfect circles (4-segment Bézier circles
   are fine), straight edges as straight lines at snapped angles, shared centers
   detected (ring ∘ dot are concentric). Low node counts.
4. **Deterministic.** Same input + settings ⇒ identical output, byte for byte.
5. **Editable structure.** Background separable from marks; gradients live in `defs`
   and are user-editable (the additive `PathItem.gradient` model already does this).

These criteria should be encoded in the evaluation harness (§5) *before* the rebuild,
so progress is measured, not eyeballed — Phase 2 shipped a regression precisely
because verification was a one-image eyeball check.

---

## 3. Recommended architecture: structure-first

Four stages, replacing the current quantize→trace→mend order. Everything stays
client-side, closed-form, and dependency-free — this is a rearrangement of math the
codebase already contains, not a new technology bet.

### 3.0 Pipeline overview

```
ImageData
   │
   ├─ Stage 1  Smoothness segmentation  → few macro-regions (bg, ring, dot, …)
   ├─ Stage 2  Paint-model ladder       → solid | multi-stop linear | radial(+focal) | glow-stack
   ├─ Stage 3  Geometry: trace ONCE per macro-region (crisp tracer) + beautify/snap
   └─ Stage 4  Assemble painter's stack → EditableDoc (existing model, unchanged)
```

### 3.1 Stage 1 — smoothness segmentation (the heart of the fix)

Goal: split the image into a handful of **macro-regions** such that each is either
flat or *one* smooth color field — i.e., the background becomes ONE region no matter
how many hues it spans, and the white ring stays separate because a strong edge
separates them.

The blueprint paper (§4.1) gives a concrete, validated recipe — adopt it rather than
improvising:

1. **Mumford–Shah smoothing** (Strekalovskiy & Cremers' real-time discrete solver,
   α = 1.0, λ = 1.5): denoises and removes anti-aliasing/resampling artifacts *and*
   yields the **discontinuity map 𝒟** (pixels where the smoothed solution still has a
   strong gradient) as a by-product. Everything downstream works on the smoothed
   image; 𝒟 splits pixels into "smooth" and "edge" sets.
2. **Color-difference segmentation** of the smooth pixels in **CIELAB** (merge
   neighbors with ΔE below τ_s = 10) → initial fine segments.
3. **Discontinuity-aware merging via multicut**, *not* greedy merging. Build the
   segment-adjacency graph with weights `exp(−‖ΔI‖²)`; mark segment pairs that face
   each other *across* a discontinuity (opposite sides within σ = 5 px of a 𝒟 pixel,
   above density τ_a = 0.25) as must-stay-separate; solve the multi-terminal min-cut
   (NP-hard in general, but tiny here — solved as repeated min-cut). **Why this
   matters: the paper demonstrates (their Fig. 3) that greedy union-fit merging
   transitively bridges genuine edges** — adjacent slices of a ramp each merge fine
   with their neighbor, and step by step the chain crosses a true boundary. A
   union-fit-residual greedy merge with an edge veto is an acceptable V2 simplification,
   but the multicut is the principled fix and the graph is small (hundreds of nodes).
4. **Anti-aliased boundary pixels** (segments inside 𝒟): merge each into a neighbor
   when its color is within τ_s of the best **convex combination of the neighbors'
   fitted fills** — AA slivers are blends of their neighbors, and this test recognizes
   that. (This principled rule replaces the current `ABSORB_COLOR_TOL = 70` heuristic.)

k-means survives only as (a) the palette generator for the UI and (b) the fallback
decomposition inside macro-regions where no paint model fits (the paper does exactly
this too: revert to color-based sub-segmentation with constant fills). Seed it
deterministically (fixed PRNG, e.g. mulberry32 keyed by image hash).

### 3.2 Stage 2 — paint-model ladder (per macro-region, fit in Oklab)

Try models in order of complexity; pick the cheapest one under tolerance
(an MDL-style score `error + λ·complexity` encodes "useful, not truthful"):

1. **Solid** — mean color.
2. **Linear, multi-stop.** Fit the axis as today (structure tensor — the paper uses
   the *same* construction: dominant eigenvector of Σ ∇I·∇Iᵀ, validating the existing
   code), then build the 1-D color profile ρ(t) along the axis and place stops as the
   **piecewise-linear approximation of ρ via the 1-D Mumford–Shah functional with
   α = ∞, λ = 1.0** (α = ∞ forces linear interpolation between stops; the knots of the
   optimum *are* the stop positions — solvable exactly by 1-D dynamic programming).
   RDP on the binned profile (ΔE tol ≈ 2 in Oklab) is the quick-and-dirty stand-in if
   the DP is deferred. Either way this nails eased and hue-rotating ramps that defeat
   the current 2-stop fit; the doc model already supports N stops (`GradientStop[]`) —
   only the fitter is limited. Useful early-out: stack the three per-channel
   plane-fit gradients into a 3×2 Jacobian; if it is rank-2 (channels ramp in
   genuinely different *directions*), the field is 2-D (like nebula's glow) and no
   linear gradient of any stop count fits — skip straight to radial / glow-stack
   instead of letting a bad linear fit win. (Side note from the paper: ARDECO's
   per-channel independent gradients don't map onto SVG's single-axis model — the
   shared-axis + stops formulation is the SVG-exact one, which the current code
   already uses. Keep it.)
3. **Radial, multi-stop, with focal point — and optionally eccentricity + affine
   transform.** The paper's radial family is (stops, focal φ, eccentricity e, center,
   affine T), fitted by minimizing the misalignment Σ (∇I × ∇f)² between observed
   color gradients and the model's radial field — the cross-product form needs no
   radius binning to find the center. SVG expresses the full family via
   `fx`/`fy` (already in `RadialGradient`) plus `gradientTransform` for the affine
   part (a small optional doc-model addition; plain centered radials need nothing).
   Use distance-weighted means when sampling the radius profile so the compressed
   side of an eccentric gradient doesn't dominate.
4. **Glow stack** (optional, the "wow" tier — this is what nebula actually is): base =
   best linear fit; residual = original − base; find the K≤3 strongest residual blobs;
   fit each as a radialGradient whose outer stops fade to `stop-opacity: 0`, layered
   above the base. SVG handles this natively; it reconstructs "blurred blob" designer
   backgrounds almost exactly and degrades gracefully (K=0 ⇒ plain linear).
5. **Fallback**: keep the region posterized (current behavior) when nothing fits —
   e.g. genuine photos.

All thresholds move from raw-RGB distance to ΔE in Oklab, making one tolerance value
behave consistently across hues (the current 6 / 34 / 70 RGB constants cannot).

### 3.3 Stage 3 — geometry + beautification

- **Trace once per macro-region** with the existing crisp tracer (its Gaussian →
  marching-squares → Schneider-fit chain is genuinely good — keep it). With ~5 regions
  instead of ~8–24 bands, tracing cost drops and there are no band boundaries left to
  show seams.
- **Keep painter's stacking** (the `stackedMask` idea is correct): bottom region
  extends full-bleed under everything above, so only *outer* boundaries of upper
  shapes are ever traced and background cracks are structurally impossible. Render
  with `nonzero`; reserve `evenodd` for genuine hole semantics.
- **Endgame option — shared-boundary curve network** (what the blueprint paper and
  Vectorizer.AI's "Vector Graph" both do): build the planar straight-line graph of
  region boundaries, chain valence-2 edges into paths between junction nodes, pair
  paths across junctions for tangent continuity, simplify with junctions pinned, then
  Bézier-fit each boundary **once** so both adjacent regions reuse identical geometry.
  This gives consistent T-junctions and better node economy than per-region tracing.
  One caveat the paper doesn't mention: even *exactly coincident* abutting paths leave
  faint renderer-AA seams (the page bleeds through `α·(1−α)` of each edge pixel — the
  classic conflation artifact), so the best combination is: **network for geometry,
  stacking for paint** — after fitting shared boundaries, expand each region's path by
  the regions above it and paint bottom-up. Strictly a V3+ refinement; stacking alone
  is fine until then. The complete construction (junction stitching, soft corner
  scoring, DP curve selection, ε = 1.5 px) is digested from the paper's supplement in
  §4.2 — no improvisation needed.
- **Beautification pass** (new, pure post-processing on traced contours — this is what
  makes output feel "drawn"). ClipGen (TVCG 2021) published concrete, human-validated
  thresholds worth adopting as-is:
  - Circle/ellipse: Pratt/Taubin algebraic fit per closed contour; mean deviation
    under ~0.5 px ⇒ replace with an exact 4-segment Bézier circle. (Nebula: ring = two
    concentric circles, dot = one, node = one — the logo becomes 5 perfect circles +
    1 rect.)
  - Lines & angles: collapse near-straight Bézier runs to lines; snap to
    horizontal/vertical when within ~10°; merge collinear segments.
  - Relations: concentric centers (within ~1/10 of the bbox long side), equal radii,
    parallel edges, repeated identical shapes — solve with a small least-squares
    adjustment so snaps don't fight each other.
  - Symmetry (later): detect a mirror axis, average the two halves.
  - Each snap is accepted only if max deviation from the raw trace stays under a
    user-visible "fidelity" tolerance — this is the knob that says how far from the
    PNG the output may drift.

### 3.4 Stage 4 — assembly

Unchanged: `EditableDoc` with bottom-up `items`, additive `gradient?` on `PathItem`,
gradient dedup in `defs` at serialization. No doc-model migration needed for stages
1–3 except *optionally* a `primitive?: 'circle' | 'rect'` hint on `PathItem` if the
editor later wants constraint-aware editing (not required to ship).

---

## 4. Relation to the state of the art

*(Web research verified 2026-06-12; URLs in §8.)*

- **The blueprint paper — read in full, digested in §4.1 below.** Adobe Research,
  *"Image Vectorization via Gradient Reconstruction"* (Chakraborty et al.,
  Eurographics/CGF 2025; **CC-BY open access**, so reimplementation is legally
  unencumbered; a copy lives at `examples/imageVectorizationViaGradientReconstruction.pdf`).
  It is §3.1–3.3 of this plan, published and productized — Illustrator's Image Trace
  gained gradient detection in 2025, almost certainly from this work. Headline
  numbers: **0.51 s at 512², 2.05 s at 1024²** (CPU), L1(CIELAB) ≈ 0.02–0.05,
  SSIM 0.72–0.93, with **one fixed parameter set across all image types** — and it
  beats the neural methods on both axes (LIVE: 1820 s, O&R: 266 s per image, worse
  quality). Stated limitations: no layered decomposition, no strokes, struggles on
  intricate natural-image shading — none of which matter for logos, and two of which
  (glow-stack layering §3.2.4, primitive snapping §3.3) are exactly where this plan
  goes *beyond* the paper.

### 4.1 Digest of the blueprint paper (algorithm + fixed parameters)

| Step | Method | Parameters |
|---|---|---|
| Preprocess | Discrete Mumford–Shah smoothing (Strekalovskiy–Cremers real-time solver); discontinuity map 𝒟 falls out as a by-product | α = 1.0, λ = 1.5 |
| Segment | CIELAB color-difference merge on smooth pixels → segment graph (weights `exp(−‖ΔI‖²)`) → discontinuity pairs → **multi-terminal min-cut** (greedy merging alone provably bridges real edges — their Fig. 3) | τ_s = 10, σ = 5 px, τ_a = 0.25 |
| Fit fills | Constant (boundary-distance-weighted mean) / linear (structure-tensor axis + stops from **1-D Mumford–Shah, α = ∞** on the axis profile) / radial (focal + eccentricity + affine T, fitted via Σ(∇I × ∇f)² misalignment). Pick min-L1 model under threshold; else revert region to color sub-segmentation with constant fills | stop-placement λ = 1.0 |
| AA pixels | 𝒟-segments merge into a neighbor when within τ_s of the best **convex combination** of neighbors' fills | τ_s = 10 |
| Curves | Boundary planar graph → valence-2 edge paths between junctions → junction-aware continuity pairing → DP simplification (junctions pinned) → piecewise Bézier fit (after Baran et al. 2010) → **gapless shared-boundary network** | — |

Properties worth copying outright: deterministic and *local* (out-painted images
reproduce identical output for unchanged regions — their Fig. 14), no per-image
tuning, path counts ~6× lower than Illustrator's solid-fill trace at higher fidelity
(1417 vs 8584 paths on their teaser).

### 4.2 Supplement digest: segmentation pseudocode + the full curve-fitting recipe

The supplement (local copy:
`examples/imageVectorizationViaGradientReconstructionSupplemental.pdf`, 5 pages)
fills the two gaps the main paper left:

**Segmentation, implementation-ready (Algorithms 1–2).** Color-difference
segmentation is plain agglomerative merging: every pixel starts as its own segment
with fill `lab(I(p))`; repeatedly merge each segment with its *closest* neighbor
(min ‖F(s)−F(s′)‖₂) while that distance ≤ τ_s, updating the fill to the mean; stop at
fixpoint. The multicut is solved per discontinuity pair, in order of a weighted
size+color difference: for each pair (u,v), **while a BFS path still connects u and v
in the working graph, apply min-cut between them**; final segments = connected
components. Both are a page of code each.

**Curve fitting (supplement §3) — adopt for V3; ε = 1.5 px everywhere in the paper:**

1. *Edge network*: trace each region boundary counter-clockwise as pixel poly-lines;
   merge the two directed edges of each boundary into one undirected edge; organize
   into a planar network of paths between junction nodes (valence ≠ 2). Gap-free by
   construction.
2. *Junction stitching*: at each junction, greedily pair incoming paths whose tangent
   angle difference is closest to π and merge them into one path crossing the
   junction (the Depixelizing-Pixel-Art move) — smoothness across T-junctions becomes
   *possible* but not forced.
3. *Key vertices*: Douglas–Peucker at ε on each path; retained vertices are the only
   allowed curve endpoints.
4. *Tangents*: at each key vertex, fit a line over a growing window until its RMS
   exceeds ε/2; G¹ curves must match that tangent.
5. *Soft corner score* c(j) ∈ [−1 smooth … +1 corner]: competitively fit a line, a
   circular arc, and a two-line "corner" wedge over growing windows until each
   exceeds ε; score from how many points each shape covered (their exact formulas are
   in supplement §3.3.3). This replaces a hard corner-angle threshold with evidence.
6. *Dynamic programming*: build an over-complete candidate set — a line between each
   adjacent key-vertex pair (cost 3.9 + δ·E) and Schneider-fit cubic Béziers between
   *any* key-vertex pair for all four C⁰/G¹ endpoint combinations (cost 4 + δ·E +
   junction penalties from c(j); δ = 10⁻⁶·ε; discard candidates deviating > ε) — then
   take the min-cost path through the DAG. Corners emerge where the evidence says
   C⁰ is cheaper, not where a threshold fires.

Step 6's inner fitter is Schneider's Graphics-Gems algorithm — **which
`src/lib/trace/subpixel.ts` already implements**. So V3's geometry upgrade is
precisely: keep the existing Schneider core, replace the crisp tracer's thresholded
corner-NMS with the soft-corner score + DP selection above. Extended results table:
~1024px inputs run 1.3–3.4 s, 2048² ≈ 10 s, L1 0.007–0.07, SSIM 0.65–0.98 — useful
spread for harness targets beyond the main paper's three-row table.
- **Layered-decomposition line**: **ARDECO** (Lecot & Lévy 2006: variational
  segmentation where each region's color is a constant/linear/quadratic polynomial —
  the segmentation itself decides "this is one ramp"), **Photo2ClipArt** (Favreau et
  al. 2017: stacked semi-transparent linear-gradient layers chosen by a
  fidelity-vs-simplicity energy with Monte-Carlo tree search) and **Gradient-Layer
  Decomposition** (Du et al., SIGGRAPH 2023; C++ code exists but unlicensed, minutes-
  scale runtime). These confirm both the target representation (few stacked
  translucent gradient layers — our glow-stack is the restricted logo-scale version)
  and the selection principle (MDL: error + λ·complexity). Their expensive global
  search is unnecessary at logo scale.
- **Region merging is formalizable**: *"A Formalization of Image Vectorization by
  Region Merging"* (arXiv 2409.15940, 2024) gives an O(N·neighbors) dual-graph
  merge framework with a **pluggable merge predicate** — plugging in "joint affine
  color fit residual" yields exactly Stage 1's model-aware merging, with convergence
  behavior already analyzed.
- **Commercial reference points**: **Vectorizer.AI** describes a proprietary "Vector
  Graph" — a planar graph with **shared boundaries between neighboring shapes** (their
  structural anti-seam mechanism, the alternative to painter's stacking), plus "full
  shape fitting" (parameterized circles, ellipses, rounded rects, stars) and
  "sub-pixel precision … place boundaries according to the anti-aliasing pixel values"
  — independent validation of both the crisp tracer's design and the beautification
  stage. Legacy **Vector Magic** openly punts ("gradients … are converted to bands of
  constant color"), and **Affinity** posterizes too — the bar §2 sets genuinely clears
  the field that everyday users compare against.
- **VTracer** (visioncortex, Rust/WASM, maintained): confirmed **no gradient output**
  — `--gradient_step` merely controls banding granularity; its color mode shares the
  current pipeline's core defect. Its *stacked* default (vs `cutout`) confirms the
  industry wisdom on seams. The old Phase 3 plan (swap to VTracer-WASM) is therefore
  de-prioritized: it would import our existing problem in Rust. Revisit only for
  photo-ish inputs.
- **Beautification precedent**: **Hoshyari et al. 2018** (perception-driven boundary
  vectorization: humans prefer regularity over pixel-faithful wiggle), **PolyFit**
  (Dominici et al. 2020; public C++ code; users preferred its output 3:1, >15:1 on
  low-res inputs — evidence the snap pass is the highest perceived-quality lever), and
  **ClipGen** (TVCG 2021) whose rule thresholds §3.3 adopts directly.
- **Neural methods** (DiffVG, LIVE, O&R 2024, SuperSVG 2024, StarVector 2025,
  LayerPeeler 2025): unchanged verdict — CUDA-bound, GPU-seconds-to-minutes, model
  sizes far beyond CDN-sane, and none produce logo-grade geometry. Re-evaluate only if
  a server-side "premium trace" tier becomes a product goal.
- **SVG mesh gradients**: still dead (dropped from SVG 2, zero browser support). The
  glow-stack (§3.2.4) is the practical substitute and covers the same visual class for
  logo backgrounds.

---

## 5. Evaluation harness first (do this before any pipeline work)

Extend `src/devtest/vectorizeTest.ts` + `vectorize-test.html` from a visual viewer
into a scoreboard, run over a fixed corpus:

- **Corpus**: the 7 hand-made example SVGs rendered at 512² (ground truth known!) +
  nebula/petals PNGs + ~10 real-world logos (gradients, flat, line-art, photo-ish).
- **Fidelity metrics**: render the traced SVG to canvas, compare to source — use
  **average L1 in CIELAB + SSIM** (the blueprint paper's exact metrics, so our numbers
  are directly comparable to its Tables 1–2: ~0.04 L1 / 0.72 SSIM at 512² is the
  published bar), plus P95 ΔE and a seam detector (max ΔE along traced boundary
  normals — catches cracks/patches that mean-error hides).
- **Usefulness metrics**: path count, total node count, gradient count, % of contours
  snapped to primitives; compare against the Affinity exports and the hand-made
  originals as references. Runtime budget per the paper: ~0.5 s at 512², ~2 s at
  1024², in-browser.
- **Determinism**: byte-identical re-run check.
- Make it runnable headless (the gradient/fit math is already pure; marching squares
  and friends don't touch DOM — only PNG decode needs a shim) so it can gate CI.

Rationale: every phase so far was declared good on a single-image eyeball check and
the screenshot regression still happened. The harness converts "looks fine to me" into
numbers that move.

---

## 6. Phased roadmap

| Phase | Scope | Effort | Risk | Exit criterion |
|---|---|---|---|---|
| **V0 — harness** | §5 scoreboard + corpus + determinism fix (seeded PRNG) | S | none | metrics dashboard runs on corpus |
| **V1 — quick wins on current pipeline** | Oklab everywhere; multi-stop emission in `fitLinear`/`fitRadial`; replace axis-clustering with union-refit test ("merge iff one model fits the union"); crisp: `nonzero` + ≥0.75px overlap dilation of upper stacked masks | S–M | low | nebula: no cracks, single-digit path count, background = 1 gradient *or* cleanly banded (no mismatched patches) |
| **V2 — structure-first core** | Stage 1 segmentation (MS smoothing + CIELAB merge + edge-aware merging — greedy-with-edge-veto first, multicut if it shows transitive bridging) + Stage 2 ladder (solid/linear-N/radial-focal); start from the paper's fixed params (τ_s = 10, σ = 5, τ_a = 0.25, MS α = 1 λ = 1.5); delete `assignGradients` mending; k-means demoted to fallback | M–L | medium | nebula bg = ONE multi-stop gradient region; petals & all flat-logo cases ≥ parity with today; L1/SSIM within striking distance of the paper's published numbers |
| **V3 — beautify** | Circle/line snapping + relation solver + fidelity knob in UI | M | low | nebula = 5 perfect circles + rect; node counts ≤ Affinity's |
| **V4 — wow tier (optional)** | Glow-stack background reconstruction; symmetry detection | M | low (additive) | nebula bg visually indistinguishable at arm's length |

Notes:
- V1 alone likely turns the screenshot from "broken" into "acceptable" — worth doing
  on this branch before merging it. V2 is where the architecture stops fighting
  itself. V3 is the biggest *perceived*-quality jump per effort for logos.
- Everything stays in the existing lazy-loaded client bundle; no new dependencies are
  required by any phase (Oklab conversion is ~20 lines; circle fit is ~40).

## 7. Explicitly not recommended

- **VTracer-WASM swap** (old Phase 3): doesn't address gradients, adds a worker + wasm
  asset for curve quality the crisp tracer already matches. Shelve.
- **Neural vectorizers / text-to-SVG**: unchanged ruling (runtime, size, faithfulness).
- **Mesh gradients**: no browser support; glow-stack covers the need.
- **More mending heuristics** on the posterize-first pipeline (smarter absorb
  tolerances, fancier clustering): each is another image-dependent patch on an
  information-destroying order of operations. V1 deliberately picks only the mends
  that are also correct under V2.

## 8. References

**Primary blueprint**
- Chakraborty et al., *Image Vectorization via Gradient Reconstruction*,
  Eurographics/CGF 2025, CC-BY — local copy:
  `examples/imageVectorizationViaGradientReconstruction.pdf` — also
  https://research.adobe.com/publication/image-vectorization-via-gradient-reconstruction/
- Strekalovskiy & Cremers, *Real-Time Minimization of the Piecewise Smooth
  Mumford–Shah Functional*, ECCV 2014 — the smoothing/discontinuity solver the paper
  builds on (the main third-party algorithm to port)
- Paper supplement (segmentation pseudocode + full curve-fitting recipe) — local
  copy: `examples/imageVectorizationViaGradientReconstructionSupplemental.pdf`
- Baran, Lehtinen, Popović, *Sketching Clothoid Splines Using Shortest Paths*,
  CGF 2010 — basis of the paper's Bézier-network fitting
- Kopf & Lischinski, *Depixelizing Pixel Art*, SIGGRAPH 2011 — junction tangent
  pairing used in the supplement's edge-network stitching
- Illustrator 2025 gradient-aware Image Trace —
  https://helpx.adobe.com/illustrator/using/image-trace-results-optimization.html

**Layered gradient decomposition**
- Favreau, Lafarge, Bousseau, *Photo2ClipArt*, SIGGRAPH Asia 2017 —
  https://www-sop.inria.fr/reves/Basilic/2017/FLB17/
- Du et al., *Image Vectorization and Editing via Linear Gradient Layer
  Decomposition*, SIGGRAPH 2023 — https://dl.acm.org/doi/10.1145/3592128 —
  code (unlicensed): https://github.com/Zhengjun-Du/ImageVectorViaLayerDecomposition
- Lecot & Lévy, *ARDECO*, EGSR 2006 — https://inria.hal.science/inria-00105620/en/

**Segmentation / compositing**
- *A Formalization of Image Vectorization by Region Merging*, arXiv 2409.15940 (2024)
- *Image Vectorization with Depth*, arXiv 2409.06648 (2024) — depth ordering +
  elastica completion of occluded layers
- Seam mechanics writeup — https://heredragonsabound.blogspot.com/2019/06/map-borders-part-13.html

**Beautification**
- Dominici et al., *PolyFit*, SIGGRAPH 2020 —
  http://www.cs.ubc.ca/labs/imager/tr/2020/ClipArtVectorization/ — code:
  https://github.com/dedoardo/polyfit
- Hoshyari et al., *Perception-Driven Semi-Structured Boundary Vectorization*,
  SIGGRAPH 2018 — https://www.cs.ubc.ca/labs/imager/tr/2018/PerceptionDrivenVectorization/
- ClipGen, TVCG 2021 (snapping thresholds) — https://arxiv.org/abs/2106.04912

**Tools / commercial**
- VTracer docs (stacked vs cutout; no gradients) — https://www.visioncortex.org/vtracer-docs/
- Vectorizer.AI (Vector Graph, shape fitting, sub-pixel) — https://vectorizer.ai/
- Vector Magic FAQ (gradients → bands) — https://vectormagic.com/support/faq
- Tool catalog — https://github.com/fromtheexchange/image2svg-awesome

---

## 9. Implementation log

*(Appended per phase. Does not amend the recommendation sections above.)*

### V0 — evaluation harness + determinism fix — 2026-06-12 — ✅ shipped

**What shipped**
- Pure, environment-agnostic scoreboard (runs identically in Node and the browser):
  - `src/devtest/color.ts` — sRGB→CIELAB (D65) + CIE76 ΔE + Rec.709 luma.
  - `src/devtest/raster.ts` — EditableDoc → RGBA rasterizer (cubic flatten →
    scanline fill with nonzero/evenodd + 4× AA → solid/linear/radial paint eval →
    painter's-order composite over white) + a boundary mask for the seam metric.
    We rasterize the doc model directly rather than parsing serialized SVG, so the
    harness needs no DOM/canvas and runs headless.
  - `src/devtest/metrics.ts` — L1 CIELAB, mean/P95 CIE76 ΔE, Wang-SSIM (11×11
    Gaussian on luma), boundary-normal seam max/P99.5, path/node/gradient counts,
    and an FNV-1a hash of the canonical doc for the determinism check.
  - `src/devtest/scoreboard.ts` — `score()` traces twice (byte-identical re-run
    check), rasterizes once, returns one row.
  - `src/devtest/png.ts` (Node `node:zlib`) + `src/devtest/nodeHarness.ts`
    (ImageData polyfill + corpus loader) for the headless side.
  - `test/harness.test.ts` gates determinism + finite metrics on the PNG corpus;
    `test/color|raster|metrics.test.ts` unit-test the pure math.
  - `src/devtest/vectorizeTest.ts` + `vectorize-test.html` upgraded from an eyeball
    viewer into a full scoreboard table (both engines + visual strip).
  - Baseline recorded in `docs/harness-baseline.json` (headless crisp, machine-
    readable) and `docs/harness-baseline.md` (both engines + provenance + V1 targets).
- **Determinism fix:** `quantize()` k-means++ now seeds a mulberry32 PRNG from an
  FNV-1a hash of the image bytes instead of `Math.random()`. Pipeline output is now
  byte-identical across runs (`det: pass`); it was non-deterministic before.

**Baseline numbers** — see `docs/harness-baseline.md`. Headline: nebula is the
failing case on both engines (crisp seam **116.9** = hairline cracks; potrace seam
**70.1** + **4** background gradients = mismatched patches), path count already
single-digit (7–8). petals near-parity.

**Deviations from the plan**
- Added explicit `.ts` extensions to the trace pipeline's *value* imports
  (`trace/index.ts`, `trace/potrace.ts`, `path/model.ts`) so the pure pipeline loads
  under Node's type-stripping ESM loader (extensionless specifiers throw there).
  Behaviour-neutral — Vite/Rollup/tsc all accept `.ts` specifiers; the browser never
  sees them (bundled). This is the enabling change the plan's "run it headless" calls
  for.
- potrace metrics are browser-measured (it needs WASM + DOMParser); crisp + all
  metrics + determinism run headless under `npm test`. The shared pure rasterizer
  makes the two sides' crisp numbers byte-identical, so the split is sound.
- Baseline is captured *with* the V0 seeded-PRNG fix in place. A `Math.random`
  pipeline produces a different (and unmeasurable, run-to-run-varying) result every
  time, so a deterministic baseline is the only one a later diff can be measured
  against. The pre-fix non-determinism is itself recorded as the motivation.
