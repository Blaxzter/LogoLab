// Colour line art through the centreline engine (src/lib/trace/centerline/colour.ts):
// the inks are traced as ONE line drawing and each stroke is painted in the ink it
// runs through. What this gates: the colours land on the right strokes, a crossing
// of two inks leaves both lines whole (the reason for tracing the union), the paper
// comes back as one rectangle (or not at all on transparency / removeBackground).
//
//   node --test test/colour-strokes.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { PathItem } from '../src/lib/path/types.ts'
import type { VectorizeOptions } from '../src/types.ts'

type RGBA = [number, number, number, number]
type Shape = { c: RGBA; inside: (x: number, y: number) => boolean }

/** Shapes painted in order over `bg`, 4×4 supersampled so every edge is anti-aliased. */
function paint(w: number, h: number, bg: RGBA, shapes: Shape[]): ImageData {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0]
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4
          const py = y + (sy + 0.5) / 4
          let c = bg
          for (const s of shapes) if (s.inside(px, py)) c = s.c
          // Premultiplied, so a transparent background averages correctly.
          acc[0] += c[0] * c[3]
          acc[1] += c[1] * c[3]
          acc[2] += c[2] * c[3]
          acc[3] += c[3]
        }
      const a = acc[3] / 16
      const p = (y * w + x) * 4
      data[p] = a > 0 ? acc[0] / acc[3] : 0
      data[p + 1] = a > 0 ? acc[1] / acc[3] : 0
      data[p + 2] = a > 0 ? acc[2] / acc[3] : 0
      data[p + 3] = Math.round(a)
    }
  return { width: w, height: h, data, colorSpace: 'srgb' } as ImageData
}

const hbar = (x0: number, x1: number, cy: number, w: number) => (x: number, y: number) =>
  x >= x0 && x <= x1 && Math.abs(y - cy) < w / 2
const vbar = (cx: number, y0: number, y1: number, w: number) => (x: number, y: number) =>
  y >= y0 && y <= y1 && Math.abs(x - cx) < w / 2

const RED: RGBA = [220, 30, 40, 255]
const BLUE: RGBA = [30, 70, 210, 255]
const WHITE: RGBA = [255, 255, 255, 255]

const opts = (patch: Partial<VectorizeOptions> = {}): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  gradients: false,
  centerline: true,
  ...patch,
})

