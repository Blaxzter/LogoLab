// Simplify path (src/lib/editor/simplify.ts). Every case measures the result
// against the ORIGINAL drawing — a simplify that drops nodes by drifting off the
// shape would pass a node count and fail here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { EditableDoc, PathItem, PathNode, SubPath, Vec } from '../src/lib/path/types.ts'
import {
  nodeTotal,
  pathReach,
  percentSlider,
  simplifyPath,
  simplifySelected,
  simplifySubPath,
  sliderPercent,
} from '../src/lib/editor/simplify.ts'
import { cubicPoint, subPathCubics } from '../src/lib/editor/bezierFit.ts'
import { rectShape } from '../src/lib/editor/shapes.ts'

const pt = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

function path(subPaths: SubPath[], id = 'p'): PathItem {
  return { kind: 'path', id, fill: '#000000', fillRule: 'nonzero', subPaths, visible: true }
}

/** Dense points along a subpath. */
function samples(sp: SubPath, per = 40): Vec[] {
  return subPathCubics(sp.nodes, sp.closed).flatMap((c) =>
    Array.from({ length: per + 1 }, (_, k) => cubicPoint(c, k / per)),
  )
}

/** Largest distance from any point of `a` to the polyline through `b`'s samples. */
function hausdorffOneWay(a: Vec[], b: Vec[], closed: boolean): number {
  let worst = 0
  for (const p of a) {
    let best = Infinity
    const m = closed ? b.length : b.length - 1
    for (let i = 0; i < m; i++) {
      const q = b[i]
      const r = b[(i + 1) % b.length]
      const dx = r.x - q.x
      const dy = r.y - q.y
      const L2 = dx * dx + dy * dy
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / L2)) : 0
      best = Math.min(best, Math.hypot(p.x - q.x - t * dx, p.y - q.y - t * dy))
    }
    worst = Math.max(worst, best)
  }
  return worst
}

const deviation = (orig: SubPath, next: SubPath) => {
  const a = samples(orig)
  const b = samples(next)
  return Math.max(hausdorffOneWay(a, b, orig.closed), hausdorffOneWay(b, a, orig.closed))
}

const polygonCircle = (cx: number, cy: number, r: number, n: number): SubPath => ({
  nodes: Array.from({ length: n }, (_, i) =>
    pt(cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)),
  ),
  closed: true,
})

test('a circle drawn as 200 line segments simplifies to a few smooth cubics within tolerance', () => {
  const sp = polygonCircle(100, 100, 80, 200)
  const tol = 0.4
  const out = simplifySubPath(sp, tol)
  assert.ok(out.nodes.length <= 8, `${out.nodes.length} nodes`)
  assert.ok(out.nodes.length >= 3)
  assert.ok(out.closed)
  const dev = deviation(sp, out)
  assert.ok(dev <= tol * 1.05, `deviation ${dev}`)
  // A circle has no corners: every kept node is smooth.
  assert.ok(
    out.nodes.every((n) => n.kind === 'smooth'),
    'every node smooth',
  )
})

test('a rectangle stays a four-corner rectangle', () => {
  const [sp] = rectShape({ x: 10, y: 10 }, { x: 90, y: 60 })
  assert.equal(simplifySubPath(sp, 2), sp, 'nothing to remove: the same object')
})

test('a rectangle with collinear clutter loses the clutter and keeps its sharp corners', () => {
  const nodes: PathNode[] = []
  for (let x = 0; x < 100; x += 10) nodes.push(pt(x, 0))
  for (let y = 0; y < 50; y += 5) nodes.push(pt(100, y))
  for (let x = 100; x > 0; x -= 20) nodes.push(pt(x, 50))
  nodes.push(pt(0, 50), pt(0, 25))
  const sp: SubPath = { nodes, closed: true }
  const out = simplifySubPath(sp, 0.5)
  assert.equal(out.nodes.length, 4)
  assert.ok(
    out.nodes.every((n) => n.hIn === null && n.hOut === null),
    'straight sides',
  )
  const corners = out.nodes.map((n) => `${n.x},${n.y}`).sort()
  assert.deepEqual(corners, ['0,0', '0,50', '100,0', '100,50'])
})

test('a rounded rectangle keeps its straight sides as lines', () => {
  const [sp] = rectShape({ x: 0, y: 0 }, { x: 100, y: 60 }, 12)
  // Densify: every segment split into four, so there is something to remove.
  const dense = { closed: true, nodes: [] as PathNode[] }
  for (const c of subPathCubics(sp.nodes, true)) {
    for (let k = 0; k < 4; k++) dense.nodes.push(pt(cubicPoint(c, k / 4).x, cubicPoint(c, k / 4).y))
  }
  const out = simplifySubPath(dense, 0.3)
  assert.ok(out.nodes.length < dense.nodes.length, `${dense.nodes.length} → ${out.nodes.length}`)
  assert.ok(deviation(dense, out) <= 0.31, `deviation ${deviation(dense, out)}`)
  // Each side is a single handle-less line from one arc to the next.
  const lines = subPathCubics(out.nodes, true).filter(
    (c) => c.c1.x === c.p0.x && c.c1.y === c.p0.y && c.c2.x === c.p3.x && c.c2.y === c.p3.y,
  )
  const long = lines.filter((c) => Math.hypot(c.p3.x - c.p0.x, c.p3.y - c.p0.y) > 30)
  assert.equal(long.length, 4, 'four long straight sides')
})

