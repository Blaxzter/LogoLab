// Phase 6 — edge-level beautify for the planar tracer. Snapping happens on the
// ONE shared edge, so both adjacent regions inherit it and stay byte-coincident.
// These tests assert: a disc edge → 4-node circle (both regions follow), a
// near-straight open edge → 2 PINNED-endpoint nodes (junction stays welded,
// neighbour untouched), the concentric relation solver fires over disc circles,
// fidelity = 0 is a pure no-op, and the pass is deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { planarBeautify } from '../src/lib/trace/planarBeautify.ts'
import { DEFAULT_BEAUTIFY_OPTIONS } from '../src/lib/trace/beautify.ts'
import { materializeDoc, reverseEdgeNodes } from '../src/lib/path/topology.ts'
import { moveEdgeNode } from '../src/lib/path/topologyEdit.ts'
import type { EdgeRef, EditableDoc, PathItem, PathNode, SharedEdge, Topology, Vertex } from '../src/lib/path/types.ts'

const OPTS = { ...DEFAULT_BEAUTIFY_OPTIONS }
const NEAR = 1e-9

const pn = (x: number, y: number, hIn: PathNode['hIn'] = null, hOut: PathNode['hOut'] = null): PathNode => ({ x, y, hIn, hOut, kind: 'corner' })

/** A filled disc of label 1 in a field of label 0. */
function disc(w: number, h: number, cx: number, cy: number, r: number): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 1 : 0
  return L
}

/** Build a materialized doc from a topology + its loopsByLabel (like the real
 *  planar branch in index.ts), so stored subPaths are derived from the graph. */
