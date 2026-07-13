# Handoff — build the tiered ground-truth corpus (tier 1 first)

> ## ✅ TIER 1 IS DONE — results in `docs/vectorization-benchmarks.md` §8
> 109 Fluent Emoji "Color" glyphs vendored (of 1,595 triaged), gated, viewable, reported.
> Headline: **the tracer invents 10.8× more boundary on gradient art than on flat art** while
> missing only 1.4× more — it finds the art, then hallucinates edges inside the gradient.
> `svgGround` had to learn to refuse **filters, clips, masks and pattern fills** (§8.1), which
> also caught a live bug in tier 0 (`checker` was never scorable — §8.2), and the lab and the
> CLI turned out to be tracing **different pixels** (§8.7).
>
> **Tiers 2–3 are still open**, and the go/no-go this handoff asked for is answered: `svgGround`
> *can* parse this art faithfully, provided it refuses what it cannot represent. Delete this file
> whenever you like — it is kept only so the brief and the outcome sit side by side.

**Status:** ~~not started~~ **done.** **Prereq work: DONE.** Tier 0 (`TRUTH_CORPUS`, 16 handcrafted cases)
is built, gated, and visible at `/labs/truth` (see `docs/labs.md`). The scoring machinery —
`svgGround.ts`, `geomScore.ts`, `truthCorpus.ts`, `groundTruthRun.ts` — exists and is shared
by the Node CLI and the browser lab. **You are adding cases to a working gate, not building
one.**

---

## The ask

`docs/vectorization-benchmarks.md` §5 proposes a five-tier corpus. Only tier 0 exists. Build
**tier 1**, and leave tiers 2–3 easy to add:

| Tier | Source | Licence | Why |
|---|---|---|---|
| 0 | our handcrafted cases | ours | **built** — each isolates a named failure mode of *this* tracer |
| **1** | **Fluent Emoji "Color"**, ~100–200 sampled | **MIT** | **the only authored-gradient ground truth that exists.** Its **Flat** variant of the same glyph is a free flat↔gradient A/B pair |
| 2 | Twemoji (jdecked fork), ~200–300 | CC-BY 4.0 | region topology, holes, authored fill ΔE. Needs an ATTRIBUTION file |
| 3 | Material Design Icons, ~200 | Apache 2.0 | boundary / corner / node-economy on silhouettes |
| 4 | the real PNGs (nebula, petals, schild, headphones) | ours | catastrophe canaries only — partially covered by `/labs/golden` |

Do tier 1 end to end (vendor → score → gate → view) before touching 2 and 3. If tier 1 shows
`svgGround` can't parse this art faithfully, tiers 2–3 are wasted work until it can.

---

## Read first (don't rediscover this)

- **`docs/vectorization-benchmarks.md`** — the whole research basis. §2: nobody in the field
  scores geometry (LIVE, Im2Vec, SGLIVE, StarVector/SVG-Bench are all raster-only). §5: the
  tier table. §6: the implementation traps. **§6 is the important one — read it twice.**
- **`docs/labs.md`** — how `/labs/truth` renders whatever is in `TRUTH_CORPUS`, and the rules
  that keep it trustworthy.
- **`src/devtest/svgGround.ts`** — the ground-truth SVG parser. It deliberately REFUSES what it
  cannot represent exactly (`unscorable()`), which is why `aurora` reports "not scorable"
  rather than silently scoring the wrong thing. **Keep that property.**

---

## Non-negotiables

1. **One corpus definition, two consumers.** `TRUTH_CORPUS` in `src/devtest/truthCorpus.ts` is
   imported by BOTH `groundTruthRun.ts` (the CLI) and `TruthLab.tsx` (the browser). A corpus
   that gets re-declared anywhere will drift. Whatever you add must land there.
2. **Refuse, don't guess.** `unscorable()` exists because a case scored against ground truth
   the parser mangled is worse than an unscored case. Fluent Emoji Color SVGs carry
   `<filter>` elements, inner shadows and per-shape opacity — if `svgGround` cannot represent
   one exactly, it must say so, not approximate it. Expect to *widen* the refusal set, not
   narrow it.
3. **Stroked SVGs cannot be ground truth.** A stroked element's visible boundary is the outline
   of the stroke, not its centerline. This is already why `aurora`, and originally the edge
   cases, were unscorable. **Filter stroked glyphs out at vendor time** — do not offset-curve
   them.
4. **`applicable: false` renders as n/a, never as a pass.** Region recovery is meaningless on
   gradient art (8-bit banding reads as dozens of "flat regions"). Tier 1 is gradient art, so
   most of it will legitimately have region recovery disabled — do NOT let that show up as a
   passing gate. See `evaluateTruthGates` and `GateTable`'s `na` tone.
