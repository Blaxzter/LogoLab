# Handoff — the ramp painted over two flat objects

**Status: FIXED 2026-09-05 — see `docs/vectorization-benchmarks.md` §26.** This file is kept as
the record of the diagnosis that framed the work; the answers to its open questions are in
§26, and two of its premises were corrected there:

- **§5's question is answered: the pair REACHES `evalPair` and the veto's own measurement
  reads 0.** The unwitnessed-jump veto binned t into 24 and only measured contrast across
  EMPTY bins; olympic's accepted blue∪green union was a radial fit whose two flats met at
  t 0.479→0.521 — inside one bin — so no bin was empty and the jump read 0.000 (the same
  pair's two earlier evaluations, with one green arc, read 0.262 and were vetoed). The
  greedy search over pairs × fit types × radial centres finds such a parametrization
  whenever one exists. The fix is the MEASUREMENT (sample resolution, side-extrapolated), not
  a threshold and not a new gate.
- **§2/§6's ground truth was checked and the labels partly corrected.** `flute-flat` authors
  NO gradient (it is the Fluent FLAT twin) — every one of its traced gradients is a fusion of
  near-colour flats, not "genuinely smooth ones alongside a step". The mixed-art witness with
  real ramps is `logo-mercedes-benz` (15 authored gradients), and §26.2's census is labelled
  by the SOURCE's authored paint, not by eye.
- **§6's transition-span lead was not needed** — the discriminator turned out to live where
  §10.3 already put it, once measured at the right resolution.

---

*Original handoff below, unchanged.*

**Status: OPEN, not started.** Everything below is measured; no code has been written for it.
Read `docs/vectorization-benchmarks.md` **§10.3** first (the unwitnessed-jump veto — the
mechanism that already exists for this and does not reach it), then **§0 #9** (gradient
banding, the neighbouring row).

---

## 1. The defect

**Traced with gradients ON, the tracer fuses spatially separate flat objects into one region
and paints them with a linear/radial gradient that is a STEP — constant colour, a brief
transition, constant colour.** It is not a gradient. It is two solid colours wearing one.

`logo-olympic-rings` @512, gradient lane, straight from the emitted defs:

```
grad-trace-1:  #0078d0 @0, #0078d0 @0.354, #00a651 @0.646, #00a651 @1     (blue ring ∪ green ring)
grad-trace-2:  #000000 @0, #000000 @0.479, #f0282d @0.521, #f0282d @1     (black ring ∪ red ring)
```

Five rings come back as **two solids + two gradients** where the flat lane emits six solids.
The fused pairs do not touch: blue's centre is **182.5** authored units from green's against a
combined outer radius of **108**; black to red is **117** against 108. Two disjoint objects,
one region, one ramp.

It is not an olympic-rings quirk. Over the 42 A/B stamp cases, **17 of 45 traced gradients**
carry this signature:

| case | what got fused |
|---|---|
| `logo-mastercard` | **all five** of its gradients are step-ramps (red circle ∪ black wordmark, etc.) |
| `letter-joins` | `#f6f6f9` → `#e2ac2d` → `#f6f6f9` — the **BACKGROUND and a letter**, one region |
| `corner-turns` | `#1a1a22` → `#ce2c34` → `#1a1a22` → `#ce2c34` — several disjoint shapes of two colours, one oscillating ramp |
| `flute-flat`, `logo-mercedes-benz` | one step-ramp **alongside genuinely smooth ones** — the mixed case |
| `peak-drop`, `acute-counter`, `logo-chrome`, `seam-corner` | one each |

## 2. Who actually hits it, and why that shapes the job

`suggestGradients` (the rampiness probe) returns **flat** for `olympic-rings`, `ring-cross`,
`instagram`, `mastercard` and `chrome`, so a user dropping a flat mark into the app gets the
good trace and never sees this. The gradient lane is `/labs/ab` showing both, or a manual
override.

**So the product case is MIXED art** — an icon with real gradients *and* flat regions, where
gradients are correctly ON and the flats get fused anyway. `logo-mercedes-benz` and
`flute-flat` are the corpus witnesses that already have both in one image, and
`gradient-flat` ("gradient bg + crisp flats — the render gate must not absorb them") is the
fixture authored for exactly this shape, currently clean. Fix the mixed case; olympic-rings
is the clearest *diagnostic*, not the target.

