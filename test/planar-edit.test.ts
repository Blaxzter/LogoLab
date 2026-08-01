// Phase 5 — shared-edge joint editing. A minimal 2-region planar doc (two unit
// squares sharing one vertical edge, forward in region A and reversed in region
// B) is mutated through the topology ops; both regions must follow and stay
// coincident. The coincidence assertions are adversarial: forgetting to
// re-materialize the neighbour makes them fail.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { materializeDoc, regionProvenance } from '../src/lib/path/topology.ts'
import {
  deleteEdgeNode,
  deleteRegionNodes,
  insertNodeOnEdge,
  moveEdgeHandle,
  moveEdgeNode,
  moveVertex,
  resolveEdgeSegment,
  setEdgeNodeKind,
  translateRegion,
  translateRegionNodes,
} from '../src/lib/path/topologyEdit.ts'
import type { EditableDoc, PathItem, PathNode, SharedEdge, Vertex } from '../src/lib/path/types.ts'

const ES = 6 // the shared edge id (TM → BM, with one interior node)

function pn(x: number, y: number, hIn: PathNode['hIn'] = null, hOut: PathNode['hOut'] = null): PathNode {
  return { x, y, hIn, hOut, kind: 'corner' }
}

/**
 * Two unit squares [0,1]×[0,2] (A) and [1,2]×[0,2] (B) sharing the vertical edge
 * x=1 (edge ES, with an interior node at (1,1)). Vertices: 0 TL(0,0) 1 TM(1,0)
 * 2 TR(2,0) 3 BR(2,2) 4 BM(1,2) 5 BL(0,2). ES is forward in A, reversed in B.
 */
function makeDoc(): EditableDoc {
  const vertices: Vertex[] = [
    { id: 0, x: 0, y: 0 },
    { id: 1, x: 1, y: 0 },
    { id: 2, x: 2, y: 0 },
    { id: 3, x: 2, y: 2 },
    { id: 4, x: 1, y: 2 },
    { id: 5, x: 0, y: 2 },
  ]
  const edge = (id: number, nodes: PathNode[], s: number, e: number): SharedEdge => ({
    id,
    nodes,
    closed: false,
    startVertex: s,
    endVertex: e,
  })
  const edges: SharedEdge[] = [
    edge(0, [pn(0, 0), pn(1, 0)], 0, 1), // TL → TM
    edge(1, [pn(1, 0), pn(2, 0)], 1, 2), // TM → TR
    edge(2, [pn(2, 0), pn(2, 2)], 2, 3), // TR → BR
    edge(3, [pn(2, 2), pn(1, 2)], 3, 4), // BR → BM
    edge(4, [pn(1, 2), pn(0, 2)], 4, 5), // BM → BL
    edge(5, [pn(0, 2), pn(0, 0)], 5, 0), // BL → TL
    edge(ES, [pn(1, 0), pn(1, 1), pn(1, 2)], 1, 4), // TM → BM (shared, interior node)
  ]
  const itemA: PathItem = {
    kind: 'path',
    id: 'A',
    fill: '#ff0000',
    fillRule: 'nonzero',
    loops: [[{ edge: 0, reversed: false }, { edge: ES, reversed: false }, { edge: 4, reversed: false }, { edge: 5, reversed: false }]],
    subPaths: [],
    visible: true,
  }
  const itemB: PathItem = {
    kind: 'path',
    id: 'B',
    fill: '#0000ff',
    fillRule: 'nonzero',
    loops: [[{ edge: 1, reversed: false }, { edge: 2, reversed: false }, { edge: 3, reversed: false }, { edge: ES, reversed: true }]],
    subPaths: [],
    visible: true,
  }
  const doc: EditableDoc = { viewBox: [0, 0, 2, 2], items: [itemA, itemB], topology: { vertices, edges } }
  return materializeDoc(doc)
}

const pathItem = (doc: EditableDoc, id: string): PathItem =>
  doc.items.find((it) => it.id === id) as PathItem

const findEdge = (doc: EditableDoc, id: number): SharedEdge =>
  doc.topology!.edges.find((e) => e.id === id)!

const anchors = (item: PathItem): { x: number; y: number }[] =>
  item.subPaths.flatMap((sp) => sp.nodes.map((n) => ({ x: n.x, y: n.y })))

const NEAR = 1e-9
const has = (pts: { x: number; y: number }[], x: number, y: number): boolean =>
  pts.some((p) => Math.abs(p.x - x) < NEAR && Math.abs(p.y - y) < NEAR)

