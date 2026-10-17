// Outline stroke (src/lib/editor/outlineStroke.ts + strokePieces.ts). The
// assertions read GEOMETRY: the exact rectangle a butt line is, the area a
// curved stroke covers, and — for round caps and joins, where the stroke is
// exactly "every point within half a width of the centre line" — the distance
// of every outline point from the centre line. A node dump would pass a
// polygon of a thousand points; the node-count assertions are what fail it.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, EditableDoc, PathItem, PathNode, Stroke, SubPath, Vec } from '../src/lib/path/types.ts'
import { outlinePath, outlineSelected, outlineTolerance, strokeOutline } from '../src/lib/editor/outlineStroke.ts'
import { dashCentrelines } from '../src/lib/editor/strokePieces.ts'
import { chainArea } from '../src/lib/editor/strokePieces.ts'
import { cubicPoint, subPathCubics } from '../src/lib/editor/bezierFit.ts'
import { ellipseShape, polygonShape, rectShape } from '../src/lib/editor/shapes.ts'

const pt = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

function stroked(subPaths: SubPath[], stroke: Partial<Stroke>, fill = 'none', id = 'p'): PathItem {
  return {
    kind: 'path',
    id,
    fill,
    fillRule: 'nonzero',
    subPaths,
    visible: true,
    stroke: { color: '#ff0000', width: 10, cap: 'butt', join: 'miter', ...stroke },
  }
}

const line = (a: Vec, b: Vec): SubPath => ({ nodes: [pt(a.x, a.y), pt(b.x, b.y)], closed: false })

/** Painted area of closed subpaths under nonzero, for results whose holes wind opposite. */
const area = (sps: SubPath[]) => Math.abs(sps.reduce((acc, sp) => acc + chainArea(subPathCubics(sp.nodes, true)), 0))
const nodes = (sps: SubPath[]) => sps.reduce((acc, sp) => acc + sp.nodes.length, 0)

/** Dense points along the outline. */
function outlinePoints(sps: SubPath[], per = 24): Vec[] {
  return sps.flatMap((sp) =>
    subPathCubics(sp.nodes, true).flatMap((c) => Array.from({ length: per }, (_, k) => cubicPoint(c, k / per))),
  )
}

/** Distance from p to the centre line (sampled densely). */
function centreDistance(sp: SubPath, p: Vec): number {
  const pts = subPathCubics(sp.nodes, sp.closed).flatMap((c) =>
    Array.from({ length: 400 }, (_, k) => cubicPoint(c, k / 399)),
  )
  let best = Infinity
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const L2 = dx * dx + dy * dy
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0
    best = Math.min(best, Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy))
  }
  return best
}

const sorted = (sp: SubPath) => sp.nodes.map((n) => `${+n.x.toFixed(6)},${+n.y.toFixed(6)}`).sort()

test('a straight butt-capped line is exactly its rectangle: four corners, no handles', () => {
  const out = strokeOutline(stroked([line({ x: 10, y: 50 }, { x: 90, y: 50 })], { width: 10 }))
  assert.equal(out.length, 1)
  assert.equal(out[0].nodes.length, 4)
  assert.ok(out[0].nodes.every((n) => n.hIn === null && n.hOut === null))
  assert.deepEqual(sorted(out[0]), ['10,45', '10,55', '90,45', '90,55'])
})

test('a round-capped line is a stadium: two sides, two half discs', () => {
  const sp = line({ x: 10, y: 50 }, { x: 90, y: 50 })
  const out = strokeOutline(stroked([sp], { width: 10, cap: 'round' }))
  assert.equal(out.length, 1)
  assert.ok(out[0].nodes.length <= 8, `${out[0].nodes.length} nodes`)
  const want = 80 * 10 + Math.PI * 25
  assert.ok(Math.abs(area(out) - want) / want < 0.002, `area ${area(out)} vs ${want}`)
  const tol = outlineTolerance(10)
  for (const p of outlinePoints(out)) assert.ok(Math.abs(centreDistance(sp, p) - 5) <= tol, `${p.x},${p.y}`)
})

test('a closed square with miter joins is an outer and an inner square, the hole open', () => {
  const sp: SubPath = { nodes: [pt(10, 10), pt(90, 10), pt(90, 90), pt(10, 90)], closed: true }
  const out = strokeOutline(stroked([sp], { width: 10, join: 'miter' }))
  assert.equal(out.length, 2)
  const [outer, inner] = [...out].sort((a, b) => area([b]) - area([a]))
  assert.deepEqual(sorted(outer), ['5,5', '5,95', '95,5', '95,95'])
  assert.deepEqual(sorted(inner), ['15,15', '15,85', '85,15', '85,85'])
  // Wound against each other, so a nonzero fill leaves the middle open.
  assert.ok(Math.abs(area(out) - (90 * 90 - 70 * 70)) < 1e-6, `area ${area(out)}`)
})

