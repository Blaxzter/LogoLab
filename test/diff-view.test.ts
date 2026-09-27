// The Difference PICTURE (src/lib/render/diffView.ts): the ΔE heat laid over a
// ghost of the source, and the pixel readout under the cursor. What these gate is
// that the picture never becomes a second, softer measurement: from HEAT_OPAQUE_DE
// up it is the heat byte for byte, below it fades by the SAME field, and the
// readout quotes the bytes the number was measured on.
//
//   node --test test/diff-view.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deltaEField, deltaEHeat, HEAT_FULL_SCALE_DE, HEAT_FLOOR } from '../src/lib/render/fidelity.ts'
import { HEAT_BG_RGB, heatColor } from '../src/lib/heat.ts'
import { diffPicture, probeDiff, GHOST_MAX, HEAT_OPAQUE_DE } from '../src/lib/render/diffView.ts'

function buf(w: number, h: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4)
  return px
}

const px = (b: Uint8ClampedArray, i: number): [number, number, number] => [b[i * 4], b[i * 4 + 1], b[i * 4 + 2]]

test('a right trace shows the art, not a black square', () => {
  // Source: white, black ink, transparent. Render: what each is over white — so the
  // field is 0 everywhere and the heat is all backdrop.
  const w = 3
  const h = 1
  const src = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 0])
  const render = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255])
  const f = deltaEField(src, render, w, h)
  assert.ok(
    f.de.every((d) => d === 0),
    'a right trace',
  )
  const pic = diffPicture(deltaEHeat(f.de), f.de, src, w, h)
  assert.deepEqual(px(pic, 0), [GHOST_MAX, GHOST_MAX, GHOST_MAX], 'white paper is the ghost at its brightest')
  assert.deepEqual(px(pic, 1), HEAT_BG_RGB, 'black ink is the backdrop')
  assert.deepEqual(px(pic, 2), HEAT_BG_RGB, 'transparency is the backdrop, not black-ink-on-white')
  assert.ok(
    pic.every((_, i) => i % 4 !== 3 || pic[i] === 255),
    'opaque',
  )
})

test('from HEAT_OPAQUE_DE up the picture IS the heat, byte for byte', () => {
  const de = Float64Array.from([0, HEAT_OPAQUE_DE, HEAT_FULL_SCALE_DE, HEAT_FULL_SCALE_DE * 4])
  const heat = deltaEHeat(de)
  const src = buf(4, 1, [255, 255, 255, 255]) // the brightest ghost there is
  const pic = diffPicture(heat, de, src, 4, 1)
  assert.deepEqual(px(pic, 0), [GHOST_MAX, GHOST_MAX, GHOST_MAX], 'no error: pure ghost')
  for (let i = 1; i < 4; i++)
    assert.deepEqual(px(pic, i), px(heat, i), `pixel ${i} is the heat, untouched by the ghost`)
})

test('below it the heat fades into the ghost by the same field, with no seam at the floor', () => {
  const floor = HEAT_FLOOR * HEAT_FULL_SCALE_DE
  const mid = (floor + HEAT_OPAQUE_DE) / 2
  const de = Float64Array.from([floor * 0.99, floor * 1.01, mid])
  const heat = deltaEHeat(de)
  const src = buf(3, 1, [255, 255, 255, 255])
  const pic = diffPicture(heat, de, src, 3, 1)
  assert.deepEqual(px(pic, 0), [GHOST_MAX, GHOST_MAX, GHOST_MAX], 'under the floor: ghost')
  const justOver = px(pic, 1)
  for (let c = 0; c < 3; c++)
    assert.ok(Math.abs(justOver[c] - GHOST_MAX) <= 1, `continuous across the floor (${justOver})`)
  // Half-way: strictly between the ghost and the heat on the ramp's blue, which
  // is the channel the cold end of the ramp carries.
  const b = px(pic, 2)[2]
  assert.ok(b > GHOST_MAX && b < px(heat, 2)[2], `mid ΔE is a mix: ghost ${GHOST_MAX} < ${b} < heat ${px(heat, 2)[2]}`)
})

test('the ghost is darker than every warm stop of the ramp', () => {
  // t = 1/6 is the first stop past the near-black one; from there up the ramp's
  // dominant channel must beat the ghost so the art never reads as heat.
  for (let t = 1 / 6; t <= 1; t += 1 / 60) {
    const peak = Math.max(...heatColor(t))
    assert.ok(peak > GHOST_MAX, `ramp at t=${t.toFixed(2)} peaks at ${peak}, above the ghost`)
  }
})

test('the readout quotes the scored bytes: a transparent source pixel reads white', () => {
  const w = 2
  const h = 1
  const source = new Uint8ClampedArray([0, 0, 0, 0, 200, 20, 20, 255]) // transparent (RGB meaningless), then red
  const render = buf(w, h, [255, 255, 255, 255])
  const f = deltaEField(source, render, w, h)
  const bufs = { width: w, height: h, de: f.de, source, render }

  const left = probeDiff(bufs, 0.25, 0.5)
  assert.ok(left)
  assert.deepEqual([left.x, left.y], [0, 0])
  assert.deepEqual(left.source, [255, 255, 255], 'composited over white, as the metric scores it')
  assert.deepEqual(left.render, [255, 255, 255])
  assert.equal(left.deltaE, 0)

  const right = probeDiff(bufs, 0.75, 0.5)
  assert.ok(right)
  assert.equal(right.x, 1)
  assert.deepEqual(right.source, [200, 20, 20])
  assert.equal(right.deltaE, f.de[1], 'the field value, not a re-measurement')
  assert.ok(right.deltaE > 50)

  assert.equal(probeDiff(bufs, 1, 0.5), null, 'the far edge is outside')
  assert.equal(probeDiff(bufs, -0.01, 0.5), null)
  assert.equal(probeDiff(bufs, 0.5, 1.2), null)
})
