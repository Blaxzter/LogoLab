# Planar subdivision tracer

Status: **Phases 1–6 shipped** on branch `feat/planar-tracer` (default engine for
color). This doc records what the work does and what's left, with enough detail
to execute the rest.

---

## 1. Why this exists

The crisp/potrace engines trace **each color region independently** and stack the
results as **overlapping masks** (the bottom layer is a full-bleed silhouette,
every smaller region paints on top). Because each region's boundary is simplified
and beautified in isolation, the boundary shared by two regions is **two different
curves**. Where they don't coincide, the lower stacked layers peek through as a
**3–4 colour hairline** — the user's reported defect.

Removing the overlap naively (pure abutting tiles) measured *worse*: the shield's
`seamMax` hit **99**, nebula **40**, and node counts rose (each region must cut
holes for the shapes inside it). The overlap was load-bearing.

**The fix — planar subdivision:** trace the segmentation label map as a shared-edge
graph. Every boundary between two regions is fitted **once** and referenced by both
adjacent regions (forward in one, reversed in the other). Coincident geometry ⇒ no
overlap, no seam, and the boundary is a single jointly-editable curve.

---

## 2. What was done in this work

### 2a. Two segmentation/stacking fixes (also on this branch, in `index.ts`/`segment.ts`)

- **Gradients-off posterization** ([segment.ts](../src/lib/trace/segment.ts) `mergeGradients`,
  threaded from `options.gradients` via `segmentOptionsFor` in
  [index.ts](../src/lib/trace/index.ts)). Previously, turning gradients off
  flattened each macro-region to its **mean** colour — so a red→orange→yellow rim
  collapsed to one muddy brown (`#8f6105`). The segmenter merges colour ramps into
  one region regardless of the toggle; now, with gradients off, Step-3c's gradient
  union-fit is skipped so ramps **posterize into flat bands** (shield: 4 muddy
  regions → 17 clean flats, each ΔE span ~2–4). Gradients-on corpus byte-identical.

