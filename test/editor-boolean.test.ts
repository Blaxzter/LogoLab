// Shape booleans (src/lib/editor/boolean.ts). The assertions measure AREA and
// CURVES, because the two ways a boolean goes wrong are silent in a data dump: a
// result that is the right outline but wound so it fills the hole, and a result
// that is right but has been flattened to a polygon.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, EditableDoc, GroupItem, PathItem } from '../src/lib/path/types.ts'
import { booleanSelected, mergeOverlaps } from '../src/lib/editor/boolean.ts'
import { ellipseShape, rectShape } from '../src/lib/editor/shapes.ts'
import { flattenSubPath } from '../src/lib/editor/hitTest.ts'

function path(id: string, subPaths: PathItem['subPaths'], fill = '#ff0000'): PathItem {
  return { kind: 'path', id, fill, fillRule: 'nonzero', subPaths, visible: true }
}

const square = (id: string, x: number, y: number, s: number, fill?: string) =>
  path(id, rectShape({ x, y }, { x: x + s, y: y + s }), fill)
const disc = (id: string, cx: number, cy: number, r: number, fill?: string) =>
  path(id, ellipseShape({ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r }), fill)

function doc(...items: DocItem[]): EditableDoc {
  return { viewBox: [0, 0, 100, 100], items }
}

/** Nonzero winding of `p` around one flattened subpath. */
function winding(p: { x: number; y: number }, poly: { x: number; y: number }[]): number {
  let w = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const side = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y)
    if (a.y <= p.y && b.y > p.y && side > 0) w++
    else if (a.y > p.y && b.y <= p.y && side < 0) w--
  }
  return w
}

/**
 * Painted area under the path's own fill rule, by sampling a 0.25 grid — what a
 * renderer fills, whatever the windings. Exact for the integer-aligned squares.
 */
function area(item: PathItem): number {
  const polys = item.subPaths.map(flattenSubPath)
  let hits = 0
  const step = 0.25
  for (let y = step / 2; y < 100; y += step) {
    for (let x = step / 2; x < 100; x += step) {
      const w = polys.reduce((acc, poly) => acc + winding({ x, y }, poly), 0)
      if (item.fillRule === 'evenodd' ? w % 2 !== 0 : w !== 0) hits++
    }
  }
  return hits * step * step
}

let n = 0
const nextId = () => `new${++n}`

function run(d: EditableDoc, op: Parameters<typeof booleanSelected>[2], ids = d.items.map((i) => i.id)) {
  const res = booleanSelected(d, new Set(ids), op, nextId)
  assert.ok(res, 'boolean ran')
  return res
}

const paths = (d: EditableDoc) => d.items.filter((i): i is PathItem => i.kind === 'path')

test('add: two overlapping squares unite into one shape of the union area', () => {
  const res = run(doc(square('a', 0, 0, 20), square('b', 10, 10, 20)), 'add')
  const out = paths(res.doc)
  assert.equal(out.length, 1)
  assert.equal(out[0].id, 'a', 'the back-most shape keeps its id')
  assert.ok(Math.abs(area(out[0]) - (400 + 400 - 100)) < 1e-6)
})

test('subtract: front shapes are cut out of the back-most one, keeping its paint', () => {
  const res = run(doc(square('a', 0, 0, 40, '#112233'), square('b', 10, 10, 20, '#aabbcc')), 'subtract')
  const [out] = paths(res.doc)
  assert.equal(out.fill, '#112233')
  assert.equal(out.subPaths.length, 2, 'outline + hole')
  assert.ok(Math.abs(area(out) - (1600 - 400)) < 1e-6, `area ${area(out)}`)
})

test('subtract keeps curves: a disc minus a square is arcs, not a polygon', () => {
  const res = run(doc(disc('a', 50, 50, 20), square('b', 50, 0, 100)), 'subtract')
  const [out] = paths(res.doc)
  const curved = out.subPaths[0].nodes.filter((nd) => nd.hIn || nd.hOut).length
  assert.ok(curved >= 2, 'arcs survive as Béziers')
  assert.ok(out.subPaths[0].nodes.length <= 6, `few nodes, got ${out.subPaths[0].nodes.length}`)
  assert.ok(Math.abs(area(out) - (Math.PI * 400) / 2) < 2, `half a disc, got ${area(out)}`)
})

test('intersect: only the overlap remains', () => {
  const res = run(doc(square('a', 0, 0, 20), square('b', 10, 10, 20)), 'intersect')
  const [out] = paths(res.doc)
  assert.ok(Math.abs(area(out) - 100) < 1e-6)
})

