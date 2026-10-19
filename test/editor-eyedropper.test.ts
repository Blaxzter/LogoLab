// The editor's eyedropper: one shape's look copied onto the selection, and the screen pipette.
//
//   node --test test/editor-eyedropper.test.ts
//
// What has to hold: the whole look travels (stroke cap, join, dash, miter limit
// and opacity included) and the construction does not (geometry, fill rule); a
// gradient lands on the target the way it sat on the source instead of the
// slice of it that happens to lie over the target; a live text keeps the colour
// past its next relayout; a click that changes nothing costs no undo step.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DocItem, EditableDoc, GroupItem, PathItem } from '../src/lib/path/types.ts'
import { withAppearance } from '../src/lib/editor/appearance.ts'
import { applyAppearance } from '../src/components/editor/editorDoc.ts'
import { hasScreenEyeDropper, pickScreenColor } from '../src/components/editor/screenColor.ts'

function rect(id: string, x: number, y: number, w: number, h: number, extra: Partial<PathItem> = {}): PathItem {
  const n = (px: number, py: number) => ({ x: px, y: py, hIn: null, hOut: null, kind: 'corner' as const })
  return {
    kind: 'path',
    id,
    fill: '#000000',
    fillRule: 'nonzero',
    subPaths: [{ closed: true, nodes: [n(x, y), n(x + w, y), n(x + w, y + h), n(x, y + h)] }],
    visible: true,
    ...extra,
  }
}

const doc = (items: DocItem[]): EditableDoc => ({ viewBox: [0, 0, 200, 200], items })

const source = rect('src', 0, 0, 10, 10, {
  fill: '#ff0000',
  fillOpacity: 0.5,
  fillRule: 'evenodd',
  stroke: { color: '#00ff00', width: 3, cap: 'round', join: 'bevel', miterLimit: 8, dash: [2, 1], opacity: 0.25 },
})

test('the whole look travels; the geometry and the fill rule stay', () => {
  const target = rect('t', 50, 50, 20, 20, {
    fill: '#123456',
    stroke: { color: '#000', width: 1, cap: 'butt', join: 'miter' },
  })
  const out = withAppearance(target, source)
  assert.equal(out.fill, '#ff0000')
  assert.equal(out.fillOpacity, 0.5)
  assert.deepEqual(out.stroke, source.stroke)
  assert.notEqual(out.stroke, source.stroke, 'the stroke is copied, not shared')
  assert.notEqual(out.stroke?.dash, source.stroke?.dash)
  assert.equal(out.fillRule, 'nonzero')
  assert.equal(out.subPaths, target.subPaths)
  assert.equal(out.id, 't')
})

test('a source without a stroke or opacity takes them off the target', () => {
  const plain = rect('s', 0, 0, 10, 10, { fill: '#00f' })
  const out = withAppearance(rect('t', 0, 0, 5, 5, { fillOpacity: 0.3, stroke: source.stroke }), plain)
  assert.equal(out.stroke, undefined)
  assert.equal(out.fillOpacity, undefined)
  assert.ok(!('stroke' in out) && !('fillOpacity' in out))
})

test('fill only (Shift-click) leaves the target stroke alone', () => {
  const mine = { color: '#abcdef', width: 4, cap: 'square' as const, join: 'round' as const }
  const out = withAppearance(rect('t', 0, 0, 5, 5, { stroke: mine }), source, 'fill')
  assert.equal(out.fill, '#ff0000')
  assert.equal(out.fillOpacity, 0.5)
  assert.equal(out.stroke, mine)
})

test('a gradient is refitted onto the target, and a solid source clears the target gradient', () => {
  const grad = rect('g', 0, 0, 10, 10, {
    fill: '#ff0000',
    gradient: {
      type: 'linear',
      x1: 0,
      y1: 5,
      x2: 10,
      y2: 5,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    },
  })
  const out = withAppearance(rect('t', 100, 40, 40, 20), grad)
  // Left edge to right edge of the target, at its mid-height: as on the source.
  assert.deepEqual(out.gradient, { ...grad.gradient, x1: 100, y1: 50, x2: 140, y2: 50 })
  assert.notEqual(out.gradient?.stops, undefined)
  const solid = withAppearance(out, rect('s', 0, 0, 1, 1, { fill: '#00ff00' }))
  assert.equal(solid.gradient, undefined)
  assert.equal(solid.fill, '#00ff00')

  const radial = rect('r', 0, 0, 10, 10, {
    gradient: { type: 'radial', cx: 5, cy: 5, r: 5, stops: [{ offset: 0, color: '#fff' }] },
  })
  const rOut = withAppearance(rect('t', 20, 20, 20, 20), radial)
  assert.deepEqual(rOut.gradient, { type: 'radial', cx: 30, cy: 30, r: 10, stops: [{ offset: 0, color: '#fff' }] })
})