/**
 * The master coincidence invariant: every region's STORED subPaths must equal a
 * from-scratch materialization of the (edited) topology. If an op forgot to
 * re-materialize a neighbour, its stored cache is stale → this fails.
 */
function assertConsistent(doc: EditableDoc): void {
  const fresh = materializeDoc(doc)
  for (let i = 0; i < doc.items.length; i++) {
    const a = doc.items[i]
    const b = fresh.items[i]
    if (a.kind === 'path' && b.kind === 'path') assert.deepEqual(a.subPaths, b.subPaths)
  }
}

test('planar-edit: moveEdgeNode on a shared interior node moves BOTH regions, coincident', () => {
  const doc = makeDoc()
  const A0 = pathItem(doc, 'A').subPaths
  const B0 = pathItem(doc, 'B').subPaths

  const next = moveEdgeNode(doc, ES, 1, 0.3, -0.2)
  const A1 = pathItem(next, 'A').subPaths
  const B1 = pathItem(next, 'B').subPaths

  // Both regions changed — the adversarial bit: if B were not re-materialized it
  // would deep-equal B0.
  assert.notDeepEqual(A1, A0)
  assert.notDeepEqual(B1, B0)

  // The moved point (1.3, 0.8) is present in BOTH regions' caches.
  const moved = findEdge(next, ES).nodes[1]
  assert.ok(has(anchors(pathItem(next, 'A')), moved.x, moved.y))
  assert.ok(has(anchors(pathItem(next, 'B')), moved.x, moved.y))

  // The untouched neighbour's existing corners are unchanged.
  assert.ok(has(anchors(pathItem(next, 'B')), 2, 0))
  assert.ok(has(anchors(pathItem(next, 'B')), 2, 2))

  assertConsistent(next)
})

test('planar-edit: moveVertex moves every incident edge endpoint (welded junction)', () => {
  const doc = makeDoc()
  const next = moveVertex(doc, 1, 0.5, 0.4) // vertex 1 = TM (1,0) → (1.5,0.4)

  // Vertex table updated.
  assert.deepEqual(next.topology!.vertices[1], { id: 1, x: 1.5, y: 0.4 })
  // Every incident edge's matching endpoint moved with it.
  assert.deepEqual(
    { x: findEdge(next, 0).nodes[1].x, y: findEdge(next, 0).nodes[1].y },
    { x: 1.5, y: 0.4 },
  ) // e0 end
  assert.deepEqual(
    { x: findEdge(next, 1).nodes[0].x, y: findEdge(next, 1).nodes[0].y },
    { x: 1.5, y: 0.4 },
  ) // e1 start
  assert.deepEqual(
    { x: findEdge(next, ES).nodes[0].x, y: findEdge(next, ES).nodes[0].y },
    { x: 1.5, y: 0.4 },
  ) // ES start

  // Both regions show the junction at the SAME new spot (coincident).
  assert.ok(has(anchors(pathItem(next, 'A')), 1.5, 0.4))
  assert.ok(has(anchors(pathItem(next, 'B')), 1.5, 0.4))
  // The interior ES node (1,1) did NOT move.
  assert.ok(has(anchors(pathItem(next, 'A')), 1, 1))
  assertConsistent(next)
})

test('planar-edit: insertNodeOnEdge adds exactly one node, both regions gain it', () => {
  const doc = makeDoc()
  const aLen0 = pathItem(doc, 'A').subPaths[0].nodes.length
  const bLen0 = pathItem(doc, 'B').subPaths[0].nodes.length

  const next = insertNodeOnEdge(doc, ES, 0, 0.5) // split (1,0)-(1,1) at midpoint → (1,0.5)
  assert.equal(findEdge(next, ES).nodes.length, 4)
  assert.equal(pathItem(next, 'A').subPaths[0].nodes.length, aLen0 + 1)
  assert.equal(pathItem(next, 'B').subPaths[0].nodes.length, bLen0 + 1)
  assert.ok(has(anchors(pathItem(next, 'A')), 1, 0.5))
  assert.ok(has(anchors(pathItem(next, 'B')), 1, 0.5))
  assertConsistent(next)
})

