// The boundary solve (src/lib/trace/planarSolve.ts): its renderer must be an exact box filter,
// and it must move a wrong boundary back onto what the raster shows without adding a node.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EdgeRef, PathNode, SharedEdge } from '../src/lib/path/types.ts'
import { depositLine, solveBoundaries } from '../src/lib/trace/planarSolve.ts'

const node = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

/** A rectangle of label 0 on a page of label 1, as a closed edge, with the frame as a second one. */
function rectScene(w: number, h: number, r: { x0: number; y0: number; x1: number; y1: number }) {
  const inner: SharedEdge = {
    id: 0,
    closed: true,
    startVertex: null,
    endVertex: null,
    // Down the left side, along the bottom, up the right: positive in the accumulation buffer.
    nodes: [node(r.x0, r.y0), node(r.x0, r.y1), node(r.x1, r.y1), node(r.x1, r.y0)],
  }
  const frame: SharedEdge = {
    id: 1,
    closed: true,
    startVertex: null,
    endVertex: null,
    nodes: [node(0, 0), node(0, h), node(w, h), node(w, 0)],
  }
  const loops = new Map<number, EdgeRef[][]>([
    [0, [[{ edge: 0, reversed: false }]]],
    [1, [[{ edge: 1, reversed: false }], [{ edge: 0, reversed: true }]]],
    [-1, [[{ edge: 1, reversed: true }]]],
  ])
  return { edges: [inner, frame], loops }
}

