# The labs (`/labs`)

The vectorizer harnesses. They used to be standalone HTML pages under `labs/`, each its own Vite
entry, with hand-rolled CSS and hand-rolled DOM. They are now **React routes inside the app** —
same corpora, same gates, same numbers, wearing the app's design system.

| Route | Component | Answers |
|---|---|---|
| `/labs/pipeline` | `PipelineLab` | *Why* does the trace look like this? Every intermediate stage. |
| `/labs/ab` | `AbLab` | Does this feature help? Trace variants (or revisions) side by side. |
| `/labs/workbench` | `workbench/Workbench` | Is it **correct**? Scored against the authored SVG. Pick the corpus. |
| `/labs/gallery` | `GalleryLab` | How does the tracer render art it can't be scored on? |
| `/labs/scoreboard` | `EngineLab` | potrace vs crisp: ΔE / SSIM / seam / determinism. |

Everything lives in `src/components/labs/`. `LAB_VIEWS` in `src/components/navItems.tsx` is the
one list the header popover, the mobile menu and the labs index all read.

## ONE LAB, ONE QUESTION — and the corpus × lens mistake

`golden`, `truth`, `eval` and `logos` were four near-duplicate labs. They were first folded into a
**corpus × lens matrix**, and that was worse: the available *lenses* changed when you switched
*corpus*, so the view's meaning changed under you and the gating ("never offer a lens that can't
run") read as arbitrary. Two dropdowns, four different tools hiding behind them.

The rule now: **a lab asks one question and never changes shape.** The Workbench
(`src/components/labs/workbench/`) asks *"is the trace correct against the art that made the
pixels?"* — of every case, in every corpus, with the same panels and the same numbers. The
**Corpus** selector means exactly one thing: *which images*.

Anything that can't be asked of every corpus is its own lab instead:

- **Raster-only art** (the golden fixtures, the eval PNGs) has no authored vector to score against,
  so it isn't in the Workbench at all. Those exact images are already in **Feature A/B**, which is
  where you compare them across revisions.
- **potrace vs crisp** scores the render against *source pixels*, not authored geometry — a
  different question → **Engine scoreboard**. It's also the only place potrace is measured (it needs
  a browser: WASM + DOMParser, so `node --test` can only score crisp).
- **Unscorable brand art** → **Gallery** (rasterize, flat-trace, look).

### The Workbench corpora

The tier sets are corpus entries in their own right (different art, different calibrated limits) —
listed flat, rather than as a "Set" sub-selector beside a "Corpus" one, which was two dropdowns for
one idea. `CorpusSource` (`corpora.tsx`) only PRODUCES cases and has **no options**; paging is the
view's job.

| Corpus | What |
|---|---|
| Tier 0 — handcrafted | The 16 cases, each isolating a named failure mode. Strictest limits. |
| Tier 1 — Fluent gradients | 109 Fluent Emoji "Color" glyphs (MIT). Carries the flat twins → `flat A/B`. |
| Tier 2 — Fluent flat twins | The same glyphs authored flat; where `regions recovered` actually runs. |
| Gated — what CI runs | Exactly what `test/truth-gate.test.ts` enforces. |
| All tiers | 231 cases. Page through it. |
| Logo corpus (scorable) | The brand marks `svgGround` can actually read — see below. |

**`tier` is optional, and that's load-bearing.** A tier is a *measured population*
(`calibrateTier1.ts` / `calibrateTier2.ts`). A case outside every one of them — a brand logo — has
**no gates**: it gets the geometry numbers and no bars. Borrowing tier 0's limits would print a
verdict nobody measured. `analysis.tsx` renders the gate table only when `c.tier !== undefined`.

**The Logo corpus is filtered to its scorable subset.** A brand mark is ground truth only if its
*visible* boundary is the boundary its path data describes; strokes, filters, clips, masks and
patterns all break that, and `svgGround.unscorable()` refuses them (the same triage
`vendorFluentEmoji.ts` runs — 109 of 1595 survived it). The subset that passes is scored in the
Workbench; **all** of them are viewable in the Gallery. It keeps its dev-only semantics —
git-ignored `examples/logos/*.svg` via `import.meta.glob`, **absent (empty-state, no 404) in a
clean/CI/production build**, `npm run fetch:logos` rehydrates — surfaced as `available: false`.

### There is no Golden view any more

The regression baseline was never a standard of *correctness* — it's a snapshot of the tracer's own
past output, and its ±12% count bands actively forbid improvement. The **gate is untouched and still
runs** (`test/trace-regression.test.ts` + `test/golden/trace-baseline.json` + `npm run gen:golden`);
it just has no page, because Feature A/B already shows those exact fixtures. `/labs/golden`
redirects there. (`goldenAnalysis.ts`, the lab-only helper that drew its ΔE/seam maps, went with
it — git remembers.)

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
- **`useLabSearch`** — the corpus search box every lab wears (rendered by `LabPage`, so it sits
  in the same place and answers to the same `/` everywhere). It filters the **case list**, not
  the finished rows: the Workbench's "All tiers" is 231 cases over 8 pages and Feature A/B costs
  seven traces a case, so hiding rows after the fact would still make you page to the case and
  still pay for tracing the rest. Filtering the corpus means only the matches are ever traced,
  and the paged labs jump back to page 1 so the match you named is in front of you. The query
  **settles** (~220 ms) before it bites — `useLabRun` re-runs on every deps change, so a
  per-keystroke value would cancel and restart the run five times a word — and it is deliberately
  **not** persisted, unlike everything else in `useLabState`: reopening a lab to a corpus
  mysteriously cut to three cases by last week's search is a bug report, not a convenience. It
  does live in the URL as **`?q=`** — not state that follows you around, a link that says what to
  look at — seeded once on mount and republished on each settle.
