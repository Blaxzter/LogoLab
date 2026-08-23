// The SVG editor's pure core: group tree surgery, affine transforms, the
// transform-box grip math, direct curve dragging, path ops, shapes, align and
// hit-testing.
//
// These are the parts where a wrong answer is silent — a reversed path renders
// identically until you drag a handle, a grip that scales about the wrong
// anchor only shows up as "the shape crawls away from the cursor". So the
// assertions check GEOMETRY (sample the curve, measure the box), not shapes of
// data structures.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, EditableDoc, GroupItem, PathItem, PathNode, SubPath } from '../src/lib/path/types.ts'
import {
  ancestorsOf,
  findParent,
  groupItems,
  isGroup,
  leafItems,
  removeItems,
  reorderItems,
  ungroup,
} from '../src/lib/path/docTree.ts'
import {
  GRIPS,
  gripAnchor,
  gripPoint,
  itemBox,
  rotateAbout,
  scaleFromGrip,
  selectionBox,
  transformItem,
  transformItems,
  uniformScale,
  translation,
} from '../src/lib/editor/transform.ts'
import { dragSegment, solveSegmentDrag } from '../src/lib/editor/segmentDrag.ts'
import {
  breakAt,
  closeSubPath,
  combinePaths,
  joinEnds,
  openSubPathAt,
  reverseSubPath,
  splitCompound,
} from '../src/lib/editor/pathOps.ts'
import { boxRadius, ellipseShape, lineShape, polygonShape, rectShape, starShape } from '../src/lib/editor/shapes.ts'
import { alignItems, distributeItems } from '../src/lib/editor/align.ts'
import { marqueeItems, marqueeNodes, pickItem, pickNodePart, pointInPath } from '../src/lib/editor/hitTest.ts'
import { collectTargets, DEFAULT_SNAP, snapBoxDelta, snapPoint } from '../src/lib/editor/snapping.ts'
import { affineScale, cubicAt, segmentControls } from '../src/lib/path/geometry.ts'
import { docStats, isStrokeOnly, representativePaint, serializeDoc, subPathsToD } from '../src/lib/path/model.ts'

/* ------------------------------------------------------------- fixtures */

function pn(x: number, y: number, hIn: PathNode['hIn'] = null, hOut: PathNode['hOut'] = null): PathNode {
  return { x, y, hIn, hOut, kind: 'corner' }
}

/** An axis-aligned square path from (x,y) of the given size. */
function square(id: string, x: number, y: number, size: number, fill = '#000000'): PathItem {
  return {
    kind: 'path',
    id,
    fill,
    fillRule: 'nonzero',
    visible: true,
    subPaths: [
      {
        nodes: [pn(x, y), pn(x + size, y), pn(x + size, y + size), pn(x, y + size)],
        closed: true,
      },
    ],
  }
}

function group(id: string, children: DocItem[]): GroupItem {
  return { kind: 'group', id, children, visible: true, expanded: true }
}

function doc(items: DocItem[], size = 100): EditableDoc {
  return { viewBox: [0, 0, size, size], items }
}

const ids = (...s: string[]) => new Set(s)

/* --------------------------------------------------------------- docTree */

test('leafItems flattens groups and prunes hidden subtrees', () => {
  const d = doc([
    square('a', 0, 0, 10),
    group('g', [square('b', 20, 0, 10), square('c', 40, 0, 10)]),
  ])
  assert.deepEqual(leafItems(d.items).map((i) => i.id), ['a', 'b', 'c'])

  // Hiding the FOLDER must hide what's in it, even though b/c stay visible:true.
  const hidden = doc([
    square('a', 0, 0, 10),
    { ...group('g', [square('b', 20, 0, 10)]), visible: false },
  ])
  assert.deepEqual(leafItems(hidden.items).map((i) => i.id), ['a'])
})