/** Exact box-filtered raster of an axis-aligned rectangle. */
function rectRaster(
  w: number,
  h: number,
  r: { x0: number; y0: number; x1: number; y1: number },
  ink: number[],
  page: number[],
) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const cx = Math.max(0, Math.min(x + 1, r.x1) - Math.max(x, r.x0))
      const cy = Math.max(0, Math.min(y + 1, r.y1) - Math.max(y, r.y0))
      const c = cx * cy
      const o = (y * w + x) * 4
      for (let k = 0; k < 3; k++) data[o + k] = ink[k] * c + page[k] * (1 - c)
      data[o + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

test('the accumulation buffer is an exact box filter', () => {
  const w = 8
  const h = 6
  const acc = new Float64Array((w + 2) * h * 4)
  const c = [1, 1, 1, 1]
  // A triangle: (2,1) (2,5) (6,5), area 8.
  depositLine(acc, w, h, 2, 1, 2, 5, c)
  depositLine(acc, w, h, 2, 5, 6, 5, c)
  depositLine(acc, w, h, 6, 5, 2, 1, c)
  let total = 0
  for (let y = 0; y < h; y++) {
    let run = 0
    for (let x = 0; x < w; x++) {
      run += acc[(y * (w + 2) + x) * 4]
      total += run
    }
  }
  assert.ok(Math.abs(total - 8) < 1e-9, `area ${total}`)
})

test('a segment leaving the raster on the right still closes its row', () => {
  const w = 4
  const h = 2
  const acc = new Float64Array((w + 2) * h * 4)
  const c = [1, 0, 0, 0]
  depositLine(acc, w, h, 1, 0, 1, 2, c)
  depositLine(acc, w, h, 9, 2, 9, 0, c)
  let run = 0
  for (let x = 0; x < w; x++) run += acc[(0 * (w + 2) + x) * 4]
  assert.ok(Math.abs(run - 1) < 1e-9, `last pixel of the row reads ${run}`)
})

test('a boundary placed wrong comes back to where the raster has it', () => {
  const w = 32
  const h = 32
  const truth = { x0: 8.3, y0: 9.4, x1: 24.6, y1: 21.7 }
  const off = { x0: 8.7, y0: 9.1, x1: 24.2, y1: 22.05 }
  const image = rectRaster(w, h, truth, [200, 30, 40], [255, 255, 255])
  const { edges, loops } = rectScene(w, h, off)
  const nodesBefore = edges[0].nodes.length
  const report = solveBoundaries({
    vertices: [],
    edges,
    loopsByLabel: loops,
    palette: [
      { r: 200, g: 30, b: 40 },
      { r: 255, g: 255, b: 255 },
    ],
    isFlat: () => true,
    image,
  })
  assert.ok(report, 'solved')
  assert.ok(report.after < report.before * 0.01, `energy ${report.before} → ${report.after}`)
  assert.equal(edges[0].nodes.length, nodesBefore)
  const [a, , c] = edges[0].nodes
  // 8-bit colour limits how well a coverage can be read, not the method.
  assert.ok(Math.abs(a.x - truth.x0) < 0.02, `x0 ${a.x}`)
  assert.ok(Math.abs(a.y - truth.y0) < 0.02, `y0 ${a.y}`)
  assert.ok(Math.abs(c.x - truth.x1) < 0.02, `x1 ${c.x}`)
  assert.ok(Math.abs(c.y - truth.y1) < 0.02, `y1 ${c.y}`)
})

test('the frame does not move and a non-flat region keeps its edges', () => {
  const w = 24
  const h = 24
  const truth = { x0: 6.3, y0: 6.3, x1: 18.6, y1: 18.6 }
  const off = { x0: 6.8, y0: 6.1, x1: 18.1, y1: 18.9 }
  const image = rectRaster(w, h, truth, [10, 10, 10], [255, 255, 255])
  const a = rectScene(w, h, off)
  solveBoundaries({
    vertices: [],
    edges: a.edges,
    loopsByLabel: a.loops,
    palette: [
      { r: 10, g: 10, b: 10 },
      { r: 255, g: 255, b: 255 },
    ],
    isFlat: () => true,
    image,
  })
  assert.deepEqual(
    a.edges[1].nodes.map((n) => [n.x, n.y]),
    [
      [0, 0],
      [0, h],
      [w, h],
      [w, 0],
    ],
  )
  const b = rectScene(w, h, off)
  solveBoundaries({
    vertices: [],
    edges: b.edges,
    loopsByLabel: b.loops,
    palette: [
      { r: 10, g: 10, b: 10 },
      { r: 255, g: 255, b: 255 },
    ],
    isFlat: (l) => l !== 0,
    image,
  })
  assert.equal(b.edges[0].nodes[0].x, off.x0)
  assert.equal(b.edges[0].nodes[0].y, off.y0)
})

test('a smooth node keeps its two handles on one line', () => {
  const w = 40
  const h = 40
  // A disc as four cubics, nudged, against the raster of the true disc.
  const R = 12
  const cx = 20.2
  const cy = 19.7
  const k = 0.5522847 * R
  const smooth = (x: number, y: number, ix: number, iy: number, ox: number, oy: number): PathNode => ({
    x,
    y,
    hIn: { x: ix, y: iy },
    hOut: { x: ox, y: oy },
    kind: 'smooth',
  })
  const d = 0.4
  const edge: SharedEdge = {
    id: 0,
    closed: true,
    startVertex: null,
    endVertex: null,
    nodes: [
      smooth(cx - R + d, cy, cx - R + d, cy - k, cx - R + d, cy + k),
      smooth(cx, cy + R, cx - k, cy + R, cx + k, cy + R),
      smooth(cx + R - d, cy, cx + R - d, cy + k, cx + R - d, cy - k),
      smooth(cx, cy - R, cx + k, cy - R, cx - k, cy - R),
    ],
  }
  const frame: SharedEdge = {
    id: 1,
    closed: true,
    startVertex: null,
    endVertex: null,
    nodes: [node(0, 0), node(0, h), node(w, h), node(w, 0)],
  }
  const loops = new Map<number, EdgeRef[][]>([
    [0, [[{ edge: 0, reversed: false }]]],
    [1, [[{ edge: 1, reversed: false }], [{ edge: 0, reversed: true }]]],
    [-1, [[{ edge: 1, reversed: true }]]],
  ])
  const data = new Uint8ClampedArray(w * h * 4)
  const S = 8
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0
      for (let j = 0; j < S; j++) {
        for (let i = 0; i < S; i++) {
          if (Math.hypot(x + (i + 0.5) / S - cx, y + (j + 0.5) / S - cy) <= R) hit++
        }
      }
      const c = hit / (S * S)
      const o = (y * w + x) * 4
      data[o] = 40 * c + 255 * (1 - c)
      data[o + 1] = 90 * c + 255 * (1 - c)
      data[o + 2] = 200 * c + 255 * (1 - c)
      data[o + 3] = 255
    }
  }
  const report = solveBoundaries({
    vertices: [],
    edges: [edge, frame],
    loopsByLabel: loops,
    palette: [
      { r: 40, g: 90, b: 200 },
      { r: 255, g: 255, b: 255 },
    ],
    isFlat: () => true,
    image: { data, width: w, height: h },
  })
  assert.ok(report && report.after < report.before * 0.2, `energy ${report?.before} → ${report?.after}`)
  for (const n of edge.nodes) {
    const ax = n.x - n.hIn!.x
    const ay = n.y - n.hIn!.y
    const bx = n.hOut!.x - n.x
    const by = n.hOut!.y - n.y
    const cross = Math.abs(ax * by - ay * bx) / (Math.hypot(ax, ay) * Math.hypot(bx, by))
    assert.ok(cross < 1e-6, `handles break by ${cross}`)
  }
})
