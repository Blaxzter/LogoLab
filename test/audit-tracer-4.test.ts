// Audit finding 4: `weldCrossings` placed the welded node three-quarters of the way
// from A to B. `mergeNodes` had already moved A to the pixel-weighted centroid of A and
// B, and the weld then averaged THAT with B a second time. The weld's contract (its
// comment: "A sits between") is the midpoint of the two Y-junctions it contracts.
//
//   node --test test/audit-tracer-4.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { weldCrossings, type SkelChain, type SkelNode, type SkeletonGraph } from '../src/lib/trace/centerline/graph.ts'

const W = 41
const H = 41

/** Pixel indices along a line from (x0,y0) to (x1,y1), both ends included. */
function line(x0: number, y0: number, x1: number, y1: number): number[] {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))
  const out: number[] = []
  for (let i = 0; i <= n; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / n)
    const y = Math.round(y0 + ((y1 - y0) * i) / n)
    out.push(y * W + x)
  }
  return out
}

function chain(id: number, pixels: number[], a: number, b: number): SkelChain {
  return { id, pixels, a, b, closed: false, len: pixels.length - 1, alive: true }
}

function node(id: number, x: number, y: number, chains: number[]): SkelNode {
  return { id, x, y, r: 1, pixels: [y * W + x], chains, alive: true }
}

test('a welded split crossing sits midway between its two junctions', () => {
  // Two lines crossing at a shallow angle, thinned to two Y-junctions A (10,20) and
  // B (20,20) joined by a horizontal run. Line 1: (0,15) → A → B → (30,25);
  // line 2: (0,25) → A → B → (30,15). Each arm runs node-ward from a to b.
  const chains: SkelChain[] = [
    chain(0, line(11, 20, 19, 20), 0, 1), // mid: A → B
    chain(1, line(0, 15, 9, 20), -1, 0), // into A from upper-left
    chain(2, line(0, 25, 9, 20), -1, 0), // into A from lower-left
    chain(3, line(30, 25, 21, 20), -1, 1), // into B from lower-right
    chain(4, line(30, 15, 21, 20), -1, 1), // into B from upper-right
  ]
  const nodes: SkelNode[] = [node(0, 10, 20, [0, 1, 2]), node(1, 20, 20, [0, 3, 4])]
  const g: SkeletonGraph = { nodes, chains, width: W, height: H }
  const dt = new Float32Array(W * H).fill(1)

  weldCrossings(g, dt)

  assert.equal(nodes[1].alive, false, 'B folded into A')
  assert.equal(chains[0].alive, false, 'mid chain dropped')
  assert.ok(nodes[0].welded)
  assert.ok(Math.abs(nodes[0].x - 15) < 1e-9, `welded x ${nodes[0].x}, expected the midpoint 15`)
  assert.ok(Math.abs(nodes[0].y - 20) < 1e-9, `welded y ${nodes[0].y}, expected 20`)
})
