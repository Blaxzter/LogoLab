// Editor operations on paths that are NOT at the top level, and text edits that
// wait on a font.
//
// Combine and Split found their paths with the recursive `findItem` but put the
// result back with a top-level-only map, so inside a group Combine deleted the
// other paths and never inserted the merged one, and Split committed a no-op.
// The node tool offered a live text's glyph outlines, which the next relayout
// throws away. And text edits deferred behind a font load landed in whatever
// order their loads finished, or — when the load failed — laid the text out
// with no glyphs and committed that.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, GroupItem, PathItem, PathNode } from '../src/lib/path/types.ts'
import { findItem, removeItems } from '../src/lib/path/docTree.ts'
import { nodeEditablePaths, replaceIn, replaceWithMany } from '../src/lib/editor/nodeEdit.ts'
import { combinePaths, splitCompound } from '../src/lib/editor/pathOps.ts'
import { createFaceQueue, type FaceNeed } from '../src/lib/text/faceQueue.ts'

const pn = (x: number, y: number): PathNode => ({ x, y, hIn: null, hOut: null, kind: 'corner' })

function square(id: string, x: number, size = 10): PathItem {
  return {
    kind: 'path',
    id,
    fill: '#000000',
    fillRule: 'nonzero',
    visible: true,
    subPaths: [{ nodes: [pn(x, 0), pn(x + size, 0), pn(x + size, size), pn(x, size)], closed: true }],
  }
}

const group = (id: string, children: DocItem[]): GroupItem => ({ kind: 'group', id, children, visible: true })

/* ------------------------------------------------------- combine / split */

test('combine inside a group puts the merged path where the first one was', () => {
  const items: DocItem[] = [square('top', 100), group('g', [square('a', 0), square('b', 20)])]
  // What `combineSelected` does with {a, b}.
  const merged = combinePaths([findItem(items, 'a') as PathItem, findItem(items, 'b') as PathItem])!
  const next = replaceIn(removeItems(items, new Set(['b'])), merged)
  const g = findItem(next, 'g') as GroupItem
  assert.deepEqual(
    g.children.map((c) => c.id),
    ['a'],
  )
  assert.equal((g.children[0] as PathItem).subPaths.length, 2, 'the merged path carries both shapes')
  assert.equal(next[0], items[0], 'untouched items keep their identity')
})

test('split inside a group replaces the path in its own group, in order', () => {
  const compound: PathItem = { ...square('o', 0), subPaths: [...square('x', 0).subPaths, ...square('y', 20).subPaths] }
  const items: DocItem[] = [group('g', [square('before', 50), compound, square('after', 70)])]
  let n = 0
  const parts = splitCompound(compound, () => `p${++n}`)
  const next = replaceWithMany(items, 'o', parts)
  assert.notEqual(next, items)
  assert.deepEqual(
    (next[0] as GroupItem).children.map((c) => c.id),
    ['before', 'p1', 'p2', 'after'],
  )
})

test('replaceWithMany returns the same list for an id that is not there', () => {
  const items: DocItem[] = [square('a', 0), group('g', [square('b', 20)])]
  assert.equal(replaceWithMany(items, 'nope', [square('c', 0)]), items)
})

/* ---------------------------------------------------------- node tool */

test('the node tool never offers a live text’s glyph outlines', () => {
  const glyphs = square('glyph', 40)
  const text: GroupItem = { ...group('t', [glyphs]), text: {} as never }
  const items: DocItem[] = [square('a', 0), group('g', [square('b', 20), text])]
  const ids = (sel: string[]) => nodeEditablePaths(items, new Set(sel)).map((p) => p.id)

  assert.deepEqual(ids([]), ['a', 'b'], 'nothing selected: every path but the glyphs')
  assert.deepEqual(ids(['g']), ['b'], 'a selected group: its paths, not a text inside it')
  assert.deepEqual(ids(['t']), [], 'a selected text')
  assert.deepEqual(ids(['glyph']), [], 'a glyph path picked directly (layers rail)')
  assert.deepEqual(ids(['a']), ['a'])
})

/* --------------------------------------------------------- face queue */

function harness(initial: string[] = []) {
  const loaded = new Set(initial)
  const gates = new Map<string, () => void>()
  const failing = new Set<string>()
  let idle = 0
  const q = createFaceQueue({
    ready: (f) => loaded.has(f.font),
    load: (needs) =>
      Promise.all(
        needs.map(
          (f) =>
            new Promise<void>((resolve) => {
              gates.set(f.font, () => {
                if (!failing.has(f.font)) loaded.add(f.font)
                resolve()
              })
            }),
        ),
      ),
    onIdle: () => idle++,
  })
  const need = (font: string) => (): FaceNeed[] => [{ font, italic: false }]
  return { q, need, gates, failing, idle: () => idle }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

test('edits queued behind a font load land in the order they were made', async () => {
  const h = harness(['fast'])
  const out: string[] = []
  const missing: string[] = []
  assert.equal(
    h.q.run(
      h.need('slow'),
      () => out.push('a'),
      () => missing.push('a'),
    ),
    true,
  )
  // A face that IS loaded still waits its turn once something is queued.
  assert.equal(
    h.q.run(
      h.need('fast'),
      () => out.push('b'),
      () => missing.push('b'),
    ),
    true,
  )
  await tick()
  assert.deepEqual(out, [])
  h.gates.get('slow')!()
  await tick()
  assert.deepEqual(out, ['a', 'b'])
  assert.deepEqual(missing, [])
  assert.equal(h.q.busy(), false)
  assert.equal(h.idle(), 1)
  // Idle again: a loaded face applies synchronously.
  assert.equal(
    h.q.run(
      h.need('fast'),
      () => out.push('c'),
      () => {},
    ),
    false,
  )
  assert.deepEqual(out, ['a', 'b', 'c'])
})

test('a face that fails to load drops the edit and the queue behind it', async () => {
  const h = harness(['fast'])
  h.failing.add('gone')
  const out: string[] = []
  const missing: string[][] = []
  h.q.run(
    h.need('gone'),
    () => out.push('a'),
    (m) => missing.push(m.map((f) => f.font)),
  )
  h.q.run(
    h.need('fast'),
    () => out.push('b'),
    () => {},
  )
  await tick()
  h.gates.get('gone')!()
  await tick()
  assert.deepEqual(out, [], 'nothing laid out without its face')
  assert.deepEqual(missing, [['gone']])
  assert.equal(h.q.busy(), false)
  assert.equal(h.idle(), 1)
  // The queue works again afterwards.
  assert.equal(
    h.q.run(
      h.need('fast'),
      () => out.push('c'),
      () => {},
    ),
    false,
  )
  assert.deepEqual(out, ['c'])
})
