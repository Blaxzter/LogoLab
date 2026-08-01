// Junction-cluster weld machinery (`weldJunctionClusters`, planarWeld.ts). A
// rasterized degree-4 crossing lands as near-coincident degree-3 lattice junctions
// joined by micro-edges (nothing merges them, so the crossing renders as a tiny jog
// — the bloom X). The weld contracts those micro-edges: one fused vertex at the
// cluster centroid, the micro-edge gone from the graph and from every region loop,
// incident edges re-anchored — so the crossing is ONE clean point.
//
// Since 2026-07-21 this machinery has exactly one production consumer: the §10.4
// evidence-gated converged-pair weld (planarReseat.weldConvergedJunctions). The old
// per-trace blanket flag (`PlanarFitOptions.weldJunctions`) was REMOVED the same
// day — re-measured, it newly crossed two tier-2 gates and degraded its own target
// cases by preempting the re-seat (§10.4 has the numbers) — so these tests drive
// `weldJunctionClusters` directly on the traced graph.
//
// Asserts: the split crossing fuses to a single junction, loops stay closed and
// endpoint-coincident, a 1px EXT pocket collapses cleanly, a clean degree-4 corner
// and long edges are untouched, radius 0 is a byte-identical no-op, deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar, type PlanarTrace } from '../src/lib/trace/planarAssemble.ts'
import { weldJunctionClusters } from '../src/lib/trace/planarWeld.ts'
import type { EdgeRef, SharedEdge } from '../src/lib/path/types.ts'

/** Trace, then contract micro-edges ≤ `radius` px (the function's own guard makes
 *  radius 0 a no-op — asserted below). */
function weldedTrace(labels: Int32Array, w: number, h: number, radius: number): PlanarTrace {
  const t = tracePlanar(labels, w, h)
  weldJunctionClusters(t.vertices, t.edges, t.loopsByLabel, w, h, radius)
  return t
}

/** Offset crossing: A|B boundary at x=6 (top half), C|D boundary at x=7 (bottom) —
 *  two degree-3 junctions at (6,6) and (7,6) joined by a 1-crack micro-edge. */
function offsetCross(w = 12, h = 12): Int32Array {
  const labels = new Int32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      labels[y * w + x] = y < 6 ? (x < 6 ? 0 : 1) : x < 7 ? 2 : 3
    }
  return labels
}

/** Clean crossing: quadrants meeting at exactly one degree-4 corner. */
function cleanCross(w = 12, h = 12): Int32Array {
  const labels = new Int32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      labels[y * w + x] = (y < 6 ? 0 : 2) + (x < 6 ? 0 : 1)
    }
  return labels
}

/** Quadrants around a single transparent pixel — a 1px EXT pocket whose 1-crack
 *  boundary edges join the junction corners minted around it. */
function pocketCross(w = 12, h = 12): Int32Array {
  const labels = cleanCross(w, h)
  labels[6 * w + 6] = -1
  return labels
}

function junctionIds(t: PlanarTrace): number[] {
  return t.vertices.map((v) => v.id)
}

/** Junction vertices within `r` px of (x,y) — isolates the crossing cluster from
 *  the degree-3 junctions every boundary mints where it meets the image border. */
function near(t: PlanarTrace, x: number, y: number, r = 3): number[] {
  return t.vertices.filter((v) => Math.hypot(v.x - x, v.y - y) <= r).map((v) => v.id)
}

function edgeById(t: PlanarTrace): Map<number, SharedEdge> {
  return new Map(t.edges.map((e) => [e.id, e]))
}

/** Every loop must chain endpoint-coincident and close. */
function assertLoopsClosed(t: PlanarTrace): void {
  const byId = edgeById(t)
  for (const [label, loops] of t.loopsByLabel) {
    for (const loop of loops) {
      assert.ok(loop.length > 0, `label ${label}: empty loop survived`)
      const ends = loop.map((r: EdgeRef) => {
        const e = byId.get(r.edge)
        assert.ok(e, `label ${label}: loop references missing edge ${r.edge}`)
        const first = e!.nodes[0]
        const last = e!.nodes[e!.nodes.length - 1]
        if (e!.closed) return { a: first, b: first }
        return r.reversed ? { a: last, b: first } : { a: first, b: last }
      })
      for (let i = 0; i < ends.length; i++) {
        if (byId.get(loop[i].edge)!.closed) continue
        const cur = ends[i]
        const nxt = ends[(i + 1) % ends.length]
        const d = Math.hypot(cur.b.x - nxt.a.x, cur.b.y - nxt.a.y)
        assert.ok(d < 1e-9, `label ${label}: loop breaks at ref ${i} (gap ${d})`)
      }
    }
  }
}

/** Every non-closed edge's endpoints must reference live vertices at the same coords. */
function assertWelded(t: PlanarTrace): void {
  const vById = new Map(t.vertices.map((v) => [v.id, v]))
  for (const e of t.edges) {
    if (e.closed) continue
    for (const [vid, node] of [
      [e.startVertex, e.nodes[0]],
      [e.endVertex, e.nodes[e.nodes.length - 1]],
    ] as const) {
      if (vid == null || vid < 0) continue
      const v = vById.get(vid)
      assert.ok(v, `edge ${e.id} references pruned vertex ${vid}`)
      assert.ok(Math.hypot(v!.x - node.x, v!.y - node.y) < 1e-9, `edge ${e.id} endpoint off its vertex ${vid}`)
    }
  }
}

