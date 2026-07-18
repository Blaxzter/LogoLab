# LogoLab — working notes for agents

Drop in a logo → preview in context → **vectorize** to clean SVG → export PWA icons. The
vectorizer (raster → planar shared-edge trace) is the heart of the app: `src/lib/trace/`.

## Before ANY vectorizer change: freeze an A/B snapshot

A change to the tracer (`src/lib/trace/**`, segmentation, beautify, fit) can silently move the
output on cases you weren't looking at. So **before** you start, freeze a baseline:

```
pnpm gen:absnapshot before-<what>     # e.g. before-checker
```

Then make the change and open **`/labs/ab`** → pick your baseline in the **Vs snapshot**
dropdown → **Changed only** shows exactly which cases moved, and each gets a **diff heat**
panel showing *where*. This is how you catch collateral changes (a corner-veto for `checker`
also nudged `aa-seam`'s flat trace — only the A/B view revealed it). Snapshots live in
`test/ab-snapshots/<name>/`; several coexist. Re-bless (`pnpm gen:absnapshot <name>`) once a
change is accepted.

## Verifying tracer correctness (not just "did it change")

`/labs/ab` tells you output *changed*; the **truth gate** tells you if it's *wrong*. It scores
the trace against the AUTHORED SVG (geometry, not a blessed baseline), so an improvement just
moves further inside the limits — nothing needs re-blessing.

```
node --test test/truth-gate.test.ts
```

Gates: boundary chamfer/p95, node parsimony, region recovery, and **corner recovery** (a
distance-blind topology check — catches a shape rounded while every px stays sub-tolerance,
e.g. a checker cell melted to a blob). Open defects + the method are tracked in ONE place:
**`docs/vectorization-benchmarks.md` §0**, with `KNOWN_DEFECTS` in the test as the
machine-checked status. A case not in `KNOWN_DEFECTS` must pass every applicable gate.

## Node

Node ≥ 22; TS is run directly via `node --experimental-strip-types`. `pnpm test` = full suite.