test('a bevel join cuts the corner; a miter past its limit falls back to the bevel', () => {
  const sp: SubPath = { nodes: [pt(10, 90), pt(50, 10), pt(90, 90)], closed: false }
  const tip = (sps: SubPath[]) => Math.min(...sps.flatMap((s) => s.nodes.map((n) => n.y)))
  const miter = strokeOutline(stroked([sp], { width: 10, join: 'miter', miterLimit: 10 }))
  const bevel = strokeOutline(stroked([sp], { width: 10, join: 'bevel' }))
  const limited = strokeOutline(stroked([sp], { width: 10, join: 'miter', miterLimit: 1.5 }))
  // The apex angle is 2·atan(0.5) ≈ 53°: miter ratio 1/sin(26.6°) ≈ 2.24.
  assert.ok(Math.abs(tip(miter) - (10 - 5 * 2.236)) < 0.01, `miter tip ${tip(miter)}`)
  assert.ok(tip(bevel) > tip(miter) + 3)
  assert.ok(Math.abs(tip(limited) - tip(bevel)) < 1e-6, 'over the limit: the bevel')
  assert.ok(nodes(miter) <= 7 && nodes(bevel) <= 8)
})

test('a dashed line comes back as one piece per dash', () => {
  const out = strokeOutline(stroked([line({ x: 0, y: 50 }, { x: 100, y: 50 })], { width: 4, dash: [10, 10] }))
  assert.equal(out.length, 5)
  for (const sp of out) assert.equal(sp.nodes.length, 4)
  assert.ok(Math.abs(area(out) - 5 * 10 * 4) < 0.5, `area ${area(out)}`)
  // An odd pattern repeats twice over, as in SVG: 5 on, 5 off.
  assert.equal(dashCentrelines(line({ x: 0, y: 0 }, { x: 100, y: 0 }), [5]).length, 10)
})

test('a stroked circle is a ring of the analytic area in a handful of curves', () => {
  const sp = ellipseShape({ x: 10, y: 10 }, { x: 90, y: 90 })[0]
  const out = strokeOutline(stroked([sp], { width: 6, join: 'round' }))
  assert.equal(out.length, 2)
  const want = Math.PI * (43 * 43 - 37 * 37)
  assert.ok(Math.abs(area(out) - want) / want < 0.005, `area ${area(out)} vs ${want}`)
  assert.ok(
    out.every((s) => s.nodes.length <= 8),
    `${out.map((s) => s.nodes.length)}`,
  )
})

test('an S-curve with round caps stays within tolerance of the true stroke edge', () => {
  const sp: SubPath = {
    nodes: [
      { x: 10, y: 50, hIn: null, hOut: { x: 30, y: 0 }, kind: 'corner' },
      { x: 50, y: 50, hIn: { x: 40, y: 20 }, hOut: { x: 60, y: 80 }, kind: 'smooth' },
      { x: 90, y: 50, hIn: { x: 70, y: 100 }, hOut: null, kind: 'corner' },
    ],
    closed: false,
  }
  const out = strokeOutline(stroked([sp], { width: 8, cap: 'round', join: 'round' }))
  assert.equal(out.length, 1)
  assert.ok(nodes(out) < 40, `${nodes(out)} nodes`)
  const tol = outlineTolerance(8)
  for (const p of outlinePoints(out)) {
    const d = centreDistance(sp, p)
    assert.ok(Math.abs(d - 4) <= tol, `point ${p.x.toFixed(2)},${p.y.toFixed(2)} is ${d} from the centre`)
  }
})

test('a bend tighter than the stroke folds without cutting a notch in itself', () => {
  // A hairpin whose arms overlap: the stroke is one solid blob, no holes.
  const sp: SubPath = {
    nodes: [
      { x: 10, y: 50, hIn: null, hOut: { x: 60, y: 50 }, kind: 'corner' },
      { x: 10, y: 54, hIn: { x: 60, y: 54 }, hOut: null, kind: 'corner' },
    ],
    closed: false,
  }
  const out = strokeOutline(stroked([sp], { width: 10, cap: 'round', join: 'round' }))
  assert.equal(out.length, 1, 'one outline, no hole')
  const tol = outlineTolerance(10)
  for (const p of outlinePoints(out)) {
    const d = centreDistance(sp, p)
    assert.ok(d >= 5 - tol && d <= 5 + tol, `point ${p.x.toFixed(2)},${p.y.toFixed(2)} is ${d} from the centre`)
  }
})

