# Handoff — junction weld + background-layer batch (2026-07-08)

Branch `feat/planar-tracer`. **COMMITTED 2026-07-09** (the whole batch below +
TODO 1's two fixes — see the latest `git log`; nothing left in the working tree from
this session). Do not revert anything on your own judgment — the user judges visuals
(see memory `show-before-reverting`). No browser MCP available; work headless (tests +
code reading). Keep runs small, no multi-agent workflows.

**What's LEFT:** TODO 2 (triage 12 unverified review claims — start with the
colour-class over-merge one, now higher-stakes because `removeBackground` composes with
the union ⇒ over-absorb = DELETE, not just mis-paint) and TODO 3 (USER visual judgment
+ default flips). Both flags still default OFF, so nothing shipped changes behaviour.

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

## TODO 2 — triage the UNVERIFIED review claims (12 verify agents died on rate limit)

These were RAISED but never adversarially checked — treat each as a hypothesis,
read the code, fix only what you can concretely confirm. Claims live in the four
reviewer results inside
`C:\Users\mail\.claude\projects\E--Programming-projects-logoviewer\f78bad06-a9cd-4d94-bd36-ffd2a34bd924\subagents\workflows\wf_8e120e47-b87\journal.jsonl`
(one JSON line per agent). Titles:

- Weld: transitive union-find chains could over-merge distant junctions (A–B ≤3px,
  B–C ≤3px ⇒ A,C fuse at >3px span); edges whose BOTH endpoints fuse into one
  vertex become open self-loops (`startVertex === endVertex`) — check downstream
  consumers (`planarBeautify.snapCoCircularLoops`, provenance, `topologyEdit`);
  weld runs after `orientLoops` with no re-orientation (tiny loops' winding);
  loop excision only drops fully-emptied loops (a 1-ref leftover that no longer
  closes?); image-border junctions fusing (frame vertex moved off the border?).
- BG union: render gate dilution when the union already dwarfs a late candidate
  (weighted means — check the math in `backgroundLayer.ts`); palette-path labelsz
  are COLOUR CLASSES, so relabeling merges disconnected same-colour components
  (could merge a foreground shape that shares a band's colour — real risk, worth a
  test); flat markers / locked palette interplay (union should probably skip
  flat-marker-pinned labels); unbounded cost (per-candidate refit × rounds — cap
  samples or rounds if a photo with many labels ever hits this path).
- Metrics: jaggedness comparability between topology path and subPaths fallback
  (fallback counts each shared boundary TWICE — fine per-case since goldens are
  planar, but document); `junctionClusters <= golden` gate with golden=0 blocks
  ALL new clusters (intended, but confirm no legit case trips it).

## TODO 3 — the actual next step: USER JUDGMENT

- `npm run dev` → `/vectorize-junctions.html`, gradients OFF. Variants: Baseline ·
  Arc-snap (shipped) · Sub-pixel+G¹ · Weld ≤3px · Weld+snap+G¹ · BG gradient+weld.
  The user drops their own images and decides: weld default? radius 2 vs 3?
  backgroundGradient as a UI toggle (TraceControls) or auto via a render gate?
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
