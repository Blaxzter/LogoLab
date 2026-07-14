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
| 2 | **Junction weld** — crossing-bar junction wedges pulled; visible at 1×, sub-tolerance since the scorer counts visible boundary only (like #7) | `cross-bars` (tier 0, gated, **passes**) | chamfer 0.34px, p95 0.54px (was 1.04/9.6 — the difference was the occluded under-bar edge, §9.6) | §7; `weld3` does NOT fix it, `refine` helps but regresses elsewhere (§9.3) |
| 3 | **AA diagonal sliver** — blend band assigned to one side; visible at 1×, sub-tolerance since the scorer counts visible boundary only | `aa-seam` (tier 0, gated, **passes**) | chamfer 0.22px, p95 0.74px (was 1.44/24.8 — the p95 was the seam occluded under the circle, §9.6) | §7; +0.09 chamfer from the §9.5 fix (label-level endpoint routing sends the whole sliver to one side) |
| 4 | **Edge pull on flats bordering a gradient bg** | `gradient-flat` (tier 0, gated, in `KNOWN_DEFECTS`) | p95 6.3px | §7 |
| 6 | **Thin features at LOW resolution** — below ~256px the sub-pixel bars still break up (the @512 defect is fixed, §9.5; the gate runs at 512) | `hairlines` @256 (ungated resolution) | chamfer 0.88px, p95 9.77px @256 (was 2.44/27.8 before §9.6 — part of that was bar-crossing occlusion; the remaining 9.77 is real) | §9.5 |
| 7 | **Checkerboard corner scalloping** — diagonally-touching squares corner-weld into scallops; sub-tolerance but visible at 1× | `checker` (tier 0, gated, **passes**) | all deviations < 2px | §8.2 |
| 8 | **Sub-pixel edge placement** slightly behind the crisp engine on smooth high-contrast boundaries (planar fits the integer crack lattice, not the AA coverage field) | nebula (gradient golden; seam metric) | last-decimal seam delta | `docs/planar-tracer.md` §3 |
| 9 | **Gradient banding** — a stack of translucent gradients traced as regions the art does not contain. *Deprioritised: off the product target* | `fluent-olive` (tier 1, gated, in `KNOWN_DEFECTS`); `black-circle` (ungated) | olive p95 97px; black-circle 31.3px invented; 10.8× invented vs flat | §8.3, §8.5 |
| 10 | **Dropped gradient boundary** — verified-visible authored edges simply lost on gradient art. *Deprioritised, distinct from banding* | `speaker-low-volume`, `chart-decreasing` (tier 1, ungated) | missed 16.9 / 15.3px — re-verified 2026-07-15 under visibility-aware scoring (§9.6): survives occlusion exclusion, so it is REAL | §8.5 |
| 11 | **Small-region drop at LOW resolution** — a 176px region @256 falls under both the share floor and the flat-interior evidence floor, so §9.4's protection cannot see it (the gate runs @512, where the same region is 4× larger and survives) | `flute` @256 (ungated resolution) | 8/9 @256: `#974827` 176px painted `#893925`, ΔE 8.0 | found during §9.7 (pre-existing — present at c3c82cb) |

Recently closed (the pattern an exit should follow): **near-colour palette cluster
fusion** (`flute`, was #5, the last tier-2 region drop) — closed 2026-07-15: k-means
separates the authored pair `#f5a165`/`#fea069` cleanly and `quantize`'s post-merge fused
the two centroids at distance 9.98 < `MERGE_DISTANCE` 10; fixed by an evidence-based merge
veto (flat-interior anchors + ΔE ≥ 4 floor), tier 2 now **437/437 regions (100.0%)** for
the first time, tier 0 and every golden byte-identical, render paints the exact authored
hex (ΔE 4.54 → 0.00) — **§9.7** is the record. **Missed boundary on flat art**
(`taco`/`mate`/`fortune-cookie`, was #1) — closed 2026-07-15 as an **answer-sheet artifact,
not a tracer defect**: the "missed" boundary is authored outline OCCLUDED by later-painted
shapes (taco 45.5% of its outline invisible), which the geometry-only GT reader counts as
scorable. Visible-only, missed 20.10 → 0.23px / 11.49 → 0.49 / 9.88 → 0.33, and the whole
tier-2 corpus is sub-pixel (mean missed 1.89 → 0.23px, max 0.63px); renders via resvg are
pixel-clean (p95 ΔE 0.00). The scorer fix (exclude invisible GT samples) SHIPPED 2026-07-15
with user sign-off; TIER_TOL[2] re-calibrated ~6–30× tighter — **§9.6** is the record.
**Thin features @512** (`hairlines`) —
chamfer 3.73 → 0.39px, p95 55.9 → 0.78px, bars recovered in the authored colours, root-caused
and measured in **§9.5** (2026-07-14); **dropped small flat regions** — 22 → 1 across tier 2,
`bloom`/`petals` 5/7 → 7/7, root-caused and measured in **§9.4** (2026-07-15); **`checker`
unscorable** — re-authored, now green (§8.2, 2026-07-15).

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

*(Superseded 2026-07-15: the conclusion held for tier 1's corpus MEAN but not per-case, and
not at all for tier 2 — the flat twins carry up to 45% hidden overdraw and the phantom
"missed boundary" defect §0 #1 was exactly this. The scorer now excludes occluded boundary
itself: geomScore.makeVisibleAt, §9.6.)*

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

**Resolved 2026-07-15, and the guess above was wrong: it was neither merging nor tracing —
the entire missed tail is authored boundary OCCLUDED by later-painted shapes, i.e. the answer
sheet, not the tracer. See §9.6.**

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

### 9.5 The fix: thin features (`hairlines`) — blend-line palette evidence + two exposed fit bugs

§0 #1, closed 2026-07-14. §9.3 had already proven every fit-stage feature a no-op on this
case ("the thin bars die at segmentation/paint"); instrumenting the flat-palette stage on
the 512px raster found **three separate mechanisms**, all in `paletteSegment.ts`'s
share-based palette cleanup — plus two fit-stage bugs the repaired segmentation then
exposed:

1. **The 50% blend-grey survives as a palette colour.** Seven parallel bars put the SAME
   exact coverage-blend value (`#88888d` — the exact sRGB midpoint of bg↔bar) on 1.5% of
   the raster, sailing over `minShare` 0.6%. The 1px/2px bars were then *assigned* to it —
   "painted blend-grey". Share cannot catch it; flat-interior evidence (§9.4) cannot
   either (it has none — but neither do the bars).
2. **The authored red is dropped and routed to that grey.** `#b4283c` (the diagonal, 620
   exact-colour pixels, 0.24% share, zero 3×3 flat interior — a 2px diagonal cannot
   contain one) failed every existing keep-test; `dropMinorColors` routed it to the
   nearest *surviving* colour — the grey (d² 17713 vs 35649 to its own bar colour). "The
   red diagonal traces grey."
3. **`modeFilter` deletes 1px features whole.** The 0.5px bar's single blend column loses
   the 3×3 majority vote (3 vs 6) at every one of its 408 pixels — the entire bar vanished
   in pass 1. Nearest surviving boundary: the next bar, 56px away = the p95 55.9.

The fix (all in the flat-palette path; MS/gradient path untouched by construction):

- **Blend-line classification** (`classifyBlends`): AA interpolates in sRGB, so a blend
  cluster sits ON the RGB segment between its two source colours (measured: ≤ 6.2 off;
  the authored red is ~100 off every line). An entry with no flat-interior evidence that
  is **edge-local** (≥ 60% of its pixels touch another class — a coverage blend is an
  edge phenomenon) and within `BLEND_LINE_EPS` 10 of a segment between two already-
  accepted entries is a blend — dissolved into its **nearer endpoint** — even when its
  share passes. An off-line entry that repeats one exact colour ≥ `minRegionArea` times
  (`modalColorCounts` — noise never repeats an exact RGB; authored thin features do) is
  kept even when its share fails. Edge-locality is load-bearing: without it, the middle
  band of a posterized ramp (collinear BY CONSTRUCTION, and wide) is dissolved —
  aurora-flat's golden caught exactly that on the first attempt.
- **Endpoint routing, not nearest-survivor routing.** Routing the grey to the globally
  nearest survivor floods 4059 pixels into the *red* entry, and the palette mode-snap
  then renames red to grey. A blend can only be a mixture of its two endpoints; it goes
  to the nearer of THEM.
- **`restoreErasedComponents`**: a ≥ `minRegionArea` connected component that
  `modeFilter` consumed WHOLE is a thin feature, not a stair-step (a 3×3 vote can shift
  a boundary ~1px; it cannot eat a 64px+ blob) — put it back verbatim, before despeckle.
- **`dominantColors` for the flat-vs-rich gate** (`index.ts`): blend dissolution shrank
  headphones' palette 16 → 11, *under* `FLAT_PALETTE_MAX_COLORS`, flipping a photo-like
  illustration from MS into palette-first (golden meanΔE 3.92 → 5.50). Continuous tone is
  full of colours that lie between other colours, so the richness gate now counts the
  survivors of share/real evidence alone — path decisions are exactly as before.
- **Ellipse snap: both Hausdorff directions** (`circleFit.ts maxEllipseToPolyDev`). With
  clean bars, the 6×408 bar-1 rectangle "fit" a 3.8 × 278 ellipse: every polygon point
  within ~1 radial unit (`maxEllipseDev` scales by r_min — a 74× underestimate along the
  long axis), while the ellipse poles overshoot the caps by 22px of EMPTY SPACE where the
  polygon has no sample to complain. The old grey rims had merely kept the bar ineligible
  for the snap. Acceptance now also samples the ellipse and measures back to the polygon
  (both engines).

Results, before → after (same protocol as §9.4):

- **`hairlines` @512 (the gate): chamfer 3.73 → 0.39px, p95 55.94 → 0.78, hausdorff
  56.61 → 2.80, missed 7.01 → 0.39.** @1024: 7.46 → 0.30 / 112.4 → 0.87. All seven bars
  survive full-height in the authored `#1a1a22` **and render** (see the amendment below —
  the first pass of this fix left two of them as pinched zero-/half-area paths that
  satisfied every gate); the diagonal traces `#b4283c`. Passes every tier-0 gate →
  deleted from `KNOWN_DEFECTS`.
- **tier 0, everything else**: `petals` improved (@512 chamfer 0.25 → 0.19), `nebula`
  improved (@512 0.24 → 0.15), `bloom` ±0.01. **`aa-seam` @512 chamfer 1.35 → 1.44
  (+0.09), p95 unchanged 24.77** — the sliver's blend entries now dissolve label-level to
  ONE side; already in `KNOWN_DEFECTS`, still the same defect (§0 #3). Region recovery
  unchanged everywhere. Node counts drift slightly (petals @512 64 → 76, ratio 1.0 → 1.2×,
  within the 3× gate).
- **tier 2 (106 flat twins)**: a wash, as it should be — chamfer p50 0.37 → 0.36, missed
  p90 5.43 → 5.50 / 1px-candidates 59 → 61, spurious max 0.46 → 0.49, parsimony max
  4.29 → 4.23; regions 105/106 unchanged (`flute` ΔE 4.5 remains, §0 #5); taco/mate/
  fortune-cookie unchanged (§0 #1 is a different defect). One case drifted across the
  informal 1px-chamfer mark (73 → 72 "would pass" — p75 sits at 1.30).
- **tier 1: untouched by construction.** Golden gate green **without re-blessing**
  (aurora-flat byte-identical after the edge-locality gate; headphones path-flip fixed by
  `dominantColors`); full suite 267/0/2. Headphones timing within run-to-run noise
  (2.2–2.6s both before and after, both configs, same loader).

Still open, honestly: **@256 the case still fails ungated** (chamfer 2.61, p95 28.81 —
there the bars are 0.25–3px and the thinnest leaves no evidence at all; now §0 #6); bar
end-caps show ~1px rounding at 1×; and a fully sub-pixel feature with NO pure-colour
pixel anywhere (e.g. a long 0.5px diagonal) would still trace in its strongest blend
shade rather than the authored colour — no case in the corpus isolates that yet.

**Amendment (same day, caught by the USER's eyes, not by any gate):** bar 7 was in the
traced doc but as a **degenerate 2-node loop** — both walls of the 1px-wide region fitted
onto the same vertical line (zero area → renders as NOTHING) — and bar 6 (2px) was a
**3-node triangle** pinched to a point at its bottom end (lost the lower ~150 rows of its
render; a one-end pinch of a rectangle keeps exactly 50% of the area). Mechanism, both: a
thin cap's two shoulder corners are 1–2px apart, `detectLoopCorners` fuses them to one
apex (its 5px merge is meant for redundant detections of ONE true corner), the wall-arcs
pin to the same apex point, and every boundary sample sits within ε of the pinched shape —
a fit "within tolerance" everywhere while destroying the region's width. **The truth gate
PASSED throughout**: chamfer/p95 measure distance to the traced *path*, which stayed
0.1–0.6px from both authored edges; region recovery cannot see it either (a 1–2px blend
bar has no 3×3 flat interior, so it is not a counted "true region"). A zero-area or
pinched path is a boundary-metric blind spot — renders are part of the exit protocol for
exactly this reason. FIX: an **area guard** on closed-edge fits in `planarAssemble` — if
the fitted loop keeps < 75% of the raw crack-loop's area (raw ≥ 4px²), the fit is replaced
by the exact staircase corners (direction-change points of the crack ring; an axis-aligned
bar = its 4 corners). For anything thin enough to trip it, exact beats smooth outright; a
real fit of a normal blob drifts area by a small fraction of ε·perimeter, nowhere near 25%
— tier 2 and every golden measured byte-identical under the guard. Verified at the PIXEL
level this time: all seven bars rasterize from the SERIALIZED SVG via resvg (not just
`rasterizeDoc`); bar 6's rendered rows exactly match its label map (only the 4
modeFilter-eroded end rows missing, ~1%); hairlines @512 essentially unchanged (0.39 / 0.78 — the
metric never saw the difference, which is the point).

### 9.6 Not a fix but a verdict: the tier-2 "missed boundary" was OCCLUDED authored outline — §0 #1 closes as an answer-sheet artifact

§0 #1 (`taco` missed 20.1px / `mate` 11.7 / `fortune-cookie` 9.9 @512), investigated
2026-07-15. **No tracer change came out of this section, and none is warranted: the tracer
was never missing anything.** The chain of evidence, in the order it was found:

1. **Locate first** (the §9.5 recipe): dump `scoreGeometry`'s worst missed samples
   (`probeMissed.ts`) and look at the pixels. Every hot blob sits in the INTERIOR of a
   solid region — taco's worst sample (306, 352) is 128px from any traced boundary, and
   the source pixel, the traced pixel, and every pixel ±2px around them are the same
   `#f9c23c`. There is no edge in the raster there. The "missed" boundary is authored
   outline that the composited render never shows: taco's orange back shell (`#FFB02E`)
   is a full closed path drawn almost entirely BEHIND the yellow front shell, the brown
   filling's dome is behind the front shell and the left tomato, and so on.
   `parseGroundTruth` reads geometry only — by design it "never reimplements painter's-
   algorithm occlusion" (svgGround.ts) — so every authored outline becomes GT boundary,
   visible or not. A tracer cannot recover an edge that made no pixels.

2. **Quantify** (`probeOcclusion.ts` — §8.4's audit, which had only ever run on tier 1,
   rebuilt for tier 2): a GT sample is *invisible* when the truth raster reads the same
   colour at ±2px along the boundary normal AND at the sample itself (the centre-pixel
   term keeps features thinner than 4px classified visible). The probe reproduces
   `scoreGeometry`'s all-sample `missedMean` exactly on all 106 cases, then re-scores on
   visible samples only:

   | case | invisible boundary | missed all → visible | chamfer | p95 |
   |---|---:|---:|---:|---:|
   | taco | **45.5%** | 20.10 → **0.23** | 10.17 → 0.23 | 88.06 → 0.76 |
   | mate | 21.9% | 11.49 → **0.49** | 5.83 → 0.33 | 84.65 → 2.47 |
   | fortune-cookie | 20.6% | 9.88 → **0.33** | 5.07 → 0.30 | 80.16 → 0.59 |

   Corpus-wide (106 flat twins @512): **8.7% of tier-2 authored boundary is invisible**
   (tier 1 measured 1.9% — the Flat style is simply authored with more overdraw: stacked
   full shapes for flag stripes put rainbow-flag at 37%, transgender-flag at 35%, lotus
   36%, teapot 30%). Visible-only, the whole corpus is sub-pixel: missed p50/p90/max
   0.52/5.50/20.10 → **0.22/0.34/0.63**, chamfer max 10.17 → **0.48**, p95 max 88.06 →
   **2.47**. The worst visible-only case is violin at 0.63px missed. **There is no
   missed-boundary defect on flat art.** The §9.2 "one-way error" observation (spurious
   p95 0.33px while missed p90 5.43px) was the artifact's signature all along: occlusion
   can only ever inflate the GT→trace direction.

3. **Falsify** (the audit must not dissolve real defects): run on tier 0,
   `gradient-flat` (6.31 → 6.31), `hairlines` (0.39 → 0.39), `bloom`/`petals`/`nebula`
   (0% invisible, unchanged) all keep their numbers — the audit is not a blanket eraser.
   But two gated KNOWN_DEFECTS numbers are themselves contaminated:
   - **`cross-bars`**: the red bar's edges pass UNDER the blue bar (6.2% invisible, up to
     ~22px deep). Visible-only: chamfer 1.04 → **0.34**, p95 9.58 → **0.54** — under
     tier-0 limits. The junction weld is still real and visible at 1× (like §0 #7's
     scalloping) but it is a sub-tolerance defect; its headline number was mostly the
     occluded under-bar.
   - **`aa-seam`**: the orange/teal seam passes UNDER the purple circle (r=23; 12.1%
     invisible, deepest occluded point ≈ 23px from the circle rim — exactly the reported
     p95 24.77). Visible-only: chamfer 1.44 → **0.22**, p95 24.77 → **0.74**. The
     blend-sliver side-assignment (§9.5) is real but sub-pixel in geometric terms.

4. **Render-verify** (the §9.5-amendment protocol — serialized SVG through resvg, not
   `rasterizeDoc`, `probeRenderCheck.ts`): taco meanΔE 0.19 / p95ΔE 0.00 / SSIM 0.9935;
   mate 0.09 / 0.00 / 0.9969; fortune-cookie 0.10 / 0.00 / 0.9963 against the truth
   raster; every located hot-spot pixel matches the source exactly; truth|trace
   side-by-sides are visually indistinguishable. A 10–20px genuinely-missing edge cannot
   hide under a p95ΔE of 0.00.

**What was NOT done, deliberately.** The fix belongs in the ANSWER SHEET — exclude
invisible GT samples from the missed side (the target segments, node counts and lengths
stay whole, so parsimony is untouched). That is a change to `geomScore.ts`, which was
explicitly fenced off for this session, and it re-defines the metric for every consumer —
so it is a decision, not a patch: it would tighten the honest tier-2 calibration
massively (visible-only corpus max chamfer 0.48 vs the current TIER_TOL[2] of 3.0), and
`cross-bars` + `aa-seam` would start PASSING tier-0 gates, forcing their KNOWN_DEFECTS
deletions with their real-but-small residuals re-filed as sub-tolerance defects like
§0 #7. Pending that decision, the scorer, the tolerances, KNOWN_DEFECTS and the tracer
are all byte-identical to a218d31; the probes (`probeMissed.ts`, `probeOcclusion.ts`,
`probeRenderCheck.ts`) stay in `src/devtest/` as the measurement record.

One implication worth carrying forward: §0 #10's tier-1 numbers (`speaker-low-volume`
~17px missed) rest on §8.4's CORPUS-MEAN 1.9% — which does not rule out per-case
occlusion outliers (the same glyph's FLAT twin is 19.8% occluded and drops to 0.26px
visible-only). Re-run `probeOcclusion.ts` per-case on tier 1 before spending tracer work
on #10.

**Amendment (same day): Option A shipped with user sign-off** — after a visual walkthrough
(truth|trace side-by-sides, the missed heat drawn on the pixels, the authored layers pulled
apart, visible-vs-hidden classification) the user chose "count only the edges you can see".
What landed:

- **`geomScore.ts scoreGeometry` now requires the truth raster** and drops GT *query*
  samples that are invisible in it (`makeVisibleAt`: same colour at ±2px along the boundary
  normal AND at the point itself; off-canvas probes count visible). Only the missed-side
  queries are filtered — target segments, node counts and boundary lengths stay whole, so
  the spurious side and parsimony are untouched *by construction* (verified: tier-2 spurious
  0.21px, parsimony max 4.23×, regions 105/106 — all byte-identical before/after). The
  probes' audit logic moved INTO the scorer; the four temporary probe scripts were deleted.
- **Tier 2 re-calibrated** (same recipe: boundary just above corpus p90, parsimony just
  above max): `TIER_TOL[2]` chamfer 3.0 → **0.35** (p90 0.31, max 0.48 violin), p95 35 →
  **1.2** (p90 1.02, max 2.47 mate), parsimony 4.5 unchanged. The tier-2 corpus now sits
  entirely inside tier 0's own limits — the flat gate finally measures the tracer, not the
  answer sheet's overdraw.
- **Tier 0**: `cross-bars` (0.34/0.54) and `aa-seam` (0.22/0.74) pass every gate → deleted
  from `KNOWN_DEFECTS`; their real, visible-at-1× residues stay tracked as §0 #2/#3
  (sub-tolerance, like #7). `gradient-flat` unchanged (p95 6.31 — still a real defect,
  still listed). `hairlines` @512 unchanged (0.39/0.78); @256 the ungated defect §0 #6
  shrinks 2.44/27.81 → 0.88/9.77 (bar-crossing occlusion was inflating it) but remains
  real. Every other tier-0 number is byte-identical.
- **Tier 1** (full 109-case calibration): chamfer p50 1.87 → 1.35 / p90 5.65 → 4.51 —
  the modest shift §8.4's 1.9% predicted; `TIER_TOL[1]` limits deliberately unchanged.
  `fluent-olive` still fails (6.73/97.2) — the banding defect is real and stays in
  `KNOWN_DEFECTS`. And the §0 #10 caution above is now RESOLVED: `speaker-low-volume`
  still misses **16.9px** and `chart-increasing`/`chart-decreasing` **15.3px** *after*
  occlusion exclusion — those edges are genuinely visible and genuinely lost; #10 is a
  real tracer defect, correctly deprioritised as gradient-only.
- **Suite**: typecheck clean, 267 pass / 0 fail / 2 skipped, unchanged. The tracer itself
  is untouched — renders are the ones verified above (p95 ΔE 0.00 through resvg).

### 9.7 The fix: evidence-based merge veto in `quantize` — the last tier-2 region drop (§0 #5) closes, tier 2 reaches 100.0%

§0 #5, closed 2026-07-15. `flute`'s `#f5a165` (3,148 exact px, 2,796 flat-interior) was
painted `#fea069` (ΔE 4.5) — the only region drop left in the 106-case tier-2 corpus after
§9.4. The §0 entry blamed `quantize`'s `MERGE_DISTANCE`; instrumenting the merge confirmed
it **and pinned the exact event**: k-means separates the pair cleanly (centroid[2]
rgb(254,160,105) n=20,695 vs centroid[11] rgb(245,161,101) n=3,271 — both authored hexes,
verbatim), then the post-merge fuses them at centroid distance **9.98 < 10** into
`#fda069`, a colour the art does not contain. The warning on the §0 entry ("do NOT just
widen/lower MERGE_DISTANCE") was right: the merge exists to re-fuse k-means centroids that
split ONE colour's pixel cloud, and the fix has to tell that apart from two authored
colours that happen to sit 9.9 apart.

**The separating evidence is §9.4's flat-interior criterion, applied per cluster.** Every
distinct colour maps to exactly one cluster, so a split pixel cloud carries its
8-neighbour-exact block in ONE of the halves — while two authored colours each anchor
their own cluster with such a block. `quantize` now takes `keepDistinctMinArea` (the flat
path passes `minRegionArea`, the same floor §9.4 protects real regions with): each
cluster's **anchor** is its highest-flat-interior exact colour at ≥ that many px, and two
clusters with different anchors refuse to fuse. Zero disables — and the flat-palette path
is the only quantize caller, so the MS/gradient path is untouched by construction.

**Two measured counter-examples shaped the veto** (both would have shipped as regressions
had the first version landed):

1. **Anchors alone are not enough — schild.** The paper-white background of a real
   exported logo carries large exact-colour runs of *neighbouring tonal values*
   (`#f4f3f1` vs `#f5f4f2`, ΔE ≈ 0.5, thousands of flat-interior px EACH). The naive veto
   split them and speckled the background: golden `schild-flat` **180 → 546 nodes**. Tonal
   noise has flat-interior evidence; what it does not have is perceptual distance.
2. **A JND floor (ΔE ≥ 2) is still not enough — aurora.** A smooth ramp traced flat
   posterizes into wide, flat, genuinely-anchored bands ~ΔE 2.9 apart. Vetoing their
   merges left 2 extra palette entries, pushed `dominantColors` past
   `FLAT_PALETTE_MAX_COLORS`, and **flipped the whole image out of palette-first into MS**
   — visibly coarser banding (render meanΔE 2.11 → 3.58 on the A/B snapshot input). The
   flip risk is structural: the veto can only ever grow the palette, so any borderline
   rich-flat image sits one veto away from the path gate.

The landed floor is **`ANCHOR_DISTINCT_DE = 4.0` — `scoreRegions`' own `MATCH_DELTA_E`**:
a region painted within ΔE 4 of its truth counts as recovered, so a fusion below 4 is
invisible to the region gate (and, per §9.4, near-invisible to eyes); above it the fusion
is a scored drop. The veto defends exactly the fusions that would be scored. flute's pair
(ΔE 4.54) stays protected; aurora (2.9) and schild (0.5) merge exactly as before. The
honest dead zone: an authored pair in [JND, 4) still fuses — no corpus case sits there,
and if one ever does, the scorer cannot see it either; the render is within the product's
own colour tolerance.

Results, before → after (protocol as §9.4/§9.5):

- **tier 2: 436/437 → 437/437 regions (99.8 → 100.0%), 105 → 106 of 106 cases clean** —
  the corpus's region gate is fully green for the first time. Every boundary
  distribution number (chamfer/p95/parsimony/missed/spurious, p10 through max) is
  **identical to the last digit** — the veto touched nothing else.
- **tier 0: byte-identical** (full three-resolution table diff, all 16 cases — the veto
  never fires there).
- **goldens: byte-identical** — 0.00% of pixels assigned a different colour on
  schild-flat / headphones-flat / bloom-flat / aurora-flat (probe over quantize output;
  fingerprints show only the pre-existing §9.4/§9.5-era drift that was never re-blessed —
  hash pairs identical with the fix stashed).
- **flute across resolutions**: @512 8/9 → **9/9**, @1024 9/10 → **10/10**, @256 7/9 →
  **8/9** (the `#f5a165` drop is gone everywhere; the remaining @256 drop is a different,
  pre-existing defect — `#974827` 176px painted ΔE 8.0, now §0 #11: at 256² the region is
  under both the share floor and the flat-interior floor, so §9.4's protection cannot
  see it).
- **render, from the SERIALIZED SVG through resvg** (§9.5-amendment rule): the region's
  own 3,148 px paint the exact authored hex — ΔE 4.54 → **0.00**, exact-hit 98.8%
  (the rest is the AA rim); whole-image meanΔE 0.192 → 0.159, p95ΔE 0.00 both sides.
- **determinism**: two traces serialize byte-identical. **perf**: headphones-flat @1024
  1.58–1.72s vs 1.55–1.74s baseline (the flat census is one O(8n) pass, armed only in
  the flat-palette path). **suite**: typecheck clean, 267 / 0 / 2 — no KNOWN_DEFECTS
  change (flute is tier 2, ungated).
