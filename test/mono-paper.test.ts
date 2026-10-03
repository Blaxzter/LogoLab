// The PAPER (src/lib/path/paper.ts): an opaque ground comes back as one rectangle under a
// mono / line-art trace, like the colour path keeps its background region — and it is
// the one item a repaint must leave alone.
//
//   node --test test/mono-paper.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { isPaper, PAPER_ID } from '../src/lib/path/paper.ts'
import { forceColorDoc } from '../src/components/vectorize/studio/forceColorDoc.ts'
import { repaintDoc } from '../src/lib/sheet/traceTile.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'
import type { VectorizeOptions } from '../src/types.ts'

type RGBA = [number, number, number, number]

/** A bar of `ink` over `bg`, 4×4 supersampled so its edges are anti-aliased. */
function bar(bg: RGBA, ink: RGBA): ImageData {
  const w = 80
  const h = 80
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let inside = 0
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4
          const py = y + (sy + 0.5) / 4
          if (px >= 15 && px <= 65 && Math.abs(py - 40) < 4) inside++
        }
      const t = inside / 16
      const a = bg[3] * (1 - t) + ink[3] * t
      const p = (y * w + x) * 4
      for (let c = 0; c < 3; c++) data[p + c] = a > 0 ? (bg[c] * bg[3] * (1 - t) + ink[c] * ink[3] * t) / a : 0
      data[p + 3] = Math.round(a)
    }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

const mono = (patch: Partial<VectorizeOptions> = {}): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  mode: 'mono',
  threshold: 128,
  ...patch,
})
const paths = (doc: EditableDoc) => doc.items.filter((it): it is PathItem => it.kind === 'path')

test('mono on an opaque page keeps the page: one rectangle, first, in the page colour', async () => {
  for (const centerline of [false, true]) {
    const doc = await traceImage(bar([255, 255, 255, 255], [20, 22, 30, 255]), mono({ centerline }))
    const items = paths(doc)
    assert.equal(items[0].id, PAPER_ID, `paper first (centerline ${centerline})`)
    // The MEDIAN of the page, not the mean: the edge anti-aliasing would pull it to #fefefe.
    assert.equal(items[0].fill, '#ffffff')
    assert.ok(items.length >= 2, 'and the ink over it')
  }
})

test('a coloured page comes back in its own colour', async () => {
  const doc = await traceImage(bar([250, 240, 220, 255], [20, 22, 30, 255]), mono())
  assert.equal(paths(doc)[0].fill, '#faf0dc')
})

test('no page on transparency, and none when the background is removed', async () => {
  const onAlpha = await traceImage(bar([0, 0, 0, 0], [20, 22, 30, 255]), mono())
  assert.ok(!paths(onAlpha).some(isPaper), 'transparency has no paper')
  const removed = await traceImage(bar([255, 255, 255, 255], [20, 22, 30, 255]), mono({ removeBackground: true }))
  assert.ok(!paths(removed).some(isPaper), 'Remove background drops it')
})

test('a repaint paints the ink and leaves the paper alone', async () => {
  const doc = await traceImage(bar([255, 255, 255, 255], [20, 22, 30, 255]), mono({ centerline: true }))
  for (const [name, painted] of [
    ['forceColorDoc', forceColorDoc(doc, '#e0457b')],
    ['repaintDoc', repaintDoc(doc, '#e0457b')],
  ] as const) {
    const items = paths(painted)
    assert.equal(items.find(isPaper)?.fill, '#ffffff', `${name} keeps the paper white`)
    for (const it of items.filter((i) => !isPaper(i)))
      assert.equal(it.fill === 'none' ? it.stroke?.color : it.fill, '#e0457b', `${name} paints ${it.id}`)
  }
})
