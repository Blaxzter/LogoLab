# Vectorization benchmarks & ground-truth corpora — research findings

**Date:** 2026-07-12. **Method:** multi-agent deep research, 26 primary sources (GitHub
repos, HuggingFace dataset cards, arXiv PDFs, LICENSE files), 129 extracted claims, 25
adversarially verified (3 independent refutation votes each). 12 confirmed, 4 **refuted**,
9 unverified (the verification pass hit a token limit).

This file exists so the findings are not lost. Anything marked ⚠️ REFUTED is a claim that a
naive reading of the docs would lead you to, and which the verification pass **killed** —
those are the expensive mistakes.

---

## 0. Open tracer defects — the ranked working list

**The rules that keep this list trustworthy** (hand-maintained lists rot; these are the
guardrails):
- `KNOWN_DEFECTS` in `test/truth-gate.test.ts` is the **authoritative, machine-checked
  status** for gated cases — CI breaks both when a new case fails and when a listed one
  starts passing. This section adds ranking and the defects that have **no gated case** and
  therefore cannot appear there.
- Every entry must name the **corpus case that reproduces it** and the section that measures
  it. No case, no entry.
- An entry leaves the list only with a measured before/after (like §9.4). Numbers are @512px.
- Ranked by relevance to the product: **flat vector / AI-generated icons** (gradient art is
  scoring infrastructure, not a goal).

| # | defect | reproducing case | number | details |
|---|---|---|---|---|
| 1 | **Thin features**: sub-pixel bars partially lost, and the surviving ones painted **blend-grey** (their pixels never reach the authored colour — the red diagonal traces grey) | `hairlines` (tier 0, gated, in `KNOWN_DEFECTS`) | chamfer 3.73px, p95 55.9px | §7, diagnosis §9.3 |
| 2 | **Missed boundary on flat art** — not fixed by region recovery; cause unlocated | `taco`, `mate`, `fortune-cookie` (tier 2, ungated) | missed 20.1 / 11.7 / 9.9px; corpus mean 1.89px | §9.2 |
| 3 | **Junction weld** — crossing-bar junction wedges pulled | `cross-bars` (tier 0, gated, in `KNOWN_DEFECTS`) | chamfer 1.04px, p95 9.6px | §7; `weld3` does NOT fix it, `refine` helps but regresses elsewhere (§9.3) |
| 4 | **AA diagonal sliver** — soft diagonal between two flats | `aa-seam` (tier 0, gated, in `KNOWN_DEFECTS`) | chamfer 1.35px, p95 24.8px | §7 |
| 5 | **Edge pull on flats bordering a gradient bg** | `gradient-flat` (tier 0, gated, in `KNOWN_DEFECTS`) | p95 6.3px | §7 |
| 6 | **Near-colour palette cluster fusion** — `quantize`'s `MERGE_DISTANCE` 10 (RGB) fuses two authored colours ΔE ≈ 4.5 apart; the last remaining tier-2 region drop | `flute` (tier 2, ungated) | 1 region, ΔE 4.5 | §9.4 |
| 7 | **Checkerboard corner scalloping** — diagonally-touching squares corner-weld into scallops; sub-tolerance but visible at 1× | `checker` (tier 0, gated, **passes**) | all deviations < 2px | §8.2 |
| 8 | **Sub-pixel edge placement** slightly behind the crisp engine on smooth high-contrast boundaries (planar fits the integer crack lattice, not the AA coverage field) | nebula (gradient golden; seam metric) | last-decimal seam delta | `docs/planar-tracer.md` §3 |
| 9 | **Gradient banding** — a stack of translucent gradients traced as regions the art does not contain. *Deprioritised: off the product target* | `fluent-olive` (tier 1, gated, in `KNOWN_DEFECTS`); `black-circle` (ungated) | olive p95 97px; black-circle 31.3px invented; 10.8× invented vs flat | §8.3, §8.5 |
| 10 | **Dropped gradient boundary** — verified-visible authored edges simply lost on gradient art. *Deprioritised, distinct from banding* | `speaker-low-volume`, `chart-decreasing` (tier 1, ungated) | ~15–17px missed | §8.5 |

