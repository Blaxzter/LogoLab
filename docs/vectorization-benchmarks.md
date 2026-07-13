# Vectorization benchmarks & ground-truth corpora — research findings

**Date:** 2026-07-12. **Method:** multi-agent deep research, 26 primary sources (GitHub
repos, HuggingFace dataset cards, arXiv PDFs, LICENSE files), 129 extracted claims, 25
adversarially verified (3 independent refutation votes each). 12 confirmed, 4 **refuted**,
9 unverified (the verification pass hit a token limit).

This file exists so the findings are not lost. Anything marked ⚠️ REFUTED is a claim that a
naive reading of the docs would lead you to, and which the verification pass **killed** —
those are the expensive mistakes.

---

## 1. Why we built a ground-truth gate at all

The pre-existing gate (`test/trace-regression.test.ts` + `test/golden/trace-baseline.json`)
compares the tracer **to its own previous output**. It can detect that something *changed*.
It cannot detect that something is *wrong*, and its ±12% count bands actively **forbid**
improvement:

> `headphones-flat` is blessed at **9,632 nodes** with jaggedness 7.53 (every other case is
> under 0.7). The gate is `nodes within ±12%`, so the floor is 8,476. **Making the tracer
> three times more economical on that photo fails the build.**

Worse, raster fidelity is *structurally blind* to a dropped region. `bloom` scores SSIM
0.9922 / meanΔE 0.11 — near perfect — while silently dropping two of its seven composited
regions. A small, low-contrast region merged into its neighbour costs almost nothing in
mean ΔE while destroying the topology. See `docs/handoff-lab-views-react.md` and
`src/devtest/truthCorpus.ts`.

---

## 2. What the field actually measures (hypothesis: raster only — **CONFIRMED**)

| Work | Evaluates with | Geometric metric vs. GT SVG? |
|---|---|---|
| **LIVE** (CVPR 2022) — the flagship flat-art vectorizer | MSE vs. path count, **against the input raster only** | **No.** Its test sets (134 emoji, 153 icons/clipart) were *rendered from SVGs that were available*, and it still didn't use them. Path count is a budget knob, not a score. |
| **StarVector / SVG-Bench** (2024–25) — current SOTA benchmark | MSE, SSIM, LPIPS, DinoScore | **No.** The paper even shows MSE correlates poorly with human judgement (Spearman 0.06–0.10) — and proposes a *better perceptual* metric, not a geometric one. |
| **Im2Vec** (CVPR 2021) | raster | **No** — and see the warning below. |
| **SGLIVE** (2024), the gradient-fitting LIVE descendant | pixel/perceptual reconstruction | **No.** States it is *"tested on various inputs… independent of datasets"* — there is no gradient GT corpus to score against. |

**Nobody in the image-vectorization line scores geometry.** That is the opportunity, and
also the reason to be suspicious of ourselves — see §3.

### ⚠️ The objection that can sink a geometric benchmark

**Im2Vec explicitly argues Chamfer distance is a BAD vectorization metric**: *"the Chamfer
distance varies wildly depending on the sampling pattern"*, and vector-supervised baselines
that regress the GT's own parameterization score **better** on Chamfer while looking
**worse**. This is the field's stated justification for retreating to raster metrics.

**How `src/devtest/geomScore.ts` answers it** (do not regress this):
- query points are resampled at a **fixed arc-length spacing**, never per-node and never
  uniform-in-*t*, so point density depends only on curve length — not on where the tracer
  chose to put nodes;
- distance is measured to the nearest **segment** of the target polyline, not the nearest
  target *point*, so the target's own discretization density drops out too.

Neither side can be gamed by parameterization.

---

## 3. Where geometric GT scoring *is* standard — steal the metrics, not the data