test('planar-edit: deleteEdgeNode removes from both; no-op below 2 nodes / on endpoints', () => {
  const doc = makeDoc()
  const next = deleteEdgeNode(doc, ES, 1) // remove the lone interior node
  assert.equal(findEdge(next, ES).nodes.length, 2)
  assert.ok(!has(anchors(pathItem(next, 'A')), 1, 1))
  assert.ok(!has(anchors(pathItem(next, 'B')), 1, 1))
  assertConsistent(next)

  // Now ES has 2 nodes — any further delete is a no-op (would drop below 2).
  assert.equal(deleteEdgeNode(next, ES, 1), next)
  assert.equal(deleteEdgeNode(next, ES, 0), next)

  // Deleting a junction endpoint of the original 3-node edge is also refused.
  assert.equal(deleteEdgeNode(doc, ES, 0), doc)
  assert.equal(deleteEdgeNode(doc, ES, 2), doc)
})

test('planar-edit: setEdgeNodeKind propagates the kind to both regions', () => {
  const doc = makeDoc()
  const next = setEdgeNodeKind(doc, ES, 1, 'smooth')
  assert.equal(findEdge(next, ES).nodes[1].kind, 'smooth')
  // The interior ES node is materialized smooth in BOTH regions.
  const aSmooth = pathItem(next, 'A').subPaths[0].nodes.filter((n) => n.kind === 'smooth')
  const bSmooth = pathItem(next, 'B').subPaths[0].nodes.filter((n) => n.kind === 'smooth')
  assert.equal(aSmooth.length, 1)
  assert.equal(bSmooth.length, 1)
  assertConsistent(next)
})

test('planar-edit: moveEdgeHandle stays coincident (reversed region sees swapped handle)', () => {
  const doc = makeDoc()
  const next = moveEdgeHandle(doc, ES, 1, 'out', { x: 1.4, y: 1.1 }, false)
  // Canonical edge node carries the new hOut.
  assert.deepEqual(findEdge(next, ES).nodes[1].hOut, { x: 1.4, y: 1.1 })

  // Region A (forward) sees the interior node with hOut = (1.4,1.1).
  const aNode = pathItem(next, 'A').subPaths[0].nodes.find((n) => Math.abs(n.x - 1) < NEAR && Math.abs(n.y - 1) < NEAR)!
  assert.deepEqual(aNode.hOut, { x: 1.4, y: 1.1 })
  // Region B (reversed) sees the SAME node with the handle swapped onto hIn.
  const bNode = pathItem(next, 'B').subPaths[0].nodes.find((n) => Math.abs(n.x - 1) < NEAR && Math.abs(n.y - 1) < NEAR)!
  assert.deepEqual(bNode.hIn, { x: 1.4, y: 1.1 })
  assertConsistent(next)
})

test('planar-edit: provenance maps junctions vs interior; reversed flag set on region B', () => {
  const doc = makeDoc()
  const provA = regionProvenance(doc, pathItem(doc, 'A'))!
  const provB = regionProvenance(doc, pathItem(doc, 'B'))!

  // Region A materialized order: [(0,0),(1,0)*TM,(1,1) interior,(1,2)*BM,(0,2)].
  assert.equal(provA[0][1].vertexId, 1) // TM junction
  assert.equal(provA[0][2].vertexId, null) // ES interior
  assert.equal(provA[0][2].edgeId, ES)
  assert.equal(provA[0][2].edgeNodeIdx, 1)
  assert.equal(provA[0][2].reversed, false)
  assert.equal(provA[0][3].vertexId, 4) // BM junction

  // Region B materialized order: [(1,0)*TM,(2,0),(2,2),(1,2)*BM,(1,1) interior].
  assert.equal(provB[0][4].vertexId, null)
  assert.equal(provB[0][4].edgeId, ES)
  assert.equal(provB[0][4].edgeNodeIdx, 1) // canonical idx, despite reversed traversal
  assert.equal(provB[0][4].reversed, true)
  assert.equal(provB[0][0].vertexId, 1) // wrap junction TM
  assert.equal(provB[0][3].vertexId, 4) // BM junction
})

test('planar-edit: resolveEdgeSegment maps a materialized segment to its edge (both directions)', () => {
  const doc = makeDoc()
  const provA = regionProvenance(doc, pathItem(doc, 'A'))!
  const provB = regionProvenance(doc, pathItem(doc, 'B'))!
  const lenA = pathItem(doc, 'A').subPaths[0].nodes.length
  const lenB = pathItem(doc, 'B').subPaths[0].nodes.length

  // A: segment idx1→idx2 (TM → interior) is ES canonical seg 0, forward t.
  assert.deepEqual(resolveEdgeSegment(provA, 0, 1, lenA, 0.5), { edgeId: ES, segIdx: 0, t: 0.5 })
  // B: segment idx3→idx4 (BM → interior) is ES canonical seg 1, t flipped to 0.5.
  assert.deepEqual(resolveEdgeSegment(provB, 0, 3, lenB, 0.5), { edgeId: ES, segIdx: 1, t: 0.5 })
})

