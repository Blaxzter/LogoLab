// Stacked output: a paint-order post-pass over the planar graph.
//
// The planar trace TILES: every boundary is one shared edge, so a ring around a disc
// comes back as an annulus with a hole and the disc sits in that hole. Stacking keeps
// the same graph and only decides what each region may paint UNDER, so the rendered
// picture cannot change — only how it is built up. Two rules, both read off the loops
// (no raster):
//
// 1. CONTAINMENT. A hole whose whole interior is covered by opaque regions painted
//    later is dropped from its region's loops: the ring becomes a full disc and the disc
//    is painted over it. No edge is refitted or copied; the lower region just stops
//    referencing the shared edge (the old stacked engine traced each region separately
//    and its two copies of a boundary drifted apart).
//
// 2. SIDE BY SIDE: amodal completion at the junctions. Where one shape is in front of
//    another, the front shape's outline runs THROUGH the junction and the outline of the
//    one behind STOPS there and turns a corner (a T-junction). The shape whose outline
//    breaks off is the one behind, and it is completed under its neighbours:
//      • along EXISTING edges when its outline visibly carries on — two overlapping
//        circles whose overlap has its own colour: red's arc continues as the edge
//        between the overlap and yellow, so red becomes a full circle under the overlap;
//      • along a NEW hidden edge when it does not — a square behind a circle: the
//        square's two cut-off sides are joined by the curve their tangents agree on (a
//        line when they are collinear), accepted only if it stays under the shapes it
//        passes beneath.
//    A completion may only pass under opaque, solid shapes, which are then painted
//    above it. Contradicting completions (A under B and B under A) are settled by
//    hiding the least area: the candidates are accepted smallest hidden area first,
//    each only if it keeps the paint order acyclic.
//
// The structure:
//  • a SHAPE is one connected face: an outer loop plus the holes nested directly in it
//    (one label can own several shapes — the white page and the white counter of an O);
//  • across an outer loop's edge lies either a sibling's outer loop (same level) or the
//    hole of the shape that contains it (one level up), or nothing (EXT / a removed
//    label: transparency);
//  • siblings joined by outer↔outer edges form a GROUP with one parent hole;
//  • paint order is a DAG (container → contents, completed shape → what it passes
//    under); a shape's LAYER is its longest path from a source, and one item is emitted
//    per (layer, label). Two shapes on one layer never overlap except where a shape on
//    a higher layer covers both.
// A hole is dropped only when nothing transparent or translucent is anywhere inside it:
// no void on its own edges, none between its children, and every child solid (opaque,
// with all of ITS holes dropped). Otherwise the region below would show through.

import type { EdgeRef, PathNode, SharedEdge, Vec } from '../path/types'
import { segmentControls, segmentCount, cubicAt } from '../path/geometry.ts'
import { flattenEdgeRefLoop, loopInside, polySignedArea } from './planarAssemble.ts'

/** One painted layer: the shapes of one label on one paint layer. */
export interface StackLayer {
  label: number
  /** Paint layer (0 = bottom). Containers sit below their contents, a completed shape
   *  below what it passes under. */
  depth: number
  /** Outer loops plus the holes that stay open, in the label's original loop order. */
  loops: EdgeRef[][]
}

export interface StackResult {
  /** Bottom to top. */
  layers: StackLayer[]
  /** Hidden edges the side-by-side rule created (a completion with no drawn outline to
   *  follow). Each is referenced by the one shape it completes; add them to the
   *  topology. */
  edges: SharedEdge[]
}

/** Two edge ends at a junction continue each other within this angle (deg). */
const THROUGH_DEG = 20
/** An outline turning less than this at a junction runs straight on there: no break.
 *  Small on purpose: a thin occluder meets the outline it cuts at a shallow angle, and
 *  the tests that matter are the tangents agreeing and the hidden edge staying under. */
const CORNER_DEG = 8
/** Tangent estimate: chord to the point this far along the edge (px, capped at ¼ edge). */
const TANGENT_REACH = 4
/** Longest chain of existing edges a completion may follow. */
const MAX_CHAIN = 48
/** Most outline refs a hidden edge may replace. */
const MAX_BRIDGE_REFS = 6
/** A hidden edge's tangent rays may meet at most this many chords away. */
const MAX_BRIDGE_REACH = 3
/** Collinear stems: both tangents within this of the chord (deg). */
const COLLINEAR_DEG = 6
/** Two hidden edges closer than this everywhere are one (px). */
const TWIN_PX = 0.5
/** Samples per Bézier segment when an edge is flattened. */
const FLAT_STEPS = 8
/** An edge shorter than this is a crossing split into two junctions, part of its
 *  junction (px). The weld collapses some to a point; at 2048 Mastercard's top crossing
 *  is two junctions 1 px apart, and at 0.75 its circles never paired. */
const MICRO_PX = 1.5
/** A completion's hidden area and the shapes it passes under agree within this fraction,
 *  plus AREA_SLACK_PX² (flattening differs between the two sums). */