test('weld fuses an offset crossing into one junction', () => {
  const labels = offsetCross()
  const base = weldedTrace(labels, 12, 12, 0)
  assert.equal(near(base, 6.5, 6).length, 2, 'baseline: the offset crossing splits into two junctions')

  const welded = weldedTrace(labels, 12, 12, 1.5)
  const fusedIds = near(welded, 6.5, 6)
  assert.equal(fusedIds.length, 1, 'weld: one fused junction at the crossing')
  const v = welded.vertices.find((x) => x.id === fusedIds[0])!
  assert.ok(Math.abs(v.x - 6.5) < 1e-9 && Math.abs(v.y - 6) < 1e-9, `fused at centroid (got ${v.x},${v.y})`)
  assert.equal(junctionIds(welded).length, junctionIds(base).length - 1, 'exactly the pair fused')
  assert.equal(welded.edges.length, base.edges.length - 1, 'micro-edge removed')
  // no loop may still reference the removed edge
  const ids = new Set(welded.edges.map((e) => e.id))
  for (const loops of welded.loopsByLabel.values())
    for (const loop of loops) for (const r of loop) assert.ok(ids.has(r.edge))
  assertLoopsClosed(welded)
  assertWelded(welded)
  assert.equal(welded.loopsByLabel.size, 4, 'all four regions survive')
})

test('weld collapses a 1px EXT pocket at a crossing', () => {
  const labels = pocketCross()
  const base = weldedTrace(labels, 12, 12, 0)
  assert.ok(near(base, 6.5, 6.5).length >= 2, 'baseline: pocket mints a junction cluster')

  const welded = weldedTrace(labels, 12, 12, 1.5)
  assert.equal(near(welded, 6.5, 6.5).length, 1, 'pocket cluster fuses to one junction')
  assertLoopsClosed(welded)
  assertWelded(welded)
  assert.equal(welded.loopsByLabel.size, 4, 'all four regions survive')
})

test('weld keeps a fused frame crossing ON the image border', () => {
  // A|B boundary jogging x=6→x=7 at y=2, with a 1px C pocket at the top border — the
  // crossing junctions are (6,0) and (7,0) ON the frame plus (6,1) just inside. Fusing
  // them must keep the survivor on the top edge (y=0); the naive centroid (y≈0.33) would
  // pull the boundary off the frame and open a sliver gap where it should bleed.
  const w = 12, h = 12
  const labels = new Int32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let l = y < 2 ? (x < 6 ? 0 : 1) : x < 7 ? 0 : 1
      if (y === 0 && x === 6) l = 2
      labels[y * w + x] = l
    }
  const base = weldedTrace(labels, w, h, 0)
  assert.ok(near(base, 6, 0.5, 1.5).length >= 3, 'baseline: the border crossing splits into ≥3 junctions')
  const welded = weldedTrace(labels, w, h, 3)
  const fused = near(welded, 6, 0.5, 1.5)
  assert.equal(fused.length, 1, 'the border crossing fuses to one junction')
  const v = welded.vertices.find((x) => x.id === fused[0])!
  assert.ok(Math.abs(v.y) < 1e-9, `fused vertex stays on the top border (y=${v.y})`)
  assertLoopsClosed(welded)
  assertWelded(welded)
})

test('weld caps cluster span: a noisy patch is not collapsed, frame vertices stay put', () => {
  // Per-pixel LCG noise packs the lattice with offset crossings — 260 short candidate
  // edges. Without a span cap the transitive union-find chains them into a few giant
  // clusters and collapses the whole patch to a handful of points (dragging border
  // vertices to the centre). The cap keeps the weld local, so an over-spread noise
  // cluster is left untouched.
  const w = 16, h = 16
  const labels = new Int32Array(w * h)
  let s = 1
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    labels[i] = s % 3
  }
  const base = weldedTrace(labels, w, h, 0)
  const welded = weldedTrace(labels, w, h, 3)
  // not collapsed: the vast majority of vertices survive (a runaway weld would leave <10)
  assert.ok(welded.vertices.length >= base.vertices.length * 0.5, `weld collapsed the patch (${base.vertices.length}→${welded.vertices.length})`)
  // no frame vertex is pulled off the border
  const onBorder = (vx: number, vy: number) => vx <= 1e-9 || vy <= 1e-9 || vx >= w - 1e-9 || vy >= h - 1e-9
  const baseById = new Map(base.vertices.map((v) => [v.id, v]))
  for (const wv of welded.vertices) {
    const bv = baseById.get(wv.id)
    if (bv && onBorder(bv.x, bv.y)) assert.ok(onBorder(wv.x, wv.y), `frame vertex ${wv.id} pulled off the border`)
  }
  // the weld induces no self-loops (non-closed edge with start===end)
  const selfLoops = (t: PlanarTrace) => t.edges.filter((e) => !e.closed && e.startVertex != null && e.startVertex === e.endVertex).length
  assert.ok(selfLoops(welded) <= selfLoops(base), 'weld introduced a self-loop edge')
  assertLoopsClosed(welded)
  assertWelded(welded)
})

test('weld leaves a clean degree-4 crossing and long edges untouched', () => {
  const labels = cleanCross()
  const base = weldedTrace(labels, 12, 12, 0)
  const welded = weldedTrace(labels, 12, 12, 3)
  assert.deepEqual(JSON.parse(JSON.stringify(welded)), JSON.parse(JSON.stringify(base)), 'no candidates ⇒ untouched')
})

test('weld radius 0 is a byte-identical no-op', () => {
  const labels = offsetCross()
  const a = weldedTrace(labels, 12, 12, 0)
  const b = tracePlanar(labels, 12, 12)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})

test('weld is deterministic', () => {
  const labels = pocketCross()
  const a = weldedTrace(labels, 12, 12, 1.5)
  const b = weldedTrace(labels, 12, 12, 1.5)
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})