test('intersect of shapes that do not touch removes them (Affinity), undo brings them back', () => {
  const res = run(doc(square('a', 0, 0, 10), square('b', 50, 50, 10)), 'intersect')
  assert.equal(res.doc.items.length, 0)
})

test('xor: overlap becomes a hole', () => {
  const res = run(doc(square('a', 0, 0, 20), square('b', 10, 10, 20)), 'xor')
  const out = paths(res.doc)
  const total = out.reduce((a, p) => a + area(p), 0)
  assert.ok(Math.abs(total - (800 - 200)) < 1e-6, `area ${total}`)
})

test('divide: pieces are separate shapes, the overlap painted like the front shape', () => {
  const res = run(doc(square('a', 0, 0, 20, '#ff0000'), square('b', 10, 10, 20, '#0000ff')), 'divide')
  const out = paths(res.doc)
  assert.equal(out.length, 3)
  const byFill = (f: string) => out.filter((p) => p.fill === f).reduce((a, p) => a + area(p), 0)
  assert.ok(Math.abs(byFill('#ff0000') - 300) < 1e-6)
  assert.ok(Math.abs(byFill('#0000ff') - 400) < 1e-6, 'overlap (100) + b alone (300)')
})

test('divide keeps a piece with a hole as ONE shape', () => {
  // A ring cut by a bar: the bar's middle is inside the ring's hole.
  const ring = path('r', [...square('o', 0, 0, 60).subPaths, ...square('i', 10, 10, 40).subPaths])
  ring.fillRule = 'evenodd'
  const res = run(doc(ring, square('b', 25, 25, 10, '#0000ff')), 'divide')
  const out = paths(res.doc)
  assert.equal(out.length, 2, 'ring + the bar (in the hole, untouched)')
  const r = out.find((p) => p.fill === '#ff0000')!
  assert.equal(r.subPaths.length, 2)
  assert.ok(Math.abs(area(r) - (3600 - 1600)) < 1e-6)
})

test('the result lands where the back-most operand was; other items keep their place', () => {
  const d = doc(square('x', 80, 80, 5), square('a', 0, 0, 20), square('y', 90, 0, 5), square('b', 10, 10, 20))
  const res = run(d, 'add', ['a', 'b'])
  assert.deepEqual(
    res.doc.items.map((i) => i.id),
    ['x', 'a', 'y'],
  )
})

test('a group is one operand, its paths united first', () => {
  const g: GroupItem = {
    kind: 'group',
    id: 'g',
    children: [square('g1', 0, 0, 20), square('g2', 10, 0, 20)],
    visible: true,
  } as GroupItem
  const res = run(doc(g, square('b', 0, 0, 30)), 'subtract', ['b', 'g'])
  // g is at the back: 30x20 union minus the 30x30 square → nothing left
  assert.equal(res.doc.items.length, 0)
})

test('mergeOverlaps: crossing contours become one outline, a counter stays a hole', () => {
  // An "o" (outline + counter) with a bar overlapping its right side.
  const o = path('o', [
    ...square('a', 0, 0, 40).subPaths,
    // the counter, wound the other way, as a font draws it
    { nodes: [...square('b', 10, 10, 20).subPaths[0].nodes].reverse(), closed: true },
    ...rectShape({ x: 30, y: 15 }, { x: 70, y: 25 }),
  ])
  const merged = mergeOverlaps(o)
  assert.equal(merged.subPaths.length, 2, 'outline + counter, the bar folded in')
  assert.ok(Math.abs(area(merged) - area(o)) < 1e-6, `${area(o)} → ${area(merged)}`)
})

test('mergeOverlaps leaves a single contour alone', () => {
  const s = square('a', 0, 0, 10)
  assert.equal(mergeOverlaps(s), s)
})

test('a script font word merges at its joins without changing what it paints', async () => {
  const { readFileSync } = await import('node:fs')
  const { faceFromBytes } = await import('../src/lib/text/engine.ts')
  const { makeTextGroup, newTextData, replaceText } = await import('../src/lib/text/edit.ts')
  const b = readFileSync(new URL('../public/fonts/pacifico.ttf', import.meta.url))
  const face = faceFromBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
  const data = replaceText(newTextData({ x: 5, y: 60 }, 40, { font: 'p' }), 0, 0, 'Xor')
  const g = makeTextGroup('t', data, () => ({ face, synthItalic: false }))
  const glyphs = g.children[0] as PathItem
  const merged = mergeOverlaps(glyphs)
  assert.ok(merged.subPaths.length < glyphs.subPaths.length, `${glyphs.subPaths.length} → ${merged.subPaths.length}`)
  assert.ok(Math.abs(area(merged) - area(glyphs)) < 1, `${area(glyphs)} → ${area(merged)}`)
})
