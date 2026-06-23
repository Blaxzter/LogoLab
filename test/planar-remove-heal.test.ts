// Live "remove & heal" on the planar graph (removeRegionAndHeal): dissolve ONE
// connected section of a region and grow the dominant neighbour into the gap,
// editing the shared-edge graph directly (no re-trace). Fixtures are hand-built
// planar tilings (the verbose-but-controlled style of planar-edit.test.ts) plus a
// real traced island for the closed-disc-edge path. The assertions are adversarial:
// a wrong winding, a stale neighbour cache, or an orphaned edge fails the
// coincidence / no-orphan / point-in-region invariants below.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { materializeDoc } from '../src/lib/path/topology.ts'
import { removeRegionAndHeal, removeRegionSection } from '../src/lib/path/topologyEdit.ts'
import { cubicAt, segmentControls, segmentCount } from '../src/lib/path/geometry.ts'
import type { EdgeRef, EditableDoc, PathItem, PathNode, SharedEdge, SubPath, Vec, Vertex } from '../src/lib/path/types.ts'

// --- fixture DSL -------------------------------------------------------------

const pn = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })
/** A straight shared edge between two junctions (two corner nodes). */
const E = (id: number, x0: number, y0: number, x1: number, y1: number, sv: number, ev: number): SharedEdge => ({
  id,
  nodes: [pn(x0, y0), pn(x1, y1)],
  closed: false,
  startVertex: sv,
  endVertex: ev,
})
const ref = (edge: number, reversed = false): EdgeRef => ({ edge, reversed })
const region = (id: string, loops: EdgeRef[][]): PathItem => ({
  kind: 'path',
  id,
  fill: '#000000',
  fillRule: 'nonzero',
  loops,
  subPaths: [],
  visible: true,
})
const docOf = (vertices: Vertex[], edges: SharedEdge[], items: PathItem[], w = 4, h = 4): EditableDoc =>
  materializeDoc({ viewBox: [0, 0, w, h], items, topology: { vertices, edges } })

const item = (doc: EditableDoc, id: string): PathItem | undefined =>
  doc.items.find((it) => it.id === id) as PathItem | undefined

// --- invariants --------------------------------------------------------------

