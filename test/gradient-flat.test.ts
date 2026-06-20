// Per-region gradient↔flat toggle (PathItem.gradientHidden). The editor flag
// makes a fitted gradient render and export as the solid `fill`, while the
// gradient itself is retained so the toggle is reversible.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { serializeDoc } from '../src/lib/path/model.ts'
import type { EditableDoc, GradientFill, PathItem, SubPath } from '../src/lib/path/types.ts'

const W = 20
const H = 6

const rect = (): SubPath => {
  const c = (x: number, y: number) => ({ x, y, hIn: null, hOut: null, kind: 'corner' as const })
  return { closed: true, nodes: [c(0, 0), c(W, 0), c(W, H), c(0, H)] }
}

const grad: GradientFill = {
  type: 'linear',
  x1: 0, y1: 0, x2: W, y2: 0,
  stops: [
    { offset: 0, color: '#ff0000' },
    { offset: 1, color: '#0000ff' },
  ],
}

function makeDoc(gradientHidden: boolean): EditableDoc {
  const item: PathItem = {
    kind: 'path',
    id: 'r0',
    fill: '#00cc00',
    fillRule: 'nonzero',
    gradient: grad,
    subPaths: [rect()],
    visible: true,
  }
  if (gradientHidden) item.gradientHidden = true
  return { viewBox: [0, 0, W, H], items: [item] }
}

const at = (px: Uint8ClampedArray, x: number, y: number): [number, number, number] => {
  const o = (y * W + x) * 4
  return [px[o], px[o + 1], px[o + 2]]
}

test('gradient-flat: a gradient region renders its ramp by default', () => {
  const px = rasterizeDoc(makeDoc(false), W, H)
  const [lr, , lb] = at(px, 1, 3) // near the red end
  const [rr, , rb] = at(px, W - 2, 3) // near the blue end
  assert.ok(lr > 180 && lb < 80, `left should be red-ish, got ${lr},${lb}`)
  assert.ok(rr < 80 && rb > 180, `right should be blue-ish, got ${rr},${rb}`)
})

test('gradient-flat: gradientHidden renders the solid fill everywhere', () => {
  const px = rasterizeDoc(makeDoc(true), W, H)
  for (const x of [1, W >> 1, W - 2]) {
    const [r, g, b] = at(px, x, 3)
    assert.ok(r < 40 && g > 180 && b < 60, `x=${x} should be flat green, got ${r},${g},${b}`)
  }
})

test('gradient-flat: SVG export uses url(#…) gradient by default', () => {
  const svg = serializeDoc(makeDoc(false))
  assert.match(svg, /linearGradient/, 'a gradient paint server is emitted')
  assert.match(svg, /fill="url\(#/, 'the path references the gradient')
})

test('gradient-flat: gradientHidden exports a flat solid fill (no gradient def)', () => {
  const svg = serializeDoc(makeDoc(true))
  assert.doesNotMatch(svg, /linearGradient/, 'no gradient paint server when flattened')
  assert.match(svg, /fill="#00cc00"/, 'the path uses its solid fill')
})

test('gradient-flat: toggling the flag back restores identical output (reversible)', () => {
  // The gradient is retained, so off→on→off round-trips byte-identically.
  assert.equal(serializeDoc(makeDoc(false)), serializeDoc(makeDoc(false)))
  const onceHidden = makeDoc(true)
  const restored: EditableDoc = {
    ...onceHidden,
    items: onceHidden.items.map((it) => (it.kind === 'path' ? { ...it, gradientHidden: false } : it)),
  }
  assert.equal(serializeDoc(restored), serializeDoc(makeDoc(false)))
})