test('grouping preserves paint order and lands at the frontmost member', () => {
  // Paint order a,b,c,d — grouping a and c must leave the visible stack as
  // b (below), then the group holding a,c where c was, then d.
  const items = [square('a', 0, 0, 10), square('b', 0, 0, 10), square('c', 0, 0, 10), square('d', 0, 0, 10)]
  const res = groupItems(items, ids('a', 'c'), 'g1')
  assert.ok(res)
  assert.deepEqual(res.items.map((i) => i.id), ['b', 'g1', 'd'])

  const g = res.items[1]
  assert.ok(isGroup(g))
  assert.deepEqual(g.children.map((i) => i.id), ['a', 'c'])
  // Flattened paint order is unchanged apart from a moving up past b, which is
  // unavoidable: a group is contiguous.
  assert.deepEqual(leafItems(res.items).map((i) => i.id), ['b', 'a', 'c', 'd'])
})

test('grouping needs two members and ignores ids nested in a selected group', () => {
  const items = [square('a', 0, 0, 10), group('g', [square('b', 0, 0, 10)])]
  assert.equal(groupItems(items, ids('a'), 'x'), null)
  // 'b' is inside 'g', so selecting both is really selecting just 'g'.
  assert.equal(groupItems(items, ids('g', 'b'), 'x'), null)
})

test('ungroup splices children back in place and keeps a hidden group hidden', () => {
  const items = [square('a', 0, 0, 10), group('g', [square('b', 0, 0, 10), square('c', 0, 0, 10)]), square('d', 0, 0, 10)]
  const out = ungroup(items, 'g')
  assert.ok(out)
  assert.deepEqual(out.map((i) => i.id), ['a', 'b', 'c', 'd'])

  const hiddenG = [{ ...group('g', [square('b', 0, 0, 10)]), visible: false }]
  const out2 = ungroup(hiddenG, 'g')
  assert.ok(out2)
  assert.equal(out2[0].visible, false, 'ungrouping a hidden folder must not reveal its contents')
})

test('ancestorsOf and findParent locate nested items', () => {
  const items = [group('outer', [group('inner', [square('leaf', 0, 0, 10)])])]
  assert.deepEqual(ancestorsOf(items, 'leaf').map((g) => g.id), ['outer', 'inner'])
  const at = findParent(items, 'leaf')
  assert.equal(at?.parent?.id, 'inner')
  assert.equal(at?.index, 0)
})

test('reorder moves items within their own parent only', () => {
  const items = [group('g', [square('a', 0, 0, 10), square('b', 0, 0, 10)]), square('c', 0, 0, 10)]
  const out = reorderItems(items, ids('a'), 'front')
  const g = out[0]
  assert.ok(isGroup(g))
  // 'a' goes to the front OF ITS GROUP — it must not escape into the top level.
  assert.deepEqual(g.children.map((i) => i.id), ['b', 'a'])
  assert.deepEqual(out.map((i) => i.id), ['g', 'c'])
})

test('a contiguous run steps as a block', () => {
  const items = [square('a', 0, 0, 10), square('b', 0, 0, 10), square('c', 0, 0, 10), square('d', 0, 0, 10)]
  const out = reorderItems(items, ids('b', 'c'), 'forward')
  assert.deepEqual(out.map((i) => i.id), ['a', 'd', 'b', 'c'])
})

test('removeItems prunes at any depth', () => {
  const items = [group('g', [square('a', 0, 0, 10), square('b', 0, 0, 10)])]
  const out = removeItems(items, ids('a'))
  const g = out[0]
  assert.ok(isGroup(g))
  assert.deepEqual(g.children.map((i) => i.id), ['b'])
})

/* ------------------------------------------------------------ serialize */

test('serializeDoc emits groups and omits empty ones', () => {
  const withGroup = doc([group('g', [square('a', 0, 0, 10, '#ff0000')])])
  const svg = serializeDoc(withGroup)
  assert.match(svg, /<g><path fill="#ff0000"/)

  // A group whose children are all hidden is structure, not markup.
  const empty = doc([group('g', [{ ...square('a', 0, 0, 10), visible: false }])])
  assert.equal(serializeDoc(empty).includes('<g'), false)
})

