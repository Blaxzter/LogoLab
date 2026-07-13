# The labs (`/labs`)

The five vectorizer harnesses. They used to be standalone HTML pages under `labs/`, each its
own Vite entry, with hand-rolled CSS and hand-rolled DOM. They are now **React routes inside
the app** — same corpora, same gates, same numbers, wearing the app's design system.

| Route | Component | Answers |
|---|---|---|
| `/labs/pipeline` | `PipelineLab` | *Why* does the trace look like this? Every intermediate stage. |
| `/labs/ab` | `AbLab` | Does this feature help? Trace variants side by side. |
| `/labs/golden` | `GoldenLab` | Did anything **change**? The regression gates and their headroom. |
| `/labs/truth` | `TruthLab` | Is it **correct**? Scored against the authored SVG. **125 cases, two tiers** — see below. |
| `/labs/eval` | `EvalLab` | What do the numbers say? ΔE / SSIM / seam / determinism scoreboard. |

Everything lives in `src/components/labs/`. `LAB_VIEWS` in `src/components/navItems.tsx` is the
one list the header popover, the mobile menu and the labs index all read.

## The shared kit

Built on the app's own primitives — `ZoomSurface` + `usePanZoom` (one camera per page, shared by
every panel, with pinch-zoom the hand-rolled cameras never had), `ZoomControls`, Tailwind, the
design tokens.

- **`LabPage`** — the shell: sticky toolbar, collapsible "about" that remembers whether you've
  read it, status line. It owns the page camera and hands it to panels via context.
- **`Panel`** / **`CaseRow`** / **`Badge`** / **`NoteBox`** / **`PendingRow`** — a labelled
  zoomable box, a corpus row, and the boxes that carry caveats.
- **`GateTable`** — the headroom bars. Both scoring labs feed it the same row shape.
- **`useLabRun`** — runs the corpus **one case at a time**, yielding between cases so finished
  rows paint while the next one traces. Cancels in flight on re-run or unmount.
- **`useLabState`** — the localStorage-persisted view state (box size, toggles).
- **`heat` / `raster` / `wire`** — the colour ramp, the RGBA→dataURL encoder, and the
  nodes/edges wireframe, each of which used to exist two or three times over.

## Rules that are load-bearing

1. **Never reimplement scoring in a component.** The labs import their case lists, trace
   options, gates and metrics from the *same modules the Node CLI uses* — `truthCorpus.ts`,
   `traceCorpus.ts`, `geomScore.ts`, `scoreboard.ts`. That is the only reason "what you see is
   what CI measures" is true. A component that recomputes a metric locally will drift.
2. **`applicable: false` renders as `n/a`, never as a pass.** `bg-ramp` scores a *perfect* 0.00
   boundary error because it has no interior boundary; region recovery is meaningless on
   gradient art. A gate that silently passes because it had nothing to measure is worse than no
   gate. `GateTable`'s `na` tone exists for this.
3. **Keep the rasterizer caveat visible.** The browser rasterizes SVG with canvas; the Node
   runner uses resvg. Numbers can differ in the last decimal, and the UI says so.
   **But make sure "the last decimal" is actually true first.** It was not: resvg composited on
   **white** while the canvas drew onto **transparency**, and almost no corpus art carries a
   background rect of its own — so the two consumers were tracing *different pixels*. That moved
   the segmentation, not the last decimal: the lab reported `bloom` at **3/7** regions where the
   CLI said **5/7**, and the gap was read as a real tracer defect for a whole session.
   `TruthLab` now flattens onto white and both say 5/7. A "harmless rasterizer difference" is
   the perfect hiding place for a real one — when the two disagree, suspect the *input* before
   the tracer.
4. **Keep them lazy.** Every lab is a `React.lazy` route in `App.tsx`. They pull in the scoring
   modules and (Golden) several MB of corpus fixtures; none of that belongs in the bundle a
   visitor downloads to crop a logo. `pnpm build` should never show lab code in the `index`
   chunk.
