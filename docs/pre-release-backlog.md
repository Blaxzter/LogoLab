# Pre-release backlog — product gaps around a very good tracer

**Date:** 2026-09-08. **Method:** read the option surface (`src/types.ts`
`VectorizeOptions`), the studio (`src/components/vectorize/`), the sheet path
(`src/lib/sheet/`) and the labs, then drove the app at `localhost:5646` and
reproduced each user-visible claim. Baseline state at the time of writing:
`node --test` **509 tests / 507 pass / 0 fail / 2 skipped**, 231 s;
`tsc -b --noEmit` clean; console clean on `/vectorize`.

The premise of this list: the *tracer* is further along than the *product around
it*. Two years of §-numbered measurement went into `src/lib/trace`, and the
things most likely to make a first-time user bounce are all outside it — an
option that exists but has no control, work that disappears on reload, an auto
mode that makes exactly one decision. Ranked by "what does a stranger hit first".

Each entry names the code that already exists, because most of these are wiring,
not invention.

---

## A. Ship blockers

### A1. Mono has no Invert, and light-on-dark art traces to nothing — silently

> Filed as [#46](https://github.com/Blaxzter/LogoLab/issues/46) (bug).

**Reproduced.** Load the bundled **Outline** example (white line-art), switch
Source → *Re-trace*, Mode → *Mono*. Result: **`0 paths · 0 nodes · 0 colors ·
70 B`**, a blank traced pane, no error, no hint. The app looks broken.

Two separate holes:

- `VectorizeOptions.invert` exists and is documented in `src/types.ts:113-117`,
  and appears **nowhere** in `TraceControls.tsx` or `controlDocs.ts`. There is no
  way for a user to reach it.
- `DEFAULT_VECTORIZE_OPTIONS.threshold` is a hard **128**
  (`src/lib/trace/index.ts:45`) regardless of what the art's ink and paper
  actually are.

The fix is already written, measured, and shipping — in the *other* tab.
`src/lib/sheet/inkProbe.ts` (`probeInk`) counts inks after fusing tonal variants
and returns `mono`, `monoInverted`, `inkLuma`, `paperLuma`; `planTileBase`
(`src/lib/sheet/plan.ts:100-145`) turns that into `mode`, `threshold`, `invert`,
and a recolor to the ink's true hex. `/sheet` has a **colour auto / Mono / Color**
control driven by it. `/vectorize` — the flagship tab — has none of it.

**Ask:** lift the sheet's decision into the studio. Mode gains an **Auto**;
Mono gains an **Invert** toggle and a threshold seeded from ink/paper luma;
mono output offers the ink's own colour instead of `#000`.

### A2. An empty (or near-empty) trace should say so

> Filed as [#47](https://github.com/Blaxzter/LogoLab/issues/47).

Independent of A1: any trace that comes back with 0 paths, or one path covering
the whole canvas, should render a hint next to the stats bar rather than an empty
checkerboard. "No shapes found — the ink may be lighter than the paper (try
Invert), or the threshold may be cutting everything out." Cheap, and it converts
the single worst first-run experience into a nudge.

### A3. Nothing survives a reload

> Filed as [#48](https://github.com/Blaxzter/LogoLab/issues/48).

`src/store.ts` is a plain zustand store with no persistence. The only thing
written to `localStorage` in the whole product is the **theme** (`src/theme.ts`).
Reload and you lose: the logo, every trace setting, every region marker, every
hand-edited node, the appearance/mockup state, and the export selection.

The irony is that the **labs** persist their view state (`useLabState.ts`,
`localStorage`) and cache corpus results in IndexedDB (`labCache.ts`). The
research harness remembers more than the product does.

**Ask:** persist the working asset in IndexedDB and the option/appearance state
in `localStorage`, restore on load with a "Restore your last session?"
affordance. A trace can take 10 s and a node-edit session 20 minutes; losing that
to a refresh is the most likely first bad review.

### A4. No error boundary

> Filed as [#49](https://github.com/Blaxzter/LogoLab/issues/49) (bug).

No `ErrorBoundary` / `componentDidCatch` anywhere in `src/`. The tracer is a
large amount of numerical code running on arbitrary user uploads; one throw in a
render path blanks the entire app with no way back except a reload — which,
per A3, also discards everything.

**Ask:** a route-level boundary with "Reset this panel", "Start over", and a
"Report an issue" link that prefills the image dimensions, the options JSON and
the stack.

### A5. There is no CI

> Filed as [#50](https://github.com/Blaxzter/LogoLab/issues/50).

`.github/` contains only `FUNDING.yml`. `CLAUDE.md` describes a regime that
assumes CI exists — *"`KNOWN_DEFECTS` … is the authoritative, machine-checked
status — CI breaks both when a new case fails and when a listed one starts
passing"* — and nothing is actually running it. The suite is green today by
diligence, not by enforcement, and it is the whole safety net under a tracer
whose defects are invisible without it.

**Ask:** a workflow running `tsc -b --noEmit`, `node --test` (~4 min) and
`pnpm build` on push and PR. Two riders worth folding in:

- `src/components/vectorize/controlPreviews.generated.ts` is **committed and
  regenerated at build time** (`scripts/gen-previews.mjs`), and it is dirty in
  the working tree right now against HEAD's tracer — the info-dialog previews
  drift from what the tracer actually does. Either gitignore it or assert in CI
  that regenerating is a no-op.
- README calls **Crisp** "the default" engine twice (lines 70, 194). The default
  is **Planar** (`DEFAULT_VECTORIZE_OPTIONS.engine`).

---

## B. A better automatic mode

### B1. Self-scoring Auto — trace a few candidates, score them, pick the winner

> Filed as [#51](https://github.com/Blaxzter/LogoLab/issues/51).

Today "automatic" is exactly **one** binary decision, made once per image:
`suggestGradients` (a rampiness probe) flips the gradients toggle. Everything
else is a fixed default — mode `color`, engine `planar`, smoothing 50, despeckle
25, fidelity 1.5, regionDetail 0, threshold 128, detail `balanced`, upscale
`off`. Inside the flat lane one more choice is made implicitly and invisibly:
`dominantColors` picks palette-first vs Mumford–Shah per raster, and
benchmarks §0 **#20** records that the *same art* takes different engines at 256
and at 512 on 6 of 152 gallery marks. The user never sees any of this and cannot
influence it.

Every piece needed to do better already exists and is already pure:

| piece | where | note |
|---|---|---|
| render a traced doc to pixels | `src/lib/render/raster.ts` `rasterizeDoc` | pure, deterministic, identical in Node and browser — by design |
| score render vs source | `src/devtest/metrics.ts` `fidelity()` | meanΔE / p95ΔE / SSIM / boundary-seam. Header says it: *"All pure: no DOM, no Node APIs"*. 461 lines + an 86-line `color.ts`, importing only `lib/path` |
| parsimony | `src/lib/path/model.ts` `docStats` | already displayed in the stats bar |
| pick mono/invert/threshold | `src/lib/sheet/inkProbe.ts` + `plan.ts` | see A1 |
| run N traces off-thread | `traceOffThread.ts` | one worker per call, abortable |

This is precisely the method the **paint-fidelity gate** already uses (§10.3):
render the trace, score it in ΔE against the source raster. The truth gate needs
an authored SVG; *this* needs only the user's own pixels, so it works on
everything a user uploads.

**Ask:** on load, trace 3–5 candidates at a reduced raster (256–384 px, cheap),
score each on ΔE + node count, re-trace the winner at the full cap, and **show
the scoreboard**: "Auto chose *Flat · gradients off* — ΔE 1.8, 44 nodes", with
the runners-up one click away. Candidates worth including:

1. `probeInk`-derived mono (+ invert, + ink recolor) — for one-ink marks
2. flat / palette-first, gradients off
3. Mumford–Shah + gradients on
4. flat + `backgroundGradient` (see C4) — the AI-icon shape: gradient backplate,
   flat glyph
5. for sources ≤ 320 px, the AI upscale path (issue #42, already shipped opt-in)

Two things this buys beyond a better first result: the choice becomes *visible
and stable* instead of flipping with the raster (#20), and the user gets a reason
rather than a mystery.

### B2. A fidelity readout, and a Difference view

> Filed as [#52](https://github.com/Blaxzter/LogoLab/issues/52).

The stats bar says `7 paths · 44 nodes · 7 colors · 2.07 KB` — four numbers about
*size* and none about *accuracy*. To judge whether a trace is good the user has
to switch to Overlay and squint at a ghost blend.

`fidelity()` gives the number. `AbLab.tsx:358` `diffHeatBuffer` +
`labs/heat.ts` already render a per-pixel disagreement heat on the shared
cold→hot ramp — it is how tracer changes are reviewed internally.

**Ask:** add ΔE to the stats bar, and a fifth view mode **Difference** beside
Split / Traced / Original / Overlay, painting the same heat the labs use. The
research view of "where is this trace wrong" is genuinely the most useful thing
in the app and it is currently locked behind `/labs`.

### B3. Presets, and a Reset

There is no preset system and no "reset to defaults" anywhere in
`TraceControls.tsx`. A user who drags four sliders into a bad place has no way
back except reloading (which, per A3, costs them everything).

**Ask:** *Flat icon · Line art · Illustration · Photo* as one-click bundles over
mode/gradients/detail/fidelity/despeckle, plus **Reset to defaults**. Presets are
also the honest UI for B1: Auto picks one, and the preset row shows which.

---

## C. Knobs the engine already accepts and the UI never offers

Every one of these is a documented field of `VectorizeOptions` that the tracer
reads today. This is wiring, not new capability.

### C1. "Colours: N" — REJECTED 2026-09-08

Proposed as a Colours slider over `paletteSegment.maxColors`/`minShare`, on the
grounds that it is the dial every competing vectorizer leads with. **Cut by the
user on the day it was written:** `PaletteEditor` (bottom right) already gives
per-colour control — eyedrop, edit a hex, set an opacity, add or remove an
entry — and a rigid *count* is the weaker interaction, not the missing one. A
number chosen up front says nothing about *which* colours it should keep, which
is the decision the user actually has. Kept here so it is not re-proposed.

### C2. Curve tolerance / node budget

Smoothing (0–100) maps onto blur and turd size; it is not the fit tolerance.
The fit ε is `planarFit.keyEpsilon` — the lever §30 and §35 both identify as the
live one (tightening 1.0 → 0.35 takes interior error 0.09 → 0.04) — and it is
reachable only from `src/devtest/crispnessStudy.ts`.

**Ask:** expose ε as **"Curve tolerance"**, or invert it into a **node budget**
("simplify until ≤ N nodes"), which is what an icon author actually wants to say.

### C3. Invert (mono)

See A1. Listed twice on purpose — it is both a bug and a missing knob.

### C4. The two experimental flags the docs already plan to expose

`docs/planar-tracer.md:112` and benchmarks §9.3 both say it in as many words:
*"Planned: expose them as opt-in feature flags in the /vectorize studio rather
than merging as defaults."*

- **`backgroundGradient`** (`src/types.ts:236-247`, `backgroundLayer.ts`, tested
  in `test/background-layer.test.ts`) — unites the posterized background bands
  into one fitted gradient so a foreground outline stops being split by band
  junctions. This is *exactly* the shape of a generated app icon: gradient
  rounded-square behind a flat glyph. It measured "0 wins on ground truth where
  it applies", which is a fair reason not to default it on and a poor reason to
  keep it unreachable.
- **`refineJunctions`** — 10 better / 14 worse on the flat corpus; same argument.

### C5. `flatPalette` and `layeredDecomposition` escape hatches

Both are automatic decisions with no override. When the automatic choice is wrong
the user has no lever at all. Fold them into an **Advanced** disclosure with the
above.

---

## D. Output and export

### D1. Merge same-fill paths on export

The planar model gives one path per region, which is right for editing and
wasteful for shipping: a 3-colour mark with 20 regions exports 20 `<path>`
elements. There is no same-fill merge anywhere (`mergeFills` in the studio is
unrelated — it restores base fills under force-colour).

**Ask:** an export-time "combine paths by colour" that emits one compound path
per fill. Export-time specifically, so joint shared-edge editing is untouched.

### D2. Path names, ordering, and output precision

The Paths rail shows `Path 1 … Path 7` — no rename, no reorder, no ids or
classes. An SVG headed for a codebase wants `#logo-mark`, `.brand-primary`.
Coordinate precision is hard-coded at 3 (`VectorizeStudio.tsx:157`) with no way
to trade bytes for accuracy.

### D3. Centerline (stroke) tracing

A real capability gap rather than a missing control. Monoline marks — the
majority of icon-set logos — currently trace as outlined fills; the user gets the
*silhouette of a stroke* instead of a stroke they can re-weight. `isStrokeOnly`
and stroke import already exist in the model (`parseSvg` imports strokes as
editable paths), so the doc side is ready; the tracer has no skeleton pass. Big
piece of work, highest ceiling on this list.

---

## E. Worth having, not urgent

- **Batch**: drop N logos → trace all → one zip. `/sheet` already does exactly
  this for tiles of one sheet (`plan.ts`, `traceTile.ts`); generalising it to N
  files is mostly UI.
- **Project file**: `.logolab` JSON (source + options + markers + edits) — makes
  a trace reproducible, shareable, and re-openable, and is A3's export-shaped
  sibling.
- **Session breadcrumb** in the trace history: "you traced this at fidelity 1.5 /
  gradients off" beside each result, so A/B-by-hand is possible without the labs.

---

## Suggested order

1. **A1 + A2** — the visible-broken one, and its fix is already written in `src/lib/sheet`.
2. **A5** — CI, before anything else moves.
3. **A3 + A4** — persistence and the boundary; the two ways a user loses work.
4. **B2** — the fidelity number and the Difference view: small, and it makes every later change reviewable *in the product*.
5. **B1** — self-scoring Auto, built on B2's scorer.
6. **C2 + C4 + C5** — the knobs, behind B3's presets. (C1 rejected.)
7. **D1 + D2**, then **D3** when there is appetite for a new tracer pass.
