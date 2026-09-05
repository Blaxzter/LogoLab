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
| 8 | **Sub-pixel edge placement** — PARTIALLY CLOSED 2026-08-05 (§15.7): `planarSubpixel.ts` displaces every edge chain onto the AA's iso-0.5 crossing before the fit (shared edges stay shared by construction), with three measured-in guards (corner self-guard, apex tangent pin, anchor flatness) — the tangent pin gained a fourth bound the same week, after it closed a letterform counter (§15.8, below). Fine-end error collapsed 2–3× (bar-caps 0.089, gear 0.080, sharp-star 0.068 ref-px @1024); `concentric` + `sharp-star` deleted from the scale gate's KNOWN_DEFECTS by the CI contract; gear-teeth corner recall 51→52/60. WHAT REMAINS OPEN: the four coarse-end cases (`overlap` , `aa-seam`, `petals`, `band-cross` — @256's AA is too wide for the guards' fixed sampling geometry, an audit-ART-list follow-up), two witness corners @512, and chupa-chups' small-feature zone trading 0.06px mean @1024 | `test/scale-invariance.test.ts` KNOWN_DEFECTS (4 entries left, only shrinks); witnesses in `examples/logos/` | gate: coarse ≤ 2.0 · max(fine, 0.15) ref-px | **§15**, instrument `scaleDiag.ts --lattice` |
| 9 | **Gradient banding** — a stack of translucent gradients traced as regions the art does not contain. *Deprioritised: off the product target* | `fluent-olive` (tier 1, gated, in `KNOWN_DEFECTS`); `black-circle` (ungated) | olive p95 97px; black-circle 31.3px invented; 10.8× invented vs flat | §8.3, §8.5 |
| 10 | **Dropped gradient boundary** — verified-visible authored edges simply lost on gradient art. *Deprioritised, distinct from banding* | `speaker-low-volume`, `chart-decreasing` (tier 1, ungated) | missed 16.9 / 15.3px — re-verified 2026-07-15 under visibility-aware scoring (§9.6): survives occlusion exclusion, so it is REAL | §8.5 |
| 15 | **CLOSED — not planned** (2026-08-23). The turn IS under-read on the lattice (§21, unretracted: `detectCorners` reads two chords ±4 POINTS on the integer staircase, and recovery falls from 96.3% at 90–105° of authored turn to **55.1%** at 60–65°). The ISSUE is what closed, on four grounds: its target metric is corner RECALL, which has no precision term — so “find more corners” and “invent corners” are the same instruction, and §22 optimising it produced visible kinks; a missed 60° corner is a gentle bend drawn as a gentle curve while an invented one is a visible kink, so it spends the detector's budget on the invisible direction; row #16 shows the tracer already errs the OTHER way on the SAME knob (12 invented corners on art with none), so the two rows pulled one lever in opposite directions; and the framing was refuted twice (§21's seam truncation, §22's reading) with a named witness authored at exactly 60.0° — the detector's bar AND the scorer's bar — which no reading can reliably clear. The one defensible remnant is `gear-teeth` **53/60**, where the corners are unambiguous (67.3° roots on a mechanical shape); it carries on as a narrow case, not a corpus-wide detector change | `corner-turns` (tier 0, gated — kept: an authored-turn sweep is a good corner-recall case regardless); `gear-teeth` 53/60 | the cliff, unchanged and still measurable with `needleDiag --turns` / `turnDiag` | **§21**, **§22**, issue [#23](https://github.com/Blaxzter/LogoLab/issues/23) (closed not-planned). **Corner work continues at row #16** |
| 16 | **The trace INVENTS corners on smooth art** — sharp nodes the authored geometry does not contain, on ellipse ends and straight→arc blends. Newly VISIBLE rather than newly introduced: `cornersRecovered` is a recall number with no precision term, so this was free by every gate here until §23 built `cornersInvented`. It is the measured form of “every nice radius has a kink in it”, and it is why §22 was rejected on sight after passing CI. The metric asks a like-for-like question at the corner's own scale — the traced node's C⁰ kink minus the AUTHORED boundary's turn over ±1px — and exempts the four places a trace is right to corner (canvas border, occluded boundary, traced junctions of degree ≥3, authored crossings) | `smooth-radii` (tier 0, **gated**, authored for this: art with NO corners at all — ellipses 1:1→1:8 in both orientations, rounded rects at 2/3/5/8/12px radii, curvature-ramp eggs) | **12** invented on a case with zero authored corners; corpus-wide over the 23 gated tier-0 cases, flat lane: p50 0, p90 2, max 12, **18 over 3 cases** (`smooth-radii` 12, `hairlines` 4, `peak-drop` 2). The rejected §22 reading takes `smooth-radii` to **18** | **§23**; instrument `src/devtest/kinkDiag.ts` (`--gate`, `--probe x,y`, `--compare`). Gate scope today: FLAT art, @512 only — gradient banding and the halved radii at @256 are each their own calibration (§23.3) |
| 17 | **A circle's whole boundary sits off its authored radius by a near-constant amount** — a BIAS, not a wobble: the trace is perfectly round and in the wrong place. Found by §24's circle lens on the day it landed, and only because that lens reports the mean residual SEPARATELY from the spread — the raw p95 reads 0.81 and looks exactly like the ring wobble, while the co-circularity spread is 0.03. Every other gate is blind: 0.8px is far inside chamfer/p95, and the shape is still round, so no corner or region lens sees it either. NOT a size law and not yet explained — the two worst circles are the same size and disagree in SIGN. Untouched by §24, whose family pass only reaches circles cut into arcs | `acute-counter` (tier 0, gated, passes — the gate is on spread, not bias) | seven authored circles read |bias| 0.09–**0.79**px: r=40.5 at **−0.79** (traced inside) against r=39.5 at **+0.19** (outside) and r=58.6 at +0.16 | **§24.3**, **§25.3**; instrument `ringDiag --circles` (the `bias` column, and since §25 the `centre` / `round` columns — a circle in the wrong PLACE is a third term `spread` folds in, and on `olympic-rings` it is now the whole residue: measured identical under an algebraic and a geometric fit, so the evidence is displaced and no estimator recovers it) |

### 0.1 Premise re-check of the four open issues (2026-08-23)

The issues were filed 2026-08-04/05, **before** §15, §17, §18, §19, §20 and §23 shipped.
§16 is the precedent for doing this first: §0 #14 had already been fixed by §15 and nobody
noticed until it was re-measured. Every claim below was re-run against the current tree;
the instruments named are new and live in `src/devtest/`.

| issue | premise | verdict |
|---|---|---|
| **#14** THROUGH_SPAN | same junction reads 21.4° → 13.2° → 13.2° → 7.1° @256/512/1024/2048; line-vs-circle winner flips | **holds exactly** — junction (209,90)→(418,180)→(836,359)→(1671,718), turns and both dev pairs (circ 0.79/line 1.25 @256, circ 1.99/line 0.67 @2048) reproduce to the decimal (`threadDiag --case band-cross`) |
| **#14** THROUGH_SPAN, *consequence* | "@256 it trips the 20° gate and the junction is DROPPED (15/16 move)" | **STALE** — @256 now moves **16 of 16**: 15 by §14 thread and **1 by §17 apex**. §17 landed 2026-08-06, the day after the issue, and catches exactly the junction the 20° gate refuses. The defect is now "same art routed down a different branch per raster", not a lost junction |
| **#14** CHORD_MAX_LEN | dead above ~1024 on its own driver case (32.9px @512 → 130.7px @2048 > 80) | **holds** — `chordDiag`: gradient-flat has 3 candidates at every raster; 1 straightened @512 (len 32.0) and @1024 (65.2), then **0 straightened / 3 too-long @2048** (131.1). Counterfactual `--cap 400` recovers exactly the 1 |
| **#14** coarse-end tail | 4 scale KNOWN_DEFECTS remain (overlap, aa-seam, petals, band-cross) | **holds** — all four still listed, gate 7/7 green |
| **#10** rings | 69 edges / 46 junctions @512; §1d / §14 / §17 all aim here and none holds | **held; now CLOSED** (§24). The premise was right and §0.1's own explanation was half wrong — see the correction below |
| **#9** border | `collectBoundary` drops every query within BORDER_EPS 1.5px; no gate can see the border | **holds** — the exclusion is intact and two-sided. `borderDiag` measures the hole at **4,489 transversal band samples** on the fixtures alone |
| **#9** symptom | "odd corners and ragged edges", witness `logo-mastercard` | **half REFUTED on the witness** — see below |
| **#15** knife edge | shaded tones ΔE 4.44–11.09 / RGB 13.5–34.4; flute-flat's authored pair at ΔE 4.5 must survive | **holds** — tones reproduce exactly (4.44 / 6.80 / 11.09), and `fluent-flute-flat` passes region recovery @512 today (truth gate 73/73), so it is a live constraint, not an already-failing one |
| **#15** "no gated case exists" | author one first | **held; now closed** — `shaded-ink` authored, gated, RED |

**#10 — CLOSED 2026-09-03 by §24.** The paragraph below is kept as written because its
correction is the useful part. Its first half stands: §14 and §17 are structurally inert on
this art, not mistuned. Its second half — "it is one gate", the corner veto, and the fixes
that follow from that — was **refuted by the counterfactual the option switch already
allowed**. `planarFit.cornerVeto: false` leaves `olympic-rings` BYTE-IDENTICAL (212 nodes,
69 edges, 46 junctions): all 24 loops simply fall through to `dev-exceeds-budget`, which
declines them too. The veto was only FIRST in the queue, and `ringDiag` reports the first
gate that declines — which is not the same as the gate that matters. The same switch snaps
992 of `checker`'s loops into discs, so the veto is doing its job and both prescriptions
below ("loop-local turn, or excluding junction corners") would have bought zero here while
re-opening the scalloping. What was actually wrong is that a ring is not a loop: its face
boundary carries TWO radii (outer arc → cap → inner arc → cap) and its arcs are spread over
several faces. §24 has the numbers.

**#10 — the answer to "why does none of it hold here" is measured, and it is one gate.**
`threadDiag` on `olympic-rings`: every edge on the mark is ΔE ≥ 60 (five saturated rings on
white), and the §14 rank only considers a junction with at least one **weak** arm (ΔE ≤ 12).
It therefore has **zero candidates**, and **0 of 46 junctions move** — §14 *and* §17 are
structurally inert on this art, not mistuned. `ringDiag` then settles the third mechanism:
of **24** candidate region loops, **24 are rejected by `corner-veto`** and not one reaches
the circle fit, at turns of 67–158°. The veto exists to stop a checker cell scalloping into
a disc, and it reads `maxTurnRad` over the WHOLE loop — on a crossing-dense mark the loop's
turn is dominated by its own junction corners, so a ring split by crossings is guaranteed to
read "polygon". That is a structural mismatch, not a calibration one, and it is a different
fix from the one the issue's "the snap's acceptance may not fire" line anticipated.

**#9 — the corner half of the symptom does not survive a like-for-like test.** The first
`borderDiag` draft scored 11 invented corners on `mastercard` at excess 87–120°, all on the
canvas rect. Every one was a **frame closure**: where art meets the canvas edge the traced
region legitimately turns to run ALONG the edge — a real ~90° corner in the doc, and no
corner at all in the authored art, which simply continues off-canvas. Requiring **both**
arms to be transversal (the first draft tested only the out-tangent) takes mastercard to
**0**, the fixtures to **0**, and the whole 152-mark gallery to **9**. This is the same trap
the issue itself named — re-admitting the framing artifact — reached from the corner side
instead of the distance side. What remains is the distance half, and there mastercard is
**not** the worst case: it reads **1.27×** its own interior, against `wedge-counter` 4.70×
(fixture) and `langchain` 2.38× / `boeing-wm` 2.12× / `visa` 1.82× (gallery). 42 of 152
gallery marks reach the border at all. Per §17's lesson, **measure which mechanism a witness
shows before trusting the issue's framing** — the named witness is mid-pack here.

