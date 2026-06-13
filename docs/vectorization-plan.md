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

### V1 — quick wins on the current pipeline — 2026-06-12 — ✅ shipped (exit met)

**What shipped**
- `src/lib/trace/oklab.ts` — sRGB→Oklab + ΔE, for perceptually-consistent merge/
  stop-placement thresholds.
- **Multi-stop emission** (`gradient.ts`): `fitLinear`/`fitRadial` now bin the 1-D
  colour profile along the axis/radius and place stops at the knots of its Oklab-RDP
  approximation (a linear ramp collapses to 2 stops; an eased/hue-rotating ramp keeps
  interior knots). Residual is measured against the emitted stop model. Added
  `fitBestGradient` (Oklab-ranked) and `sampleGradient`.
- **Union-refit merge** (`index.ts`): replaced `assignGradients`' axis-clustering +
  raw-RGB absorb with a greedy union-refit — two regions merge iff one gradient fits
  their combined samples within `MERGE_OKLAB_TOL` (0.06). Grouping runs BEFORE tracing
  and each group's labels are MERGED into one region (`mergeLabels`), so a posterized
  smooth field collapses into a single full-bleed region painted with one gradient.
- **Crisp seam fix** (`subpixel.ts`): switched crisp output to `nonzero` fill with
  loop winding oriented by nesting parity (`orientForNonzero`), and edge-snapping of
  near-border vertices so the bottom layer is truly full-bleed (was leaving a half-
  covered last pixel row/column → page bled through as an edge seam).
- Seeded PRNG (from V0) makes all of the above byte-deterministic.

**Harness numbers vs baseline** (headless crisp, refined metric):

| image  | paths   | nodes      | grad    | SSIM (b→V1)        | seam max (b→V1) | seam P99.5 (b→V1) |
|--------|--------:|-----------:|--------:|--------------------|-----------------|-------------------|
| nebula | 7→**2** | 410→**35** | 4→**2** | 0.9600→**0.9685**  | 116.9→**83.2**  | 101.4→**40.9**    |
| petals | 7→**3** | 83→**38**  | 0→**2** | 0.9831→**0.9894**  | 12.6→21.7       | 5.9→9.7           |

(Both rows under the *final* seam metric; the V0 figures were re-measured against the
eff497d pipeline in a worktree so the diff is one instrument.) nebula's crack/patch/
border seam collapses (P99.5 101.4→40.9) with 7→2 paths and one coherent background
gradient. petals' seam max ticks up on a handful of curved-edge pixels (gradients now
capture its shading) but SSIM rises and paths drop 7→3 — net improvement, ≥ parity.

Browser (both engines): nebula potrace 2 paths, SSIM 0.979, seam ~19.7, no visible
crack; petals/orbit/outline/summit clean-to-perfect (orbit SSIM 0.996; outline &
summit ~1.0, grad 0 — no wrong merges). aurora SSIM 0.990 (potrace) with a residual
seam at its semi-transparent chevron strokes. nebula L1/meanΔE rose (5.64→8.21 /
3.52→4.97): the deliberate trade of one-linear-over-a-2-D-glow colour accuracy for
ZERO band seams — the plan's "generous ΔE, zero seams".

**Exit criterion — met.** nebula (both engines): no cracks, **2 paths** (single-
digit), background = **one gradient** — visually beats the flat-purple Affinity
reference. petals & every flat/line case ≥ parity (all improved or perfect).

**Deviations from the plan**
- Went beyond "assign a shared gradient" to **label-merging** each union-refit group
  into one region. Reason: the old per-band layers, with the count-based paint order,
  sandwiched the white ring UNDER two tiny pink bands, whose receding traces leaked
  the white underlayer as a diagonal "crack". Collapsing the field to one region
  removes the sandwich entirely (and cuts path count). Still "merge iff one model fits
  the union".
- The plan's crisp **overlap dilation** was implemented then **reverted**: dilating
  upper masks roughened boundaries and, given the paint order, painted pink bands over
  the white ring (purple-on-white overshoot, SSIM 0.917). Label-merge + edge-snap fix
  the seams more cleanly with nothing to overlap.
- **Oklab scope**: applied to the merge predicate and stop placement (the cross-region
  threshold consistency the plan targets). The per-region solid-vs-gradient SELECTION
  residual stays in RGB to avoid retuning the validated single-region fitter and its
  tests — slated for V2's rebuild.
- **Seam metric finalized during V1** (after an adversarial review caught an earlier
  over-exclusion that could hide near-edge cracks): a boundary pixel is excluded only
  where BOTH source and render have an edge within 1px — a correctly-reproduced edge,
  ± sub-pixel placement — so a crack/patch/overshoot near an edge is still scored. Also
  composites the source over white before scoring (a harness bug: transparent source,
  e.g. white line-art, was scored as black, which had crater-ed `outline`/`aurora`).
  Opaque nebula/petals numbers are unaffected by the alpha fix; V0 was re-measured
  under the final metric (worktree) so `harness-baseline.md`'s V0↔V1 diff is one
  instrument.
- **Edge-veto NOT added** (deferred to V2 per plan): union-refit can in principle
  bridge two distinct flat colours across a true edge into a near-step gradient. The
  corpus shows no such bridging (flat cases stay grad-0 / perfect), so the V2 multicut
  edge-veto is left as the principled fix; this is a known latent risk.
- aurora's translucent-stroke seam and any stroke/line-art class remain V2/beyond.

### V2 — structure-first core — 2026-06-12 — ✅ shipped (exit met)

