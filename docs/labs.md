# The labs (`/labs`)

The five vectorizer harnesses. They used to be standalone HTML pages under `labs/`, each its
own Vite entry, with hand-rolled CSS and hand-rolled DOM. They are now **React routes inside
the app** — same corpora, same gates, same numbers, wearing the app's design system.

| Route | Component | Answers |
|---|---|---|
| `/labs/pipeline` | `PipelineLab` | *Why* does the trace look like this? Every intermediate stage. |
| `/labs/ab` | `AbLab` | Does this feature help? Trace variants side by side. |
| `/labs/golden` | `GoldenLab` | Did anything **change**? The regression gates and their headroom. |
| `/labs/truth` | `TruthLab` | Is it **correct**? Scored against the authored SVG. **231 cases, three tiers** — see below. |
| `/labs/eval` | `EvalLab` | What do the numbers say? ΔE / SSIM / seam / determinism scoreboard. |

Everything lives in `src/components/labs/`. `LAB_VIEWS` in `src/components/navItems.tsx` is the
one list the header popover, the mobile menu and the labs index all read.

## The shared kit

Built on the app's own primitives — `ZoomSurface` + `usePanZoom` (one camera **per row**: the
panels of a case pan/zoom in lockstep, rows are independent — a page-global camera meant
inspecting one junction flung every other case off-screen; pinch-zoom included), `ZoomControls`
(one compact pill per row header), Tailwind, the design tokens.

- **`LabPage`** — the shell: sticky toolbar, collapsible "about" that remembers whether you've
  read it, status line. It owns the page-wide **Dark bg** toggle (persisted per lab; panels read
  it via context — white-on-transparent art is invisible on the light checkerboard) and a
  fallback camera for panels rendered outside a `CaseRow`. The first panel mounted under a
  camera auto-claims itself as the box that camera's +/− buttons zoom around, so no lab threads
  a `primary` flag row by row.
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
3. **The labs rasterize SVG with the SAME engine as CI.** Both the labs and the Node runner now
   rasterize SVGs with **resvg** — the labs via `@resvg/resvg-wasm` (the WASM build of the exact
   Rust engine `@resvg/resvg-js` wraps), through the shared `resvgRaster.ts` helper (`labImageData`),
   with the same options the gate uses (`fitTo width`, `background: white` for the scored truth
   raster). Verified byte-identical (0 differing pixels across flat + gradient corpus cases), so
   "what you see is what CI measures" now holds at the *pixel* level, not just the module level.
   The WASM (~1 MB) is dynamically imported and initialized once, only when a lab first rasterizes
   an SVG, so it stays in the lazy lab chunk and never touches the product bundle (rule 4).
   *History worth keeping, because it is the trap:* the labs used to rasterize with the **browser
   canvas** (Blink's SVG renderer — a *different* engine), which drew onto **transparency** while
   resvg composited on **white**. Almost no corpus art carries a background rect, so the two were
   tracing *different pixels* — that moved the segmentation, not the last decimal: the lab reported
   `bloom` at **3/7** regions where the CLI said **5/7**, read as a real tracer defect for a whole
   session. A "harmless rasterizer difference" is the perfect hiding place for a real one; using
   one engine end-to-end removes the hiding place. (The remaining wobble is **PNG *decode*** —
   Chrome's canvas vs Node's decoder disagree by ±1 on a few partial-alpha pixels — which only
   affects the raster-fixture paths, `aurora-flat` in the Golden lab; see that lab's note.)
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
   `scoreRegions`, `rasterizeDoc` — plus the SVG rasterization in `labImageData` (resvg-wasm runs
   synchronously on the calling thread). Moving that off-thread is the next win if the labs ever
   feel sluggish again; it needs a new worker protocol, since the current one only returns a
   traced document.

## The A/B lab can compare against a frozen revision ("Vs snapshot")

The variants answer "does this FLAG help?" — same code, one option apart. They cannot answer
"did this CODE CHANGE help?", which is what a tracer fix needs judged. That is what
`pnpm gen:absnapshot` is for: it traces the A/B corpus with the current working tree and
freezes the output under `test/ab-snapshots/` (serialized SVG per case × gradients on/off, a
manifest recording the git rev — `+dirty` when the tracked tree had modifications). The lab's
**Vs snapshot** toggle then shows *source | snapshot | working tree* per case, one shared
camera, real vector rendering at any zoom.

The rule that makes the comparison trustworthy: **the snapshot stores the exact pixels it
traced** (a PNG per case — SVG cases rasterized once by resvg), and the view traces the live
code **from that stored PNG**, not from its own canvas rasterization of the SVG. One input
file, two code revisions — a visible delta is the code, never resvg-vs-canvas. (Residual
caveat: the browser's canvas PNG *decode* can differ from Node's by ±1 on a few
partial-alpha pixels — the aurora finding below — which is far below anything judged
visually.) The case list is owned by `src/devtest/abCorpus.ts`, imported by both the writer
and the view, per rule 1.

Typical flow: `git stash && pnpm gen:absnapshot && git stash pop` freezes the last committed
revision; the lab then shows exactly what the working tree changed. Re-bless (re-run the
command) once a change is accepted — same lifecycle as `gen:golden`.

## The Truth lab is paged, and tiered

`TRUTH_CORPUS` is now **231 cases**: 16 handcrafted (tier 0) + **109 Fluent Emoji "Color"**
gradient glyphs (tier 1, MIT — `docs/vectorization-benchmarks.md` §8) + the same glyphs'
**106 Flat variants** scored in their own right (tier 2 — §9; flat multi-region art is what
the product traces, and it is the tier where the zero-tolerance *regions recovered* gate
actually runs). At 1–3 s per case, a flat list would be a wall of spinners, so the page runs
**one page at a time**: pick a **Set** (tier 0 / tier 1 / tier 2 / *Gated* — what CI runs /
all) and a page size.

Row-level lazy tracing (trace when the row scrolls into view) was the obvious alternative and
is worse: it makes *scrolling* expensive and unpredictable, and you still pay for every row you
pass. A page bounds the work explicitly. `useLabRun` still yields between cases, so finished
rows paint as they land.

- **Per-tier tolerances.** Tier 0's limits (chamfer 1.0px / p95 2.5px) were calibrated on crisp
  flat art; only 31 of 109 gradient cases pass them. Tier 1 has **its own** (6.0px / 60.0px),
  measured on its population by `calibrateTier1.ts`; tier 2 likewise (3.0px / 35.0px,
  `calibrateTier2.ts`). Each row's badge says **which limit it was actually held to** — a green
  bar here can never mean "somebody quietly widened tier 0". Tier 1's and 2's are *"do not get
  worse"* numbers, not *"this is correct"* numbers.
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