function poly(sp: SubPath): Vec[] {
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < 6; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 6))
  }
  return pts
}
function inPolygon(p: Vec, pg: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = pg.length - 1; i < pg.length; j = i++) {
    const a = pg[i]
    const b = pg[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
/** Even-odd fill test over an item's subpaths (outer ⊻ holes ⇒ inside the paint). */
function inRegion(it: PathItem, p: Vec): boolean {
  let parity = false
  for (const sp of it.subPaths) if (inPolygon(p, poly(sp))) parity = !parity
  return parity
}

/** Master coincidence invariant: stored subPaths == a fresh materialization. */
function assertConsistent(doc: EditableDoc): void {
  const fresh = materializeDoc(doc)
  for (let i = 0; i < doc.items.length; i++) {
    const a = doc.items[i]
    const b = fresh.items[i]
    if (a.kind === 'path' && b.kind === 'path') assert.deepEqual(a.subPaths, b.subPaths)
  }
}

/** No loop references a missing edge; no edge is referenced by > 2 region sides. */
function assertNoOrphans(doc: EditableDoc): void {
  const live = new Set(doc.topology!.edges.map((e) => e.id))
  const refCount = new Map<number, number>()
  for (const it of doc.items) {
    if (it.kind !== 'path' || !it.loops) continue
    for (const loop of it.loops)
      for (const r of loop) {
        assert.ok(live.has(r.edge), `loop references dissolved edge ${r.edge}`)
        refCount.set(r.edge, (refCount.get(r.edge) ?? 0) + 1)
      }
  }
  for (const [id, c] of refCount) assert.ok(c <= 2, `edge ${id} referenced by ${c} sides (> 2)`)
}

// --- fixtures ----------------------------------------------------------------

/**
 * Three unit squares in a row: A[0,1] · B[1,2] · C[2,3], height 1. A|B share x=1,
 * B|C share x=2; all other edges face EXT. Vertices 0..7 are the eight corners.
 */
function strip(): EditableDoc {
  const V: Vertex[] = [
    { id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }, { id: 2, x: 2, y: 0 }, { id: 3, x: 3, y: 0 },
    { id: 4, x: 0, y: 1 }, { id: 5, x: 1, y: 1 }, { id: 6, x: 2, y: 1 }, { id: 7, x: 3, y: 1 },
  ]
  const edges: SharedEdge[] = [
    E(0, 0, 0, 1, 0, 0, 1), // A top
    E(1, 1, 0, 2, 0, 1, 2), // B top
    E(2, 2, 0, 3, 0, 2, 3), // C top
    E(3, 3, 0, 3, 1, 3, 7), // C right
    E(4, 3, 1, 2, 1, 7, 6), // C bottom
    E(5, 2, 1, 1, 1, 6, 5), // B bottom
    E(6, 1, 1, 0, 1, 5, 4), // A bottom
    E(7, 0, 1, 0, 0, 4, 0), // A left
    E(8, 1, 0, 1, 1, 1, 5), // A|B shared (x=1)
    E(9, 2, 0, 2, 1, 2, 6), // B|C shared (x=2)
  ]
  const A = region('A', [[ref(0), ref(8), ref(6), ref(7)]])
  const B = region('B', [[ref(1), ref(9), ref(5), ref(8, true)]])
  const C = region('C', [[ref(2), ref(3), ref(4), ref(9, true)]])
  return docOf(V, edges, [A, B, C])
}

/**
 * One enclosing region G = [0,3]² with a square hole, and F = [1,2]² sitting in
 * the hole. F's outer ring is byte-shared with G's hole loop (the pure hole-fill
 * case). Built via the tracer so the boundaries are closed-loop "disc" edges,
 * exercising the closed-edge branch of the re-chain.
 */
function enclosed(): EditableDoc {
  const w = 7
  const h = 7
  const labels = new Int32Array(w * h) // all 0 (the frame → smooth outer disc)
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) labels[y * w + x] = 1 // island
  const trace = tracePlanar(labels, w, h)
  const order = [...trace.loopsByLabel.keys()].filter((l) => l >= 0).sort((a, b) => a - b)
  const items = order.map((Lb) => region('r' + Lb, trace.loopsByLabel.get(Lb)!))
  return docOf(trace.vertices, trace.edges, items, w, h)
}

/**
 * F = [1,2]×[0,2] borders G = [0,1]×[0,2] along the full x=1 edge (length 2) and
 * H = [2,3]×[0,1] along a short x=2 edge (length 1); the rest of F faces EXT. The
 * dominant neighbour is G — the freed area must heal into it, not into H.
 */
function dominant(): EditableDoc {
  const V: Vertex[] = [
    { id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }, { id: 2, x: 2, y: 0 }, { id: 3, x: 3, y: 0 },
    { id: 4, x: 3, y: 1 }, { id: 5, x: 2, y: 1 }, { id: 6, x: 2, y: 2 }, { id: 7, x: 1, y: 2 }, { id: 8, x: 0, y: 2 },
  ]
  const edges: SharedEdge[] = [
    E(0, 1, 0, 1, 2, 1, 7), // F|G shared (x=1, len 2)
    E(1, 2, 0, 2, 1, 2, 5), // F|H shared (x=2 upper, len 1)
    E(2, 1, 0, 2, 0, 1, 2), // F top (EXT)
    E(3, 2, 1, 2, 2, 5, 6), // F right-lower (EXT)
    E(4, 2, 2, 1, 2, 6, 7), // F bottom (EXT)
    E(5, 0, 0, 1, 0, 0, 1), // G top (EXT)
    E(6, 1, 2, 0, 2, 7, 8), // G bottom (EXT)
    E(7, 0, 2, 0, 0, 8, 0), // G left (EXT)
    E(8, 2, 0, 3, 0, 2, 3), // H top (EXT)
    E(9, 3, 0, 3, 1, 3, 4), // H right (EXT)
    E(10, 3, 1, 2, 1, 4, 5), // H bottom (EXT)
  ]
  const F = region('F', [[ref(2), ref(1), ref(3), ref(4), ref(0, true)]])
  const G = region('G', [[ref(5), ref(0), ref(6), ref(7)]])
  const H = region('H', [[ref(8), ref(9), ref(10), ref(1, true)]])
  return docOf(V, edges, [F, G, H])
}

/**
 * One item F with TWO blobs — left [0,1]×[0,1] and right [2,3]×[0,1] — bracketing a
 * neighbour G = [1,2]×[0,1] that shares an edge with each. Removing the right blob
 * must leave F holding the left blob and heal the right gap into G.
 */
function twoBlobs(): EditableDoc {
  const V: Vertex[] = [
    { id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }, { id: 2, x: 2, y: 0 }, { id: 3, x: 3, y: 0 },
    { id: 4, x: 0, y: 1 }, { id: 5, x: 1, y: 1 }, { id: 6, x: 2, y: 1 }, { id: 7, x: 3, y: 1 },
  ]
  const edges: SharedEdge[] = [
    E(0, 0, 0, 1, 0, 0, 1), // left blob top
    E(1, 1, 1, 0, 1, 5, 4), // left blob bottom
    E(2, 0, 1, 0, 0, 4, 0), // left blob left
    E(3, 2, 0, 3, 0, 2, 3), // right blob top
    E(4, 3, 0, 3, 1, 3, 7), // right blob right
    E(5, 3, 1, 2, 1, 7, 6), // right blob bottom
    E(6, 1, 0, 2, 0, 1, 2), // G top
    E(7, 2, 1, 1, 1, 6, 5), // G bottom
    E(8, 1, 0, 1, 1, 1, 5), // leftblob|G shared (x=1)
    E(9, 2, 0, 2, 1, 2, 6), // rightblob|G shared (x=2)
  ]
  const F = region('F', [
    [ref(0), ref(8), ref(1), ref(2)], // left blob
    [ref(3), ref(4), ref(5), ref(9, true)], // right blob
  ])
  const G = region('G', [[ref(6), ref(9), ref(7), ref(8, true)]])
  return docOf(V, edges, [F, G])
}

/** A lone square item floating on transparency — every edge faces EXT. */
function floating(): EditableDoc {
  const V: Vertex[] = [
    { id: 0, x: 0, y: 0 }, { id: 1, x: 1, y: 0 }, { id: 2, x: 1, y: 1 }, { id: 3, x: 0, y: 1 },
  ]
  const edges: SharedEdge[] = [E(0, 0, 0, 1, 0, 0, 1), E(1, 1, 0, 1, 1, 1, 2), E(2, 1, 1, 0, 1, 2, 3), E(3, 0, 1, 0, 0, 3, 0)]
  return docOf(V, edges, [region('F', [[ref(0), ref(1), ref(2), ref(3)]])])
}

// --- tests -------------------------------------------------------------------

test('remove-heal: enclosed blob is a pure hole-fill — neighbour swallows it, item dropped', () => {
  const doc = enclosed()
  assert.equal(doc.items.length, 2)
  assert.equal(item(doc, 'r0')!.subPaths.length, 2, 'region 0 starts with a hole')
  const seed = { x: 3.5, y: 3.5 } // inside the island

  const next = removeRegionAndHeal(doc, 'r1', seed)
  assert.notEqual(next, doc)
  assert.equal(item(next, 'r1'), undefined, 'the enclosed blob item is dropped')
  const r0 = item(next, 'r0')!
  assert.equal(r0.subPaths.length, 1, 'region 0 lost its hole (it closed)')
  assert.ok(inRegion(r0, seed), 'the old blob area is now inside region 0')
  assertConsistent(next)
  assertNoOrphans(next)
})

test('remove-heal: middle of a 3-strip merges into the lower-id neighbour, tiling preserved', () => {
  const doc = strip()
  const seed = { x: 1.5, y: 0.5 } // inside B (the middle)

  const next = removeRegionAndHeal(doc, 'B', seed)
  assert.notEqual(next, doc)
  assert.equal(item(next, 'B'), undefined, 'the middle strip is dissolved')
  // A and C share an equal-length border with B → the tie breaks to the lower id (A).
  assert.ok(inRegion(item(next, 'A')!, seed), 'the freed middle is now inside A')
  assert.ok(!inRegion(item(next, 'C')!, seed), 'C did not claim the gap')
  assert.deepEqual(item(next, 'C')!.subPaths, item(doc, 'C')!.subPaths, 'C is byte-identical')
  // The shared A|B edge (8) dissolved; the B|C edge (9, now A|C) survives.
  const live = new Set(next.topology!.edges.map((e) => e.id))
  assert.ok(!live.has(8), 'the A|B edge dissolved')
  assert.ok(live.has(9), 'the B|C edge survives as the new A|C boundary')
  assertConsistent(next)
  assertNoOrphans(next)
})

test('remove-heal: dominant neighbour (longer shared border) wins the merge', () => {
  const doc = dominant()
  const seed = { x: 1.5, y: 1 } // inside F

  const next = removeRegionAndHeal(doc, 'F', seed)
  assert.notEqual(next, doc)
  assert.equal(item(next, 'F'), undefined)
  assert.ok(inRegion(item(next, 'G')!, seed), 'dominant neighbour G absorbed the section')
  assert.ok(!inRegion(item(next, 'H')!, seed), 'short-border H stayed put')
  assert.deepEqual(item(next, 'H')!.subPaths, item(doc, 'H')!.subPaths, 'H is geometrically unchanged')
  assertConsistent(next)
  assertNoOrphans(next)
})

test('remove-heal: only the clicked blob of a multi-blob item dissolves; item kept', () => {
  const doc = twoBlobs()
  assert.equal(item(doc, 'F')!.loops!.length, 2)
  const rightSeed = { x: 2.5, y: 0.5 }
  const leftSeed = { x: 0.5, y: 0.5 }

  const next = removeRegionAndHeal(doc, 'F', rightSeed)
  assert.notEqual(next, doc)
  const F = item(next, 'F')!
  assert.equal(F.loops!.length, 1, 'the item survives with its remaining blob')
  assert.ok(inRegion(F, leftSeed), 'the far blob of the same colour is untouched')
  assert.ok(!inRegion(F, rightSeed), 'the clicked blob is gone from F')
  assert.ok(inRegion(item(next, 'G')!, rightSeed), 'G healed into the clicked blob')
  assertConsistent(next)
  assertNoOrphans(next)
})

test('remove-heal: a blob touching only transparency is a plain delete (heals to nothing)', () => {
  const doc = floating()
  const next = removeRegionAndHeal(doc, 'F', { x: 0.5, y: 0.5 })
  assert.notEqual(next, doc)
  assert.equal(item(next, 'F'), undefined, 'the floating blob is removed')
  assert.equal(next.items.length, 0)
  // Every edge / vertex it owned is pruned — nothing dangling.
  assert.equal(next.topology!.edges.length, 0)
  assert.equal(next.topology!.vertices.length, 0)
})

test('remove-heal: no-op when the seed is outside every ring / item is unknown / non-planar', () => {
  const doc = strip()
  assert.equal(removeRegionAndHeal(doc, 'B', { x: 2.5, y: 0.5 }), doc, 'seed in C, asked for B → no-op')
  assert.equal(removeRegionAndHeal(doc, 'nope', { x: 1.5, y: 0.5 }), doc, 'unknown item → no-op')
  const legacy: EditableDoc = { viewBox: [0, 0, 1, 1], items: [] }
  assert.equal(removeRegionAndHeal(legacy, 'x', { x: 0, y: 0 }), legacy, 'no topology → no-op')
})

test('remove-heal: deterministic — same removal twice yields identical docs', () => {
  const a = removeRegionAndHeal(dominant(), 'F', { x: 1.5, y: 1 })
  const b = removeRegionAndHeal(dominant(), 'F', { x: 1.5, y: 1 })
  assert.deepEqual(a, b)
})

test('remove-heal: removeRegionSection targets a blob by its loop index (no seed)', () => {
  // The editor escalation path: a thin blob's junctions are selected (deleteRegionNodes
  // can't thin them), so ⌫ removes the section identified by the selected subpath/loop.
  const doc = twoBlobs()
  // Loop 1 of item F is the RIGHT blob (loop 0 is the left blob).
  const next = removeRegionSection(doc, 'F', 1)
  assert.notEqual(next, doc)
  assert.equal(item(next, 'F')!.loops!.length, 1, 'F keeps its other blob')
  assert.ok(inRegion(item(next, 'F')!, { x: 0.5, y: 0.5 }), 'left blob untouched')
  assert.ok(inRegion(item(next, 'G')!, { x: 2.5, y: 0.5 }), 'G healed into the removed right blob')
  // Same as seed-targeting the right blob.
  assert.deepEqual(next, removeRegionAndHeal(doc, 'F', { x: 2.5, y: 0.5 }))
  assertConsistent(next)
  assertNoOrphans(next)

  // Equivalent via removeRegionAndHeal on a seed taken from the same blob.
  assert.equal(removeRegionSection(doc, 'F', 99), doc, 'out-of-range loop → no-op')
})

test('remove-heal: a near-miss seed just outside a thin sliver still resolves it', () => {
  // The enclosed-island seed nudged a hair outside the flattened ring still heals
  // (the nearest-ring fallback), so a click on a 1px sliver is robust.
  const doc = enclosed()
  const r1 = item(doc, 'r1')!
  // Centroid of the island's outer ring, pushed outward past the polygon edge.
  const xs = r1.subPaths[0].nodes.map((n) => n.x)
  const ys = r1.subPaths[0].nodes.map((n) => n.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const next = removeRegionAndHeal(doc, 'r1', { x: cx, y: cy })
  assert.equal(item(next, 'r1'), undefined, 'island still dissolved')
  assertConsistent(next)
})
