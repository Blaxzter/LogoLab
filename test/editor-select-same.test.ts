// "Select same fill / stroke / appearance" in the SVG editor: which shapes count as painted alike.
//
//   node --test test/editor-select-same.test.ts
//
// The ways this goes wrong are quiet: `#ABC` and `#aabbcc` read as two colours,
// a gradient copy never matches because its coordinates moved with its shape, a
// hidden shape joins the selection and gets recoloured unseen, a glyph of a live
// text is selected on its own (and its edit is thrown away on the next
// keystroke). Each test pins one of those.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, EditableDoc, GradientFill, GroupItem, PathItem, Stroke } from '../src/lib/path/types.ts'
import { colorKey, leadPath, paintMatches, sameGradient, selectSame } from '../src/lib/editor/paintMatch.ts'

function sq(id: string, fill: string, extra: Partial<PathItem> = {}): PathItem {
  return {
    kind: 'path',
    id,
    fill,
    fillRule: 'nonzero',
    subPaths: [
      {
        closed: true,
        nodes: [
          { x: 0, y: 0, hIn: null, hOut: null, kind: 'corner' },
          { x: 10, y: 0, hIn: null, hOut: null, kind: 'corner' },
          { x: 10, y: 10, hIn: null, hOut: null, kind: 'corner' },
        ],
      },
    ],
    visible: true,
    ...extra,
  }
}

const group = (id: string, children: DocItem[], extra: Partial<GroupItem> = {}): GroupItem => ({
  kind: 'group',
  id,
  children,
  visible: true,
  ...extra,
})

const doc = (items: DocItem[]): EditableDoc => ({ viewBox: [0, 0, 100, 100], items })
const ids = (s: Set<string> | null) => [...(s ?? [])].sort()

const stroke = (color: string, width = 2, extra: Partial<Stroke> = {}): Stroke => ({
  color,
  width,
  cap: 'butt',
  join: 'miter',
  ...extra,
})

test('colours compare normalised: case, #rgb and whitespace do not make a new colour', () => {
  assert.equal(colorKey('#ABC'), colorKey('#aabbcc'))
  assert.equal(colorKey(' #AaBbCc '), '#aabbcc')
  assert.equal(colorKey('NONE'), 'none')
  assert.notEqual(colorKey('#aabbcc'), colorKey('#aabbcd'))
})

test('same fill finds every shape of that colour, in any hex spelling, and nothing else', () => {
  const d = doc([sq('a', '#FF0000'), sq('b', '#f00'), sq('c', '#ff0001'), sq('d', 'none')])
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fill')), ['a', 'b'])
  // No fill is a paint too: it matches the other unfilled shapes.
  assert.deepEqual(ids(selectSame(d, new Set(['d']), 'fill')), ['d'])
})

test('a gradient matches an equal gradient wherever it sits, never the solid that is its swatch', () => {
  const g = (x: number): GradientFill => ({
    type: 'linear',
    x1: x,
    y1: 0,
    x2: x + 10,
    y2: 0,
    stops: [
      { offset: 0, color: '#FF0000' },
      { offset: 1, color: '#0000ff', opacity: 1 },
    ],
  })
  const other: GradientFill = {
    ...g(0),
    stops: [
      { offset: 0, color: '#ff0000' },
      { offset: 0.5, color: '#0000ff' },
    ],
  }
  assert.ok(sameGradient(g(0), g(50)), 'placement is not part of the paint')
  const d = doc([
    sq('a', '#ff0000', { gradient: g(0) }),
    sq('b', '#ff0000', { gradient: g(50) }),
    sq('c', '#ff0000'),
    sq('e', '#ff0000', { gradient: other }),
  ])
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fill')), ['a', 'b'])
  assert.deepEqual(ids(selectSame(d, new Set(['c']), 'fill')), ['c'])
})

test('same stroke compares the outline colour; unstroked shapes match each other', () => {
  const d = doc([
    sq('a', '#111111', { stroke: stroke('#00F', 2) }),
    sq('b', '#222222', { stroke: stroke('#0000ff', 8) }),
    sq('c', '#111111'),
    sq('z', '#111111', { stroke: stroke('#0000ff', 0) }),
  ])
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'stroke')), ['a', 'b'])
  // A zero-width stroke paints nothing: it is the same as none.
  assert.deepEqual(ids(selectSame(d, new Set(['c']), 'stroke')), ['c', 'z'])
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fillStroke')), ['a'])
})