| Work | Metrics | Fit for a region/flat-art tracer |
|---|---|---|
| **Deep Vectorization of Technical Drawings** (ECCV 2020, arXiv 2003.05471) | Hausdorff (max), Mean Minimal Deviation (mean), **primitive count**, IoU — computed by rendering vector GT → raster → vectorize → **score in geometry space** | The *exact* protocol we use. But: centerline strokes on a skeleton, not filled regions. PFP floorplan data is commercially sourced, **not redistributable**. **Take the metrics.** |
| **Polygonal building-footprint vectorization** (e.g. P3, arXiv 2505.15379) | **Chamfer** (mean boundary-to-boundary), **Hausdorff** (max), IoU, **vertex-count ratio** | The only branch whose GT is *closed regions with boundaries* — structurally what our planar tracer emits. Its vertex-count ratio is literally our node-economy metric. Aerial imagery, straight-line polygons, no Béziers. **Cleanest published template.** |
| **Single-Line Drawing Vectorization** (CGF 2025) | stroke-length delta, stroke count, and **undetected vs. hallucinated intersections** | The intersection bookkeeping is the closest published analogue to our **junction-weld** check — sharper than a raw cluster count because it is scored against truth. Data is Adobe Stock-licensed, **unusable**. **Take the metric.** |
| **CubiCasa5K** | segmentation metrics (mIoU) | Literally "raster in, authored SVG GT out" — but it is a *labelling* GT stored in SVG, not a tracing-fidelity GT. **CC-BY-NC-SA** → unusable anyway. |

---

## 4. Corpora — verdicts

### ✅ The gradient answer: Microsoft Fluent Emoji