Recently closed (the pattern an exit should follow): **dropped small flat regions** — 22 → 1
across tier 2, `bloom`/`petals` 5/7 → 7/7, root-caused and measured in **§9.4** (2026-07-15);
**`checker` unscorable** — re-authored, now green (§8.2, 2026-07-15).

Feature verdicts (not defects): the experimental A/B flags (`refineJunctions`,
`weldJunctions`, `backgroundGradient`) measured **non-mergeable as defaults** — §9.3. The
plan is to expose them as opt-in feature flags in the /vectorize studio instead.

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
mean ΔE while destroying the topology. See `docs/labs.md` (the `/labs/truth` view) and
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
| **0 — the gate** ✅ **BUILT** | **our handcrafted cases** (`src/devtest/genEdgeCases.ts` → `TRUTH_CORPUS`) | ours | Each isolates a *named* failure mode of **this** tracer (bg-gradient reunification, colour-class DELETE risk, junction weld). **No public corpus covers these.** |
| **1 — gradients** ✅ **BUILT — see §8** | **Fluent Emoji "Color"**, **109 vendored** of 1,595 triaged | **MIT** | The only authored gradient GT that exists. Flat variants give a free A/B. |
| **2 — flat twins** ✅ **BUILT — see §9** | **Fluent Emoji "Flat"**, the 106 tier-1 A/B controls promoted to scored cases | **MIT** | Region recovery + boundary on flat multi-region art — the product's actual shape. |
| **3 — multi-colour flat** | **Twemoji** (jdecked fork), ~200–300 | **CC-BY 4.0** | Region topology, holes, authored fill ΔE. Needs an `ATTRIBUTION` file. |
| **4 — silhouettes** | **Material Design Icons**, ~200 | **Apache 2.0** | Boundary/corner/node-economy. Filled, no trademarks. |
| **5 — canaries** | the real PNGs (nebula, petals, schild, headphones) | ours | Loose "did we catastrophically collapse" gates only. Not a target. |

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
- **Neither can filtered, clipped, masked or pattern-filled SVGs** — same principle, four more
  ways for the visible boundary to stop being the authored boundary. All are refused by
  `svgGround.refusals()`; see **§8.1–8.2**, which is where each was found the hard way. Note
  Figma hangs `filter=`/`clip-path=`/`mask=` on a **`<g>`**, so a reader that parses `<g>` only
  for its transform walks straight past them into the children.
- **A gradient `url(#…)` fill is fine; a pattern `url(#…)` fill is not.** The distinction is the
  whole of tier 1 — a gradient leaves the outline exactly where it was authored, a pattern
  replaces it with a tiling — so the check must **resolve the referenced id**, not match on
  `url(`.
- **Rasterize both consumers onto the same background.** resvg was compositing on white and the
  browser canvas on transparency, which moved the segmentation and made the lab and the CLI
  disagree about a real defect (**§8.7**).
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

## 7. First ground-truth findings about the tracer (2026-07-12) — historical record

**The live, ranked defect list is §0** — this section is the original record of what the
first ground-truth runs surfaced, kept because the *wrong characterisation* below (and how
the corpus corrected it) is itself a finding:

- ~~**Systematic low-contrast overlap merge.**~~ **FIXED 2026-07-15 — see §9.4.** `bloom` and
  `petals` dropped their overlap lenses; both now recover 7/7 at every resolution and pass
  every tier-0 gate (deleted from `KNOWN_DEFECTS`). The original characterisation below was
  *wrong in an instructive way*: the merge looked "colour-threshold driven, not area driven"
  (B∩C survived at 821px with ΔE 75.2 while 695px lenses with ΔE 11.0/13.5 dropped), but the
  real mechanism was `dropMinorColors`' **share threshold** — pure area, no colour term. The
  ΔE pattern was a coincidence of which *cluster counts* (region + its AA rim) landed either
  side of 0.6%. The lesson: a threshold inferred from two data points is a hypothesis, not a
  characterisation — the tier-2 corpus (22 drops, ΔE 4.5–115.2) broke it immediately.
  - **The old golden passed both** (bloom SSIM 0.9922, petals 0.9915) — raster-blindness
    confirmed.
- **`hairlines`: 56px Hausdorff** — the sub-pixel bars are simply gone.
- **`cross-bars`: 9.6px worst-case miss**, parsimony 2.7× — the junction-weld case now has a
  number.