const AREA_TOL = 0.02
const AREA_SLACK_PX = 4
/** Most shapes one completion may pass under. */
const MAX_SWALLOW = 400

interface Shape {
  label: number
  /** Global loop index of the outer loop; -1 for an orphan hole (never stacked). */
  outer: number
  holes: number[]
  group: number
}

interface LoopRec {
  label: number
  /** Index within the label's loop list. */
  local: number
  refs: EdgeRef[]
  shape: number
  isHole: boolean
}

/** One end of an open edge, at its junction vertex. */
interface End {
  edge: number
  atStart: boolean
  v: number
  p: Vec
  /** Unit tangent pointing AWAY from the vertex, into the edge. */
  dir: Vec
}

/** One accepted completion of a shape's outer loop. */
interface Completion {
  shape: number
  /** Ref index where the outline breaks off (kept). */
  from: number
  /** Ref index where it rejoins (kept); the refs strictly between are replaced. */
  to: number
  path: EdgeRef[]
  /** Shapes the completion passes under, and those whose edge it now shares (the far
   *  side of a followed chain): all must be painted above the completed shape. */
  under: number[]
  hidden: number
  edge?: SharedEdge
}

/**
 * Re-layer a planar trace for stacked painting. `labels` are the regions to paint
 * (a removed background is left out and reads as transparency); `opaque(label)` says
 * whether a region hides what is under it.
 */
