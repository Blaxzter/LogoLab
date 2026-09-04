# Handoff — the 18 arcs, and through-chains at equal-strength junctions

**Branch:** `fix/ring-crossing-arcs` (PR #31, open). Read `docs/vectorization-benchmarks.md`
**§24** first — all of it. This file is the follow-on that §24.8/§24.9 stop short of.

---

## 1. The state you are inheriting

§24 fixed the ring wobble of issue #10 by grouping an authored circle's traced arcs into a
**family** and snapping the family to one refitted circle. Numbers, @512:

| | before §24 | now |
|---|---|---|
| `ring-cross` (the gated fixture) circle recovery | 0.78 | **0.07** |
| `logo-olympic-rings` worst spread | 0.785 | **0.412** |
| `bloom` / `overlap` | 0.84 / 0.38 | 0.12 / 0.03 |

The gate is `circleSpread` in `evaluateTruthGates` (limit 0.25), the lens is
`geomScore.circleRecovery`, and the instruments are `ringDiag --circles` and
`ringDiag --families`. Suite is 463/463 green.

## 2. The defect that is left

**On `olympic-rings`, 55 arcs are candidates, 37 are in a family, and 18 are not.** Those 18
are the whole residue, and they show up two ways — which is why it is one job, not two:

- **the ring does not quite line up across a crossing.** Yellow reads 0.41 / 0.38 and green
  0.40 / 0.36, against 0.17–0.23 for blue, black and red;
- **the corner AT a crossing has the wrong angle.** Where both arms are snapped, the traced
  crossing angle is exact — black-inner × green-inner is authored **119.7°** and traces at
  **119.8–120.1°**. Where one arm is one of the 18, its tangent comes from a raw fit and the
  same measurement reads **108.9°** against an authored **102.3°**.

Note what is NOT the defect. The snapped curve is a true circle: every `smooth` node the snap
emits has a tangent break of **0.00°**, and `arcSlice` builds every handle from the circle's
tangent. And a corner at a crossing is CORRECT — the lower band's region genuinely ends
there and its outline turns to follow the upper band's edge. Do not try to remove it.

Also not this: every OUTER circle carries a uniform **+0.26 to +0.40px outward bias** with
~0.00 on the inners. That is §0 row **#17**, a circle in the wrong place rather than a wobbly
one, and it is untouched by any of this.

## 3. Why it is blocked, and what NOT to repeat

All 18 sit **0.34–1.07px from their ring** — inside the 1.5px fidelity budget. Admitting them
is geometrically reasonable. The blocker is that it cannot be decided locally.

The two contested members, side by side:

| | span | own circle | own dev | dev on family | joined via |
|---|---|---|---|---|---|
| `ring-cross` gradients, e18 — admitting it HURTS | 38° | r 26.5 vs family 63.9 | 0.17 | 1.18 | geometric |
| `olympic-rings` e37 — admitting it HELPS | 49° | r 18.2 vs family 66.6 | 0.28 | 1.13 | geometric |

Indistinguishable in every property the tracer can see. And the population does not break the
tie: over the **27 gallery marks with authored circles, the two settings are byte-identical —
0 of 27 differ.** It is a two-witness trade, currently settled toward admitting (the user's
call, 2026-09-04): olympic 0.412, ring-cross's gradient gold ring 0.70 as the accepted cost.

**Measured and rejected — do not re-derive these:**

1. **Drop the radius pre-filter in the grow rounds** (it rejects arcs that are within budget,
   on a radius that is meaningless for a short arc — it looks like an obvious bug). Bends arcs
   of DIFFERENT circles onto one another: `bloom-flat` render mean ΔE **0.06 → 1.44**,
   ring-cross gradients middle inner 0.28 → 1.59, past its own pre-§24 baseline.
2. **Skip the worsening guard for short members**, or **for members admitted geometrically** —
   identical outcomes, and both are the setting currently shipped.
3. **`arcSlice` with a minimum of two segments**, so a sub-90° slice carries a node actually
   ON its circle rather than only its two pinned endpoints. olympic 0.547 → 0.420 but the
   gradient case unmoved — not the mechanism, and it costs nodes. Reverted.
4. **Tightening `FAMILY_WORSEN_K` to 1.5.** Buys the gradient lane 0.11px and takes `bloom`
   from 0.12 to **0.55** — dropping a member refits the circle without it and the rest then
   sit worse. The truth gate caught it in one run.

The lesson under all four: **a short arc's own circle fit is noise** (r 18 and r 99 on a ring
authored at 66.6), and every attempt to decide membership from it, in either direction, fails
on one witness or the other.