**[microsoft/fluentui-emoji](https://github.com/microsoft/fluentui-emoji) — MIT.** The single
most valuable finding. Every emoji ships in three authored styles: **Color**, Flat, High
Contrast. The **Color** SVGs are gradient-heavy Figma exports — verified by fetching raw
files: `rocket_color.svg` carries **20 `linearGradient` + 34 `radialGradient`** references,
4 `<filter>` elements and 21 opacity attributes; `balloon_color.svg` 8 linear + 16 radial.

~1,500+ emoji × Color style ≈ **the only meaningful-scale corpus of clean, hand-authored,
multi-stop linear+radial gradient SVGs with real translucency that exists.** Root LICENSE is
plain MIT (verified via raw.githubusercontent) — safe to vendor into a public repo.

**Bonus:** the **Flat** variant of the same glyph is a built-in flat/gradient **A–B pair** —
same artwork, one with gradients and one without. Exactly the controlled experiment the
gradient union-merge and background-reunification work needs. The `<filter>` elements and
inner shadows are also precisely the soft-edge adversary a planar tracer must survive.

> **Outside of this, gradients are a desert.** No academic corpus has authored-gradient
> ground truth. SVG Repo (500k+, "mostly CC0") has gradient illustrations but mixes CC0 /
> CC-BY / MIT **per asset** — hand-curate, never bulk-pull.

### ✅ Twemoji — CC-BY 4.0, use the fork

**[jdecked/twemoji](https://github.com/jdecked/twemoji)** (the maintained community fork;
`twitter/twemoji` is abandoned post-acquisition). Graphics are **CC-BY 4.0** — permissive,
**non-viral**, needs only an `ATTRIBUTION` file. ~3,600 authored multi-colour **flat** SVGs
with real fill colours. Good for multi-region topology, hole correctness, authored-fill ΔE.

### ✅ Noto Emoji — mind the licence split

Fonts are **OFL 1.1**, but the tools and **image assets (the SVGs) are Apache 2.0** —
permissive, non-viral. Flat only.

### ✅ Material Design Icons — Apache 2.0, **filled**

The right pick for a silhouette/boundary/corner tier. **No brand trademarks.**

### ⚠️ REFUTED — Simple Icons is *not* the free lunch it looks like

The project LICENSE is CC0-1.0, but
[DISCLAIMER.md](https://github.com/simple-icons/simple-icons/blob/master/DISCLAIMER.md) says:

> *"Simple Icons is released under CC0 — though that doesn't mean to imply that all icons
> within the project are also CC0."*

The CC0 waives the **maintainers'** rights in the path data; it cannot waive third-party
**brand** rights. Vendoring ~3,300 brand marks into a public repo is **trademark exposure
that CC0 does not cure**.

Two further claims were killed 0-3 by the verifiers:
- ⚠️ "all icons are CC0, redistributable with no obligation" — **REFUTED** (above).
- ⚠️ "every icon is a single hand-authored `path` in a 24×24 viewBox, no groups/circles/rects"
  — **REFUTED.** Do not assume uniform structure.

Also: fills are **stripped** (icons default to black), so Simple Icons **cannot test
authored-fill colour error at all**. *Mitigation if you still want it: pull via npm at build
time rather than committing the SVGs, or hand-pick a non-brand subset.*

### ❌ Lucide / Feather — wrong shape entirely

ISC/MIT, no trademarks — but they are **stroke-based line icons with no fills**. A rasterized
stroke traces as a thin closed region, so the authored node count and hole topology will
**not correspond** to anything a region tracer recovers. Use Material Design Icons instead.

### ❌ DeepSVG / SVG-Icons8 — dead end, three ways

1. Distributed as **pre-augmented PyTorch tensors** (`icons_tensor.zip`, 3 GB), *not* SVG.
2. The repo tells you to get the originals from icons8, *"for which you will need a paid
   plan"*.
3. Preprocessing applies **Ramer-Douglas-Peucker and Schneider simplification** — so even the
   tensors are lossily-rewritten curves. **Unusable as node-economy or corner-fidelity GT by
   construction**, even if you paid.

### ❌ FIGR-8 — dead end

Headline release is 1.5M grayscale **192×192 PNGs** (raster). ⚠️ The claim that a clean
`FIGR-8-SVG` is readily obtainable was **REFUTED 0-3**. Licensing is a hazard regardless: MIT
wrapper over individually **CC BY 3.0 US** Noun Project files, with the README asserting
reproduction on material intended to be sold is *strictly prohibited*.

### ⚠️ StarVector SVG-Stack — the licence is **undeclared**

11 live HF datasets (`svg-stack` 2.28M, `svg-fonts` 1.93M, `svg-icons` 89.4k, `svg-emoji`
10k, `FIGR-SVG` 1.33M, `svg-diagrams` 183k; all updated Jan 10 2025). `svg-stack` is the only
one retaining the full range of SVG primitives, so gradients *do* appear — but incidentally
and unstratified (web icons, plots, logos, junk), and the **HF dataset card declares no
licence at all**. Scraped from The Stack → a mixture of upstream licences, **legally
unresolved** for redistribution.

- `starvector/svg-emoji` (10k) **does** contain real gradients — but it aggregates OpenMoji +
  Noto + Twemoji, so it **inherits OpenMoji's ShareAlike**.
- Every **`-simple`** variant is useless to us: the simplification *"consists of eliminating
  complex primitives… **color and shapes are abstracted only to use simple line strokes**."*

### ❌ OpenMoji — ShareAlike, avoid

**CC BY-SA 4.0.** The ShareAlike is viral and would infect a derived corpus. The proposal to
relicense to plain CC BY is an **open, undecided issue** as of June 2026.

### ❌ OmniSVG / MMSVG-Illustration — **CC-BY-NC-SA**

NonCommercial *and* ShareAlike. Also: every SVG is resized to 200×200 and rewritten through
**picosvg** — lossy, so node counts don't reflect authored structure anyway.

---

## 5. The recommended tiered corpus

| Tier | Source | Licence | Purpose |
|---|---|---|---|
| **0 — the gate** | **our handcrafted cases** (`src/devtest/genEdgeCases.ts` → `TRUTH_CORPUS`) | ours | Each isolates a *named* failure mode of **this** tracer (bg-gradient reunification, colour-class DELETE risk, junction weld). **No public corpus covers these.** |
| **1 — gradients** | **Fluent Emoji "Color"**, ~100–200 sampled | **MIT** | The only authored gradient GT that exists. Flat variants give a free A/B. |
| **2 — multi-colour flat** | **Twemoji** (jdecked fork), ~200–300 | **CC-BY 4.0** | Region topology, holes, authored fill ΔE. Needs an `ATTRIBUTION` file. |
| **3 — silhouettes** | **Material Design Icons**, ~200 | **Apache 2.0** | Boundary/corner/node-economy. Filled, no trademarks. |
| **4 — canaries** | the real PNGs (nebula, petals, schild, headphones) | ours | Loose "did we catastrophically collapse" gates only. Not a target. |

**Licence hygiene for a public repo:** CC0 needs nothing · MIT/Apache/ISC need a NOTICE ·
CC-BY needs an ATTRIBUTION file — all fine. **Anything `-SA` or `-NC` stays out.**

---

## 6. Implementation notes worth not rediscovering

- **Rasterizer: `@resvg/resvg-js`, not `sharp`.** When the rasterization *is* the ground
  truth, fidelity beats sharing a dependency — and Fluent Emoji's Color SVGs use `<filter>`
  elements, which resvg handles far more faithfully than librsvg. (Install with **pnpm**;
  this is a pnpm workspace and npm chokes on the `workspace:` protocol.)
- **`model.parseSvg` is unusable for GT**: it needs `DOMParser` (absent in Node) *and* it
  routes gradient-filled shapes into `RawItem`s that the rasterizer skips — lossy in exactly
  the dimension we want to score. Hence `src/devtest/svgGround.ts`.
- **Counts are not comparable; boundaries are.** An authored primitive count ≠ the region
  count a planar tracer should recover. `bloom` is 3 translucent circles → **7** composited
  regions (correctly). `nebula` is 4 paths of which 2 share a fill → **3** merged paths
  (correctly). Scoring "recovered paths vs authored paths" marks both as failures. **Boundary
  distance is composition-invariant**; parsimony must be **nodes per unit boundary length**.
- **Stroked SVGs cannot be ground truth** without offset-curve maths. A stroked element's
  visible boundary is the *outline of the stroke*, not its centerline. We re-authored the
  generated edge cases as **fills** (`thickLine` / `ring` in `genEdgeCases.ts`) — exact GT,
  zero offset maths, pixel-identical output. `public/examples/aurora.svg` is still stroked
  (mitered chevrons) and therefore still unscorable.
- **Two false-pass traps we already fell into** (see `geomScore.ts` comments):
  1. a case with no interior boundary (`bg-ramp` is one full-canvas rect) yields zero sample
     points → `mean([]) === 0` → a **perfect score for measuring nothing**. Hence
     `GeomScore.samples` and `TruthGate.applicable`.
  2. **region recovery is meaningless on gradient art** — a smooth ramp's 8-bit quantisation
     bands read as 69 "flat regions", so a tracer that correctly fits *one* gradient looks
     like it dropped 60.
- **Match regions by LOCATION, not colour.** Rasterize the trace and ask what colour it paints
  at each true region's own pixels. Colour-matching can pair a dropped region with an
  unrelated path of coincidentally similar shade — `bloom`'s dropped A∩C lens (`#1e9feb`)
  sits only **ΔE 4.7** from the traced B∩C fill (`#309bdf`), a different region on the other
  side of the image.

---

## 7. Open findings about the tracer (not the benchmark)

These came out of the first ground-truth runs and are **not yet fixed**:

- **Systematic low-contrast overlap merge.** `bloom` and `petals` independently drop their
  overlap lenses. Two distinct failure modes, separated by the location-based matcher:
  - `bloom` `#db50a7` (A∩B) → the trace paints `#ef63a8` there: **absorbed into its
    neighbour** (ΔE 11.0).
  - `bloom` `#1e9feb` (A∩C) → the trace paints `#309bdf` there: the region **exists but got
    the wrong colour**, merged into the spatially-distant B∩C **colour class** (ΔE 4.7).
  - The merge is **colour-threshold driven, not area driven**: B∩C survives at 821px with a
    ΔE 75.2 step, while the dropped lenses are 695px with ΔE 11.0/13.5 steps. **The threshold
    sits above ΔE 13.5.**
  - **The old golden passes both** (bloom SSIM 0.9922, petals 0.9915).
- **`hairlines`: 56px Hausdorff** — the sub-pixel bars are simply gone.
- **`cross-bars`: 9.6px worst-case miss**, parsimony 2.7× — the junction-weld case now has a
  number.
- **Good news:** `nebula` (0.23px chamfer, parsimony 1.0×), `annulus` (0.09px chamfer — hole
  topology is nailed), `concentric`, `sharp-star`, `aa-seam`, `overlap` all clean.