5. **Match regions by LOCATION, not colour** (`geomScore.ts`) — already done; don't "optimize"
   it. `bloom`'s dropped lens sits ΔE 4.7 from an unrelated region on the other side of the image.
6. **Vendored art lives under `public/`.** Anything outside `public/` is served in dev and
   **404s in a production build** — this bit the golden lab and was only fixed last session by
   importing its fixtures. `TRUTH_CORPUS` paths are already `public/…` for exactly this reason.

---

## The work, in order

1. **Vendor.** A script (`src/devtest/vendorFluentEmoji.ts`?) that pulls the Fluent Emoji repo
   at a **pinned commit**, takes the **Color** SVGs, and writes a **deterministic sample**
   (stable hash of the glyph name, not `Math.random`) into `public/corpus/fluent/`. Also pull
   the matching **Flat** variant of each sampled glyph — that pairing is half the value. Emit
   a `NOTICE` (MIT) alongside. **Don't vendor 1,500 files;** ~100–200 is the ask, and every
   file is repo weight forever.
2. **Triage.** Run each candidate through `parseGroundTruth` + `unscorable()` and **write the
   verdict to disk** (a JSON manifest). Glyphs the parser refuses never enter the corpus. Report
   the refusal histogram — "42 rejected: 30 stroked, 12 filtered" is a finding worth keeping,
   and it tells you what `svgGround` should learn next.
3. **Gate.** Extend `TRUTH_CORPUS` (or add a sibling `GRADIENT_CORPUS` that shares the gate
   arithmetic — your call, but justify it). Set `gradients: true` per case. **Runtime is the
   design constraint:** the CI gate must stay fast, so gate a small fixed subset and let the
   lab browse the rest.
4. **View.** `/labs/truth` renders whatever the corpus contains, so tier 1 appears for free —
   **but 16 cases already take ~1–2 minutes to trace in the browser.** 150 will not work as a
   flat list. You need pagination, a tier filter, or row-level lazy tracing (trace when the row
   scrolls into view). Decide this before you add 150 rows and discover the page is unusable.
5. **Report.** The flat↔gradient A/B pair is the experiment nobody has been able to run: score
   the SAME glyph flat and gradient, and show the delta. That is what tier 1 is FOR.

---

## Traps already paid for (from §6, and last session)

- **Rasterizer: `@resvg/resvg-js`, not sharp** — it handles `<filter>` far more faithfully, and
  Fluent Color leans on filters. **It is currently declared in `package.json` but NOT installed
  locally** — `groundTruthRun.ts` won't run and `tsc` reports one error because of it. Install
  it with **pnpm** (this is a pnpm workspace) before you start, or you cannot verify anything
  against the CLI.
- **The browser rasterizes with canvas, the CLI with resvg.** Numbers differ in the last
  decimal. That is stated in the lab's UI; keep it stated.
- **Counts are not comparable; boundaries are.** Authored primitive count ≠ recovered region
  count (bloom: 3 circles → 7 composited regions, correctly). Score boundary distance
  (composition-invariant) and nodes-per-unit-boundary — never "paths vs paths".
- **`model.parseSvg` is unusable for ground truth** (needs `DOMParser`, and routes
  gradient-filled shapes into `RawItem`s the rasterizer skips — lossy in exactly the dimension
  we score). That is why `svgGround.ts` exists. Don't "simplify" by reusing it.

---

## Verification

- `pnpm typecheck` && `pnpm test` (**241 pass / 0 fail / 2 skipped** is the current baseline —
  do not let it regress).
- `node --experimental-strip-types src/devtest/groundTruthRun.ts` must agree with `/labs/truth`
  to within anti-aliasing noise. If they disagree, the shared-module contract broke.
- Current tier-0 state, as your regression check: **`bloom` 3/7 and `petals` 5/7 regions**
  (known tracer defects — `docs/vectorization-benchmarks.md` §7 — **not** view bugs);
  `aurora` reports **not scorable** (stroked); `bg-ramp` and `radial-glow` report **n/a** on
  every boundary gate (no interior boundary). Note: an older doc claimed bloom was 5/7. It is
  **3/7** — verified against both the old and new views.
- `pnpm build` — the corpus must not land in the main bundle. The labs are lazy routes; keep
  them that way.

---

## Open question worth deciding early

The gradient gates are unproven. `TRUTH_TOL` (chamfer 1.0px, p95 2.5px, parsimony 3.0×) was
calibrated on flat handcrafted art. Gradient emoji with soft filter edges may not be gradeable
at those thresholds at all — and if you loosen them globally you weaken tier 0. **Expect to
need per-tier tolerances,** and say so in the gate table rather than quietly widening the
existing ones.