5. **Never block the shell.** Two separate mechanisms, and you need both:
   - **`labTrace`**, not `traceImage` — it runs the trace in a worker (via `traceOffThread`),
     so the pipeline doesn't seize the main thread. Worker and main thread produce
     byte-identical documents (verified: same `hashDoc`); only potrace can't go off-thread
     (it needs DOMParser + WASM), and `labTrace` sends it back automatically.
   - **`useLabRun`** — yields between cases so finished rows paint. `await Promise.all(corpus)`
     freezes the tab regardless of workers, because the *scoring* is still on the main thread.

   **Still main-thread, and still stalls (~1–2 s per case):** the scoring — `scoreGeometry`,
   `scoreRegions`, `rasterizeDoc` — plus the canvas rasterization in `getImageData`. Moving
   that off-thread is the next win if the labs ever feel sluggish again; it needs a new worker
   protocol, since the current one only returns a traced document.

## The Truth lab is paged, and tiered

`TRUTH_CORPUS` is now **125 cases**: 16 handcrafted (tier 0) + **109 Fluent Emoji "Color"**
gradient glyphs (tier 1, MIT — `docs/vectorization-benchmarks.md` §8). At 1–3 s per case, a
flat list would be a five-minute wall of spinners, so the page runs **one page at a time**:
pick a **Set** (tier 0 / tier 1 / *Gated* — what CI runs / all) and a page size.

Row-level lazy tracing (trace when the row scrolls into view) was the obvious alternative and
is worse: it makes *scrolling* expensive and unpredictable, and you still pay for every row you
pass. A page bounds the work explicitly. `useLabRun` still yields between cases, so finished
rows paint as they land.

- **Per-tier tolerances.** Tier 0's limits (chamfer 1.0px / p95 2.5px) were calibrated on crisp
  flat art; only 31 of 109 gradient cases pass them. Tier 1 has **its own** (6.0px / 60.0px),
  and each row's badge says **which limit it was actually held to** — a green bar here can
  never mean "somebody quietly widened tier 0". Tier 1's are *"do not get worse"* numbers, not
  *"this is correct"* numbers.
- **`flat A/B`** traces the same glyph's **Flat** twin and shows the delta. It is the point of
  tier 1: the tracer invents **10.8×** more boundary on gradient art than on flat art while
  missing only 1.4× more — it finds the art, then hallucinates edges inside the gradient.
- **The gate.** `test/truth-gate.test.ts` runs the *Gated* set (tier 0 + 10 tier-1) at **512px**
  — the limits are pixels, and pixel error scales with the raster, so the resolution is pinned.
  It carries an explicit `KNOWN_DEFECTS` list rather than tolerances loose enough to hide
  today's failures; a case not on the list must pass, a case on it must still fail. It blesses a
  boolean, never a number, so the tracer can still improve without re-blessing anything.

## Two findings the labs surfaced about themselves

**Panels take the shape of the art, not a square** (`Panel`'s `aspect` prop). A raster `<img>`
stretched into a square box is *distorted*, while a trace `<svg viewBox>` letterboxes itself
(`preserveAspectRatio` defaults to `meet`) — so on non-square art (`headphones-flat` is
582×1024) the source and the trace were drawn at two different scales, side by side, and could
not be compared. Pass `aspect` on every panel.

**`aurora-flat` is the one golden case whose live numbers don't reproduce the blessed record,
and the golden is NOT stale.** Verified: Node scores it at exactly the blessed values
(meanΔE 1.904, hash `55d99265`); the browser gets 1.926 / `c69503b9`. The cause is the decode:
Chrome's canvas and our own PNG decoder disagree on **11 pixels out of 262,144, by ±1 in one
colour channel**, all of them partial-alpha (antialiased) edge pixels. That is normally
harmless — `bloom-flat` is 37% partial-alpha and reproduces exactly — but aurora is a
*posterized* ramp, so an off-by-one straddles a band threshold, flips the segmentation, and
moves the geometry. It is a genuine browser-vs-Node difference, the drift banner is right to
call it out, and re-blessing the baseline would only break CI.

## Working in production, not just dev

The Golden lab's baseline (`test/golden/trace-baseline.json`) and its fixtures
(`examples/test-files/`, `test/fixtures/`) live outside `public/`. The dev server happened to
serve them, so nobody noticed that a deployed build 404s on all of it. They are now **imported**
(`?raw` for the baseline, `import.meta.glob(..., '?url')` for the fixtures), so Vite emits them
and the lab works deployed — inside the lazy chunk, so only a visitor who opens it pays.

The Truth corpus is all under `public/`, so it was already fine.
