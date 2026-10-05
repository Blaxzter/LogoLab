// Stacked output: a paint-order post-pass over the planar graph.
//
// The planar trace TILES: every boundary is one shared edge, so a ring around a disc
// comes back as an annulus with a hole and the disc sits in that hole. Stacking keeps
// the same graph and only decides what each region may paint UNDER. A hole whose whole
// interior is covered by opaque regions painted later is dropped from its region's
// loops, so the ring becomes a full disc and the disc is painted over it. No edge is
// refitted or copied: the top region's boundary is still the one shared edge, the lower
// region just stops referencing it. Hence no double-drawn seams (the old stacked engine
// traced each region separately and its two copies of a boundary drifted apart).
//
// Containment only. Side-by-side neighbours (neither inside the other) still tile;
// deciding which of two touching regions should extend under the other is a second,
// separate rule.
//
// The structure, all read off the loops (no raster):
//  • a SHAPE is one connected face: an outer loop plus the holes nested directly in it
//    (one label can own several shapes — the white page and the white counter of an O);
//  • across an outer loop's edge lies either a sibling's outer loop (same level) or the
//    hole of the shape that contains it (one level up), or nothing (EXT / a removed
//    label: transparency);
//  • siblings joined by outer↔outer edges form a GROUP with one parent hole; a group's
//    depth is its parent's depth + 1, and painting by depth puts every container under
//    everything it contains.
// A hole is dropped only when nothing transparent or translucent is anywhere inside it:
// no void on its own edges, none between its children, and every child solid (opaque,
// with all of ITS holes dropped). Otherwise the region below would show through.

import type { EdgeRef, SharedEdge, Vec } from '../path/types'
import { flattenEdgeRefLoop, loopInside, polySignedArea } from './planarAssemble.ts'

/** One painted layer: the shapes of one label at one nesting depth. */
export interface StackLayer {
  label: number
  depth: number
  /** Outer loops plus the holes that stay open, in the label's original loop order. */
  loops: EdgeRef[][]
}

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

/**
 * Re-layer a planar trace for stacked painting. `labels` are the regions to paint
 * (a removed background is left out and reads as transparency); `opaque(label)` says
 * whether a region hides what is under it. Returns the layers bottom-to-top.
 */
export function stackRegions(
  loopsByLabel: ReadonlyMap<number, EdgeRef[][]>,
  edges: ReadonlyMap<number, SharedEdge>,
  labels: readonly number[],
  opaque: (label: number) => boolean,
): StackLayer[] {
  const painted = new Set(labels)
  const loops: LoopRec[] = []
  const shapes: Shape[] = []
  const edgeMapRW = edges as Map<number, SharedEdge>

  // --- shapes: each hole goes to the smallest outer loop of its label containing it ---
  for (const [label, ls] of loopsByLabel) {
    if (label < 0) continue
    const base = loops.length
    const polys: Vec[][] = ls.map((l) => flattenEdgeRefLoop(l, edgeMapRW))
    const areas = polys.map(polySignedArea)
    const boxes = polys.map(bbox)
    const shapeOfOuter = new Map<number, number>()
    ls.forEach((refs, i) => {
      loops.push({ label, local: i, refs, shape: -1, isHole: areas[i] < 0 })
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
        if (!boxInside(boxes[i], boxes[j]) || !loopInside(polys[i], polys[j])) continue
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

  // --- depth: one below the shape owning the parent hole ---
  const depthMemo = new Map<number, number>()
  const depthOf = (g: number, guard = 0): number => {
    const hit = depthMemo.get(g)
    if (hit !== undefined) return hit
    const h = groupParent.get(g)
    const d = h === undefined || guard > shapes.length ? 0 : depthOf(shapes[loops[h].shape].group, guard + 1) + 1
    depthMemo.set(g, d)
    return d
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

  // --- layers: (label, depth), painted depth-first then by label ---
  const byKey = new Map<string, { label: number; depth: number; keep: number[] }>()
  shapes.forEach((s, si) => {
    if (!painted.has(s.label)) return
    const depth = depthOf(s.group)
    const key = `${depth}:${s.label}`
    let layer = byKey.get(key)
    if (!layer) byKey.set(key, (layer = { label: s.label, depth, keep: [] }))
    if (s.outer >= 0) layer.keep.push(s.outer)
    for (const h of s.holes) if (!droppable(h)) layer.keep.push(h)
  })
  return [...byKey.values()]
    .sort((a, b) => a.depth - b.depth || a.label - b.label)
    .map(({ label, depth, keep }) => ({
      label,
      depth,
      loops: keep.sort((a, b) => a - b).map((li) => loops[li].refs),
    }))
    .filter((l) => l.loops.length > 0)
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
