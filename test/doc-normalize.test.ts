// The normalize pass (src/lib/path/normalize.ts): a traced doc refitted into an
// icon grid — the `normalize: 24` an MCP caller asks for.
//
//   node --test test/doc-normalize.test.ts
//
// What it guards: the art lands centred inside the inset (both axes, whichever
// is long), a stroke's width scales with its geometry and its margin counts in
// the fit, the paper becomes the whole box, gradients and the planar topology
// move with the shapes, and the serialized viewBox is the grid.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { docStats, serializeDoc } from '../src/lib/path/model.ts'
import { artBounds, defaultInset, normalizeDoc } from '../src/lib/path/normalize.ts'
import { paperItem } from '../src/lib/path/paper.ts'
import type { EditableDoc, PathItem, PathNode } from '../src/lib/path/types'

const corner = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

function rect(id: string, x: number, y: number, w: number, h: number, fill = '#000000'): PathItem {
  return {
    kind: 'path',
    id,
    fill,
    fillRule: 'nonzero',
    subPaths: [{ nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)], closed: true }],
    visible: true,
  }
}

function doc(items: PathItem[], size = 100): EditableDoc {
  return { viewBox: [0, 0, size, size], items }
}

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

test('a square mark fills the inner box, centred', () => {
  const out = normalizeDoc(doc([rect('a', 20, 20, 60, 60)]), { size: 24, inset: 2 })
  assert.deepEqual(out.viewBox, [0, 0, 24, 24])
  const b = artBounds(out.items)
  assert.ok(b)
  near(b.x, 2)
  near(b.y, 2)
  near(b.w, 20)
  near(b.h, 20)
})

test('a wide mark is fitted by its long side and centred on the short one', () => {
  const out = normalizeDoc(doc([rect('a', 0, 0, 60, 20)]), { size: 24, inset: 2 })
  const b = artBounds(out.items)
  assert.ok(b)
  near(b.x, 2)
  near(b.w, 20)
  near(b.h, 20 / 3)
  near(b.y, (24 - 20 / 3) / 2)
})

test('a stroke counts half its width in the fit and scales with the geometry', () => {
  const line: PathItem = {
    kind: 'path',
    id: 'l',
    fill: 'none',
    fillRule: 'nonzero',
    subPaths: [{ nodes: [corner(10, 50), corner(90, 50)], closed: false }],
    stroke: { color: '#000000', width: 10, cap: 'round', join: 'round', dash: [4, 2] },
    visible: true,
  }
  const out = normalizeDoc(doc([line]), { size: 24, inset: 2 })
  const path = out.items[0] as PathItem
  // With its round caps the ink spans x 5..95 (90 wide) and y 45..55: scale 20/90.
  const s = 20 / 90
  near(path.stroke?.width ?? 0, 10 * s)
  assert.deepEqual(path.stroke?.dash, [4 * s, 2 * s])
  near(path.subPaths[0].nodes[0].x, 2 + 5 * s)
  near(path.subPaths[0].nodes[1].x, 22 - 5 * s)
  near(path.subPaths[0].nodes[0].y, 12)
  const b = artBounds(out.items)
  assert.ok(b)
  near(b.x, 2)
  near(b.w, 20)
  near(b.h, 10 * s)
})

test('the paper is not fitted — it becomes the whole icon box', () => {
  const out = normalizeDoc(doc([paperItem(100, 100, '#ffffff'), rect('a', 40, 40, 20, 20)]), {
    size: 24,
    inset: 2,
  })
  const paper = out.items[0] as PathItem
  assert.equal(paper.id, 'paper')
  const xs = paper.subPaths[0].nodes.map((n) => n.x)
  const ys = paper.subPaths[0].nodes.map((n) => n.y)
  assert.deepEqual([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], [0, 24, 0, 24])
  const b = artBounds(out.items)
  assert.ok(b)
  near(b.x, 2)
  near(b.w, 20)
})

test('gradient coordinates and the planar topology move with the shapes', () => {
  const shape = rect('g', 20, 20, 60, 60)
  shape.gradient = { type: 'linear', x1: 20, y1: 20, x2: 80, y2: 80, stops: [] }
  const radial = rect('r', 20, 20, 60, 60)
  radial.gradient = { type: 'radial', cx: 50, cy: 50, r: 30, fx: 40, fy: 40, stops: [] }
  const d: EditableDoc = {
    ...doc([shape, radial]),
    topology: {
      vertices: [{ id: 0, x: 20, y: 20 }],
      edges: [{ id: 0, nodes: [corner(20, 20), corner(80, 20)], closed: false, startVertex: 0, endVertex: null }],
    },
  }
  const out = normalizeDoc(d, { size: 24, inset: 2 })
  const g = (out.items[0] as PathItem).gradient
  assert.ok(g && g.type === 'linear')
  near(g.x1, 2)
  near(g.x2, 22)
  const rg = (out.items[1] as PathItem).gradient
  assert.ok(rg && rg.type === 'radial')
  near(rg.cx, 12)
  near(rg.r, 10)
  near(rg.fx ?? 0, 12 - 10 / 3)
  near(out.topology?.vertices[0].x ?? 0, 2)
  near(out.topology?.edges[0].nodes[1].x ?? 0, 22)
})

test('an empty doc only gets the viewBox; stats describe the fitted doc', () => {
  const out = normalizeDoc(doc([]), { size: 24, inset: 2 })
  assert.deepEqual(out.viewBox, [0, 0, 24, 24])
  const fitted = normalizeDoc(doc([rect('a', 0, 0, 10, 10), rect('b', 50, 50, 10, 10, '#ff0000')]), {
    size: 24,
    inset: 2,
  })
  assert.deepEqual(docStats(fitted), { paths: 2, nodes: 8, colors: 2 })
})

test('serialized at two decimals, the viewBox is the grid', () => {
  const out = normalizeDoc(doc([rect('a', 7, 7, 33, 33)]), { size: 24, inset: 2 })
  const svg = serializeDoc(out, 2)
  assert.match(svg, /viewBox="0 0 24 24"/)
  assert.match(svg, /d="M2 2L22 2L22 22L2 22Z"/)
})

test('the default inset is a twelfth of the box', () => {
  assert.equal(defaultInset(24), 2)
  assert.equal(defaultInset(16), 1)
  assert.equal(defaultInset(512), 43)
})