- **Good news:** `nebula` (0.23px chamfer, parsimony 1.0×), `annulus` (0.09px chamfer — hole
  topology is nailed), `concentric`, `sharp-star`, `aa-seam`, `overlap` all clean.

---

## 8. Tier 1 (Fluent Emoji "Color") — built, and what it found

**Built:** `src/devtest/vendorFluentEmoji.ts` (vendor + triage) → `public/corpus/fluent/`
(109 Color SVGs + 106 Flat twins + `NOTICE` + `manifest.json`) → `src/devtest/fluentCorpus.ts`
(generated) → spread into `TRUTH_CORPUS`. Pinned at `microsoft/fluentui-emoji@62ecdc0d`.
Browse at `/labs/truth` (Set → *Tier 1*); CI gates a 10-case slice (`test/truth-gate.test.ts`).

### 8.1 Only 6.9% of the art is usable as ground truth — and that is the correct answer

Triaging all **1,595** candidate glyphs (skin-tone duplicates excluded) through
`parseGroundTruth` + `refusals()`:

| Refused because | Glyphs | Why it cannot be ground truth |
|---|---:|---|
| `filtered` | **1,417** | see below — **the big one** |
| `stroked` | 998 | the visible boundary is the stroke *outline*, not the path |
| `empty` | 312 | every shape in the file was refused, so nothing was left |
| `clipped` | 115 | the visible boundary is the intersection with the clip |
| `masked` | 15 | the visible boundary is the mask's alpha |
| **scorable** | **110** | of which **109** actually carry gradients → the tier-1 corpus |

(Columns sum to more than the total: a glyph is counted under every reason it fails.)

**`svgGround` had to learn to refuse three new things**, and finding that out was most of the
work. Before this, it checked only for strokes — so it would have handed back confident,
crisp geometry for **16 of the 24** glyphs it accepted, whose visible boundary it cannot
actually reproduce. Fluent puts `filter=` / `clip-path=` / `mask=` on a **`<g>`**, and a
transform-only reader walks straight past it into the children.

Both of Fluent's filter families break ground truth, **for opposite reasons** — which is
exactly why they are refused rather than approximated:
- **foreground blur** (`feGaussianBlur` on `SourceGraphic`, σ=0.5 in a 32-unit viewBox)
  **displaces the silhouette**: the authored path is nowhere near the visible edge;
- **inner shadow** (`SourceAlpha` → `feOffset` → blur → `feComposite k2=-1 k3=1`) leaves the
  silhouette intact but paints a **soft edge *inside* it that the authored path list does not
  contain**. A tracer that correctly reproduces that edge gets scored as having *hallucinated*
  it. The answer sheet is incomplete, and an incomplete answer sheet marks correct work wrong.

> **Teaching `svgGround` inner shadows is the single highest-value follow-up**: it alone would
> unlock a large share of those 1,417 glyphs. It needs the shadow's own geometry added to the
> GT, not just tolerance for the filter.

### 8.2 It also caught a live bug in tier 0: `checker` was never scorable

`checker.svg` was two rects with `fill="url(#pattern)"`. The visible boundary is the pattern's
**tiling** (~7,000 edges); the authored geometry is **two rectangles**. It was being scored
against those two rects and "failing" at **chamfer 26.7px, p95 114px, parsimony 32×**, with
52px of *invented* boundary — i.e. a tracer that correctly recovered the checkerboard was
being charged with inventing it. That was a bug in the **answer sheet**, not the tracer.
It reported *not scorable* (`patterned`), like `aurora` (`stroked`), until **2026-07-15**, when
it was re-authored as 896 explicit filled squares (patterns are to fills what strokes are to
fills; tiles resized 18/9 → 16/8 so the coarse grid aligns with the fine quadrant — no square
straddles it, so nothing is occluded). Scored for the first time, the tracer **passes**:
chamfer 0.38px / p95 1.87px / parsimony 1.0× / 2/2 regions @512, near-perfect 0.01px @1024.
One honest nuance the numbers under-sell: in the FINE quadrant the diagonally-touching ink
squares come out corner-welded into scalloped blobs — every deviation is sub-2px (hence the
green p95) but the texture visibly differs at 1×. A real defect, correctly sized by the
metric as small; if it ever matters, it needs a corner-topology fix, not a tolerance change.