export function stackRegions(
  loopsByLabel: ReadonlyMap<number, EdgeRef[][]>,
  edges: ReadonlyMap<number, SharedEdge>,
  labels: readonly number[],
  opaque: (label: number) => boolean,
): StackResult {
  const painted = new Set(labels)
  const loops: LoopRec[] = []
  const shapes: Shape[] = []
  const polys: Vec[][] = []
  const edgeMapRW = edges as Map<number, SharedEdge>

  // --- shapes: each hole goes to the smallest outer loop of its label containing it ---
  for (const [label, ls] of loopsByLabel) {
    if (label < 0) continue
    const base = loops.length
    const lp: Vec[][] = ls.map((l) => flattenEdgeRefLoop(l, edgeMapRW))
    const areas = lp.map(polySignedArea)
    const boxes = lp.map(bbox)
    const shapeOfOuter = new Map<number, number>()
    ls.forEach((refs, i) => {
      loops.push({ label, local: i, refs, shape: -1, isHole: areas[i] < 0 })
      polys.push(lp[i])
      if (areas[i] >= 0) {
        shapeOfOuter.set(i, shapes.length)
        loops[base + i].shape = shapes.length
        shapes.push({ label, outer: base + i, holes: [], group: -1 })
      }
    })
    for (let i = 0; i < ls.length; i++) {
      if (areas[i] >= 0) continue
      let best = -1
      let bestA = Infinity
      for (let j = 0; j < ls.length; j++) {
        if (areas[j] < 0 || areas[j] >= bestA) continue
        if (!boxInside(boxes[i], boxes[j]) || !loopInside(lp[i], lp[j])) continue
        best = j
        bestA = areas[j]
      }
      if (best >= 0) {
        const s = shapeOfOuter.get(best)!
        shapes[s].holes.push(base + i)
        loops[base + i].shape = s
      } else {
        loops[base + i].shape = shapes.length
        shapes.push({ label, outer: -1, holes: [base + i], group: -1 })
      }
    }
  }

  // --- edge sides: which loops reference each edge ---
  const sides = new Map<number, number[]>()
  loops.forEach((rec, li) => {
    for (const r of rec.refs) {
      let a = sides.get(r.edge)
      if (!a) sides.set(r.edge, (a = []))
      a.push(li)
    }
  })
  /** The loop across `edge` from loop `li`, or -1 for transparency. */
  const across = (edge: number, li: number): number => {
    for (const o of sides.get(edge) ?? []) {
      if (o === li) continue
      return painted.has(loops[o].label) ? o : -1
    }
    return -1
  }

  // --- groups of siblings (union-find over outer↔outer edges) ---
  const uf = shapes.map((_, i) => i)
  const find = (i: number): number => {
    while (uf[i] !== i) i = uf[i] = uf[uf[i]]
    return i
  }
  const parentHoleOf = new Map<number, number>() // shape → hole loop across its outer
  const touchesVoid = new Uint8Array(shapes.length)
  shapes.forEach((s, si) => {
    if (s.outer < 0) return
    for (const r of loops[s.outer].refs) {
      const o = across(r.edge, s.outer)
      if (o < 0) touchesVoid[si] = 1
      else if (loops[o].isHole) parentHoleOf.set(si, o)
      else uf[find(si)] = find(loops[o].shape)
    }
  })
  const groupParent = new Map<number, number>() // group root → parent hole loop
  const groupVoid = new Set<number>()
  const conflicted = new Set<number>() // holes a group disagreed about: never dropped
  const members = new Map<number, number[]>()
  shapes.forEach((s, si) => {
    const g = find(si)
    s.group = g
    let m = members.get(g)
    if (!m) members.set(g, (m = []))
    m.push(si)
    if (touchesVoid[si]) groupVoid.add(g)
    const h = parentHoleOf.get(si)
    if (h === undefined) return
    const prev = groupParent.get(g)
    if (prev === undefined) groupParent.set(g, h)
    else if (prev !== h) {
      conflicted.add(prev)
      conflicted.add(h)
    }
  })
  const childrenOfHole = new Map<number, number[]>()
  for (const [g, h] of groupParent) {
    let a = childrenOfHole.get(h)
    if (!a) childrenOfHole.set(h, (a = []))
    a.push(g)
  }

  // --- which holes drop: nothing see-through anywhere inside ---
  const solidMemo = new Map<number, boolean>()
  const dropMemo = new Map<number, boolean>()
  const droppable = (h: number): boolean => {
    const hit = dropMemo.get(h)
    if (hit !== undefined) return hit
    dropMemo.set(h, false) // cycle guard
    let ok = !conflicted.has(h) && loops[h].refs.every((r) => across(r.edge, h) >= 0)
    if (ok) {
      for (const g of childrenOfHole.get(h) ?? []) {
        if (groupVoid.has(g) || !members.get(g)!.every(solid)) {
          ok = false
          break
        }
      }
    }
    dropMemo.set(h, ok)
    return ok
  }
  const solid = (si: number): boolean => {
    const hit = solidMemo.get(si)
    if (hit !== undefined) return hit
    solidMemo.set(si, false) // cycle guard
    const s = shapes[si]
    const ok = s.outer >= 0 && painted.has(s.label) && opaque(s.label) && s.holes.every(droppable)
    solidMemo.set(si, ok)
    return ok
  }

  // --- paint order DAG: `above.get(a)` holds the shapes painted over a ---
  const above = new Map<number, Set<number>>()
  const addAbove = (lo: number, hi: number): void => {
    let s = above.get(lo)
    if (!s) above.set(lo, (s = new Set()))
    s.add(hi)
  }
  for (const [g, h] of groupParent) {
    const owner = loops[h].shape
    for (const m of members.get(g)!) addAbove(owner, m)
  }
  /** Whether `to` is painted (transitively) over `from`. */
  const reaches = (from: number, to: number): boolean => {
    if (from === to) return true
    const seen = new Set<number>([from])
    const stack = [from]
    while (stack.length) {
      for (const n of above.get(stack.pop()!) ?? []) {
        if (n === to) return true
        if (!seen.has(n)) {
          seen.add(n)
          stack.push(n)
        }
      }
    }
    return false
  }

  // --- side by side: completions under the neighbours, smallest hidden area first ---
  const completions = sideBySide(
    shapes,
    loops,
    polys,
    edges,
    across,
    solid,
    (si) => painted.has(shapes[si].label),
    (si) => opaque(shapes[si].label),
    (edge) => sides.get(edge) ?? [],
  )
  completions.sort((a, b) => a.hidden - b.hidden)
  const accepted = new Map<number, Completion[]>()
  let nextEdgeId = 0
  for (const id of edges.keys()) nextEdgeId = Math.max(nextEdgeId, id + 1)
  const newEdges: SharedEdge[] = []
  /** An accepted hidden edge the bridge `e` would duplicate (same ends, same curve). */
  const twinOf = (e: SharedEdge): { edge: SharedEdge; reversed: boolean } | null => {
    for (const o of newEdges) {
      const reversed = o.startVertex === e.endVertex && o.endVertex === e.startVertex
      if (!reversed && !(o.startVertex === e.startVertex && o.endVertex === e.endVertex)) continue
      const a = flattenOpen(e.nodes)
      const b = flattenOpen(o.nodes)
      if (reversed) b.reverse()
      if (a.length === b.length && a.every((p, i) => Math.hypot(p.x - b[i].x, p.y - b[i].y) < TWIN_PX))
        return { edge: o, reversed }
    }
    return null
  }
  for (const c of completions) {
    const mine = accepted.get(c.shape) ?? []
    const n = loops[shapes[c.shape].outer].refs.length
    if (mine.some((o) => spansOverlap(o.from, o.to, c.from, c.to, n))) continue
    if (c.under.some((x) => reaches(x, c.shape))) continue
    for (const x of c.under) addAbove(c.shape, x)
    if (c.edge) {
      // Two shapes completed along one line under the same occluder (the halves of a
      // seam a disc covers) share ONE hidden edge, as every boundary in the graph does.
      const twin = twinOf(c.edge)
      if (twin) c.path = [{ edge: twin.edge.id, reversed: twin.reversed }]
      else {
        const e = { ...c.edge, id: nextEdgeId++ }
        c.path = [{ edge: e.id, reversed: false }]
        newEdges.push(e)
      }
    }
    mine.push(c)
    accepted.set(c.shape, mine)
  }

  // --- the page showing through: a shape the colour of what lies beneath it ---
  // Orbit: a teal plate, a white ring, a teal counter, a white dot. Stacked naively, the
  // ring fills in and the counter is painted back on top as a teal disc — the plate's own
  // colour drawn again over a white disc. The counter IS the plate showing through, so it
  // is left out and the ring keeps its hole: plate, ring, dot — what a designer draws, and
  // what mono gives. "Beneath" is the shape owning the hole the ring sits in, when that
  // hole is dropped (it extends under the whole ring). A shape any completion involves is
  // kept: something other than the plate may be under it.
  const involved = new Set<number>()
  for (const cs of accepted.values())
    for (const c of cs) {
      involved.add(c.shape)
      for (const x of c.under) involved.add(x)
    }
  const keepHole = new Set<number>()
  const omitted = new Map<number, number>() // shape → the shape it shows through to
  // (Nested rings of two colours: the shape beneath can itself be one left out.)
  const shown = (b: number): number => {
    for (let guard = 0; omitted.has(b) && guard < shapes.length; guard++) b = omitted.get(b)!
    return b
  }
  // Outside in, because each omission re-opens a hole: once the counter is left out the
  // ring is a ring again, and the white dot inside no longer lies on white — it must not
  // be left out as "the ring showing through" (it was, and Orbit lost its dot).
  const groupDepth = new Map<number, number>()
  const depthOfGroup = (g: number, guard = 0): number => {
    const hit = groupDepth.get(g)
    if (hit !== undefined) return hit
    const hp = groupParent.get(g)
    const d = hp === undefined || guard > shapes.length ? 0 : depthOfGroup(shapes[loops[hp].shape].group, guard + 1) + 1
    groupDepth.set(g, d)
    return d
  }
  const outsideIn = [...groupParent].sort((a, b) => depthOfGroup(a[0]) - depthOfGroup(b[0]))
  for (const [g, hp] of outsideIn) {
    if (!droppable(hp) || keepHole.has(hp)) continue
    const beneath = shown(loops[hp].shape)
    const bl = shapes[beneath].label
    if (!painted.has(bl) || !opaque(bl)) continue
    for (const r of members.get(g)!) {
      if (involved.has(r) || omitted.has(r)) continue
      for (const h of shapes[r].holes) {
        if (!droppable(h)) continue
        const same: number[] = []
        for (const cg of childrenOfHole.get(h) ?? [])
          for (const c of members.get(cg)!) if (shapes[c].label === bl && !involved.has(c) && solid(c)) same.push(c)
        if (same.length === 0) continue
        keepHole.add(h)
        for (const c of same) omitted.set(c, beneath)
      }
    }
  }
  // What sat on an omitted shape now sits on the shape it showed through to: it no longer
  // has to clear the ring around the hole (that hole is open again), so the dot can share
  // the ring's layer and item.
  for (const [c, beneath] of omitted) {
    for (const x of above.get(c) ?? []) if (!omitted.has(x)) addAbove(shown(beneath), x)
    above.delete(c)
    for (const his of above.values()) his.delete(c)
  }

  // --- layers: longest path from a source, one item per (layer, label) ---
  const layerMemo = new Map<number, number>()
  const below = new Map<number, number[]>()
  for (const [lo, his] of above)
    for (const hi of his) {
      let a = below.get(hi)
      if (!a) below.set(hi, (a = []))
      a.push(lo)
    }
  const layerOf = (si: number): number => {
    const hit = layerMemo.get(si)
    if (hit !== undefined) return hit
    layerMemo.set(si, 0) // cycle guard (the DAG is acyclic by construction)
    let l = 0
    for (const lo of below.get(si) ?? []) l = Math.max(l, layerOf(lo) + 1)
    layerMemo.set(si, l)
    return l
  }

  const byKey = new Map<string, { label: number; depth: number; keep: { idx: number; refs: EdgeRef[] }[] }>()
  shapes.forEach((s, si) => {
    if (!painted.has(s.label) || omitted.has(si)) return
    const depth = layerOf(si)
    const key = `${depth}:${s.label}`
    let layer = byKey.get(key)
    if (!layer) byKey.set(key, (layer = { label: s.label, depth, keep: [] }))
    if (s.outer >= 0) {
      const done = accepted.get(si)
      layer.keep.push({ idx: s.outer, refs: done ? spliceLoop(loops[s.outer].refs, done) : loops[s.outer].refs })
    }
    for (const h of s.holes) if (!droppable(h) || keepHole.has(h)) layer.keep.push({ idx: h, refs: loops[h].refs })
  })
  const layers = [...byKey.values()]
    .sort((a, b) => a.depth - b.depth || a.label - b.label)
    .map(({ label, depth, keep }) => ({
      label,
      depth,
      loops: keep.sort((a, b) => a.idx - b.idx).map((k) => k.refs),
    }))
    .filter((l) => l.loops.length > 0)
  return { layers, edges: newEdges }
}

