// Underlap: the last tiled edges of a stacked output reach under the shape in front.
//
// Two shapes sharing one edge each anti-alias it over what lies below, so a pixel the edge cuts
// in half shows a quarter of the layer beneath them: conflation. The picture carries a faint
// line along every such edge, and the mix at the edge reads as if the shape in front were bigger.
// Stacking removes it wherever one shape can be completed under another; this removes the rest.
//
// The shape behind stops referencing the shared edge and draws a hidden copy of it instead,
// pushed under the shape in front. The node count of the path does not change, and the visible
// boundary is still the shared edge, which only the shape in front now draws.
//
// Four rules:
//  * The ends stay on their junctions, or the outline behind would need a joining segment.
//  * The copy may only run under the shape in front, under anything painted above the shape
//    behind, or over the shape behind itself. Anywhere else it would show.
//  * The shape in front must be opaque, or the hidden part shows through it.
//  * An edge that runs along pixel boundaries keeps its place. It cuts no pixel, so nothing
//    anti-aliases there and there is no line to hide; the copy would only bow the outline of
//    the shape behind (a checkerboard's back cells came out with every side bulging 4 px).
//
// Pure (no DOM or Node APIs). Ships in the npm package.

import type { EdgeRef, PathNode, SharedEdge, Vec } from '../path/types'

export interface UnderlapLayer {
  label: number
  loops: EdgeRef[][]
}

export interface UnderlapInput {
  /** Bottom to top. Refs that move are replaced in `loops`. */
  layers: UnderlapLayer[]
  edges: Map<number, SharedEdge>
  /** Receives every hidden copy, so the caller can add it to the topology. */
  addEdge: (e: SharedEdge) => void
  labels: Int32Array
  width: number
  height: number
  opaque: (label: number) => boolean
}

/** How far the copy reaches, deepest first; the first that stays hidden wins. One pixel covers
 *  every pixel the shared edge cuts. Deeper leaves room to drag the edge in the editor, and
 *  keeps the hidden outline away from the visible one, where nothing can tell them apart. */
const DISTANCES = [4, 3, 2, 1, 0.5]
/** Below this the segment is too short to be worth a handle (px). */
const MIN_HANDLE_SEG = 3
/** Near a pinned end the copy is still at the junction, where any label may read (px). */
const END_SLACK = 1.5
/** A sharp corner's offset is capped at this multiple of the distance. */
const MITER_LIMIT = 2

interface RefSite {
  layer: number
  loop: number
  ref: number
}

const unit = (x: number, y: number): Vec | null => {
  const l = Math.hypot(x, y)
  return l < 1e-9 ? null : { x: x / l, y: y / l }
}

/** The left normal at a node (rotated from travel), mitred across a corner. */
function nodeNormal(e: SharedEdge, i: number): { n: Vec; miter: number } | null {
  const count = e.nodes.length
  const nd = e.nodes[i]
  const hasPrev = e.closed || i > 0
  const hasNext = e.closed || i < count - 1
  const prev = hasPrev ? e.nodes[(i - 1 + count) % count] : null
  const next = hasNext ? e.nodes[(i + 1) % count] : null
  const into = nd.hIn ? unit(nd.x - nd.hIn.x, nd.y - nd.hIn.y) : prev ? unit(nd.x - prev.x, nd.y - prev.y) : null
  const out = nd.hOut ? unit(nd.hOut.x - nd.x, nd.hOut.y - nd.y) : next ? unit(next.x - nd.x, next.y - nd.y) : null
  const a = into ?? out
  const b = out ?? into
  if (!a || !b) return null
  const n = unit(-a.y - b.y, a.x + b.x)
  if (!n) return { n: { x: -a.y, y: a.x }, miter: 1 }
  const cos = n.x * -a.y + n.y * a.x
  return { n, miter: Math.min(MITER_LIMIT, 1 / Math.max(1e-6, cos)) }
}

/** A copy of the edge moved `signed` px along its left normal, ends pinned. */
function offsetCopy(e: SharedEdge, id: number, signed: number): SharedEdge {
  const count = e.nodes.length
  const single = !e.closed && count === 2
  const moved = (p: Vec, by: Vec, k: number): Vec => ({ x: p.x + by.x * k, y: p.y + by.y * k })
  const nodes: PathNode[] = e.nodes.map((nd, i) => {
    const pinned = !e.closed && (i === 0 || i === count - 1)
    const nm = nodeNormal(e, i)
    if (!nm) return { ...nd, hIn: nd.hIn && { ...nd.hIn }, hOut: nd.hOut && { ...nd.hOut } }
    const off = pinned ? 0 : signed * nm.miter
    // A pinned end's handle still leans under the front shape: one lone cubic bows out by 3/4
    // of what its handles move, so it takes 4/3 to reach the distance at its middle.
    const hk = pinned ? signed * (single ? 4 / 3 : 1) : off
    const out: PathNode = {
      x: nd.x + nm.n.x * off,
      y: nd.y + nm.n.y * off,
      hIn: nd.hIn ? moved(nd.hIn, nm.n, hk) : null,
      hOut: nd.hOut ? moved(nd.hOut, nm.n, hk) : null,
      kind: nd.kind,
    }
    if (pinned) {
      // A straight side leaving a junction gets a handle, or the copy stays on the edge for
      // its whole first segment.
      const other = i === 0 ? e.nodes[1] : e.nodes[count - 2]
      const len = Math.hypot(other.x - nd.x, other.y - nd.y)
      if (len >= MIN_HANDLE_SEG) {
        const third: Vec = { x: nd.x + (other.x - nd.x) / 3, y: nd.y + (other.y - nd.y) / 3 }
        if (i === 0 && !nd.hOut) out.hOut = moved(third, nm.n, hk)
        if (i === count - 1 && !nd.hIn) out.hIn = moved(third, nm.n, hk)
      }
    }
    return out
  })
  return { id, nodes, closed: e.closed, startVertex: e.startVertex, endVertex: e.endVertex }
}