test('an open polyline stays open with its ends where they were', () => {
  const nodes = Array.from({ length: 60 }, (_, i) => pt(i * 2, 20 * Math.sin(i / 10)))
  const sp: SubPath = { nodes, closed: false }
  const out = simplifySubPath(sp, 0.25)
  assert.equal(out.closed, false)
  assert.ok(out.nodes.length < 15, `${out.nodes.length}`)
  assert.deepEqual([out.nodes[0].x, out.nodes[0].y], [nodes[0].x, nodes[0].y])
  const last = out.nodes[out.nodes.length - 1]
  assert.deepEqual([last.x, last.y], [nodes[59].x, nodes[59].y])
  assert.ok(deviation(sp, out) <= 0.26)
})

test('a path with no redundancy comes back unchanged', () => {
  const tri: SubPath = { nodes: [pt(0, 0), pt(50, 0), pt(25, 40)], closed: true }
  assert.equal(simplifySubPath(tri, 1), tri)
  const star: SubPath = {
    nodes: Array.from({ length: 10 }, (_, i) => {
      const r = i % 2 ? 20 : 50
      const a = (Math.PI * i) / 5
      return pt(50 + r * Math.cos(a), 50 + r * Math.sin(a))
    }),
    closed: true,
  }
  assert.equal(simplifySubPath(star, 1), star)
})

test('holes are simplified on their own and survive', () => {
  const item = path([polygonCircle(50, 50, 40, 120), polygonCircle(50, 50, 20, 90)])
  const out = simplifyPath(item, 0.3)
  assert.equal(out.subPaths.length, 2)
  out.subPaths.forEach((sp, i) => assert.ok(deviation(item.subPaths[i], sp) <= 0.31))
  assert.ok(out.subPaths.every((sp) => sp.closed && sp.nodes.length >= 2 && sp.nodes.length <= 8))
})

test('simplifySelected reports before → after and reaches into groups, not texts', () => {
  const a = path([polygonCircle(50, 50, 40, 100)], 'a')
  const b = path([polygonCircle(50, 50, 40, 100)], 'b')
  const doc: EditableDoc = {
    viewBox: [0, 0, 100, 100],
    items: [{ kind: 'group', id: 'g', children: [a], visible: true }, b],
  }
  const res = simplifySelected(doc, new Set(['g']), 0.5)
  assert.equal(res.before, 100)
  assert.ok(res.after <= 8 && res.after >= 3, `${res.after}`)
  const g = res.doc.items[0]
  assert.ok(g.kind === 'group' && g.children[0].kind === 'path' && nodeTotal(g.children[0]) === res.after)
  assert.equal(res.doc.items[1], b, 'unselected path untouched')
  const none = simplifySelected(doc, new Set(), 0.5)
  assert.equal(none.doc, doc)
})

test('the tolerance slider is log-scaled and round-trips', () => {
  assert.ok(Math.abs(sliderPercent(0) - 0.05) < 1e-12)
  assert.ok(Math.abs(sliderPercent(100) - 5) < 1e-12)
  assert.ok(Math.abs(sliderPercent(50) - 0.5) < 1e-9, 'the middle is the geometric mean')
  for (const p of [0.05, 0.2, 1, 3.3]) assert.ok(Math.abs(sliderPercent(percentSlider(p)) - p) < 1e-9)
})

test('pathReach counts stroked and simplifiable paths, and selected texts', () => {
  const stroked: PathItem = {
    ...path([{ nodes: [pt(0, 0), pt(10, 0)], closed: false }], 's'),
    stroke: { color: '#000000', width: 2, cap: 'butt', join: 'miter' },
  }
  const hidden: PathItem = { ...stroked, id: 'h', stroke: { ...stroked.stroke!, opacity: 0 } }
  const tri = path([{ nodes: [pt(0, 0), pt(10, 0), pt(5, 8)], closed: true }], 't')
  const doc: EditableDoc = { viewBox: [0, 0, 100, 100], items: [stroked, hidden, tri] }
  assert.deepEqual(pathReach(doc.items, new Set(['s', 'h', 't'])), { stroked: 1, simplifiable: 1, texts: 0 })
  assert.deepEqual(pathReach(doc.items, new Set()), { stroked: 0, simplifiable: 0, texts: 0 })
})

test('an open preview is never reported outward: the session base stands in until Apply', async () => {
  const { reportedDoc } = await import('../src/lib/editor/simplify.ts')
  const base: EditableDoc = { viewBox: [0, 0, 10, 10], items: [] }
  const shown: EditableDoc = { viewBox: [0, 0, 10, 10], items: [] }
  const edited: EditableDoc = { viewBox: [0, 0, 10, 10], items: [] }
  const session = { base, selection: new Set<string>(), shown }
  assert.equal(reportedDoc(shown, session), base)
  // An edit that ended the session is the drawing now.
  assert.equal(reportedDoc(edited, session), edited)
  assert.equal(reportedDoc(shown, null), shown)
})
