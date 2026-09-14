# LogoLab — working notes for agents

Drop in a logo → preview in context → **vectorize** to clean SVG → export PWA icons. The
vectorizer (raster → planar shared-edge trace) is the heart of the app: `src/lib/trace/`. It
is also the npm package **`logolab`** — the same tracer as an MCP server — so read *The tracer
ships TWICE* below before you call a change to it done.

## Before ANY vectorizer change: freeze an A/B snapshot

A change to the tracer (`src/lib/trace/**`, segmentation, beautify, fit) can silently move the
output on cases you weren't looking at. So **before** you start, freeze a baseline:

```
pnpm gen:absnapshot before-<what>     # e.g. before-checker
```

Then make the change and open **`/labs/ab`** → pick your baseline in the **Baseline**
dropdown → **Changed only** shows exactly which cases moved, and each gets a **diff heat**
panel showing *where*. This is how you catch collateral changes (a corner-veto for `checker`
also nudged `aa-seam`'s flat trace — only the A/B view revealed it).

If you also freeze an `after-<what>` stamp when the change is accepted, the two are a **pair**:
they show up in the Baseline dropdown under **⇄ Pairs** as one entry that diffs the two FROZEN
stamps against each other (nothing traced, so it does not decay as you keep working, and the
`after-` stamp is not dead weight). **Compare with** is the same control by hand — working tree
(the default) or any other snapshot. Don't stamp an `after-` unless you mean to keep it: a lone
`before-` is the normal case, and the pair is for a result worth being able to re-open later.

Every case is traced in **three lanes** (`AB_LANES`), each at the resolution production uses
for that art: flat at the flat cap, gradient/photo at the gradient cap, and **mono** — which
is NOT a subset of the colour path (`mode: 'mono'` returns before segmentation and the colour
lanes pin `engine: 'planar'`, which routes around the two modules mono is made of). The mono
cut comes from the ink probe on the raster, not a constant, so the lane traces what a user
actually gets. Old stamps keep working: every lane's resolution is recorded per stamp.

Two case lanes, both in `src/devtest/abCorpus.ts`: the ⟐ **fixtures** (handcrafted, one mechanism
each — good gates, weak evidence: they are "good enough" long before real art is) and a slice
of the ◆ **gallery** corpus, the same brand marks `/labs/gallery` shows, rasterized on white
exactly as that page does. The gallery lane needs `npm run fetch:logos`; without it the lane
is empty and everything else still works. `--logos all|a,b|none` overrides the slice for one
run. Judge a tracer change on BOTH — the defects get reported on the marks.

Snapshots live in `test/ab-snapshots/<name>/`, several coexist, and they are **gitignored**:
a stamp is a local working artifact (regenerable from any revision), and the gallery lane
traces trademarked art that is not redistributed. Re-bless (`pnpm gen:absnapshot <name>`)
once a change is accepted.

## Verifying tracer correctness (not just "did it change")

`/labs/ab` tells you output *changed*; the **truth gate** tells you if it's *wrong*. It scores
the trace against the AUTHORED SVG (geometry, not a blessed baseline), so an improvement just
moves further inside the limits — nothing needs re-blessing.

```
node --test test/truth-gate.test.ts
```

Gates: boundary chamfer/p95, node parsimony, region recovery, **corner recovery** (a
distance-blind topology check — catches a shape rounded while every px stays sub-tolerance,
e.g. a checker cell melted to a blob), and **paint fidelity** (gradient tier 0 only: the
trace is RENDERED and scored in ΔE against the source raster — catches a paint-only failure
like a re-centred glow, which every geometry gate is blind to on gradient art, §10.3).
Open defects + the method are tracked in ONE place:
**`docs/vectorization-benchmarks.md` §0**, with `KNOWN_DEFECTS` in the test as the
machine-checked status. A case not in `KNOWN_DEFECTS` must pass every applicable gate.

## The tracer ships TWICE, and only one of them is automatic

A tracer change reaches the website by itself — Cloudflare Workers Builds is connected to this
repo and deploys `main`. It does **not** reach anyone running `npx -y logolab`. That is the
same tracer, published to npm as **`logolab`** from `packages/mcp`, and it only moves when
someone cuts a release. **A tracer change is not shipped until you release one.**

`packages/mcp` has no sources of its own: it points tsc at `src/mcp/server.ts` and compiles
whatever that reaches (`src/mcp` plus `src/lib/{trace,path,sheet,render}` — 57 files today), so
your change is already *in* the package the moment you edit the tracer. It is just unpublished.

To release: bump the version in **`packages/mcp/package.json`** — the only place it lives; the
server reads it (`packageVersion` in `src/mcp/runtime.ts`) rather than repeating it — then

```
pnpm test
git tag v0.1.1 && git push origin v0.1.1     # tags are signed; make it LOCALLY
```

then Releases → Draft a new release → pick the existing tag → Publish. `release.yml` does the
rest (trusted publishing over OIDC, no npm token, provenance attached) and refuses a tag whose
version disagrees with the manifest. Do not let the GitHub UI create the tag for you: one made
server-side is unsigned, and the workflow verifies the signature.

### `test/mcp-package.test.ts` is what stops you shipping a broken package

The package's dependency list is decided by IMPORTS, in files nobody edits with npm in mind.
Add `import { x } from 'some-package'` anywhere in the tracer's graph and the app still works,
the checkout still works, the typecheck still passes — and `npx -y logolab` dies at runtime
with `ERR_MODULE_NOT_FOUND`, because that package was a devDependency of the app and was never
declared by the package that ships. The test walks the real graph (static, dynamic, and the
lazy `createRequire` that loads the optional sharp decoder) and fails on anything undeclared,
on a dependency version that drifts between the two manifests, and on the server's version
being hard-coded again instead of read. **If it fails, fix the manifests — never the
assertion.**

## The session is persisted, so studio state has TWO homes now

Every studio's state used to be session-only. It isn't: a reload restores the upload, the
appearance, the trace options and markers, the traced document (hand edits included), an
un-applied cleanup cutout, the whole icon sheet with its traces, and the editor's drawing.
`src/lib/persist/` owns it, and the split is by WHEN a value is needed, not by size:

* **localStorage** for anything that must be right in the FIRST painted frame — the stores and
  the studios seed their initial state from it synchronously. Async would mean rendering the
  defaults and then snapping to the user's settings.
* **IndexedDB** for bytes and documents. Read ONCE in `main.tsx`, before the first render, into
  a module-level payload that panels `claim()` on mount — so a lazily-mounted studio never
  races an async read against its own auto-trace.

The header's **Saved chip** (`src/components/SavedChip.tsx`) is the standing indicator, over
`src/lib/persist/status.ts`. It must be able to say **Not saved**: private mode, a blocked
origin and a full quota all make persistence impossible, and a chip that keeps reading "Saved"
through that is worse than no chip. `test/save-status.test.ts` is the gate — both of its
failure modes (reporting saved while a newer value is still in memory, or sticking on
"saving") look identical to the working version in a screenshot.

Two things to keep in mind when touching a studio:

* Anything derived from the working PIXELS is stored with `assetKey` (`src/store.ts`), which is
  reissued whenever those pixels change. Check it before adopting a restored value, or a trace
  ends up shown over a different image than it was cut from.
* A restored studio must not re-run the probes that set its defaults. `VectorizeStudio` keeps
  the ink probe (it feeds the “why” line) but runs it MEASURE-ONLY on the first pass after a
  restore — otherwise the rampiness probe and the ink offer overwrite the user's own settings,
  which reads as “my options reset themselves”.

## The Editor tab IS the working logo — on CHANGE, never on open

`EditorPanel` pushes its document into the app's logo by itself (debounced); there is no
"Use as logo" button any more. The guard that matters is `doc !== opened`: the studio fires
`onChange` once with the document it was seeded with, and treating that as an edit is
destructive rather than merely redundant — round-tripping an SVG through `parseSvg` →
`serializeDoc` yields different markup for the same drawing, so *visiting* the tab would
reissue the working image, bump `assetKey`, and drop the trace and cleanup keyed to it.

It is also what makes opening an example or a dropped SVG harmless: your logo is untouched
until you actually change something. Don't replace that check with a text comparison against
`logo.svgText` — that is the weaker guard already sitting underneath it, and it does not hold
across a parse round-trip.

The open drawing lives in a MODULE-level slot as well as React state. This panel is a lazy
route, so every tab click unmounts it, and the stored session can't stand in: the boot payload
is claim-once and the first mount already took it. Without the slot, clicking to Preview and
back dropped the drawing and showed the intake screen.

## Offline: the precache list is computed, not globbed

The app is a PWA. The service worker is hand-written (`src/pwa/sw.js`) and its precache list is
computed at build time from the chunk graph (`scripts/swPlugin.ts`): reachable from the entry,
stopping at `src/components/labs/`, `src/devtest/` and the three optional heavyweight packages.
A glob would precache all 31 MB — 27 MB of which is the research harness and the AI runtime that
a user cropping a logo never opens.

The walk follows imports AND **bare URL references in chunk code**, because that is how Vite
emits a Web Worker — and the tracer runs in one. Dropping it makes “works offline” silently mean
“works offline until you try to trace something”. `test/offline-precache.test.ts` is the gate.

## Node

Node ≥ 22; TS is run directly via `node --experimental-strip-types`. `pnpm test` = full suite.
