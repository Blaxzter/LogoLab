# Handoff — fold the `labs/` harnesses into the React app

**Status:** not started. **Prereq work: DONE** (the five pages now live in `labs/`, build
clean as `dist/labs/*.html`, and are linked from `LAB_VIEWS` in
`src/components/navItems.tsx`).

---

## The ask

The five vectorizer harnesses are standalone HTML pages with hand-rolled inline CSS and
hand-rolled DOM. The user wants to **show them off inside the application** — so they need to
become real React views that look like the app, not dev-only scratch pages. Re-implementing
their CSS from scratch would be wasteful: **the app already has the design system and most of
the interaction primitives they duplicate.**

This is a **refactor**, not a rewrite. The pages already work and already produce correct
numbers. Do not change what they measure.

---

## Read first (don't rediscover this)

- `docs/vectorization-benchmarks.md` — why the ground-truth gate exists, what the metrics
  mean, and the traps already fallen into. **The trust properties in §"Non-negotiables"
  below come from there.**
- `src/devtest/truthCorpus.ts` / `src/devtest/traceCorpus.ts` — the corpora + gates, shared by
  the Node CLI and the browser views. This sharing is the whole reason the views are
  trustworthy.

---

## What already exists in the app — REUSE, don't rebuild

| App asset | What the labs do instead |
|---|---|
| **`src/components/ui/ZoomSurface.tsx`** + **`src/hooks/usePanZoom.ts`** — synced pan/zoom across surfaces, wheel-zoom toward cursor, drag-pan, double-click reset, **pinch-zoom** | `attachCam` / `clampCam` / `applyCam` hand-rolled **3×** (`goldenView.ts`, `truthView.ts`, `junctionTest.ts`), with no pinch support. **This is the single biggest win.** |
| **`src/components/ui/ZoomControls.tsx`** | `#zoom` / `#reset` DOM wiring, 3× |
| **`src/components/ui/controls.tsx`** — `Field`, `Slider`, `Toggle`, `Segmented`, `Collapsible` | raw `<input type=range>` / `<select>` / `<details>`, 3–5× |
| **Tailwind v4** (`@import 'tailwindcss'` in `src/index.css`) | ~330 lines of inline `<style>` across the 5 pages |
| `Button`, `Tooltip`, `Sheet`, `CheckerToggle` | ad-hoc |

### The actual duplication (measured)

CSS classes defined in **all five** pages: `.row`, `.cells`, `.cell`, `.box`.
DOM ids bound in **all five**: `#out`, `#status`. In 3/5: `#zoom`, `#size`, `#reset`.

Inline `<style>` per page: golden 107 lines · truth 88 · ab 50 · debug 45 · test 43.

TS helpers duplicated across view modules: `attachCam`/`clampCam`/`applyCam` (3×),
`heat()` colour ramp (2×), `rgbaToUrl()` (2×), the `load()`/`save()` localStorage state
pattern (3×).

---

## Suggested component inventory

Extract into `src/components/labs/`:

- **`<LabPage>`** — the shell: sticky compact toolbar + collapsible "about" (`<details>`,
  state persisted). Both `vectorize-golden` and `vectorize-truth` already have this exact
  structure; the other three still have the old fixed-header wall of prose that the user
  complained about. **Fix all five by having one shell.**
- **`<CaseRow>`** — `.row` + `<h2>` + badge + `.cells` flex strip.
- **`<Panel>`** (was `.cell` + `.box`) — labelled box with the checkerboard background,
  wrapping a `ZoomSurface` so every panel in a row shares one `PanZoom`.
- **`<GateTable>`** — the headroom bars + n/a rows. Currently duplicated between
  `goldenView` and `truthView`; the shapes differ (`GateRow` vs `TruthGate`) but the render
  is the same. **`TruthGate.applicable === false` must render as `n/a`, never as a pass** —
  see Non-negotiables.
- **`<HeatMap>`** / **`heatColor()`** — one colour ramp, one module. Both pages already use
  the same stops.
- **`<WireOverlay>`** — the nodes/edges SVG overlay (`.w-edge`, `.w-corner`, `.w-smooth`,
  `.w-vert`), currently in 2 pages.
- **`useLabState<T>(key, defaults)`** — the localStorage-persisted view state, replacing the
  three copies of `load()`/`save()`.

---

## Non-negotiables (breaking these silently ruins the views)

1. **Do not reimplement scoring in React.** The views import their case lists, trace options,
   gates and metrics from the *same modules the Node CLI uses* — `truthCorpus.ts`,
   `traceCorpus.ts`, `geomScore.ts`, `scoreboard.ts`. That is the only reason "what you see is
   what CI measures" is true. A React component that recomputes a metric locally will drift.
2. **`applicable: false` must render as `n/a`, not as a pass.** A gate that silently passes
   because it had nothing to measure is worse than no gate (`bg-ramp` scores a *perfect* 0.00
   boundary error because it has no interior boundary; region recovery is meaningless on
   gradient art). This trap has already been hit once.
3. **Keep the rasterizer caveat visible.** The browser rasterizes SVG with canvas; the Node
   runner uses resvg. Numbers can differ in the last decimal. Say so in the UI.
4. **Bundle isolation.** The `vite.config.ts` comment is explicit: these are separate entries
   so *"none of this lands in the main bundle"*. If they become React routes, **lazy-load
   them** (`React.lazy` + route-level split) or every normal user downloads the harnesses.
5. **Tracing is slow** — the truth view traces 16 cases × up to 3 resolutions. It must not
   block the app shell. Keep the incremental "render the row, then trace, then fill it in"
   pattern (`truthView.ts` `render()` already does this with a `setTimeout(0)` yield); a
   naive `await Promise.all` will freeze the tab.

---

## Suggested order

1. **`ZoomSurface` first.** Replace the three hand-rolled cameras with the existing component
   in place, still in the HTML pages. Biggest win, lowest risk, immediately testable.
2. Extract `<Panel>` / `<CaseRow>` / `<LabPage>` and port **one** page — `vectorize-truth` is
   the best candidate (newest, cleanest, and its shell is already the target shape).
3. Port the rest. `vectorize-debug` / `-test` / `-ab` still have the old fixed-header layout;
   the shell fixes them for free.
4. Add the routes (lazy), point `LAB_VIEWS` at them, delete `labs/*.html` and their
   `rollupOptions.input` entries **last** — only once every page has a working React
   equivalent.

---

## Verification

- `pnpm typecheck` && `pnpm test` (243 tests; 241 pass / 0 fail / 2 slow-skipped is the
  current baseline — **do not let this regress**).
- `pnpm build` — confirm the lab code is **not** in the main `index` chunk.
- **Drive the pages in a browser and compare numbers to the CLI**:
  `node --experimental-strip-types src/devtest/groundTruthRun.ts` should agree with
  `/labs/vectorize-truth.html` to within anti-aliasing noise. If a ported view disagrees with
  the CLI, the port broke the shared-module contract (Non-negotiable #1).
- Current expected truth-corpus state, as a regression check: `bloom` 5/7 and `petals` 5/7
  regions (**known tracer defects, not view bugs** — see `docs/vectorization-benchmarks.md`
  §7); `aurora` reports **not scorable** (stroked geometry); everything else clean.

---

## Note on scope

The user's framing was *"I wanna show them off in the application"*. That raises the bar past
"dev harness": these will need to be responsive, work on mobile, and match the app's visual
language. The `ui/` kit and Tailwind get you most of that for free — which is exactly why
re-implementing the CSS would be the wrong move.
