// The layers rail's pure core: the display row model, what shift-click spans,
// where a drop lands, and the tree surgery a drop performs.
//
//   node --test test/layer-rows.test.ts
//
// Everything here hinges on ONE inversion — the list runs top-down, paint order
// runs bottom-up — and getting it wrong is invisible until a drag puts a shape
// on the wrong side of another. So the assertions are about ORDER: paint order
// in, display order out, and the paint order that comes back after a move.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, GroupItem, PathItem } from '../src/lib/path/types.ts'
import { isGroup, leafItems, moveItems } from '../src/lib/path/docTree.ts'
import {
  dropSpot,
  edgeAt,
  layerRows,
  rowsBetween,
} from '../src/lib/editor/layerRows.ts'

/* ------------------------------------------------------------- fixtures */

function path(id: string): PathItem {
  return {
    kind: 'path',
    id,
    fill: '#000000',
    fillRule: 'nonzero',
    subPaths: [{ nodes: [], closed: true }],
    visible: true,
  }
}

function group(id: string, children: DocItem[], expanded = true): GroupItem {
  return { kind: 'group', id, children, visible: true, expanded }
}

/** p1 p2 [g1: c1 c2] p3, in PAINT order — p3 is frontmost. */
function tree(): DocItem[] {
  return [path('p1'), path('p2'), group('g1', [path('c1'), path('c2')]), path('p3')]
}

const ids = (items: readonly DocItem[]) => items.map((it) => it.id)

/* ------------------------------------------------------------ row model */

test('layerRows reverses paint order and indents children', () => {
  const rows = layerRows(tree())
  assert.deepEqual(
    rows.map((r) => r.item.id),
    ['p3', 'g1', 'c2', 'c1', 'p2', 'p1'],
    'top of the list is the frontmost item',
  )
  assert.deepEqual(rows.map((r) => r.depth), [0, 0, 1, 1, 0, 0])
  assert.deepEqual(rows.map((r) => r.parentId), [null, null, 'g1', 'g1', null, null])
  // The index is into the PARENT's children, in paint order — not the row list.
  assert.deepEqual(rows.map((r) => r.siblingIndex), [3, 2, 1, 0, 1, 0])
})

test('layerRows numbers in paint order, so adding a shape renumbers nothing', () => {
  const rows = layerRows(tree())
  const num = (id: string) => rows.find((r) => r.item.id === id)?.number
  assert.equal(num('p1'), 1)
  assert.equal(num('p2'), 2)
  assert.equal(num('c1'), 3)
  assert.equal(num('p3'), 5)
  assert.equal(num('g1'), 1, 'groups are counted on their own sequence')

  // A new shape lands on top and takes the NEXT number; nothing below moves.
  const grown = layerRows([...tree(), path('p4')])
  assert.equal(grown.find((r) => r.item.id === 'p3')?.number, 5)
  assert.equal(grown.find((r) => r.item.id === 'p4')?.number, 6)
})

test('a collapsed group hides its subtree from the rail', () => {
  const items = [path('p1'), group('g1', [path('c1'), path('c2')], false)]
  assert.deepEqual(layerRows(items).map((r) => r.item.id), ['g1', 'p1'])
})

/* -------------------------------------------------------- range select */

test('rowsBetween spans the block the eye sees, either direction', () => {
  const rows = layerRows(tree())
  const span = ['p3', 'g1', 'c2', 'c1', 'p2']
  assert.deepEqual(rowsBetween(rows, 'p3', 'p2'), span)
  assert.deepEqual(rowsBetween(rows, 'p2', 'p3'), span, 'dragging upward spans the same rows')
  assert.deepEqual(rowsBetween(rows, 'p2', 'p2'), ['p2'], 'a range onto itself is one row')
})

test('rowsBetween with no usable anchor selects just the clicked row', () => {
  const rows = layerRows(tree())
  assert.deepEqual(rowsBetween(rows, 'gone', 'p2'), ['p2'])
  assert.deepEqual(rowsBetween(rows, 'p2', 'gone'), [])
})

test('a range across a collapsed group cannot pick up its hidden children', () => {
  const items = [path('p1'), group('g1', [path('c1')], false), path('p3')]
  const rows = layerRows(items)
  assert.deepEqual(rowsBetween(rows, 'p3', 'p1'), ['p3', 'g1', 'p1'])
})

/* ---------------------------------------------------------- drop target */

test('edgeAt splits a leaf in half and a group in three', () => {
  assert.equal(edgeAt(2, 32, false), 'above')
  assert.equal(edgeAt(30, 32, false), 'below')
  assert.equal(edgeAt(16, 32, false), 'below', 'a leaf has no middle to drop into')

  assert.equal(edgeAt(2, 32, true), 'above')
  assert.equal(edgeAt(16, 32, true), 'into')
  assert.equal(edgeAt(30, 32, true), 'below')
})