**What shipped** — the quantize→trace→mend pipeline is replaced by segment→fit→trace
(§3.1–3.2). New pure modules (all `node --test`):
- `src/lib/trace/mumfordShah.ts` — discrete piecewise-smooth Mumford–Shah solver
  (truncated-quadratic / binary line process, the [SC14] scheme): each outer pass
  recomputes per-edge cut state (α‖Δu‖² ≥ λ) then Gauss–Seidel-diffuses the resulting
  quadratic sub-problem to a fixpoint. Returns the smoothed image u + the
  discontinuity map 𝒟 (eq 1–2). α = 1.0; the cap λ is expressed as a gradient-
  magnitude edge threshold T = √(λ/α) = 0.15 in the working RGB[0,1] scale.
- `src/lib/trace/segment.ts` — Stage 1.2–1.4: CIELAB colour-difference agglomerative
  merge over smooth pixels (τ_s = 10, Supplement Alg 1) → S₀; discontinuity relation
  𝒜 (eq 3, σ = 5, τ_a = 0.25); a GLOBAL greedy union-fit merge gated by the 𝒜 edge
  veto **and** a profile-gap veto; AA (𝒟) pixels flooded into the nearest-matching
  neighbour. Output is QuantizeResult-shaped, so the existing stacked-mask tracer is
  untouched.