**New instruments** (all purely diagnostic; two production out-sinks, `onChord` and
`onArcLoop`, are undefined in production and the passes are byte-identical without them):
`src/devtest/borderDiag.ts` (#9), `src/devtest/ringDiag.ts` (#10),
`src/devtest/chordDiag.ts` (#14). `threadDiag` already covered #14's THROUGH_SPAN witness.
New corpus case `shaded-ink` (#15, tier 0, gated, in `KNOWN_DEFECTS` at 512 **and** 256).

Recently closed: **a small isolated feature swept away by the despeckle area floor**
(issue #8, user-reported from /labs/ab on `logo-ibm` — the ▼ peak of the m's middle
stroke, dropped by the flat trace and kept by the gradient one) — closed 2026-08-21,
**§20** is the record. The flat lane's `despeckleComponents` sweeps up sub-`minRegionArea`
connected components so anti-alias shrapnel does not each become a traced loop; the ▼ is
its own 26px component, isolated by the art's white stripes, and the broom could not tell
it from shrapnel. Phase 0 moved the goalposts twice: the handoff's `--despeckle 0` proof
does NOT attribute (the dial moves `minShare` AND `minRegionArea` together — a `--floor`/
`--share` 2×2 shows `minShare` **inert**, the ink entry holding 11.74% of the image), and
the earlier "no palette stage kills it" reading was an artefact of a whole-image survival
FRACTION — 26px of a 40,000px ink mask reads flat at every stage. ROI-scoped, the
component census names the stage outright: 24 → 32 → 32 → 26 → 26 px, then GONE at
despeckle; `restoreErasedComponents` is blind because the mode filter ERODED it rather
than erasing it whole. The fix is §9.4's flat-interior criterion asked per COMPONENT: a
sub-floor component with at least one full 3×3 source block of exactly its palette hex is
SPARED. Calibrated on a joint distribution, not a hunch (`lowresDiag --census`, 2,394
sub-floor components over 174 marks against 4×-supersampled truth): it fires on 46 and
**none of them is fringe**, worst `cov4` admitted 0.797. The intuitive axis — the share of
a component's pixels that are exactly its palette hex — was built, measured and
**REJECTED**: it resurrects 40–54 fringe components at every threshold while missing over
half the real ones, because a k-means centroid need not equal any source pixel
(mercedes-benz's greys read 0.000 at `cov4` 0.96). Ships as a ONE-SIDED veto that can only
spare (§17's `ARM_BOW` shape). Witness: ibm missedMax **17.84 → 3.55**, corners 120 →
**122/127**, chamfer 0.2409 → **0.2064** — what `--despeckle 0` bought, without lowering
the floor. Corpus-wide only **12 of 152** gallery marks change at all, 8 better, no mark
loses a corner, and the single regression is named (`soundcloud` +0.0011px chamfer).
Corpus case `peak-drop` (authored for this, tier 0, verified reproducing first — a 20-peak
rack straddling the floor plus an in-case AA-seam control), gate
`test/planar-peak.test.ts`. Golden corpus byte-identical; watchlist byte-stable; A/B pair
`before-ibm-peak` ⇄ `after-ibm-peak` moves 3 of 114 outputs, the third (`scale-blind`) a
gain that was not designed for. Residue in §20.4: features under ~30px² carry no 3×3
evidence and are still dropped, 88 of the census's 98 SOLID components need a TOLERANT
flat-interior test this deliberately did not attempt, and `scoreRegions`' colour keying
means a monochrome mark can lose whole components with the region gate green.

Recently closed: **the mastercard needle — a curved arm fitted as a chord** (issue #7,
user-reported from /labs/ab on `logo-mastercard`'s wordmark) — closed 2026-08-11, **§19**
is the record. `snapCornerToArms` intersects two straight arm LINES; on a curved arm that
line is a chord and the intersection slides ALONG the other arm — under §18's 2.5px
overshoot floor, or with its reach probe blinded because the ray runs along a real edge
(reach ≈ moved). The 'e' eye grew 2.1px white needles into its stems; the 'm' crotch held
the mark's one unrecovered corner. A measurably-bent arm (bow > 0.5, n ≥ 12) is now
modelled as its ANCHORED TANGENT — the window box-smoothed, extended while co-circular,
half-split, the tangent read as the tip half's direction continued by half the measured
half-turn (φ ≥ 10°, the curvature test a staircase cannot pass) — with a convex-only 45°
tip floor (holds `acute-counter` @256 at exactly p95 2.130 and sharp-star at 11/11), a
70° pin-turn floor (a pin that leaves a corner's turn near the 60° sharp bar rotates it
into reading smooth — gear-teeth's regime), and a >150° near-parallel guard (census:
3.6–5.1px slides on staircase jogs; `parallel` refusals 3 → 122, every one of those
slides gone). Three models were built, measured and rejected on the way (§19.3): Kasa
circles (collapse on ~8px windows), a sagitta-parabola tangent (over-rotates under AA —
acute @256 read the very p95 §18 refused), a coherence gate (non-separable at any K).
Witness: mastercard corners 48/49 → **49/49**, chamfer 0.2735 → **0.2680**, worst
invented boundary 2.17 → **1.30px**; corpus-wide the bow 0.6–1.0 census bucket goes mean
0.843 → **0.639px**, worse-than-lattice 220 → **136**. Corpus case `letter-joins`
(authored for this, tier 0, verified-reproducing before authoring), gate
`test/planar-needle.test.ts`; golden corpus byte-identical, watchlist byte-stable except
**gear-teeth 52 → 53/60** (a gain). Residue in §19.4: the short-arm blunt notch (144
census records, the 'a'-join's 2.55px), and crotch corners that place sub-px but read
< 60° sharp.

Recently closed: **an acute counter's apex reconstructed PAST the ink** (issue #17,
user-reported twice from /labs/ab on `logo-instagram`) — closed 2026-08-08, **§18** is the
record. `snapCornerToArms` intersects the two fitted arm lines, which is right for a
raster-ERODED tip (sharp-star 11/11) and wrong on an acute CURVED counter, where each arm
line is a chord leaning into the lens and the crossing lands px inside solid ink. Geometry
cannot tell the two apart — §17.1 already measured `bow` as not separable — so the fit now
consults the RASTER: how far the corner's own coverage actually reaches along the
reconstruction ray. Two hypotheses died on the way (the overshoot distance alone, which cost
an eroded spike its reconstruction 0.50 → 7.07px; and the MEAN coverage, which reads *higher*
on the worst cases because they cross the ink and come out the other side), and so did the
obvious correction (falling back to the lattice vertex: `acute-counter` @256 p95 2.13 →
**3.46**, worse than the overshoot it removed — it CLAMPS to the evidence instead). Corpus
case `acute-counter` (authored for this, tier 0), gate `test/planar-apex.test.ts`. Worst
overshoot past an authored tip 6.85 → **2.63px**; on real marks `logo-instagram` p95 **2.633
→ 1.506**, `coca-cola` chamfer 0.3350 → 0.3193 with corners 8/12 → 9/12 and −22 nodes,
`chupa-chups` 54/62 → 55/62, `firefox` 21/33 → **25/33** — no mark loses a corner, five gain.
A/B: 14 of 70 outputs move, and the only fixture among them is `sharp-star` gradients-ON
(flat lane byte-identical). Residue, named: ~2.6px of overshoot survives at the worst tip,
because the raster's evidence stops just inside the authored tip.

Recently closed: **a junction that IS a real corner of the art** (the other half of #15) —
closed 2026-08-06, **§17** is the record. §14 places a junction on a fit taken THROUGH it,
which only exists where the strong boundary continues; where it CORNERS, the chord-turn gate
correctly refuses (a through fit rounds the corner off) and the junction kept its integer
lattice corner. It is now placed at the INTERSECTION of the two strong arms' own fitted lines
— §10.6's corner evidence, which the snap cannot reach at a junction because the chain ends
there. Phase 0 came first and moved the goalposts twice: a census of the 101 corner-verdict
junctions across the 128 GT-scorable private marks, scored against the AUTHORED outline,
showed the issue's named witness is a witness for the OTHER mechanism (the row above), and
the obvious arm-straightness gate is **not separable** (bow ≤ 0.79 holds 51 authored-straight
arms and 100 authored-bent ones) — so `ARM_BOW` ships as a one-sided veto that can only drop
an arm. Red gate first (`test/planar-thread.test.ts`: junction 0.620 → **0.143px** off the
authored apex, worst arm node 0.581 → **0.127px**), corpus case `seam-corner` (chamfer 0.242
→ **0.214** @512, 0.295 → **0.262** @1024, corners 40/40 and 38/38 throughout). The loudest
witness is `checker` traced with gradients ON, where every cell corner is a rank-firing corner
junction: chamfer **0.222 → 0.107**, p95 **0.829 → 0.411**, with node count, item count and
corner recall all byte-identical — 961 of 1024 cells better, 0 worse. A/B: 5 of 68 outputs
move, 4 better. The one-arm NORMAL correction was built, measured and REJECTED (§17.3).
**Scope it honestly** (§17.4's caveats, user-raised): that checker lane is one the rampiness
probe turns OFF for this art, no gallery mark exhibits the mechanism (their whole footprints
are 102–184 px), and what shipped is a closed, gated mechanism rather than a visible
improvement to any mark in the corpus today.

Recently closed: **a small region collapsing to a sliver @512** (`fluent-beverage-box-flat`'s
`#990838`, was #14) — closed 2026-08-06, **§16** is the record, and it closed the way this
list does not usually get to: the forward bisect the exit protocol demands found the defect
**already fixed**, incidentally and silently, by §15's sub-pixel edge placement (red at
88ef5a2, green at 7a740e9 — the commit that landed §15). Ink kept **13.5% → 98.3%**, regions
6/7 → **7/7**. The mechanism was still attributed rather than assumed: a flag matrix at HEAD
(`lowresDiag --fit`) isolates the pincher as §10.4's junction RE-SEAT — with the lattice
chains restored (`subpixelEdges:false`) the blob's two ends both re-seat against circle×circle
pairs and its loop self-crosses into a 77px² bowtie; turning `junctionReseat` off on top
restores it (101.7%). §10.4's chord straightening is exonerated — it never fires here. What
this exit actually BUILDS is the gate that was missing, because the fix arriving by accident
is the same hole as the regression arriving unnoticed: `truth regions @512:` gates the seven
tier-2 cases the @256 lane already runs, on region recovery plus a new **ink-kept** gate (the
area question — recovery is a MEDIAN and only flips past 50% loss). Verified RED on the
regressed tracer before being trusted green.

Recently closed: **the §15 tangent pin closed a letterform counter** (`logo-instagram`'s `a`,
user-reported 2026-08-05 from /labs/ab, a one-day-old regression of §15.7's guard 2) — closed
2026-08-05, **§15.8** is the record. The ranked hypothesis (the wedge's anchor sampling) was
FALSIFIED by the per-point dump — 229 of 306 point-outcomes in the ROI are `corner-revert`,
so the pass had already left that neighbourhood on the lattice; the mover was the pin, whose
"arm line" is fitted over [3..16]px and there measures a crown that has already turned 45°.
Rotating a 26px handle by the 29.3° that bought (just under the 30° cap) moved its control
point 13.1px and the crown left its own samples by ~2px. The pin now also honours the fit's
own tolerance — `(4/9)·handle-tip movement ≤ ε`, the cubic-basis bound — which is inert on
the 703-pin measured population below 1.9px and 5.8× tighter than the defect. Gate:
`test/planar-pin.test.ts` (crown sag 2.77 → **1.24px**, limit 1.6), corpus witness
`wedge-counter` (p95 1.19 → **0.45** @512), corner watchlist and every §15.7 witness number
unchanged.

Recently closed: **a weak colour boundary aiming a strong edge** (was #15) — closed 2026-08-01, **§14** is the record. A posterization band seam ending on a real edge pinned that edge to the seam's INTEGER lattice corner and rotated it ~1px end to end; the junction is now placed on a fit taken THROUGH it from both strong arms' raw lattice chains (`planarThread.ts`), before anything is fitted. Flank swing 0.98px → 0.24 (0.10 with gradients ON), tangent breaks 15.4°/9.5° → 0.7°/0.7°, and the `band-cross` control improves rather than moving. The §14.2 shape as WRITTEN — fit the chain through and split the fitted curve — was built and rejected on measurement: it fixes more (apex, a 150px arm) but bows a dead-flat 78px edge by 0.7px; §14.3 has both sets of numbers. What is left of #15 is the row above.

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

## 14. Contrast rank — a weak boundary aiming a strong edge (2026-07-30, FIXED 2026-08-01)

**Symptom (user-reported, /labs/gallery, `affinity-designer.svg` traced flat).** Two
complaints on one mark: a straight bar edge that *bends* where a colour band boundary
reaches it, and a rounded corner that grows *bumps*. The banding itself was explicitly
accepted ("I don't expect a gradient"); what is not acceptable is the banding damaging the
logo's real edges.

**The contrast spectrum is cleanly bimodal.** Per shared edge, ΔE76 between the two regions
that own it (`src/devtest/bandPullDiag.ts`, derived post-hoc from the doc's own topology):

```
posterization band seams:  ΔE  2.7 – 10.2
real logo edges:           ΔE 47   – 79
```

Nothing in between. So "prefer the high-contrast boundary" is not a heuristic on this art —
it is a clean separation, and 13 T-junctions have a band edge landing on real edges.

**Measured, against the authored path data** (`affinity-designer.svg` is 1020 bytes of plain
`d` attributes, so the truth is exact rather than sampled — `src/devtest/apexProbe.ts`):

| | flat trace | gradients ON (no band junctions) |
|---|---|---|
| inner flank, displacement at s=6 → s=90 | −0.37 → **+0.61** (0.98px swing) | −0.35 → −0.27 (**0.08px**) |
| triangle apex error | 1.54px | 0.97px |
| inner-panel arc, tangent break at its two ends | **11.0° / 10.7°** | — |
| outer plate corners (no band junction) | 0.03–0.06 mean, 0.40 swing | — |

The flank does not step, it **rotates**: it is one fitted edge pinned at the apex and at a
band junction, and the two ends carry different errors. (Scanned with BILINEAR sampling —
nearest-neighbour quantizes the scan and reports a gradual tilt as a sudden step, which
points at the wrong mechanism entirely.)

**Root cause.** A junction is an INTEGER lattice corner; the edge it lands on is sub-pixel.
Pinning a 116px edge to that corner costs ~1px at that end, against 100+px of staircase
evidence that would have placed it far better. The band boundary decides where the pin goes,
so the weak boundary aims the strong edge.

**Not beautify.** `junctionReseat: false`, `arcSnap: false` and `fidelity: 0` are each
byte-identical to the shipped output. §10.4's re-seat cannot help by construction: it
corrects to the INTERSECTION of two primitives and requires transversality, while here the
strong boundary runs *straight through* the junction; and its `MIN_MOVE` is 1.5px while this
correction is 0.5–1px.

### 14.1 Three approaches measured and rejected — read before re-attempting

- **A flat-authored driver case does not reproduce it.** `band-cross` (new, gated, tier 0 —
  four flat near-colours, ΔE 7.5/8.2/7.6, crossed by a bar, a disc, a quarter arc and an
  uncrossed control square) scores **chamfer 0.14 / p95 0.49 @512: GREEN**. A weak boundary
  alone does not bend a strong edge. The case is kept as a CONTROL — it pins that flat weak
  boundaries are harmless, so a future fix that starts damaging them fails the build.
  (Authoring note: the mark's tightest pair, ΔE 2.7, is not usable — quantize merges it, so
  the band would be missing from the trace entirely and the case would go red for a known,
  unrelated reason. Measured: 4 fills instead of 5, p95 25.7px.)
- **Nor does a ramp version, nor sub-pixel phase.** Same geometry over a linear ramp, swept
  across 10 sub-pixel phases against a no-bands control (`src/devtest/bandCrossProbe.ts`):
  worst flank deviation **none 0.82 / flat bands 0.83 / ramp 0.94** — the control reaches the
  same magnitude. Whatever the extra ingredient in the real mark is, it is not "bands crossing
  a bar", and it is not phase alone.
- **A post-fit contrast-ranked re-seat CANNOT work, and this is structural.** The obvious fix
  — a sibling pass to `reseatJunctions` that projects the junction onto the strong edge's
  fitted primitive, gated on the ΔE split — was built, and it correctly identified the
  junction (`ends=3 de=[2.7,50.5,52.3]`, strong=2, weak=1, continuation confirmed). It then
  moved it **0.000px**. The primitive is fitted from the arm of the ALREADY-PINNED edge: the
  99px flank is a single straight fitted segment ending at the vertex, so its line passes
  through the vertex by construction and projecting onto it is a no-op. By the time
  `planarBeautify` runs, the tilt is baked in and the evidence that would correct it is gone.
  (Two continuation tests were also measured along the way: comparing the two arms' fitted
  LINES fails because a 17px arm's direction is noise; a tight corridor around the primitive
  is circular, since the stretch being corrected is itself displaced. A chord-direction test
  at 15° works — worth keeping if this is re-attempted.) The code was reverted rather than
  shipped dead.

### 14.2 Where the fix lives: BEFORE the fit, in the junction itself

In `assemblePlanar`, which still holds each edge's raw lattice chain (`net.edges[].pts`) —
the evidence the pin destroys. `planarThread.ts` ranks every junction's incident boundaries
by contrast, and where a WEAK one ends on a STRONG one that CONTINUES through, it joins the
two strong arms' raw chains into one window across the junction, fits that window (one line,
or one circle where the boundary curves through), and moves the junction onto it. Every
incident edge — including the band seam, whose endpoint follows — is then fitted pinned to
that one point, so both regions still reference one shared edge and the planar
byte-coincidence invariant is untouched.

The correction is purely NORMAL to the strong boundary, and that is the whole point. The
lattice quantizes the junction ACROSS the edge, which is what tilts it; where the junction
sits ALONG the edge is the weak boundary's business, and an error there is invisible.

**Measured on the driver** (`affinity-designer.svg` @512 flat, `apexProbe.ts` — the rendered
scan is bilinear, see the trap above):

| | before | after | gradients ON (no band junctions) |
|---|---|---|---|
| inner flank, rendered displacement s=6 → s=108 | −0.37 → **+0.61**, swing **0.98** | −0.41 … −0.17, swing **0.24** | −0.37 … −0.27, swing 0.10 |
| inner flank vs the authored line (fitted geometry) | 0.03 → 0.75 ramp | 0.01 → 0.21 | 0.10 → 0.21 |
| arm B→C mean / max | 0.41 / 0.86 | **0.10 / 0.21** | 0.16 / 0.22 |
| tangent break at the panel's two seam junctions | **15.4° / 9.5°** | **0.7° / 0.7°** | — |
| whole mark, render vs source | ΔE mean 1.361, p99 8.69 | ΔE mean **1.332**, p99 **7.50** | — |
| triangle apex A | 1.54px | 1.54px (unchanged — see below) | 0.97px |
| outer plate corners (no band junction) | 0.03–0.06 mean, 0.40 swing | unchanged | — |

The flank stops rotating: it lands at a uniform −0.3px, which is where gradients-ON puts it.
20 of the mark's 34 junctions move, none by more than 0.84px (`threadDiag.ts`).

**Blast radius.** On the flat-authored tier-0 corpus — `checker` (1837 junctions),
`sharp-star`, `gear-teeth`, `bar-caps`, `hairlines`, `cross-bars`, `aa-seam`, `concentric`,
`annulus`, `overlap` — **zero** junctions move: ordinary flat art has no weak boundaries, so
the rank never fires. `band-cross`, the authored weak-boundary control, moves all 16 and gets
BETTER (chamfer 0.14 → 0.12, p95 0.49 → 0.34 @512; 0.19 → 0.13, 0.70 → 0.57 @256). Of the 42
`/labs/ab` outputs, 4 move — `aurora`, `bg-ramp-twin`, `nebula`, `petals`, all FLAT traces of
ramp art, i.e. exactly this family — and rendered against their source they are neutral to
better (aurora ΔE p95 20.90 → 19.99; nebula and bg-ramp-twin unchanged to 3 decimals; petals
mean 0.971 → 0.979). With `planarFit.fitThrough: false` all 42 are byte-identical, so the
pass is fully gated and the refactor it rides on is exact.

### 14.3 Calibration, and the three things that died on the way

`src/devtest/threadDiag.ts` prints what the rank sees per junction — the ΔE census, the arm
lengths, the through-fit residual against one line and one circle, the chord turn, and the
verdict. Every gate below is read off that table, not assumed.

- **ΔE 12 / 25 (weak / strong).** The spectrum is bimodal on every case that fires: the
  widest gap is 10.2 → 47.0 on the Affinity mark, 8.3 → 42.0 on `band-cross`, 15.0 → 60.2 on
  `bg-ramp-twin`. The gates sit inside a gap 30–45 wide. A junction with anything in between
  is not classified and is left alone.
- **The residual test ALONE threads a real corner — measured, and it is why the chord-turn
  gate exists.** A 40° corner of the navy plate fits a CIRCLE to 1.11px over the ±12px window
  (a 40° bend over 24px *is* an arc of radius ~35), so it passes any residual gate loose
  enough to accept the plate's genuine radius-50 corners (0.75–0.84) — and would be rounded
  off. The chord TURN separates them cleanly where the residual cannot: continuations and
  radius-50 corners read 0–13.2°, real corners 39.8–105.3°. The gate is 20°, 1.5× from both
  sides; anything in [14°, 39°] is identical on this corpus. The residual gate is KEPT at
  1.2px but is not load-bearing: across tier 0 it never fires once the turn gate is in. It
  guards the shape the turn cannot see — two arms that each bend but net ~0°.
- **The §14.2-as-written CHAIN FIT was built and rejected on measurement.** Threading the
  strong edges into one chain, fitting THAT, and splitting the fitted curve at each junction
  (exact de Casteljau, both regions still on one shared edge) does fix the flank — and it
  fixes MORE: apex 1.54 → 1.23 and the P0→A arm's stray 0.76 → 0.12, because a longer chain
  gives the fit room to absorb a pin error locally instead of tilting a 150px run. But
  re-fitting the chain re-decomposes geometry that had nothing wrong with it: the inner
  panel's dead-flat 78px bottom edge (y = 308.00 at every sample, a constant −0.47px offset)
  came out BOWED by 0.7px (y → 308.7 mid-span, swing 0.57), and the A→P1 arm grew a 0.77px
  excursion where it had 0.29. Trading a 1px tilt for a 0.7px sag is not an improvement —
  §10.4 and §13 are both in this file because sub-tolerance geometry the gates do not see is
  still a defect. Junction placement alone gets the reported defect and touches nothing else.
  - A sub-experiment that ALSO died: the sag was first blamed on the chain becoming a CLOSED
    loop and so reaching a different fitter (`fitCorneredLoop`, ≥2 loop corners). Cutting the
    loop open at its weakest junction and fitting it as an open chain reproduced the sag
    node-for-node. The cause is the re-fit itself, not which fitter runs.
- **What the chain experiment DID establish, and is now a named follow-up:** the apex error
  (1.54px, target ~1.0) is NOT the pin. It is the corner snap's arm evidence being CUT by the
  band junction — `snapCornerToArms` can only sample up to the neighbouring junction, so a
  seam landing 20px from an apex halves the arm the apex is reconstructed from (§10.6's
  short-arm regime). That is a corner-recovery mechanism, and fixing it there would keep the
  apex win without the sag.

**Known residual, measured and named.** Correcting a junction whose edge's OTHER end is a
real corner — also a junction, and still pinned to its integer lattice corner — converts a
constant offset into a tilt: the mark's 133px top edge went from a uniform 1.06px offset to
mean 0.69 with 0.71px of swing. Across the mark's 29 strong edges the mean error improves
(−0.43px total) and the swing is a wash (9 better, 10 worse, 10 unchanged, +1.57px total),
while the whole-mark render ΔE improves. The fix is the same one the follow-up above needs: a
junction that IS a real corner deserves the same sub-pixel placement, from its arm
intersection rather than from a through fit. Until then this is the honest cost of the trade.

**Gated by** `test/planar-thread.test.ts` (the mechanism at its smallest: a sub-pixel diagonal
cut by a weak seam — the junction lands on the true edge, a 65° corner under the same seam
does not move, equal contrast moves nothing, and no palette is byte-identical) and by
`band-cross`, which stays a CONTROL: it pins that flat weak boundaries are harmless, and it
must stay green.

## 15. Cross-resolution consistency — the lattice floor, measured (§0 #8, Phase 0: 2026-08-04)

**Symptom (user-reported, /labs/gallery, five marks at once).** Every visible defect the
user named — chupa-chups' ® disintegrating, cnn's uneven gap, coca-cola's bump on a smooth
curve, ahrefs' arch flattening to a trapezoid, bluetooth's rune — shrinks 3–4× when the
SAME artwork is rasterized at 1536 instead of 512, with nodes rising only 8–20%. Not one
of them is a fit-logic bug: output quality is a function of raster resolution rather than
of the artwork. That is §0 #8, and this section is its Phase 0 — the instrument and the
numbers, landed BEFORE any fix (the §12 discipline).

### 15.1 The hole: no gate compares two resolutions

Every gate scores ONE resolution independently — truth-gate @512, the LOWRES lane @256 —
each against tolerances calibrated at THAT raster, in that raster's pixels. Both honest,
and structurally blind to the question "is this the same shape at two sizes?": a tracer
whose geometry is chosen by the lattice passes all of them, at every size, forever.

`src/devtest/scaleScore.ts` (the arithmetic) + `scaleDiag.ts` (the CLI) close it. Each
case is traced at 256/512/1024; every lane's doc is affine-scaled into the FINEST lane's
space (exact on Bézier control points — nothing resampled or re-fitted) and scored there
against the authored SVG, with the reference raster driving the §9.6 visibility filter.
The only thing that differs between lanes is the resolution the tracer saw.

  drift = chamfer(coarsest) / chamfer(finest), both in reference px.
  1.00 = the trace is a function of the ARTWORK.  4.00 = of the LATTICE (over this span).

Traps the instrument is built against, all three of which produced confident wrong
conclusions the day the witnesses were measured: rasterizeDoc silently CROPS an enlarged
doc (geometry-only end to end, nothing renders); meanΔE PREFERS a structurally broken
trace (headline numbers are structural); a mean hides a destroyed small glyph (p95 +
worst-cell always reported).

### 15.2 The numbers: the corpus sits AT the pure-lattice line

Tier 0 @256/512/1024 (16 scorable): median drift **4.69×** over a 4× lattice. Every
curved case lands in 3.7–7.2 (overlap 6.96, cross-bars 7.40, bar-caps 7.16, aa-seam 4.98,
sharp-star 4.69, nebula 4.40, concentric 4.28, gradient-flat 4.02, petals 3.98,
band-cross 3.69, bloom 2.67). The witnesses, same sweep: cnn **5.10×**, chupa-chups
**5.30×**, coca-cola **6.11×** (chamfer 1.41 → 0.23 ref-px). bluetooth (`<use>`) and
ahrefs (clipped) have no readable answer sheet — the self-consistency lane (coarsest
geometry vs finest geometry directly, no answer sheet needed) reads 1.95/19.6 and
1.42/3.5 px (μ/p95; ideal 0).

Two structural findings ride along: corner recovery on the witnesses CLIMBS with
resolution (75% @256 → 87.8% @512 → 94.7% @1024 — the product traces at 2048, the lab
judges at 512, §0's lab-bias note), and `checker` reads 0.003px error at every size —
axis-aligned art is EXACTLY representable on the lattice, which is why the whole family
stayed invisible on fixtures and shows on curved brand art.

### 15.3 Attribution: the error is in the samples, not the fit

Drift alone confirms the consequence, not the cause — and two causes predict the same
drift: samples quantized to the crack lattice, or absolute-px fit tolerances meaning
different things at different sizes. `scaleDiag --lattice` separates them: score the RAW
crack chains (`net.edges[].pts`, exactly what the fitter is handed — via an inert
`onPlanarLabels` tap in index.ts, A/B verified 0/33 files changed) against the authored
SVG in the same reference space.

Measured, in each lane's OWN pixels:

```
median lattice error:  @256 0.223px   @512 0.224px   @1024 0.226px
```

A CONSTANT — the quantization floor of integer-lattice sampling (the theoretical mean
|error| of a uniform ±0.5px quantizer along both axes lands exactly in this range). And
"fit adds" ≤ 1.0× on most cases (concentric 0.40×, annulus 0.35× — the circle snap
AVERAGES lattice noise away; sharp-star 0.67×, petals 0.89×, gear-teeth 0.85×). The fit
is already extracting more accuracy than its input carries. **No tolerance change can
recover what the samples never had** — the Phase-0 audit's scale-relative-ε workstream is
therefore SECOND-order for #8 (it still matters for feature-size-dependent melting, §10).

The sub-pixel information exists and the engine ignores it: the CRISP engine (subpixel.ts)
builds a continuous coverage field and places marching-squares vertices at true iso-0.5
crossings — but a coverage field is per-region, and two neighbouring regions must agree on
ONE shared boundary. Making edges sub-pixel while keeping them SHARED is the open design
problem; the icon-sheet measurement (same pixels, 3× finer lattice: ink-area drift
0.75pp → 0.13pp, SSIM 0.864 → 0.946) bounds the available win from below.

### 15.4 The gate

`test/scale-invariance.test.ts` — 7 cases (curved/diagonal boundary only; `checker`-style
axis-aligned art reports INAPPLICABLE below a 0.05px signal floor, per the
evaluateTruthGates "n/a is not a pass" discipline), @256 vs @1024, `SCALE_DRIFT_MAX 2.0`.
The limit is derived, not fitted: there is NO healthy population to calibrate on (the
corpus sits at the pure-lattice line), so 2.0 encodes "boundary error must improve less
than proportionally to the raster — the trace must be at least half a function of the
artwork". It sits below today's whole population and above `annulus`' 1.69, so it is
demonstrably reachable. Six cases land in `KNOWN_DEFECTS` (the truth-gate boolean
contract: listed must fail, unlisted must pass, the list only shrinks); `annulus` passes
on merit and doubles as the control a fix must not cost. Contract verified in both
directions before landing.

### 15.5 What Phase 0 rules out / defers

- **An ML super-resolution upscaler in front of the tracer** — rejected in the mission
  brief: it hallucinates edges the tracer then faithfully traces, and plain bilinear 3×
  already recovers most of the measured win. If SR is ever added it belongs in Cleanup,
  opt-in.
- **Fixing via wider tolerances** — the drift is in the samples; tolerances only decide
  how faithfully the fit reproduces the quantized input.
- **The /labs/gallery raster cap** (512 vs the app's 2048, hardcoded gradients:false) —
  real lab bias, understates the tracer, but fixing the lab is not a tracer fix; noted,
  not a workstream.

Residue, named: `aa-seam`'s @1024 error stalls at 0.228 (the §0 #3 sliver residue, so its
drift ratio UNDERSTATES the lattice share); `hairlines` drift 24.9× is the thin-feature
family compounding on top of #8, not pure lattice; aurora (ramp art traced flat) shows
self 15.8/113.5px — band boundaries are unstable across resolution, expected for
posterization and out of #8's scope.

### 15.6 The absolute-px constant audit (Phase 0.2)

`docs/absolute-px-audit.md` — 122 constants classified ART (must scale with raster) /
SENSOR (must NOT — the AA ramp is ~1px at every size) / CAP / UNCLEAR, each from its
actual comparand with quoted evidence; 25 initial classifications were refuted by an
adversarial verification pass and corrected. Highlights that are FINDINGS, not just
classification: `THROUGH_SPAN` 12px (planarThread) reads the same authored junction's
chord turn as 21.4° @256 but 7.1° @2048 and FLIPS the line-vs-circle winner — §14's
threading silently degrades off-512; `CHORD_MAX_LEN` 80px (planarReseat) is measured DEAD
on its own §10.4 driver above ~1024 (the authored chord is 130.7px @2048 > 80); the
`minRegionArea` px²-floor family compares res²-growing areas against a fixed 50 (measured
0/80/176/922 across 128→512 for one colour — the §12.5 knife edge, now with numbers). The
tripwire list (SENSOR constants and what breaks if scaled) is the do-not-touch map for
every fix in this family. Per the audit's own honesty note, the segment-lane rows are
single-auditor evidence, and the witness ranking is mechanism inference, not measurement —
each candidate still needs its own gated case before any change.

### 15.7 The fix: sub-pixel edge displacement + the three guards it needed (2026-08-05)

**The pass** (`planarSubpixel.ts`, `PlanarFitOptions.subpixelEdges`, default ON; OFF or an
imageless `tracePlanar` call is byte-identical — every label-only caller is unchanged by
construction). Before fitting, each edge chain's interior points move from the integer
crack lattice to the iso-0.5 crossing of the LOCAL two-colour coverage profile, read from
the source raster along the chain normal: two far anchors at ±1.75px (validated against
the LABEL MAP — one guard covers junctions, thin features and the border), the local
contrast axis farL−farR (no palette needed), linear interpolation of the projected
profile, and skip-don't-guess guards (contrast ≥ 12 RGB, blend-segment residual ≤ 16,
monotone profile, |δ| ≤ 0.75). Sharedness is free — the chain is stored once and both
regions reference it (the §14 threadJunctions move, applied to whole chains). Corner
detection, the area guard and the staircase fallback all stay on the LATTICE chain
(index-preserving displacement makes that a one-line distinction).

**The three guards, each measured in, none designed in advance:**
1. **Corner self-guard** (in-pass): the AA iso-line ROUNDS every apex, and fitting that
   rounding melts corners — gear-teeth's 67.3° roots fell 28→6 recovered (recall 51/60 →
   36/60) while its 80° tips kept their margin. Windowed detection on the lattice cannot
   see small corners (§10.6's dilution), but on the DISPLACED chain staircase noise is
   gone, so local turn IS corner evidence at any scale: turn > 35° over ±4 steps reverts
   ±5 steps to the lattice.
2. **Tangent pin** (`pinCornerTangents`, per-displaced-edge): the arc fits' end tangents
   are free within ε and rotate toward the bisector on smooth displaced evidence — a 91°
   authored corner read 77° from the lattice fit and 51° displaced, crossing the 60°
   sharp bar (chupa-chups, six letterform corners at once). Apex HANDLES now rotate onto
   the fitted arm-line directions (the same evidence the apex position already trusts,
   via `snapCornerToArmsFull`), capped at 30°. In `fitCorneredOpen` the pin is doubly
   load-bearing: the weak-turn prune reads those tangents to decide if a corner is real.
   Side effect: gear-teeth 51/60 → **52/60**, one better than the pre-§15 baseline.
3. **Anchor flatness** (in-pass): an anchor inside a ~3.5px bar carries the right label
   but never pure colour (the opposite wall's AA reaches it), biasing both walls INWARD —
   bar-caps @256 narrowed three bars past the area guard into the staircase fallback
   (82/36/72 nodes, parsimony 5.99×), and coca-cola's thin script corners shifted ~1.8px.
   |I(±FAR) − I(±(FAR+1))| ≤ 10 RGB or skip. Plus: an area-guard trip on a displaced
   chain now refits from the LATTICE chain first (the pre-§15 path) before any staircase.

**After (all gates green, suite 344/0):** tier-0 fine-end chamfer collapses — bar-caps
0.181 → **0.089**, gear-teeth 0.177 → **0.080**, sharp-star 0.125 → **0.068**, concentric
0.081 → **0.039** ref-px @1024 — and two scale-gate cases pass outright: **concentric**
(drift 4.28× → reg. 1.19×) and **sharp-star** (4.69× → reg. 1.76×), both deleted from
KNOWN_DEFECTS by the CI contract. Witnesses: ahrefs self-consistency 1.42 → **1.24**
(p95 3.53 → 3.33), bluetooth 1.95 → 1.90, cnn @1024 0.237 → **0.212**; corner recovery
@256 **75.0 → 76.4%**, @1024 equal, @512 **87.8 → 85.4%** (−2 corners — see residue).
gear 52/60, bar-caps 43/43, cross-bars/checker/hairlines all green at both lanes.

**Residue, named:** (a) two witness corners @512 (chupa-chups 54/55's one, plus one
more across the marks) still soften or shift ≤ ~3px — small-corner apex placement on
mixed lattice/displaced arms; (b) chupa-chups @1024 chamfer 0.236 → 0.301 (the guards
revert most displacement on its small-feature-dense ® zone, and what remains trades a
little mean error there); (c) the four remaining scale-gate KNOWN_DEFECTS (overlap,
aa-seam, petals, band-cross) improved at the fine end but their COARSE ends still ride
the lattice — the @256 lane's AA is too wide relative to the guards' sampling geometry
for displacement to survive its own safety checks there. The next lever for those is
resolution-aware guard geometry, which is workstream-2 territory (the audit's ART list),
not more displacement.

### 15.8 The regression the pin caused, and the bound that fixes it (2026-08-05, issue #11)

**Symptom (user-reported, /labs/ab ◆ gallery lane, `logo-instagram` @512).** The `a` of the
Instagram wordmark loses the thin white gap at the top of its counter: the frozen
`before-subpixel` stamp keeps it, the working tree closes it, and the gradient trace grows a
notch at the same place. Attribution was clean by construction — `before-subpixel` differs
from the working tree only by the §15 pass.

**Phase 0, the instrument.** `src/devtest/counterDiag.ts` — per-point displacement dump for a
chosen ROI (reading `planarSubpixel`'s own observational hook, so there is no second copy of
the estimator), the tangent-pin candidates that fired there, and the INTERIOR white run per
raster row measured three ways in the same units: source raster, trace with the pass off,
trace with the pass on. `src/devtest/pinDiag.ts` histograms the pin across a corpus.

**The measured cause — and it is NOT the ranked hypothesis.** The issue ranked the anchor
sampling geometry inside a converging wedge first (suspect 1). The dump refutes it: in the
ROI **229 of 306 point-outcomes are `corner-revert`** — the pass's own corner self-guard has
already put that whole neighbourhood back on the lattice, and the surviving displacements are
≤ 0.5px. The chain the fitter sees there is, to within half a pixel, the pre-§15 chain.

What changed is the FIT, through guard 2. At the wedge tip (a 2px-deep V, the quantized tip
of the counter's white sliver) the corner's outgoing arm is the bowl's crown, which turns 45°
→ 0° within ~4px — i.e. INSIDE the [SNAP_GAP..SNAP_SPAN] = [3..16]px window
`snapCornerToArmsFull` fits its "arm line" over. The line is therefore a CHORD of a turning
boundary, not the boundary's tangent at the apex, and the pin rotated the handle onto it:

```
apex (323,121) out   rot 29.3°   handle 26.0px   → control point moves 13.1px
   (the same neighbourhood's other five pins: ≤ 0.93px)
```

29.3° sits just under `PIN_ROTATE_MAX_DEG` 30, so the shipped cap allowed it. The fitted
crown then left its own samples by ~2px, the bowl's arch thinned to a smear, and the counter's
white tip merged with the page. Confirmed by isolation: with the pin disabled and the
displacement kept, the crown is restored exactly (`counterDiag --ascii`).

**Why an angle cap is the wrong quantity.** Rotating a handle moves the curve in proportion
to the handle's LENGTH. The same 29° is a 1px nudge on a 2px handle and a 13px swing on a
26px one. Measured over tier 0 + the gallery witnesses (703 applied pins, `pinDiag`), the
handle-tip movement is where the population separates and the angle is not:

```
applied pins by handle-tip shift   <0.25  <0.5   <1   <1.5   <2    <3    <5   ≥5
  tier 0 (162)                       118    27    14     2     1     0     0    0
  gallery witnesses (541)            271   139    90    31     4     4     1    1  ← 13.1px
```

**The fix (one clause).** The pin exists to correct a TANGENT, so bound its side effect by
the fit's own tolerance: moving one cubic control point by `d` moves the curve by at most
max{3t(1−t)²} = 4/9 of `d`, and a correction that moves the curve further than ε is not a
tangent correction — it is a re-fit onto evidence the fit itself rejected. `pinHandle` now
also requires `(4/9)·2·|h|·sin(rot/2) ≤ epsilon`. Derived, not calibrated: the whole tier-0
corpus stays under 1.9px of handle-tip movement, so the bound is inert on the population it
was not aimed at, and the witness's 13.1px is 5.8× outside it.

**The gate (red before the fix).** `test/planar-pin.test.ts` — the witness's anatomy built
from two analytic strokes and quantized onto the crack lattice (curved crown, the 2px pinch
step, shoulder, straight stem), handed straight to `fitCorneredLoop`. It asserts the fitted
curve still explains the crown samples it was fitted to: **2.77px before, 1.24px after**
(limit 1.6 = ε + the staircase's own ±0.5). Two companions keep it honest: the same fixture
UNPINNED is inside the bar (so the pin is what moves it), and a lens whose tips are sharp
corners between gently curved arms keeps all four of its pins applied — guard 2's own win
(chupa-chups' letterform corners) must not be switched off by the bound.

**The corpus case.** `wedge-counter` (`genEdgeCases.ts`, A/B lane, deliberately UNGATED —
the `scale-blind` arrangement): a rack of three bowl+stem units at the (radius, cut depth,
meeting angle) cells a pipeline sweep measured losing, plus a steep-meeting control. @512
its boundary p95 goes **1.19 → 0.45** and chamfer **0.24 → 0.16** across the fix, and its
three pathological pins (5.5 / 5.2 / 3.6px of handle-tip movement) are refused while the
control's stay applied. It is ungated for two honest reasons: its worst sag is ~2px over a
short arc, which a whole-case p95 dilutes to 1.19 — inside tier 0's 2.5 — and gating it
would ALSO pin §15.7's coarse-end residue at a knife edge (@256 the displacement pass costs
this art 2 of 20 corners, exactly the 80% floor, before AND after this fix).

**After.** Suite 347/0 (+3 new), truth gate 55/55, scale gate 7/7 with its four
KNOWN_DEFECTS unchanged. Corner watchlist byte-stable: gear-teeth **52/60**, bar-caps
**43/43**, sharp-star **11/11**, cross-bars **10/10**, checker **3556/3588 (99.1%)**.
Witnesses unchanged where §15.7 measured them (corner recovery @256 76.4% / @512 85.4% /
@1024 95.8%, cnn @1024 0.212, ahrefs self 1.24, bluetooth 1.90) and better where the bound
bites: coca-cola @512 chamfer 0.347 → **0.335**, p95 0.962 → **0.905**; nike 0.239 →
**0.235**. A/B vs `before-counter`: **7 of 33 cases moved** — one fixture (`nebula`, the
gradient photo, Δmean 0.026) and six gallery marks, `logo-instagram` flat among them.

**The gradient half of the report is a DIFFERENT defect — measured, not assumed.** The issue
also names a notch at the counter tip in the gradients-ON trace. Attribution first: a
worktree at the pre-§15 commit (88ef5a2) confirms the issue's premise — `subpixelEdges:false`
reproduces that commit BYTE-IDENTICALLY on this mark, in both lanes. But in the gradient lane
the crown is already broken there: pre-§15, HEAD and the fixed tree render that neighbourhood
the same way (Δmean 1.70 in the 34×22px ROI between pre-§15 and HEAD, and **0.000 between
HEAD and the fix** — the pins there are ≤ 0.41px of handle-tip movement, far under any
bound). So the gradient notch is not this regression: it is the gradient segmentation
splitting the wedge, present before §15, and it stays open. Flat art is the product target
and the flat lane is what this fixes.

**Residue, named:** the pin is still gated by an ANGLE as well (30°), which remains a
proxy — a short handle can rotate far on evidence that does not support it and stay inside
both bounds. Nothing in the corpus measures that today. And the arm window itself is still
fixed at [3..16]px: the honest fix for a turning arm would be to shorten the window until its
own samples are collinear (`bow` is already computed and carried on `ArmFit` for exactly
that), which is worth doing when a case demands it — the `bow` distribution measured here is
NOT separable (straight arms read 0.5–0.75px on a lattice staircase, the pathological arm
1.01px), so it is not a gate on its own.

## 16. The tier-2 @512 region lane, and how §0 #14 was already fixed (2026-08-06, issue #12)

§0 #14 was a 522px region of `fluent-beverage-box-flat` whose doc item survived with the
right fill while its GEOMETRY pinched to a ~77px² sliver, so the region rendered white.
§12.4 found it while verifying the low-res family, bisected it to §10.4 (green at e549b29,
red at fc7b7e9), and left it a row instead of a drive-by fix. The issue's own plan put the
gate first — and following that order is what turned up the surprise.

### 16.1 The instrument first, and what it measured

`src/devtest/lowresDiag.ts` gains two things, both extensions of what was already there:

- the doc-level autopsy runs for **every** authored colour, not only the ones
  `scoreRegions` already calls missing, and reports **ink** — source px vs rendered px of
  that colour. #14 is an ink collapse; a missing-only autopsy cannot see one coming, and
  (as it turned out) cannot see one go either.
- `--fit k=v,k2=v2` overrides `PlanarFitOptions` for the final trace, so a mechanism can be
  switched off at runtime instead of in a worktree.

The first run at HEAD did not reproduce the defect:

```
#990838  src 634px  render 640px  ink 100.9%   ← the row says 88px rendered
```

Healthy at 256 / 384 / 512 / 640 / 768 / 1024 — not a resolution accident. A forward bisect
(worktree + the same probe) dated the repair exactly:

```
fdf6f48 (§13 rim-cap)     ink 13.9%   88px    anchor-polygon 76.8px²
c5eba6a (§14 contrast)    ink 13.9%   88px
88ef5a2 (§15's parent)    ink 13.9%   88px
7a740e9 (§15 sub-pixel)   ink 100.9%  640px   anchor-polygon 513.6px²   ← fixed here
```

**§15 closed #14 as a side effect, and nobody knew.** Not one number in §15.7 mentions it,
because nothing in CI was measuring tier 2 at 512.

### 16.2 The mechanism, attributed rather than assumed

The issue asked which §10.4 sub-mechanism pinches the blob. A 2×2 flag matrix at HEAD @512
answers it without a worktree — `subpixelEdges:false` restores the pre-§15 lattice chains:

| planarFit | regions | `#990838` ink |
|---|---|---|
| (default) | 7/7 | 100.9% |
| `subpixelEdges:false` | **6/7** — painted `#ffffff`, ΔE 88.6 | **13.9%** |
| `subpixelEdges:false, junctionReseat:false` | 7/7 | 101.7% |
| `junctionReseat:false` | 7/7 | 101.1% |

(Ink here is the autopsy's EXACT-colour count, which is what `lowresDiag` prints; the gate
counts both sides at ΔE ≤ 4 and reads the same collapse as 13.5% of 651px. Same measurement,
two fringe conventions — quoted as printed rather than silently reconciled.)

So the pincher is §10.4's junction **re-seat**, and §15 removed its trigger rather than the
fault. A log inside `reseatJunctions` shows what differs. The blob is a two-edge loop between
v0 (272,48) and v1 (268,79):

- **lattice chains:** BOTH ends re-seat against circle×circle pairs (v0 +1.74px, v1 +2.81px),
  and the terminal re-emit leaves the closed subpath self-crossing — its six anchors run down
  the left arc and then back up further LEFT again (x 256–259), with the right arc out to
  x≈287 simply gone. Shoelace 76.8px². RENDERED, that is not two lobes but a **~4px-wide
  crescent hugging the blob's left rim** — the return curve runs back along the outbound one,
  so the enclosed area is the gap between them and the other 86% of the region paints white:

  ```
    source (#990838)                     traced, lattice chains
      .......+###+.........                ....++#++............
      ...+#############+...                ..+##+...............
      +##################..                #####................
      #####################                +###.................
      ##################### ×32 rows       +###.................  ×32 rows
      #####################                #####................
      +##################..                ..+##+...............
      ...+#############+...                 ....++................
  ```
- **displaced chains (shipped):** only v1 re-seats, and the blob is a clean five-anchor loop
  spanning x 259–287, 513.6px².

`chords` is empty in both runs, so §10.4's occluder-chord straightening — the other half of
the "reseat/chord territory" the row named — is **exonerated**.

### 16.3 The gate that was actually missing

§12.4 wrote the diagnosis plainly: *"Tier 2 being ungated in CI is how a 2-region regression
survived five commits unnoticed."* The repair arriving unnoticed is the same hole. So the
deliverable here is the lane, not a fix.

**`truth regions @512:`** — `TIER2_REGION_CORPUS` in `truthCorpus.ts`, the SAME seven tier-2
cases the @256 lane runs (three region-fragile drivers + four healthy controls, selected in
§12.1 by sweeping all 106 twins for region loss — the same question, so the selection carries
over rather than being re-argued). Two gates, both tolerance-free:

- **region recovery** — zero tolerance, as everywhere else;
- **ink kept** (new) — `worstInk` from `scoreRegions`: rendered px / source px per region,
  both counted at ΔE ≤ 4. Recovery asks its question with a MEDIAN at the region's own
  pixels, so it flips only once more than half the region is gone; #14 tripped it only
  because the collapse was near-total. A region pinched to 45% keeps its median AND its
  boundary numbers, because the boundary that survives is traced accurately. Ink degrades
  continuously.

`INK_MIN` = 0.5, measured (`calibrateLowres.ts`, worst region per case over the healthy
population):

| population | min | p05 | p50 |
|---|---|---|---|
| tier 2 @512 (106 twins) | 89.8% (ginger-root) | 93.7% | 99.7% |
| tier 2 @256 (106 twins) | 81.7% (donkey) | 86.5% | 99.1% |
| tier 0 + controls @512 | 93.4% (flute) | 95.9% | 99.4% |
| tier 0 + controls @256 | 86.1% (flute) | 92.5% | 98.9% |

The defect measures **13.5%**. The floor sits 1.6× below the healthiest-worst case and 3.7×
above the failure — the paint gate's recipe (§10.3), and being a RATIO it is the first limit
in this corpus that is resolution-free, so all three lanes share it.

**Why this lane gates no boundary numbers.** `TIER_TOL[2]` is a calibrated catastrophe gate
that deliberately leaves ~10% of the twins red, and beverage-box's own p95 sits in that tail
(1.28 vs 1.20). Gating boundary here would need either a `KNOWN_DEFECTS` entry — which would
make the lane BLIND to #14's return, since a listed case only has to fail *something* — or a
second, looser p95 at the same resolution as `TIER_TOL[2]`, which is precisely the
tolerance-widening this corpus exists to prevent.

**Red before green.** The gate files are byte-identical between 88ef5a2 and HEAD, so the new
lane was copied verbatim into a worktree at 88ef5a2 and run against the tracer that HAD the
defect:

```
✖ truth regions @512: fluent-beverage-box-flat
    ✗ regions recovered: 1 vs all
    ✗ ink kept (worst region): 0.14 vs ≥ 50%
  dropped: #990838 (522px) painted #ffffff, ΔE 88.6
  worst ink: #990838 13.5% (88 rendered px of 651)
```

The other six cases pass there too, so the lane is discriminating, not uniformly angry. At
HEAD: 7/7 and **98.3%** (640 of 651).

### 16.4 After (the numbers), and the residue

Zero files under `src/lib/**` changed — the tracer is byte-identical, so the A/B corpus
cannot have moved and no snapshot needed judging. What changed is `src/devtest`, the gate,
and one labs gate-row renderer.

- Suite **347 → 354 pass / 2 skip** (+7, the new lane); truth gate 55 → 62 tests.
- The ink gate is evaluated in ALL THREE lanes (it is part of `evaluateTruthGates`), and no
  pre-existing case fails it — 55 cases gained a gate for free.
- Corner watchlist byte-stable, as it must be: gear-teeth **52/60**, bar-caps **43/43**,
  sharp-star **11/11**, cross-bars **10/10**, checker **3556/3588 (99.1%)**.
- `KNOWN_DEFECTS_TIER2_512` landed **empty**, and it is the one case where an empty defect
  list is not a claim of virtue — §16.1 explains why it was already green.

**Residue, named.** §10.4's re-seat still mis-reads this geometry; §15 masks it by moving the
chains off the lattice, and that mask is *not* categorical — `planarSubpixel` declines points
one at a time (label guard, contrast, flatness, corner revert), so a neighbourhood it declines
is a neighbourhood where the pinch is still reachable. There is no shipped configuration that
reproduces it today (the one production `tracePlanar` call always passes the image, so
`subpixelEdges` is always live), which is why this is a residue and not a row: per §0's rules
a defect needs a case that reproduces it. The repro, for whoever meets it again:

```
node --experimental-strip-types src/devtest/lowresDiag.ts fluent-beverage-box-flat \
  --res 512 --fit subpixelEdges=false
```

## 17. The junction that IS a corner (§0 #15, 2026-08-06, issue #13)

§14 places a junction on a fit taken THROUGH it — which is only defined where the strong
boundary CONTINUES. Where it CORNERS, §14's chord-turn gate refuses (correctly: one line or
circle across the bend rounds the corner off, and §14.3 measured a 40° corner passing the
residual test), and the junction then kept its INTEGER lattice corner. That is the residue
§14.3 named and left open, and it is what this section closes — half of it.

### 17.1 Phase 0: the census, and the thing it found before any code changed

`threadDiag.ts` gained a CORNER lane: for every junction the rank rejects with a `corner`
verdict it now prints each strong arm's own line residual (`bow`) and which rule placed the
junction. A throwaway census scored the same population against the AUTHORED outline —
101 corner-verdict junctions across the 128 GT-scorable marks of the private corpus, each
placement measured as its distance off the authored boundary, which is the right score
because it is blind to the ALONG-edge freedom (that position is the weak boundary's
business, §14.2).

**The finding that re-scoped the issue.** The issue's named witness is `affinity-designer.svg`,
whose five corner-verdict junctions the issue treats as corners. They are not. Measured
against the authored path data, every one of them sits **1.8–2.9px from the nearest authored
corner** — they are junctions ON a straight edge with a real corner just inside the 12px arm
window, which is why their arm bows split 1.20/0.77, 0.77/1.58, 1.21/0.77, 1.33/0.77 and
0.66/1.40: one arm is the flat top edge, the other is a chord across a bend. §0 #15 is
therefore TWO mechanisms, not one:

- **(a) the junction IS the corner** — three regions meeting at an authored corner. This is
  what the issue prescribes a fix for, and what §17 builds.
- **(b) a corner NEAR a junction** — the seam truncates the arm `snapCornerToArms`
  reconstructs the apex from (§10.6's short-arm regime). §14.3 already named this as a
  separate follow-up. It stays open, and it is the mechanism the row's Affinity numbers
  measure.

The Affinity mark is a witness for (b), not (a), so **it does not move under this fix** — it
is byte-identical, its five junctions all refused by the arm gate. Saying so is the point of
having measured it.

**A second measurement, and it killed the obvious gate.** The natural way to ask "is this arm
a tangent?" is its own line residual. Scoring all 202 arms against whether the ART runs
straight over that same window (authored sagitta ≤ 0.15px):

```
bow ≤ 0.79    51 authored-STRAIGHT   100 authored-bent
bow > 0.79     0 authored-STRAIGHT    51 authored-bent
```

So `bow` is **not separable** — exactly what §15.8's residue predicted for a lattice
staircase, re-measured here rather than assumed, and not separable in this population either.
It is bounded on ONE side only: no straight arm in the corpus reaches 0.8. `ARM_BOW = 0.8` is
therefore only ever used to DROP an arm, never to certify one.

Two more candidates died in the same census, so they are not re-attempted:

- **A gap before the arm window** (skip the first `g` px, the §10.6 `armGap` idea) is worse
  at every value: off-outline mean 0.581 (g=0) → 0.746 (g=2) → 0.831 (g=3) → 0.937 (g=4).
  The points nearest the junction carry the most information about where the junction is.
- **Fitting the arms on the §15 DISPLACED chains** instead of the lattice is a wash (mean
  0.559 vs 0.581), because `planarSubpixel`'s own guards revert the first ~12px next to a
  junction anyway — its far anchors land in the third region there and fail the label check.
  The displaced bow equals the lattice bow to two decimals on the Affinity junctions.

### 17.2 The fixture, and the gate that was red first

`seam-corner` (`genEdgeCases.ts`, A/B lane, **ungated** — the `scale-blind` / `wedge-counter`
arrangement): eight sideways WEDGES, six with their apex sitting ON a shallow band seam. The
seam's direction lies inside the wedge, so past the apex it runs into the navy and is hidden:
it TERMINATES on the corner, and three regions meet at one authored corner with ΔE ≈ 42–52 /
42–52 / 7.7 — §14's rank exactly, on the branch it refuses. The same seam re-emerges through
the wedge's base, where §14 does thread it, so every flank is a long strong edge with one
corner-pinned end and one threaded end: the tilt anatomy, per unit. Two CONTROL wedges have
the same shape and the same seam crossings but their apex on no seam, so it is an interior
vertex of one chain that §10.6's snap already resolves.

An UP-pointing triangle does not work, and the reason is worth keeping: a shallow seam
through its apex does not enter the downward wedge, so it passes THROUGH — the vertex is
degree 4, and on the lattice it splits into two degree-3 junctions ~2px apart whose arms are
2px long (measured while authoring: `arm 2px < 6`, no verdict at all).

It is ungated because a lattice pin is at most 0.71px by construction and a whole-case p95
dilutes that far inside tier 0's 2.5 — **no case-level tolerance can be RED on this
mechanism**. The red gate is `test/planar-thread.test.ts`, which measures the junction
against the authored corner it is supposed to be. Its fixture samples the label at pixel
CENTRES, so the staircase is an unbiased quantization and the authored apex is exact in
lattice coordinates rather than a blessed number:

| | before | after |
|---|---|---|
| seam junction, off the authored apex (48, 48.380) | (48.000, 49.000) — **0.620px** | (48.017, 48.522) — **0.143px** |
| worst arm node vs its authored line | **0.581px** | **0.127px** |

Three companions keep it honest: the corner must not be ROUNDED by being placed (the reason
§14 refused it — the fitted arms' opening must survive), a CONTINUATION under the same seam
must still take §14's through fit, and `cornerJunctions: false` must be byte-identical to
the no-palette trace.

### 17.3 The fix, and the half of it that was measured and rejected

`planarThread.ts`, in the same rank, on the other side of the same turn gate: fit each strong
arm's own line over the window the turn gate already used (junction-first, `THROUGH_SPAN`
12px, no gap), and place the junction at their INTERSECTION. Both arms must clear `ARM_BOW`
or the junction keeps its lattice corner — a bowed arm's "line" is a chord of something
turning, and intersecting against a chord throws the apex px ALONG the other arm (measured,
with the veto removed: moves reach 10.4px). §14's `MAX_MOVE` 2.0 is shared unchanged.

**REJECTED, so it is not rebuilt: the one-arm NORMAL correction.** With only one usable arm
the junction can still be corrected in that arm's normal direction — §14's own rule, since
the along-edge position is the weak boundary's business. It is geometrically right, it is the
only branch that fires on the Affinity witness, and it does improve the junction itself
(0.50px → 0.27px off the authored outline, all five). It was built, measured, and dropped:
the correction has a component ACROSS the OTHER arm, whose chain is still on the lattice, so
it tilts that one instead.

| | apex only | apex + normal |
|---|---|---|
| chamfer better / worse, over the 110 GT-scorable marks | **6 / 3** | 8 / 6 |
| `affinity-designer` corners recovered (was 5/7) | **5/7** | **4/7** |
| Affinity authored-straight-run swing, Σ over 22 runs (was 7.39px) | 7.39 (inert) | 7.57 |
| Affinity Σ mean offset (was 3.66px) | 3.66 (inert) | 3.37 |

The mean improves and the swing does not, which is the signature of trading one arm's error
for another's. Fixing it properly means propagating the endpoint correction into the first
few lattice points of the arm that turns — §15 territory, not this one.

**Also measured and NOT taken: a wider move cap for the apex branch.** An acute apex is the
one place a bigger move is legitimate (the raster erodes a narrow tip, so the true corner
sits px past the lattice), and `seam-corner`'s 17° wedge is refused at 2.16px. But the sweep
saturates instantly — every value from 3 to 12px does exactly the same thing, that one
junction and nothing else, for @512 chamfer 0.214 → 0.209 against @256 0.196 → 0.200. A knob
that trades one lane against another for 0.005px does not earn its place.

### 17.4 After (the numbers)

`seam-corner`, the driver, at all three resolutions — corner recovery perfect throughout, so
nothing is being bought by melting a corner:

| | chamfer | p95 | corners | nodes |
|---|---|---|---|---|
| @256 | 0.214 → **0.196** | 0.639 → 0.664 | 37/37 | 110 |
| @512 | 0.242 → **0.214** | 0.661 → **0.642** | 40/40 | 110 → **108** |
| @1024 | 0.295 → **0.262** | 0.646 → **0.608** | 38/38 | 106 → **104** |

Five of the six seam apexes are placed (`◆ APEX`); the sixth is the 17° wedge refused by
`MAX_MOVE` above. Five more corner junctions — the wedge BASE corners, where the 12px window
crosses the base — are refused by the arm gate reading 1.08–1.57 bow on one side.

**Blast radius: 5 of the 68 A/B outputs move**, and the biggest of them is the strongest
evidence in this section. `checker` traced with GRADIENTS ON posterizes its own AA into weak
bands, so every one of its 3588 cell corners becomes a rank-firing corner junction with two
straight arms — and there the fix is measurable at case level:

```
checker, gradients ON:  chamfer 0.222 → 0.107   p95 0.829 → 0.411
                        corners 3556/3588 unchanged, nodes 10466 unchanged, items 1760 unchanged
                        961 of 1024 16px cells better, 0 worse
```

Identical topology, identical node count, boundary error halved — which is what a pure
sub-pixel junction placement is supposed to look like, and the reason to trust the number
rather than the mean-ΔE trap. The other four: `scale-blind` grad ΔE mean 12.450 → **11.635**,
`logo-fedex` grad 0.9238 → **0.9117** (−2 nodes), `logo-coca-cola` grad 4.2316 → **4.2229**
(p99 55.99 → 55.72), and `logo-instagram` FLAT 1.3444 → 1.3458 — a +0.1% local trade confined
to nine 16px cells in one glyph (3 better / 6 worse), p99 unchanged, −2 nodes. It is not the
§15.8 counter: that ROI does not move.

**Two caveats on that evidence, because the numbers above read stronger than the change is**
(both user-raised from /labs/ab — "I don't really see any improvements" — and both measured
rather than conceded):

- **The loudest witness is in a lane the product never chooses.** `suggestGradients(checker)`
  returns **false**: the rampiness probe (§ the gradients auto-default) correctly traces that
  art FLAT, and the flat lane has been byte-perfect — ΔE 0.000 against its own input — since
  §9.8 landed on 2026-07-20. So `checker` gradients-ON is a lab lane the A/B stamps freeze on
  purpose (so a change cannot hide in the setting you were not looking at), not a picture any
  user gets. The halving is a real measurement of the mechanism; it is not a product win.
- **No mark in the gallery slice exhibits mechanism (a) at all**, so on real art this fix
  buys nothing visible. Measured from the frozen stamps, the total footprint of every gallery
  change is: `logo-instagram` flat **102 px**, `logo-fedex` grad **104 px**, `logo-coca-cola`
  grad **184 px** — each out of ~131k. Cropped at 10×, the instagram change is a wash with a
  slight local regression (ROI mean ΔE 2.815 → **2.876**, p99 29.17 → 27.89). The accurate
  claim for this section is *the mechanism is closed and gated*, not *the marks look better*;
  the marks that would benefit are the ones this corpus does not yet contain.

The tier-0 FLAT lane is untouched, as §14's zero-blast-radius property predicts — ordinary
flat art has no weak boundaries, so the rank never fires. Corner watchlist byte-stable:
gear-teeth **52/60**, bar-caps **43/43**, sharp-star **11/11**, cross-bars **10/10**, checker
**3556/3588 (99.1%)**, and `band-cross` — §14's control — byte-identical at 25/25.

Suite **354 → 358 pass / 2 skip** (+4, all in `test/planar-thread.test.ts`); truth gate
62/62, scale gate 7/7 with its four KNOWN_DEFECTS unchanged.

**Residue, named.**
- Mechanism (b) above — a corner NEAR a junction, its arm truncated by the seam — is
  untouched, and it is what the §0 row now carries. `affinity-designer` is its witness and is
  byte-identical under this fix.
- `THROUGH_SPAN` is still a fixed 12 absolute px, so the arm window and therefore `ARM_BOW`
  are resolution-blind. §15.6's audit already flagged this constant (it flips §14's
  line-vs-circle winner between 256 and 2048); §17 inherits the problem rather than adding to
  it, and the honest fix is the same one — shorten the window until its own samples are
  collinear, which needs a case that demands it.
- The arm gate is a one-sided veto by construction (§17.1), so a junction whose corner is
  real but whose two arms are both gently curved is left on the lattice. Nothing in the
  corpus measures the cost of that today.

---

## 18. The apex that outran its evidence (issue #17, 2026-08-08)

`snapCornerToArms` places a corner at the INTERSECTION of the two lines fitted to its arms.
On a raster-ERODED tip that is the whole point — a shallow star point genuinely sits px past
the last labelled pixel, and reconstructing it is what §10.2 measured as `sharp-star`'s 11/11
corner recall. On an ACUTE CURVED counter the same arithmetic misfires: each "arm line" is a
CHORD leaning into the lens, and the two chords cross px past the real tip. The reported
witness (`logo-instagram`'s script 'a', @512, user-reported twice) put the counter's apex
3.4px above its own tip, in pixels whose luminance is 57 — solid ink.

### 18.1 Phase 0: the instrument, and the two hypotheses it killed

`src/devtest/apexDiag.ts` — an observational sink in the fit (`PlanarFitOptions.apexDiag`,
the `pinDiag` pattern) joined to the source raster. Per reconstructed apex it walks the ray
from the lattice vertex to the apex and recovers the OWN region's coverage α by projecting
the sampled colour onto the own↔other line **in sRGB** (where the rasterizer composited it;
Lab curves the mixing line), sampling BILINEAR (§14's trap: nearest-neighbour quantises the
very trail being measured). `own` is read from the raster 2.5px BEHIND the vertex, so convex
and concave corners need no separate treatment. Census @512: **3582 scored apexes over 142
gallery marks, 531 overshooting the raster's own coverage by > 1px and 297 by > 2px.**

**Killed hypothesis 1 — the overshoot distance alone.** The obvious rule, and the one the
issue proposes: refuse a reconstruction landing more than X px past the coverage. Not
separable. `acute-counter`'s own eroded 10° spike @256 overshoots **2.57px** while landing
**0.50px** from its authored apex, and a `gear-teeth` tooth @256 overshoots **3.55px** — both
RIGHT, and both inside the range of the lens tips the rule exists to refuse (6.23–10.25
@256). Shipped as-is it cost the spike its reconstruction: 0.50px → **7.07px**.

**Killed hypothesis 2 — the MEAN coverage along the ray.** The natural repair, and wrong for
a reason worth keeping: the worst reconstructions travel so far that they cross the ink and
re-enter the own colour on the far side, so their mean reads **0.303 / 0.252** — *higher*
than the legitimate spikes' 0.284. Any statistic averaged over the whole segment inherits
that. Only the CONTIGUOUS run from the lattice vertex (`reach`) is immune.

**What does separate** is the FRACTION of the distance the raster's own material covers.
Erosion only hides the last sub-pixel sliver of a tip, so its trail runs most of the way
(spikes: 5.00/7.57 = 0.66, 3.75/5.98 = 0.63, past 1.0 at finer rasters). An over-reconstruction
leaves the shape at the lattice vertex and keeps going (lens tips: 0.00–0.53, median 0.20).

### 18.2 The fixture, and what it took to make it measure ONE thing

No existing case carries this anatomy. `wedge-counter` was measured for it FIRST and does not
reproduce (max overshoot **0.21px**): its wedges pinch out sub-pixel and the lattice fuses
them, which is §15.8's mechanism. So `acute-counter` (genEdgeCases, TRUTH_CORPUS tier 0) —
lens counters of two circular arcs, both arms curved, sweeping the tip ANGLE as the primary
axis because a slope error divides by the tangent of the half-angle. Its bottom row is the
CONTROL that makes it a test rather than a target: eroded ink spikes whose reconstruction is
RIGHT.

The first draft was **wrong in a way only measurement caught**: its 24° cells came to 1.5px
of width @256, were dropped WHOLE (authored tip **120–143px** from any fitted node), and
would have scored this mechanism with a thin-feature loss (§12's territory). Every cell is
now ≥ 3.7px wide @256.

Two cheaper gates were also tried and are recorded as dead ends: a chain-only anatomy (the
`test/planar-pin.test.ts` shape) cannot exercise a rule whose only input is the raster, and a
hand-rendered two-colour lens UNDER-reconstructs instead (3.21px short, unchanged by the
rule) — below ~6px of width a lens's tips erode faster than its arms converge.

### 18.3 The rule, and the sweep that chose it

`src/devtest/apexSweep.ts` sweeps both terms against BOTH sides at once — the authored-tip
error on `acute-counter`, and corner recall on every control whose recall this snap buys.

**The control side does not constrain the choice at all**: `sharp-star` 11/11, `gear-teeth`
52/60, `bar-caps` 43/43, `cross-bars` 10/10, `band-cross` 25/25, `checker` 3556/3588 are
**byte-identical under every rule in the sweep, at 256 and 512 both**. What picks the rule is
the eroded-spike control, and it is a knife edge on the reach fraction:

| rule | acute-counter Σ tip error @512 | worst | **SPIKE control** |
|---|---|---|---|
| off (pre-§18) | 53.7 | 6.87 | 2.01 |
| overshoot > 2.5 alone | 19.5 | 2.64 | **7.07 ✗** |
| overshoot > 2.5 & reach < 0.70·moved | 19.5 | 2.64 | **7.07 ✗** |
| overshoot > 2.5 & reach < **0.60**·moved | **19.5** | **2.64** | **2.01 ✓** |

0.6 is the middle of the measured gap (defect ratios top out at 0.53, surviving spikes start
at 0.63). `APEX_OVERSHOOT_MAX` 2.5 leaves every @512 survivor untouched; 2.0 buys 3px of Σ
and starts clipping `gear-teeth` and `fedex`, which is not worth the blast radius.

**REJECTED, so it is not rebuilt: falling back to the lattice vertex.** The four existing
refusals in this snap all do that, so it was the first thing built — and it is the wrong
correction. Where a tip is genuinely if partly eroded the truth lies BETWEEN the two, and
pinning to the lattice drags the whole adjacent arc in: `acute-counter` @256 boundary p95
**2.13 → 3.46**, worse than the overshoot it removed. CLAMPING to `reach` instead — the point
where the raster's own material actually stops — is better everywhere and worse nowhere:

| acute-counter | chamfer | p95 |
|---|---|---|
| @256 | 0.479 → **0.443** | 2.13 → 2.13 |
| @512 | 0.304 → **0.267** | 0.80 → **0.78** |
| @1024 | 0.211 → **0.190** | 0.97 → **0.96** |

Region recovery 3/3 and corner recovery unchanged at all three.

The probe lives in `planarAssemble` (the layer that holds both the raster and the palette)
and reaches the fit as a per-edge closure, so `planarFit` stays pure geometry and every
label-only caller — tests, diagnostics, synthetic label maps, an EXT-sided border edge — is
byte-identical by construction.

### 18.4 After (the numbers)

Gate: `test/planar-apex.test.ts` (5 tests). It is red-before-green **structurally** rather
than historically — each test measures `apexEvidence:false` against the default in the same
run, and its preconditions assert the pre-§18 state (Σ > 40px, worst tip > 5px, worst
overshoot > 4px), so the gate cannot pass by the rule silently never firing.

| | before | after |
|---|---|---|
| worst OVERSHOOT past an authored tip, `acute-counter` @512 | **6.85px** | **2.63px** |
| Σ over its 14 authored lens tips @512 | 53.7px | **19.5px** |
| the eroded-spike control | 2.01px | **2.01px** (untouched) |

**On the real marks**, scored against the AUTHORED SVG (flat lane, @512) — this is where §18
differs from §17, which closed a mechanism no gallery mark exhibited:

| mark | chamfer | p95 | corners | nodes |
|---|---|---|---|---|
| `instagram` — **the reported witness** | 0.4411 → **0.4000** | **2.633 → 1.506** | 8/9 | 368 → 368 |
| `coca-cola` | 0.3350 → **0.3193** | 0.905 → **0.817** | 8/12 → **9/12** | 256 → **234** |
| `chupa-chups` | 0.2232 → **0.2110** | 0.652 → **0.639** | 54/62 → **55/62** | 526 → 520 |
| `mastercard` | 0.2817 → **0.2735** | 0.668 → 0.666 | 48/49 | 308 → 306 |
| `ibm` | 0.2428 → **0.2414** | 0.678 → **0.674** | 119/127 → **120/127** | 374 |
| `mercedes-benz` | 1.2284 → 1.2308 | 8.225 | 11/32 → **13/32** | 574 → 576 |
| `firefox` | 4.2128 → **4.2046** | 35.150 → 35.156 | 21/33 → **25/33** | 576 |
| `fedex` | 0.2104 (inert) | 0.710 | 37/37 | 131 |

No mark loses a corner; five gain. `mercedes-benz` trades 0.0024 of chamfer for two corners.
Corpus-wide over the 42 gallery marks the census slice covers: apexes overshooting their
evidence by > 1px **221 → 128**, 97 clamped, and the worst overshoot collapses from 6–13px to
under 2.5px on a dozen marks (`soundcloud` 12.82 → 2.33, `reddit` 11.93 → 2.08, `whatsapp`
11.33 → 2.18, `snapchat` 9.11 → 1.51, `tripadvisor` 7.93 → 0.34).

**Blast radius: 14 of 70 A/B outputs move**, 13 of them gallery marks. The only fixture that
moves is `sharp-star` **gradients-ON** — and the flat lane, which is the gated one and the one
the product chooses, is **byte-identical**. The gradient lane improves (chamfer 0.3263 →
0.3132, corner recall 11/11 unchanged, p95 0.911 → 0.921): its bottom-left point's near-tip
node lands 2.00px from the authored tip instead of 2.89px.

Suite **364 → 371 tests** (369 pass / 2 skip); truth gate green at 256 and 512 including the
new `acute-counter`, scale gate unchanged.

**Scope it honestly.** What remains is the rule's own resolution: a residual overshoot of
~2.6px at the worst tip, because the bound is on the overshoot past the RASTER's evidence and
that evidence stops a little inside the authored tip — the last sub-pixel sliver of an acute
counter carries no measurable coverage. Closing that needs a model of the tip, not a probe.

---

## 19. The arm that was measurably a curve (issue #7, 2026-08-11)

`snapCornerToArms` fits a straight LINE to each arm and intersects. §18 already named what
that does on a curved arm — the line is a CHORD leaning into the curve — and closed the
far face of it (reconstructions outrunning the raster by > 2.5px). This issue is the near
face: the chord intersection slides ALONG the other arm by 1–3px, under §18's floor, or
with the reach probe blinded because the ray runs ALONG a real edge whose AA fringe reads
as coverage (reach ≈ moved). The reported witness is `logo-mastercard`'s wordmark: the
'e' eye's flat bottom overshoots both authored corners laterally (2.14 / ~1px), poking
white needles into the stems — the "needle" the issue circled — and the 'm' left crotch
keeps the mark's ONE unrecovered corner (48/49), its apex pushed 3.4px AWAY from the
notch by two bent chords (bows 0.90/0.77).

### 19.1 Phase 0: the instrument, and what it ruled out

`src/devtest/needleDiag.ts` — locate (hot-sample clustering over the geomScore
diagnostics), attribute (a fit-flag matrix, §16's `lowresDiag --fit` shape), inspect
(label-map and crop-sheet panels, per-apex records via the §18 `apexDiag` sink), and
census (all 128 svgGround-scorable gallery marks @512 flat, every apex record joined to
its nearest visible authored corner within 4px).

- **The fit-flag matrix is inert** on all three witness sites: `subpixelEdges`,
  `junctionReseat`, `apexEvidence`, `arcSnap`, `smoothPasses=0` — none moves the needle
  or the notch. The mechanism sits in the corner snap itself.
- **The label map already truncates a notch tail** ~1–2px (the AA majority vote cannot
  keep a sub-pixel white wedge), and the fit then rounds the blunt lattice V further.
- **The census stratifies by arm bow** — reconstruction quality degrades continuously:

  | max arm bow | n | mean errApex | mean errLattice | worse-than-lattice |
  |---|---|---|---|---|
  | < 0.3 | 583 | 0.283 | 0.599 | ~0% |
  | 0.3–0.6 | 442 | 0.420 | 0.836 | 6% |
  | 0.6–1.0 | 830 | 0.843 | 1.000 | **27%** |
  | ≥ 1.0 | 36 | 1.875 | 0.993 | **67%** |

- A second family fell out of the worst-15: **near-parallel fitted tips** (147–163°),
  where the intersection is ill-conditioned ALONG the boundary and slides 3.6–5.1px off a
  lattice vertex that was 0.35–1.0px correct (`instagram` 5.05 vs 0.35). §18 cannot
  refuse these — the ray runs along a real edge, so `reach ≈ moved`.
- **Short-arm refusals at authored corners** (n=144, 29 beyond 1.5px — a blunt truncated
  notch presents as two shoulder corners 3 steps apart, both refused) are a THIRD
  mechanism, measured and left open — see the residue below.

### 19.2 The fixture, and the scorer hole it exposed

`letter-joins` (genEdgeCases, tier 0): three D-segment counters at the witness's own
scale (arc × line — the 'e' eye), three disc-union crotches authored as ONE path so the
crossing vertices are explicit (arc × arc — the 'm' crotch), a straight-arm eroded spike
and a right-angle square notch as controls. Verified to REPRODUCE before authoring
(§18.2's lesson): the scratch rack shows moved 2.81px along-chord at bow 0.92, and the
crotch apexes pushed off the bisector exactly like the mark.

The fixed counter fits to a 2-NODE closed loop (two corners, two arcs — more parsimonious
than before), and `geomScore.sharpCorners` skipped any subpath under 3 nodes: a perfectly
placed corner scored as MISSING. The scorer now reads closed 2-node loops (GT-side inert:
authored arcs arrive as multi-node cubics). That is the honest direction — the tracer
output got better and the scorer had to catch up.

### 19.3 The model, the sweep, and the three that died

The shipped arm model (`planarFit.ts`, flag `arcArms`, default true): where an arm's
samples measurably bow off their line (bow > 0.5, n ≥ 12), the window is box-smoothed,
extended while CO-CIRCULAR (the line path's collinear extension, translated to curves —
a kinked gear window breaks circle-consistency at once and extends nothing), split at its
middle, and each half gets its own LSQ direction. The two half-directions disagree by
half the window's arc turn (the φ ≥ 10° gate is the curvature test a staircase cannot
pass); the tangent at the tip END is the tip half's direction continued by φ/2, anchored
at the denoised tip-end sample. The apex is the intersection of the two arm models; §18's
evidence veto applies unchanged on top.

Measured and REJECTED on the way (each by the sweep, `needleDiag --sweep`, judged on the
fixture AND mastercard AND acute-counter at 256+512 AND the corner watchlist at once):

- **Fitted circles as the arm model.** Kasa on a ~8px letterform window collapses to a
  noise-hugging circle (r 1.7–4.1 where the authored arc is r≈14); with smoothing it
  broke the other way (a 3.35px circle×line slide at the 't'; spike control 2.01 → 4.51,
  `letter-joins` control worst 12.46). Kept behind `arcArmModel:'circle'` as the record.
- **A parabola-sagitta tangent** (rotate the chord by the sagitta-implied angle):
  over-rotates where AA fattens the sagitta — an acute @256 tip landed 2.2px PAST its
  authored apex and `acute-counter` @256 read p95 3.44, the very number §18 refused.
- **A 2·|s̄|/bow coherence gate** for staircase-vs-arc: non-separable at every K (it even
  cost gear-teeth corners) — §17.1's bow lesson repeating on a different statistic.

Four guards shipped WITH the model, each with its measured reason: a near-parallel
conditioning guard (fitted tip > 150° keeps the lattice — the census family above;
`parallel` refusals go 3 → 122 corpus-wide and every 3.6–5.1px slide in the worst-15
disappears); a tip floor (chord-estimated tip < 45° keeps the chords — at an acute tip
the intersection amplifies tangent noise by 1/sin(tip) and the chord errs SHORT, the
safe side; this is what holds `acute-counter` @256 at exactly p95 2.130 and sharp-star
at 11/11) that CONCAVE corners are exempt from (a notch's chord-tips under-read — a 77°
authored crotch reads 37.6° — and every population the floor protects is convex; the
loop winding supplies the sign); and a pin-turn floor (corrected turn ≥ 70° before the
§15 pin consumes the model tangents — a pin that leaves the turn near the 60° sharp bar
rotates a real corner into reading SMOOTH, which is how gear-teeth's marginal 67° roots
first flipped).

### 19.4 After (the numbers)

Gate: `test/planar-needle.test.ts` (5 tests, red-before-green structurally — each
measures `arcArms:false` against the default in the same run, §18.4's contract).

| letter-joins @512 | chords only | §19 |
|---|---|---|
| Σ over the 12 authored join corners | 14.07px | **8.84px** |
| worst join corner | 1.84px | **1.22px** |
| Σ over the 6 crotch vertices | 5.91px | **3.64px** |
| square-notch corners / spike control | 0.00 / 2.02 | 0.00 / 2.02 (byte-identical) |

**On the witness**, `logo-mastercard` @512 flat, scored against the authored SVG:

| | before | after |
|---|---|---|
| corners | 48/49 | **49/49** — the 'm' crotch, recovered |
| chamfer | 0.2735 | **0.2680** |
| worst invented boundary (the needle) | 2.17px | **1.30px** |
| the 'e' needle site / 'm' crotch miss | 2.17 / 2.49 | **1.05 / 0.46** |
| nodes | 306 | 294 |

Corpus-wide (the census re-run): the bow 0.6–1.0 bucket's mean error 0.843 → **0.639px**
with worse-than-lattice 220 → **136**; bow ≥ 1.0 mean 1.875 → **1.066**. The bow < 0.3
bucket is untouched to the third decimal — straight arms never enter the new code.

Controls: `acute-counter` Σtip 19.5 → 18.4 @512 with the worst tip and both spike
controls unchanged, and @256 p95 exactly 2.130 with corners 11/13 — §18's case is
preserved to the digit. Corner watchlist: sharp-star **11/11**, bar-caps **43/43**,
cross-bars **10/10**, band-cross **25/25**, checker **3556/3588** all byte-stable;
**gear-teeth 52 → 53/60** — one root corner GAINED (the pin-turn floor also stops a
pre-existing marginal pin), the only watchlist number that moves, and it moves up.
`mastercard` @1024: 61/61 both ways, worst invented 1.65 → 1.45. The 20-case golden
corpus is byte-identical (the hash gate passed unchanged), so the blast radius on
ordinary art is nil; the A/B pair for review is `before-needle` ⇄ `after-needle`.

Suite **371 → 378 tests** (376 pass / 2 skip): +5 in `test/planar-needle.test.ts`,
+2 truth lanes for `letter-joins` (green at 256 and 512 on landing).

**Residue, named.**
- The **short-arm blunt notch** (mechanism 3 of Phase 0) is untouched: mastercard's
  'a'-bowl join still misses 2.55px of notch tail — the label map truncates the wedge and
  the two shoulder corners both take the `short-arm` refusal, so nothing reconstructs.
  §10.7's cap resolver is the template for a fix (a V-turn analog emitting ONE corner);
  144 census records, mean 1.1px.
- `letter-joins` cell 2's crotch pair (authored turn 77.4°) PLACES within ~0.9px but
  still READS < 60° sharp to the corner scorer under either model — corner recall stays
  29/31 pre and post. The gate holds placement; the sharpness classification of
  moderately-turned concave corners is open.
- The census tail that remains (`ubuntu`/`chupa-chups` 3.4–4.7px) has errLattice ≈
  errApex — the LATTICE is already that far out, a segmentation-side loss no apex rule
  can reach.

---

## 20. The feature that was smaller than the broom (issue #8, 2026-08-21)

The flat lane assigns every pixel to a palette colour and then sweeps up the tiny
connected components the assignment leaves behind — anti-alias shrapnel that would
otherwise each become their own traced loop (`despeckleComponents`, paletteSegment.ts).
The broom is a plain area floor, `minRegionArea`, 50px² at the default Despeckle dial of
25. It cannot tell shrapnel from a SMALL REAL FEATURE that happens to be isolated, and
the reported witness is exactly that: `logo-ibm`'s ▼, the peak of the m's middle stroke,
cut off from the rest of the mark by the art's own white stripes and therefore its own
26px connected component. The flat trace lost it whole; the gradient trace (a different
segmenter) kept it.

### 20.1 Phase 0: which knob, and which of its five consumers

The handoff arrived with a measured proof that `--despeckle 0` recovers the ▼ (ibm
missedMax 17.84 → 3.55) and the reasonable conclusion that the 50px floor is the killer.
That is **not what the dial proves**. `paletteOptionsFor` moves TWO knobs at once:

    despeckle 25  ⇒  minShare 0.007, minRegionArea 50
    despeckle  0  ⇒  minShare 0.006, minRegionArea 24

so the experiment confounds a share floor with an area floor. Sweeping the dial narrows
it — the output is a STEP between dial 18 (`area 26`) and 20 (`area 32`) while `minShare`
climbs continuously through it — but a monotone knob can also cross a floor, so the step
alone does not attribute. `lowresDiag` gained `--floor N` / `--share F` to move them
independently, and the 2×2 is unambiguous:

    share 0.006 floor 24 → ▼ kept (26px)     share 0.007 floor 24 → ▼ kept (26px)
    share 0.006 floor 50 → ▼ GONE            share 0.007 floor 50 → ▼ GONE

**`minShare` is inert.** It was never a candidate on this art: the ▼'s ink entry holds
11.74% of the image, three orders of magnitude clear of any share floor.

The second Phase-0 residue was WHICH of `minRegionArea`'s consumers fires. It has five
(quantize's merge veto, the share-drop `real` protection, the `protect` modal clause,
`restoreErasedComponents`, `despeckleComponents`), and the earlier palette replay had
reported "no palette stage kills it" — because that replay's survival table is a
whole-image FRACTION, and 26px of a 40,000px ink mask reads as flat at every stage.
`lowresDiag --roi` scopes the lens to the feature, and the component census then names
the stage outright:

    assign 24px → blends 32px → share 32px → mode 26px → restore 26px → despeckle GONE

`restoreErasedComponents` cannot help: the mode filter ERODED the component (26 of 32
kept) rather than erasing it whole, and the restore is blind to erosion by construction.
It is `despeckleComponents`, alone, at the area floor. Note also that `segment.ts`'s
`mergeSmallRegions` — the other `minRegionArea` consumer, and the one the AA-transition-
sliver fix was built for — **is not on this path at all**: flat art goes through
`segmentFlatPalette`, not the Mumford–Shah segmenter.

### 20.2 The joint distribution, and the axis that failed

The floor exists for a reason, so the rule that spares the ▼ has to be measured on both
sides before it is written. `lowresDiag --census` replays the palette path to the exact
input of `despeckleComponents` on every tier-0 fixture and gallery mark, enumerates every
component the floor is about to eat, and scores each against an INDEPENDENT truth: `cov4`,
the mean 4×-supersampled coverage of the component's own colour over its footprint, read
off a higher-resolution render so it is not a restatement of the 1× floors.

**2,394 sub-floor components over 174 marks:**

| truth bucket | n | size p10/p50/p90 | flat3 ≥ 1 | exactFrac p50 |
|---|---|---|---|---|
| SOLID  (cov4 ≥ .90) | 98 | 1 / 11 / 31 | **10** | 0.000 |
| MIXED  (.50–.90) | 540 | 1 / 1 / 16 | **36** | 0.000 |
| FRINGE (cov4 < .50) | 1,756 | 1 / 1 / 8 | **0** | 0.000 |

The obvious axis was tried first and **REJECTED on measurement**: `exactFrac`, the share
of the component's pixels that are exactly its palette hex. At every threshold it
resurrects 40–54 FRINGE components while still missing more than half the SOLID ones —
because a k-means centroid need not equal any source pixel at all (mercedes-benz's four
grey shades read `exactFrac 0.000` at `cov4 0.96`). It is not separable.

`flat3` — §9.4's flat-interior criterion asked per COMPONENT instead of per LABEL — is.
It fires on 46 of the 2,394, and **not one of them is fringe**; the lowest `cov4` it
admits anywhere in the population is 0.797. The structural reason is the same one §9.4
gives: nine adjacent pixels all at full coverage of one authored colour is solid ink by
definition, and a coverage ramp cannot produce it, because consecutive AA pixels differ —
that is what makes them a ramp. It also carries an implicit floor worth naming: a 3×3
block needs nine pixels, so nothing under 9px can ever be spared and true salt-and-pepper
is structurally out of reach.

So it ships as a **one-sided veto that can only SPARE a component**, never dissolve one —
§17's `ARM_BOW` shape, and the right shape for a rule calibrated on 46 positives.

### 20.3 The gate, and the fixture authored for it

The reporting mark is private-corpus and cannot gate CI, so `peak-drop` is authored for
this (tier 0, verified reproducing before the gate was written): 20 downward peaks of
20/30/40/48/64 px² @512 — four sizes below the floor and one above it as the in-case
control — in four rows at quarter-unit phase offsets and two palette colours, each
isolated between two bars the ibm way. The bottom third is a ~1.8° seam whose staircase
is precisely the shrapnel the floor exists for: the OTHER control, gating the rule's
false-positive side through node count.

Two things the fixture taught, both worth keeping:

- **The region gate is colour-keyed.** `scoreRegions` buckets by RGB, so a monochrome
  mark losing a whole component is structurally invisible to it — `logo-ibm` scores
  `2/2 regions, ink 102.6%` with the ▼ gone. The first draft of the rack passed every
  @512 gate while dropping 8 of 10 peaks. This is the same all-gates-green class §10.4
  named, and the corpus-level lens that DOES see it is boundary p95 plus corner recall —
  but only once the rack's own features dominate its boundary samples rather than its
  bars. The shipped rack is deliberately short-barred for that reason.
- **A fixture cannot straddle an ABSOLUTE floor at two rasters two octaves apart.**
  Quartering the raster sixteenths the area, putting the whole rack at 5–16 px² @256 with
  no evidence on any side of the floor. `peak-drop` is therefore excluded from the @256
  lane (`LOWRES_TIER0_UNSCORABLE`) rather than listed in `KNOWN_DEFECTS_LOWRES` — a
  listed case only has to fail SOMETHING, so listing it would go blind to real @256
  regressions of everything else it draws.

`test/planar-peak.test.ts` is the mechanism gate, red-before-green in the same run via
`paletteSegment: { regionEvidence: false }`. It asserts a LADDER rather than a score,
because a count of 16 could also be a phase lottery:

    veto OFF: only the four above-floor controls painted         4/20
    veto ON : every peak from 30px² up painted, every 20px² not 16/20

The 20px² miss is the rule's resolution, not slack in it: a 5.6 × 7.1px triangle is too
thin a wedge to contain nine full-coverage pixels, so there is no evidence to read.
Recorded as `EVIDENCE_MIN_AREA` so a later fix that reaches further has to delete it
deliberately. Three further tests pin the shape: the above-floor control must be
recovered EITHER WAY (so "just lower the floor" cannot pass the case), the veto must be
one-sided feature by feature, and the seam must not shatter.

### 20.4 What it measures, on both sides

Witness, `logo-ibm` @512 flat — identical to what `--despeckle 0` bought, without
lowering the floor:

| | chamfer | p95 | missedMax | corners | nodes |
|---|---|---|---|---|---|
| before | 0.2409 | 0.674 | 17.840 | 120/127 | 374 |
| after | **0.2064** | **0.640** | **3.552** | **122/127** | 380 |

`peak-drop` @512: chamfer 0.3965 → **0.0581**, p95 **10.000 → 0.131**, corners 134/148 →
**148/148**, nodes 352 → 436.

Corpus-wide (`lowresDiag --effect`, two passes: fingerprint every mark, then score the
movers against authored geometry) — **12 of 152 gallery marks change AT ALL**, so the
rule is inert on 92% of the corpus, as the census predicted:

| mark | Δchamfer | ΔmissedMax | Δcorners | Δnodes |
|---|---|---|---|---|
| snapchat | **−0.7654** | −7.14 | 0 | +148 |
| hack-the-box-wordmark | −0.0512 | −6.02 | 0 | +6 |
| ibm | −0.0345 | **−14.29** | **+2** | +6 |
| fedex-wm | −0.0247 | −9.75 | 0 | +4 |
| parcel | −0.0132 | 0.00 | 0 | +8 |
| intel-wm | −0.0056 | −1.56 | 0 | +4 |
| ibm-wm | −0.0006 | 0.00 | 0 | +4 |
| chupa-chups | −0.0001 | −2.11 | 0 | +8 |
| soundcloud | **+0.0011** | 0.00 | 0 | +16 |

Eight better, one worse, and **no mark loses a corner** (+2 total). The one regression is
named rather than rounded away: `soundcloud` gains 0.0011px of chamfer (0.9333 → 0.9343,
0.1%) for four spared components — inside that mark's own noise, and it is the price of a
rule with no per-mark exceptions. Three of the twelve movers (`proton-mail`,
`proton-mail-wordmark`, `google-antigravity-wordmark`) are not svgGround-scorable and are
reported as moving without a number, rather than silently dropped.

Watchlist byte-stable: sharp-star **11/11**, gear-teeth **53/60**, bar-caps **43/43**,
cross-bars **10/10**, band-cross **25/25**, checker **3556/3588**, `acute-counter` @256
p95 exactly **2.130**. The 20-case golden corpus is byte-identical. Suite **378 → 383**
tests (381 pass / 2 skip): +4 in `test/planar-peak.test.ts`, +1 truth lane for
`peak-drop`.

A/B pair `before-ibm-peak` ⇄ `after-ibm-peak`: **3 of 114 outputs move** — `peak-drop`
(the target), `logo-ibm` (the witness), and `scale-blind`, which is a gain and worth
stating because it was not designed for: that fixture's 6px checker cells are 36px²
components, sub-floor by construction, and two of them were being dissolved. It now
traces exactly — chamfer 0.0024 → **0.0000**, missedMax 8.49 → **0.00**, corners
2690/2690 and parsimony 1.02 unchanged. Every gradient lane is byte-identical (the rule
is on the flat palette path only).

**Residue, named.**
- **Features under ~30px² are still dropped** — no 3×3 block, no evidence, veto silent.
  The 20px² rung of `peak-drop` is the standing witness.
- **88 of the 98 SOLID sub-floor components in the census are still dissolved**, because
  their palette entry is a k-means centroid no source pixel matches exactly
  (mercedes-benz's greys, ups-wm's `#f9b502`, wikipedia's `#efefef`). Reaching them needs
  a tolerant flat-interior test — ΔE against the entry rather than exact hex — which is a
  separate calibration with its own false-positive risk, and was deliberately NOT
  attempted here on the strength of this population.
- **The region gate's colour keying** (§20.3) is a hole in the corpus, not in this fix: a
  monochrome mark can lose any number of whole components with `regions recovered` green.
  No case gates it today.

---

## 21. The corner that was never detected (issue #23, Phase 0 only, 2026-08-21)

**No fix here.** This section exists because Phase 0 REFUTED the issue's stated mechanism
and the §0 row that carried it, and this file is where refuted claims are supposed to be
recorded rather than quietly re-derived a third time.

### 21.1 What §0 #15 said, and what is actually true

The row read: *a band seam landing 2–3px from an authored corner truncates the arm
`snapCornerToArms` reconstructs from*, with `planarThread.ts` as the fix domain. Measured
on the §20 tracer, on the row's own named witness (`affinity-designer.svg` @512 flat):

| the claim | the measurement |
|---|---|
| the corner is junction-owned | **Not a junction.** All 34 junctions of the mark enumerated (`threadDiag --all`); none is anywhere near the apex. `surveyJunctions` never sees it, at any rank. |
| a seam truncates its arm to 2–3px | **Not truncated.** The apex sits at index **102 of a 276-point chain** — ~100px of arm on one side, ~170px on the other. |
| the 133px top edge tilts, 0.71px swing | **Stale.** §14 + §17 already fixed that tilt; it measures **0.19 mean / 0.66 max** today. |

The apex error itself is real and unchanged — **1.54px** flat, byte-identical with
`reseat off` / `arcSnap off` / `beautify off`; the gradients-ON control is **1.23** (the
row's 0.97 was also stale).

### 21.2 The actual mechanism

The corner is authored at **exactly 60.0°**, which is exactly `cornerTurnDeg`. And
`detectCorners` runs on the RAW integer lattice — `detectCorners(latticePts, …)` in
`planarAssemble.ts`, *before* `presmooth`, which then receives the detected corners as
`pinned` — over a **±4-POINT** window. On a steep-diagonal staircase that window
systematically under-reads the turn:

    measured turn at the apex index, by window and pre-smoothing passes
    passes      win2     win3     win4     win5     win6     win8
    0           45.0     53.1     45.0     47.7     56.3     49.4    ← the shipped path
    1           31.0     36.9     37.4     42.3     45.7     49.4
    2           24.4     33.1     36.9     40.4     45.0     49.0

**45.0° measured at a 60.0° authored corner**, against a 60° threshold. So it is never
classified, never reaches `snapCornerToArms` (confirmed: no apex record is emitted for
it), and its node stays lattice-pinned 1.54px out. Note the non-monotonicity in window
size — that is staircase phase aliasing, §10.6/§10.7's regime, not smoothing. Forcing
`cornerTurnDeg` down closes the loop: at 60 and 50 the ROI error is unchanged
(1.155/0.311 invented, 1.234/0.324 missed); at **45** it collapses to **0.750/0.145** and
**0.911/0.153**.

### 21.3 It is not one witness

`needleDiag --turns` — every visible authored corner on every svgGround-scorable gallery
mark, stratified by its AUTHORED turn. **2,934 corners over 128 marks:**

| authored turn | n | recovered | rate |
|---|---|---|---|
| 60–65 | 78 | 43 | **55.1%** |
| 65–70 | 126 | 81 | 64.3% |
| 70–75 | 206 | 153 | 74.3% |
| 75–80 | 130 | 111 | 85.4% |
| 80–90 | 273 | 246 | 90.1% |
| 90–105 | 1615 | 1555 | **96.3%** |
| 105–120 | 227 | 204 | 89.9% |
| 120–150 | 210 | 182 | 86.7% |
| 150–180 | 68 | 39 | 57.4% |

A clean monotonic cliff toward the threshold. The 60–80° band holds **540 corners and
loses 152**; the Λ apex is one of them. (The 150–180° tail is a different regime —
near-reversals, §18/§19's territory.) This is also the most likely reading of
`gear-teeth`'s standing 53/60, whose roots are authored at 67.3°.

### 21.4 Why no fix shipped with this

The fix domain moves from `planarThread.ts` to the corner detector's TURN MEASUREMENT,
and the blast radius is much larger than the row assumed: §10.6 deliberately aligned
`cornerTurnDeg` to the scorer's own 60° sharp bar, and `sharp-star`, `gear-teeth`,
`bar-caps`, `checker` and `band-cross` all sit on that constant. So the fix is **not**
"lower the threshold" — that mints corners the scorer does not count and risks shattering
smooth art, which is precisely the trade §10.6 measured. The shape that looks right is a
scale/phase-aware turn read — the turn taken from FITTED arm directions over a longer,
evidence-bounded span instead of a fixed ±4-point chord — leaving the 60° bar alone. That
is its own Phase-0-complete pass with the whole corner watchlist as its control set, and
it needs a tier-0 fixture first (there is none: the witness is private-corpus and
ungated). §17's lesson, again: measure which mechanism a witness shows before trusting
the issue's framing.
---

## 22. The turn reading that passed every gate and was rejected on sight (issue #23, 2026-08-21)

**No fix here.** The reading §21.4 prescribed was built, measured, shipped to a PR — and
**pulled on the /labs/ab review**, because it put a visible KINK in smooth boundary all over
the corpus while every gate in this repo reported a clean win. That failure is worth more
than the mechanism was, so this section leads with it.

### 22.1 What it looked like on the numbers

The reading: at a candidate the ±4-point chord already reads within 25° of the bar, read the
turn again from two least-squares ARM directions, each fitted over as many samples as stay
straight to within the fit's own ε, and keep the SHARPER of the two — one-sided at the
detector, so nothing the chord finds today can be lost. Shared by all four turn readers
(`detectCorners`, `detectLoopCorners`, `detectOpenCorners`, `resolveLoopCaps`). Four guards
rode with it, each caught by the end-to-end sweep and each measured in:

- **NMS before the promotion is applied** — un-suppressed it costs `gear-teeth` 53 → 50 by
  welding each tooth's tip and root into one cluster (the two-scale trade §10.6 rejected),
  and reads the rack BELOW the chord baseline.
- **No promotion beside a corner the chord already found** — unguarded it took `logo-ibm`
  122 → 118 of 127 *while improving its boundary error*, §10.4's all-gates-green class.
- **A reach gate at 25°** — open past ~35° it costs `gear-teeth` 57 → 52. It is the
  statement that a corner is local sharpness CONFIRMED by arm evidence, never arm evidence
  alone.
- **A co-circular veto** — two straight arms always "explain" a small enough circle.

And an arm GAP (§10.6's `SNAP_GAP` idea applied to the reading) was built and rejected on
price: +203 unexplained sharp sites for 6 corners at gap 1, +929 for 7 at gap 2.

What that measured, over the same 2,934 visible authored corners on 128 gallery marks §21.3
used:

| authored turn | n | before | after |
|---|---|---|---|
| 60–65 | 78 | 43 (55.1%) | 51 (65.4%) |
| 65–70 | 126 | 81 (64.3%) | 103 (81.7%) |
| 70–75 | 206 | 153 (74.3%) | 166 (80.6%) |
| 75–80 | 130 | 111 (85.4%) | 117 (90.0%) |
| 80–90 | 273 | 246 (90.1%) | 251 (91.9%) |
| 90–180 | 2120 | 1980 | 1980 |

**+54 corners recovered, exactly one lost.** `gear-teeth` **53 → 57/60** — the standing
defect §21.3 predicted would fall to this. `logo-ibm` chamfer 0.2064 → **0.1978**, p95 0.640
→ **0.588**, corners held at 122/127. `american-express` **+10** corners. Corner watchlist
byte-identical except gear-teeth's gain; 6-case golden corpus byte-identical; suite green;
the rack's own ladder climbed at all three resolutions with nothing lost. `turnDiag --effect`
priced the corpus at Δcorners +54, summed Δchamfer −0.0369, corners gained on 24 marks and
lost on 1.

### 22.2 What it looked like at 5×

Kinks. On `chupa-chups`' brown ellipse, on `logo-instagram`'s lower ring, on the
`logo-mastercard` wordmark's `m`. Counted after the fact — traced sharp corners with **no
authored corner within 2.5px**:

| mark | traced sharp corners | unexplained NEW corners | furthest from any authored corner |
|---|---|---|---|
| chupa-chups | 216 → 240 | **9 sites** | 25.5px |
| logo-instagram | 196 → 206 | **7 sites** | 46.1px |
| logo-mastercard | 172 → 176 | **2 sites** | 13.8px |

Their read turns are 62–109°, i.e. they are not marginal: the reading is confidently
asserting a corner in the middle of a smooth arc.

### 22.3 Why nothing in the gate set could see it — the part to keep

Three independent blind spots, all of which had to line up:

1. **`cornersRecovered` has no precision term.** It counts AUTHORED corners recovered.
   Minting corners is therefore free by that metric, and occasionally scores as a *gain* —
   a minted kink within `CORNER_MATCH_R` of an authored corner counts as recovering it.
   "+54 corners" was one half of a two-sided quantity reported as if it were the whole.
2. **Chamfer and p95 are nearly blind to a C⁰ kink.** A kink displaces the boundary by a
   couple of tenths of a pixel over a short arc; the corpus percentiles drown it. It was not
   even silent — `chupa-chups` moved +0.0120 chamfer and +0.75 missedMax while gaining 4
   corners, and that was written up as a trade. It was the signal.
3. **The guard and its control shared an assumption.** The co-circular veto fits a CIRCLE,
   and the fixture control it was calibrated against is four DISCS. A control chosen to
   match the guard can only ever confirm the guard. Real smooth boundary is ellipses and
   curvature-varying blends — `chupa-chups`' ellipse, `instagram`'s rounded-square corner
   blends — and there the veto never fires at all. The @256 disc control DID catch the
   unvetoed reading (6 and 8 corners on two discs), which made the guard look validated.

The first two are corpus holes, not bugs in this change: **the corpus has no PRECISION lens
at all.** It can say a corner was lost. It cannot say a corner was invented. That is the
same shape as §20.3's finding that `scoreRegions` is colour-keyed, and it is why a
human A/B review is still the last gate — this is the fourth defect in this file
(§10.3's paint drift, §10.4's line-into-circle, §15.8's crown, now this) that shipped green
and was caught by eye.

### 22.4 What survives

- **`corner-turns`** (tier 0, in the truth corpus at @512 and @256): 56 circular sectors
  sweeping AUTHORED turn 61 / 65 / 69 / 73 / 77 / 81 / 100° over eight bisector rotations
  and four AA phases, whose arm ends turn exactly 90° in every cell as an in-case control,
  plus four smooth discs. It reproduces the defect §21 measured on a committed case for the
  first time (164/172 recovered, all eight misses at 61–69°), and it stands on its own as a
  corner-recall case. **Its smooth control is now known to be insufficient** — see 22.5.
- **`src/devtest/turnDiag.ts`**: the reader census. It evaluates any candidate turn reading
  at every authored corner it can locate on the lattice, without touching the tracer, and
  it is what priced chord-vs-least-squares-vs-evidence-bounded, replacement-vs-promotion,
  and the arm gap. `--at X,Y` is the single-site autopsy.
- **The measurement that the mechanism is real**, and that a reading CAN recover it: the
  cliff flattens by 54 corners. Nothing about §21's diagnosis is retracted.
- The reading itself, behind `cornerTurnEvidence` (default **false**), with its knobs, so
  the rejection stays re-measurable — the `refineJunctions` precedent (§9.3).

### 22.5 What a second attempt needs FIRST

Not another guard. A **precision lens**, and it does not exist today:

> a gate that fails when smooth AUTHORED boundary gains a C⁰ kink.

Concretely, the ingredients are already here: `sharpCorners` on the traced doc gives every
C⁰ kink the trace asserts; `svgGround` gives the authored geometry; the join is "a traced
sharp corner more than `CORNER_MATCH_R` from any authored corner, on a stretch of authored
boundary that is smooth there". That number — **invented corners per mark** — is what
`cornersRecovered` should always have been paired with, and it would have failed this change
on the first run. It is worth building whether or not #23 is ever attempted again, because
it guards every future corner change, and because the three marks above are ordinary art,
not edge cases.

Only after that: the actual open question this attempt could not answer — how to separate
"this boundary CORNERS here" from "this boundary CURVES tightly here" when both are read
from the same short, staircase-quantized window. The circle veto was one answer and it was
too narrow. A curvature-continuity test over the union window is the obvious next candidate,
and it should be calibrated on ELLIPSES and blends, not on discs.
---

## 23. The corner the corpus could not see — a precision lens (2026-08-23)

§22's post-mortem named the hole: **`cornersRecovered` is a recall number with no precision
term**, so inventing a corner is free by it, and chamfer/p95 barely move for a C⁰ kink on a
short arc. A change that put a visible kink in smooth boundary across ordinary art scored
+54 recovered corners and passed every gate. This section is the missing half.

    cornersInvented — sharp corners the trace asserts that the authored art does not have.

`geomScore.inventedCorners`, reported by `scoreGeometry`, gated by `evaluateTruthGates`.

### 23.1 The measurement, and the two drafts that were wrong

Per traced sharp corner, a like-for-like turn comparison at the CORNER's own scale:

    excess = (the traced node's C⁰ kink)  −  (authored turn over ±KINK_WIN px of arc length)

A real corner gives excess ≈ 0 — both turn by the corner angle. A tight authored arc gives
excess ≈ 0 as well. A kink laid on boundary the art carries smoothly gives the whole kink.

Two earlier drafts failed, and both failures were informative:

- **"Is the authored boundary FLAT here?"** (authored window turn < K, ignoring the traced
  side). Too blunt on curved art, and blunt in exactly the wrong direction: on the marks
  that reported §22 it exempted every kink. Probing the sites one at a time is what killed
  it — the places a bad reading kinks are **not** flat boundary. `instagram`'s glyph radii
  and `chupa-chups`' swirl turn **12–45° per ±1px** there, a 1–5px radius of curvature.
- **A WINDOW on the traced side too** (traced window turn − authored window turn). That
  re-adds the same arc curvature to both sides and the difference cancels the signal. The
  traced side needs no window at all: `sharpCorners` reads the kink straight off the node's
  handles, and that IS the turn the trace asserts at a point.

And the window has to be **±1px**, not ±5. At ±5px a 3px-radius authored arc has already
turned 60–110°, so a wide window scores any kink on it as legitimate and the census sees
nothing. ±1px is the scale at which "corner or curve" is actually a question.

Four exemptions, each for boundary a trace is RIGHT to corner at — and the first three were
each found by a census run that was obviously wrong before they existed:

| exemption | why | what it was hiding |
|---|---|---|
| the canvas BORDER | framing, not art (`collectBoundary` drops it for the same reason) | all 71 of the first run's hits on tier 0 |
| a traced JUNCTION (degree ≥ 3) | three regions meeting genuinely corner — §14/§17's subject, and where every posterization band seam lands | 4,125 of 5,609 sites |
| an authored CROSSING | a union's silhouette corners where two smooth shapes cross, and `sharpCorners` cannot see it on the authored side because it reads one subpath at a time | the rest of `checker` |
| OCCLUDED boundary | the trace cannot reproduce what the raster does not show | the same exclusion §9.6 applies to the missed side |

A traced corner further than 2px from any authored boundary is invented BOUNDARY — that is
`spuriousMax`'s job and is not counted here.

### 23.2 It catches the thing it was built for

On the marks that reported §22, with the rejected reading toggled:

| case | invented, reading OFF | reading ON |
|---|---|---|
| `chupa-chups` | 11 | **18** |
| `logo-instagram` | 28 | **32** |
| `logo-coca-cola` | 15 | **19** |
| `logo-mastercard` | 1 | **3** |
| `logo-ibm` | 1 | 1 |
| `nike` | 1 | 1 |

`ibm` and `nike` hold still, which matters: §22 was a genuine gain on `ibm` and the lens
agrees. The gallery is private and cannot gate CI, so the gate needed a fixture — and the
existing corpus could not provide one. That is the *third* hole §22.3 named: the smooth
control that change was calibrated against is four plain DISCS, and a disc has neither of
the anatomies the defect lives on (constant curvature, no blend).

**`smooth-radii`** (tier 0, authored for this): art with **no corners at all**, so every
sharp corner the trace asserts on it is invented by construction and the metric reads as a
plain count. Ellipses at aspect 1:1 → 1:8 in both orientations (a 1:8 end has a ~2.5px
radius while its flank is nearly straight — the whole curvature range on one closed path);
rounded rectangles with 2 / 3 / 5 / 8 / 12 px corner radii, each a G¹ blend from a dead
straight edge into a tight arc, plus narrow twins whose two blends nearly meet; and
curvature-ramp eggs built from four quarter-ellipse arcs. (The first draft built those eggs
from two half-ellipses, which is a LENS with a cusp at each end — a corner, in the fixture
whose whole premise is that it has none.)

Measured: the shipped tracer invents **12** corners on it, the rejected §22 reading **18**.
The gate's allowance is 12, so §22 would have gone **red on a committed CI case**.

### 23.3 What the lens found on the way in — a new §0 row

Turning it on is itself a measurement, and it is not flattering. Over the 23 gated tier-0
cases, flat lane, the shipped tracer:

    p50 0   p90 2   max 12      18 invented corners over 3 of 23 cases

`peak-drop` 2 (its own ~1.8° AA-seam control, faceted into two hard nodes), `hairlines` 4
(sub-pixel bar caps, the corpus's hardest thin-feature case), `smooth-radii` **12** — on art
with no corners in it at all, which is §0's new row. These are per-case ALLOWANCES rather
than `KNOWN_DEFECTS` entries, and that choice has a cost worth stating: KNOWN_DEFECTS is
keyed by CASE, so listing these three would switch off every other gate on them — and
`peak-drop` was made green by §20 the week before. The header of `truth-gate.test.ts` is
right that a recorded number is worse than a recorded boolean; the alternative here was
worse still. The numbers are named, explained, and can only come down.

**Scope, stated honestly:**
- **FLAT art only**, the same predicate the region and ink gates use. On gradient art the
  traced regions are posterization bands whose corners are a property of the banding rather
  than of the authored outline, and the junction exemption does not fully model them —
  measured, five tier-1 cases report 1–3 invented corners. Gating that here would
  misattribute a banding question to a corner-precision one.
- **@512 only.** Every radius in the corpus halves at 256, so "corner or curve" is a
  different question there and the allowances would be a different calibration. §12's
  warning about gating tier-2 corners for the first time inside the low-res lane applies
  exactly.
- A corpus-wide gallery sweep is still missing: the first attempt OOM'd on the brute-force
  nearest-sample query (since replaced with a bucket grid, but the run was not repeated).

### 23.4 Where this leaves #23

The issue stays open and its §0 row is unchanged — the turn is still under-read on the
lattice, `gear-teeth` still stands at 53/60, and the cliff toward the 60° bar is still
there. What has changed is that a second attempt can now be judged before a human has to
look at it: the reading that recovers those corners must do it **without moving
`smooth-radii` off 12**. §22.5 asked for exactly this gate; it exists now.

The open question that attempt could not answer is unchanged and is the real one — how to
separate "this boundary CORNERS here" from "this boundary CURVES tightly here" when both
are read from the same short, staircase-quantized window. The circle veto was one answer
and it was too narrow. Whatever the next one is, it now has to be calibrated on ellipse
ends and straight→arc blends, because that is what `smooth-radii` is made of.

---

## 24. The ring that could not be one circle (issue #10, 2026-09-03)

**Status: SHIPPED.** `ring-cross` circle recovery **0.78 → 0.07** px, and the mark the issue
was filed on — `logo-olympic-rings` — stops kinking through its crossings. Two cases the
defect list did not know it owned came with it: `bloom` 0.84 → 0.12, `overlap` 0.38 → 0.03,
and `petals` left the scale gate's `KNOWN_DEFECTS` at drift 3.98× → 1.84×.

### 24.1 The framing that was wrong, and how the counterfactual showed it

§0.1 re-measured this issue on 2026-08-23 and concluded, with a census to back it: of 24
candidate region loops on `olympic-rings`, **24 are rejected by `corner-veto`** and not one
reaches the circle fit. The reading was that `CORNER_TURN` is structurally mismatched — it
reads `maxTurnRad` over the WHOLE loop, and on crossing-dense art the loop's turn is
dominated by its own junction corners — and the prescription that followed was a loop-local
turn, or excluding junction corners from the veto's reading.

The census was right and the prescription was wrong, because `ringDiag` reports the FIRST
gate that declines and that is not the same as the only one. Running the counterfactual the
option switch already allowed (`planarFit.cornerVeto: false`) settles it in one line:

| case | veto | nodes | edges | verdicts |
|---|---|---|---|---|
| olympic-rings | on | 212 | 69 | corner-veto 24 |
| olympic-rings | **off** | **212** | **69** | dev-exceeds-budget 24 |
| checker | on | 7104 | 3596 | corner-veto 1760 |
| checker | **off** | **7195** | 3596 | **snapped 992**, dev 768 |

Switching the veto off changes the rings **not at all** — byte-identical output; all 24
loops simply fall through to the next gate. It is not the gate holding them back, it is
merely first in the queue. Meanwhile the same switch rounds 992 checker cells into discs, so
the veto is doing exactly the job §9.8 built it for. Both halves of the prescription — loosen
the turn reading, or exempt junction corners — would therefore have bought **zero** on this
mark while re-opening the scalloping.

The lesson generalises past this issue: **an instrument that reports the first failing gate
cannot tell you the gate is load-bearing.** `ringDiag`'s own header says a `corner-veto`
verdict and a `dev-exceeds-budget` verdict "lead to completely different fixes" — true, but
only once you know which one you would actually hit. The counterfactual costs one flag.

### 24.2 What is actually wrong: a ring is not a loop, twice over

With the veto off, the real gate reports numbers that are not close:

| loop | edges | fitted r | radialDev | budget |
|---|---|---|---|---|
| 1 / 2 | 12 | 77.4 / 77.1 | 12.62 / 12.91 | 1.50 |
| 3 / 4 / 5 | 10 | 74.9–75.8 | 11.87–12.33 | 1.50 |
| 3 / 4 / 5 | 8 | 47.9–50.0 | 15.21–18.22 | 1.50 |

`olympic-rings` is authored `r="49.25" stroke-width="9.5"` on a 342-wide canvas, so at the
512px raster its inner radius is 66.6px and its outer 80.8px. Every fitted circle lands
*between* the two, missing by roughly half the band. That is not a calibration that drifted;
it is the wrong model:

1. **A ring's face carries two radii.** Where one band passes over another, the covered
   ring's annulus loses a chunk, and what is left is a "C" whose single boundary loop runs
   outer arc → cap → inner arc → cap. Those points come from two concentric circles a
   band-width apart. No single circle fits them at any threshold.
2. **A ring's arcs live in several faces.** `ring-cross`'s middle ring is cut into four
   C-faces, each holding exactly one outer arc and one inner arc — so even a grouping that
   handled (1) could never put two arcs of the same circle together, because they are never
   in the same loop. **A ring is a document-level object; a loop is a face-level one.**

This also explains why the corpus never caught it. `concentric` and `annulus` are rings too,
but their loops are single closed edges that go to 1a's disc snap and never enter §1d at
all — `ringDiag` reports 13 and 9 `single-edge-loop` verdicts respectively. The mechanism had
no fixture exercising it in the direction where it fails.

### 24.3 The fixture, and the lens the corpus was missing

The issue's own protocol note turned out to be a hard requirement rather than a preference:
`olympic-rings` is authored with `stroke`, so `svgGround` refuses it outright and no claim
about it can carry a number. `ring-cross` is the same mechanism as FILLED ANNULI — three
interlocking rings, the middle painted first so it goes under both neighbours, at the
witness's own scale (r 72px / band 16px @512, against olympic-rings' 73.7 / 14.2) — plus a
**fourth ring, identical and touching nothing**, as an in-case control.

Authoring it proved the second half of the problem: **it passed every gate.** chamfer 0.10,
p95 0.51, parsimony 1.9× against limits of 1.0 / 2.5 / 3.0, region recovery 5/5. The rings
visibly wobble and the corpus had no number for it, for three separate reasons:

- `chamfer`/`p95` average over the whole document, so a defect confined to the arcs around a
  crossing is diluted by every correct pixel elsewhere;
- `cornersInvented` (§23) exempts traced junctions of degree ≥3 and authored crossings **by
  construction** — precisely where this lives;
- `hausdorff` sees the excursion (1.74px vs `annulus`'s 0.13px) but is a whole-document max
  with no notion of the right answer, so it cannot be gated tightly without failing art that
  has no exact answer.

A circle **does** have an exact answer, and that is what makes the residual attributable.
`geomScore.circleRecovery` finds the authored circles in the ground truth and measures the
traced boundary's radial residual against each. One-sided on purpose (traced → authored):
occlusion then needs no special case, because where a ring is covered there is simply no
traced boundary to score, whereas the missed direction would charge the trace for arcs the
renderer never drew.

**The de-biasing is the design, not a detail.** The gate is the p95 residual with each
circle's own MEAN residual removed — "did the arc stay on one circle", which is exactly what
§1d promises. It paid for itself on the first corpus run: `acute-counter` reads a raw p95 of
0.81 that is **entirely bias** (its 40px circle comes back a uniform 0.79px undersized,
p50 ≈ p95 ≈ |bias|) and a spread of 0.03. That is a different defect — a real, previously
unmeasured one, now §0 row #17 — and rolling the two together would have let a fix for
either claim the other's ground.

Calibrated @512 over the 13 flat tier-0 cases with authored circles (`ringDiag --circles
--corpus`). The corpus split into two populations an order of magnitude apart:

| | cases |
|---|---|
| circles the snap CAN fit | corner-turns 0.01 · aa-seam 0.02 · smooth-radii 0.03 · gear-teeth 0.03 · acute-counter 0.03 · annulus 0.04 · concentric 0.07 · band-cross 0.08 |
| circles CUT INTO ARCS | overlap 0.38 · ring-cross 0.78 · letter-joins 0.81 · bloom 0.84 · shaded-ink 1.16 |

The limit is **0.25** — 3× above the clean maximum, 1.5× below the lowest defect. An absolute
"this is wrong" bound, not a drift band. RED on landing: `ring-cross`, 0.78.

### 24.4 The fix: families, not loops

`snapCoCircularLoops` keeps its loop pass unchanged, and gains a second pass that runs ONCE
over the whole topology on the open edges the first did not claim: **fit each open edge on
its own, cluster them all by the circle each found, snap every cluster to its own refit.** A
ring's outer arcs become one family and its inner arcs another, wherever in the document
they were traced.

**Why this does not re-open the checker scalloping.** §24.1's counterfactual says the veto is
load-bearing, so it is kept — but applied per EDGE, which is the level at which what it says
is true. A checker cell's 90° turns sit at its VERTICES, exactly where a crossing ring's do,
which is why a whole-loop reading cannot tell the two apart. Read per edge and they separate
cleanly: a cell's side is a straight chain that turns 0° and fits no circle worth having,
while a ring's arc turns smoothly and fits its own radius. Three more guards a straight chain
cannot pass: its own fit must hold within budget, a family needs at least two member arcs,
and their combined sweep must reach `FAMILY_MIN_SPAN`.

Three things were measured wrong on the way and are worth keeping written down, because each
looked like a working fix:

**(a) An open chain is not a closed one.** `maxTurnRad` wrapped the last direction back onto
the first — right for a region loop, catastrophic for a single arc: the wrap step is the
CLOSING CHORD, which runs the opposite way, so an arc's own sweep reads as a 150° corner.
Every one of `ring-cross`'s eight ring arcs was vetoed at 132–162°, on fits of dev
0.53–1.04px. The pass looked correct and did nothing at all.

**(b) A short arc's circle fit is not usable as a clustering key.** `ring-cross`'s four ring
arcs fit r 78.0–78.4 with centres scattered over 2.6px, on a ring authored at r 80.0. A
pairwise test on (cx, cy, r) either misses real members — it left one of the four inner arcs
behind — or merges wrong ones. The pass now SEEDS AND GROWS: round 0 groups on the loose
proxy, then refits, and from round 1 the test is the one that matters — does this candidate's
own polyline lie within budget of the family's circle. The refit over several arcs is
conditioned by their combined sweep and lands within 0.14px of the authored circle
(c = (255.94, 159.99) r 79.86 against an authored (256, 160) r 80.0).

**(c) A snapped circle is worth nothing if the junctions are on someone else's.** With the
family fitted correctly, the output still barely moved: the middle ring landed at radius
80.6 while its family circle was 79.86. `arcSlice` splits into ≤90° pieces, so a sub-90° arc
emits **only its two pinned endpoints** — the circle enters solely through the handle
lengths. Those endpoints are crossing junctions, and the loop pass had already claimed them
for the neighbouring ring and snapped them radially onto ITS circle. The arc was therefore
displaced bodily off its own. The fix is the one §0 #15 named as the residue, in its
narrowest possible form: **a vertex claimed by two snapped circles goes to their
intersection**, capped at `JUNCTION_XING_MAX_MOVE` 3px (§10.4's MIN_MOVE lesson from the
other side — a junction move needs positive evidence, and a far intersection is not it). A
crossing is a point of both rings; the radial snap can only ever satisfy one.

### 24.5 `FAMILY_MIN_SPAN`, and the regression that set it

The sweep floor is the guard that stops the pass ASSERTING a circle it has not seen. It was
first set at 0.6 rad (34°) on intuition, and the corpus caught it immediately:
`schild-flat`'s worst seam went **68.5 → 77.4 ΔE**, from one family of two arcs covering 65°
between them. Two short shallow chains that happen to agree are not evidence of a ring.

The census (`ringDiag --families`, both lanes @512) says where the bar goes. On the fixture
corpus every family the pass finds sweeps **285–358°** — near-complete rings, as the
mechanism predicts. The gallery is a continuum from 45° up, with no gap, and every family
below ~100° has exactly two arcs. At **π** (half a turn) every fixture family survives, all
eight of `olympic-rings`'s do, and the short pairs are refused — `schild-flat` returns to
byte-identical.

The rule is stated as a claim about the art rather than a threshold that happened to work: a
ring cut by crossings keeps most of its 2π by construction, so anything covering less than
half a circle is not a cut ring.

### 24.6 Results

| | before | after |
|---|---|---|
| `ring-cross` circle recovery | **0.78** | **0.07** |
| `ring-cross` middle ring, outer / inner | 0.69 / 0.78 | 0.07 / 0.03 |
| `ring-cross` control ring (untouched) | 0.04 | **0.04** |
| `bloom` | 0.84 | **0.12** |
| `overlap` | 0.38 | **0.03** |
| `bloom-flat` nodes / meanΔE / SSIM | 46 / 0.113 / 0.9922 | **34 / 0.060 / 0.9939** |
| `petals` scale drift @256 vs @1024 | 3.98× | **2.01×** (still listed — see §24.7) |
| `olympic-rings` worst spread (the witness) | 0.785 | **0.664** |
| every other case with authored circles | — | unmoved |

The control ring is the load-bearing row: same ring, same image, same raster, no crossings —
and it does not move. A fix that bought the crossed rings by loosening the ring test would
show up there.

A/B, both lanes: 17 of 84 outputs moved, all of it circle-bearing art (ring-cross, bloom,
overlap, petals, nebula, aa-seam.grad, gradient-flat; gallery chrome, instagram, mastercard,
olympic-rings). Suite 463/463.

### 24.7 The user's A/B review, and three things it found

The fix went to /labs/ab before it went anywhere else, and the review is why §24 has this
section. Four observations, and only one of them was a bug — but that one was real.

**(a0) THE FIRST ANSWER TO (a) WAS VERIFIED ON THE WRONG INPUT.** Worth the most attention
of anything in this section. The A/B FIXTURE lane rasterizes its SVG cases on a TRANSPARENT
background — `writeAbSnapshots` only composites on white for the gallery lane, "the
transparent input the app's own rasterization produces" — while `circleRecovery`, the truth
gate and every measurement in §24.1–24.6 render on white. Those are two different traces of
`bloom`: with alpha the discs stay translucent and the region graph differs. The junction fix
in (a) is real and it is measured, but it is measured on the composited trace, and the
picture in /labs/ab did not move at all. The user said so — "I don't see any difference" —
and was right; the stamp was current and the fix simply did not reach that input.

Two habits come out of it. Regenerating a stamp is not evidence that anything changed: diff
the SVGs (`cmp`), which takes a second. And when a lab view and a gate disagree, check what
each one is actually FEEDING the tracer before explaining the difference — a byte comparison
against a freshly traced doc is worthless if the two used different rasterization, which is
exactly the false "STAMP IS STALE" reading that cost a round here.

On the alpha input the asymmetry is stark in the numbers, and it is not the junction rule:
the LEFT disc reads spread **0.77** and its mirror image on the right reads **0.01**. The
cause is a KNIFE EDGE in the round-0 grouping. That round compares fitted RADII within
`FAMILY_CLUSTER_REL · r` = 6.23px, and the two short pink arcs fit their own circles at
r 110.7 on a disc authored at 104 — missing by 0.6 — while their mirror images on the blue
disc fit 105.6 and 108.6 and pass. Same geometry, opposite verdicts, decided by 0.6px of a
quantity §24.4(b) already established is not trustworthy for short arcs.

The fix adds a second way in, and the sweep condition is the whole of its safety: a candidate
may also join when its polyline simply LIES within budget of the family circle, provided it
sweeps at least `FAMILY_JOIN_MIN_SPAN` (0.6 rad). §24.7(c) is the measured reason that
condition is not optional — admitting any span on the distance test alone bends arcs of
different circles onto one another. Two circles that cross can stay inside a 1.5px budget of
each other for a few degrees either side of the crossing; they cannot do it for forty.
Calibrated on this case: the arcs that must join sweep 52–56°, the fragments that must not
sweep 2–6°. Result: pink 0.77 → **0.09**, all three families 3 arcs and ~354°, and the white
speck stays (it is authored, and on this input it IS a traced region — see (a) for the
composited case where it is not).

It also reached a lane nothing else had. `petals` **passes** the scale gate at drift 1.56×
where the previous round left it failing at 2.01×: @256 improved 0.529 → 0.410 alongside
@1024's 0.263, so the ratio came down for the right reason instead of going up.

**(a) `bloom` came back ASYMMETRIC, and it should not have.** Its three discs are mirror-
symmetric about x=256 by construction, and the traced lens below the triple point had one
side bitten in. The cause was the junction rule of §24.4(c) taking `circles[0] × circles[1]`
in CLAIM ORDER. Three boundaries meet inside two pixels there — the lower two discs cross at
(256, 277.9), the upper disc's own bottom is at (256, 276.0) — and claim order is not
mirror-symmetric, so the two sides picked different crossings. Ranking every PAIR by how far
its crossing sits from the raw junction is order-independent and mirrors correctly. Measured
after: the three junctions land at (254.90, 275.93), (257.20, 275.93) and (256.05, 277.86)
against authored (254.9, 276.0), (257.1, 276.0), (256.0, 277.9) — every one inside 0.1px.

A second thing fell out of that, and it is worth writing down because it looked like a
regression: the tiny WHITE SPECK at bloom's centre disappears. It was never a traced region.
The before trace has six fills and not one of them is near-white, and the source raster has
no white pixel there either — the authored 2px² triangle is entirely AA fringe at 512. The
speck was a HAIRLINE CRACK between regions whose shared junctions had been placed
inconsistently, and consistent placement closes it. Region recovery stays 7/7 and boundary
agreement improves (chamfer 0.06, p95 0.11 @512).

**(b) `olympic-rings` still pulled, and a ring cut ONCE was the reason.** The census found 21
of its arcs unclaimed, and among them `e24`: r 66.5, sweep **266°**, the red ring's whole
inner boundary as a single edge. The "a family needs two members" rule refused it — and
nothing else would take it either, because the closed-disc snap (1a) never sees an open edge
and the line snap (1b) is not for arcs. So the longest, best-conditioned arc in the mark was
left as a freehand chain. The member count was only ever a PROXY for evidence and
`FAMILY_MIN_SPAN` is the real measure, so the proxy is gone: a single arc sweeping 266°
constrains its circle better than two 90° ones do. olympic-rings goes to 10 families.

**(c) The radius pre-filter looks like a bug and is load-bearing.** The same census showed
every one of those 21 arcs sitting 0.34–1.07px from its ring, comfortably inside the 1.5px
budget, and rejected anyway — by the cheap `|r_own − r_family|` guard, on fitted radii of 18
and 99 for arcs of a ring authored at 66.6. That is exactly the ill-conditioning §24.4(b)
exists to escape, so removing the guard looked obviously right. It was measured and
**REVERTED**: with only the distance test, arcs of genuinely different circles that graze
within budget over a short span join and are bent onto the wrong one. `bloom-flat`'s render
mean ΔE went 0.06 → **1.44** and `ring-cross`'s gradient lane blew past its own baseline
(middle inner 0.28 → 1.59, against 0.75 before §24). The crude radius comparison is what
keeps different rings apart, and the arcs it costs are worth less than the ones it saves.

**(d) `instagram` is deformed, and it is not this.** Measured at the branch point and after:
inner ring spread 1.87 → 1.75, dot 1.57 → 1.57, outer 0.87 → 0.91. Pre-existing and
essentially untouched. Its ring is small (r 25.6) and gradient-banded, so the flat trace cuts
it into many short arcs of different colours whose own fits scatter far more than
`FAMILY_CLUSTER_REL · r` = 1.5px allows them to group. A scale-relative clustering tolerance
is tightest exactly where the per-arc fits are worst; that is its own calibration and its own
row, not this one.

**(e) `ring-cross` still pulled in GRADIENT mode, and "within budget" was hiding it.** The
one place §24 had made something worse: the gold ring's inner circle read 0.70 against a 0.31
baseline. The per-member numbers name the cause outright — an arc that fitted its OWN circle
at **0.17px** was being dragged to **1.18px** on the family circle, a 7× degradation, and the
family was accepted because its overall deviation (1.18) still cleared the 1.5px budget.
Within budget is not the same as an improvement. The healthy pattern looks nothing like it:
on the same case's flat lane every member comes out better or comparable (own 1.04 → 0.73 on
the family), and the honest ratios top out near 1.7.

So a family may no longer make a member substantially worse than it already was: members over
`FAMILY_WORSEN_K` (2×) of their own fit — with a floor, so an unusually clean arc does not set
an impossible bar — are DROPPED, the circle is refitted without them, and what remains must
still clear the sweep and budget tests. Gold inner 0.70 → **0.49**, navy inner back to its
0.66 baseline, and the flat lane, the corpus and the golden records all unmoved.

Tightening the bar to 1.5 was measured and **rejected**: it buys the gradient lane a further
0.11px and takes `bloom` from 0.12 to **0.55**, because dropping a member re-fits the circle
without it and the remaining members then sit worse. The truth gate caught that within one
run, which is the argument for having built it in §24.3.

WHAT REMAINS, and why it is not a family problem. Gold's inner boundary in gradient mode is
ONE arc sweeping 270° whose own best-fit circle already wanders **0.77px** — the gradient
path's edge placement is the limit, not the grouping. The same lane's UNTOUCHED control ring
reads 0.23 against 0.04 flat, so it carries an order of magnitude more noise before any of
this runs. Against that floor the crossed ring is 0.75 → 0.30 and 0.55 → 0.16, navy 0.67 →
0.66, and gold 0.31 → 0.49: three better, one worse. Gradient art is scoring infrastructure
rather than the product target (§0's ranking rule), and the flat lane — which is the target —
is 0.78 → 0.07.

**What the review cost elsewhere.** Nothing, in the end. `petals` spent one round back in the
scale gate's `KNOWN_DEFECTS` at 2.01× — @1024 had gone resolution-free while @256 stayed on
the lattice, and a RATIO gate reads a fine-end-only improvement as drift — and (a0)'s
sweep-gated join reached the coarse lane too, closing it at **1.56×**. The one residue is
`ring-cross`'s gradient lane, where the gold ring's inner circle reads 0.70 against a 0.31
baseline (the crossed middle ring is 0.75 → 0.28 and 0.55 → 0.16 the other way, and the
untouched control ring reads 0.23 in gradient mode against 0.04 flat, so that lane carries
~0.23 of noise before anything else).

### 24.8 How far the witness got, and the trade that stops it going further

`olympic-rings` worst spread, measured against its authored circles directly (it is stroked,
so `svgGround` refuses it): **0.785 → 0.547**, over four steps — 0.682 with families, 0.668
with the single-arc rule, 0.547 with the sweep-gated join and the worsening guard.

It is no longer uniform. Blue, black and red now read **0.17–0.23**; the whole residue is on
**yellow (0.41 / 0.43) and green (0.40 / 0.55)** — the two rings that pass UNDER at every
crossing and are therefore cut into the most pieces. And a good part of what remains is not
wobble at all: every OUTER circle carries a **+0.26 to +0.40px uniform outward bias** with
~0.00 on the inners, which is §0 row #17 and invisible as a shape defect.

**The remaining arcs can be admitted, and it was measured three ways.** 20 candidates stay
unclaimed, all of them 0.34–1.07px from their ring — inside the 1.5px budget. They are held
out by the worsening guard of §24.7(e), whose baseline is a member's distance from its OWN
fitted circle. Three attempts to let them through:

1. **Skip the guard for short members** (their own fit being meaningless). olympic 0.547 →
   **0.412**. But `ring-cross`'s gradient gold ring went back to 0.70 — the member that guard
   exists to drop turned out to sweep only 38°, not the ~143° assumed.
2. **Skip the guard for members admitted on the geometric route** rather than on radius
   agreement. Identical outcome: olympic 0.412, gold 0.70, because that member joins
   geometrically too.
3. **Give `arcSlice` a minimum of two segments** so a sub-90° slice carries a node actually
   ON its circle instead of only its two pinned endpoints. olympic 0.547 → 0.420 — but gold
   unmoved, so this is not the mechanism, and it costs nodes for nothing. Reverted.

The two contested members are **indistinguishable in every local property**:

| | span | own circle | own dev | dev on family | joined via |
|---|---|---|---|---|---|
| `ring-cross` grad e18 (must be dropped) | 38° | r 26.5 vs family 63.9 | 0.17 | 1.18 | geometric |
| `olympic-rings` e37 (should be kept) | 49° | r 18.2 vs family 66.6 | 0.28 | 1.13 | geometric |

Nothing the tracer can see separates them. The difference is only in the ANSWER — whether the
family circle or the freehand arc is closer to a truth neither of them knows. And the
population cannot break the tie either: over the **27 gallery marks with authored circles the
two settings are byte-identical**, 0 of 27 differ. It is a two-witness trade.

**Settled by the user, 2026-09-04: take the olympic gain.** The rule shipped is the one that
states the principle rather than the outcome — the worsening guard's baseline is a member's
distance from its OWN fitted circle, so it is only asked where that fit was CREDIBLE enough
to be the reason the member joined. A member admitted on the geometric route has, by
construction, an own circle nothing like the family's (e37: r 18.2 on a ring of 66.6), and
"it sits 0.28px from THAT" is not evidence of anything. When a member's own circle is
nonsense, believe the family.

  olympic-rings  0.547 → **0.412**   yellow 0.43 → 0.38, green 0.55 → 0.36, black 0.20 → 0.17
  ring-cross gradients, gold inner   0.49 → 0.70 (the accepted cost)
  flat lane, corpus, golden, suite   unmoved

Recorded so the next person does not re-derive it: this is a TWO-WITNESS trade with no
discriminator, not a tuned threshold. Reversing it means dropping every member that fails
the ratio, credible or not.

### 24.9 What is left

**CLOSED by §25 (2026-09-04).** The 18 unclaimed arcs on `olympic-rings` and the
wrong-angled crossing corners were ONE defect, and the direction was the right one: decide
membership from the TOPOLOGY at the junction (which incident edges continue one another).
All 55 arcs now reach a family and the worst crossing corner is 0.60° off authored instead of
11.13°. The admission for an equal-strength crossing turned out to be a RANK (which pairing
is straightest) and not a threshold — §14's own `THROUGH_TURN_DEG` starts vetoing real
continuations at @1024. `docs/handoff-through-chains.md` remains as the record of the four
dead ends §24.8 measured; **§25** is the outcome.

### 24.10 Also open


- **`instagram`'s small gradient-banded ring** (spread 1.75, pre-existing) — §24.7(d). The
  round-0 grouping tolerance is `FAMILY_CLUSTER_REL · r`, which is tightest exactly where the
  per-arc fits are worst. An absolute floor alongside the relative one is the obvious idea and
  is NOT free: §24.7(c) is the measured warning about loosening this pass's grouping.
- **`olympic-rings` reads 0.547** against `ring-cross`'s 0.07 — see §24.8 for exactly what is
  left, the three measured attempts on it, and the trade that stops it going further.
  **SUPERSEDED by §25:** every arc is now in a family and the ring is one circle to 0.01px of
  roundness; what the spread number still carries there is CENTRE PLACEMENT, which is §0 #17
  and measurably not a fit problem (§25.3).
- **`letter-joins` 0.81 is NOT this mechanism**, despite reading like it. Its three bowls are
  each ONE CLOSED edge, so they never reach §1d — `ringDiag` counts 18 single-edge loops and
  not one candidate — and the family pass groups OPEN arcs, so it cannot reach them either.
  What declines is 1a's own disc snap: a bowl with a join in it turns sharply, the corner
  veto refuses to round it (rightly — it would eat the join), and the arc is then fitted
  freehand. **A circle interrupted by a CORNER rather than by a crossing is its own fix**,
  and it is the obvious next one: the same family idea applied to the sub-chains of a single
  closed edge, split at its corners.
- **`shaded-ink` 1.16** is issue #15 seen through this lens, not a circle problem: the colour
  path carves the art, so the boundary is in the wrong place before any snap runs.
- **The gate is @512 and flat-art only**, for §23's reason — every radius halves at 256, so
  the same relative error is half the pixels there and the limit would be its own
  calibration.
- **The junction-intersection rule only fires where two circles both claim a vertex.** A
  junction between a snapped circle and a fitted LINE (a spoke meeting a ring) still gets the
  radial snap; §17's arm-intersection placement is the mechanism for that case and was not
  extended here.

## 25. Through-chains — membership from the topology, not from the fit (2026-09-04)

**Status: SHIPPED (PR open for review).** The residue §24.9 handed on
(`docs/handoff-through-chains.md`) is closed on the witness. All **55** of `olympic-rings`'
candidate arcs now reach a co-circular family (§24 got 37; the 18 that did not were the whole
defect), and the crossing corners the handoff's §2 names as the second symptom land within
**0.60°** of authored where the worst was **11.13°**.

| `olympic-rings` @512 | §24 | §25 |
|---|---|---|
| candidate arcs in a family | 37 of 55 | **55 of 55** |
| circle **roundness** — p95 about the trace's own circle | 0.33 | **0.01** |
| crossing corner angle, mean / p90 / **max** error | 1.26° / 3.76° / **11.13°** | 0.22° / 0.50° / **0.60°** |
| circle **centre** offset, worst | 0.43 | 0.50 |
| `circleSpread` (the gate's number, the three folded together) | 0.45 | 0.53 |

The last two rows are the honest cost and §25.3 is about them. Gated corpus: **unmoved on all
13 circle-bearing cases**, byte-identical. Truth gate 75/75, suite 463/463, golden untouched
(every golden case is byte-identical with §25 on or off, so the three stale advisories in
`trace-regression` are not this change's to bless). A/B: **4 of 84 outputs moved** —
olympic-rings flat + grad, and `nebula.flat` / `petals.flat` by mean ΔE 0.018 / 0.002.

### 25.1 The measurement that had to come first

The handoff asked for one thing before any code: *if §14's contrast rank admitted its
equal-strength junctions, which pairing would tangent continuity choose, and is it right?*

§14 joins two arms across a junction and fits them as one window, but only where the CONTRAST
RANK finds a WEAK arm aiming a STRONG one — because for weak/strong the strong pair IS the
through-pair, for free. Five saturated rings on white have no weak edge anywhere, so the rank
has zero candidates and 0 of 46 junctions move. The open question is which pairing is right
when three or four EQUALLY STRONG arms meet.

`src/devtest/xingDiag.ts` answers it: at every junction, enumerate every pairing, score each
by §14's own chord turn, take the matching tangent continuity picks (straightest first, each
arm used once), and compare with GROUND TRUTH — which arms lie on the same authored circle.
`olympic-rings` is stroked so `svgGround` refuses it; its circles are read off the `<circle>`
elements as centre ± half the stroke width (`geomScore.strokedCircleGround`, which also makes
the mark issue #10 was filed on scorable in `ringDiag --circles` for the first time).

**Correct at every real crossing, at every resolution:**

| | @256 | @512 | @1024 | @2048 |
|---|---|---|---|---|
| chosen matching correct | 32/32 | 32/32 | 32/32 | 32/32 |
| margin over the straightest rejected pair | ≥45.0° | ≥45.0° | ≥36.9° | ≥43.2° |
| worst TRUE continuation turn | 19.4° | 16.5° | **20.2°** | **20.2°** |
| true continuations §14's `THROUGH_TURN_DEG`=20 would veto | 0 | 0 | **1** | **1** |

**That last row is the design.** §0 #14's scale-dependence lands squarely on the ABSOLUTE
reading — the threshold sits at 0.99× the worst true continuation once the raster is fine
enough, and starts vetoing real continuations. The RANK does not move: right at every scale,
never by less than 36.9°. So the admission for an equal-strength crossing is *which pairing
is straightest*, not *is this pairing straight enough*. The turn cap is kept as a coarse
sanity bound (`CHAIN_TURN_MAX` 30°, with TRUE CONTINUATION ≤ 20.2° and REAL CORNER ≥ 45.0°
across four resolutions and the whole gated flat corpus), but the margin is what decides.

Corpus-wide the chosen matching is correct on **46/46** junctions of circle-bearing art.

**THREE SCORING TRAPS, each of which first produced a false negative.** They are the reason
this section exists rather than a one-line "tangent continuity works":

1. **Ground truth is a MATCHING, not a pair.** At a degree-4 crossing of two circles BOTH
   pairings are true continuations at once — `bloom`'s triple point is exactly this. Scored
   one-pair-against-one-pair, `bloom` read 7/8 and `overlap` 2/4; scored as matchings, both
   are 100%.
2. **A canvas-clip junction is not a crossing.** `olympic-rings` is authored tangent to its
   own canvas on all four sides, so 14 of its 46 junctions are places where a ring runs off
   the raster and its boundary continues ALONG the straight image edge. "On the circle" and
   "on the border" then agree to a fraction of a pixel and read a turn of **0.0° exactly**.
   Every rule of this shape gets all 14 wrong, and not one of them is a ring defect.
3. **A short arm's chord direction is staircase noise** — §14's `MIN_ARM` already says so.
   Without it, `overlap`'s two 3px lens tips look like counter-evidence and are not.

### 25.2 What chaining actually buys: a radius worth trusting

§24.8's blocker, restated: a short arc's own circle fit is noise (r 18.2 and r 99 on a ring
authored at 66.6), the worsening guard's baseline IS that fit, and every attempt to decide
membership from it fails on one witness or the other — four of them measured and rejected in
§24.8 / handoff §3. The way out is not a better threshold on that quantity. It is to stop
asking it:

    |fitted r − authored r| — the CHAIN: max 1.38px over 16 chains
                    its member EDGES alone: max 75.65px over 43 edges     (@512)
                                            max 178.67px                 (@2048)

The pass therefore joins arcs FIRST and clusters SECOND. `throughChains` in
`planarBeautify.ts` runs over the §24 candidate list, surveys every incident open edge at each
junction (not only the candidates — the arm that decides a pairing is usually the covered
ring's boundary, which the family pass will never touch), links only pairs of candidates, and
walks the links into chains. A chain must still BE an arc: its own fit within budget, or it
falls back to its members unchained, never dropped. Everything downstream is unchanged —
what changes is that `cands[k].c` is now a ring's fit rather than a fragment's.

`ring-cross` shows the mechanism at its cleanest: the middle ring's inner and outer circles,
which §24.2 established can never share a face, come back as complete **360° chains of four
edges**, fitted r **80.00** and **64.03** against authored 80.0 and 64.0.

`chainArcs: false` restores the §24 tracer byte-identically — §24.1's lesson, that a census
naming the first failing gate cannot tell you the gate is load-bearing, kept as a flag.

### 25.3 The lens folded three defects into one, and the third now dominates

**`circleSpread` went UP on the witness, 0.45 → 0.53, and reading that as a regression is the
trap this section exists to prevent.**

§24.3 already pulled one term out of the raw residual: `bias`, a circle uniformly the wrong
SIZE, "a different defect — and rolling the two together would have let a fix for either claim
the other's ground". There is a third. A traced circle of the right size and shape in the
wrong PLACE produces a residual d·cos(θ−φ) about the authored one, so it reads as spread ≈ d
however perfectly round the trace is. That term was invisible while the rings were still
wobbling, and it dominates the moment a ring is genuinely recovered as ONE circle.

`circleRecovery` now reports both halves alongside `spread` (**neither is gated — the limit
stays `spread`**): `centre`, the traced circle's centre offset, and `roundness`, the p95
residual about the trace's OWN best-fit circle — "did the arc stay on one circle" with both
placement terms removed. On `olympic-rings` every one of the ten circles goes to **roundness
0.01px**: the trace IS ten circles, to a hundredth of a pixel, where §24 left up to 0.33.

**And the centre error is not the fit's fault.** Fitting each ring's evidence with the
ALGEBRAIC (Kåsa) estimator the tracer uses and with a GEOMETRIC one that minimises the true
orthogonal residual gives centre errors **identical to two decimals on all ten circles**
(`xingDiag`, "PER AUTHORED CIRCLE"). A partial-arc fit bias would have shown there. The
evidence itself is displaced, and the split is the same one §24.8 found: blue/black/red read
0.08–0.23 while yellow and green — the rings cut into the most pieces — read 0.34–0.43. That
is the §0 **#17** family (`Δr` on the same table is +0.33 to +0.42 on every OUTER circle and
−0.05 to −0.19 on the inners, exactly #17's signature, measured on the RAW network before any
snap runs). The handoff named it out of scope in advance and it stays out of scope.

The honest cost line: yellow's two circles move 0.38 → 0.50 and 0.43 → 0.46 of centre error,
because more of the ring is now on one circle and therefore shows more of that displacement.
Eight of ten are unchanged or better. It buys roundness 0.33 → 0.01 and the corner angle
11.13° → 0.60°.

### 25.4 Exposure, and what did NOT move

The pairing being right on rings says nothing about art with no rings in it, so the blast
radius was counted before the change was believed (`xingDiag --corpus`). At `margin ≥ 30°`
over the gated flat corpus, `checker` chains **1667 of 1681** junctions — correct (a
checkerboard vertex genuinely has two straight-through pairs) but by far the largest exposure
in the corpus, and the downstream guards are what absorb it: a straight chain fits no circle
worth having, so the per-edge corner veto, the own-fit-in-budget test and `FAMILY_MIN_SPAN`
refuse it exactly as they refuse the unchained version. `hairlines`, `letter-joins`,
`gear-teeth`, `bar-caps`, `smooth-radii`, `overlap`, `concentric`, `annulus`, `sharp-star`,
`corner-turns`, `acute-counter` and `nebula` chain **zero**.

Measured after: the gated corpus's circle recovery is byte-identical on all 13 cases, and the
A/B stamps differ on 4 of 84 outputs — the witness, and two cases by mean ΔE ≤ 0.018.

### 25.5 What is left

- **`olympic-rings` centre placement (0.50px worst)** is now the whole residue on that mark,
  and it is §0 **#17**, measured here on the raw network: the evidence is displaced before any
  snap, and no estimator recovers it. The new `centre` / `roundness` columns are the lens for
  it when someone takes #17 on.
- **The gate still reads `spread`,** which folds size, placement and wobble together. That is
  deliberate — it is an absolute "this is wrong" bound and it caught §24's regressions in one
  run — but anyone judging a ring change should read `roundness` next to it.
- **Chaining is gated to degree ≥3 junctions,** matching the census. A degree-2 vertex is an
  unambiguous continuation and joining those is free evidence that was NOT measured here.
- **The junction-intersection rule (§24.4c) is unchanged.** With both arms of a crossing now
  snapped it fires on strictly more junctions, which is why the corner angles closed; a
  junction between a snapped circle and a fitted LINE still gets the radial snap (§24.10).
- **Instruments:** `xingDiag` (the pairing census, `--corpus`, `--scales`, `--all`),
  `xingAngle` (crossing corner angles against the authored crossing, `--nochain`),
  `ringDiag --circles` (now scores stroked circles, so `olympic-rings` carries a number).