// ---------------------------------------------------------------------------
// Side by side: find where a shape's outline breaks off at a junction, and the
// completion under its neighbours that the junction implies.
// ---------------------------------------------------------------------------

function sideBySide(
  shapes: Shape[],
  loops: LoopRec[],
  polys: Vec[][],
  edges: ReadonlyMap<number, SharedEdge>,
  across: (edge: number, li: number) => number,
  solid: (si: number) => boolean,
  isPainted: (si: number) => boolean,
  isOpaque: (si: number) => boolean,
  sidesOf: (edge: number) => readonly number[],
): Completion[] {
  // A crossing is often two junctions joined by a micro-edge the weld collapsed to a
  // point; such an edge is part of its junction, not an outline. Vertices joined by one
  // form a junction CLUSTER, and arms are paired per cluster.
  const flat = new Map<number, Vec[]>()
  const micro = new Set<number>()
  for (const e of edges.values()) {
    if (e.closed || e.startVertex == null || e.endVertex == null || e.startVertex < 0 || e.endVertex < 0) continue
    const pts = flattenOpen(e.nodes)
    flat.set(e.id, pts)
    if (polyLength(pts) < MICRO_PX) micro.add(e.id)
  }
  const cl = new Map<number, number>()
  const findC = (v: number): number => {
    let r = v
    while (cl.has(r) && cl.get(r) !== r) r = cl.get(r)!
    cl.set(v, r)
    return r
  }
  const microAt = new Map<number, SharedEdge[]>()
  for (const id of micro) {
    const e = edges.get(id)!
    const ra = findC(e.startVertex!)
    const rb = findC(e.endVertex!)
    if (ra !== rb) cl.set(ra, rb)
    for (const v of [e.startVertex!, e.endVertex!]) {
      let a = microAt.get(v)
      if (!a) microAt.set(v, (a = []))
      a.push(e)
    }
  }
  /** Micro-edge refs leading from vertex a to vertex b inside one cluster ([] if a = b). */
  const hop = (a: number, b: number): EdgeRef[] | null => {
    if (a === b) return []
    const prev = new Map<number, [number, EdgeRef]>()
    const queue = [a]
    const seen = new Set([a])
    while (queue.length) {
      const v = queue.shift()!
      for (const e of microAt.get(v) ?? []) {
        const fwd = e.startVertex === v
        const w = fwd ? e.endVertex! : e.startVertex!
        if (seen.has(w)) continue
        seen.add(w)
        prev.set(w, [v, { edge: e.id, reversed: !fwd }])
        if (w === b) {
          const path: EdgeRef[] = []
          for (let x = b; x !== a; x = prev.get(x)![0]) path.unshift(prev.get(x)![1])
          return path
        }
        queue.push(w)
      }
    }
    return null
  }

  // Edge ends with their tangents, and the through pairs at each junction: the two arms
  // that continue each other best, ranked (a junction's straightest pair claims its arms
  // first), within THROUGH_DEG.
  const ends = new Map<string, End>()
  const byCluster = new Map<number, End[]>()
  const endKey = (edge: number, atStart: boolean) => `${edge}:${atStart ? 0 : 1}`
  for (const [id, pts] of flat) {
    if (micro.has(id)) continue
    const e = edges.get(id)!
    // The tangent stops at the edge's first corner node: a stem a few px long must not
    // read round the corner it ends in.
    const corners = e.nodes.map((nd, i) => (i > 0 && i < e.nodes.length - 1 && nd.kind === 'corner' ? i : -1))
    const firstCorner = corners.find((i) => i > 0) ?? e.nodes.length - 1
    const lastCorner = [...corners].reverse().find((i) => i > 0) ?? 0
    for (const atStart of [true, false]) {
      const seq = atStart ? pts : [...pts].reverse()
      const reach = atStart ? firstCorner * FLAT_STEPS : (e.nodes.length - 1 - lastCorner) * FLAT_STEPS
      const end: End = {
        edge: id,
        atStart,
        v: atStart ? e.startVertex! : e.endVertex!,
        p: seq[0],
        dir: tangent(seq.slice(0, reach + 1)),
      }
      ends.set(endKey(id, atStart), end)
      const c = findC(end.v)
      let a = byCluster.get(c)
      if (!a) byCluster.set(c, (a = []))
      a.push(end)
    }
  }
  const partner = new Map<End, End>()
  const cosThrough = Math.cos((THROUGH_DEG * Math.PI) / 180)
  for (const list of byCluster.values()) {
    const pairs: [number, End, End][] = []
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].edge === list[j].edge) continue
        const straight = -dot(list[i].dir, list[j].dir)
        if (straight >= cosThrough) pairs.push([straight, list[i], list[j]])
      }
    pairs.sort((a, b) => b[0] - a[0])
    for (const [, a, b] of pairs) {
      if (partner.has(a) || partner.has(b)) continue
      partner.set(a, b)
      partner.set(b, a)
    }
  }
  const tailOf = (r: EdgeRef) => ends.get(endKey(r.edge, !r.reversed))
  const headOf = (r: EdgeRef) => ends.get(endKey(r.edge, r.reversed))
  const otherEnd = (e: End) => ends.get(endKey(e.edge, !e.atStart))!
  const cosCorner = Math.cos((CORNER_DEG * Math.PI) / 180)

  const out: Completion[] = []
  shapes.forEach((s, si) => {
    if (s.outer < 0 || !isPainted(si)) return
    const li = s.outer
    const refs = loops[li].refs
    const n = refs.length
    // The outline's real refs (micro-edges are junction, not outline).
    const sig: number[] = []
    for (let i = 0; i < n; i++) if (!micro.has(refs[i].edge)) sig.push(i)
    const ns = sig.length
    if (ns < 2) return
    const tails = new Map<number, End>()
    const heads = new Map<number, End>()
    for (const i of sig) {
      const t = tailOf(refs[i])
      const h = headOf(refs[i])
      if (!t || !h) return
      tails.set(i, t)
      heads.set(i, h)
    }
    // Junction cluster → the real ref leaving it (an outline visiting a cluster twice is
    // ambiguous there).
    const leaving = new Map<number, number>()
    for (const i of sig) {
      const c = findC(tails.get(i)!.v)
      leaving.set(c, leaving.has(c) ? -1 : i)
    }
    const ownEdges = new Set(refs.map((r) => r.edge))
    const oldArea = polySignedArea(polys[li])
    /** The area the shapes `sis` cover, holes and all (what is in a hole is above them). */
    const areaOf = (sis: number[]): number => sis.reduce((a, x) => a + polySignedArea(polys[shapes[x].outer]), 0)

    /** The shapes strictly between the outline and a completion, or null when the
     *  region reaches transparency, the shape itself, or a shape that is not solid.
     *  `fence` (the followed chain) closes the region; without one only the shapes
     *  directly across the replaced span count, and the bridge test does the rest.
     *  Micro-edges are never crossed: the shapes on their two sides only touch. */
    const swallowed = (replaced: EdgeRef[], fence: Set<number> | null): number[] | null => {
      const found = new Set<number>()
      const stack: number[] = []
      const visit = (edge: number, from: number): boolean => {
        if (micro.has(edge)) return true
        const o = across(edge, from)
        if (o < 0) return false
        const sh = loops[o].shape
        if (sh === si) return false
        if (!found.has(sh)) {
          if (!solid(sh) || found.size >= MAX_SWALLOW) return false
          found.add(sh)
          stack.push(sh)
        }
        return true
      }
      for (const r of replaced) if (!visit(r.edge, li)) return null
      while (fence && stack.length) {
        const x = shapes[stack.pop()!]
        for (const lj of [x.outer, ...x.holes]) {
          if (lj < 0) continue
          for (const r of loops[lj].refs) {
            if (fence.has(r.edge) || ownEdges.has(r.edge)) continue
            if (!visit(r.edge, lj)) return null
          }
        }
      }
      return [...found]
    }
    /** The opaque shapes on the outer side of the chain edges, or null when one is
     *  transparency, translucent, or this shape. */
    const farSide = (fence: Set<number>, inside: Set<number>): number[] | null => {
      const found = new Set<number>()
      for (const edge of fence) {
        let outer = -1
        for (const lj of sidesOf(edge)) {
          const sh = loops[lj].shape
          if (!inside.has(sh)) outer = sh
        }
        if (outer < 0 || outer === si || !isPainted(outer) || !isOpaque(outer)) return null
        found.add(outer)
      }
      return [...found]
    }
    const between = (from: number, to: number): EdgeRef[] => {
      const rs: EdgeRef[] = []
      for (let i = (from + 1) % n; i !== to; i = (i + 1) % n) rs.push(refs[i])
      return rs
    }
    /** The area the completion adds, or -1 when the completed outline does not contain
     *  the whole shape. Positive added area is not enough: a replaced span that loops
     *  round the far side of the new path leaves part of the shape OUTSIDE the completed
     *  outline (mercedes-benz lost half a star arm), so every point of the replaced span
     *  must lie inside it. */
    const hiddenArea = (from: number, to: number, path: EdgeRef[], extra?: SharedEdge): number => {
      const kept: EdgeRef[] = []
      for (let i = to; ; i = (i + 1) % n) {
        kept.push(refs[i])
        if (i === from) break
      }
      let m = edges as Map<number, SharedEdge>
      if (extra) {
        m = new Map(edges)
        m.set(extra.id, extra)
      }
      const poly = flattenEdgeRefLoop([...kept, ...path], m)
      for (const r of between(from, to)) {
        const e = edges.get(r.edge)
        if (!e || micro.has(r.edge)) continue
        const pts = flattenOpen(e.nodes)
        for (let i = 1; i < pts.length - 1; i++) if (!pointInPolygon(pts[i], poly)) return -1
      }
      return polySignedArea(poly) - oldArea
    }

    for (let q = 0; q < ns; q++) {
      const k = sig[q]
      const outIdx = sig[(q + 1) % ns]
      const inEnd = heads.get(k)!
      const outEnd = tails.get(outIdx)!
      // Smooth here: the outline does not break.
      if (-dot(inEnd.dir, outEnd.dir) >= cosCorner) continue
      const cont = partner.get(inEnd)
      if (cont === outEnd) continue
      if (cont) {
        // Its outline carries on as an existing edge: follow the through chain until
        // it rejoins this outline.
        const path: EdgeRef[] = []
        const fence = new Set<number>()
        let at = inEnd.v
        let cur: End | undefined = cont
        let to = -1
        for (let step = 0; cur && step < MAX_CHAIN; step++) {
          if (fence.has(cur.edge) || ownEdges.has(cur.edge)) break
          const h = hop(at, cur.v)
          if (!h) break
          path.push(...h, { edge: cur.edge, reversed: !cur.atStart })
          fence.add(cur.edge)
          const qe = otherEnd(cur)
          at = qe.v
          const m = leaving.get(findC(qe.v))
          if (m !== undefined) {
            const t = m >= 0 ? tails.get(m) : undefined
            const back = t ? hop(at, t.v) : null
            if (t && back && partner.get(qe) === t) {
              path.push(...back)
              to = m
            }
            break
          }
          cur = partner.get(qe)
        }
        if (to < 0 || to === outIdx) continue
        const replaced = between(k, to)
        const under = swallowed(replaced, fence)
        if (!under || under.length === 0) continue
        // The completed outline now runs along each chain edge too, and both shapes on
        // it anti-alias the same pixels there. That is only invisible if the shape on
        // the FAR side is opaque and painted above this one; over the page it shows as a
        // fringe of this shape's colour round the other's rim (a disc split in two
        // colours: one half completed under the other rims the other with its colour).
        const beyond = farSide(fence, new Set(under))
        if (!beyond) continue
        const hidden = hiddenArea(k, to, path)
        // The region the completion hides IS the shapes it passes under: their areas
        // must add up to it. A flood that missed a shape (or took one from outside)
        // disagrees here, whatever went wrong upstream.
        if (hidden <= 0 || !sameArea(hidden, areaOf(under))) continue
        under.push(...beyond)
        out.push({ shape: si, from: k, to, path, under, hidden })
        continue
      }
      // Its outline stops here and nothing drawn carries it on: bridge to where it
      // resumes with the curve the two cut-off stems agree on (a T-junction at each end).
      const a = scale(inEnd.dir, -1) // travel direction arriving at the break
      for (let used = 1; used <= MAX_BRIDGE_REFS && used < ns; used++) {
        const j = sig[(q + used) % ns]
        // `to` may come back round to `k` itself: an outline that is one ref plus the
        // span it loses (a square's three sides as one edge, cut by a circle).
        const to = sig[(q + used + 1) % ns]
        const wIn = heads.get(j)!
        const wOut = tails.get(to)!
        if (-dot(wIn.dir, wOut.dir) >= cosCorner) continue
        const bridge = bridgeNodes(inEnd.p, a, wOut.p, wOut.dir)
        if (!bridge) continue
        const replaced = between(k, to)
        const under = swallowed(replaced, null)
        if (!under || under.length === 0) continue
        if (!bridgeUnder(bridge, under, si, shapes, polys)) continue
        const edge: SharedEdge = { id: -1, nodes: bridge, closed: false, startVertex: inEnd.v, endVertex: wOut.v }
        const path = [{ edge: -1, reversed: false }]
        const hidden = hiddenArea(k, to, path, edge)
        // A bridge hides part of the shapes across the span, never more than all of it.
        if (hidden <= 0 || hidden > areaOf(under) * (1 + AREA_TOL) + AREA_SLACK_PX) continue
        out.push({ shape: si, from: k, to, path, under, hidden, edge })
        break
      }
    }
  })
  return out
}