### 8.3 The flat↔gradient A/B — the experiment nobody could run

`src/devtest/fluentAbRun.ts`, 106 matched pairs @ 512px. The same glyph, authored flat and
authored with gradients, same rasterizer, same tracer, same scorer:

| | gradient (Color) | flat | |
|---|---:|---:|---|
| boundary error (mean) | 2.44px | 1.07px | 2.3× worse |
| …authored boundary **MISSED** | 2.63px | 1.93px | 1.4× worse |
| …boundary **INVENTED** | **2.26px** | **0.21px** | **10.8× worse** |

Gradient art scores worse on **92 of 106** pairs. **The tracer is not failing to find the
art — it is inventing art that is not there.** It recovers the authored silhouette on gradient
glyphs about as well as on flat ones (missed is only 1.4× worse; sub-pixel on 45 of 109), and
then **bands a smooth stack of translucent gradients into regions the art does not contain**.

`black-circle` is the pure case: **one circle**, painted with **five stacked translucent
gradients**. Its flat twin scores a near-perfect 0.14px. The gradient original scores 15.74px
— missed **0.18px**, invented **31.30px**, and 3 traced paths for a 1-circle glyph.

*Caveat, stated because it is load-bearing:* Flat is a separately **authored** drawing, not the
Color art with its gradients deleted (22 shapes vs 6 on average). It is a **matched pair, not
an ablation** — the direction is solid, the magnitude is an upper bound.

### 8.4 Ruled out: the answer sheet is NOT full of phantom edges

Before trusting any of the above, the obvious alternative explanation was tested: an authored
path that is **occluded** contributes boundary no tracer can recover, which would show up as a
fake "missed". Measured (step ±2px along the boundary normal, compare raster colour):
**only 1.9% of tier-1 authored boundary is invisible**, and excluding it moves the corpus mean
by 0.1px (5.67 → 5.57px). So `geomScore` needs no change and the failures below are real.

### 8.5 New open findings about the tracer

- **Gradient banding on stacked overlays** (§8.3). The headline. `black-circle`, `olive`,
  `potato` — invents 9–31px of interior boundary.
- **Genuinely dropped boundary**, a *distinct* failure: `speaker-low-volume` misses **16.9px**
  of **verified-visible** authored boundary; `chart-decreasing` / `chart-increasing` ~15px.
  Not occlusion, not banding — the tracer simply loses those edges.
- **Parsimony is fine, and the intuition was wrong.** Fluent draws at 32 units, so the guess
  was that any tracer would look profligate against the artist. The opposite: the tracer spends
  **fewer** nodes than the artist (mean 151 vs 252) and **97 of 109** cases already pass tier
  0's strict 3× limit.

### 8.6 Per-tier tolerances (and why tier 0's were not touched)

`TRUTH_TOL` (chamfer 1.0 / p95 2.5 / parsimony 3.0) was calibrated on crisp flat art and only
**31 of 109** gradient cases pass it. Widening it would have quietly weakened the 16 cases tier
0 depends on, so the tiers now carry **their own limits** (`TIER_TOL`), each row in the lab
says which one it was held to, and tier 0's numbers are **unchanged**:

| | chamfer | p95 | parsimony |
|---|---:|---:|---:|
| tier 0 (crisp flat) | 1.0px | 2.5px | 3.0× |
| tier 1 (soft gradient) | 6.0px | 60.0px | 5.0× |

Tier 1's are **measured** (`src/devtest/calibrateTier1.ts` prints the distribution), set just
above the corpus p90. They are **"do not get worse" numbers, not "this is correct" numbers** —
a green tier-1 gate does *not* mean the tracer is good at gradient art. Every one of them
should come **down** as §8.5 is fixed. The limits are px **at 512px**: the same trace scores
7.8px at 256 and 33.1px at 1024, so the gate pins the resolution.

### 8.7 The two consumers were tracing different pixels

`groundTruthRun.ts` rasterizes with resvg `background: 'white'`; the browser drew the SVG onto
a **transparent** canvas. Almost no corpus art carries a background rect of its own (bloom does
not; no Fluent glyph does), so the CLI and `/labs/truth` were handing the tracer **different
input** and comparing the results as though they were the same experiment.