const paths = (items: unknown[]) => items.filter((it): it is PathItem => (it as PathItem).kind === 'path')
const strokes = (items: unknown[]) => paths(items).filter((it) => it.stroke && it.fill === 'none')
const near = (hex: string, c: RGBA) => {
  const v = parseInt(hex.slice(1), 16)
  return Math.hypot(((v >> 16) & 255) - c[0], ((v >> 8) & 255) - c[1], (v & 255) - c[2]) < 30
}
/** Horizontal / vertical reach of a stroke's anchors. */
const span = (it: PathItem) => {
  const xs = it.subPaths.flatMap((sp) => sp.nodes.map((n) => n.x))
  const ys = it.subPaths.flatMap((sp) => sp.nodes.map((n) => n.y))
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

test('two inks crossing: each line comes back whole, in its own colour, over a paper rectangle', async () => {
  const img = paint(160, 160, WHITE, [
    { c: BLUE, inside: vbar(80, 20, 140, 8) },
    { c: RED, inside: hbar(20, 140, 80, 8) },
  ])
  const doc = await traceImage(img, opts())
  const s = strokes(doc.items)
  const red = s.filter((it) => near(it.stroke!.color, RED))
  const blue = s.filter((it) => near(it.stroke!.color, BLUE))
  assert.equal(red.length, 1, `one red stroke, got ${s.map((it) => it.stroke!.color).join(' ')}`)
  assert.equal(blue.length, 1, 'one blue stroke')
  // Whole through the crossing: each spans (nearly) its bar's full length.
  assert.ok(span(red[0]).w > 110, `red spans ${span(red[0]).w}`)
  assert.ok(span(blue[0]).h > 110, `blue spans ${span(blue[0]).h}`)
  for (const it of [...red, ...blue]) assert.ok(Math.abs(it.stroke!.width - 8) < 1.5, `width ${it.stroke!.width}`)
  const paper = paths(doc.items).find((it) => it.id === 'paper')
  assert.ok(paper && near(paper.fill, WHITE), 'the paper is one white rectangle')
  assert.equal(doc.items[0], paper, 'painted first, under the strokes')
})

test('removeBackground drops the paper rectangle', async () => {
  const img = paint(120, 120, WHITE, [{ c: RED, inside: hbar(20, 100, 60, 8) }])
  const doc = await traceImage(img, opts({ removeBackground: true }))
  assert.equal(
    paths(doc.items).find((it) => it.id === 'paper'),
    undefined,
  )
  assert.equal(strokes(doc.items).length, 1)
})

test('a coloured paper stays the paper, and a light ink on it is the line', async () => {
  const navy: RGBA = [20, 30, 80, 255]
  const img = paint(120, 120, navy, [{ c: WHITE, inside: hbar(20, 100, 60, 8) }])
  const doc = await traceImage(img, opts())
  const s = strokes(doc.items)
  assert.equal(s.length, 1)
  assert.ok(near(s[0].stroke!.color, WHITE), `stroke ${s[0].stroke!.color}`)
  const paper = paths(doc.items).find((it) => it.id === 'paper')
  assert.ok(paper && near(paper.fill, navy))
})

test('on transparency there is no paper, and a white line still traces', async () => {
  const img = paint(120, 120, [0, 0, 0, 0], [{ c: WHITE, inside: hbar(20, 100, 60, 8) }])
  const doc = await traceImage(img, opts())
  assert.equal(
    paths(doc.items).find((it) => it.id === 'paper'),
    undefined,
  )
  const s = strokes(doc.items)
  assert.equal(s.length, 1)
  assert.ok(near(s[0].stroke!.color, WHITE))
  assert.ok(span(s[0]).w > 70)
})

test('a line of one ink tied to a shape of another is cut where the ink changes', async () => {
  // A pink diamond with a dark string hanging from its bottom corner: the junction
  // pairing threads the string onto one of the diamond's arms, and the paint splits it.
  const PINK: RGBA = [224, 69, 123, 255]
  const DARK: RGBA = [31, 35, 48, 255]
  const seg = (x0: number, y0: number, x1: number, y1: number, w: number) => (x: number, y: number) => {
    const dx = x1 - x0
    const dy = y1 - y0
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)) <= w / 2
  }
  const diamond = [seg(100, 20, 150, 70, 10), seg(150, 70, 100, 120, 10), seg(100, 120, 50, 70, 10), seg(50, 70, 100, 20, 10)]
  const img = paint(200, 220, WHITE, [
    ...diamond.map((inside) => ({ c: PINK, inside })),
    { c: DARK, inside: seg(100, 120, 110, 200, 10) },
  ])
  const doc = await traceImage(img, opts())
  const s = strokes(doc.items)
  const dark = s.filter((it) => near(it.stroke!.color, DARK))
  assert.equal(dark.length, 1, `one dark stroke, got ${s.map((it) => it.stroke!.color).join(' ')}`)
  const ys = dark[0].subPaths.flatMap((sp) => sp.nodes.map((n) => n.y))
  assert.ok(Math.min(...ys) > 105, `the dark stroke stays on the string (top at y=${Math.min(...ys)})`)
  assert.ok(Math.max(...ys) > 190, 'and reaches its end')
  const pinkSpan = s.filter((it) => near(it.stroke!.color, PINK)).flatMap((it) => it.subPaths.flatMap((sp) => sp.nodes.map((n) => n.y)))
  assert.ok(Math.max(...pinkSpan) < 130, 'no pink runs down the string')
})

test('strokes come back stacked as the source stacks them', async () => {
  // A green stem ending in a purple bar, the stem painted OVER the bar — then the reverse.
  // The engine's assembly order is the same for both; only the paint tells them apart.
  const PURPLE: RGBA = [128, 64, 190, 255]
  const GREEN: RGBA = [39, 153, 84, 255]
  const bar = { inside: hbar(20, 180, 150, 16) }
  const stem = { inside: vbar(100, 30, 150, 16) }
  const z = (doc: { items: unknown[] }, c: RGBA) => doc.items.findIndex((it) => (it as PathItem).stroke && near((it as PathItem).stroke!.color, c))
  for (const [below, above] of [
    [PURPLE, GREEN],
    [GREEN, PURPLE],
  ] as const) {
    const shapes = below === PURPLE ? [{ c: PURPLE, ...bar }, { c: GREEN, ...stem }] : [{ c: GREEN, ...stem }, { c: PURPLE, ...bar }]
    const doc = await traceImage(paint(200, 200, WHITE, shapes), opts())
    assert.ok(z(doc, below) >= 0 && z(doc, above) >= 0, 'both strokes traced')
    assert.ok(z(doc, above) > z(doc, below), `${above === GREEN ? 'green' : 'purple'} is painted over ${below === GREEN ? 'green' : 'purple'}`)
  }
})