/** The hidden edge from `p` (leaving along `a`) to `q` (arriving against `b`, the
 *  direction the outline leaves `q` in): a line when the stems are collinear, else the
 *  cubic through their tangent rays' meeting point. Null when the stems are not
 *  relatable (rays that do not meet ahead, or a bend past 90°). */
function bridgeNodes(p: Vec, a: Vec, q: Vec, b: Vec): PathNode[] | null {
  const chord = { x: q.x - p.x, y: q.y - p.y }
  const len = Math.hypot(chord.x, chord.y)
  if (len < 1e-6 || dot(a, b) < 0) return null
  const u = scale(chord, 1 / len)
  const cosCol = Math.cos((COLLINEAR_DEG * Math.PI) / 180)
  const node = (v: Vec, hIn: Vec | null, hOut: Vec | null): PathNode => ({
    x: v.x,
    y: v.y,
    hIn,
    hOut,
    kind: 'smooth',
  })
  if (dot(a, u) >= cosCol && dot(b, u) >= cosCol) return [node(p, null, null), node(q, null, null)]
  // p + a·t = q − b·s
  const den = cross(a, b)
  if (Math.abs(den) < 1e-9) return null
  const t = cross(chord, b) / den
  const s = cross(chord, a) / den
  if (t <= 0 || s <= 0 || t > MAX_BRIDGE_REACH * len || s > MAX_BRIDGE_REACH * len) return null
  const m = { x: p.x + a.x * t, y: p.y + a.y * t }
  return [
    node(p, null, { x: p.x + ((m.x - p.x) * 2) / 3, y: p.y + ((m.y - p.y) * 2) / 3 }),
    node(q, { x: q.x + ((m.x - q.x) * 2) / 3, y: q.y + ((m.y - q.y) * 2) / 3 }, null),
  ]
}