## 3. Why no gate sees it

The near-step ramp puts its transition roughly where the real boundary is, so the RENDER is
almost right. Mean ΔE, trace vs source @512:

| | flat | gradient | |
|---|---|---|---|
| `olympic-rings` | 0.552 | 1.047 | |
| `logo-mastercard` | 0.460 | 1.133 | |
| `corner-turns` | 0.424 | 1.322 | |
| `letter-joins` | 0.122 | **2.740** | p95 0.00 → **18.72**, p99 → 71.89 |

The §10.3 **paint gate** is `PAINT_MEAN_MAX` 3.0 / `PAINT_P95_MAX` 8.0 on GRADIENT tier-0
cases. Three of those four sit under it. **`letter-joins` does not — p95 18.72 is 2.3× over
the limit.** It is a tier-0 case that the truth gate runs with `gradients: false`, so the gate
that would go red on it is simply never pointed at it.

**That is your red gate, and it costs a corpus row rather than a new mechanism.** Confirm it
before building anything.

## 4. Measured and rejected — do not re-derive these

**1. Tuning `maxUnwitnessedJump` (the §10.3 unwitnessed-jump veto).** This is the shipped
mechanism aimed at precisely this defect: a union is rejected when its fitted gradient jumps
across a SAMPLE-FREE stretch of its parameter, *and* one side is a near-flat colour block. It
is ON by default (0.12) on the auto path. The counterfactual at **0** — maximally strict, the
one-flag test §24.1 exists to teach:

| case | shipped (0.12) | veto at 0 |
|---|---|---|
| `olympic-rings` | 2 step-ramps | **2 step-ramps — UNCHANGED** |
| `letter-joins` | 1 step-ramp | **1 step-ramp — UNCHANGED** |
| `logo-mastercard` | 5 step-ramps | 4 step-ramps |
| `corner-turns` | 1 step-ramp | 0 — fixed |
| `nebula` | 1 gradient (real) | **0 — its real background gradient DESTROYED, posterized into 4 solids** |

So the veto is already load-bearing (it fixes `corner-turns`), **cannot be tightened**
(`nebula` dies at 0 — the regression §10.3 records), and **does not reach the two clearest
witnesses at any value**. Whatever fuses olympic's blue∪green and letter-joins'
background∪letter, it is not this gate. Finding out what it *is* is job one (§5).

**2. The reverted `profileCliff` merge-veto** (§10.3 names it). It measured the colour cliff
at the pair's own seam and the sign came out **inverted** between real and fake — nebula's
genuine background reunite needs cliff 0.50 while the fake white-in-red reads 0.273. Any
signal read off the pair's INPUT statistics is walking back into this.

**3. Counting reversals in the emitted ramp** (measured here, 2026-09-05). The idea is that a
real gradient walks one way through Lab while fused flats oscillate — `corner-turns` really
does go A→B→A→B. **It does not separate:** `logo-mercedes-benz`'s genuinely smooth
`grad-trace-3` reversal-counts **3** and `shaded-ink`'s real ramps count 2, while
`olympic-rings`' and `logo-mastercard`'s fakes count **0**. Real gradients on complex art
wander in Lab. Dead end.

## 5. The first measurement, before any code

**Find out where the fusion is actually decided.** §4's counterfactual proves it is not the
unwitnessed-jump veto, and that is the whole reason this handoff exists rather than a
one-line threshold change. The acceptance condition is `evalPair` in
`src/lib/trace/segment.ts` (~line 592):

```
fit.oklabResidual <= opts.mergeTol
&& profileGap(...) <= opts.maxProfileGap
&& (unwitnessedJump(...) <= opts.maxUnwitnessedJump || min(solidResidual(gi), solidResidual(gj)) > FLAT_FLANK_RES)
```