- **Connected-flood stacked mask** ([index.ts](../src/lib/trace/index.ts) `stackedMask`).
  The cumulative "rank ≥ layer" mask pulled in **spatially-disjoint** higher
  regions, re-tracing them as hidden islands in every layer below (the "circle on
  every path" the user saw in the node editor). Now the mask floods only from the
  layer's own region through **connected** higher-rank pixels, so disjoint shapes
  are dropped. Render-identical (a rank-k pixel is still topped by layer k), corpus
  hashes unchanged. *(This only affects the crisp engine; planar supersedes it.)*

### 2b. The planar tracer (Phases 1–4)

**Architecture — graph is source of truth, `subPaths` is a derived cache.** This is
what keeps the blast radius small: every *read* consumer of `PathItem.subPaths`
(renderer, `serializeDoc`, Paths panel, metrics) is unchanged. Only the editor
(Phase 5) needs to learn the graph.

Types on `EditableDoc` ([types.ts](../src/lib/path/types.ts)):
- `Vertex {id,x,y}` — a junction (≥3 regions meet); the single owner of its position.
- `SharedEdge {id, nodes: PathNode[], closed, startVertex, endVertex}` — one fitted
  boundary curve, canonical direction start→end.
- `EdgeRef {edge, reversed}`; a region's boundary is `loops: EdgeRef[][]` (outer + holes).
- `Topology {vertices, edges}` on `EditableDoc.topology`; `PathItem.loops?` marks a
  topological region (absent ⇒ legacy independent path, e.g. an imported SVG).

| File | Phase | Responsibility |
|---|---|---|
| [planarNetwork.ts](../src/lib/trace/planarNetwork.ts) | 1 | Pixel-corner lattice "crack" network → **junctions** (`crackDegree≥3`, which also resolves the checkerboard/saddle deterministically) → **edges** carrying the ordered label pair on each side. Pass A walks junction-anchored chains; Pass B closes pure loops (a disc inside a field). Transparent + out-of-bounds collapse to one exterior label `EXT`. |
| [planarFit.ts](../src/lib/trace/planarFit.ts) | 2 | Per-edge curve fit. Pre-smooth the unit staircase (Chaikin, endpoints pinned) to replace the coverage-field blur, then an **open-arc multi-cubic fit**: open RDP → one-sided endpoint tangents → evidence-based corner score → over-complete candidates via the reused `fitSingleCubic` → an **open** linear DP → materialize. Junction endpoints forced `corner` so adjacent edges share an exact anchor. Pure-loop edges reuse `fitClosedLoop`. |
| [planarAssemble.ts](../src/lib/trace/planarAssemble.ts) | 3 | Build half-edges (`+id` left-of-canonical, `−id` right), walk faces at junctions via the lattice rotational system (next = clockwise from the reverse of arrival), classify outer vs hole and **orient for nonzero** — orientation is baked into the EdgeRef loops (reverse order + toggle `reversed`) so `materializeRegion` stays a pure forward concat and the editor can map node→edge. `tracePlanar(labels,w,h,opts)` is the entry. |
| [topology.ts](../src/lib/path/topology.ts) | — | `materializeRegion(loops, edges)` (forward-concat shared edges, dedup junction anchors, close) and `materializeDoc`/`rematerializeRegions`. `reverseEdgeNodes` is a pure reindex+handle-swap ⇒ the two regions on an edge are byte-coincident. |

**Integration** ([index.ts](../src/lib/trace/index.ts)): `engine === 'planar'` branch
runs `tracePlanar`, reuses the per-region paint ladder (`fitPaintLadder`/`applyPaint`)
unchanged, emits topological `PathItem`s (`loops` + materialized `subPaths`) bottom-up,
and **skips loop-`beautify`** (it moves loops independently and would desync shared
edges). Planar is the **default for color** (`DEFAULT_VECTORIZE_OPTIONS.engine`),
selectable in [TraceControls.tsx](../src/components/vectorize/TraceControls.tsx), and
runs **off-thread** (`canTraceOffThread` now allows any non-potrace engine). Mono mode
falls back to the crisp mask tracer.

**Validation:** [test/planar.test.ts](../test/planar.test.ts) — per-pixel relabel
integrity on synthetic maps (quadrants, island/hole), determinism, and exact
shared-edge coincidence. Full suite 152 pass. Headless metrics vs crisp: petals
`seamMax` 5.7→**3.0**, shield `seamP995` 65.7→**53.7**, nebula visually identical
(meanΔE 2.95→3.01), node counts higher (real holes). `src/devtest/planarScore.ts`
is the scoring helper.

### 2c. Unrelated: gradient-import WIP → `main`

The pre-existing SVG gradient-import feature (`gradientImport.ts`, `model.ts`,
`geometry.ts`, `PathsPanel.tsx`) was committed **to `main`** (commit `5f77b60`),
separate from this branch.

---

## 3. Known limitations (current planar output)

**Tracer defects are tracked in ONE place: `docs/vectorization-benchmarks.md` §0** — a
ranked list where every entry names the corpus case that reproduces it, with
`KNOWN_DEFECTS` in `test/truth-gate.test.ts` as the machine-checked status. (This section
used to carry its own list; it rotted — three of its four entries were long fixed.)

What belongs here instead — planar-specific limitations that are not corpus defects:

1. **Editor gap:** double-clicking the *closing* segment of a pure closed-loop disc edge
   is a no-op (`resolveEdgeSegment` rejects it) — insert elsewhere on the loop.
2. **Sub-pixel edge placement** on smooth high-contrast boundaries is slightly behind
   crisp (planar fits the integer crack staircase, not the AA coverage field) — visible
   only as a marginally higher seam metric on gradient images like nebula (§0 #8).
3. **Experimental flags stay OFF by default — measured, not forgotten** (benchmarks §9.3):
   `refineJunctions` (tradeoff: 10 better / 14 worse on the flat corpus),
   `backgroundGradient` (0 wins on ground truth where it applies). Planned: expose them as
   opt-in feature flags in the /vectorize studio rather than merging as defaults.
   (`weldJunctions` was REMOVED 2026-07-21 — re-measured, the blanket weld newly crossed
   two tier-2 gates and degraded bloom/overlap by preempting the §10.4 junction re-seat;
   see 1e below. `junctionReseat` — the §10.4 re-seat + evidence-gated converged-pair
   weld — ships ON, flag exists only as the A/B baseline switch.)

---

## 4. Phase 5 — shared-edge joint editing (SHIPPED)

**Goal:** dragging an interior node on a shared boundary moves the one edge → **both**
regions follow; dragging a junction moves **every** incident edge.

**What shipped** (the plan below was followed; key landing points):
- [topology.ts](../src/lib/path/topology.ts): `NodeProvenance`/`HandleSite`,
  `materializeRegionWithProvenance`, and `regionProvenance`. `materializeRegion`
  was refactored to delegate to a single shared `materializeLoop` walk so the
  derived `subPaths` and the provenance map can never drift. Provenance bridges a
  materialized `NodeRef{sub,idx}` back to the graph: a junction anchor → `vertexId`;
  an interior node → `edgeId`+`edgeNodeIdx` (canonical, with the reversed in/out swap
  baked into `inHandle`/`outHandle`).
- [topologyEdit.ts](../src/lib/path/topologyEdit.ts) (new): `moveEdgeNode`,
  `moveVertex` (updates the `Vertex` + every incident edge endpoint), `moveEdgeHandle`,
  `insertNodeOnEdge`, `setEdgeNodeKind`, `deleteEdgeNode` (guards <2 nodes & open-edge
  junction endpoints), `translateRegion`, plus provenance routers
  `translateRegionNodes`/`deleteRegionNodes` and `resolveEdgeSegment`. Each op mutates
  `doc.topology` immutably then `rematerializeRegions` only the touched regions, so both
  adjacent regions stay byte-coincident. Pure cubic/tangent/mirror math is shared with
  [geometry.ts](../src/lib/path/geometry.ts) (`splitSegmentAt`/`setNodeKindNode`/
  `moveHandleNode`/`translateNode`) so the open-edge ops and the closed-subpath editor
  cannot diverge.
- [EditorCanvas.tsx](../src/components/vectorize/EditorCanvas.tsx) /
  [VectorizeStudio.tsx](../src/components/vectorize/VectorizeStudio.tsx): drags,
  double-click insert/kind-toggle, arrow-nudge and Delete route through the topology ops
  when `item.loops` is present; items **without** `loops` keep the exact old per-item
  `geometry.ts` + `withItem` path byte-for-byte. Live preview, undo/redo (whole-doc
  snapshots incl. `topology`), serialize/export, and the rasterizer are unchanged.
- [test/planar-edit.test.ts](../test/planar-edit.test.ts) (new): a hand-built
  2-region shared-edge doc + real `tracePlanar` topology (degree-4 centre junction,
  island hole edge). Adversarial coincidence (stored `subPaths` must equal a fresh
  materialization — fails if a neighbour is left un-rematerialized), both-regions-change,
  insert/delete/vertex/handle, chained multi-node drag, and determinism. Full suite
  **167 pass**, typecheck clean.

**Original plan (followed):**

**Current gap:** [EditorCanvas.tsx](../src/components/vectorize/EditorCanvas.tsx) edits
each `PathItem` via [geometry.ts](../src/lib/path/geometry.ts) (`moveNodes`,
`moveHandle`, `insertNode`, `setNodeKind`) keyed by `NodeRef{sub,idx}` into that one
item's `subPaths`, and commits via `withItem`. It has **no concept of `doc.topology`**,
so edits hit the derived cache only and the neighbour's edge (a separate `PathItem`)
is untouched → desync.

**Plan:**

1. **Provenance from materialization.** Add `materializeRegionWithProvenance(loops,
   edges)` to [topology.ts](../src/lib/path/topology.ts) returning the `SubPath[]`
   plus, per materialized node, `{edgeId, edgeNodeIdx, vertexId|null, reversed}`.
   (A junction anchor maps to a `vertexId`; an interior edge node maps to
   `edgeId+edgeNodeIdx`.) This is the bridge from an editor `NodeRef` back to the graph.

2. **Edge-aware edit ops** in a new section of [topology.ts](../src/lib/path/topology.ts)
   (or `topologyEdit.ts`): each mutates `doc.topology` then calls `rematerializeRegions`
   for the affected edges:
   - `moveEdgeNode(doc, edgeId, nodeIdx, dx, dy)` — interior edge node.
   - `moveVertex(doc, vertexId, dx, dy)` — moves the vertex **and** the endpoint node
     of every incident edge (so the junction stays welded).
   - `moveEdgeHandle(doc, edgeId, nodeIdx, which, to, mirror)`.
   - `insertNodeOnEdge(doc, edgeId, segIdx, t)` — de Casteljau split inside the edge;
     both regions gain the node.
   - `setEdgeNodeKind(doc, edgeId, nodeIdx, kind)`.
   - `deleteEdgeNode` (guard against degenerating an edge below 2 nodes).
   Reuse the math already in [geometry.ts](../src/lib/path/geometry.ts) (de Casteljau
   split, handle mirroring) on the edge's `nodes` array.

3. **Editor rewiring** ([EditorCanvas.tsx](../src/components/vectorize/EditorCanvas.tsx)):
   hit-testing can stay on the materialized `subPaths`, but on commit, if the selected
   item has `loops`, translate the geometry op into the corresponding `topology.ts`
   op via the provenance map, producing a new doc with the affected regions
   re-materialized. A `withTopology(doc, nextTopology)` helper replaces `withItem` for
   topological items. Junction hits (provenance `vertexId`) drag all incident edges;
   interior hits drag the one edge. **Legacy items (no `loops`) keep the existing
   per-item ops** — both models coexist.

4. **No change needed** to history ([useHistory.ts](../src/hooks/useHistory.ts) snapshots
   the whole doc incl. `topology`), to serialize/export (materialized `subPaths`), or to
   the rasterizer. SVG **import** produces legacy independent paths (no shared edges) —
   re-deriving a planar graph from arbitrary imported SVG is out of scope.

5. **Verification:** a headless test that mutates one edge and asserts both adjacent
   regions' materialized `subPaths` updated and remain coincident; plus in-app: drag an
   interior shared node (neighbour follows), drag a junction (all spokes follow),
   insert/delete on a shared edge, undo/redo.

6. **Then flip nothing** — planar is already the default; this just makes editing it
   coherent. (Optionally surface "shared edge" affordance in the UI.)

---

## 5. Phase 6 — edge-level beautify (SHIPPED)

**Goal:** restore the circle/ellipse/line snapping that planar v1 dropped. The
loop-level [beautify.ts](../src/lib/trace/beautify.ts) moves each loop's vertices
independently, which would desync the byte-coincident geometry two regions share
on a boundary — so it stays SKIPPED for planar. Snapping at the **edge** level is
*easier* because a boundary is ONE shared edge by construction: snap the canonical
`SharedEdge.nodes` once and **both** adjacent regions re-materialize from it,
coincident, with zero desync risk.

**What shipped:**

- **[circleFit.ts](../src/lib/trace/circleFit.ts) (new).** The pure primitive-fit
  math beautify.ts had kept private — `fitCircle`/`maxRadialDev`,
  `fitEllipse`/`maxEllipseDev`, the kappa-Bézier emit (`makeCircleSubPath`/
  `makeEllipseSubPath`), `flatten`, `anchorSignedArea`, single-linkage `clusterBy`,
  and the concentric / equal-radius `relationSolveCircles` — was **lifted here
  verbatim** so both beautifiers share ONE copy (no fork). `relationSolveCircles`
  is the generic core: it mutates each circle's `cx/cy/r` in place (gating every
  adjustment against that circle's RAW trace) and returns which moved, so each
  caller regenerates only its own geometry. beautify.ts now imports these; its
  `relationSolve` is a thin wrapper. The crisp/potrace corpus is **byte-identical**
  (verified by hashing crisp output on nebula/petals before and after the move).

- **[planarBeautify.ts](../src/lib/trace/planarBeautify.ts) (new).**
  `planarBeautify(topo, loopsByLabel, opts)` returns a new `Topology` (vertices
  unchanged); `fidelity ≤ 0` returns the input topology unchanged (pure no-op):
  - **1a — disc edges → circle / ellipse.** Each CLOSED edge is flattened, fit
    with `fitCircle`/`fitEllipse`, and (if `maxRadialDev`/`maxEllipseDev ≤ fidelity`
    and the radius clears `2·fidelity`) replaced by the 4-node kappa primitive,
    **oriented to the edge's existing winding** so the `EdgeRef.reversed` flags the
    assembler baked for BOTH regions stay valid.
  - **1b — open edges → straight line.** An OPEN edge whose flattened arc lies
    within `fidelity` of the chord between its two endpoints is replaced by exactly
    two corner nodes at the **unchanged junction endpoints** (pinned byte-exact,
    handles dropped) — so every other edge meeting at those junctions stays welded.
  - **1c — relation solver** over the disc circles from 1a
    (`relationSolveCircles`), each adjustment re-gated against the circle's raw arc.
  - Wired into the `engine==='planar'` branch of [index.ts](../src/lib/trace/index.ts):
    runs after `tracePlanar`, before the per-region `materializeRegion` loop, and
    its beautified edges become the doc's `topology`. Phase-5 editing then operates
    on the already-beautified graph (a drag on a snapped circle still moves both
    regions — covered by [test/planar-beautify.test.ts](../test/planar-beautify.test.ts)).

- **Validation.** [test/planar-beautify.test.ts](../test/planar-beautify.test.ts):
  disc→4-node circle with both regions byte-coincident (adversarial: reverse of one
  region's run equals the other's), open-edge→2 pinned nodes with a curved neighbour
  untouched, concentric relation solve, `fidelity=0` no-op, determinism, and a
  Phase-5 drag on the beautified edge. Full suite **173 pass**, typecheck clean.

- **Measured** ([planarBeautifyScore.ts](../src/devtest/planarBeautifyScore.ts),
  planar at fidelity 0 vs 1.5): on geometric shapes the win is **regularity +
  fidelity**, not node count. The planar fitter is already node-economical (it fits
  a disc to a 2-cubic closed loop), so snapping to the canonical 4-node kappa circle
  costs ~+2 nodes/circle but yields a *perfect* primitive the relation solver can
  reconcile, and **lowers** error: geom (disc+ring+square) meanΔE 1.49→**1.40**,
  SSIM 0.932→**0.938**; nebula meanΔE 3.01→**2.99**, SSIM 0.9769→**0.9780**; seamMax
  unchanged on all; petals untouched (no primitives). Nodes: geom 34→38, nebula
  74→80, petals 38→38. Deterministic throughout.

**1d — co-circular open-arc loop snap (SHIPPED).** The high-value case the deferred
stretch was aimed at: a RING (a white outline / annulus) that sits over colour bands.
Every band boundary that meets the ring is a degree-≥3 junction, so the ring is split
into open arcs, each fitted independently with FORCED-CORNER endpoints and no shared
tangent — so the two arcs meet at an unconstrained angle on the integer lattice
corner. That is the user-reported **"pull"/kink where the bands meet the ring**
(measured ~26–44° of kink at each junction on a synthetic ring; a per-junction
tangent/sub-pixel fix can't tell that apart from a genuine flat-art corner, so it
either misses the ring or distorts flat art — both were tried and measured worse).

The fix keys on **co-circularity**, which uniquely identifies a ring:
`snapCoCircularLoops` in [planarBeautify.ts](../src/lib/trace/planarBeautify.ts) fits
ONE circle to each region loop that has ≥1 open edge (a ring's outer/inner boundary is
a full circle split into arcs). Gated exactly like the disc snap 1a (`fitCircle` +
`maxRadialDev ≤ fidelity`, radius > 2·fidelity). For each circular loop it:
1. **radial-snaps the loop's junction vertices onto the circle**, moving every incident
   edge endpoint with the vertex — the ring arcs AND the T-ing spokes — so the graph
   stays welded and the two regions on each edge stay byte-coincident; then
2. **re-emits each arc as a circular slice** (`arcSlice` in
   [circleFit.ts](../src/lib/trace/circleFit.ts): a ≤90°-split kappa-Bézier partial arc
   pinned byte-exact at the two junctions). Because both arcs at a junction carry the
   circle's tangent there, they join **G¹** — the kink is gone by construction.

Runs first (on the raw fitted arcs); its edges skip the per-edge 1a/1b passes.
Measured on a synthetic ring split by N bands: **kink 26–44° → 0–4°**, max radial dev
**~1.2px → ~0.7–0.9px**, and fewer nodes. Corpus: nebula/schild byte-identical (no
circular loops), **petals improves** (round petals snap to circles: seam 2.4→2.1, SSIM
+0.0001, nodes 38→32), headphones ear-cups snap cleanly (within tolerance). Validated
by [test/planar-arc-snap.test.ts](../test/planar-arc-snap.test.ts) (kink collapse,
byte-coincidence, welded junctions, determinism, `fidelity=0` no-op). `fidelity=0`
stays a pure no-op, so this rides the existing fidelity dial (on by default at 1.5px).

*Straight X-crossings.* A pinwheel's wedge crossings are straight LINES meeting at a
point (no co-circularity), so 1d does not touch them; the line snap (1b) straightens
each arm but the crossing point stays lattice-snapped. Since §10.4 the junction
RE-SEAT (1e) recovers exactly the crossings whose junctions demonstrably slid — the
rest stay lattice-snapped by design (sub-pixel nudging of ALL junctions measured
worse, `refineJunctions`). H/V axis-snapping is still intentionally NOT done (it
would move junction endpoints and unweld the graph).

**1e — junction re-seat + converged-pair weld (SHIPPED ON, benchmarks §10.4;
`planarFit.junctionReseat: false` = the pre-§10.4 baseline).** *Why a crossing is
never one point:* in a single shared-edge tiling a boundary must terminate at a
vertex wherever ≥3 regions meet, and a vertex is any lattice corner with crack
degree ≥ 3 ([planarNetwork.ts](../src/lib/trace/planarNetwork.ts) `isJunction`). A
rasterized degree-4 crossing almost never lands all four wedge tips on ONE corner —
AA + posterization split it into 2+ near-coincident degree-3 corners joined by
1–3px micro-edges; worse, at a NEAR-TANGENT crossing the label-map junction SLIDES
several px along the shared tangent (the colour needle there is
quantization-invisible), so the fitted boundary bends off its own primitive to
reach the pinned vertex (gradient-flat's "line pulled into the circle").

Two-step fix ([planarReseat.ts](../src/lib/trace/planarReseat.ts)): (1) RE-SEAT — a
planarBeautify pre-pass moves a degree-3 junction onto the intersection of its two
strongest incident FITTED primitives (line/circle arms from the fitted segments;
mangled short caps skipped) when the vertex lies near both yet their intersection is
≥1.5px away; terminal caps are repaired from the primitives, and an edge re-seated
against the SAME line at both ends re-emits as the straight occluder CHORD (1d is
vetoed off its loop — a "D" is not a disc). (2) WELD — junction pairs the re-seat
CONVERGED (micro-edge ≤2px, ≥1 endpoint moved) fuse into one degree-4 vertex via
`weldJunctionClusters` ([planarWeld.ts](../src/lib/trace/planarWeld.ts)): centroid
fuse, incident edges re-anchored byte-coincident, micro-edge excised from every
loop. The EVIDENCE gate is the whole point — the old blanket form (contract every
≤3px micro-edge, `weldJunctions`, off by default) was re-measured 2026-07-21 and
REMOVED: bare shortness sometimes marks a real thin feature (beverage-box, §9.3),
and running before the re-seat its blind centroids preempted the exact correction
that now handles crossings (bloom p95 0.41→0.63 UNDER the blanket weld — worse than
doing nothing). [test/planar-reseat.test.ts](../test/planar-reseat.test.ts) locks
the mechanism; [test/planar-weld.test.ts](../test/planar-weld.test.ts) locks the
contraction machinery.

**1f — background layer separation (EXPERIMENTAL,
`VectorizeOptions.backgroundGradient`, default off; gradients-OFF planar only).**
The ring-"pull" and jagged-band fix at the root. With gradients off a smooth
background ramp posterizes into flat bands; every band↔band boundary is a noisy
nearest-colour frontier (traced faithfully ⇒ SUPER-JAGGED), and every band that
touches a foreground outline mints a junction that splits it (the "dot"/pull on the
white ring). Both defects are the bands' *existence*, so
[backgroundLayer.ts](../src/lib/trace/backgroundLayer.ts) makes the boundary not
exist: seed with the border-ring background label, grow over adjacent labels while
ONE fitted gradient still explains the union, relabel the accepted set to a single
region, and paint it with that gradient (a real SVG gradient bottom layer; the
foreground keeps flat fills; the ring becomes a junction-free closed loop that
disc-snaps to a perfect circle). The growth is gated on the RENDER, not an analytic
veto (the V6 pattern): a candidate joins only if the union gradient's per-pixel
prediction over the union's own samples is at least as close (mean CIE76, +0.1
margin) to the source as the flat band colours are — absorbing a genuinely distinct
shape forces the gradient to paint a transition the source renders crisp, so it
loses and the shape survives (petals' cyan petal is the guard case; an earlier
residual-only gate absorbed it into a blurry radial). Measured (gradients OFF,
512px): nebula 13 paths/606 nodes → **2 paths/40 nodes** (6-stop linear background,
ring/dot one clean shape), aurora 14/276 → **4/44** (5-stop linear, zero junctions);
petals/orbit/outline/summit/bloom byte-identical (union rejected or no seed).

*Interactions.* The union is also a strictly better background **detector**, so it
composes with `removeBackground`: with both flags on, the whole united set is dropped
instead of the single border-majority band (`detectBorderBackground` alone leaves a
posterized ramp's other bands on the canvas). The dropped label is therefore computed
on the FINAL map — the union relabels its members to a seed re-detected *after*
remove-markers and spike-healing, so filtering on the pre-union `bg` could silently
no-op and ship the background. Remove-markers themselves relabel pixels while the
raster keeps the dissolved object's colours, so those pixels are excluded from the
union's sample build (else a ghost tint drags an endpoint ~100/255 per channel).
[test/background-layer.test.ts](../test/background-layer.test.ts).

---

## 6. Other backlog

- ~~**AA transition slivers** (§3.2)~~ — **done**: segmentation-side small-region
  merge (`mergeSmallRegions`), driven by the Despeckle dial (§3.2). Possible follow-up:
  a thinness metric (absorb long-but-thin AA bands a pure area threshold misses).
- **Sub-pixel edge placement** — optionally place crack vertices at AA-weighted
  sub-pixel positions to close the small nebula seam gap with crisp.
- `src/devtest/planarScore.ts` is the harness for tuning all of the above.
- **Band-boundary regularization** (if 1f isn't taken): with gradients OFF all of
  bloom/aurora/nebula take the PALETTE-FIRST path, so band↔band boundaries are
  perpendicular-bisector iso-planes between k-means centroids evaluated on RAW
  pixels — source noise/AA flips assignment along the bisector (fingering), and the
  only smoother in that path is the 2-pass 3×3 `modeFilter`. Options: assign labels
  on lightly-smoothed channels, raise `modePasses`, or a boundary-belt re-assignment
  on a smoothed field. `healColorSpikes` can also nibble posterized band boundaries
  (validated on flat art, not on band stacks) — worth an A/B if jag persists.

## 7. Junction / jaggedness metrics (evaluation)

The golden harness previously measured only render fidelity (meanΔE/SSIM/seam) and
counts — a junction cluster or a jagged band boundary hid inside every tolerance.
`topologyMetrics` ([metrics.ts](../src/devtest/metrics.ts)) now scores every traced
doc (via `scoreDoc`) with:

- `junctions` — vertices in the shared-edge graph;
- `junctionClusters` / `clusterSpanMax` — clusters of ≥2 junction vertices within
  3px (an unresolved crossing); **asserted never to grow** per golden case;
- `jaggedness` — mean |turn| per px (deg/px) over the boundary curves (shared edges
  counted once); asserted within +15% +0.2 of golden.

Corpus: `bloom-flat` and `aurora-flat` (the two junction-issue images, gradients
OFF) joined `GOLDEN_CORPUS` via pre-rasterized 512px fixtures in `test/fixtures/`
(the node harness has no SVG rasterizer). Still unmeasured: junction kink angle
(tangent continuity at a junction), gradient-axis/stop fidelity, zoom-scale (>1×)
render comparison.