test('a filled and stroked path becomes a group of fill under outline; stroke-only stays one path', () => {
  let n = 0
  const nextId = () => `n${++n}`
  const sq: SubPath = { nodes: [pt(10, 10), pt(90, 10), pt(90, 90), pt(10, 90)], closed: true }
  const both = outlinePath({ ...stroked([sq], { width: 4, opacity: 0.5 }, '#00ff00', 'a'), name: 'Box' }, nextId)
  assert.ok(both && both.kind === 'group')
  assert.equal(both.id, 'a', 'the group takes the path’s place and id')
  assert.equal(both.name, 'Box')
  const [fill, outline] = both.children as PathItem[]
  assert.equal(fill.fill, '#00ff00')
  assert.equal(fill.stroke, undefined)
  assert.equal(outline.fill, '#ff0000')
  assert.equal(outline.fillOpacity, 0.5, 'the stroke’s opacity becomes the outline’s fill opacity')
  assert.equal(outline.stroke, undefined)
  const only = outlinePath(stroked([line({ x: 0, y: 0 }, { x: 50, y: 0 })], { width: 2 }, 'none', 'b'), nextId)
  assert.ok(only && only.kind === 'path')
  assert.equal(only.id, 'b')
  assert.equal(only.fill, '#ff0000')
  assert.equal(outlinePath({ ...stroked([sq], {}), stroke: undefined }, nextId), null)
})

test('outlineSelected reaches into groups, skips live text, and is null with no stroke', () => {
  const a = stroked([line({ x: 0, y: 0 }, { x: 50, y: 0 })], { width: 2 }, 'none', 'a')
  const plain: PathItem = { ...a, id: 'c', stroke: undefined }
  const text: DocItem = {
    kind: 'group',
    id: 't',
    visible: true,
    children: [{ ...a, id: 'glyph' }],
    text: {
      runs: [{ text: 'A' }],
      style: { font: 'x', size: 10, weight: 400, italic: false, fill: '#000000', tracking: 0 },
      align: 'left',
      lineHeight: 1.2,
      kerning: true,
      matrix: [1, 0, 0, 1, 0, 0],
    },
  }
  const doc: EditableDoc = {
    viewBox: [0, 0, 100, 100],
    items: [{ kind: 'group', id: 'g', visible: true, children: [a] }, plain, text],
  }
  const res = outlineSelected(doc, new Set(['g', 'c', 't']), () => 'x')
  assert.ok(res)
  const g = res.items[0]
  assert.ok(g.kind === 'group' && g.children[0].kind === 'path' && g.children[0].stroke === undefined)
  assert.equal(res.items[1], plain)
  assert.equal(res.items[2], text, 'a live text is left alone')
  assert.equal(
    outlineSelected(doc, new Set(['c']), () => 'x'),
    null,
  )
})

test('a closed rectangle or 4/8/16-gon outlines as a ring under round and bevel joins too', () => {
  // The joins used to be united as one operand of their own, and paper.js's
  // ring ∪ joins dropped the outer contour: the "outline" was the inner hole
  // plus a corner wedge, which a nonzero fill paints as a solid rectangle.
  const shapes: [string, SubPath[]][] = [
    ['rect', rectShape({ x: 10, y: 10 }, { x: 110, y: 70 })],
    ...[4, 8, 16].map((n): [string, SubPath[]] => [`${n}-gon`, polygonShape({ x: 60, y: 60 }, 50, n, 0.3)]),
  ]
  for (const [name, sps] of shapes) {
    for (const join of ['round', 'bevel'] as const) {
      for (const width of [8, 2]) {
        const out = strokeOutline(stroked(sps, { width, join, cap: 'round' }))
        const signed = out.map((sp) => chainArea(subPathCubics(sp.nodes, true)))
        assert.equal(out.length, 2, `${name} ${join} ${width}: outer + inner`)
        assert.ok(signed.some((a) => a > 0) && signed.some((a) => a < 0), `${name} ${join} ${width}: a ring`)
        // About perimeter × width: the ring, not the filled interior.
        const perimeter = sps[0].nodes.reduce((acc, n, i, ns) => {
          const m = ns[(i + 1) % ns.length]
          return acc + Math.hypot(m.x - n.x, m.y - n.y)
        }, 0)
        const ring = area(out)
        assert.ok(Math.abs(ring - perimeter * width) < perimeter * width * 0.1, `${name} ${join} ${width}: ${ring}`)
      }
    }
  }
})