test('planar-edit: translateRegionNodes routes junction→moveVertex, interior→moveEdgeNode', () => {
  const doc = makeDoc()
  const provA = regionProvenance(doc, pathItem(doc, 'A'))!

  // Interior node (A idx2) → moveEdgeNode: both regions follow, junctions stay.
  const viaInterior = translateRegionNodes(doc, provA, [{ sub: 0, idx: 2 }], 0.1, 0.1)
  assert.ok(has(anchors(pathItem(viaInterior, 'A')), 1.1, 1.1))
  assert.ok(has(anchors(pathItem(viaInterior, 'B')), 1.1, 1.1))
  assert.ok(has(anchors(pathItem(viaInterior, 'A')), 1, 0)) // TM junction unmoved
  assertConsistent(viaInterior)

  // Junction node (A idx1 = TM) → moveVertex: every incident edge endpoint moves.
  const viaJunction = translateRegionNodes(doc, provA, [{ sub: 0, idx: 1 }], 0.2, 0.3)
  assert.deepEqual(viaJunction.topology!.vertices[1], { id: 1, x: 1.2, y: 0.3 })
  assert.ok(has(anchors(pathItem(viaJunction, 'A')), 1.2, 0.3))
  assert.ok(has(anchors(pathItem(viaJunction, 'B')), 1.2, 0.3))
  assertConsistent(viaJunction)
})

test('planar-edit: deleteRegionNodes deletes interior, skips junctions', () => {
  const doc = makeDoc()
  const provA = regionProvenance(doc, pathItem(doc, 'A'))!
  // Select the interior node + a junction; only the interior should be removed.
  const next = deleteRegionNodes(doc, provA, [{ sub: 0, idx: 2 }, { sub: 0, idx: 1 }])
  assert.equal(findEdge(next, ES).nodes.length, 2)
  assert.ok(has(anchors(pathItem(next, 'A')), 1, 0)) // junction kept
  assert.ok(!has(anchors(pathItem(next, 'A')), 1, 1)) // interior gone
  assertConsistent(next)
})

test('planar-edit: translateRegion moves a whole region, neighbour stays welded', () => {
  const doc = makeDoc()
  const next = translateRegion(doc, pathItem(doc, 'A'), 0.5, 0)
  // Region A's far edge (e5, x=0 side) shifted; the shared edge ES shifted too.
  assert.ok(has(anchors(pathItem(next, 'A')), 0.5, 0)) // TL moved
  // The shared boundary stays coincident between A and B (master invariant).
  assertConsistent(next)
})

// --- Real traced topology (reversed refs, oriented holes, degree-4 junction) ---

function quadrants(w: number, h: number): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) L[y * w + x] = y < h / 2 ? (x < w / 2 ? 0 : 1) : x < w / 2 ? 2 : 3
  return L
}