Not a last-decimal difference — it **moved the segmentation**: the lab reported `bloom` at
**3 of 7** regions recovered where the CLI said **5 of 7**, and that gap was being read as a
real (and much worse) tracer defect. The lab now flattens onto white; both report **5/7**.
*If you see the CLI and the lab disagree, this is the first thing to suspect.*

---

## 9. Tier 2 (Fluent "Flat" twins) — the flat corpus, and what promoting it found

**Built 2026-07-14.** The 106 Flat variants had only ever been the `flatSvg` controls of the
tier-1 A/B (§8.3) — never scored in their own right. That left `regions recovered`, the
zero-tolerance dropped-region gate (the failure raster fidelity is structurally blind to, §1),
running on **12 cases**: it is `applicable: false` on all 109 gradient cases. Since flat
multi-region art is exactly what the product traces, the twins are now first-class tier-2
cases (`gradients: false`, browse at `/labs/truth` → *Tier 2*, not CI-gated). Derived in
`truthCorpus.ts` from `FLUENT_CORPUS` — not duplicated — so the pairing cannot drift.
`TIER_TOL[2]` (chamfer 3.0px / p95 35px / parsimony 4.5×) is measured, not guessed:
`calibrateTier2.ts` prints the distribution, limits sit just above the corpus p90 (parsimony:
above the max), same recipe as tier 1.

### 9.1 The headline: 22 dropped regions, and the ΔE story §7 told is incomplete

Across the 106 flat twins @ 512px: **91/106 recover every region; 22 regions dropped in the
other 15 cases** (415/437 = 95.0% overall). The §7 characterisation — a colour-threshold merge
that "sits above ΔE 13.5" — describes only the *low* end of the distribution. The dropped
regions' ΔE (truth colour vs what the trace paints at those pixels) is **p50 28.7, p90 70.9,
max 115.2**:

| case | dropped | painted instead | ΔE |
|---|---|---|---:|
| `parachute` | `#433b6b` backpack (661px) | `#00d26a` — the canopy green | **115.2** |
| `pencil` | `#402a32` graphite tip (412px) | `#f92f60` — the eraser pink | **76.4** |
| `taco` | `#6d4534` filling (1266px) | `#44911b` — the lettuce green | **70.9** |
| `flute` | `#f5a165` (2796px) | `#fea069` | 4.5 |

These are visually blatant (a pencil whose tip is eraser-pink) yet nearly invisible to raster
gates — 661px at ΔE 115 moves a 512² meanΔE by ~0.3. The region **shapes** survive; they are
assigned to a spatially distant, wildly wrong **colour class**. What looked like two failure
modes — absorption into a similar neighbour (bloom/petals, ΔE 9–14) and misassignment to a
distant class (ΔE 28–115) — turned out to be ONE mechanism whose apparent ΔE depends only on
which colours happened to survive: **§9.4, fixed 2026-07-15**.

### 9.2 Boundary: the tracer invents nothing on flat art, and loses real edges

The split (`calibrateTier2.ts`, mirrors §8.3's A/B means exactly — missed 1.93px / invented
0.21px):

|  | p50 | p75 | p90 | p95 | max |
|---|---:|---:|---:|---:|---:|
| chamfer | 0.42 | 1.33 | 2.80 | 4.10 | 10.20 (`taco`) |
| **missed** (GT→trace) | 0.72 | 2.41 | 5.43 | 7.93 | 20.17 (`taco`) |
| **spurious** (trace→GT) | 0.21 | 0.25 | 0.29 | 0.33 | **0.46** |
| parsimony | 0.83× | 0.96× | 1.37× | 1.60× | 4.29× |

Two of the three worst missed-boundary cases (`taco` 20.2, `mate` 11.7) are also dropped-region
cases (`fortune-cookie` 9.9 is not), consistent with — but not yet proof of — the obvious
mechanism: a region merged into an *adjacent* class erases the shared edge, so §9.1 and "missed
boundary on flat art" (§7) overlap substantially. Parsimony is a non-issue (p50 below 1× — more
economical than the artist).

### 9.3 The AbLab's experimental features, measured against ground truth: none merges

The `/labs/ab` variants that are not in the default trace (`refineJunctions`, `weldJunctions: 3`,
`backgroundGradient`) were swept over tier 0, the gated tier 1, and all 106 tier-2 twins
(512px). Verdict — measured, and the reason each flag **stays off by default**:

| variant | tier 0 (16) | tier 1 gated (10) | tier 2 — the product corpus (106) |
|---|---|---|---|
| `refine` | cross-bars −0.22 / gradient-flat p95 −0.75, **but** aa-seam +0.14, bloom/petals worse | olive worse | **10 better / 14 worse** — a tradeoff, not a win |
| `weld3` | bloom p95 −0.25 (the X-crossing it was built for), nothing worse | neutral | **0 better / 5 worse, +1 dropped region** — `beverage-box-flat` p95 2.0→**22.0px**, 5/7→4/7: a ≤3px micro-edge is sometimes a *real thin feature* |
| `refine+weld3` | mixed | olive worse | 9 better / **21 worse**, +1 drop |
| `bgGrad` | overlap slightly worse | neutral | 0 better / 4 worse, +1 drop |

Two conclusions worth keeping:
- **`refineJunctions`' old verdict ("weaker + corpus-moving") survives contact with ground
  truth** — it was not an artifact of the self-referential golden gate.
- **None of the fit-stage features touches the real flat-art defects.** `hairlines` is
  *identical* under every variant (p95 55.94px each): the thin bars die at
  segmentation/paint — they survive geometrically but are painted **blend-grey** (the red
  diagonal is traced grey), because a sub-pixel feature's raster pixels never reach the
  authored colour. That is a thin-feature coverage/colour-class problem (§7 #3), in the same
  family as §9.1's misassignments — not a junction-geometry problem.

### 9.4 The fix: flat-interior protection in `dropMinorColors` (22 drops → 1)

§9.1's root cause, located by instrumenting `pencil`: **`dropMinorColors(minShare: 0.006)`**
in the flat-palette path (`paletteSegment.ts`). 0.6% of a 512² raster is 1,573px — larger
than every dropped region in the corpus — so each small region's palette entry was dissolved
into its *nearest surviving* colour, which for an isolated dark detail is arbitrarily wrong
(`pencil`'s `#402a32` tip → `#f92f60` eraser-pink, ΔE 76). The share threshold exists to kill
AA blend smears and cannot be simply lowered (a long edge's blend band out-counts a small
region).

The separating evidence is **flat-interior area** — pixels whose 8 neighbours carry the exact
same source colour (the criterion `scoreRegions` already used). Measured on the corpus the
separation is absolute: every real dropped region had **300+** flat-interior pixels, every
blend smear had **0** (worst real-region false negative seen: an 85px goggle-shine). So
`segmentFlatPalette` now protects entries with flat-interior ≥ `minRegionArea` (the existing
"real region" floor, which already scales with the Despeckle dial — anything smaller is
despeckled away regardless, so protecting it would be pointless).

Results @ 512px, before → after:
- **tier 2 regions: 22 dropped → 1** (95.0% → 99.8%; 91 → 105 of 106 cases clean). The
  remaining drop is a *different* mechanism: `flute` `#f5a165` vs `#fea069` sit 9.9 apart in
  RGB, inside `quantize`'s `MERGE_DISTANCE` 10 cluster-merge — ΔE 4.5, visually negligible.
- **tier 0: `bloom` 5/7 → 7/7** (chamfer 0.65 → 0.19, p95 3.17 → 0.47), **`petals` 5/7 → 7/7**
  (chamfer 1.15 → 0.25, p95 17.77 → 0.62) — both now pass every tier-0 gate; deleted from
  `KNOWN_DEFECTS`. Every other tier-0 case unchanged (aa-seam identical — the AA-sliver kill
  still works; the protection never fires on smears because they have no flat interior).
- **tier 1: untouched by construction** (the flat-palette path only runs with gradients off).
- **boundary means moved only slightly** (tier-2 missed 1.93 → 1.89px): the dropped shapes had
  mostly been traced with the wrong *fill*, which boundary metrics (colour-blind) and raster
  metrics (ΔE-diluted) both structurally miss. Region recovery was the only gate that saw it —
  the corpus paid for itself.
- Golden gate green without re-blessing; photo trace 4.67 → 4.28s flat / 25.3 → 22.7s gradient
  (no regression; the new pass is one O(8n) scan).