test('a target that already looks like the source is returned as is (no undo step)', () => {
  const same = withAppearance(rect('t', 9, 9, 3, 3), source)
  assert.equal(withAppearance(same, source), same)
  const d = doc([source, same])
  assert.equal(applyAppearance(d, new Set(['t']), source), d)
})

test('applies to every selected path, into groups, and never touches the rest', () => {
  const a = rect('a', 0, 0, 5, 5)
  const b = rect('b', 0, 0, 5, 5)
  const c = rect('c', 0, 0, 5, 5)
  const g: GroupItem = { kind: 'group', id: 'g', children: [b], visible: true }
  const d = doc([source, a, g, c])
  const next = applyAppearance(d, new Set(['a', 'g']), source)
  const [, na, ng, nc] = next.items as [PathItem, PathItem, GroupItem, PathItem]
  assert.equal(na.fill, '#ff0000')
  assert.equal((ng.children[0] as PathItem).stroke?.color, '#00ff00')
  assert.equal(nc, c)
  assert.equal(next.items[0], source)
})

test('a selected text takes the colour into its style, so the next keystroke keeps it', () => {
  const text: GroupItem = {
    kind: 'group',
    id: 'tx',
    visible: true,
    children: [rect('tx~0', 0, 0, 30, 10, { fill: '#111827' })],
    text: {
      runs: [{ text: 'Hi' }],
      style: { font: 'inter', size: 10, weight: 400, italic: false, fill: '#111827', tracking: 0 },
      align: 'left',
      lineHeight: 1.2,
      kerning: true,
      matrix: [1, 0, 0, 1, 0, 0],
    },
  }
  const next = applyAppearance(doc([source, text]), new Set(['tx']), source)
  const t = next.items[1] as GroupItem
  assert.equal(t.text?.style.fill, '#ff0000')
  assert.ok(t.text?.runs.every((r) => !r.style?.fill || r.style.fill === '#ff0000'))
  // The rest of the paint rides on the outlines (layoutGroup carries it over).
  assert.equal((t.children[0] as PathItem).stroke?.width, 3)
})

test('the screen pipette: absent without EyeDropper, hex out, null on cancel', async () => {
  assert.equal(hasScreenEyeDropper({}), false)
  assert.equal(await pickScreenColor({}), null)
  const answering = (v: string | Error) => ({
    EyeDropper: class {
      open() {
        return v instanceof Error ? Promise.reject(v) : Promise.resolve({ sRGBHex: v })
      }
    },
  })
  assert.equal(hasScreenEyeDropper(answering('#000000')), true)
  assert.equal(await pickScreenColor(answering('#A1B2C3')), '#a1b2c3')
  assert.equal(await pickScreenColor(answering('rgb(255, 0, 16)')), '#ff0010')
  assert.equal(await pickScreenColor(answering(new Error('AbortError'))), null)
  assert.equal(await pickScreenColor(answering('nonsense')), null)
})

test('re-sampling a moved copy of a gradient shape is no change (float refit within tolerance)', async () => {
  const { transformItem } = await import('../src/lib/editor/transform.ts')
  const src = rect('a', 10.1, 0.7, 30.2, 10.3, {
    fill: '#ff0000',
    gradient: {
      type: 'linear',
      x1: 10.1,
      y1: 0.7,
      x2: 40.3,
      y2: 0.7,
      stops: [
        { offset: 0, color: '#ff0000' },
        { offset: 1, color: '#0000ff' },
      ],
    },
  })
  for (const dx of [0.1, 0.3, 0.7, 1.1, 3.3, -9.7, 12.34, 0.05, 7.77]) {
    const moved = transformItem({ ...src, id: 'b' }, [1, 0, 0, 1, dx, 0.3]) as PathItem
    assert.equal(withAppearance(moved, src), moved, `dx ${dx}`)
  }
})

test('the eyedropper samples the text run under the pointer, not the first one', async () => {
  const { sampledPath } = await import('../src/lib/editor/appearance.ts')
  const text: GroupItem = {
    kind: 'group',
    id: 'T',
    visible: true,
    children: [rect('T~0', 0, 0, 10, 10, { fill: '#000000' }), rect('T~1', 20, 0, 10, 10, { fill: '#ff0000' })],
  }
  assert.equal(sampledPath(text, { x: 25, y: 5 }, 0.5)?.fill, '#ff0000')
  assert.equal(sampledPath(text, { x: 5, y: 5 }, 0.5)?.fill, '#000000')
  // Between the letters: the first run, as before.
  assert.equal(sampledPath(text, { x: 15, y: 5 }, 0.5)?.fill, '#000000')
})