function tracedDoc(labels: Int32Array, w: number, h: number): EditableDoc {
  const trace = tracePlanar(labels, w, h)
  const order = [...trace.loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
  const items: PathItem[] = order.map((Lb) => ({
    kind: 'path',
    id: 'r' + Lb,
    fill: '#000000',
    fillRule: 'nonzero',
    loops: trace.loopsByLabel.get(Lb)!,
    subPaths: [],
    visible: true,
  }))
  const doc: EditableDoc = { viewBox: [0, 0, w, h], items, topology: { vertices: trace.vertices, edges: trace.edges } }
  return materializeDoc(doc)
}

test('planar-edit: real traced quadrants — moving the degree-4 centre junction keeps all 4 regions coincident', () => {
  const doc = tracedDoc(quadrants(16, 16), 16, 16)
  assert.equal(doc.items.length, 4)

  // The centre (8,8) is where all four quadrants meet — the highest-degree vertex.
  const degree = new Map<number, number>()
  for (const e of doc.topology!.edges) {
    if (e.startVertex != null && e.startVertex >= 0) degree.set(e.startVertex, (degree.get(e.startVertex) ?? 0) + 1)
    if (e.endVertex != null && e.endVertex >= 0) degree.set(e.endVertex, (degree.get(e.endVertex) ?? 0) + 1)
  }
  let centre = -1
  let best = 0
  for (const [v, d] of degree) if (d > best) ((best = d), (centre = v))
  assert.ok(best >= 4, `expected a degree-≥4 junction, got ${best}`)

  const v0 = doc.topology!.vertices.find((v) => v.id === centre)!
  const next = moveVertex(doc, centre, 1.5, -0.5)
  const moved = next.topology!.vertices.find((v) => v.id === centre)!
  assert.deepEqual({ x: moved.x, y: moved.y }, { x: v0.x + 1.5, y: v0.y - 0.5 })

  // Every region's cache was rebuilt from the new graph (no stale neighbour).
  assertConsistent(next)
  // All four regions meeting at the centre carry the moved junction, coincident.
  let regionsWithPoint = 0
  for (const it of next.items) if (it.kind === 'path' && has(anchors(it), moved.x, moved.y)) regionsWithPoint++
  assert.equal(regionsWithPoint, 4)
})

test('planar-edit: real traced island — insert + delete on the shared hole edge tracks both regions', () => {
  const island = (w: number, h: number): Int32Array => {
    const L = new Int32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) L[y * w + x] = x >= 6 && x < w - 6 && y >= 6 && y < h - 6 ? 1 : 0
    return L
  }
  const doc = tracedDoc(island(20, 20), 20, 20)
  assert.equal(doc.items.length, 2)
  // The island/background boundary is one shared edge (a closed loop). Find it:
  // the edge referenced by both regions.
  const refCount = new Map<number, number>()
  for (const it of doc.items)
    if (it.kind === 'path' && it.loops)
      for (const loop of it.loops) for (const r of loop) refCount.set(r.edge, (refCount.get(r.edge) ?? 0) + 1)
  const shared = [...refCount.entries()].find(([, c]) => c >= 2)?.[0]
  assert.ok(shared != null, 'expected a shared hole edge referenced by both regions')

  const before = doc.topology!.edges.find((e) => e.id === shared)!.nodes.length
  const inserted = insertNodeOnEdge(doc, shared!, 0, 0.5)
  assert.equal(inserted.topology!.edges.find((e) => e.id === shared)!.nodes.length, before + 1)
  assertConsistent(inserted)

  const deleted = deleteEdgeNode(inserted, shared!, 1)
  assert.equal(deleted.topology!.edges.find((e) => e.id === shared)!.nodes.length, before)
  assertConsistent(deleted)
})

test('planar-edit: deterministic — same op sequence twice yields identical docs', () => {
  const run = (): EditableDoc => {
    let d = makeDoc()
    d = moveEdgeNode(d, ES, 1, 0.25, -0.1)
    d = moveVertex(d, 1, 0.2, 0.2)
    d = insertNodeOnEdge(d, ES, 0, 0.4)
    d = setEdgeNodeKind(d, ES, 1, 'smooth')
    d = moveEdgeHandle(d, ES, 2, 'in', { x: 0.9, y: 1.2 }, true)
    return d
  }
  assert.deepEqual(run(), run())
})

test('planar-edit: chained multi-node drag (two junctions + interior of one edge) moves each target once', () => {
  // A marquee drag can select a junction and an interior node of an edge incident
  // to it in the SAME gesture. translateRegionNodes chains moveVertex/moveEdgeNode
  // on the evolving doc; since provenance carries stable topological ids (vertexId,
  // edgeId, edgeNodeIdx) — never positional indices that a move could shift — each
  // target lands at origin+delta with no double-move or stale index.
  const doc = makeDoc()
  const provA = regionProvenance(doc, pathItem(doc, 'A'))!
  // ES materialized in A as [TL, TM(idx1,junction v1), interior(idx2), BM(idx3,v4), BL].
  const result = translateRegionNodes(
    doc,
    provA,
    [{ sub: 0, idx: 1 }, { sub: 0, idx: 2 }, { sub: 0, idx: 3 }],
    1,
    1,
  )
  const es = findEdge(result, ES)
  assert.equal(es.nodes.length, 3) // no count change, indices stayed valid
  assert.deepEqual({ x: es.nodes[0].x, y: es.nodes[0].y }, { x: 2, y: 1 }) // TM junction +Δ
  assert.deepEqual({ x: es.nodes[1].x, y: es.nodes[1].y }, { x: 2, y: 2 }) // interior +Δ (once)
  assert.deepEqual({ x: es.nodes[2].x, y: es.nodes[2].y }, { x: 2, y: 3 }) // BM junction +Δ
  // The far ends of the other spokes incident to the moved junctions stayed put.
  assert.ok(has(anchors(pathItem(result, 'B')), 2, 1)) // neighbour sees moved TM
  assertConsistent(result)
})
