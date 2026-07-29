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
| 3 | **AA diagonal sliver** — blend band assigned to one side; visible at 1×, sub-tolerance since the scorer counts visible boundary only | `aa-seam` (tier 0, gated, **passes**) | chamfer 0.12px, p95 0.43px (was 0.22/0.74; §12's classify fixpoint routes the sliver's mid-blends to better endpoints — earlier 1.44/24.8 was the seam occluded under the circle, §9.6) | §7; §12 |
| 8 | **Sub-pixel edge placement** slightly behind the crisp engine on smooth high-contrast boundaries (planar fits the integer crack lattice, not the AA coverage field) | nebula (gradient golden; seam metric) | last-decimal seam delta | `docs/planar-tracer.md` §3 |
| 9 | **Gradient banding** — a stack of translucent gradients traced as regions the art does not contain. *Deprioritised: off the product target* | `fluent-olive` (tier 1, gated, in `KNOWN_DEFECTS`); `black-circle` (ungated) | olive p95 97px; black-circle 31.3px invented; 10.8× invented vs flat | §8.3, §8.5 |
| 10 | **Dropped gradient boundary** — verified-visible authored edges simply lost on gradient art. *Deprioritised, distinct from banding* | `speaker-low-volume`, `chart-decreasing` (tier 1, ungated) | missed 16.9 / 15.3px — re-verified 2026-07-15 under visibility-aware scoring (§9.6): survives occlusion exclusion, so it is REAL | §8.5 |
| 14 | **Small region collapses to a sliver @512** — the doc item EXISTS but its geometry pinches to ~77px² for a 691px label, so the region paints white; a §10.4 REGRESSION (bisect: green at e549b29, red at fc7b7e9 — reseat/chord territory, NOT the weld deletion §12 fixed), unnoticed for five commits because tier 2 is ungated @512 | `fluent-beverage-box-flat` @512 (ungated resolution for tier 2; the case IS gated @256, where it passes) | 6/7 @512: `#990838` (522px) painted `#ffffff`, ΔE 88.6; render shows 88px of the colour | found during §12.4 (2026-07-29); §9.7's "437/437" figure predates it |