/** Every interior sample of the bridge lies in one of the `under` shapes' REGIONS (outer
 *  outline minus its holes) and outside shape `self`. Testing the outer outline alone
 *  let a bridge cut across the shape it completes whenever one of the shapes across the
 *  span held it in a hole: that outline contains the shape itself (mercedes-benz lost
 *  half a star arm). */
function bridgeUnder(nodes: PathNode[], under: number[], self: number, shapes: Shape[], polys: Vec[][]): boolean {
  const pts = flattenOpen(nodes)
  const inShape = (p: Vec, si: number): boolean =>
    pointInPolygon(p, polys[shapes[si].outer]) && !shapes[si].holes.some((h) => pointInPolygon(p, polys[h]))
  for (let i = 1; i < pts.length - 1; i++) {
    if (inShape(pts[i], self)) return false
    if (!under.some((si) => inShape(pts[i], si))) return false
  }
  return true
}

/** Replace each completion's span of `refs` with its path. */
function spliceLoop(refs: EdgeRef[], done: Completion[]): EdgeRef[] {
  const n = refs.length
  const skip = new Uint8Array(n)
  const after = new Map<number, EdgeRef[]>()
  for (const c of done) {
    after.set(c.from, c.path)
    for (let i = (c.from + 1) % n; i !== c.to; i = (i + 1) % n) skip[i] = 1
  }
  const out: EdgeRef[] = []
  for (let i = 0; i < n; i++) {
    if (skip[i]) continue
    out.push(refs[i])
    for (const r of after.get(i) ?? []) out.push(r)
  }
  return out
}