test('a flat stroke-free doc serializes exactly as before groups existed', () => {
  const flat = doc([square('a', 1, 2, 10, '#123456')])
  const svg = serializeDoc(flat)
  const d = subPathsToD(flat.items[0] instanceof Object ? (flat.items[0] as PathItem).subPaths : [], 2)
  assert.equal(
    svg,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill="#123456" d="${d}"/></svg>`,
  )
})

test('stroke round-trips through serialization', () => {
  const item = square('a', 0, 0, 10)
  item.stroke = { color: '#00ff00', width: 2.5, cap: 'round', join: 'round', dash: [4, 2], opacity: 0.5 }
  const svg = serializeDoc(doc([item]))
  assert.match(svg, /stroke="#00ff00"/)
  assert.match(svg, /stroke-width="2.5"/)
  assert.match(svg, /stroke-linecap="round"/)
  assert.match(svg, /stroke-dasharray="4 2"/)
  assert.match(svg, /stroke-opacity="0.5"/)
  // Defaults stay off the wire.
  const plain = square('b', 0, 0, 10)
  plain.stroke = { color: '#000000', width: 1, cap: 'butt', join: 'miter' }
  const svg2 = serializeDoc(doc([plain]))
  assert.equal(svg2.includes('stroke-linecap'), false)
  assert.equal(svg2.includes('stroke-linejoin'), false)
})

/* -------------------------------------------------------- stroke-only paths */

test('a stroke-only path reports its stroke as the colour it shows', () => {
  const item = square('a', 0, 0, 10)
  item.fill = 'none'
  item.stroke = { color: '#ff8800', width: 4, cap: 'round', join: 'round' }
  assert.equal(isStrokeOnly(item), true)
  assert.equal(representativePaint(item), '#ff8800')

  // A filled path — even one that also has a stroke — shows its fill.
  const filled = square('b', 0, 0, 10, '#123456')
  filled.stroke = { color: '#000000', width: 1, cap: 'butt', join: 'miter' }
  assert.equal(isStrokeOnly(filled), false)
  assert.equal(representativePaint(filled), '#123456')

  // `fill: none` with no stroke paints nothing, and is not "stroke-only".
  const invisible = square('c', 0, 0, 10)
  invisible.fill = 'none'
  assert.equal(isStrokeOnly(invisible), false)
})

test('serializeDoc emits fill="none" rather than inventing an interior', () => {
  const item = square('a', 0, 0, 10)
  item.fill = 'none'
  item.stroke = { color: '#ffffff', width: 40, cap: 'round', join: 'round' }
  const svg = serializeDoc(doc([item]))
  assert.match(svg, /fill="none"/)
  assert.match(svg, /stroke="#ffffff" stroke-width="40"/)
  assert.match(svg, /stroke-linecap="round"/)
})

test('a stroke-only path contributes no colour to the palette count', () => {
  const stroked = square('a', 0, 0, 10)
  stroked.fill = 'none'
  stroked.stroke = { color: '#ffffff', width: 2, cap: 'butt', join: 'miter' }
  const filled = square('b', 20, 0, 10, '#112233')
  const stats = docStats(doc([stroked, filled]))
  assert.equal(stats.paths, 2)
  assert.equal(stats.colors, 1, '"none" is not a colour')
})

test('affineScale is the area-preserving scale, and exact when uniform', () => {
  assert.equal(affineScale([1, 0, 0, 1, 5, 9]), 1)
  assert.equal(affineScale([3, 0, 0, 3, 0, 0]), 3)
  // Non-uniform: √|det| = √(2·8) = 4, between the two axis scales.
  assert.equal(affineScale([2, 0, 0, 8, 0, 0]), 4)
  // A degenerate matrix must not hand back 0 and collapse a stroke width.
  assert.equal(affineScale([0, 0, 0, 0, 0, 0]), 1)
})

/* ------------------------------------------------------------ transform */

test('transformItem recurses through a group and moves every descendant', () => {
  const g = group('g', [square('a', 0, 0, 10), group('inner', [square('b', 20, 20, 10)])])
  const moved = transformItem(g, translation(5, 7))
  const box = itemBox(moved)
  // 'a' spans 0..10 and the nested 'b' spans 20..30, so the group box is 30 wide.
  assert.deepEqual(box, { x: 5, y: 7, w: 30, h: 30 })
})

test('transforming a traced region drops its planar link', () => {
  const item = square('a', 0, 0, 10)
  item.loops = [[{ edge: 1, reversed: false }]]
  const moved = transformItem(item, translation(1, 0)) as PathItem
  assert.equal(moved.loops, undefined, 'a moved region must not be re-materialized back to where it was')
})

test('a grip scales about the opposite corner, which stays exactly put', () => {
  const box = { x: 10, y: 10, w: 20, h: 20 }
  for (const grip of GRIPS) {
    const anchor = gripAnchor(box, grip)
    const from = gripPoint(box, grip)
    const m = scaleFromGrip(box, grip, { x: from.x + 10, y: from.y + 6 })
    const movedAnchor = { x: m[0] * anchor.x + m[2] * anchor.y + m[4], y: m[1] * anchor.x + m[3] * anchor.y + m[5] }
    assert.ok(Math.hypot(movedAnchor.x - anchor.x, movedAnchor.y - anchor.y) < 1e-9, `${grip} moved its anchor`)
  }
})

test('a corner grip drag lands the grip on the cursor', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 }
  const target = { x: 25, y: 40 }
  const m = scaleFromGrip(box, 'se', target)
  const p = gripPoint(box, 'se')
  const landed = { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] }
  assert.ok(Math.abs(landed.x - target.x) < 1e-9)
  assert.ok(Math.abs(landed.y - target.y) < 1e-9)
})

test('an edge grip scales one axis only', () => {
  const box = { x: 0, y: 0, w: 10, h: 10 }
  const m = scaleFromGrip(box, 'e', { x: 30, y: 999 })
  assert.ok(Math.abs(m[3] - 1) < 1e-9, 'east grip must not touch the vertical scale')
  assert.ok(Math.abs(m[0] - 3) < 1e-9)
})

test('a uniform corner drag keeps the aspect ratio', () => {
  const box = { x: 0, y: 0, w: 10, h: 20 }
  const m = scaleFromGrip(box, 'se', { x: 40, y: 25 }, { uniform: true })
  assert.ok(Math.abs(Math.abs(m[0]) - Math.abs(m[3])) < 1e-9)
})

test('rotation about a point holds that point fixed', () => {
  const o = { x: 5, y: 5 }
  const m = rotateAbout(o, Math.PI / 3)
  const p = { x: m[0] * o.x + m[2] * o.y + m[4], y: m[1] * o.x + m[3] * o.y + m[5] }
  assert.ok(Math.hypot(p.x - o.x, p.y - o.y) < 1e-9)

  // A quarter turn takes (1,0) from the origin to (0,1).
  const q = rotateAbout({ x: 0, y: 0 }, Math.PI / 2)
  const r = { x: q[0] * 1 + q[2] * 0 + q[4], y: q[1] * 1 + q[3] * 0 + q[5] }
  assert.ok(Math.abs(r.x) < 1e-9 && Math.abs(r.y - 1) < 1e-9)
})

test('selectionBox unions only the selected ids', () => {
  const d = doc([square('a', 0, 0, 10), square('b', 50, 50, 10)])
  assert.deepEqual(selectionBox(d.items, ids('a')), { x: 0, y: 0, w: 10, h: 10 })
  assert.deepEqual(selectionBox(d.items, ids('a', 'b')), { x: 0, y: 0, w: 60, h: 60 })
})

test('a stroke follows a UNIFORM scale', () => {
  const item = square('a', 0, 0, 10)
  item.stroke = { color: '#000000', width: 2, cap: 'butt', join: 'miter', dash: [4, 2] }
  const scaled = transformItem(item, [3, 0, 0, 3, 0, 0]) as PathItem
  assert.equal(scaled.stroke?.width, 6)
  assert.deepEqual(scaled.stroke?.dash, [12, 6])

  // Rotation and translation are uniform (scale 1) — the width must not drift.
  const spun = transformItem(item, rotateAbout({ x: 5, y: 5 }, 0.7)) as PathItem
  assert.ok(Math.abs((spun.stroke?.width ?? 0) - 2) < 1e-9)
  const moved = transformItem(item, translation(9, -3)) as PathItem
  assert.equal(moved.stroke?.width, 2)
})

test('a NON-uniform scale leaves the stroke width alone', () => {
  // Squashing a shape flat used to thin its outline by √|det| — a number the
  // user never touched changing by an amount they could not predict. There is
  // no single width that describes "thinner vertically, unchanged
  // horizontally", so the honest answer is to keep the authored weight.
  const item = square('a', 0, 0, 10)
  item.stroke = { color: '#000000', width: 40, cap: 'round', join: 'round' }

  const squashed = transformItem(item, [1, 0, 0, 0.1, 0, 0]) as PathItem
  assert.equal(squashed.stroke?.width, 40, 'a vertical squash must not thin the stroke')
  // The geometry itself still squashes.
  assert.ok(Math.abs((itemBox(squashed)?.h ?? 0) - 1) < 1e-9)

  const stretched = transformItem(item, [4, 0, 0, 1, 0, 0]) as PathItem
  assert.equal(stretched.stroke?.width, 40)
})

test('uniformScale reports the factor only when both axes agree', () => {
  assert.equal(uniformScale([2, 0, 0, 2, 5, 5]), 2)
  assert.equal(uniformScale([1, 0, 0, 0.1, 0, 0]), null)
  assert.equal(uniformScale([3, 0, 0, -3, 0, 0]), 3, 'a mirror is still uniform in magnitude')
  // A rotation is uniform at scale 1.
  const r = rotateAbout({ x: 0, y: 0 }, 1.1)
  assert.ok(Math.abs((uniformScale(r) ?? 0) - 1) < 1e-9)
  // Shear is not.
  assert.equal(uniformScale([1, 0, 0.5, 1, 0, 0]), null)
})

test('the north grip scales one axis and never touches the width', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 }
  const m = scaleFromGrip(box, 'n', { x: 999, y: 90 })
  assert.equal(m[0], 1, 'the horizontal scale stays exactly 1')
  assert.ok(Math.abs(m[3] - 0.1) < 1e-9)
})

/* ---------------------------------------------------------- segmentDrag */

test('solveSegmentDrag moves the on-curve point by exactly the requested delta', () => {
  for (const t of [0.2, 0.35, 0.5, 0.75]) {
    const d = { x: 3, y: -4 }
    const { dc1, dc2 } = solveSegmentDrag(t, d)
    const b1 = 3 * (1 - t) * (1 - t) * t
    const b2 = 3 * (1 - t) * t * t
    assert.ok(Math.abs(b1 * dc1.x + b2 * dc2.x - d.x) < 1e-9, `t=${t} x`)
    assert.ok(Math.abs(b1 * dc1.y + b2 * dc2.y - d.y) < 1e-9, `t=${t} y`)
  }
})

test('dragging a straight segment bends it and leaves the anchors alone', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [{ nodes: [pn(0, 0), pn(10, 0)], closed: false }],
  }
  const from = { x: 5, y: 0 }
  const to = { x: 5, y: 4 }
  const out = dragSegment(item, 0, 0, 0.5, from, to)

  const nodes = out.subPaths[0].nodes
  assert.deepEqual([nodes[0].x, nodes[0].y], [0, 0], 'start anchor must not move')
  assert.deepEqual([nodes[1].x, nodes[1].y], [10, 0], 'end anchor must not move')

  const { p0, c1, c2, p3 } = segmentControls(out.subPaths[0], 0)
  const mid = cubicAt(p0, c1, c2, p3, 0.5)
  assert.ok(Math.abs(mid.x - to.x) < 1e-9 && Math.abs(mid.y - to.y) < 1e-9, 'the grabbed point follows the cursor')
})

test('dragging near a segment end is clamped instead of exploding', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [{ nodes: [pn(0, 0), pn(10, 0)], closed: false }],
  }
  const out = dragSegment(item, 0, 0, 0.001, { x: 0.01, y: 0 }, { x: 0.01, y: 2 })
  const h = out.subPaths[0].nodes[0].hOut
  assert.ok(h && Math.abs(h.y) < 200, 'a grab at t≈0 must not fling the handle off the canvas')
})

/* -------------------------------------------------------------- pathOps */

test('reversing a subpath keeps the drawn curve identical', () => {
  const sp: SubPath = {
    nodes: [
      { x: 0, y: 0, hIn: null, hOut: { x: 3, y: 6 }, kind: 'corner' },
      { x: 10, y: 0, hIn: { x: 7, y: -6 }, hOut: null, kind: 'corner' },
    ],
    closed: false,
  }
  const rev = reverseSubPath(sp)
  // Same curve, opposite parameterization: B(t) forward == B(1-t) reversed.
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const f = segmentControls(sp, 0)
    const r = segmentControls(rev, 0)
    const a = cubicAt(f.p0, f.c1, f.c2, f.p3, t)
    const b = cubicAt(r.p0, r.c1, r.c2, r.p3, 1 - t)
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `t=${t}`)
  }
})

test('opening a closed subpath duplicates the cut node', () => {
  const item = square('a', 0, 0, 10)
  const out = openSubPathAt(item, 0, 2)
  const sp = out.subPaths[0]
  assert.equal(sp.closed, false)
  assert.equal(sp.nodes.length, 5, 'four corners plus the duplicated cut')
  assert.deepEqual([sp.nodes[0].x, sp.nodes[0].y], [sp.nodes[4].x, sp.nodes[4].y])
})

test('breaking an open path at an interior node yields two strands', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [{ nodes: [pn(0, 0), pn(5, 0), pn(10, 0)], closed: false }],
  }
  const out = breakAt(item, 0, 1)
  assert.equal(out.subPaths.length, 2)
  assert.equal(out.subPaths[0].nodes.length, 2)
  assert.equal(out.subPaths[1].nodes.length, 2)
})

test('joining two open strands welds them into one', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [
      { nodes: [pn(0, 0), pn(10, 0)], closed: false },
      { nodes: [pn(10.2, 0), pn(20, 0)], closed: false },
    ],
  }
  const out = joinEnds(item, { sub: 0, idx: 1 }, { sub: 1, idx: 0 })
  assert.equal(out.subPaths.length, 1)
  const nodes = out.subPaths[0].nodes
  assert.equal(nodes.length, 3)
  assert.ok(Math.abs(nodes[1].x - 10.1) < 1e-9, 'the weld sits at the midpoint of the gap')
})

test('joining the two ends of one strand closes it', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [{ nodes: [pn(0, 0), pn(10, 0), pn(10, 10)], closed: false }],
  }
  const out = joinEnds(item, { sub: 0, idx: 0 }, { sub: 0, idx: 2 })
  assert.equal(out.subPaths[0].closed, true)
})

test('splitCompound and combinePaths are inverse in shape count', () => {
  const item = square('a', 0, 0, 10)
  item.subPaths.push(square('b', 2, 2, 4).subPaths[0])
  let n = 0
  const parts = splitCompound(item, () => `s${++n}`)
  assert.equal(parts.length, 2)
  const back = combinePaths(parts)
  assert.equal(back?.subPaths.length, 2)
  assert.equal(back?.fillRule, 'evenodd')
})

test('closing needs at least three nodes', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [{ nodes: [pn(0, 0), pn(10, 0)], closed: false }],
  }
  assert.equal(closeSubPath(item, 0).subPaths[0].closed, false)
})

/* --------------------------------------------------------------- shapes */

test('rect / ellipse / line / polygon / star produce the boxes they were asked for', () => {
  const r = rectShape({ x: 0, y: 0 }, { x: 20, y: 10 })
  assert.deepEqual(itemBox({ ...square('t', 0, 0, 1), subPaths: r }), { x: 0, y: 0, w: 20, h: 10 })

  const rr = rectShape({ x: 0, y: 0 }, { x: 20, y: 10 }, 3)
  const rb = itemBox({ ...square('t', 0, 0, 1), subPaths: rr })
  assert.ok(rb && Math.abs(rb.w - 20) < 1e-6 && Math.abs(rb.h - 10) < 1e-6, 'a rounded rect still fills its box')

  const e = ellipseShape({ x: 0, y: 0 }, { x: 20, y: 10 })
  const eb = itemBox({ ...square('t', 0, 0, 1), subPaths: e })
  assert.ok(eb && Math.abs(eb.w - 20) < 1e-6 && Math.abs(eb.h - 10) < 1e-6)

  assert.equal(lineShape({ x: 0, y: 0 }, { x: 0, y: 0 }).length, 0, 'a zero-length line is not a shape')

  const { center, radius } = boxRadius({ x: 0, y: 0 }, { x: 20, y: 20 })
  const poly = polygonShape(center, radius, 6)
  assert.equal(poly[0].nodes.length, 6)
  const star = starShape(center, radius, 5)
  assert.equal(star[0].nodes.length, 10, 'a 5-point star has 10 vertices')
})

test('a rect corner radius is clamped to half the short side', () => {
  const huge = rectShape({ x: 0, y: 0 }, { x: 20, y: 10 }, 999)
  const b = itemBox({ ...square('t', 0, 0, 1), subPaths: huge })
  assert.ok(b && Math.abs(b.h - 10) < 1e-6, 'an over-large radius must not fold the shape through itself')
})

/* ---------------------------------------------------------------- align */

test('align moves items to the reference edge without resizing them', () => {
  const d = doc([square('a', 0, 0, 10), square('b', 50, 20, 30)])
  const out = alignItems(d, ids('a', 'b'), 'left')
  assert.equal(itemBox(out.items[0])?.x, 0)
  assert.equal(itemBox(out.items[1])?.x, 0)
  assert.equal(itemBox(out.items[1])?.w, 30, 'aligning must never scale')
})

test('a single selection aligns to the artboard', () => {
  const d = doc([square('a', 10, 10, 10)], 100)
  const out = alignItems(d, ids('a'), 'right')
  assert.equal(itemBox(out.items[0])?.x, 90)
})

test('distribute equalizes the gaps, not the centres', () => {
  // Widths 10, 30, 10 across 0..100 — even CENTRES would leave uneven gaps.
  const d = doc([square('a', 0, 0, 10), square('b', 40, 0, 30), square('c', 90, 0, 10)], 100)
  const out = distributeItems(d, ids('a', 'b', 'c'), 'horizontal')
  const boxes = out.items.map((i) => itemBox(i)!)
  const gap1 = boxes[1].x - (boxes[0].x + boxes[0].w)
  const gap2 = boxes[2].x - (boxes[1].x + boxes[1].w)
  assert.ok(Math.abs(gap1 - gap2) < 1e-9, `gaps differ: ${gap1} vs ${gap2}`)
  assert.equal(boxes[0].x, 0, 'the extremes stay put')
  assert.equal(boxes[2].x, 90)
})

/* -------------------------------------------------------------- hitTest */

test('pointInPath honours evenodd, so a donut hole is a miss', () => {
  const donut = square('d', 0, 0, 20)
  donut.subPaths.push(square('inner', 5, 5, 10).subPaths[0])
  donut.fillRule = 'evenodd'
  assert.equal(pointInPath(donut, { x: 2, y: 10 }), true, 'the ring is filled')
  assert.equal(pointInPath(donut, { x: 10, y: 10 }), false, 'the hole is not')
})

test('pickItem returns the frontmost hit and reports the enclosing group', () => {
  const items = [square('back', 0, 0, 20, '#111111'), square('front', 5, 5, 20, '#222222')]
  assert.equal(pickItem(items, { x: 10, y: 10 }, 1)?.id, 'front')
  assert.equal(pickItem(items, { x: 1, y: 1 }, 1)?.id, 'back')

  const grouped = [group('g', [square('leaf', 0, 0, 20)])]
  const hit = pickItem(grouped, { x: 10, y: 10 }, 1)
  assert.equal(hit?.id, 'g', 'clicking a grouped shape selects the group')
  assert.equal(hit?.leafId, 'leaf', 'and still reports which leaf was under the cursor')
})

test('node hit priority is handle, then anchor, then segment', () => {
  const item: PathItem = {
    kind: 'path', id: 'p', fill: '#000000', fillRule: 'nonzero', visible: true,
    subPaths: [{ nodes: [pn(0, 0, null, { x: 0, y: 0 }), pn(10, 0)], closed: false }],
  }
  const opts = { anchorTol: 3, handleTol: 3, segmentTol: 3 }
  // The handle sits exactly on its anchor. Without handle-first priority you
  // could never pull a curve out of a straight corner.
  const hit = pickNodePart(item, { x: 0, y: 0 }, opts)
  assert.equal(hit?.kind, 'handle')

  const onCurve = pickNodePart(item, { x: 5, y: 0.5 }, opts)
  assert.equal(onCurve?.kind, 'segment')
  assert.ok(Math.abs((onCurve?.t ?? 0) - 0.5) < 0.1)

  assert.equal(pickNodePart(item, { x: 5, y: 50 }, opts), null)
})

test('a containment marquee takes only what it fully frames', () => {
  const items = [square('in', 10, 10, 10), square('out', 80, 80, 30)]
  assert.deepEqual(marqueeItems(items, { x: 0, y: 0, w: 50, h: 50 }), ['in'])
  // Crossing mode grazes.
  assert.deepEqual(
    marqueeItems(items, { x: 0, y: 0, w: 85, h: 85 }, { touch: true }).sort(),
    ['in', 'out'],
  )
})

test('marqueeNodes selects anchors inside the band', () => {
  const item = square('a', 0, 0, 10)
  assert.deepEqual(marqueeNodes(item, { x: -1, y: -1, w: 3, h: 3 }), ['0:0'])
  assert.equal(marqueeNodes(item, { x: -1, y: -1, w: 20, h: 20 }).length, 4)
})

/* ------------------------------------------------------------- snapping */

test('snapping resolves each axis independently', () => {
  const items = [square('other', 40, 0, 10)]
  const cfg = { ...DEFAULT_SNAP, grid: 0 }
  const targets = collectTargets(items, [0, 0, 100, 100], ids('moving'), cfg)
  // x is near the other shape's left edge (40); y is nowhere near anything.
  const res = snapPoint({ x: 42, y: 63 }, targets, cfg)
  assert.equal(res.point.x, 40)
  assert.equal(res.point.y, 63, 'the un-snapped axis must be left alone')
  assert.equal(res.x?.source, 'edge')
  assert.equal(res.y, null)
})

test('a moving box snaps by its own edges, not by the pointer', () => {
  const items = [square('other', 50, 0, 10)]
  const cfg = { ...DEFAULT_SNAP, grid: 0, toArtboard: false }
  const targets = collectTargets(items, [0, 0, 100, 100], ids('moving'), cfg)
  const box = { x: 0, y: 0, w: 10, h: 10 }
  // Moving right by 47 puts the box's left edge at 47 — 3 from the target's 50.
  const out = snapBoxDelta(box, { x: 47, y: 0 }, targets, cfg)
  assert.equal(out.delta.x, 50, 'the edge lands on the guide')
  assert.equal(out.x?.source, 'edge')
})

test('an edge snaps to an edge and a centre to a centre, never across', () => {
  // A wide reference (20..80, centre 50) and a wide mover (40 across) put the
  // mover's own edges far from its centre, so the three probes can be tested
  // apart. Moving right by 2 puts the mover's CENTRE at 22 — two units from the
  // reference's left EDGE at 20, and nowhere near its centre. Both of the
  // mover's edges (2 and 42) are far from everything.
  const items = [square('other', 20, 0, 60)]
  const cfg = { ...DEFAULT_SNAP, grid: 0, toArtboard: false, tolerance: 3 }
  const targets = collectTargets(items, [0, 0, 100, 100], ids('moving'), cfg)
  const out = snapBoxDelta({ x: 0, y: 0, w: 40, h: 10 }, { x: 2, y: 0 }, targets, cfg)
  // Without role matching the centre would be dragged onto that edge (delta 0).
  assert.equal(out.delta.x, 2, 'a centre must not be captured by an edge')
  assert.equal(out.x, null)

  // A point drag ignores roles — a lone point is neither an edge nor a centre,
  // so it is free to land on that same edge.
  assert.equal(snapPoint({ x: 22, y: 55 }, targets, cfg).point.x, 20)
})

test('a shape never snaps to its own current position', () => {
  const items = [square('moving', 40, 0, 10)]
  const cfg = { ...DEFAULT_SNAP, grid: 0, toArtboard: false }
  const targets = collectTargets(items, [0, 0, 100, 100], ids('moving'), cfg)
  assert.equal(targets.xs.length, 0, 'the dragged item must not contribute targets')
})

test('grid snapping applies only when nothing better is in range', () => {
  const cfg = { ...DEFAULT_SNAP, grid: 10, toGeometry: false, toArtboard: false, tolerance: 3 }
  const targets = collectTargets([], [0, 0, 100, 100], new Set(), cfg)
  assert.equal(snapPoint({ x: 21, y: 55 }, targets, cfg).point.x, 20)
  assert.equal(snapPoint({ x: 25, y: 55 }, targets, cfg).point.x, 25, 'out of tolerance stays free')
})