Recently closed (the pattern an exit should follow): **the LOW-RESOLUTION
scale-blindness family** (`hairlines` @256, was #6; `flute` @256, was #11 — plus two
UNDISCOVERED members the new lane's calibration sweep caught: `parachute` 9/10 and
`beverage-box` 6/7 @256) — closed 2026-07-29, **§12** is the record. Phase 0 first:
nothing below 512 was gated, so the family had no red number to beat — the @256 lane
(`LOWRES_CORPUS`/`LOWRES_TOL` in truthCorpus.ts, `truth @256:` tests, tolerances
calibrated at 256 the §9.6/§10.3 way) and the per-stage instrument
(`src/devtest/lowresDiag.ts`) landed before any fix. The measured histogram then
FALSIFIED the written hypothesis — the absolute share/area floors were the proximate
killer for NONE of the four drivers. Four mechanisms, four fixes: (a) k-means starves
a small colour cloud of a centroid at 256², so two authored colours share ONE cluster
and §9.7's anchor veto has no merge event to refuse → the anchor-guided cluster SPLIT
in `quantize` (same evidence, same thresholds — flute 8/9 → **9/9**, parachute 9/10 →
**10/10**); (b) `classifyBlends`' greedy count-descending order INVERTS at low res
(the bars' blend cluster outweighs the pure bar colour) → fixpoint iteration + route
path-compression, plus a mode-snap census exclusion so a routed-in blend cannot
rename its endpoint's hex; (c) a thin 45° stroke is 4-DISCONNECTED by construction →
the modeFilter rescue is now 8-connected + erosion-aware (`RESTORE_MAX_SURVIVAL`)
with a pinch-fill (hairlines 0.93/9.69 → **0.31/0.74**, parsimony 1.3); (d) the §10.4
converged-junction weld deleted a LOLLIPOP region whole (beverage-box's straw: 129px
outline sharing its fused vertex pair with the 2.8px neck) → cluster-fuse veto in
`weldJunctionClusters` (6/7 → **7/7**; the same veto recovered the straw @512, where
§10.4 had silently broken it — §12.4, whose bisect also surfaced §0 #14). A/B corpus
0/42 variant files changed; @512 stable except aa-seam IMPROVING to 0.12/0.43; all
four `KNOWN_DEFECTS_LOWRES` entries deleted by the CI contract.
**bar-end caps render pointed /
domed, not square** (`hairlines` @512 bar ends, was #6b, user-reported 2026-07-20) —
closed 2026-07-28, **§10.7** is the record: the row's stored anatomy was STALE on both
halves (§10.6's short-arm bypass had already fixed the ≥7px caps the row described, and
the "one fused cluster" mechanism is only one of three failure families), so the driver
case was authored where the loss actually measures TODAY — `bar-caps`, 7px-wide bars
(the `CORNER_MIN_EDGE` grading floor itself) at the AA phases a real-pipeline sweep
showed losing: 30/43 = 69.8% corner recall, red, gear-teeth §10.5 pattern. The measured
root: inside a cap narrower than ~2·`CORNER_WINDOW` the ±4px turn test reads a MIXTURE
of both shoulders at every cap vertex, so apex count and placement are phase lottery
(1 apex → far corner bevels; 3 → every node blunt at 38–52°; 2 misplaced → tangent
wobble reads 45° at a true corner). The cap resolver (`resolveLoopCaps`) re-reads each
apex group with arm-anchored evidence and, when the group is a flat ~180° U-turn between
two long straight arms, emits exactly TWO corners snapped to arm∩cap-line and pins the
cap as a straight line: **43/43 (100%)**, chamfer 0.22 → 0.14, controls and the whole
corner watchlist (gear-teeth 51/60, sharp-star 11/11, cross-bars 10/10, checker 99.1%)
byte-stable. **soft-alpha feather survives as a
translucent sliver layer** (`100 years tour.png`, was #13, user-reported, HIGH product
relevance — soft-alpha is the default AI-generator export) — closed 2026-07-28, **§11**
is the record: the feather is a blend whose second endpoint is TRANSPARENCY, invisible
to the pairwise RGB segment model; the candidate fix's "RGB explainable as parent×t"
clause was KILLED by measurement (the 3-way mix extrapolates 18.8–101 RGB off the
parent — that unexplainability is the defect's own mechanism), and the shipped gate is
pure alpha-distribution evidence: `classifyBlends` gained a feather endpoint
(`αmode < 255 && αstd ≥ 10 && αmodeShare ≤ 0.15`, margins ≥ 1.5× both sides against
authored translucent flats and healthy AA fringes) routing the shells into the nearest
ACCEPTED colour by RGB — measured 100% unanimous with per-pixel routing. Repro traces
2 items / 230 nodes (the sliver layer was 66 subpaths / 264 nodes @2048; the
user-approved delete-the-swatch workaround measured 242) — the fix beats the manual
workaround. Categorically inert on opaque art (A/B corpus 0/42 files changed,
suite green); `test/palette-feather.test.ts` pins the discrimination both ways.
**Scale-blind corner detection /
snap melts well-resolved small sharp features** (`gear-teeth`, was #12 — §10's driver
case, authored deliberately red) — closed 2026-07-28, **§10.6** is the record: the
measured histogram FALSIFIED the §10.5 window/apex-merge hypothesis (fusion losses: 0;
ε-melts of a detected corner: 0) and located the loss in (a) the detector's 70° turn
threshold sitting above the 60° the scorer and planarBeautify both define as sharp —
the gear's 67.3° roots were structurally invisible — and (b) the corner snap's fixed
3px arm gap + unconditional arm-intersection reconstruction misplacing short-armed
corners whose raw lattice apex was already sub-px correct. One definition of sharp
(60°) + a scale-aware snap (armGap, short-arm bypass, displacement cap, arc-scaled
presmooth, `CORNER_MERGE` 3): corners **21/60 → 51/60 (85%)**, chamfer 0.22 → 0.18,
p95 0.78 → 0.50, entry deleted from `KNOWN_DEFECTS` by the CI contract. The same
change closed **#2b (notch chamfer)** — `sharp-star` corner recall 9/11 → **11/11**,
the two 80° notches now single sharp corners (their window-diluted 60–70° readings
clear the aligned threshold) — and lifted `cross-bars` 8/10 → **10/10**.
**Slid junction at a near-tangent crossing** (user-reported: gradient-flat's straight hypotenuse "pulled into the circle"
where it crosses the disc — an all-gates-green, sub-tolerance defect visible at 5×) —
closed 2026-07-21, **§10.4** is the record: the label-map junction slides up to 8.4px
along the shared tangent (the colour needle there is quantization-invisible), and the
junction re-seat pass (`planarReseat.ts`) moves it back to the intersection of the
incident FITTED primitives; gradient-flat p95 0.72 → 0.63, parsimony 1.62 → 1.48,
hairlines also improves. **Step-3c step-fit merge / gradient
corner sliver joins a flat class** (user-reported: nebula.png + gradient-flat corners
painted flat mid-gradient) + **no corner snap on OPEN edges** (gradient-flat's triangle
apex asymmetric, §10.2 follow-up (a)) — both closed 2026-07-21, **§10.3** is the record.
They compounded on `gradient-flat`: p95 **6.31 → 0.72px** (was §0 #4, "edge pull on flats
bordering a gradient bg" — the pull WAS the two of them), chamfer 0.81 → 0.23, corners
6/6, entry deleted from `KNOWN_DEFECTS`. The same open-edge snap closed **#2 junction
weld's measured face**: `cross-bars` corner recall 4/10 → **8/10 = 80%, the gate passes**,
entry deleted (chamfer/p95 unchanged 0.34/0.54 — the sub-tolerance wedge pull at 1× stays
watched in AbLab, but it no longer has a failing number, so per this list's rules it has
no row). **beveled star tips / heal-pinch
loop split** (`sharp-star`) — closed 2026-07-20: every tip traced as a flat 2-node cap 4px
short of the apex because `healColorSpikes`' 8-connected reassignment created 1px diagonal
pinches that junction-split the outline into OPEN edges (which get no corner snap); fixed
by restricting heal targets to 4-connected neighbours. Apex now 0.93px from authored; on
`headphones-flat` the same fix halves nodes (9632 → 5220) and junction clusters (282 → 121)
at identical meanΔE/SSIM — the old heal was manufacturing thousands of pinch junctions
there. Shipped with the corner gate made applicable (CORNER_MIN_COUNT 12 → 10) and the
tangent-based corner reading — **§10.2** is the record; the residue is #2b above.
**Near-colour palette cluster
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
unscorable** — re-authored, now green (§8.2, 2026-07-15). **Checkerboard corner scalloping**
(`checker`, was #7) — closed 2026-07-18: NOT the mode filter or the tracer (both emit exact
8px squares); `planarBeautify`'s circle/ellipse snap rounded each cell to a blob because
radial-deviation acceptance is size-relative (an 8px square sits < 1px from its best-fit
circle). Fixed by a corner-turn veto on the snaps (a loop that turns a sharp corner is a
polygon, not a disc). chamfer 0.38 → **0.000**, p95 1.74 → **0.000**, corner recall 41.9 →
**97.2%** — **§9.8** is the record, and it shipped with a NEW distance-blind gate (below).

Feature verdicts (not defects): the experimental A/B flags (`refineJunctions`,
`backgroundGradient`) measured **non-mergeable as defaults** — §9.3. The plan is to expose
them as opt-in feature flags in the /vectorize studio instead. (`weldJunctions` was in this
list until 2026-07-21: re-measured against the §10.4 tracer it newly crossed two tier-2
gates and degraded its own target cases, so the flag was REMOVED — §10.4; its machinery
survives as the evidence-gated converged-pair weld's engine.)

Open research direction: the fit/snap tolerances are ABSOLUTE px and therefore
scale-blind — the root shape of the §9.8 checker bug. A scale-relative ε keyed to local feature
size (medial radius) is written up in **§10**; the SNAP half is now a measured prototype
(`PlanarFitOptions.localScaleK`, default OFF) — it SUBSUMES the §9.8 corner-turn veto (checker
corner recall 97.2% with the veto off, k ∈ [0.10, 0.20]) and regresses no round case, but is
byte-identical to the shipped veto on today's corpus, so it stays off pending a case that
distinguishes them (**§10.1**). The driver case for the fit half (`gear-teeth`, was #12,
§10.5) closed 2026-07-28 WITHOUT a scale-aware fit ε: the measured loss was in the corner
DETECTOR's threshold and the SNAP's fixed gaps, both now scale-aware/aligned (§10.6). The
literal fit-ε idea (openRDP / cubic-discard at `min(ε_abs, k·medial)`) remains unbuilt —
no gated case currently demands it (gear-teeth's remaining 9 lost corners are detection
tail + fit-tangent noise, not ε-melt; §10.6's histogram measured ε-melts at ZERO).

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
One honest nuance the numbers under-sold, now CLOSED (2026-07-18, §9.8): in the FINE quadrant
the cells came out rounded into scalloped blobs — every deviation was sub-2px (hence the green
p95) but the texture visibly differed at 1×. It was NOT a corner-weld and NOT the mode filter:
`tracePlanar` emits exact 8px squares, but `planarBeautify`'s circle/ellipse snap then rounded
each cell (radial-deviation acceptance is size-relative — an 8px square is < 1px from its
best-fit circle). Fixed by a corner-turn veto on the snaps; chamfer 0.38 → 0.000, p95 1.74 →
0.000. The tell that no existing gate caught it — a shape wrecked while every distance stayed
sub-pixel — is exactly why §9.8 also added the **corner-recovery gate**.

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

*(2026-07-21: `weld3` re-measured against the §10.4 tracer and REMOVED — the flag, its
AbLab/Profiler variants and the assemble-time call are gone; `planarWeld.ts` survives as
the §10.4 converged-pair weld's contraction engine. See the §10.4 removal note: it newly
crossed two tier-2 gates and degraded bloom/overlap, its own target cases, by preempting
the re-seat.)*

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

*(Follow-up 2026-07-29: the 437/437 figure ROTTED unnoticed — §10.4 (fc7b7e9,
2026-07-21) dropped beverage-box @512 to 5/7, and nobody re-ran this sweep because
tier 2 is ungated in CI. §12.4 recovered the straw (weld lollipop veto → 6/7); the
remaining drop is §0 #14. Current @512 figure: 436/437.)*

---

### 9.8 The fix: corner-turn veto in `planarBeautify` — `checker` scalloping (§0 #7) closes, and the gate that had to exist to prove it

The oldest "sub-tolerance but visibly wrong" entry, closed 2026-07-18 — but the interesting
part is that finding it meant discarding two wrong root causes in a row, each of which a
plausible reading of §8.2 ("corner-welded", "high-frequency aliasing") would lead you to.

**Root cause, third guess and correct.** The chain is segment → `tracePlanar` → `planarBeautify`.
- The label map is a clean checkerboard: `modeFilter` (the 3×3 majority pass) changes **0**
  pixels on a perfect 8px checkerboard, and only 32 at the coarse↔fine SEAM on the real one
  (a minor, separate thing). Not the cause.
- `tracePlanar` emits **exact 8×8 squares**: 4 `corner` nodes, no handles, bbox 8.0×8.0.
  Verified by dumping the fitted geometry. Not the cause either.
- `planarBeautify` then **rounds every cell to a blob.** Its disc snap (1a) and co-circular
  loop snap (1d) accept a circle/ellipse on max RADIAL deviation alone — a purely
  size-relative test. An 8px square is < 1px from its best-fit circle (dev ≈ 0.83px < the
  1.5px fidelity), so each cell is "close enough" and gets re-emitted as arcs: bbox
  8.0×8.0 → 9.5×8.0, 4 straight edges → 4 arcs. The rendered fine quadrant is a field of
  beige eggs in concave cushions — precisely the reported picture.

**The fix (`src/lib/trace/planarBeautify.ts`).** Radial deviation cannot tell a small square
from a small circle; TURNING can — a circle's 4-node kappa fit bends ~5.6° per flatten step,
a polygon spikes 90° at each corner. So both snaps gain a `CORNER_TURN` (60°) veto: a loop
that turns a sharp corner is a polygon, not a disc/ring, and is never rounded. Genuine round
art (nebula/annulus/concentric, the ring co-circular arcs) turns far below 60° and is
untouched — golden and full suite byte-identical.

**Measured (`checker` @512):** chamfer 0.379 → **0.000**, p95 1.738 → **0.000**, hausdorff
2.08 → 0.50, parsimony 1.02 → 1.05. The trace is now pixel-exact.

**The gate that had to exist.** Every prior gate PASSED the rounded output — chamfer 0.38 and
p95 1.74 are under tier 0's 1.0 / 2.5, region recovery is 2/2 (colour + topology intact), and
the blobs don't weld (diagonal cells stay ~1.8px apart), so no component metric catches it
either. A shape wrecked while every distance stayed sub-pixel is the exact blind spot §1
warns about, one dimension over. So the fix ships with a new **corner-recovery gate**
(`geomScore.scoreGeometry` → `evaluateTruthGates`): of the VISIBLE authored HARD corners (a
polygonal vertex, ≥60° turn between two STRAIGHT edges — occluded ones excluded via
`makeVisibleAt`, §9.6), what fraction does the trace reproduce as a hard corner within 2.5px.
Rounding a corner replaces its straight edges with arcs, so the node stops being hard and the
recall drops. Flat-art only (like region recovery); applicable only with ≥ 12 gradeable
corners, and a corner is gradeable only when BOTH its authored edges are ≥ 7px — so a
sub-pixel sliver's cap is exempt (this is what keeps `hairlines`, whose 0.5–6px bars the fit
legitimately curves, from tripping it — that is chamfer/p95's job, §9.5). Floor: 80% recall.
- `checker` rounded: **41.9%** (1504 / 3588) → **FAIL**. `checker` fixed: **97.2%** (3488 /
  3588) → PASS. The gate has teeth and the fix clears it with margin.
- No other gated case regresses: tier-0 flats pass, `hairlines` reports n/a (8 gradeable
  corners < 12), gradient tier-1 is n/a (not flat art).
- **suite**: typecheck clean, **267 / 0 / 2**; golden regression byte-identical (the veto
  fires only where a snap would have rounded a corner — nothing else in the corpus does).
  `checker` was never in `KNOWN_DEFECTS` and still is not: it passes, now honestly.

---

## 10. Scale-relative fit tolerance — prototype landed 2026-07-19 (§10.1)

**The observation.** The tracer's fit/beautify tolerances are ABSOLUTE pixels — the curve fit
runs at ε ≈ 1.0px, the circle/ellipse/line snaps accept within `fidelity` ≈ 1.5px. That is
scale-BLIND, and §9.8 is the proof it bites: an 8px checker cell sits 0.83px from its best-fit
circle, so `0.83 < 1.5` and the snap "rounded" it into a blob. The same 1.5px that is generous
on a 400px shape is loose enough to destroy an 8px one. A single absolute number cannot be
right at both scales.

**The idea (as raised).** Make the tolerance track LOCAL DETAIL: aggressive simplification
where the art is sparse/large, conservative where it is dense/small — a "heatmap" of local
node/feature density modulating how hard the fitter is allowed to push. Where features are
tiny (a checker's fine quadrant, fine text, a busy junction), tighten ε so nothing is
over-smoothed; on a big empty expanse, loosen it and spend fewer nodes.

**Refinement — the variable is SCALE, not density per se.** Density is a good proxy (dense ⇒
small features nearby), but two traps make raw node density the wrong primitive:
1. *Chicken-and-egg:* node density is an OUTPUT of the fit, so it cannot cleanly be an INPUT to
   it. Measure the driver from the SOURCE instead — the raw crack-polygon's local turning, or a
   multi-scale edge/corner response on the raster, computed before fitting.
2. *A lone small icon on a big canvas* is low global density yet still wants preservation.
   What you actually want is LOCAL FEATURE SIZE — how big is the thing this boundary bounds —
   which the planar tracer can get cheaply as the **medial radius** (distance to the nearest
   opposite boundary) or the region area.

So the concrete form is `ε_local = min(ε_abs, k · localScale)`. For the checker cell,
`localScale ≈ 8px` ⇒ `k·8 ≈ 0.8px`, which tightens ε below the square's 0.83px circle
deviation and the snap never fires — automatically, with no special-case.

**Precedent.** This is curvature-adaptive / scale-space simplification (mesh decimation with
curvature-weighted quadric error; scale-adaptive Douglas–Peucker). Not novel; the novelty here
would be wiring it to the medial radius the planar graph already exposes.

**Relationship to what shipped.** §9.8's corner-turn veto is a cheap SPECIAL CASE of this
("never round a polygon"). A full scale-relative ε would subsume it, plus catch the milder
size-blind cases the veto does not (a small blob rounded *without* a sharp corner). It is
strictly more work and more calibration risk, which is why the veto shipped first.

**Why it is now measurable.** Before the corner-recovery gate (§9.8) there was no automated way
to tell "helpfully simplified" from "destroyed the shape" — both stayed sub-pixel on chamfer.
Now the truth corpus + the corner gate can score a scale-relative-ε prototype and say whether it
improves small-feature fidelity without regressing the smooth cases. That is the prerequisite
this idea was waiting on; **§10.1 is that prototype, built and measured 2026-07-19.**

**Where the knobs live today:** `keyEpsilon`/`fidelity` in `src/lib/trace/index.ts`
(`crispOptionsFor`, `beautifyOptionsFor`), the snap gates in `src/lib/trace/planarBeautify.ts`
(`fid`, now modulated by `localScaleK` — §10.1), and the fit ε in `src/lib/trace/planarFit.ts`.
The medial radius the SNAP gate uses is the fitted primitive's own radius; the fit-ε half (still
open) would take it from the label map / planar network (`src/lib/trace/planarNetwork.ts`).

---

### 10.1 Prototype: scale-relative fidelity on the beautify snaps — built & measured (2026-07-19)

**What shipped (default OFF).** The `min(ε_abs, k·localScale)` gate of §10, realized for the
circle / ellipse / co-circular SNAPS in `planarBeautify` — the exact site of the §9.8 bite
(`tracePlanar` already emits exact squares; the fit ε was never the problem there). For each
snap the local scale is the fitted primitive's OWN radius — the disc/ring's medial radius, free
on hand, no distance transform, no chicken-and-egg. The gate `maxRadialDev ≤ fidelity` becomes
`maxRadialDev ≤ min(fidelity, k·r)`, so a big disc keeps the full 1.5px budget and a tiny one
must fit within a fraction of its own size. Behind `PlanarFitOptions.localScaleK` (0 = off =
byte-identical); the §9.8 corner-turn veto is exposed as `cornerVeto` so the two mechanisms can
be A/B'd head-to-head. `src/devtest/scaleRelSweep.ts` is the sweep harness;
`test/planar-scale-fidelity.test.ts` pins the discrimination property.

**Subsumption — §10's central claim, CONFIRMED (`checker` @512, corner-turn veto turned OFF):**

| config (veto OFF)   | chamfer | p95  | corner recall              |
|---------------------|---------|------|----------------------------|
| k = 0 (absolute px) | 0.38    | 1.74 | **41.9%** ✗ — the §9.8 bug |
| k = 0.10 … 0.20     | **0.00**| **0.00** | **97.2%** ✓ — byte-identical to the veto |
| k = 0.25            | 0.38    | 1.74 | 41.9% ✗ — too loose, rounds again |

With the corner-turn veto removed, a scale-relative ε ALONE reproduces the checker fix exactly
for k ∈ [0.10, 0.20]. The veto is a special case of the scale gate, as predicted — the checker
cell (fitted r ≈ 3.7px, 0.83px from its best-fit circle) is caught because `k·r < 0.83` there,
automatically, with no turn test.

**No regression, and why it is structural.** Every round / corner / thin tier-0 case —
`concentric` `nebula` `annulus` `bloom` `petals` `sharp-star` `hairlines` `aa-seam` — is
BYTE-IDENTICAL across the whole k ∈ [0.10, 0.25] sweep, veto on or off. `min(fid, k·r)` tightens
below the absolute budget only when `k·r < fid`, i.e. radius < `fid/k` ≈ 15px at k=0.1; every
genuine circle in the corpus is larger, so the scale term never binds on them. The mechanism is
invisible to everything except sub-15px round-ish shapes — exactly the population §9.8 named.

**Where it GREIFT — two constructed cases (`src/devtest/scaleRelDemo.ts`), one of them viewable:**

- *Substitution (veto OFF).* A field of small SQUARES beside small CIRCLES. With the §9.8 veto
  turned off the tracer has no guard: **9/9 squares round to blobs**. Scale-relative ε alone puts
  it back — **0/9 squares round, 9/9 circles stay round** — discriminating by SIZE, no turn test.
  The square is caught because its ~0.18·r deviation exceeds `k·r`; the circle survives because its
  ~0.02·r deviation does not (measured: a clean circle stays sub-`k·r` down to 8px diameter, so the
  control never regresses). `test/planar-scale-fidelity.test.ts` pins the invariant. This is a
  **viewable edge case** — `scale-blind.svg` (four checkerboard bands, cells 16→6px, so the scale
  THRESHOLD is visible: veto-off scallops only the small bands, scale-ε re-sharpens exactly those)
  and the classic `checker`, with the AbLab variants **`Veto off`** vs **`Veto off + scale-ε`**.
  The cells must be ADJACENT (a checkerboard), not isolated: a lone sub-13px square traces to a
  concave "pillow" (corner-pinned pre-smoothing bows its sides in) — a pre-existing tiny-loop
  artifact that muddies the demo, which shared straight edges avoid. NB the SHIPPED default (veto
  on) is byte-identical with or without scale-ε on these, so the effect shows only in the veto-off
  pair — the substitution, not an additive win.
- *The veto's BLIND SPOT (veto ON — the shipped default).* The veto discriminates by TURNING, so a
  small blob rounded WITHOUT a sharp corner slips past it. A **~10×6px flat ellipse** (ratio 0.55)
  turns only 49° (< 60°, veto blind) and is a hair too small for the ellipse snap (min-axis <
  2·fidelity), so the SHIPPED tracer rounds it to a **circle** (r ≈ 3.9) — a flat ellipse becomes a
  round dot, radial dev 1.41px > `k·r` = 0.59px. Scale-relative ε keeps it elliptical. This is the
  one place the scale gate does something the veto CANNOT, at the default setting — but it is a
  narrow population (sub-6px flat ellipses), which is why it does not by itself justify flipping the
  default.

**Verdict — landed default-OFF, like `refineJunctions` / `weldJunctions` (the latter since
removed entirely, §10.4).** Two honest facts
pull opposite ways: (a) scale-relative ε SUBSUMES the §9.8 veto and generalizes it to the
non-cornered small-blob case (measured + synthetic), but (b) on today's corpus the veto already
catches every real case, so additive (veto + scale) is byte-identical to shipped and there is no
case yet where scale does STRICTLY better. So the veto stays the default and the scale gate ships
as a measured, tested prototype behind `localScaleK` (nominal k = 0.15, mid of the [0.10, 0.20]
safe window). Flip it on — or drop the veto for it — the day a corpus case rounds a small blob
the veto's turn test misses. Suite 271/0/2, golden + truth-gate byte-identical.

**Still open (the bigger half of §10).** This prototype makes the SNAPS scale-aware; the FIT ε
(`planarFit.ts` RDP + cubic-discard at 1.0px) is still absolute. Making THAT scale-relative needs
the medial radius as a per-point field over open edges — a distance transform on the label map
(`planarNetwork.ts`), not just the fitted primitive's radius — which is strictly more work and
more calibration risk. The fit already emits exact squares, so the snaps were the right first cut.

### 10.2 The fix: sharp-star's beveled tips — a 1px heal pixel was splitting the loop (2026-07-20)

**Symptom.** Every one of `sharp-star`'s 10 points traced as a flat 2-node cap ~4px short of
the authored apex (top tip: authored (256,26), traced cap (255,30)–(257,30), hausdorff 4.0px
@512). Identical across EVERY AbLab variant — the break was upstream of every `planarFit`
flag. And no gate was red: boundary mean/p95 passed (tips are a tiny fraction of boundary
length) and the corner gate — built for exactly this defect class (§9.8) — reported **n/a**,
because the star has 10 visible authored corners and `CORNER_MIN_COUNT` was 12. The corpus's
corner-preservation case was exempt from the corner gate.

**Cause chain, measured stage by stage.**
1. *Raster (inherent, ~2px).* The sub-pixel tip anti-aliases below 50% coverage; the palette
   segmenter's 50%-isophote cut puts the tip at y=28 (authored 26).
2. *`modeFilter` erosion (~2px, self-inflicted).* A ≤2px-wide tip row has 4 own vs 5 foreign
   votes in the 3×3 majority window, so each pass eats one row: modePasses 0/1/2 → tip row
   28/29/30. (Same family as the §9.5 thin-bar erasure; `restoreErasedComponents` only rescues
   components erased WHOLE, not eroded tips.)
3. *The machinery that repairs both already exists — for closed loops.* `detectLoopCorners`
   finds the tip cluster and `snapCornerToArms` extends the two straight arms to their
   intersection: on the closed pre-heal loop the apex lands at **(255.92, 25.07)** — 0.93px
   from authored — and `planarBeautify` preserves it.
4. *Root cause: `healColorSpikes` split the loop.* At the 4 non-axis-aligned tips one fully-
   covered navy pixel survives beyond the eroded tip (e.g. (39,185), exact palette colour);
   heal flipped it back — but not the blend pixels connecting it, and its only navy contact
   was DIAGONAL. A checkerboard pinch is a junction in the planar network: the star outline
   went from ONE closed loop (2220 pts) to open edges + 5pt micro-edges.
5. *Open edges get no corner snap.* `planarAssemble` runs `fitCorneredLoop` only for
   `e.closed`; `fitOpenArc`'s DP places C⁰ joints at staircase key vertices but never extends
   arms. Result: every corner beveled, including tips far from any healed pixel.

**Fixes shipped (each one line of mechanism).**
- *`healColorSpikes` targets 4-connected neighbours only* (`index.ts`). The colour evidence
  comes from the PALETTE, not the neighbour pixel, so the 8-connected scan added nothing
  except the diagonal-only reassignments — which create a pinch by construction. A genuine
  wedge still heals inward edge-by-edge across passes. On sharp-star the heal drops from 4
  flipped px (all pinches) to 2 (both 4-adjacent, no topology change); the star loop stays
  closed, 12 nodes (was 17+2+2 across a junction-split graph), apex snapped to 0.93px.
- *`CORNER_MIN_COUNT` 12 → 10* (`truthCorpus.ts`). A 10-corner star is not "mostly-round
  art". With the gate applicable, the pre-fix defect measures 0 recovered — it would have
  been red on day one.
- *Tangent-based corner reading in `geomScore.sharpCorners`.* The old test only counted
  handle-free line-line joints. On the flat path `FLAT_LINE_COST` (4.5 > cubicCost 4) makes
  the DP PREFER a cubic wherever one fits within ε, so a genuinely sharp tip lands as a C⁰
  kink between two cubics — rendering identically sharp, scored as not-a-corner (the fixed
  star read 3/11 while all 10 tips were crisp). Tangents are strictly MORE accurate, not
  looser: a corner melted to a blob (§9.8's checker) is G¹ — tangents agree, turn ~0 — and
  still never reads as sharp. GT polygons carry no handles, so the GT side is unchanged;
  `checker` still passes at 97%+ recall.
- *Arc fits censor the cap remnants (`fitCorneredLoop`).* Found by eye after the heal fix:
  the RIGHT tip (authored slope −0.073, the shallowest) rendered as an S-hook with an extra
  node. Its top arm rasterizes to a 6px-long 1px plateau right next to the eroded tip, so
  the arc's first dense points sit laterally OFF the snapped-apex→arm line and the fit
  chased them, arriving at the apex from below. Those points are exactly the ones
  `snapCornerToArms` already skips (`SNAP_GAP` — "the rounded part"); now the ARC fit skips
  them too (trimmed before pinning the snapped endpoints, guarded to keep ≥ 2 interior
  points so a small checker cell's edge keeps its evidence). Right tip: one hard corner
  node, clean taper; sharp-star chamfer 0.30 → 0.19, hausdorff 4.0 → 2.73 @512, and one
  more notch returns as a hard line-line corner (recall 7 → 8/11).
- *Adaptive arm span in `snapCornerToArms` — the shallow-tip overshoot closes, and the gate
  flips green.* The LEFT tip still snapped 2.78px past the authored apex and its arc dove
  back with a visible kink (user-reported). Root cause is sampling, not fitting: at arm
  slope 0.073 the 14px `SNAP_SPAN` window contains LESS THAN ONE unit staircase step, so
  the fitted arm slope is step-phase noise — and at a ~4° tip angle every slope error
  multiplies ~1/tan(4°) ≈ 14× into AXIAL apex error. The window now grows up to
  `SNAP_SPAN_MAX` 40px while each next point stays within `SNAP_COLLINEAR` 0.75px of the
  current fit (and never past the neighbouring corner): straight arms earn 3 steps of
  evidence, curved arms fail the first extension and keep the old window — ring/blob
  corners unmoved. All five tips land 0.11–1.23px from authored (top 0.93 → 0.11, left
  2.78 → 1.23, kink node gone), corner recall 9/11 = 82% — **sharp-star passes the corner
  gate**, and CI forced the `KNOWN_DEFECTS` deletion (the list-can-only-shrink contract
  doing its job). Chamfer 0.19, p95 0.52 @512.

**After.** sharp-star corner recall 0 → 7 (heal fix) → 8 (arc trim) → **9/11 = 82%** with
the adaptive arm span — **the corner gate passes** and its `KNOWN_DEFECTS` entry is deleted.
The residue is cosmetic and enumerated as §0 #2b: two of five 80° notches trace as a 2-node
chamfer ~3.5px wide (`detectLoopCorners`' 70°/±4px window misses them — staircase phase
decides — so they never reach the snap). `cross-bars` became corner-gated for the first
time and fails (4/10) — that is the §0 #2 junction weld read through the corner lens, not
a new defect; it stays in `KNOWN_DEFECTS`. The rest of tier 0 + the tier-1 slice stays
green.

**Corpus effect (golden re-bless, reviewed).** The 8-connected heal was manufacturing pinch
junctions everywhere, not just on stars. `headphones-flat`: nodes **9632 → 5220 (−46%)**,
junction clusters **282 → 121 (−57%)** at identical fidelity (meanΔE 3.918 → 3.914, SSIM
0.7934 → 0.7940) — this is the §1 case whose 9632-node golden the doc itself calls
pathological. `aurora-flat`: clusters 3 → 0, nodes 193 → 173. `schild-flat` — the art the
heal was BUILT for — improves slightly (meanΔE 0.954 → 0.948, seam identical 68.54): the
wedge still heals, edge-by-edge. One number moved the wrong way: headphones-flat `seamMax`
51.61 → 57.64 — the worst single boundary pixel of the pre-existing thin-dark-ring family at
(509,717) (the old max, ΔE 51.6, sits 40px away in the same ring); a max-statistic on an
off-target photo case, accepted with the re-bless. `nebula`/`petals`/`bloom-flat` hashes:
bloom −2 nodes, the gradient pair untouched (heal is flat-only; the headphones-grad golden
diff in the same bless was pre-existing staleness — its old record predates a7239b2's
engine changes, verified by re-recording at HEAD with the fix stashed). The planar unit
test's 8-connectivity contract ("a diagonally-orphaned pixel must heal") is deliberately
REVERSED — that contract was the pinch generator.

**Follow-ups named.** (a) Open-edge interior corner snap in `fitOpenArc` — the class fix for
any outline genuinely junction-split by a third colour (this fix only rescues loops that
should never have been split); (b) the notch threshold/window (70°/±4px vs a real 80° turn);
(c) shallow-tip snap bias. All three live under the sharp-star `KNOWN_DEFECTS` entry (§0 #2b).
*(a) shipped 2026-07-21 as `fitCorneredOpen` — §10.3.)*

### 10.3 Two fixes: the Step-3c step-fit merge veto + open-edge corner snap (2026-07-21)

**Symptoms (user-reported, same screenshot).** (1) A section of a gradient background
"graded flat": nebula.png's bottom-left corner and gradient-flat's bottom-right corner
render as a flat sliver with an invented boundary arc mid-gradient. (2) gradient-flat's
triangle apex traced asymmetric — one smooth node above the apex plus a corner node
off-centre with a short curve, where the art has one sharp point.

**Cause 1 — the degenerate step-fit merge (`segment.ts` Step 3c).** `fitBestGradient` is
multi-stop, so the union {big flat region} ∪ {small far-away flat-ish sliver} fits as a
STEP function — flat, jump, flat — almost exactly: gradient-flat's white circle ∪ orange
corner band fit radial `#f6f6f9(t<0.73) → #ea9529(t>0.85)` at RMS residual **0.0012**;
nebula-png's white blob ∪ purple corner at **0.0022**. Both BEAT the honest adjacent
bg∪sliver merges (0.0037 / 0.0212 — a real ramp carries curvature; a step of two flats is
near-exact), so the greedy global-min hands the corner to the white class first, and the
sliver is then painted with the white region's model. Neither guard fired: `profileGap`
measured 0.083 / 0.125 (≤ 0.34) because the big host's own spatial extent fills the
t-profile to within 2–3 bins of the sliver, and the S>64 candidate gate wasn't running
(S₀ = 13 / 19; its "provable superset" comment is wrong — un-gated global-min DOES select
non-adjacent different-mean pairs). Calibration over tier 0+1 endpoint groups (409
multi-fine groups) showed the pattern is EPIDEMIC, not a corner case: nebula-svg's white
dot lives in the purple bg class as a radial step (res 0.0000 — pixel-perfect and
structurally wrong), hairlines' two dark bars in the white bg class, watermelon's pupil,
annulus' teal ∪ red, bg-ramp-twin's blue ∪ green shape pair (the case's designed trap).

**Fix 1 — the unwitnessed-jump veto** (`SegmentOptions.maxUnwitnessedJump`, default
0.12). A union is rejected when its fitted gradient makes an Oklab ΔE jump larger than
the threshold across a SAMPLE-FREE stretch of parameter t (flanking-bin pooled means)
**AND one of the two groups is itself a near-flat colour block** (`FLAT_FLANK_RES`
0.008 — the flat-flank condition, added after the user's /labs/ab review, below).
A genuine smooth field is witnessed everywhere along its own axis; a genuine reunite
(nebula's field outside the ring re-joining the hole) OVERLAPS in t; the step-paste
concentrates its full contrast in empty bins. This is NOT the reverted `profileCliff`
(that measured contrast at the pair's colour seam, inverted between real and fake; this
measures contrast across EMPTY parameter space). Calibration: honest ramp merges measure
**0.0000** (bg-ramp, bg-ramp-twin bg, radial-glow, aurora ×2; gradient-flat's 10-band bg
reunite 0.031); the step-pastes measure **0.22–0.75**. On tier-1 soft-gradient art the
band is continuous (0.05–0.24, no clean gap) — 0.12 passes every gate incl. the tier-1
slice, and the product target is flat icons. SCOPE: auto path only — Region detail > 0 or
keep-separate markers disable the veto (`segmentOptionsFor`), because the marker split
and the V6 translucent recovery CONSUME the fusion behaviour (an overlap must fuse into
its shape's class for the split to carve out; bloom's layers-integration test locks it,
and its load-bearing merge-time unions measure > 0.26 — no threshold serves both). FLAT
markers keep the veto (they exist to hand-fix fake regions; disabling on their account
would resurrect the fakes).

**The flat-flank condition (the /labs/ab review's catch).** The first cut vetoed on the
jump alone, and the user's review caught `radial-glow` REGRESSING: the glow re-centred
and grew ring artifacts — while every gate stayed green (on gradient art the gates score
boundary geometry, and radial-glow's authored geometry is just the frame; the PAINT is
gate-blind). Root cause is subtle: the veto did NOT change radial-glow's topology (one
region either way, verified) — it changed the greedy merge ORDER. The old sequence
freely merged far-apart pieces of the smooth field via near-exact step fits (harmless
there — everything fuses into one region regardless); vetoing them re-routed the
sequence, and since each merge re-strides the union's samples (`strideConcat`), the
final region carried a DIFFERENT sample subset — and Stage 2 fitted a different glow off
it. Instrumenting every res/gap-passing pair of the old sequences gave the separator:
the true pastes always have a FLAT side (min-side solid residual ≤ 0.0055: gradient-flat
white 0.0000 / sliver 0.0048, nebula-png 0.0000 / 0.0055, hairlines 0.0000 ×3) while
the smooth-field pairs never do (min side ≥ 0.0156 radial-glow, ≥ 0.0190 bg-ramp — a
~3× gap; `FLAT_FLANK_RES` 0.008 sits in it). With the condition, radial-glow @ 0.12 is
**byte-identical to the pre-fix baseline** and every step-paste veto still fires.
Physical reading: a flat block has no interior colour trend that could ever bridge the
gap (the step is pure invention); a ramped piece's own trend explains its side of it.

**Cause 2 — open edges never got the §10.2 corner snap.** `snapCornerToArms` + cap-trim
lived only in `fitCorneredLoop` (closed loops). gradient-flat's triangle outline is an
OPEN edge — the white circle overlaps it, junctions at (216,192)/(244,226) split it — so
the apex stayed a raw pinned lattice vertex at (350,337), 2.2px off authored (348,338),
and the DP fit around the AA-eroded cap remnants, arriving from the wrong side (the exact
S-hook pathology the §10.2 cap-trim note describes).

**Fix 2 — `fitCorneredOpen` + `detectOpenCorners`** (`planarFit.ts`, wired in
`planarAssemble`). detectLoopCorners' clustering (sub-threshold runs → one apex, fuse
≤5px) mirrored with clamped windows — the raw `detectCorners` set holds BOTH staircase
shoulders of a vertex and must not become two breakpoints. Each interior corner snaps to
its arm intersection (windows clamp at the open ends; the edge's endpoints are junction
anchors — never snapped, never trimmed, byte-coincident with siblings), pieces are
cap-trimmed at corner ends and fitted open, stitched with the corner as ONE hard node.
A prune-and-refit pass drops breakpoints whose FITTED turn is < 30° (a staircase jog near
a junction fires the ±4px 70° detector but fits nearly straight — asserting a hard corner
there is geometry the art doesn't have).

**After @512.** `gradient-flat`: chamfer 0.81 → **0.23**, p95 **6.31 → 0.72**, parsimony
2.2 → 1.62, regions 89/89, corners **6/6** — passes every gate, `KNOWN_DEFECTS` entry
deleted (was §0 #4; the "edge pull" was these two defects compounding). The apex is one
sharp node 0.4px from authored; all three triangle vertices single corners ≤ 0.55px.
`cross-bars`: corner recall 4/10 → **8/10 = 80%, the corner gate passes**, entry deleted
(chamfer/p95 unchanged 0.34/0.54 — §0 #2's measured face closes; the sub-tolerance wedge
visual stays watched in AbLab). sharp-star 9/11, checker 0.00/0.00 @ 99.1%, aa-seam
0.22/0.74 — unchanged. Full suite 273 green.

**Corpus effect (golden re-bless, for review).** `nebula` grad: the fake step gradient is
GONE — gradientCount 3 → 2, junctions 2 → 0, seamMax 26.1 → **12.7**, nodes 74 → 62,
jaggedness 0.43 → 0.41; meanΔE 2.94 → 3.20 (+0.26 — the step gradient reproduced the
sliver pixel-exactly; structure wins over raster fidelity here, per the product target).
`headphones-flat`: nodes 5212 → **5038**, jaggedness 8.77 → **7.47**, meanΔE +0.014.
`headphones-grad`: nodes 700 → 686, jaggedness 2.29 → 2.01, meanΔE +0.018.
`schild-flat`: 180 → 178 nodes. `petals`/`bloom-flat`/`aurora-flat`: byte-identical.
A/B snapshots: `before-stepfit-opencorner` (ba62a3b) frozen for the /labs/ab review.

**Follow-ups.** (a) The DP's own near-straight C⁰ joints on open edges remain (a ~4° kink
node where the boundary bends into a junction's AA neighbourhood — pre-existing
behaviour, now more visible next to snapped corners). (b) ~~flanking-population flatness
as the next discriminator~~ — RESOLVED same day as the flat-flank condition above, after
the user's review caught radial-glow. (c) ~~A gate for PAINT on gradient art does not
exist~~ — SHIPPED same day: the **paint-fidelity gate** (`PAINT_MEAN_MAX` 3.0 /
`PAINT_P95_MAX` 8.0 in `truthCorpus.ts`) renders the traced doc (`scoreboard.scoreDoc`,
the same harness rasterizer the goldens use) and scores mean/p95 CIE76 ΔE against the
source raster, on the four GRADIENT tier-0 cases — exactly the blind spot: there the
geometry gates score only boundary, and region/corner recovery are n/a by construction.
Calibrated healthy values 1.05–1.34 / 1.80–3.47; the regressed radial-glow measures
**9.14 / 23.95 — the gate goes red on the exact tracer state the user caught by eye**
(verified by re-running the gate with the flat-flank condition temporarily neutralized).
Wired into `test/truth-gate.test.ts` AND the Workbench gate table (`analysis.tsx`), same
`evaluateTruthGates` definition. Tier-1 paint stays ungated (§0 #9/#10 — the soft
multi-gradient banding family is a known, deprioritised defect; gating it adds red, not
information). Flat art stays ungated (regions + boundary + palette already pin its paint).

### 10.4 Junction re-seat on fitted-primitive intersection (2026-07-21)

**Symptom (user-reported, /labs/workbench on `gradient-flat` @521%).** The triangle's
straight hypotenuse gets "pulled into the circle": near where it crosses the white
disc, the traced line bends left off its own line, the disc bulges to meet it, and the
white|dark boundary between the crossings fits neither the line nor the arc — both
shapes look worse than the raster. Every gate was green (§10.3's exit numbers): the
whole defect lives inside the 1/2.5px limits, spread across the crossing zone.

**Cause — the lattice junction SLIDES along a near-tangent crossing.** The hypotenuse
crosses the disc at distance 74.2 from its centre (r = 76): a 12° incidence, sagitta
1.8px. Near the true crossings, the colour needle between the two boundaries (the bg
wedge past the exit, the white wedge before it) is sub-pixel thin for several px, so
AA + quantization hand its pixels to a neighbour class — the three-colour meeting
point in the LABEL MAP does not exist where the art crosses. Measured @512: the
lattice junction landed **8.4px past** the authored intersection (on the arc, 2.2px
off the line) at the exit, 3.1px early at the entry. `fitOpenArc` pins junction
endpoints, so the straight edge's last segment BENT off the line to reach the slid
vertex (the "pull"), and the chord edge between the junctions spanned a stretched gap
as a curve on neither primitive. No lattice-local scheme can find the true point —
the evidence is destroyed in the raster; `refineJunctions` (±10px raw-arm least
squares, 2px cap) is structurally blind to it.

**Fix — `planarReseat.ts`, a planarBeautify pre-pass (before §1d).** At each interior
degree-3 junction: extract each incident edge's terminal primitive from its FITTED
geometry (arm ≤ 110px, stopping at ≥30° fitted corners; line ≤ 0.8px dev, else circle
≤ 0.9px radial dev; a terminal segment ≤ 18px that breaks the fit is skipped as a
mangled cap and the neighbouring run carries the primitive). If the vertex lies
within 3px of TWO primitives whose intersection sits ≥ 1.5px away (≤ 12px, ≥ 5°
transversal), move it there: the correction slides ALONG both boundaries, so a
correct junction (intersection ≈ vertex) never moves — the 1.5px floor keeps generic
sub-pixel lattice noise untouched (the refineJunctions lesson). Terminal repair:
line-arm caps are deleted (the run extends straight to the vertex — the bend was the
defect), circle-arm terminals re-emit as `arcSlice`s, the third edge re-anchors. An
edge whose two endpoints were both re-seated against the SAME line is that occluder
continuing through the crossing — it re-emits as the straight CHORD, and §1d is
vetoed from absorbing its loop into a circle (a disc cut by a chord is a "D"; without
the veto, 1d's now-valid circle fit re-invents the occluded sliver — observed while
building this). Border junctions are excluded (the frame must stay). Rides the
fidelity dial like all of planarBeautify; `planarFit.junctionReseat: false` = the
pre-§10.4 baseline.

**After @512.** `gradient-flat`: chamfer 0.23 → **0.20**, p95 0.72 → **0.63**,
parsimony 1.62 → **1.48** (the bent cap node and its breakpoint are gone); both
junctions land ≤ 0.35px off BOTH primitives (residual is tangential fit noise —
invisible); hypotenuse straight end-to-end (max 0.33px), chord an exact 2-node
straight on the line, sagitta-inside the disc as authored. `hairlines`: 0.44/0.89 →
**0.41/0.86**, parsimony 1.74 → 1.68. `overlap` p95 −0.01, `fluent-flute` −0.01
chamfer. `nebula`/`petals`/`bg-ramp-twin`/`flute-flat` byte-changed, scores identical
(sub-tolerance anchor moves). 14/21 A/B cases byte-identical incl. every gradient
case the §10.3 flat-flank protects (`radial-glow`, `bg-ramp`), `aa-seam` (border
guard), `checker`, `cross-bars`, `sharp-star`, `concentric`. Suite 277 (4 new:
`test/planar-reseat.test.ts` — a hand-annexed needle fixture reproducing the slide
deterministically). A/B snapshot `before-gradient-flat-pull` (e549b29) frozen for the
/labs/ab review.

**Second half (same day, user-reported from the /labs/ab review): the converged-pair
weld.** Measuring node spacing on `overlap` after the re-seat showed the smallest gap
had gone 4.0px → **0.31px**: at a lens tip ALL four regions meet in one authored
point (a degree-4 crossing), rasterization splits it into two degree-3 junctions +
a micro-edge, and the re-seat — via the circle×circle intersection — had correctly
converged both onto the true crossing but left two near-coincident vertices and a
0.31px edge. Completion: `weldConvergedJunctions` (planarReseat.ts) contracts a
micro-edge (fitted length ≤ 2px) when at least one endpoint was RE-SEATED — the
evidence gate that separates it from the blanket ≤3px weld §9.3 measured as a
corpus regression (a bare-short micro-edge is sometimes a real thin feature;
beverage-box-flat). Reuses `weldJunctionClusters` (planarWeld.ts, new optional
`eligible` filter) for the graph work: fuse to centroid, re-anchor incident edges,
excise from loops. Runs in index.ts after planarBeautify (contracting rewrites the
region loops, which beautify treats as read-only; `SnapOptions.onReseat` carries the
moved-vertex ids out). Two enabling tweaks in the arm extraction, both found on
overlap's bottom tip: `CAP_MAX` 18 → 24 (the cap breakpoint sat 20px out), and the
corner-stop is bypassed at the first interior node behind a ≤ 8px cap (`CAP_STOP_
BYPASS`: a 3px cap kinking ≥30° into a long arc IS the mangle — the stop starved the
arm and the cap-skip never had a candidate; a real short terminal like
gradient-flat's 24px hypotenuse piece stays protected by the bound). After @512:
`overlap` lens tips are ONE vertex each — flat 0.33/0.34px from authored, grad
0.92/0.33px — parsimony 1.99 → **1.75** (p95 0.38 → 0.41, sub-noise), both X
crossings render as a clean point; the pre-existing 1.4/2.2px band-junction
clusters are untouched (no re-seat evidence — exactly the gate working). Changed
A/B set unchanged at 7/21. Suite 279 (6 reseat/weld tests).

**Blanket-weld retirement (same day).** With the converged-pair weld in place, the question
"is the experimental `weldJunctions: 3` blanket weld now obsolete?" was answered by
RE-MEASURING it against today's tracer (tier 0 + tier 2, 122 cases @512, default vs
`weldJunctions: 3`): **10 better / 6 worse / 106 same — including two NEW tier-2 gate
crossings** (`fluent-peanuts-flat` boundary-mean 0.25→0.46, `fluent-custard-flat` p95
1.00→1.50) that did not exist in the §9.3 sweep, and — decisive — its own target cases now
DEGRADE under it: `bloom` p95 0.41→**0.63** (was −0.25 better in §9.3), `overlap`
0.41→0.46. Cause: the blanket weld ran in `assemblePlanar`, BEFORE the §10.4 re-seat, and
fused clusters onto blind centroids — destroying the junction pairs whose fitted-primitive
intersections the re-seat would have recovered exactly. The §9.3 objection (bare shortness
is not evidence — beverage-box) still stands on top. So the flag was REMOVED 2026-07-21:
`PlanarFitOptions.weldJunctions`, the assemble-time call, and the AbLab/Profiler variants
are gone (the Profiler slot now measures `junctionReseat` instead); `planarWeld.ts` remains
as the machinery behind `weldConvergedJunctions`, and `test/planar-weld.test.ts` drives it
directly. The §9.3 sweep rows above stay as the historical record.

**Ghost-disc arc lap (same day, user-reported on real logo art).** A soft-alpha PNG
("100 years tour": AI-export with a 3–6px alpha feather, which survives as a translucent
sliver layer — §0 #13) rendered with a large translucent CIRCLE floating over the
letters. Repro @2048: `applyEnd`'s circle-arm re-emit turned a **5.9px** terminal cap
into a **356° arc** of its r≈81 fitted circle — a ghost disc ballooning out of a sliver
edge. Cause: the sweep-side hint passed to `arcSlice` is the ORIGINAL cap's sampled
midpoint, and on a mangled cap that points AWAY from the corrected vertex the hint
lands on the wrong angular side of the tiny from→to span — which `arcSlice` faithfully
honours as the near-full-circle way around. Fix: `junctionLocalMid` — a TERMINAL
re-emit is junction-local by definition, so a hinted sweep > π is itself the mangle;
the hint is replaced by the minor arc's own midpoint (chord midpoint projected
radially onto the circle). §1d's arcSlice call is untouched (a ring arc between two
junctions may legitimately sweep > π, and its hint comes from the full polyline).
Corpus A/B vs `before-reseat-arc-cap`: **1/21 changed — `nebula.flat`**, where the
same lap had been silently mangling the white ring into blobby ghost discs (flat is
nebula's ungated A/B variant, so no gate saw it); it now renders as the clean ring +
dot. Everything else byte-identical. Suite green (`planar-reseat.test.ts` + 1: a
synthetic wrong-side-cap fixture that fails on the pre-fix code).

### 10.5 The §10 driver case exists now: `gear-teeth`, authored deliberately red (2026-07-21)

§10.1 ended on "there is no case yet where scale does STRICTLY better", and the fit-ε half
of §10 stalled on the same missing evidence ("no red case demands it"). The case was
CONSTRUCTED instead of waited for: `gear-teeth`
(`public/examples/edge-cases/gear-teeth.svg`, genEdgeCases) — a 14-tooth trapezoid gear
next to a large smooth navy disc (the control). The geometry is TUNED into the exact
window that separates "the raster can't resolve it" from "the tracer won't":

- every tooth chord is ≥ 7.5px @512 — above the answer sheet's own `CORNER_MIN_EDGE` 7px
  grading floor, and comfortably raster-resolved (a commercial tracer keeps these teeth);
- but the corners sit 7.5–12.5px apart — inside the wash zone of the fit's FIXED ±4px
  corner window (`CORNER_WINDOW`, spanning 8px) + 5px apex-merge distance, so
  `detectLoopCorners` fuses/washes most of them and ε=1.0 melts what is left.

**Measured @512 (authoring-time):** chamfer 0.22 / p95 0.78 / parsimony 1.20 — every
boundary gate GREEN — while corner recall is **21/60 = 35%** (< 80%): the §9.8 lesson
again, a shape can be destroyed while every px stays sub-tolerance, and only the
distance-blind corner gate sees it. Sweep across tooth counts (n=24 → gtCorners 4, below
the grading floor, fails p95 instead 5.08; n=12–18 all fail corner recall 35–62%) — the
shipped n=14 sits mid-window with margin on both sides. Verified non-movers: the
corner-turn veto (guards the SNAPS; this loss is in the FIT) and `localScaleK = 0.15`
(byte-identical scores — same reason). Registered: tier-0 truth corpus + `KNOWN_DEFECTS`
+ §0 #12. NOT added to `AB_CORPUS` yet — AbLab's snapshot compare throws on a case absent
from a frozen manifest, and re-generating old baselines would falsify them; add it at the
next natural re-bless.

Closing #12 is the "still open (the bigger half)" §10.1 work item, now with a number to
beat: scale-aware fit ε and detector windows — the corner window / apex-merge / ε keyed to
local feature size (medial radius per point, from a distance transform on the label map),
instead of absolute px. The user's original framing (a detail "heat map" multiplying the
hard px gates) is exactly this; §10's refinement (measure SCALE from the source, not node
density) still applies. *(Closed 2026-07-28 — §10.6. The measured mechanism was NOT the
one §10.5 predicted; the histogram below is why the diagnosis pass ran before any design.)*

### 10.6 gear-teeth closes: one definition of sharp + a scale-aware corner snap (2026-07-28)

**The diagnosis falsified §10.5's mechanism.** Instrumenting every stage on the gear loop
(`src/devtest/gearDiag.ts`, kept as the repro artifact) gave the histogram — of the 39
lost corners: **32 never detected**, **0 lost to cluster fusion or the 5px apex-merge**
(mergeDist 2/3/5 byte-identical apex sets at the old threshold), **0 ε-melted after
detection**, **7 misplaced by the snap** (apex evidence 0.2–1.3px from authored, fitted
sharp node 2.6–4.4px — just past the scorer's 2.5px radius). The 32 detection losses
decompose by authored geometry: the roots turn **67.3°** and the detector demanded
**70°** — while `geomScore.sharpCorners` and planarBeautify's `CORNER_TURN` both define
sharp as **60°**. The pipeline graded 60° and detected 70°: every 60–70° authored corner
was structurally invisible, at every scale. The tips (80.1°) clear 70° on paper but the
±4px window dilutes the measured turn (min 53°, median 72° across staircase phases) —
phase decides. Shrinking the window ALONE measures WORSE (win ≤ 3 quantizes turns into
~45°/63° buckets below even 60°).

**What shipped (`planarFit.ts`).**
- **`cornerTurnDeg` 70 → 60** — the one sharpness definition, aligned with the scorer
  and beautify. The smooth-disc control (992-pt loop, r=124) emits zero apexes down to
  55°/win3, so the change is invisible to clean round art.
- **Scale-aware snap arm gap (`armGap`)** — the fixed `SNAP_GAP` 3 discarded 3 of an
  ~8-step arm's points, leaving phase noise; the gap now scales with the inter-corner
  arc (≥13 steps keep the full 3, an 8-step chord drops to 1), and the cap-trim before
  each arc fit mirrors it.
- **Short-arm reconstruction bypass** — arm-intersection reconstruction exists to
  recover ERODED apexes (shallow star tips) and needs long-arm evidence to earn its
  move; when either arm is shorter than `SNAP_GAP+4` steps the raw cluster apex is kept
  (measured median error 0.99px — better than its own reconstruction). SWEPT: raising
  the bypass to 11/14 collapses recall to 57–62% — medium arms genuinely profit from
  reconstruction; only the shortest do not.
- **Displacement cap** — an accepted reconstruction may move the apex at most
  `max(2, 0.5·shortSpan)` px (full-span arms keep the legacy `max(inSpan,outSpan)`), so
  a noisy intersection can never carry a corner out of tolerance.
- **Arc-scaled presmooth (`arcSmoothPasses`)** — 2 smoothing passes on a sub-16-step
  inter-corner arc bend its few interior points inward and rotate the fitted end
  tangents (a 67° joint reads < 60° = not-a-corner off invented geometry); full passes
  from 16 steps, one from 9, raw below.
- **`CORNER_MERGE` 5 → 3** — the apex-fuse distance now sits between the two scales it
  must separate: above a rasterized tip's shoulder pair (≤ ~2px), below the smallest
  corner spacing the corpus keeps (7.5px chords). At 5 it fused real 3–5px corner
  pairs; 3 measured +5 corners on gear-teeth, no spurious apexes.

**Tried and MEASURED WORSE (the full 36-config sweep ran on the real pipeline —
union × mergeDist × bypass-span × line-preference):** a two-scale win∪(win−1) apex
UNION (fine-scale extras poison their neighbours' fitted tangents: 85.0% → 81.7%); a
±2px fine-turn apex re-localization (a staircase reads ~90° at ordinary step vertices
too: → 68.3%); a short-arc LINE preference undoing `FLAT_LINE_COST` below 16/24px
(→ 78.3–80.0%). The winning config is the sweep's global optimum, and each rejected
mechanism is one line of history here so it is not re-invented.

**After @512.** `gear-teeth`: corners **21/60 → 51/60 (85.0%, gate passes, margin 5)**,
chamfer 0.22 → **0.18**, p95 0.78 → **0.50**, parsimony 1.20 → 1.3 (+30 true corner
nodes), `KNOWN_DEFECTS` entry deleted by the CI contract. `sharp-star`: corner recall
9/11 → **11/11** — the two 80° notches of **§0 #2b** now trace as single sharp corners
(their window-diluted 60–70° readings clear the aligned threshold); the #2b row is
deleted. `cross-bars`: 8/10 → **10/10**. `hairlines`: chamfer 0.41 → **0.38**.
`gradient-flat` 6/6 at p95 0.63, `checker` 99.1% at 0.00/0.00 — unchanged. Tier 1
slice: all green, paint gate incl. `radial-glow` green. Suite 279/0/2.

**Corpus effect (golden re-bless, for review).** The cost lands on the one pathological
photo case: `headphones-flat` seamMax 57.64 → **79.47** (a max-statistic in the §10.2
thin-dark-ring family), jaggedness 7.47 → **10.60**, nodes 5038 → 5498 (+9%) — while
its meanΔE (3.928 → 3.922), SSIM (0.7923 → 0.7940) and junction clusters (121 → 119)
all IMPROVE: at 60° the detector pins more of its noisy AA boundaries as corners, so
the trace follows the staircase more faithfully instead of smoothing it. Accepted per
the §10.2 precedent (off-target case, fidelity metrics improve, max-statistic noted).
*(Follow-up 2026-07-28: `headphones-flat` was RETIRED from the golden corpus at user
direction — the photo-derived case is off the product target and kept forcing exactly
these accept-the-trade re-blesses; `headphones-grad` (same fixture, slow-gated) stays
as the Step-3c perf + complex-input guard. See the `traceCorpus.ts` corpus comment.)*
Flat-icon corpus: `nebula` 62 → 59 nodes, `aurora-flat` 171 → 163 nodes and
meanΔE −0.013, `petals`/`bloom-flat`/`schild-flat` metric-identical. A/B vs the frozen
`before-scale-eps` snapshot: 20 of 42 variant files changed, dominated by node-count
SHRINK (cross-bars 1066 → 720 bytes, sharp-star 701 → 545 — single hard corners
replacing beveled pairs); review in /labs/ab → Vs snapshot → `before-scale-eps`.

**Open residue (not gated red anywhere).** gear-teeth still loses 9 corners: ~5 in the
detection tail (window dilution at unlucky phases — the two-scale union that would find
them costs more than it recovers) and ~4 to fit-tangent noise at correctly-placed
nodes. The literal scale-aware fit-ε (openRDP / cubic-discard at `min(ε_abs,
k·medial)`) remains unbuilt and currently undemanded — this fix measured ε-melts at
ZERO. §0 #6b (bar caps) is untouched by design: a cap's two shoulders sit in ONE
contiguous sub-threshold run, which no mergeDist change splits. *(Closed same day —
§10.7. Both halves of that sentence turned out stale on measurement: this fix's own
short-arm bypass had already healed the ≥7px caps, and the fused-run anatomy is only
one of the three failure families the cap regime actually exhibits.)*

### 10.7 Bar-end caps close: the cap resolver (§0 #6b, 2026-07-28)

**The re-measurement rewrote the row — twice.** The stored anatomy (§10.2 exit note:
"≤4px cap + both shoulders in ONE ±4px-window cluster → one apex → pointed; 7px cap →
slanted shoulder snaps → shallow dome") was measured FALSE at HEAD before any design:
a probe rack of 7–12px bars traced 36/36 corners sub-px — §10.6's short-arm bypass +
`CORNER_MERGE` 3 had closed the ≥7px regime as an unnoticed side effect (the same rack
run against the pre-§10.6 tree in a worktree: 32/36, the only loss being a 45° bar the
70° threshold never detected). The defect was NOT gone though — a real-pipeline sweep
(angle × width × length × sub-pixel phase, `traceImage` + the scorer's own corner
match) located where it lives TODAY: **7px-wide caps — the `CORNER_MIN_EDGE` grading
floor itself — at non-crisp AA phases**, every angle, most phases (recall 0–3 of 4 per
bar; the same bar at a crisp integer phase, or 1px wider, traces 4/4 sub-px; w8+ is
phase-robust at 8/8 phases). At an unlucky phase the 50%-isophote cap rasterizes ~1px
narrower than authored, into the window-confusion zone.

**The driver case** (`bar-caps`, genEdgeCases, gear-teeth §10.5 pattern): eight w7 bars
pinned at MEASURED-failing (angle, phase) cells — phases authored as center =
integer + phase/2, the sweep's exact construction — plus a w10-crisp and a w8-at-worst-
phase control that must stay green through any fix, plus two below-grading-floor bars
(6px/4px) that keep the user-visible pointed-end regime in the picture without grading.
At HEAD: **30/43 = 69.8% corner recall, RED** (gate ≥80%), boundary gates green.
Registered tier 0 + `KNOWN_DEFECTS` for the span of one commit. (Authoring trap worth
one line: rotated bars authored at width exactly 3.5 viewBox units compute a 6.99…px GT
short side from float normalization and `CORNER_MIN_EDGE` 7 silently drops their caps
from grading — the red bars graded n/a until authored 3.51 = 7.02px.)

**Measured loss anatomy (capDiag.ts, kept as the repro artifact).** Stages A/B are
nearly clean — apex evidence sits 0.4–1.9px from every authored corner — and the loss
is three families with ONE root: inside a cap narrower than ~2·`CORNER_WINDOW`, every
cap vertex sees BOTH shoulders through the ±4px window and reads a diluted 60–90°
mixture, so the run structure (and with it apex count + placement) is staircase-phase
lottery. (1) ONE apex — the 45°/fused regime, the row's original mechanism: the far
corner bevels away. (2) THREE apexes — a spurious mid-cap staircase vertex survives
`CORNER_MERGE` 3 at 3.6px spacing, the fit pins all three, and the cap's turn splits
38–52° per node: every corner present, none reads ≥60° sharp (the exact "extra apexes
poison joints" failure §10.6 measured when it rejected the two-scale union). (3) TWO
apexes ~1px off the true corners: the cubic fitted over the ≤7-point cap arc bends its
end tangents and a true 90° corner reads 45°.

**What shipped (`planarFit.ts`: `resolveLoopCaps` + cap-aware snap + cap line pin,
inside `fitCorneredLoop` — API unchanged).** Sub-threshold runs join across gaps ≤ 6
into apex GROUPS; each group is re-read with ARM-ANCHORED evidence: seed a 6-vertex
line fit 10 steps outside the group center on each side (the long edges are the most
reliable objects in the neighbourhood), reject unless both seeds are collinear within
`SNAP_COLLINEAR` (a checker cell or gear tooth wraps other corners into the seed
window and fails HERE — that guard, not a size threshold, is what keeps the resolver
off working art), then extend each line inward RE-FITTING as vertices join (fixed seed
slope is step-phase noise on low-angle staircases) until deviation > 1.2px — the stop
lands at the true corner. Classify as CAP iff the arms are anti-parallel ≥150° (a bar
end U-turns; a gear root→tip zigzag nets ~13°), the stop-to-stop chord is cap-sized
(3–10px; a rasterized tip plateau is ≤2px and stays a tip), and the interior is FLAT
(≤1.3px from the chord — a sharp-star tip V dips far below its shoulder chord; this is
what makes a cap a cap). A classified cap contributes exactly TWO corners, each
snapped to the intersection of its long-arm line with the cap-chord line (fitted over
the whole group interior — both corners' evidence pooled), displacement-capped at
2.5px, and the cap arc is emitted as a straight LINE (§10.6 swept a blanket short-arc
line preference and measured it WORSE on gear-teeth; this one is evidence-gated to
classified caps only). Any classification failure leaves the detector's apexes exactly
as they were.

**Calibration (swept one-at-a-time on the real pipeline, watchlist in the columns).**
Every ±1-notch variation of the constants measured IDENTICAL across bar-caps,
gear-teeth, sharp-star, checker, cross-bars and hairlines — the values sit on a
plateau — except the arm-extension tolerance, whose sweep bounds are real: 1.0 costs
bar-caps chamfer (0.14 → 0.16, extension stops early on phase-.5 chatter — an AA edge
at a half-pixel phase CHATTERS ±1px about its mean line, which is noise, not a
corner), 1.4 starts eating gear-teeth corners (51 → 49/60). Resolver OFF reverts
bar-caps to 30/43.

**After @512.** `bar-caps`: corners **30/43 → 43/43 (100%)**, chamfer 0.22 → **0.14**,
in-case controls 7/7 unchanged; `KNOWN_DEFECTS` entry deleted by the CI contract. The
watchlist is measurement-identical: gear-teeth 51/60 (85%, margin 5) at chamfer 0.18,
sharp-star 11/11, cross-bars 10/10 at 0.34/0.54, checker 3556/3588 (99.1%) at
0.00/0.00, gradient-flat 6/6, radial-glow paint gate green. Suite 282/280/0 (2
skipped), golden byte-stable — no re-bless. A/B corpus vs the frozen `before-caps`
snapshot: **2 of 42 variant files changed — hairlines.flat + hairlines.grad, the one
corpus case with sub-7px caps** (its 6px bar ends now square; chamfer 0.41 vs 0.38
before, both far inside the 1.0 gate); everything else byte-identical. Review in
/labs/ab → Vs snapshot → `before-caps`.

**Residue (not gated red anywhere).** (a) `hairlines`' 4px bar at phase .76 still ends
in a 1px nub: its fused-apex fit pinches, the planarAssemble AREA GUARD (correctly)
emits the exact staircase, and that staircase faithfully includes a 1px AA notch in
the raster cap — the resolver declined the 3–4px cap at that phase, and chasing it
below `chordMin` 3 is the measured guard against splitting eroded star-tip plateaus
(§10.2's 1–2px shoulder pairs) into false corner pairs. Sub-floor thin bars are the
§0 #6 family. (b) Caps on OPEN edges (a bar ending at a junction, the
`fitCorneredOpen` path) never enter the resolver — no case demands it (cross-bars is
10/10); the class fix would mirror `resolveLoopCaps` there. (c) `bar-caps` is NOT in
`AB_CORPUS` (same §10.5 reasoning: a case absent from frozen manifests breaks AbLab's
snapshot compare; add at the next natural re-bless).

---

## 11. Soft-alpha feather (§0 #13) — the alpha-aware blend endpoint (2026-07-28)

**The defect (user-reported 2026-07-21, §0 #13).** An AI-export PNG ("100 years tour",
2510×1074) surrounds its opaque letters with a 3–6px alpha feather. quantize slices that
ramp into a family of translucent shell clusters (10 of 12 clusters on the repro);
they merge into one surviving RGBA palette entry that traces as a translucent sliver
layer hugging every letter edge — at HEAD before this fix: **66 subpaths / 264 nodes,
α-mode 222, share 0.93%** (the §0 row's original 54/208/α188 had drifted with
§10.3–10.5; same mechanism). No dial removed it: `minShare` cleared, modal protection
held (75 exact repeats ≥ minRegionArea 50).

**Why classifyBlends could not see it.** The blend model explains an entry as a point
ON the RGB segment between two accepted colours. A feather's second endpoint is
TRANSPARENCY — there is no second colour — and its RGB is a 3-way mix (parent hue ×
under-glow × alpha ramp) measured **13.5–21.2 RGB** off every accepted-pair segment
(eps 10). The candidate fix's other clause ("RGB explainable as parent×t toward the
local composite") was killed by the same measurement: a per-pixel RGB(α) ramp fit
extrapolated to α=255 lands **18.8–101 RGB off the parent**. RGB cannot gate this
class; it is only good for ROUTING (nearest-RGB sends every feather cluster's pixels
100% unanimously to one survivor).

**The shipped gate is pure alpha-distribution evidence** (`paletteSegment.ts`):
`regionAlphaStats` (per-label α mode / mode-share / std over kept pixels) feeds a
`feather[]` flag — `αmode < 255 && αstd ≥ FEATHER_ALPHA_STD(10) && αmodeShare ≤
FEATHER_MODE_SHARE(0.15)` — and `classifyBlends` gained a second acceptance path: an
entry that is edge-local, has no real-region evidence, is NOT pair-explainable, and
carries the feather signature dissolves into the nearest ACCEPTED entry by RGB
(count-descending order guarantees the opaque parents are accepted before their own
shells). The existing pre-drop relabel machinery absorbs the pixels; the modal
exemption auto-drops with `blend=true`.

**Calibration (the separator, measured with margins).** A feather RAMPS; an authored
translucent flat is ONE alpha. Repro feather clusters: αstd min 16.1 (survivors
30.7/25.7), αmodeShare max 0.06. Healthy side (synthetic control: authored flats at
opacity 0.55 over transparency, plus their AA fringes): authored flats αstd 0.0–0.3 /
modeShare 1.00, worst healthy fringe αstd 6.6 / modeShare 0.38. The thresholds sit in
the gaps: **10** is 1.6× below the defect's min and 1.5× above the worst healthy
fringe; **0.15** has 2.5× margin both sides. Fully-opaque art has αmode 255 everywhere
⇒ the gate is categorically inert on every gated corpus (truth gate rasterizes on
white).

**After.** Repro: **2 items / 230 nodes** (`#73dbff` + `#ffffff`, both opaque) — the
sliver layer is GONE, and the result beats the user-approved delete-the-swatch
workaround (locked 2-colour palette: 242 nodes). Control: both authored translucent
flats survive at exactly α140. Corpus: A/B vs `before-feather` **0/42 variant files
changed**; suite green (281 tests incl. the new `test/palette-feather.test.ts`, which
pins the discrimination BOTH ways — the feather fixture documents that colour and
alpha must be decorrelated, and that a constant-colour rim manufactures flat-interior
`real` evidence from its own sub-α-mask neighbours). `src/devtest/featherDiag.ts` is
the calibration instrument (per-cluster table + fix simulation on repro & control).

**Open risks (named at ship).** (a) A genuinely AUTHORED soft glow/drop-shadow over
transparency shares the feather signature and now dissolves into its parent — same
output as the manual workaround, but a behavioural change for such art; the locked
palette (PaletteEditor) bypasses `classifyBlends` and remains the override. (b) Single
repro: no second alpha-feather PNG exists in the corpus (Headphones/Schild measured
fully opaque); the healthy side is calibrated on the synthetic control + the
categorical opaque-art guarantee. (c) The α≥128 mask clamps measured dispersion; a
sub-1px feather could dip toward the 16.1 floor — 10 keeps 1.6× margin there.

---

## 12. The low-res lane, and the scale-blindness family closes (§0 #6 + #11, 2026-07-29)

Closed together because they were WRITTEN as one disease — "the segmentation floors are
absolute pixel counts, blind to resolution" — and the first thing this exit did was gate
and then MEASURE that claim. The measurement (the §10.5→§10.6 lesson, third time now)
falsified it: the absolute floors were the proximate killer for NONE of the four driver
cases. Four distinct mechanisms, all resolution-LINKED but none "just scale the floor".

### 12.1 Phase 0 — the lane: nothing below 512 was gated

Every boundary limit is in pixels and was calibrated @512, so the whole family below 512
had no red number to beat. `truth-gate.test.ts` now runs a second loop — `truth @256:` —
over `LOWRES_CORPUS` at `LOWRES_RES` 256 with `LOWRES_TOL`, all defined and documented in
`truthCorpus.ts`; `calibrateLowres.ts` is the calibration artifact (tier 0 in full + all
106 flat twins swept @256, the §9.6/§10.3 recipe: read limits off the healthy population,
let the failures land red).

- **Tier 0 @256** (hairlines excluded): chamfer max 0.46, p95 max 1.10, parsimony max
  1.77 — the @512 limits (1.0/2.5/3.0) hold with ≥ 2× margin, so the lane keeps the same
  absolute numbers, derived from @256 data rather than inherited.
- **Tier 2 @256** (the three droppers excluded): chamfer max 0.60, p95 max 2.53 (rugby-
  football), parsimony max 1.43 → lane limits 1.0/4.0/3.0. NOT tier 2's @512 numbers
  (0.35/1.2): at 256 the same art carries 2× the relative AA and the whole population
  shifts up.
- The sweep DISCOVERED two unlisted members of the family — `parachute` 9/10
  (#00a6ed 99px painted #5092ff, ΔE 28.7) and `beverage-box` 6/7 (#d3f093 481px painted
  #c3ef3c, ΔE 36.4, p95 8.24) — exactly the "there may be undiscovered ones" prediction.
  Lane = 16 tier-0 cases + 3 drivers + 4 healthy controls (pencil — the §9.4
  protected-tip case, rugby-football / nazar-amulet / violin — the calibrated tails).
- The corner gate is tier-0-only in the lane: tier-2 corner recall is ungated at EVERY
  resolution and measures poorly at both (flute 3/10 @256, 0/9 @512) — a
  resolution-INDEPENDENT behaviour that a low-res lane would misattribute.

### 12.2 Phase 0 — the instrument, and the histogram that killed the hypothesis

`src/devtest/lowresDiag.ts` (gearDiag's recipe one stage earlier) replays
`segmentFlatPalette` tap by tap — assign / blends / share / mode / restore / despeckle /
heal — then the doc build (fit → beautify → weld → materialize), and reports per authored
colour the fraction of its pixels still labelled within ΔE 4 (the region gate's own
MATCH_DELTA_E) after each stage. Where each driver ACTUALLY died @256:

| case | written hypothesis | measured mechanism |
|---|---|---|
| flute `#974827` | share floor + flat-interior floor | dead at `assign`: k-means starves a 355px cloud of a centroid — both browns land in ONE cluster (`#8c3c26`), so §9.7's anchor VETO has no merge event to refuse. The floors never even saw it (flat-interior 176 ≥ 50 would have protected the entry, had it existed). |
| parachute `#00a6ed` | (undiscovered) | same: the cyan lands inside `#5092ff`'s cluster (`#4a95fd` centroid) |
| hairlines bars | floors eat sub-pixel bars | `classifyBlends`' greedy count-descending ORDER inverts: the bars' 25%-grey blend cluster (1,009px) outranks the pure bar colour (816px), is processed first, cannot be explained (its second endpoint is not accepted yet), and survives as a fake palette colour; then the mode-snap census renames the bar entry to that grey (the §9.5 "renames red to grey" failure one stage later); then the 45° diagonal — 4-DISCONNECTED by construction — fragments into ~6px pieces under the restore/despeckle grouping and vanishes |
| beverage-box `#d3f093` | (undiscovered) | segmentation KEEPS the straw (~700px, entry protected); the §10.4 converged-junction weld deletes the region: the straw is a LOLLIPOP (outline 129px and neck 2.8px between the SAME vertex pair), the neck is contracted, and the "both endpoints fused ⇒ self-loop ⇒ contract too" rule then deletes the 129px outline — the label's only loop — so index.ts silently skips the label |

### 12.3 The fixes (each validated against its histogram row)

**(a) Anchor-guided cluster SPLIT in `quantize` — the dual of §9.7's merge veto.** The
veto can only refuse a merge event; at low res there is none. Same evidence, same
thresholds: a cluster holding ≥ 2 flat-interior anchors (≥ `keepDistinctMinArea` px
each, §9.4's criterion) with pairwise ΔE ≥ `ANCHOR_DISTINCT_DE` (4.0) is two authored
colours — split it, each member colour to its nearest anchor, centroids rebuilt as
count-weighted means (the mode-snap picks the final hex regardless). When k-means
separates properly every cluster holds one anchor and the split is a no-op — schild's
tonal noise (ΔE 0.5) and aurora's ramp bands (ΔE 2.9) sit under the ΔE floor and merge
exactly as §9.7 calibrated. flute 8/9 → **9/9**, parachute 9/10 → **10/10** @256.

**(b) `classifyBlends` fixpoint + census guard.** After the unchanged greedy pass, the
classification iterates to a FIXPOINT (pass-synchronous, the accepted set only
shrinks): each still-accepted entry is re-tested against segments between two OTHER
currently-accepted entries — so an entry accepted only because its endpoint came later
in count order still dissolves. Routes are path-compressed (chains are acyclic — a
route target always dissolves in a strictly later pass than its source), preserving
§9.5's endpoint-routing principle transitively: hairlines' mid-grey → 25%-grey → the
BAR colour. And `snapPaletteToModes` now excludes pixels that arrived via blend
dissolution from the mode census — a routed-in coverage mixture is not a candidate
design hex, and at 256 it OUT-COUNTS the entry's own colour (1,006 vs 816). When the
greedy order was already right, pass 2 finds nothing and the output is byte-identical;
the §11 feather clause runs in pass 1 only, its calibration untouched.

**(c) Restore for 4-disconnected thin features.** `restoreErasedComponents` now groups
8-connected (a 45° chain touches itself corner-to-corner only — under 4-connectivity
the diagonal was ~45 fragments of ~6px, under any floor), measures erasure as an
EROSION FRACTION (`RESTORE_MAX_SURVIVAL` 0.3 — one surviving pixel would otherwise
poison a whole chain's rescue; §9.5's own argument quantifies the gap: a majority vote
melts ~a perimeter's worth of a real blob, survival stays ≥ ~0.7, while a thin feature
keeps almost nothing — the diagonal keeps ~2%), and 4-CONNECTS what it restores
(pinch-fill: at each diagonal step, claim the side pixel whose source colour is nearer
the component's mean — without it the restored chain is a checkerboard-pinch junction
storm: hairlines parsimony 1.1× → 4.7×). `despeckleComponents` deliberately STAYS
4-connected — see §12.5. hairlines @256: chamfer 0.93 → **0.31**, p95 9.69 → **0.74**,
parsimony **1.3**; @512 byte-stable (restored bars are axis-aligned — no diagonal
steps, the pinch-fill is inert by construction).

**(d) Lollipop veto in `weldJunctionClusters`.** A cluster whose fusion would pinch
together the endpoints of an edge LONGER than the weld radius is a lollipop neck, not
a rasterized crossing — the fuse is skipped and its micro-edges stay real edges (the
same safe fallback the over-spread span rule already uses). A true §10.4 crossing is
unaffected: its second edge between the fused pair is itself micro (overlap 4/4 at
both resolutions, cross-bars 10/10). beverage-box 6/7 → **7/7** @256 — and the same
deletion turned out to exist @512 (§12.4).

### 12.4 Discovered while verifying: §10.4 had already broken beverage-box @512

The @512 watchlist run showed beverage-box 6/7 — and a worktree probe at HEAD showed it
was **5/7 BEFORE this work**: §9.7's "tier 2 = 437/437" had silently rotted. Bisect:
green at e549b29 (§10.3c), red at fc7b7e9 (§10.4, 2026-07-21) — the straw (`#d3f093`,
the weld lollipop deletion, fixed here by (d): 6/7 @512 now) and `#990838` (522px
painted white: its doc item exists but collapses to a ~77px² sliver, 88px rendered).
The `#990838` collapse is §10.4 reseat/chord territory, distinct from this family — it
gets its own §0 row (#14) instead of a drive-by fix. Tier 2 being ungated in CI is how
a 2-region regression survived five commits unnoticed; the @256 lane now gates
beverage-box-flat (and would have caught the straw half of this).

A first version of (d) kept the long edge but let the cluster fuse (both endpoints
dragged onto the fused point) — beverage-box @256 went green and the @512 watchlist
exposed the flaw before it shipped: a small blob's two ~33px arcs pinched into a
sliver. The cluster-fuse veto replaced it.

### 12.5 Rejected alternatives (measured, so they are not re-invented)

- **Scale-relative floors** (minShare / minRegionArea ∝ image area) — the WRITTEN fix
  direction, NOT BUILT: the histogram showed the floors were not the proximate killer
  for any driver. minShare is a FRACTION (scale-free by construction); minRegionArea
  feeds the Despeckle dial contract ("absolute px², reads the same across engines"),
  and scaling it would change every non-512 user trace for zero demonstrated wins. The
  honest residual: hairlines' diagonal survives the palette by a knife edge (modal
  count 50 vs floor 50 at despeckle 25) — if a future case lands on that edge, this is
  where to look, and the scale-relative floor is the first candidate.
- **8-connected `despeckleComponents`** — kept 8-chained AA shrapnel that survives the
  mode filter; each 4-fragment still becomes its own planar face: pencil-flat @256
  shattered into 166 fringe loops, parsimony 1.5× → **10.1×**. Reverted to
  4-connectivity; restored thin diagonals don't need it (the pinch-fill 4-connects
  them before despeckle runs).
- **Keep-as-self-loop lollipop guard** — §12.4; replaced by the cluster-fuse veto.

### 12.6 After (the numbers)

@256 lane (limits in `LOWRES_TOL`): every case green — hairlines **0.31 / 0.74 / 1.3×**
(was 0.93 / 9.69 / 1.1), flute-flat **9/9**, parachute-flat **10/10**, beverage-box-flat
**7/7** (0.23 / 1.02), controls byte-stable (pencil at exactly its pre-change
0.51 / 1.45 / 0.7). All four `KNOWN_DEFECTS_LOWRES` entries deleted by the CI contract —
the map is EMPTY. @512: the whole lane unchanged except `aa-seam` chamfer 0.22 →
**0.12**, p95 0.74 → **0.43** (the fixpoint routes the sliver's mid-blends to better
endpoints — the §0 #3 residue shrinks) and beverage-box 5/7 → 6/7 (§12.4). Corner
watchlist stable: gear-teeth 51/60, bar-caps 43/43, sharp-star 11/11, cross-bars 10/10,
checker 99.1%, hairlines @512 0.41/0.86. Paint gates green at both resolutions
(radial-glow 1.12/2.22 @512, 1.18/2.41 @256). A/B vs `before-lowres`: **0 of 42 variant
files changed** — the A/B corpus (all ≥ 512 native) is categorically untouched. Full
suite green (305 pass / 2 skip incl. the 22 new `truth @256:` tests); goldens untouched,
no re-bless.

### 12.7 Open residue (named, not hidden)

- The **0.25px bar** (hairlines @256) stays untraced: at 25% coverage its pixels are
  paler than healthy AA fringes — a palette segmenter recovering it as a solid 1px bar
  would render DARKER than the source does. The truth gate's visibility filter (§9.6)
  already excludes its boundary as invisible, which is the same verdict from the
  scorer's side: a fully sub-half-pixel feature is below the information floor of this
  representation.
- **flute-flat corners 4/10 @256 / 0/9 @512** — resolution-independent tier-2 corner
  behaviour, ungated everywhere, out of this family (§12.1).
- **`#990838` @512** — §0 #14, the remaining §10.4 damage.

## 13. The rim-cap bulge — a re-seated third edge kept handles sized for its old span (2026-07-29)

**Symptom (user-reported, /labs/ab on `bg-ramp-twin`, flat variant).** The left disc is
not round: a pointed "beak" pushes out of its right rim exactly where a posterization
band boundary crosses. The right disc, same image, same trace, is perfectly round.

**Not a regression.** The flat trace is byte-identical to the `before-lowres` snapshot
@5143c64 — the A/B row's "unchanged" tag is honest. §12 did not cause it; it had simply
never been looked at, because **no gate scores it**: `bg-ramp-twin` is registered
`gradients: true` (a flat trace of ramp art is bands the authored SVG does not contain,
so boundary agreement against the answer sheet is meaningless there). With gradients ON
the disc is ONE closed edge and 1a snaps it to a circle (r 52.16 vs authored 52). The
defect exists only on the path nothing measures.

**Cause — §10.4's third edge is anchor-shifted with frozen handles.** Flat mode
posterizes the ramp, so two band boundaries plant junctions on the disc's rim and the
rim becomes four open arcs. `reseatJunctions` correctly re-seats the two junctions
bounding the right cap onto the line∩circle intersection (both land on the true circle):

```
v9  (191.00,234.00) → (194.00,240.91)  move 7.53px   line x=194 conf 230 × circle r=52.22 conf 108
v10 (189.00,282.00) → (192.00,277.71)  move 5.23px   line x=192 conf 230 × circle r=52.72 conf 105
```

At each junction the pass re-emits only the **two strongest** arms from their primitives.
The cap edge loses both votes — its own circle arm scores conf 50 at v9 and is too short
to claim a primitive at all at v10, against the long rim arc's 108 — so it falls to
`applyEnd`'s third-edge branch: `shiftNodeTo`, anchor moved, handles translated rigidly.
Its chord shrinks 48px → 37px while the handles keep their old length, and the cubic
balloons. Measured on the 41° cap, radial error against the authored circle:

| `edge#18` | anchors | fitted curve |
|---|---|---|
| baseline | 0.68px | **3.26px** |
| re-seat off (`planarFit.junctionReseat: false`) | 0.12px | 0.12px |

**Why the repair that exists could not fire — and why only ONE disc is affected.** §1d
(`snapCoCircularLoops`) is built for exactly this shape: a rim split into arcs, fitted to
one circle. It gates on max radial deviation of the **flattened fitted** loop, so it eats
the self-inflicted bulge:

```
green loop  turn 32.6° ok   circle (144.7,256.1) r=52.35   dev 2.234 > tol 1.500  → VETOED
blue  loop  turn 50.2° ok   circle (368.0,256.1) r=65.93   dev 1.453 ≤ tol 1.500  → snapped
```

The blue disc has the identical defect (its own worst arc bulges 1.53px pre-snap) and
clears the fidelity by 0.05px. Green misses by 0.73px and keeps four independently fitted
arcs. One image, two discs, opposite outcomes from the same mechanism — the tolerance
edge is the only difference. With the re-seat off, green's loop deviates 0.682 and 1d
fits (144.1, 256.1) r=51.97 against the authored (144, 256, 52).

**The fix — `reshapeTerminalTo` in `planarReseat.ts`.** A moved anchor re-maps its
terminal segment instead of dragging it: the control polygon is carried by the similarity
taking the old endpoint onto the corrected one about the inner anchor, with the component
PERPENDICULAR to the chord scaled by k² rather than k. A circular arc's sagitta goes as
chord²/radius, so a pure similarity preserves the segment's *shape* when what must be
preserved is the *curve it is a piece of* — it would inflate the radius as the chord
shrinks. Exact for a straight segment, exact for a circular arc.

Two guards keep the blast radius small, and **both were forced by measurement, not
foresight**:

- **A terminal segment with no handles takes the plain shift unchanged** — most edges,
  untouched.
- **Only the SHRINKING case is corrected (k < 1).** See "Rejected" below: applying k² on
  GROWTH regressed `hairlines`.

**Rejected — k² on a lengthening span (caught by the user in /labs/ab, not by any gate).**
The first version scaled the perpendicular component by k² in both directions, clamped to
k ≤ 2. It put a visible S-kink in `hairlines`' straight diagonal where it crosses a bar:
the crossing leaves a 9.9px edge whose fit carries a sub-pixel wobble, the correction
LENGTHENED it, and k² multiplied that wobble by up to 4×. Worse, the bend then failed 1b's
straightness test, so the edge kept handles it had previously had *dropped* — the kink
survived to the output:

```
edge#8  (9.9px, across the bar crossing)
before      (229.00,184.00) hOut=-               (232.11,193.41) hIn=-           ← straight
k² on grow  (229.00,184.00) hOut=3.0px@perp0.04  (232.11,193.41) hIn=3.5px@perp-1.50
```

The asymmetry is the point: a shortened span leaves handles too LONG — the segment bulges
outward past its own curve, visible and gate-poisoning. A lengthened span leaves them too
SHORT — the segment flattens toward its chord, the conservative direction, and near-straight
fits depend on that. Correct the over-long case; leave the under-long case alone. With the
guard, `hairlines` is byte-identical to the baseline again and the disc fix is unaffected
(both ends of the rim cap shrink: k = 0.86 and 0.89).

**After.** The cap's curve error drops 3.26px → **0.40px**; the loop then deviates 1.155
< 1.5, so 1d fires and the whole rim becomes one circle (every arc ≤ 0.40px). Blue
improves too (1.453 → 1.303), i.e. it stops riding the tolerance edge.

| | cap curve err | 1d loop dev | outcome |
|---|---|---|---|
| before | 3.26px | 2.234 (> 1.5) | four fitted arcs, beak |
| probe (linear handle rescale) | 0.69px | 1.155 | 1d fires |
| shipped (k² perpendicular) | **0.40px** | **1.155** | 1d fires, rim = one circle |

**Collateral (A/B, 21 cases × flat+grad vs `before-reseat-cap`).** **4 cases moved**
(6 before the shrink-only guard; `hairlines` and `nebula` returned to byte-identical):
`bg-ramp-twin` (−6 path commands — the snapped circle is cheaper), `petals`,
`gradient-flat`, `flute-flat`. No path-count change anywhere; the three collateral ones
are sub-pixel nudges on smooth arcs, rendered and inspected at 9× (total |Δ| vs the
baseline render: petals 18, gradient-flat 42, flute-flat **1** px-equivalents). Full suite
**307 tests, 0 fail**. Tier-0 ground truth: every case byte-identical in score except
**`gradient-flat` @256 — the case §10.4 itself was built for — which IMPROVES** (width
0.68 → 0.67, hausdorff 2.09 → 2.08). No `KNOWN_DEFECTS` movement in either direction.

**Open (named, not hidden).** The mechanism has **no gated witness**. `bg-ramp-twin`'s
flat trace is unscorable against ramp art by construction, so this fix is protected by
nothing: the driver case that *would* gate it is flat art where a plain disc is crossed
by a plain bar — authored circle + rect, fully scorable, the §10.5 `gear-teeth` recipe.
Until that case exists, the regression that produced the beak can return silently.