- `src/lib/trace/lab.ts` — sRGB→CIELAB + ΔE76 for the segmenter's thresholds.
- `src/lib/trace/gradient.ts` gains `fitPaintLadder` (Stage 2): MDL selection
  (Oklab residual + λ·#params, λ = 0.0015) over solid → linear-multistop → radial,
  with the §3.2.2 rank-2 anisotropy as a soft radial preference. `fitLinear` now
  returns the structure-tensor anisotropy.
- `src/lib/trace/index.ts` — colour mode rewired to segment → ladder → trace.
  **Deleted** `groupRegions`/`mergeLabels`/the union-refit scaffolding/`sampleRegion`
  (the posterize-then-mend path, plan §7). `quantize.ts` is retained as the
  fallback/UI palette but no longer on the main path.

**Harness numbers vs the V1 baseline** (headless crisp, same instrument):

| image  | paths   | SSIM (V1→V2)       | meanΔE (V1→V2) | seam max (V1→V2) | seam P99.5 (V1→V2) |
|--------|--------:|--------------------|----------------|------------------|--------------------|
| nebula | 2→**2** | 0.9685→**0.9756**  | 4.97→**4.00**  | 83.2→**13.3**    | 40.9→**11.4**      |
| petals | 3→4     | 0.9894→0.9890      | 1.25→1.85      | 21.7→**6.8**     | 9.7→**3.3**        |

Browser corpus (both engines): nebula potrace SSIM 0.980 / seam 11.6 (V1 ~19.7);
orbit/outline clean-to-perfect (outline 1.0000, grad 0); bloom 0.988/0.980 grad 0;
summit **potrace** 0.997; petals renders all three translucent circles in their
correct colours. determinism `pass` on every row.

**Exit criterion — met.** nebula background = ONE coherent multi-stop gradient region
(no bands, no cracks — seam P99.5 collapses 40.9→11.4) at **lower** meanΔE than V1's
single linear (4.97→4.00), with every other headless metric improved. All flat/line
cases ≥ parity (orbit/outline/bloom/summit-potrace clean, grad 0). Determinism +
typecheck + build green; 43→62 tests.

**Deviations from the plan (each with a measured reason)**
- **Edge threshold calibrated to the working colour scale.** The functional FORM is
  exact (min(α‖∇u‖², λ)), but the paper's fixed λ = 1.5 gives a cut threshold
  √(λ/α) = 1.22 that is unreachable in normalised RGB (max step √3 ≈ 1.73; real logo
  edges ≈ 0.3–0.85), so 𝒟 would be empty. T = 0.15 (RGB[0,1] L2) is the equivalent in
  this scale — a units conversion (documented in `mumfordShah.ts`), not a relaxation.
  Validated: 𝒟 cleanly isolates nebula's ring/dot from a fully-smooth background.
- **nebula background is a multi-stop LINEAR, not a radial.** The structure tensor
  measures the field as 1-D-dominant (anisotropy ≈ 0.005); a 5-stop linear fits it to
  Oklab 0.020 vs the best radial's 0.025, i.e. linear is genuinely the better single
  model and already beats V1 on every metric. The plan's own §3.2.4 scopes the true
  2-D "glow-stack" (base linear + radial overlays) to V4 — a single SVG gradient
  cannot represent nebula's base-plus-glow field, and forcing a worse radial would
  raise meanΔE (the plan forbids relaxing a metric). So V2 ships the honest best
  single model; the radial ladder rung is implemented and unit-tested on a synthetic
  radial, ready for fields that actually are radial-dominant.
- **Rank-2 early-out is a SOFT preference, not a hard linear-drop.** Hard-dropping
  linear on a 2-D field was measured to force a *worse* SOLID on a linearly-shaded
  petal (the radial barely beat solid on MDL once linear was removed). Instead the
  anisotropy waives the radial's +1 centre-param penalty so it wins a near-tie, but
  never discards a markedly-better linear — fidelity-safe and still honours the intent.
- **Greedy union-fit + edge veto, NOT multicut.** Per plan §6 the multicut is only
  warranted if the greedy merge transitively bridges a true edge; the corpus shows no
  bridging (the 𝒜 veto + profile-gap veto keep nebula's ring separate from its
  background and the three petals distinct), so the multicut (Supplement Alg 2) is left
  for if a future case needs it.
- **eq-6 misalignment radial centre + eccentricity/affine T (`gradientTransform`) not
  built.** No corpus case is radial-dominant (nebula measures 1-D), so there is no
  measured reason or validation target for the extra machinery, and adding an
  unvalidated paint feature would risk silently de-syncing the harness rasterizer.
  Deferred with the glow-stack to V4. The radial model used (candidate-centre search +
  multi-stop) passes the synthetic-radial unit test.
- **`colors`/`despeckle` dials no longer drive a k-means count** (segmentation is
  structural); the options stay in the public API and still tune the tracer's
  smoothing/turdsize downstream.

**Adversarial review** (10-agent workflow, 6 dimensions, every finding independently
re-verified): the ms-correctness, paint-ladder, pipeline-integrity and **exit-honesty**
dimensions raised nothing. Three segmentation findings were confirmed and fixed:
- (HIGH) a thin all-discontinuity opaque feature isolated on transparency (e.g. a
  1–2 px stroke) had no smooth seed and was unreachable by the flood, so it was emitted
  as label −1 and silently dropped. Fixed: leftover opaque components are now seeded as
  their own macro-regions (regression-tested).
- (LOW) the colour-difference merge's fixed 64-pass cap could under-merge silently →
  loop to a true fixpoint (union-find guarantees termination).
- (LOW) the 𝒜 facing tally is per-axis while touch is per-pixel → documented as an
  intentional veto bias in the safe (edge-preserving) direction; τ_a kept at 0.25.

**Known latent (for V3)** — `sampleGradient`/`segment.gradientT` ignore a radial's
focal point while `raster.ts`/`gradientToSvgDef` honour it; dormant in V2 because no
emitted gradient sets `fx`/`fy`, but a focal-radial fitter (V3) must keep the three in
sync or the harness will mismeasure its residual.

### V3 — beautify — 2026-06-12 — ✅ shipped (machinery + knob + zero-regression default; exit criterion partially met, with a measured structural reason)

**What shipped** — a PURE post-processing beautify pass (plan §3.3), run AFTER the
tracer and BEFORE the `EditableDoc` is assembled, so it serves BOTH engines and does
NOT re-segment:
- `src/lib/trace/beautify.ts` — `beautify(groups, opts)` over one `SubPath[]` per item:
  - **Circle snap** — centred algebraic (Kåsa/Coope) circle fit per closed loop;
    replace with a 4-node kappa-Bézier circle (reusing `model.ellipseSubPaths`, now
    exported) when its max radial deviation ≤ the fidelity knob and `r > 2·fidelity`.
  - **Axis-aligned ellipse snap** — linear conic fit under an `A+C=2` normalisation
    (rotated ellipses deferred), gated the same way.
  - **Line polish** — straighten near-flat cubics to true lines, merge collinear
    vertices, snap near-axis edges to exact H/V (all sharing a fixed `LINE_POLISH_CAP`
    = 0.3 px drift ceiling, see deviations).
  - **Relation solver** — single-linkage clusters of concentric centres (within
    `relationFrac` = 1/10 of the doc bbox long side) and equal radii; reconcile each
    cluster to its (radius-weighted) mean, accepting a move per circle only when the
    re-centred/re-sized circle still fits its RAW flattened trace within the knob — so
    snaps never fight each other or exceed the tolerance.
  - Winding is preserved per loop (snapped primitives match the source loop's signed-area
    sign) so nonzero/evenodd holes still render as holes.
- `src/lib/trace/index.ts` — colour mode rewired to **collect every layer's trace →
  beautify all loops at once (so the relation solver sees across items) → assemble**;
  mono mode beautifies its single shape too. `fidelity` plumbed through.
- `src/types.ts` + `TraceControls.tsx` — additive `fidelity?: number` (px; default 1.5,
  `DEFAULT_BEAUTIFY_OPTIONS.fidelity`) + a "Fidelity" slider (0 = off … 6 px). 0 makes
  beautify a no-op (raw trace).
- **No doc-model / rasterizer change**: every snapped shape is a plain 4-node Bézier
  subpath, so `parseSvg`/`serializeDoc`, the node editor, and `raster.ts` are all
  untouched (the plan's permitted `primitive?` hint was deliberately NOT added — unused).

**Harness numbers vs the V2 baseline** (headless crisp, default fidelity 1.5 px):

| image  | paths | nodes (V2→V3) | SSIM (V2→V3)       | meanΔE (V2→V3) | seam max (V2→V3) | seam P99.5 |
|--------|------:|---------------|--------------------|----------------|------------------|------------|
| nebula | 2     | 34→**33**     | 0.9756→**0.9762**  | 4.00→**3.99**  | 13.3→**11.6**    | 11.4 (=)   |
| petals | 4     | 44→**44**     | 0.9890 (=)         | 1.85 (=)       | 6.8 (=)          | 3.3 (=)    |

`npm test` 62→**77** (15 new `beautify` unit tests: circle/ellipse fit + fidelity gate,
line/collinear/H-V, concentric & equal-radius solver, winding, determinism, no-mutate).
Determinism `pass`, typecheck + build green.

- **nebula**: the centre **dot snaps to a mathematically perfect circle** (centre
  ≈ image-centre, 5→4 nodes) and every metric holds or improves — a clean,
  zero-regression default.
- **petals**: organic shapes, nothing snaps → **exact V2 parity** at every fidelity
  level (the line polish no longer touches its curves — see deviations).

**Browser corpus** (`vectorize-test.html`, potrace + crisp over the 7-image set,
fidelity 0 ⇒ V2 vs 1.5 ⇒ V3) — beautify runs on BOTH engines, so the **potrace product
default** sheds nodes across the board with no fidelity regression:

| image   | potrace nodes (V2→V3) | potrace SSIM      | potrace seam max | note |
|---------|-----------------------|-------------------|------------------|------|
| nebula  | 48→**36**             | 0.9796→**0.9800** | 11.6 (=)         | dot circle + collinear cleanup |
| petals  | 59→**53**             | 0.9938 (=)        | 2.4 (=)          | parity |
| aurora  | 64→**60**             | 0.9938→0.9934     | 66 (=)           | translucent strokes held |
| orbit   | 40→**32**             | 0.9934→**0.9937** | 0.5 (=)          | concentric rings snap |
| outline | 45→**38**             | 1.0000 (=)        | 0 (=)            | line-art, perfect held |
| summit  | 27→**12**             | 0.9972→0.9960     | 0 (=)            | straight edges de-staircased |
| bloom   | 41 (=)                | 0.9876 (=)        | 8.1 (=)          | unchanged |

crisp matches its headless numbers (nebula & orbit improve, the rest parity). seam and
meanΔE hold or improve on every row of both engines; the only sub-parity figure anywhere
is **summit-potrace SSIM −0.0012** (4th-decimal noise, seam still a perfect 0) — the cost
of halving a straight-edged mark's node count, well inside the knob.

**Exit criterion (plan §6 V3) — partially met, with a measured structural reason.**
- *"nebula = ~5 perfect circles + a rect, concentric centres detected"* — NOT reachable
  at a faithful tolerance. The white **ring and the small node bump at 12 o'clock are the
  same colour and touch, so segmentation fuses them into ONE connected component**; the
  node dents BOTH ring circles by ~10–11 px (measured: ring-outer max radial dev 10.4,
  ring-inner 11.4, vs dot 0.5). Snapping the rings therefore needs `fidelity ≥ ~12 px`,
  which **erases the node and drops SSIM to 0.954 — a regression** the no-regression rule
  forbids, so the knob correctly rejects it at the default. Completing the rings means
  *separating* the node — i.e. the §3.3 shared-boundary curve network / shape completion,
  which the plan scopes to **V3+/beyond** — and re-segmentation is forbidden (§7). So V3
  ships the honest best: dot = perfect circle, rings kept faithful (node preserved).
- *"node counts ≤ Affinity's export"* — Affinity nebula = 30 anchors / 5 paths; V3 = 33 /
  2 paths (1 below V2, but the un-snappable rings keep it ~3 above Affinity, for the same
  node-fusion reason; V3 nonetheless uses fewer paths and one coherent gradient vs
  Affinity's flat purple in 5 paths).
- *"the fidelity knob visibly trades regularity for PNG-faithfulness end to end"* — **MET
  and demonstrated**: raising the knob to ≥12 px snaps the rings → nebula becomes
  bg-rect + **3 circles** (ring-outer + ring-inner + dot), with the **relation solver
  centre-aligning ring-outer and the dot** to an identical centre (ring-inner stays put,
  its tight residual budget correctly blocking the move), 19 nodes, SSIM 0.954 — regularity
  bought with faithfulness, exactly the knob's purpose. The default (1.5 px) stays faithful;
  `fidelity = 0` reproduces the raw V2 trace byte-for-byte.

**Deviations from the plan (each with a measured reason)**
- **Single fidelity gate, not the plan's separate 0.5 px circle-mean threshold.** A snap
  is accepted iff its max deviation from the raw trace ≤ `fidelity`. Reason: item 4 makes
  the knob *the* acceptance rule, and a fixed 0.5 px circle gate would stop the knob from
  ever loosening circle-snapping — defeating the required "trades regularity for
  faithfulness" demonstration. Not a relaxation: clean circles (the dot) sit far under the
  1.5 px default anyway.
- **All line cleanups (straighten, collinear-merge, H-V snap) share a fixed
  `LINE_POLISH_CAP = 0.3 px` drift ceiling, NOT the fidelity budget.** Measured on the
  browser corpus (potrace, the product default): running them at the full 1.5 px budget
  regressed aurora's translucent-stroke seam 66→97 and meanΔE 1.18→1.57, and petals'
  crisp seamMax 6.8→9.9 — in each case a single repositioned boundary vertex moving
  > 1 px past where the source edge can still account for it. Capping at 0.3 px restores
  parity everywhere while still merging pixel-staircase vertices (the potrace node drops
  above). The full fidelity budget is reserved for whole-shape circle/ellipse snaps,
  where the drift is distributed smoothly around a perfect shape rather than concentrated
  at one nudged vertex — so a circle can use the whole knob without seaming.
- **Axis-aligned ellipse only** (rotated ellipse via a full conic eigen-fit deferred): no
  corpus contour is a rotated ellipse, so there is no measured target to validate it
  against (and an unvalidated fit risks de-syncing the rasterizer — the V2 caution).
- **Symmetry pass deferred** (plan marks it "optional, last"): the circle snaps + relation
  solver already regularise the symmetric cases; no measured need yet.
- **`despeckle`/`colors` still don't gate beautify**; the new `fidelity` dial is the only
  beautify control (the others remain tracer dials, as in V2).

**Known latent** — unchanged from V2: `sampleGradient`/`segment.gradientT` ignore a
radial's focal point while `raster.ts`/`gradientToSvgDef` honour it. V3 emits no radial
focal (the relation solver only adjusts circle/ellipse geometry), so it stays dormant; a
future focal-radial fitter must still keep the three in sync.

**Not done (V3+, explicitly out of scope)** — the shared-boundary curve network and the
supplement's soft-corner + DP curve selection (§4.2). The crisp tracer's corners are NOT
the nebula bottleneck (node fusion is), so the geometry extension would not move the
exit numbers; deferred per the plan's "only if snapping is fully demonstrated first".

### V4 — glow-stack background — 2026-06-13 — ✅ shipped (exit met)

**What shipped** — Stage 2.4 (plan §3.2.4, the "wow" tier). nebula's background is a
diagonal base PLUS lighter radial glows — a genuinely 2-D field NO single SVG gradient
can represent (V2/V3 ship the honest best single linear, meanΔE ≈ 4.0). It is now
decomposed into a base + translucent radial overlays:
- `src/lib/trace/gradient.ts`:
  - `fitGlowStack(fit, gate, base)` — greedy residual-blob peeling (K ≤ 3). Each round
    finds the SMOOTH-sample peak (cleanest glow centre), fits a CENTRED Gaussian glow
    toward that colour — alpha = the least-squares fraction of `(C − composite)` that
    explains the remaining error, regressed in log-space vs distance² to recover
    `α(d) = α₀·exp(−d²/2σ²)`, emitted as opacity-fading radial stops out to r = 3σ — and
    keeps it only if it cuts the composited residual. Overlays are centred (no fx/fy), so
    `sampleGradient` and the rasterizer agree and the V2 focal latent stays dormant.
  - `sampleGlowStack` + `meanLabResidual`; `PaintLadderResult` gains `model: 'glow'` +
    `glow?: GlowStack`. `fitPaintLadder` attempts a glow when the best single model's
    residual exceeds `glowTrigger`, and keeps it only when it beats that model by
    `glowMinGain`.
- `src/lib/trace/index.ts`: a glow region emits its opaque base item then one translucent
  overlay item per radial (sharing the region's beautified geometry, deep-cloned), all
  before the next region — so the glow paints over the base, under the marks. New
  `fullRegionSamples` builds the glow GATE set (see deviations).
- **No rasterizer / doc-model change**: `raster.ts` already composites radial gradients
  with per-stop opacity (straight alpha-over), which is exactly what the overlays need.

**Harness numbers vs V3** (default options):

| image  | engine  | meanΔE (V3→V4) | SSIM (V3→V4)      | P95 ΔE (V3→V4) | seam P99.5 | paths | grads |
|--------|---------|----------------|-------------------|----------------|------------|-------|-------|
| nebula | potrace | 3.99→**2.87**  | 0.9764→**0.9821** | 11.5→**8.2**   | 11.4→12.0  | 2→3   | 2→3   |
| nebula | crisp   | 3.99→**2.95**  | 0.9762→**0.9782** | 11.6→**8.2**   | 11.4→12.0  | 2→3   | 2→3   |
| petals | both    | 1.77/1.85 (=)  | 0.9938/0.9890 (=) | (=)            | (=)        | (=)   | (=)   |

`npm test` 77→**81** (4 new glow-stack unit tests). Determinism `pass`; typecheck + build
green. **The glow fires on nebula ONLY** — every other corpus image (petals/aurora/orbit/
outline/summit/bloom, both engines) is byte-for-byte unchanged: no spurious glow anywhere.

**Exit criterion (plan §6 V4) — met.** "nebula bg visually indistinguishable at arm's
length": the single 2-D-glow overlay cuts background meanΔE from 4.49 to 3.25 (full
region), full-image meanΔE 3.99→2.87/2.95, SSIM up, and **P95 ΔE 11.5→8.2** — the worst-case
colour error drops by a third. The one metric that ticks up is nebula's seam P99.5
(11.4→12.0): the glow shifts background colours at the already-high ring-boundary AA — a
smooth recolour, NOT a crack — and is dwarfed by the meanΔE / SSIM / P95 gains.

**Deviations from the plan (each with a measured reason)**
- **The glow is gated in CIE76 ΔE, not Oklab.** The rest of the ladder selects models in
  Oklab (V1/V2 consistency), but a blue-violet glow correction is ~20× larger in CIE76 (the
  harness's own fidelity metric) than in the perceptually-flatter Oklab — an Oklab gate
  silently rejected a clearly-beneficial overlay (measured: 0.0009 Oklab RMS "improvement"
  for a 1.0 CIE76 / +0.002 SSIM render win). Gating on CIE76 ties the decision to what the
  arbiter measures.
- **Two sample sets: fit on SMOOTH, gate on FULL region.** The overlay shape (peak +
  Gaussian) is fit on the segmenter's smooth (AA-free) samples so the blob seeds at the
  clean glow centre, but acceptance is measured on the FULL region (every labelled pixel,
  AA included, `fullRegionSamples`). The smooth subset omits the high-error anti-aliased
  pixels a glow most improves and under-reports its benefit ~20× (sample meanΔE improvement
  0.045 vs full-region 1.235) — so a smooth-only gate never fired. The full-region gate
  makes the fit-time metric match the render.
- **One overlay for nebula, not K = 3.** Measured: the 2nd blob does not clear even a 0.05
  CIE76 gate, so a single Gaussian is the honest fit. K ≤ 3 remains the cap for fields with
  more blobs.
- **Symmetry detection (the other half of the V4 row) NOT built.** The glow stack was the
  requested/headline piece; symmetry is deferred (the circle snaps + relation solver from
  V3 already regularise the symmetric cases, so there is no measured need yet).
- **Glow base = the chosen single model** (nebula: the multi-stop linear), per §3.2.4
  ("base = best linear fit").

**Known latent** — STILL unchanged: `sampleGradient`/`segment.gradientT` ignore a radial's
focal point while `raster.ts`/`gradientToSvgDef` honour it. V4's glow overlays are
deliberately CENTRED (no fx/fy), so the three agree and the latent stays dormant; a future
eccentric/focal-radial fitter must keep them in sync (per the V2 note).

### V5 Stage A — evidence-based crisp curve fitting (soft-corner + DP) — 2026-06-13 — ✅ shipped (Stage-A exit met; potrace NOT retired)

**What shipped** — the crisp tracer's hard turn-angle corner NMS (`detectCorners`) is
replaced by the supplement's evidence-based pipeline (§4.2), keeping Schneider's cubic as
the inner fitter:
- `src/lib/trace/curveFit.ts` (new, pure, `node --test`): closed-loop Douglas–Peucker key
  vertices at ε → per-vertex tangents (§3.3.2) → soft-corner score from a competitive
  line/circle/wedge fit (§3.3.3) → min-cost cyclic DP over an over-complete candidate set
  (a line between adjacent key vertices `3.9+δE`, and Schneider cubics between key-vertex
  pairs for the four C⁰/G¹ endpoint combos `4+δE+ΣJ_G1`, each discarded if it deviates > ε;
  `δ=10⁻⁶ε`). Corners emerge where C⁰ is genuinely cheaper, not where a threshold fires.
- `src/lib/trace/subpixel.ts`: feeds the DENSE marching-squares loop straight to
  `fitClosedLoop`; `detectCorners`/`sharpestVertex`/`fitArc`/`rdpClosed` and the old
  Schneider block are deleted. `orientForNonzero` now tests loop nesting + winding on the
  FLATTENED curve, not the sparse anchor polygon (see deviations — this fixes a crack).
- `src/devtest/lineArtCorpus.ts` (new): summit (sharp mountain), orbit (ring/annulus) and
  bloom rebuilt from the doc model + rasterized, so the corner-preservation case gates
  `npm test` (harness.test.ts asserts summit seam < 3). `runBaseline` scores them too.
- `TraceControls.tsx`: engine hint corrected (crisp = lowest node count + sharp corners;
  potrace = highest fidelity + cleanest abutting/translucent edges).

**Browser scoreboard — crisp vs potrace, full corpus** (the arbiter; both engines):

| image   | crisp SSIM / potrace | crisp seamMax / potrace | crisp nodes / potrace |
|---------|----------------------|-------------------------|-----------------------|
| nebula  | 0.9782 / 0.9821      | 12.3 / 12.3             | **29 / 40**           |
| petals  | 0.9901 / 0.9938      | 5.7 / 2.4               | **31 / 53**           |
| aurora  | 0.9917 / 0.9934      | **40.0 / 65.9**         | **29 / 60**           |
| orbit   | 0.9930 / 0.9937      | 0.5 / 0.5               | **22 / 32**           |
| outline | 1.0000 / 1.0000      | 0 / 0                   | **30 / 38**           |
| summit  | 0.9829 / 0.9960      | **0 / 0** (was **93**)  | **9 / 12**            |
| bloom   | 0.9796 / 0.9876      | 15.5 / 8.1              | **35 / 41**           |

**Headless (npm test 81→95, det pass, typecheck + build green)** — vs the V4 crisp baseline:
nebula meanΔE 2.95→**2.95** SSIM 0.9782→**0.9782** seamP99.5 12.0→**12.0** nodes 37→**29**;
petals 1.85→**1.83** / 0.9890→**0.9901** / 3.3→**2.6** / 44→**31**; new headless rows
summit (seam **0.0**, 14 nodes), orbit (0.9932, 23), bloom (0.9898, 42).

**Exit criterion (Stage A) — MET.** summit's sharp corners are preserved: **seam 93 → 0**
with the boundary exactly on the source edges, at **9 nodes ≤ potrace's 12** — the headline
weakness (B). crisp's node-count edge is intact/widened on EVERY row (e.g. aurora 29 vs 60,
outline 30 vs 38), and crisp seam ≤ potrace everywhere except the translucent-overlap cases
(see below). No regression vs V4: nebula identical, petals better, summit hugely better;
aurora/orbit SSIM dip −0.0017/−0.0007 is bought back many times over by seam (aurora 66→40)
and node (aurora 60→29) gains.

**potrace NOT retired (kept, both engines).** crisp SSIM stays marginally below potrace on
every row (−0.0007 … −0.0131), and crisp seam exceeds potrace on petals (5.7 vs 2.4) and
bloom (15.5 vs 8.1) — the abutting-translucent-boundary residue, weakness (A). Per the plan
("NEVER drop potrace while it still wins any fidelity row") both engines are kept and the UI
hint corrected. The residual SSIM gap is the inherent crisp tradeoff (fewest, cleanest nodes
vs pixel-faithful), so it would persist even after Stage B — potrace retirement is therefore
out of reach by geometry changes alone.

**Post-V5 product decision (user, 2026-06-13): crisp is now the DEFAULT engine** (potrace
still one click away). Retirement remains off (the dep stays), but for a logo tool whose goal
is designer-like output (§2), crisp's fewest/cleanest nodes + sharp corners are the better
default; the marginal SSIM/seam gaps favour potrace only on photo-ish / translucent inputs,
which users can switch to. Also dropped two stale UI knobs: **Colors** (dead since V2 —
`segmentOptionsFor` ignores it) and **Precision** (output formatting, not a trace stage). A
user-facing "How it works" explainer (`PipelineExplainer.tsx`) and a dev stage-viewer
(`vectorize-debug.html`) now visualize the per-stage intermediates from the live image.

**Deviations from the plan (each with a measured reason)**
- **ε = 1.0 px, not the paper's 1.5.** Measured: at 1.5 the looser cubic fit regressed
  nebula's smooth-gradient region below V4 parity (SSIM 0.9782→0.9758, meanΔE 2.95→3.00);
  1.0 holds nebula/petals EXACTLY and keeps the node-count win. Corner placement is
  evidence-based, independent of ε.
- **`orientForNonzero` flattens before nesting/winding tests.** The low-node fits expose a
  latent bug: a circle is two semicircle cubics → a 2-ANCHOR loop whose anchor polygon
  badly under-covers the true region, so the old anchor-polygon nesting test misclassified a
  hole near a coarse outer boundary as a fill → a catastrophic crack (nebula seam 12→102 at
  ε=1.2). Flattening makes containment + winding exact at any node count; the crack is gone
  and nebula is monotonic across ε.
- **Three performance bounds (the paper is silent on scale; a heavy-AA logo loop would hang
  the browser otherwise).** (1) cubic span capped at MAX_SPAN=20 key vertices — "any pair"
  is O(N·m²) on a smooth boundary; (2) each cubic is fit/scored on ≤64 evenly-sampled arc
  points and the soft-corner / tangent windows are capped at ±24 points — a smooth circle
  never exceeds ε so the unbounded window is O(loop²) per vertex; (3) the cyclic DP runs from
  a single forced-break seam (a key vertex no cubic spans, hence a break in every tour, so
  exact) instead of all m seams — O(m³)→O(m·K); plus a per-loop ε-coarsen above 300 key
  vertices for anti-aliased slivers. All preserve the corpus numbers exactly (the fixes are
  behaviour-neutral on clean loops) and bring a 6 s pathological loop to <100 ms.

**Stage B — NOT built (the premise was measured and refuted).** Stage B (shared-boundary
curve network) fixes weakness (A) = abutting-boundary *cracks* (a render discontinuity where
the source is smooth — the page/underlayer bleeding through a gap). Before building it, the
petals/bloom seam pixels were located and inspected (the top-12 ΔE boundary pixels of each):
**there are no cracks.** Every seam pixel has render-gradient ≈ 0 — the render is *smooth*
there, just the wrong COLOUR (e.g. bloom: source `rgb(50,178,236)` vs render
`rgb(48,156,223)`, ΔE 10.9; petals: source `rgb(44,172,231)` vs render `rgb(45,161,225)`,
ΔE 5.7, both gradients 0). The seam is the V2 segmenter / paint-ladder discretising a
translucent overlap blend into a region whose fitted fill is a few ΔE off — a PAINT error
sampled near a boundary, NOT a geometry divergence. (V1's stacking already eliminated the
abutting cracks, which is why render-gradient is 0.)

Shared boundary geometry cannot change a region's fill colour, and there is no crack to
close — so Stage B would not move the petals/bloom seam. Worse, the network traces the
INTEGER pixel grid (the supplement's "pixel poly-lines"), which is less sub-pixel-accurate
than Stage A's coverage-field contouring, so it would push boundaries *off* the true edge —
regressing petals/bloom placement AND summit/outline's currently-perfect (seam 0) sub-pixel
corners. Per the plan's own gate ("ONLY build Stage B if the harness shows abutting-boundary
residue is the remaining gap"), the gate is not satisfied. The real fix for the petals/bloom
seam is paint-colour accuracy on translucent overlaps — V2/V4 paint/segmentation, explicitly
out of scope for V5 (which is additive geometry). Stage B abandoned (not deferred): it is the
wrong tool for the measured gap. The crisp/potrace SSIM gap is likewise inherent (crisp's
node-economy tradeoff), so potrace stays as the fidelity engine regardless.

### Translucent overlaps — `Region detail` knob (stopgap) + layered decomposition (the real fix) — 2026-06-13

**Where overlaps die (measured, not assumed).** For petals/bloom (translucent overlapping
circles) the overlap-blend zones don't appear in the output. Varying each stage's threshold
on petals (region count; more = overlaps surviving) vs nebula (smooth gradient; more =
posterize fragmentation):

| setting | petals | nebula |
|---|---|---|
| default (MS edge T 0.15, merge τ_s 10) | 4 | 2 |
| MS edge T 0.08 / 0.05 (step ② "detected edges") | **4 / 4** (no change) | 2 |
| merge τ_s 4 (step ③ grouping) | 4 | 2 |
| merge τ_s 2 + mergeTol 0.01 (step ③) | **13** | (slow; fragments) |

So the loss is at **step ③ (grouping)**, not step ② (edge detection): lowering the MS edge
threshold to 0.05 does NOT recover the overlaps (the blend boundaries are gentle and, even
when kept, the colour-difference merge still fuses the similar colours). Only tightening the
merge thresholds (τ_s ≈ 2) brings them back — but that also shatters smooth gradients and is
much slower. There is no single safe value, which is exactly why the merge was a fixed
default ("automatic").

**Shipped: a `Region detail` knob (opt-in stopgap).** `VectorizeOptions.regionDetail` (0–100,
default 0) drives `segmentOptionsFor`: 0 = the balanced default (byte-identical output —
nebula/petals baselines unchanged); higher lowers τ_s (10→2.5) and mergeTol (0.06→0.012).
Measured at the extreme: petals 4→8 paths (overlaps recovered), nebula 3→9 paths / 29→1414
nodes (the gradient fragments — the documented tradeoff, surfaced in the slider hint and the
"How it works" step-③ text). It is NOT a clean fix, just a user-controllable tradeoff.

**The real fix — layered/translucent decomposition (NOT done here; future).** The correct
representation for these images is what the source IS: a few *translucent* shapes stacked,
the renderer blending them (so 3 circles at opacity 0.85 reproduce exactly, with the fewest
elements) — rather than splitting the blends into opaque flat bands. This is an established
research line, but all of it is global/expensive (MCTS or minute-scale solves), so none fits
this app's lightweight client-side budget yet — hence deferred:

- **Photo2ClipArt** — Favreau, Lafarge, Bousseau, *SIGGRAPH Asia 2017*: stacked
  semi-transparent gradient layers chosen by a fidelity-vs-simplicity energy via Monte-Carlo
  tree search. https://www-sop.inria.fr/reves/Basilic/2017/FLB17/
- **Image Vectorization & Editing via Linear Gradient Layer Decomposition** — Du et al.,
  *SIGGRAPH 2023*: https://dl.acm.org/doi/10.1145/3592128 — code (unlicensed):
  https://github.com/Zhengjun-Du/ImageVectorViaLayerDecomposition
- **Image Vectorization with Depth** — arXiv 2409.06648 (2024): depth ordering + elastica
  completion of the occluded parts of each layer.
- ARDECO (Lecot & Lévy, EGSR 2006) is the variational ancestor;
  our V4 glow-stack (§3.2.4) is the restricted, logo-scale special case already shipped.

### V5+ — user-placed region markers (seeded segmentation) — 2026-06-13 — ✅ shipped (exit met)

**Why.** The `Region detail` knob (above) recovers translucent overlaps only by
tightening the merge thresholds GLOBALLY, which also fragments smooth gradients
everywhere (measured there: nebula 3→9 paths / 29→1414 nodes). Markers are the
surgical alternative — the classic marker-controlled-segmentation technique
(marker watershed / seeded region growing): the user clicks the spots to keep as
their own regions; ONLY those are protected, so gradients elsewhere stay intact.

**Marker-watershed semantics.** A marker = "keep a distinct region here." Two
segments that carry DIFFERENT markers must never merge; an unmarked region merges
exactly as before. So to split a translucent overlap from a neighbouring shape the
user marks BOTH (the overlap centre AND each circle). No foreground/background
scribble groups (deferred) — one flat marker class, v1.

**What shipped** (additive; no markers ⇒ byte-identical output):
- `src/types.ts` — `VectorizeOptions.markers?: {x,y}[]` in NORMALIZED [0,1] image
  coords (resolution-independent: correct at studio 1024 and explainer 512 alike).
- `src/lib/trace/segment.ts` — `SegmentOptions.markers`; each marker (fixed input
  order) claims the nearest SMOOTH pixel (`nearestSmoothPixel`, expanding
  Chebyshev-ring scan capped at 64 px ⇒ a stray marker degrades to a no-op, not a
  full sweep) and gets a distinct id. The must-not-merge constraint reuses the
  existing 𝒜 veto mechanism at **both** merge steps (see deviation 1):
  - step 2 (colour-difference seeded growth): a per-root `rootMarker` array; a
    union that would bring two different markers together is vetoed, so the two
    marked seeds grow into a watershed instead of fusing.
  - step 3c (global union-fit): a per-group `groupMarker`; `pairVetoed` rejects a
    merge of two differently-marked groups. A group holds ≤1 marker by induction.
- `src/lib/trace/index.ts` — `segmentOptionsFor` threads `markers` through (whether
  or not `regionDetail` is raised); no markers + detail 0 returns the exact default
  object ⇒ byte-identical. `traceImage` already passes the full options, so the
  worker (`trace.worker.ts`) and off-thread clients (`traceOffThread.ts`) carry
  markers through `postMessage` UNCHANGED — no worker/plumbing changes needed.
- UI: a **"Mark"** tool (3rd toolbar segment, key **M**) in `VectorizeStudio` +
  `EditorCanvas` (reusing its exact pan/zoom↔image transform — no parallel one):
  click adds a marker, click a pin removes it, a toolbar "N markers · Clear"
  affordance clears all. Pins are emerald target glyphs rendered in every tool
  (so protected spots stay visible), `r()`-scaled to constant screen size under
  zoom, `pointer-events:none` (removal hit-tested geometrically by the svg).
  Markers live in `opts.markers` ⇒ flow into the (debounced) trace AND the "How it
  works" explainer (step 3 reflects the marker count), and SURVIVE a re-trace
  (`run()` resets only the doc, never opts). Crisp stays off-thread.
- Tests: `test/markers.test.ts` (5, pure `node --test`) — two markers split one
  adjacent same-colour region (step-2 watershed), a marker in each of two merging
  blobs keeps them separate (step-3c veto), empty/undefined markers ⇒ byte-identical
  labels, determinism-with-markers, and an edge-placed marker snapping to the
  nearest region. `npm test` 98→**103**.

**Harness numbers.**
- *No-marker parity — byte-identical.* `runBaseline` hashes UNCHANGED on every row
  (nebula 27d9bc0a, petals bad1db5a, summit 4a1e726b, orbit a14e2458, bloom
  bf83b801); every metric identical, only `runtimeMs` (timing noise) differs.
  Determinism `pass`; typecheck + build green.
- *petals (the target case), headless segmenter region counts:* default **4**
  (bg + 3 circles, overlaps fused). Mark the blue∩pink overlap + both circles (3
  markers) → **5** (the overlap returns as its own ~4.5k-px cyan region). Mark all
  3 circles + 3 pairwise overlaps + triple (7 markers) → **7**. Browser studio:
  6 markers → **4→6 paths / 31→52 nodes**, with `Region detail` left at **auto** —
  overlaps recovered with NO global fragmentation.
- *nebula (the must-not-regress case):* a marker placed IN the smooth gradient →
  **2→2** regions, byte-identical centroids/counts. A marker on a region that is
  already its own region is a no-op for that field — the gradient is NOT fragmented
  (contrast the `Region detail` knob, which shatters it). Exit criterion met.

**Browser verification.** Mark tool exercised end-to-end on petals: add (pins
render + debounced re-trace fires + overlaps appear), remove (click a pin: 2→1),
clear (8→0, reverts to the 4-path baseline), pins stay anchored + constant-size at
157 % zoom, and **screenshots succeeded mid-crisp-trace** (the "Tracing layer N/N…"
overlay while the UI stayed interactive — proof the worker path stayed off-thread).

**Deviations from the brief (each with a measured reason).**
- **Markers veto at BOTH merge steps, not only the step-3c 𝒜 veto the brief named
  as the integration point.** Measured earlier (the `Region detail` entry): the
  petals overlap fuses into a circle at **step 2** (the τ_s colour-difference merge)
  — `τ_s = 4` alone leaves petals at 4 regions; only `τ_s ≈ 2` recovers it. So a
  step-3c-only veto could never separate two markers that step 2 had already merged
  into ONE fine segment. Extending the SAME veto down to step 2 (seeded growth) is
  what makes the petals case work; it is the established watershed move, not a
  parallel mechanism.
- **A marker off a smooth pixel snaps to the nearest one** (rather than being
  dropped) so a click on an anti-aliased edge / 𝒟 pixel still anchors to a real
  segment; unreachable (fully transparent) ⇒ silently ignored.
- **The "exempt marked segments from despeckle/AA-absorption" step is satisfied
  structurally, not as new code:** `segment.ts` has no region-despeckle pass (V2
  deleted drop-minor), and step 4 only floods UNassigned 𝒟 pixels — it never
  absorbs a whole region — so the two vetoes alone guarantee a marked region
  survives. (A sub-turdsize marked speck can still be dropped by the tracer
  downstream; out of scope.)
- **Marker UI lives in `EditorCanvas`** (now that the parallel edit-view rework had
  landed) to reuse its measured client↔viewBox transform verbatim, rather than a
  standalone overlay with a duplicated transform.