test('dropSpot flips display order back into paint order', () => {
  const rows = layerRows(tree())
  // Above p3 (the topmost row) = in FRONT of everything.
  assert.deepEqual(dropSpot(rows, 'p3', 'above'), { parentId: null, index: 4 })
  // Below p1 (the bottom row) = behind everything.
  assert.deepEqual(dropSpot(rows, 'p1', 'below'), { parentId: null, index: 0 })
  // Inside a row of a group resolves against the GROUP, not the top level.
  assert.deepEqual(dropSpot(rows, 'c2', 'above'), { parentId: 'g1', index: 2 })
})

test('dropSpot into a group lands at its front; a leaf has no inside', () => {
  const rows = layerRows(tree())
  assert.deepEqual(dropSpot(rows, 'g1', 'into'), { parentId: 'g1', index: 2 })
  assert.equal(dropSpot(rows, 'p1', 'into'), null)
  assert.equal(dropSpot(rows, 'nope', 'above'), null)
})

/* ------------------------------------------------------------- the move */

test('moveItems sends a back shape to the front', () => {
  const items = tree()
  const to = dropSpot(layerRows(items), 'p3', 'above')!
  const next = moveItems(items, new Set(['p1']), to)!
  assert.deepEqual(ids(next), ['p2', 'g1', 'p3', 'p1'])
})

test('moveItems drops into a group, and the shape stays put visually', () => {
  const items = tree()
  const to = dropSpot(layerRows(items), 'g1', 'into')!
  const next = moveItems(items, new Set(['p3']), to)!
  assert.deepEqual(ids(next), ['p1', 'p2', 'g1'])
  const g = next.find((it) => it.id === 'g1') as GroupItem
  assert.deepEqual(ids(g.children), ['c1', 'c2', 'p3'], 'front of the group')
  // Nothing that was in front of p3 was in that group, so paint order holds.
  assert.deepEqual(leafItems(next).map((l) => l.id), ['p1', 'p2', 'c1', 'c2', 'p3'])
})

test('moveItems pulls a child back out to the top level', () => {
  const items = tree()
  const to = dropSpot(layerRows(items), 'p2', 'below')!
  const next = moveItems(items, new Set(['c1']), to)!
  assert.deepEqual(ids(next), ['p1', 'c1', 'p2', 'g1', 'p3'])
  assert.deepEqual(ids((next.find((it) => it.id === 'g1') as GroupItem).children), ['c2'])
})

test('moveItems keeps the relative stacking of a multi-row drag', () => {
  const items = tree()
  const to = dropSpot(layerRows(items), 'p1', 'below')!
  const next = moveItems(items, new Set(['p3', 'p2']), to)!
  assert.deepEqual(ids(next), ['p2', 'p3', 'p1', 'g1'], 'p2 was behind p3 and still is')
})

test('moveItems adjusts for movers that sat before the drop point', () => {
  // "Just behind g1" quoted against the ORIGINAL tree is index 2 — but p1 is
  // pulled out from below it first, so a naive insert would land one too far.
  const items = tree()
  const next = moveItems(items, new Set(['p1']), { parentId: null, index: 2 })!
  assert.deepEqual(ids(next), ['p2', 'p1', 'g1', 'p3'])
})

test('moveItems refuses to swallow a group into its own subtree', () => {
  const items = tree()
  assert.equal(moveItems(items, new Set(['g1']), { parentId: 'g1', index: 0 }), null)
  const deep = [group('outer', [group('inner', [path('c1')])])]
  assert.equal(moveItems(deep, new Set(['outer']), { parentId: 'inner', index: 0 }), null)
})

test('moveItems reports a no-op drop rather than costing an undo step', () => {
  const items = tree()
  const rows = layerRows(items)
  // Both edges that mean "where p2 already is".
  assert.equal(moveItems(items, new Set(['p2']), dropSpot(rows, 'p2', 'above')!), null)
  assert.equal(moveItems(items, new Set(['p2']), dropSpot(rows, 'p2', 'below')!), null)
  assert.equal(moveItems(items, new Set(['p2']), dropSpot(rows, 'p1', 'above')!), null)
})

test('moveItems takes a selected group along with its children', () => {
  const items = tree()
  const to = dropSpot(layerRows(items), 'p1', 'below')!
  const next = moveItems(items, new Set(['g1', 'c1']), to)!
  assert.deepEqual(ids(next), ['g1', 'p1', 'p2', 'p3'])
  const g = next.find((it) => it.id === 'g1')!
  assert.ok(isGroup(g) && ids(g.children).join() === 'c1,c2', 'the child rode along inside')
})
