// §10 scale-relative fidelity (docs/vectorization-benchmarks.md §10) — the
// discrimination property, proven on synthetic shapes the truth corpus lacks.
//
// The circle/ellipse/disc SNAP in planarBeautify accepts on RADIAL deviation ≤
// fidelity — a SIZE-relative test, so a small square (radially circle-close) rounds
// into a blob (§9.8). §9.8 fixed it with a corner-turn veto. §10's claim is that a
// scale-relative tolerance `min(fidelity, k·localScale)` SUBSUMES that veto AND is
// more general: it discriminates a small SQUARE from a small CIRCLE by SCALE alone,
// with the corner-turn veto turned OFF.
//
// These tests pin exactly that, with `cornerVeto: false` so the veto cannot be doing
// the work — only the scale-relative tolerance can:
//   • a small SQUARE is NOT rounded (its 0.18·r deviation exceeds k·r), and
//   • a genuine small CIRCLE of the SAME scale IS still snapped (its ~0.05·r
//     deviation stays under k·r) — no regression, and
//   • with k = 0 (absolute px, veto off) the same square DOES round — proving the
//     scale term, not something else, is what saves it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { planarBeautify, type SnapOptions } from '../src/lib/trace/planarBeautify.ts'
import { DEFAULT_BEAUTIFY_OPTIONS } from '../src/lib/trace/beautify.ts'
import type { EdgeRef, PathNode } from '../src/lib/path/types.ts'

const OPTS = { ...DEFAULT_BEAUTIFY_OPTIONS } // fidelity 1.5

/** A filled disc of label 1 in a field of label 0. */
function disc(w: number, h: number, cx: number, cy: number, r: number): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = (x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 1 : 0
  return L
}

/** A filled axis-aligned square of label 1 (half-side `a`) in a field of label 0. */
function square(w: number, h: number, cx: number, cy: number, a: number): Int32Array {
  const L = new Int32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[y * w + x] = Math.abs(x - cx) <= a && Math.abs(y - cy) <= a ? 1 : 0
  return L
}

/** The closed boundary edge of the FILLED shape (label 1) — not the field's own
 *  outer border against the canvas edge, which is also a closed loop. */
function shapeEdgeNodes(L: Int32Array, w: number, h: number, snap: SnapOptions): PathNode[] {
  const trace = tracePlanar(L, w, h)
  const shapeLoops = trace.loopsByLabel.get(1)
  assert.ok(shapeLoops && shapeLoops.length === 1 && shapeLoops[0].length === 1, 'the filled shape is one closed single-edge loop')
  const eid = shapeLoops[0][0].edge
  const topo = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS, snap)
  return topo.edges.find((e) => e.id === eid)!.nodes
}

/** A loop is a snapped primitive iff every node is a smooth kappa-Bézier node with
 *  two handles (makeCircleSubPath / makeEllipseSubPath emit exactly that). A raw
 *  polygon (unsnapped square) has corner nodes with no handles. */
const isRoundedPrimitive = (nodes: PathNode[]): boolean =>
  nodes.length >= 4 && nodes.every((n) => n.kind === 'smooth' && !!n.hIn && !!n.hOut)

const K = 0.15 // nominal coefficient — mid-window (checker fixed ≤0.20, circles safe ≥0.10)

test('scale-fidelity: a small square is NOT rounded when the tolerance tracks its scale (veto off)', () => {
  // An 11px square (half-side 5) in a 40² field: small enough that absolute fidelity
  // (1.5px) rounds it, but its 0.18·r deviation exceeds the scale-relative k·r.
  const nodes = shapeEdgeNodes(square(40, 40, 20, 20, 5), 40, 40, { cornerVeto: false, localScaleK: K })
  assert.equal(isRoundedPrimitive(nodes), false, 'scale-relative ε must refuse to round a small square')
})

test('scale-fidelity: the SAME small square DOES round at k=0 (absolute px, veto off) — the §9.8 bug', () => {
  const nodes = shapeEdgeNodes(square(40, 40, 20, 20, 5), 40, 40, { cornerVeto: false, localScaleK: 0 })
  assert.equal(isRoundedPrimitive(nodes), true, 'absolute-px fidelity rounds a small square (this is what §10 fixes)')
})

test('scale-fidelity: a genuine small circle of the same scale IS still snapped (no regression, veto off)', () => {
  const nodes = shapeEdgeNodes(disc(40, 40, 20, 20, 7), 40, 40, { cornerVeto: false, localScaleK: K })
  assert.equal(isRoundedPrimitive(nodes), true, 'a real small circle must still snap under scale-relative ε')
  assert.equal(nodes.length, 4, 'circle snap emits a 4-node kappa-Bézier')
})

test('scale-fidelity: default snap options are byte-identical to the shipped path (k=0, veto on)', () => {
  const sq = square(40, 40, 20, 20, 5)
  const a = shapeEdgeNodes(sq, 40, 40, {})
  const b = shapeEdgeNodes(sq, 40, 40, { arcSnap: true, localScaleK: 0, cornerVeto: true })
  assert.deepEqual(a, b)
  // …and the shipped path (veto on) also refuses to round the square — same outcome
  // scale-relative ε reaches without the veto.
  assert.equal(isRoundedPrimitive(a), false)
})
