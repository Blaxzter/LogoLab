# Handoff — junction weld + background-layer batch (2026-07-08)

Branch `feat/planar-tracer`. **COMMITTED 2026-07-09** (the whole batch below +
TODO 1's two fixes — see the latest `git log`; nothing left in the working tree from
this session). Do not revert anything on your own judgment — the user judges visuals
(see memory `show-before-reverting`). No browser MCP available; work headless (tests +
code reading). Keep runs small, no multi-agent workflows.

**What's LEFT:** TODO 3 (USER visual judgment + default flips). **TODO 2 is DONE
(2026-07-10 — triage + fixes below.)** Both flags still default OFF, so nothing shipped
changes behaviour; `npm test` 241 pass / 0 fail / 2 slow-skipped, `tsc` + `build` clean,
golden hashes UNCHANGED.

## State: DONE and verified (don't redo)

- **Weld** (`src/lib/trace/planarWeld.ts`, flag `planarFit.weldJunctions` px, default
  0 = byte-identical): contracts micro-edges between near-coincident junctions →
  bloom's X becomes ONE vertex. Called at end of `assemblePlanar`.
  `test/planar-weld.test.ts` (5 tests).
- **Background layer separation** (`src/lib/trace/backgroundLayer.ts`, flag
  `VectorizeOptions.backgroundGradient`, default off; gradients-OFF planar only,
  wired in `src/lib/trace/index.ts` after `healColorSpikes`): border-seeded label
  union gated by per-pixel CIE76 render comparison; merged region gets the fitted
  gradient. nebula 13p/606n→2p/40n, aurora 14p/276n→4p/44n, petals correctly
  rejected. `test/background-layer.test.ts` (4 tests).
- **Harness**: `topologyMetrics` in `src/devtest/metrics.ts` (junctions,
  junctionClusters, clusterSpanMax, jaggedness) → `scoreDoc` → `GoldenRecord` →
  gates in `test/trace-regression.test.ts`. New golden cases `bloom-flat` /
  `aurora-flat` with fixtures `test/fixtures/{bloom,aurora}-512.png`. Goldens
  re-blessed; the 5 pre-existing hashes are UNCHANGED.
- Suite: `npm test` → 235 pass / 0 fail (2 slow skipped). `npx tsc --noEmit` clean.
  `npm run build` clean (a junctionTest import error found mid-session is ALREADY
  FIXED — `VectorizeOptions` now imported from `../types`).
- Docs: `docs/planar-tracer.md` §5 (new 1e weld, 1f background layer) + §7 metrics.
  Memory `vectorization-upgrade-plan.md` updated with the full session state.
- Evidence page for the user (screenshots + numbers + judging instructions):
  https://claude.ai/code/artifact/713cda8c-db51-4cfe-af5f-a2e57b7fb419

## TODO 1 — DONE (2026-07-08, both CONFIRMED findings fixed)

Both in `src/lib/trace/index.ts` planar branch. Suite 239 (237 pass / 0 fail / 2 slow
skipped), `npx tsc --noEmit` clean, **golden hashes unchanged** (byte-identity holds:
`backgroundGradient` off ⇒ `bgUnion` null ⇒ drop-set is exactly the old `{bg}`).