function buildDoc(w: number, h: number, topo: Topology, loopsByLabel: Map<number, EdgeRef[][]>): EditableDoc {
  const order = [...loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
  const items: PathItem[] = order.map((Lb) => ({
    kind: 'path',
    id: 'r' + Lb,
    fill: '#000000',
    fillRule: 'nonzero',
    loops: loopsByLabel.get(Lb)!,
    subPaths: [],
    visible: true,
  }))
  return materializeDoc({ viewBox: [0, 0, w, h], items, topology: topo })
}

/** The shared edge id referenced by ≥2 distinct region labels (the disc boundary). */
function sharedEdgeId(loopsByLabel: Map<number, EdgeRef[][]>): number {
  const labelsByEdge = new Map<number, Set<number>>()
  for (const [label, loops] of loopsByLabel)
    for (const loop of loops)
      for (const r of loop) {
        let s = labelsByEdge.get(r.edge)
        if (!s) labelsByEdge.set(r.edge, (s = new Set()))
        s.add(label)
      }
  const found = [...labelsByEdge.entries()].find(([, labels]) => labels.size >= 2)
  assert.ok(found, 'expected an edge shared by two regions')
  return found![0]
}

/** Every materialized subpath that comes from `edgeId`, tagged with traversal dir. */
function subpathsForEdge(doc: EditableDoc, edgeId: number): { nodes: PathNode[]; reversed: boolean }[] {
  const out: { nodes: PathNode[]; reversed: boolean }[] = []
  for (const it of doc.items) {
    if (it.kind !== 'path' || !it.loops) continue
    it.loops.forEach((loop, li) => {
      const ref = loop.find((r) => r.edge === edgeId)
      if (ref) out.push({ nodes: it.subPaths[li].nodes, reversed: ref.reversed })
    })
  }
  return out
}

/** Master coincidence invariant: stored subPaths === a fresh materialization. */
function assertConsistent(doc: EditableDoc): void {
  const fresh = materializeDoc(doc)
  for (let i = 0; i < doc.items.length; i++) {
    const a = doc.items[i]
    const b = fresh.items[i]
    if (a.kind === 'path' && b.kind === 'path') assert.deepEqual(a.subPaths, b.subPaths)
  }
}

const centreOf = (nodes: PathNode[]): { cx: number; cy: number } => ({
  cx: nodes.reduce((s, n) => s + n.x, 0) / nodes.length,
  cy: nodes.reduce((s, n) => s + n.y, 0) / nodes.length,
})

// --- 1a/coincidence: disc edge → circle, both regions follow ----------------

test('planar-beautify: disc edge snaps to a 4-node circle; both regions coincident', () => {
  const W = 40, H = 40
  const trace = tracePlanar(disc(W, H, 20, 20, 12), W, H)
  const edgeId = sharedEdgeId(trace.loopsByLabel)

  const before = buildDoc(W, H, { vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel)
  const topo = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS)
  const after = buildDoc(W, H, topo, trace.loopsByLabel)

  // The canonical disc edge is now a 4-node kappa-Bézier circle (all smooth).
  const discEdge = topo.edges.find((e) => e.id === edgeId)!
  assert.equal(discEdge.nodes.length, 4)
  assert.ok(discEdge.nodes.every((n) => n.kind === 'smooth' && !!n.hIn && !!n.hOut))

  // BOTH regions on the edge materialize it: one forward, one reversed.
  const afterSubs = subpathsForEdge(after, edgeId)
  assert.equal(afterSubs.length, 2, 'disc edge is referenced by exactly two regions')
  const fwd = afterSubs.find((s) => !s.reversed)!
  const rev = afterSubs.find((s) => s.reversed)!
  assert.equal(fwd.nodes.length, 4)
  assert.equal(rev.nodes.length, 4)

  // Byte-coincident: the reversed region's run is the exact reverse of the
  // forward region's run (adversarial — fails if a region kept stale geometry).
  assert.deepEqual(reverseEdgeNodes(rev.nodes), fwd.nodes)

  // Both regions actually changed vs the unbeautified trace (not just one).
  const beforeSubs = subpathsForEdge(before, edgeId)
  const beforeFwd = beforeSubs.find((s) => !s.reversed)!
  const beforeRev = beforeSubs.find((s) => s.reversed)!
  assert.notDeepEqual(fwd.nodes, beforeFwd.nodes)
  assert.notDeepEqual(rev.nodes, beforeRev.nodes)

  assertConsistent(after)
})

// --- 1b: near-straight open edge → 2 pinned nodes, neighbour preserved ------

test('planar-beautify: near-straight open edge snaps to 2 pinned nodes; curved neighbour untouched', () => {
  const vertices: Vertex[] = [
    { id: 0, x: 0, y: 0 },
    { id: 1, x: 10, y: 0 },
    { id: 2, x: 0, y: 10 },
  ]
  // edge 0: near-straight (interior node only 0.4px off the chord) → snaps.
  // edge 1: a genuine curve sharing junction v0 (bulges ~3px) → preserved.
  const edges: SharedEdge[] = [
    { id: 0, closed: false, startVertex: 0, endVertex: 1, nodes: [pn(0, 0), pn(5, 0.4), pn(10, 0)] },
    {
      id: 1,
      closed: false,
      startVertex: 0,
      endVertex: 2,
      nodes: [pn(0, 0, null, { x: 4, y: 3 }), pn(0, 10, { x: 4, y: 7 }, null)],
    },
  ]
  const e1Before = JSON.stringify(edges[1].nodes)
  const topo = planarBeautify({ vertices, edges }, new Map(), OPTS)

  const e0 = topo.edges.find((e) => e.id === 0)!
  // Collapsed to exactly two corner nodes pinned at the junction endpoints.
  assert.equal(e0.nodes.length, 2)
  assert.deepEqual({ x: e0.nodes[0].x, y: e0.nodes[0].y }, { x: 0, y: 0 })
  assert.deepEqual({ x: e0.nodes[1].x, y: e0.nodes[1].y }, { x: 10, y: 0 })
  assert.equal(e0.nodes[0].hOut, null)
  assert.equal(e0.nodes[1].hIn, null)

  // The curved neighbour is byte-unchanged AND the input edge was not mutated.
  const e1 = topo.edges.find((e) => e.id === 1)!
  assert.equal(JSON.stringify(e1.nodes), e1Before)
  assert.equal(JSON.stringify(edges[1].nodes), e1Before)
  // Its shared endpoint still sits exactly on junction v0 (weld intact).
  assert.deepEqual({ x: e1.nodes[0].x, y: e1.nodes[0].y }, { x: 0, y: 0 })
})

// --- 1c: concentric relation solver across disc circles ---------------------

test('planar-beautify: concentric disc edges are aligned to a common centre', () => {
  const circlePolyNodes = (cx: number, cy: number, r: number, n = 48): PathNode[] => {
    const nodes: PathNode[] = []
    for (let i = 0; i < n; i++) {
      const t = (i / n) * 2 * Math.PI
      nodes.push(pn(cx + r * Math.cos(t), cy + r * Math.sin(t)))
    }
    return nodes
  }
  const edges: SharedEdge[] = [
    { id: 0, closed: true, startVertex: null, endVertex: null, nodes: circlePolyNodes(20, 20, 12) },
    { id: 1, closed: true, startVertex: null, endVertex: null, nodes: circlePolyNodes(20.6, 20.4, 6) },
  ]
  const topo = planarBeautify({ vertices: [], edges }, new Map(), { ...OPTS, fidelity: 2 })

  // Both snapped to 4-node circles…
  assert.equal(topo.edges[0].nodes.length, 4)
  assert.equal(topo.edges[1].nodes.length, 4)
  // …and the concentric solver pulled them to one shared centre.
  const c0 = centreOf(topo.edges[0].nodes)
  const c1 = centreOf(topo.edges[1].nodes)
  assert.ok(Math.abs(c0.cx - c1.cx) < 1e-6 && Math.abs(c0.cy - c1.cy) < 1e-6, `centres ${JSON.stringify(c0)} vs ${JSON.stringify(c1)}`)
  // Distinct radii (|12-6| exceeds the relation window) are NOT reconciled.
  const r0 = Math.max(...topo.edges[0].nodes.map((n) => Math.abs(n.x - c0.cx)))
  const r1 = Math.max(...topo.edges[1].nodes.map((n) => Math.abs(n.x - c1.cx)))
  assert.ok(Math.abs(r0 - r1) > 1, `radii stay distinct, got ${r0} vs ${r1}`)
})

// --- no-op + determinism ----------------------------------------------------

test('planar-beautify: fidelity 0 returns the input topology unchanged', () => {
  const trace = tracePlanar(disc(40, 40, 20, 20, 12), 40, 40)
  const topo: Topology = { vertices: trace.vertices, edges: trace.edges }
  const out = planarBeautify(topo, trace.loopsByLabel, { ...OPTS, fidelity: 0 })
  assert.equal(out, topo, 'same reference back (pure no-op)')
})

test('planar-beautify: deterministic (twice → identical topology)', () => {
  const trace = tracePlanar(disc(40, 40, 20, 20, 12), 40, 40)
  const a = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS)
  const b = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS)
  assert.deepEqual(a, b)
})

// --- Phase 5 editing still operates coherently on the beautified graph -------

test('planar-beautify: dragging a node on a beautified shared edge moves both regions', () => {
  const W = 40, H = 40
  const trace = tracePlanar(disc(W, H, 20, 20, 12), W, H)
  const edgeId = sharedEdgeId(trace.loopsByLabel)
  const topo = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS)
  const doc = buildDoc(W, H, topo, trace.loopsByLabel)

  const before = JSON.stringify(subpathsForEdge(doc, edgeId))
  // Drag interior node 1 of the now-circular shared edge (4 nodes, idx 0..3).
  const next = moveEdgeNode(doc, edgeId, 1, 0.7, -0.3)
  const subs = subpathsForEdge(next, edgeId)
  const fwd = subs.find((s) => !s.reversed)!
  const rev = subs.find((s) => s.reversed)!

  assert.notEqual(JSON.stringify(subs), before, 'both regions moved')
  assert.deepEqual(reverseEdgeNodes(rev.nodes), fwd.nodes, 'edge stays byte-coincident after the drag')
  assertConsistent(next)
})