test('same appearance also needs the width and both opacities', () => {
  const base = sq('a', '#111111', { stroke: stroke('#0000ff', 2) })
  assert.ok(paintMatches(base, sq('b', '#111', { stroke: stroke('#00f', 2) }), 'appearance'))
  assert.ok(!paintMatches(base, sq('b', '#111', { stroke: stroke('#00f', 3) }), 'appearance'))
  assert.ok(!paintMatches(base, sq('b', '#111', { stroke: stroke('#00f', 2, { opacity: 0.5 }) }), 'appearance'))
  assert.ok(!paintMatches(base, sq('b', '#111', { fillOpacity: 0.5, stroke: stroke('#00f', 2) }), 'appearance'))
  // Opacity 1 written out equals opacity left out.
  assert.ok(
    paintMatches(base, sq('b', '#111', { fillOpacity: 1, stroke: stroke('#00f', 2, { opacity: 1 }) }), 'appearance'),
  )
})

test('hidden shapes, and shapes in a hidden group, are never selected', () => {
  const d = doc([
    sq('a', '#ff0000'),
    sq('h', '#ff0000', { visible: false }),
    group('g', [sq('in', '#ff0000')], { visible: false }),
  ])
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fill')), ['a'])
})

test('at the top level a match inside a group selects the shape, not the whole group', () => {
  const d = doc([sq('a', '#ff0000'), group('g', [sq('in', '#ff0000'), sq('other', '#00ff00')])])
  // Selecting the group would carry `other` along into the next recolour.
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fill')), ['a', 'in'])
  // A selected group gives its first path as the model, like the Inspector's swatch.
  assert.equal(leadPath(d, new Set(['g']))?.id, 'in')
  assert.deepEqual(ids(selectSame(d, new Set(['g']), 'fill')), ['a', 'in'])
})

test('inside an entered group the search stays in that group', () => {
  const d = doc([sq('a', '#ff0000'), group('g', [sq('in', '#ff0000'), group('deep', [sq('d2', '#f00')])])])
  assert.deepEqual(ids(selectSame(d, new Set(['in']), 'fill', 'g')), ['d2', 'in'])
})

test('a live text matches by its outlines and is selected whole, never glyph by glyph', () => {
  const text = group('t', [sq('t~0', '#FF0000')], {
    text: {
      runs: [{ text: 'Hi' }],
      style: { font: 'inter', size: 10, weight: 400, italic: false, fill: '#ff0000', tracking: 0 },
      align: 'left',
      lineHeight: 1.2,
      kerning: true,
      matrix: [1, 0, 0, 1, 0, 0],
    },
  })
  const d = doc([sq('a', '#ff0000'), text])
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fill')), ['a', 't'])
  assert.deepEqual(ids(selectSame(d, new Set(['t']), 'fill')), ['a', 't'])
})

test('a selection with no path to take paint from selects nothing', () => {
  const d = doc([{ kind: 'raw', id: 'r', markup: '<circle r="3"/>', visible: true }, sq('a', '#ff0000')])
  assert.equal(selectSame(d, new Set(['r']), 'fill'), null)
  assert.equal(selectSame(d, new Set(), 'fill'), null)
})

test('a lead OUTSIDE the entered group is searched for where it is, and is in the answer', () => {
  // Reachable: enter G, then click X on the canvas — nothing clears the entered group.
  const d = doc([group('G', [sq('a', '#ff0000')]), sq('X', '#ff0000'), sq('Y', '#ff0000'), sq('Z', '#00ff00')])
  assert.deepEqual(ids(selectSame(d, new Set(['X']), 'fill', 'G')), ['X', 'Y', 'a'])
  // A lead inside the entered group still keeps the search there.
  assert.deepEqual(ids(selectSame(d, new Set(['a']), 'fill', 'G')), ['a'])
})

test('a text matches when ANY of its paint runs does, not only its first', () => {
  const text = group('T', [sq('T~0', '#000000'), sq('T~1', '#ff0000')], {
    text: {
      runs: [{ text: 'ab' }],
      style: { font: 'inter', size: 12, weight: 400, italic: false, fill: '#000000', tracking: 0 },
      align: 'left',
      lineHeight: 1.2,
      kerning: true,
      matrix: [1, 0, 0, 1, 0, 0],
    },
  })
  assert.deepEqual(ids(selectSame(doc([text, sq('R', '#ff0000')]), new Set(['R']), 'fill')), ['R', 'T'])
})