For the olympic blue∪green pair, print all four terms. Two solid ring colours should give
`solidResidual ≈ 0`, so the flat-flank escape should be shut and the veto should apply —
which means either `unwitnessedJump` measures ~0 (the union's samples fill every bin of the
fitted axis, so the jump is "witnessed" when it should not be), or the pair never reaches
`evalPair` at all. **Those two answers lead to completely different fixes.** §24.1 is the
precedent and the warning: an instrument that names the first failing gate cannot tell you
which gate is load-bearing — run the counterfactual.

Then, and only then, the second question: what separates a real gradient from a fused pair?

## 6. The one lead that survives, and its weakness

Score each emitted ramp by the fraction of its span over which the colour actually changes
(consecutive stops with ΔE > 1). A step spends almost none of it; a real ramp spends all of
it. Over the 45 stamp gradients:

- **suspected fake, 0.042–0.167:** olympic ×1, mastercard ×5, mercedes ×2, flute-flat ×1,
  peak-drop, acute-counter, seam-corner, letter-joins, chrome, corner-turns
- **unambiguously real, 1.000:** `nebula`, `bg-ramp`, `bg-ramp-twin`, `gradient-flat`,
  `aurora`, `logo-firefox` ×6, `logo-affinity-designer`, `logo-mercedes-benz` ×4

It is more promising than `profileCliff` for one specific reason: it reads the **fitted
output**, not the pair's input statistics, and `nebula` — the exact case that killed
`profileCliff` — sits at the **maximum**.

**It is a lead, not a finding, and it is not clean.** olympic's blue→green reads **0.292**
against mercedes' real `grad-trace-7` at **0.354** and flute-flat's at **0.438**. Worse, the
"fake" labels above are an eyeball judgement — **nobody has checked which corpus cases
actually author gradients.** Establish that ground truth and score any candidate signal as a
CLASSIFIER against it before believing a threshold. A metric calibrated on intuition is how
`profileCliff` happened.

The untested idea with the most in it: the discriminator is probably **spatial, not in the
stops**. A fused pair and nebula's occluder-split background are both disconnected — that is
why connectivity alone cannot work — but the ramp *continues* across nebula's gap and *steps*
across olympic's. Measuring at the gap, on input pixels, is a different question from
`profileCliff`'s seam-contrast. `nebula` is the case any such rule must survive.

## 7. Protocol — non-negotiable, see CLAUDE.md

- **Freeze an A/B baseline first:** `pnpm gen:absnapshot before-<what>`, then review in
  `/labs/ab`. Judge BOTH lanes — ⟐ fixtures and ◆ gallery. This change lands on the GRADIENT
  lane, which is the half of each A/B card that ring work never moved; look at it.
- **A red gate before a fix** — see §3, `letter-joins` in the gradient lane at p95 18.72
  against a limit of 8.0.
- `node --test test/truth-gate.test.ts` is the correctness gate; `pnpm test` is the full
  suite (465, 2 skipped). Re-bless the golden ONLY for cases your change actually moves —
  verify case-by-case with the tracer flag on and off; the file carries pre-existing drift
  that is not yours to bless.
- **Regenerating an A/B stamp is not evidence anything changed.** `cmp` the SVGs. And the ⟐
  fixture lane rasterizes on a TRANSPARENT background while the truth gate and the paint gate
  composite on white — two different traces of the same case (§24.7(a0) cost a full round of
  review on exactly this).
- Tracer changes stay an **OPEN PR** until the user has reviewed the A/B snapshots.

## 8. Files

| | |
|---|---|
| the merge | `src/lib/trace/segment.ts` — Step-3c field merge, `evalPair`, `unwitnessedJump`, `solidResidual`, `FLAT_FLANK_RES`, `DEFAULT_SEGMENT_OPTIONS.maxUnwitnessedJump` |
| the scope switch | `src/lib/trace/index.ts` `segmentOptionsFor` — the veto is AUTO-path only; Region detail > 0 or keep-separate markers disable it |
| the auto-default | `src/lib/trace/rampiness.ts` — `suggestGradients`, why flat art never reaches this in the app |
| the paint gate | `src/devtest/truthCorpus.ts` — `PAINT_MEAN_MAX` 3.0 / `PAINT_P95_MAX` 8.0, gradient tier-0 only |
| the record | `docs/vectorization-benchmarks.md` §10.3 (the veto and the reverted `profileCliff`), §0 #9 |