## 4. The direction worth trying

Stop deciding membership from the arc's own geometry. Decide it from the **topology at the
junction**: at a crossing, which incident edges are CONTINUATIONS of one another. Chain those
into one through-going stroke, and fit the circle to the chain. A ring then arrives as one
object instead of a cluster to be guessed at, and both symptoms in §2 close together — the
arcs are placed by construction, and both arms of a crossing are snapped so its angle is
exact.

**The machinery already exists.** `src/lib/trace/planarThread.ts` (§14) joins two arms across
a junction into one window and fits them as one line or one circle, then moves the junction
onto that curve. Read its header — it is the same idea, already built, already shipping.

**Why it does not already do this.** It is gated on the §14 CONTRAST RANK: a junction is a
candidate only if it has at least one **weak** arm (ΔE ≤ 12), because §14's problem was a
posterization seam aiming a strong edge. `olympic-rings` is five saturated rings on white —
every edge is **ΔE ≥ 60** — so the rank has **zero candidates and 0 of 46 junctions move**
(`threadDiag --case olympic-rings`). The mechanism is structurally inert here, not mistuned.

So the work is: **find a principled admission for EQUAL-STRENGTH crossings.** The open
question §14 never had to answer is which pairing is right when four strong arms meet — for
weak/strong the answer was free, because the strong pair IS the through-pair. Tangent
continuity is the obvious signal and it is exactly what §14's chord-turn gate already
computes; `THROUGH_SPAN`'s scale-dependence (§0 #14 — the same junction reads 21.4° @256 and
7.1° @2048) is the known trap on that road.

Do not start by writing code. Start with `threadDiag` and answer, on `olympic-rings`: if the
rank admitted these junctions, which pairing would tangent continuity choose, and is it the
right one? That is a measurement, and it decides whether this direction is real.

## 5. Protocol — non-negotiable, see CLAUDE.md

- **Freeze an A/B baseline first:** `pnpm gen:absnapshot before-<what>`, then review in
  `/labs/ab`. Judge BOTH lanes — ⟐ fixtures and ◆ gallery.
- **A red gate before a fix.** The lens for this defect exists (`circleSpread`), so a new
  fixture may not be needed — but check `ringDiag --circles --corpus` before and after.
- `node --test test/truth-gate.test.ts` is the correctness gate; `pnpm test` is the full suite
  (465 tests). Re-bless the golden ONLY for cases your change actually moves — verify
  case-by-case against the branch point; the file carries pre-existing drift that is not
  yours to bless.
- **Regenerating an A/B stamp is not evidence anything changed.** `cmp` the SVGs. And when
  comparing a stamp against a locally traced doc, match the rasterization first: the ⟐ fixture
  lane keeps a TRANSPARENT background while the truth gate and `circleRecovery` composite on
  white. Those are two different traces of the same case, and confusing them cost a full round
  of review here (§24.7(a0)).
- Tracer changes stay an OPEN PR until the user has reviewed the A/B snapshots.

## 6. Files

| | |
|---|---|
| the pass | `src/lib/trace/planarBeautify.ts` — the co-circular FAMILY pass, `FAMILY_*` constants |
| the through-fit | `src/lib/trace/planarThread.ts` — §14, the machinery to generalize |
| the lens | `src/devtest/geomScore.ts` — `circleRecovery`, `authoredCircles` |
| the gate | `src/devtest/truthCorpus.ts` — `CIRCLE_SPREAD_MAX`, `CIRCLE_SPREAD_ALLOWED` |
| instruments | `ringDiag --circles` / `--families` / `--corpus` / `--logos`; `threadDiag` |
| the record | `docs/vectorization-benchmarks.md` §24 (and §14, §17 for the through-fit) |