/** Whether two completions of one n-ref ring collide: one replaces a ref the other
 *  keeps as an end or also replaces, or both splice in after the same ref. */
function spansOverlap(f1: number, t1: number, f2: number, t2: number, n: number): boolean {
  if (f1 === f2) return true
  // from === to replaces every other ref.
  const inner = (f: number, t: number, i: number) => {
    const d = (i - f + n) % n
    return d > 0 && d < ((t - f + n) % n || n)
  }
  for (let i = 0; i < n; i++) {
    if (inner(f1, t1, i) && (inner(f2, t2, i) || i === f2 || i === t2)) return true
    if (inner(f2, t2, i) && (i === f1 || i === t1)) return true
  }
  return false
}

function flattenOpen(nodes: PathNode[]): Vec[] {
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }))
  const sp = { nodes, closed: false }
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < FLAT_STEPS; k++) pts.push(cubicAt(p0, c1, c2, p3, k / FLAT_STEPS))
  }
  const last = nodes[nodes.length - 1]
  pts.push({ x: last.x, y: last.y })
  return pts
}

/** Unit direction from the first point toward the point TANGENT_REACH along the
 *  polyline (at most a quarter of its length, so a short edge reads its own end). */
function tangent(pts: Vec[]): Vec {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const reach = Math.max(Math.min(TANGENT_REACH, total / 4), 1e-6)
  let acc = 0
  let target = pts[pts.length - 1]
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    if (acc >= reach) {
      target = pts[i]
      break
    }
  }
  const d = { x: target.x - pts[0].x, y: target.y - pts[0].y }
  const l = Math.hypot(d.x, d.y)
  return l < 1e-9 ? { x: 1, y: 0 } : { x: d.x / l, y: d.y / l }
}

const sameArea = (a: number, b: number): boolean => Math.abs(a - b) <= Math.max(a, b) * AREA_TOL + AREA_SLACK_PX

function polyLength(pts: Vec[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return l
}

const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y
const cross = (a: Vec, b: Vec) => a.x * b.y - a.y * b.x
const scale = (a: Vec, k: number): Vec => ({ x: a.x * k, y: a.y * k })

function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function bbox(poly: Vec[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of poly) {
    if (p.x < x0) x0 = p.x
    if (p.x > x1) x1 = p.x
    if (p.y < y0) y0 = p.y
    if (p.y > y1) y1 = p.y
  }
  return { x0, y0, x1, y1 }
}

/** Cheap pre-gate for loopInside: the inner box within the outer one (a little slack). */
function boxInside(a: Box, b: Box): boolean {
  const e = 1e-6
  return a.x0 >= b.x0 - e && a.y0 >= b.y0 - e && a.x1 <= b.x1 + e && a.y1 <= b.y1 + e
}