- **`corpusIndex`** — **where a case lives**, across every lab. Each lab's search covers its own
  corpus, the corpora do not overlap, and so "No case matches “olympic”" is regularly a true
  statement answering the wrong question: it reads as *we don't have it* when the truth is *not
  on this page*. The index knows all nine searchable corpora (the Workbench's six, the Gallery,
  A/B's two lanes), so a lab can add "…also in **Gallery 1**" beside its counter and put the same
  list in its empty state, each entry a link carrying `?q=` (and `?corpus=` / `?lane=`) so
  following it lands on the match. Every entry derives its names from the module the lab itself
  renders from, so a corpus cannot drift out from under it. `olympic-rings` is the worked example:
  stroked, so `svgGround` refuses it and the Workbench's scorable logo corpus rightly excludes it
  — it exists only in the Gallery and the A/B gallery lane, and now the Workbench says so.
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
   synchronously on the calling thread). Moving that off-thread is the next win *for a run*; it
   needs a new worker protocol, since the current one only returns a traced document.
6. **A lab page is expensive to RE-RENDER, not just to compute — and that is a different bug.**
   The Workbench draws ~50 panels of generated SVG, several of them heat maps of thousands of
   `<rect>`s. Typing one character in the search box cost **over a second**, and none of it was
   tracing or scoring: it was `set innerHTML`, re-parsing every panel. Two rules keep it honest,
   both measured (1200 ms → ~12 ms per keystroke with 25 rows on screen):
   - **Memoize the `{ __html }` OBJECT, not just the string** (`RawArt`). React's DOM update
     compares props by *reference*, and `dangerouslySetInnerHTML` is the one prop whose value is
     an object — a fresh `{ __html: sameString }` each render reads as a change and re-parses the
     fragment. Holding the object's identity makes React skip the write.
   - **Hand `LabPage` the rendered rows as memoized ELEMENTS**, keyed on the little view state a
     row actually reads (the Workbench: `run.results` + `ui.heat`). Stable element identity lets
     React bail out of those subtrees entirely, so a keystroke, the box slider and the wireframe
     toggle cost nothing. This is also why `useLabState`'s patch returns the *same* object when
     nothing changed — every paged lab fires `setUi({ page: 0 })` on each keystroke, and page 0
     is where you already were.

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

**Two stamps of one change are a PAIR, and the lab diffs them directly.** The workflow above
tends to produce two — `before-x` to freeze the baseline, `after-x` to record the accepted
result — and for a long time only the first was usable: the view could compare a stamp against
the *working tree* and nothing else, so the `after-` half sat inert on disk and the comparison
decayed the moment anyone kept editing. **Compare with** (the second dropdown) fixes that: point
it at another snapshot instead of the working tree and both panels are frozen output, diffed
against each other. Nothing is traced, so it is fast, it does not decay, and it is the only way
to compare two revisions when *neither* is checked out. Such a set appears in the **Baseline**
dropdown under **⇄ Pairs** as one entry that selects both sides — detected from the
`before-`/`after-` naming (`conventionalPartner` in abCorpus.ts, pinned by
`test/ab-snapshot-pair.test.ts`), or recorded explicitly with
`pnpm gen:absnapshot after-x --pair before-x` when the names don't follow it.

That mode needs one guard the working-tree mode doesn't. Two stamps taken far apart may have
traced **different pixels** for the same case — a fixture SVG was edited, `AB_SNAPSHOT_RES`
changed — and diffing their traces would then report an *art* change as a *code* change, which
is precisely the confounded measurement this lab exists to prevent. So both stored input PNGs
are compared byte-for-byte; a mismatch marks the row **input differs** and drops it from the
changed/unchanged counts instead of answering wrongly.

**Two lanes: fixtures and gallery.** The ⟐ handcrafted cases isolate one mechanism each,
which is what makes them good gates and weak evidence — they go green long before real art
looks right, and every user-reported defect so far arrived on a brand mark, not on a fixture.
So the corpus also carries a curated slice of the same logos `/labs/gallery` shows (◆ rows),
rasterized **on white** exactly as that page does, so what you judge here is what you saw
there. Those SVGs are the private, gitignored corpus (`npm run fetch:logos`): the writer skips
the ones that aren't on disk and the view drops them, so a clone that never fetched them still
runs the fixture lane. **Cases** in the lab switches lane (the gallery doubles the corpus, and
in variants mode every case costs one trace per variant); `AB_LOGOS` in `src/devtest/abCorpus.ts`
is the list, and `pnpm gen:absnapshot <name> --logos all|a,b|none` overrides it for one run.

**Stamps are not committed.** `test/ab-snapshots/` is gitignored (its README explains the
lifecycle): a stamp is a local working artifact — regenerable from any revision, and what you
freeze depends on what you are about to change — and the gallery lane's inputs are trademarked
art. Two diagnostics (`rimCapDiag.ts`, `rimCapRender.ts`) read one stamp by name and say which
command to run when it isn't there.

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