/** Points along an edge, about one a pixel, with their distance from the nearer pinned end. */
function samples(e: SharedEdge, visit: (x: number, y: number, tx: number, ty: number, fromEnd: number) => void): void {
  const count = e.nodes.length
  const segs = e.closed ? count : count - 1
  const pts: { x: number; y: number; tx: number; ty: number }[] = []
  for (let i = 0; i < segs; i++) {
    const a = e.nodes[i]
    const b = e.nodes[(i + 1) % count]
    const c1 = a.hOut ?? a
    const c2 = b.hIn ?? b
    const len =
      Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y)
    const n = Math.max(2, Math.min(512, Math.ceil(len)))
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n
      const u = 1 - t
      const x = u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x
      const y = u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y
      const tx = 3 * u * u * (c1.x - a.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (b.x - c2.x)
      const ty = 3 * u * u * (c1.y - a.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (b.y - c2.y)
      pts.push({ x, y, tx, ty })
    }
  }
  const step: number[] = [0]
  for (let i = 1; i < pts.length; i++)
    step.push(step[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const total = step[step.length - 1] ?? 0
  pts.forEach((p, i) => visit(p.x, p.y, p.tx, p.ty, e.closed ? Infinity : Math.min(step[i], total - step[i])))
}

/** How far off a pixel boundary still counts as on it (px). */
const GRID_EPS = 1e-3

/** Whether the whole edge runs along pixel boundaries: horizontal or vertical everywhere, on a
 *  whole coordinate. Such an edge leaves every pixel it touches whole on one side. */
function onPixelGrid(e: SharedEdge): boolean {
  let on = true
  const whole = (v: number): boolean => Math.abs(v - Math.round(v)) <= GRID_EPS
  samples(e, (x, y, tx, ty) => {
    if (!on) return
    if (Math.abs(ty) <= GRID_EPS * Math.abs(tx)) on = whole(y)
    else if (Math.abs(tx) <= GRID_EPS * Math.abs(ty)) on = whole(x)
    else on = false
  })
  return on
}

/**
 * Give every edge two layers still share a hidden copy under the shape in front. Returns how many
 * edges moved. An edge whose copy would show anywhere stays tiled.
 */
export function underlapTiledEdges(input: UnderlapInput): number {
  const { layers, edges, addEdge, labels, width: w, height: h, opaque } = input
  const labelAt = (x: number, y: number): number => {
    const cx = Math.floor(x)
    const cy = Math.floor(y)
    return cx < 0 || cy < 0 || cx >= w || cy >= h ? -1 : labels[cy * w + cx]
  }
  // The lowest layer each label appears on: a label is "above" a layer only if all of it is.
  const lowest = new Map<number, number>()
  layers.forEach((l, i) => {
    if (!lowest.has(l.label)) lowest.set(l.label, i)
  })
  const sites = new Map<number, RefSite[]>()
  layers.forEach((l, li) => {
    l.loops.forEach((loop, lo) => {
      loop.forEach((r, ri) => {
        const s = sites.get(r.edge)
        if (s) s.push({ layer: li, loop: lo, ref: ri })
        else sites.set(r.edge, [{ layer: li, loop: lo, ref: ri }])
      })
    })
  })
  let nextId = 0
  for (const id of edges.keys()) nextId = Math.max(nextId, id + 1)

  let moved = 0
  for (const [id, refs] of sites) {
    if (refs.length !== 2 || refs[0].layer === refs[1].layer) continue
    const [behind, front] = refs[0].layer < refs[1].layer ? refs : [refs[1], refs[0]]
    const behindLabel = layers[behind.layer].label
    const frontLabel = layers[front.layer].label
    if (behindLabel === frontLabel || !opaque(frontLabel)) continue
    const e = edges.get(id)
    if (!e || e.nodes.length < 2 || onPixelGrid(e)) continue
    // Which way is the front shape? The raster's own labels answer, not an orientation rule.
    let vote = 0
    samples(e, (x, y, tx, ty) => {
      const l = Math.hypot(tx, ty)
      if (l < 1e-9) return
      const nx = -ty / l
      const ny = tx / l
      if (labelAt(x + nx * 1.5, y + ny * 1.5) === frontLabel) vote++
      if (labelAt(x - nx * 1.5, y - ny * 1.5) === frontLabel) vote--
    })
    if (vote === 0) continue
    const sign = vote > 0 ? 1 : -1
    let copy: SharedEdge | null = null
    for (const d of DISTANCES) {
      const c = offsetCopy(e, nextId, sign * d)
      let ok = true
      samples(c, (x, y, _tx, _ty, fromEnd) => {
        if (!ok || fromEnd < END_SLACK) return
        const l = labelAt(x, y)
        if (l === frontLabel || l === behindLabel) return
        // A label painted wholly above the shape behind hides the copy too.
        const low = lowest.get(l)
        if (low === undefined || low <= behind.layer) ok = false
      })
      if (ok) {
        copy = c
        break
      }
    }
    if (!copy) continue
    nextId++
    edges.set(copy.id, copy)
    addEdge(copy)
    const layer = layers[behind.layer]
    const old = layer.loops[behind.loop][behind.ref]
    // The loop arrays can be the trace's own: replace, never edit in place.
    const nextLoop = layer.loops[behind.loop].slice()
    nextLoop[behind.ref] = { edge: copy.id, reversed: old.reversed }
    const nextLoops = layer.loops.slice()
    nextLoops[behind.loop] = nextLoop
    layer.loops = nextLoops
    moved++
  }
  return moved
}
