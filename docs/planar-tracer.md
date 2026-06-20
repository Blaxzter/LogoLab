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

1. ~~**Shared-edge editing is not wired yet.**~~ **Done (Phase 5).** Dragging a node
   on a shared boundary now moves the one edge and both regions follow; junction
   drags move every incident spoke. (Minor known gap: double-clicking the *closing*
   segment of a pure closed-loop disc edge is a no-op — insert elsewhere on it.)
2. **Anti-alias transition slivers.** At a colour boundary the segmenter assigns the
   in-between AA colour its own thin region, which planar faithfully traces → many
   tiny unnecessary regions. Fix belongs in **segmentation** (absorb AA slivers into
   a neighbour) or a small-region cull in the planar path. *(User-reported.)*
3. ~~**No circle/line snapping** (beautify).~~ **Done (Phase 6).** Shared edges
   now snap to circles / ellipses / straight lines at trace time (§5).
4. **Sub-pixel edge placement** on smooth high-contrast boundaries is slightly behind
   crisp (it fits the integer crack staircase, not the AA coverage field) — visible
   only as a marginally higher seam metric on gradient images like nebula.

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

**Deferred (stretch 1d — open-edge circular ARC snap):** an open junction→junction
edge that follows a circular arc could collapse to cubic arc(s) pinned at its two
junctions. It needs a *partial*-arc-to-Bézier emit (the kappa builder only emits a
full ellipse) and only earns its keep where the fitter leaves a wobbly multi-cubic
arc — not seen on the current corpus (the open-arc DP fit is already economical), so
it is deferred. The line snap (1b) covers the high-value straight-boundary case;
H/V axis-snapping is intentionally NOT done (it would move junction endpoints and
unweld the graph).

---

## 6. Other backlog

- **AA transition slivers** (§3.2) — the most user-visible next win; segmentation-side
  merge of AA-only regions, or an area-threshold region cull in the planar emit loop.
- **Sub-pixel edge placement** — optionally place crack vertices at AA-weighted
  sub-pixel positions to close the small nebula seam gap with crisp.
- `src/devtest/planarScore.ts` is the harness for tuning all of the above.