1. **MAJOR — `removeBackground` × `backgroundGradient` conflict.** Fixed by *composing*
   the flags (user's call, asked explicitly): the union is the better background
   DETECTOR, so with both on the whole united set is dropped, not just the border
   band. `bg` (on `q.labels`) still feeds `applyRemoveMarkers`' fill exclusion; the
   drop-set is computed on the FINAL map: `{bg} ∪ bgUnion.set` — covering the case
   where the union's seed (re-detected on `healed`) disagrees with `bg`.
   Measured on a posterized-ramp fixture: `removeBackground` alone drops 1 of 8 bands
   (9→8 items); composed → **1 item**, just the foreground shape.

2. **MINOR — removed-marker colours contaminate the union fit.** Fixed: `changedMask`
   (pixels the remove-markers reassigned, whose raster RGB still belongs to the deleted
   object) is passed as a new optional `skip` arg to `fullRegionSamples`, union path
   only. Without it the fitted endpoint drifts `#cf282b → #642897` (~107/255 on red).

Both new tests in `test/background-layer.test.ts` were checked NON-VACUOUS by reverting
the fix and confirming they fail. Caveat: on that fixture `bgSeed === bg`, so test 1
locks in the *composed contract* rather than reproducing the original silent-ship
(which needs `bgSeed !== bg`); the drop-set covers both by construction.

## TODO 2 — DONE (2026-07-10, triaged the 11 unverified review claims)

Each claim treated as a hypothesis: read the code, confirmed/refuted empirically
(scratchpad probes + fuzzers), fixed only what was concretely confirmed. All fixes are
still gated on the OFF-by-default flags, so goldens stayed byte-identical.

**BG union (`backgroundLayer.ts`) — Claims 6 + 7 share ONE root cause + fix.**
The render gate judged each candidate on the WHOLE grown union's mean error, so a large
background DILUTED a small candidate's error to nothing and absorbed it regardless of
whether it belonged (Claim 6). That is exactly what makes the palette-path colour-class
over-merge dangerous (Claim 7): a label is a colour CLASS, so a foreground shape sharing
a band's colour rides in on the diluted gate and — with `removeBackground` — gets DELETED.
Confirmed with a probe (8-band ramp + small green shape ⇒ shape absorbed). **Fix:** gate
each candidate on ITS OWN pixels (`gradientRenderError(fit, samples[cand]) vs bandErr[cand]
+ RENDER_MARGIN`), margin recalibrated 0.1→1.0 (measured: legit ramp bands gap ≤0.14, a
distinct shape gaps ≥10; 1.0 is below the ΔE JND so a wrongful absorb stays imperceptible).
Two new tests in `test/background-layer.test.ts`; the `removeBackground × backgroundGradient`
test was updated (honestly, documented) — one near-flat sliver the gradient renders 2.7 ΔE
off now correctly stays OUT of the union instead of being diluted-absorbed.
- Claim 8 (flat-marker pin): **Fixed** — `uniteBackgroundGradient` takes a `pinned` set;
  a flat-marked label is never seeded/absorbed (wired in `index.ts` via `flatMarkerLabels`
  on `healed`). Locked-palette half: enabling `backgroundGradient` is a deliberate opt-in,
  so running the union is fine; flat markers still honoured. + test.
- Claim 9 (unbounded cost): **Confirmed** (929 ms on a 256² noisy photo). **Fixed** —
  `UNION_FIT_CAP` (12000) strides the union fed to each fit; `MAX_UNION_FITS` (600) budgets
  candidate fits so a many-band gradient poster can't go ~quadratic. Both no-ops on real
  band-sets (byte-identical).

**Weld (`planarWeld.ts`) — root cause of 1/2/5 was the same unbounded transitive fusion.**
A 4000-case fuzzer showed near-random maps collapse the WHOLE junction set into one cluster
(border vertex `(1,0)→(6.8,6.6)`).
- Claim 1 (transitive over-merge): **Fixed** — a `spanCap = 2·radius` rejects any cluster
  whose pairwise span is too large (its micro-edges survive — the safe pre-weld fallback).
- Claim 2 (self-loop edges `start===end`): **Fixed** — an edge whose both endpoints fuse
  into one survivor is now CONTRACTED like a micro-edge (excised from loops). Net weld-
  induced self-loops went negative (weld now REDUCES the pre-existing tracer ones).
- Claim 5 (frame vertex pulled off the border): **Fixed** — a fused cluster containing a
  frame junction is clamped onto that frame edge (threaded `net.width/height` into the weld).
  Border-moves 3879→0. Two new tests in `test/planar-weld.test.ts`.
- Claim 3 (no re-orientation after weld): **Refuted** — welded vs weld-0 have identical
  loop-winding-violation counts (weld adds 0 net); its moves are small + tiny loops drop.
- Claim 4 (1-ref leftover loop that no longer closes): **Refuted** — 0 single-open-loops
  across the fuzzer; `assertLoopsClosed` holds (the Claim-2 contraction also covers this).

**Metrics (`metrics.ts`) — both were documentation asks.**
- Claim 10: documented that jaggedness is NOT comparable across the topology vs subPaths
  branches (fallback double-counts shared boundaries AND adds junction-corner turn).
- Claim 11: confirmed the zero-tolerance `junctionClusters` gate is intended (0 for
  nebula/petals/schild-flat; genuine-crossing cases carry non-zero goldens with headroom)
  and documented it in `test/trace-regression.test.ts`.

## TODO 3 — the actual next step: USER JUDGMENT

- `npm run dev` → `/vectorize-ab.html` (renamed from vectorize-junctions.html),
  gradients OFF. Variants: Baseline · Arc-snap (shipped) · Sub-pixel+G¹ · Weld ≤3px ·
  Weld+snap+G¹ · BG gradient+weld. Now also carries a handcrafted "difficult case"
  corpus (SVG, `src/devtest/genEdgeCases.ts`) and an **Input px** switch that
  re-rasterizes each SVG case at 128–1024px (labels show p·n·**j**unctions, so you can
  watch scale-stability). The user drops their own images and decides: weld default?
  radius 2 vs 3? backgroundGradient as a UI toggle (TraceControls) or auto via a render gate?
- Only after their verdict: commit (they must ask), possibly flip defaults +
  re-bless goldens (`npm run gen:golden` — review the printed diff).

## Gotchas for a small agent

- Run tests: `npm test` (full) or `node --test --experimental-strip-types test/<file>.test.ts`.
- Dev server may pick port 5174 (5173 often busy).
- `weldJunctions: 0` and `backgroundGradient: undefined` MUST stay byte-identical —
  the golden hashes are the proof; never re-bless to make a failure pass without
  understanding it.
- The A/B view is the only sanctioned place to judge visuals; metrics are
  information, not verdicts.
