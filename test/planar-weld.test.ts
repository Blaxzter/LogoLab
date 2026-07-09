// Junction-cluster weld (`PlanarFitOptions.weldJunctions`). A rasterized degree-4
// crossing lands as near-coincident degree-3 lattice junctions joined by micro-edges
// (nothing merges them, so the crossing renders as a tiny jog — the bloom X). The
// weld contracts those micro-edges: one fused vertex at the cluster centroid, the
// micro-edge gone from the graph and from every region loop, incident edges
// re-anchored — so the crossing is ONE clean point.
//
// Asserts: the split crossing fuses to a single junction, loops stay closed and
// endpoint-coincident, a 1px EXT pocket collapses cleanly, a clean degree-4 corner
// and long edges are untouched, weld 0 is a byte-identical no-op, deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar, type PlanarTrace } from '../src/lib/trace/planarAssemble.ts'
import { DEFAULT_PLANAR_FIT, type PlanarFitOptions } from '../src/lib/trace/planarFit.ts'
import type { EdgeRef, SharedEdge } from '../src/lib/path/types.ts'

const OPTS = (weld: number): PlanarFitOptions => ({ ...DEFAULT_PLANAR_FIT, weldJunctions: weld })

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
  const base = tracePlanar(labels, 12, 12, OPTS(0))
  assert.equal(near(base, 6.5, 6).length, 2, 'baseline: the offset crossing splits into two junctions')

  const welded = tracePlanar(labels, 12, 12, OPTS(1.5))
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
  const base = tracePlanar(labels, 12, 12, OPTS(0))
  assert.ok(near(base, 6.5, 6.5).length >= 2, 'baseline: pocket mints a junction cluster')

  const welded = tracePlanar(labels, 12, 12, OPTS(1.5))
  assert.equal(near(welded, 6.5, 6.5).length, 1, 'pocket cluster fuses to one junction')
  assertLoopsClosed(welded)
  assertWelded(welded)
  assert.equal(welded.loopsByLabel.size, 4, 'all four regions survive')
})

test('weld leaves a clean degree-4 crossing and long edges untouched', () => {
  const labels = cleanCross()
  const base = tracePlanar(labels, 12, 12, OPTS(0))
  const welded = tracePlanar(labels, 12, 12, OPTS(3))
  assert.deepEqual(JSON.parse(JSON.stringify(welded)), JSON.parse(JSON.stringify(base)), 'no candidates ⇒ untouched')
})

test('weld 0 is a byte-identical no-op', () => {
  const labels = offsetCross()
  const a = tracePlanar(labels, 12, 12, OPTS(0))
  const b = tracePlanar(labels, 12, 12, { ...DEFAULT_PLANAR_FIT })
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})

test('weld is deterministic', () => {
  const labels = pocketCross()
  const a = tracePlanar(labels, 12, 12, OPTS(1.5))
  const b = tracePlanar(labels, 12, 12, OPTS(1.5))
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)))
})
