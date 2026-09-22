// A small mono raster is enlarged before it is traced — by its size (the icon
// sheet's measured rule) or by the thickness of its thin ink, whichever asks for
// more, and never past the flat raster cap.
//
//   node --test test/stroke-width.test.ts
//
// The case behind the stroke rule: a 499px page of sheet music whose staff lines
// are 1px. Not small by the size rule (×1), and at ×1 every staff line melted
// into the note heads; 3× traced them clean.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  hairlineCut,
  hairlineRaise,
  inkThickness,
  HAIRLINE_FULL_SHARE,
  HAIRLINE_MAX_RAISE,
  HAIRLINE_MIN_SHARE,
  THIN_INK_SHARE,
} from '../src/lib/strokeWidth.ts'
import {
  monoTraceScale,
  strokeScale,
  traceScale,
  MONO_UPSCALE_MAX,
  RASTER_MAX_DIM_FLAT,
  RASTER_MAX_DIM_HIGH,
} from '../src/lib/traceCaps.ts'
import { DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { ImageDataLike } from '../src/lib/ink.ts'
import type { VectorizeOptions } from '../src/types'

/** White opaque paper. */
function paper(w: number, h: number): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  return { width: w, height: h, data }
}

function fill(img: ImageDataLike, x0: number, y0: number, w: number, h: number): void {
  for (let y = y0; y < Math.min(img.height, y0 + h); y++)
    for (let x = x0; x < Math.min(img.width, x0 + w); x++) {
      const i = (y * img.width + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 0
    }
}

const mono: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'mono', threshold: 128 }

test('thickness is the local stroke width, not the stroke length', () => {
  const img = paper(400, 400)
  for (let y = 40; y < 400; y += 40) fill(img, 20, y, 360, 1) // 1px staff lines, 360px long
  const t = inkThickness(img, 128, false)
  assert.ok(t)
  assert.equal(t.thickness, 1)
  const thick = paper(400, 400)
  fill(thick, 50, 50, 300, 12) // one 12px bar
  fill(thick, 50, 200, 12, 150) // one 12px post
  assert.equal(inkThickness(thick, 128, false)?.thickness, 12)
})

test('a sliver of thin ink does not set the thickness; a real share does', () => {
  const img = paper(400, 400)
  fill(img, 50, 50, 300, 300) // 90 000 px of solid
  fill(img, 10, 380, 380, 1) // 380 px of hairline — 0.4% of the ink
  assert.ok(inkThickness(img, 128, false)!.thickness > 3, 'the hairline is dust next to the block')
  for (let y = 360; y < 400; y += 3) fill(img, 0, y, 400, 1) // ~5 600 px more of hairline
  const share = 5600 / (90000 + 5600)
  assert.ok(share < THIN_INK_SHARE, 'still under the share…')
  fill(img, 0, 0, 400, 1)
  for (let x = 0; x < 400; x += 3) fill(img, x, 0, 1, 45) // …and now over it
  assert.equal(inkThickness(img, 128, false)!.thickness, 1)
})

test('the mask is the tracer’s own cut: alpha is coverage, invert flips the side', () => {
  const img = paper(100, 100)
  fill(img, 0, 40, 100, 2) // 2px line
  for (let x = 0; x < 100; x++) img.data[(45 * 100 + x) * 4 + 3] = 0 // an invisible 1px "line"
  fill(img, 0, 45, 100, 1)
  assert.equal(inkThickness(img, 128, false)!.thickness, 2, 'the transparent row does not count')
  // The sheet-music case: a 1px line whose anti-aliasing lives in ALPHA (black RGB,
  // alpha 255 on the line, 90 on the rows beside it) is 1px, not 3.
  const aa = paper(100, 100)
  for (let x = 0; x < 100; x++)
    for (const [y, a] of [[59, 90], [60, 255], [61, 90]] as const) {
      const i = (y * 100 + x) * 4
      aa.data[i] = aa.data[i + 1] = aa.data[i + 2] = 0
      aa.data[i + 3] = a
    }
  assert.equal(inkThickness(aa, 128, false)!.thickness, 1)
  // Light ink on dark paper: the same 2px line, inverted.
  const dark = paper(100, 100)
  for (let i = 0; i < dark.data.length; i += 4) dark.data[i] = dark.data[i + 1] = dark.data[i + 2] = 0
  for (let x = 0; x < 100; x++)
    for (const y of [40, 41]) {
      const i = (y * 100 + x) * 4
      dark.data[i] = dark.data[i + 1] = dark.data[i + 2] = 255
    }
  assert.equal(inkThickness(dark, 128, true)!.thickness, 2)
  // Un-inverted, the "ink" is the ground itself: two black bands 40 and 58 rows tall.
  assert.equal(inkThickness(dark, 128, false)!.thickness, 40)
})

test('the two rules: size toward ~512px (≤3×), stroke toward ~3px (≤4×)', () => {
  assert.equal(traceScale(170), 3)
  assert.equal(traceScale(499), 1)
  assert.equal(traceScale(1024), 1)
  assert.equal(strokeScale(1), 3)
  assert.equal(strokeScale(2), 2)
  assert.equal(strokeScale(3), 1)
  assert.equal(strokeScale(0.5), MONO_UPSCALE_MAX)
})

test('the sheet-music page: not small, but its 1px staff wants ×3', () => {
  const img = paper(499, 488)
  for (let y = 30; y < 488; y += 12) fill(img, 20, y, 460, 1)
  const plan = monoTraceScale(img, mono)
  assert.equal(plan.thickness, 1)
  assert.equal(plan.scale, 3)
  assert.equal(plan.by, 'stroke')
})

test('thick strokes on a mid-size raster are traced as they are', () => {
  const img = paper(499, 488)
  fill(img, 40, 40, 400, 20)
  fill(img, 40, 200, 20, 250)
  const plan = monoTraceScale(img, mono)
  assert.equal(plan.scale, 1)
  assert.equal(plan.by, 'none')
})

test('a tiny tile still gets the sheet’s ×3 whatever its strokes', () => {
  const img = paper(170, 170)
  fill(img, 30, 30, 110, 110)
  const plan = monoTraceScale(img, mono)
  assert.equal(plan.scale, 3)
  assert.equal(plan.by, 'size')
})

test('never past the flat cap; High detail makes room', () => {
  const img = paper(1200, 900)
  for (let y = 30; y < 900; y += 12) fill(img, 20, y, 1160, 1)
  assert.equal(Math.floor(RASTER_MAX_DIM_FLAT / 1200), 1)
  assert.equal(monoTraceScale(img, mono).scale, 1, 'no room below the 2048 cap')
  assert.equal(Math.floor(RASTER_MAX_DIM_HIGH / 1200), 3)
  assert.equal(monoTraceScale(img, { ...mono, traceDetail: 'high' }).scale, 3)
})

test('colour, an explicit Off, and the AI path are left alone', () => {
  const img = paper(200, 200)
  for (let y = 10; y < 200; y += 10) fill(img, 0, y, 200, 1)
  assert.equal(monoTraceScale(img, { ...mono, mode: 'color' }).scale, 1)
  assert.equal(monoTraceScale(img, { ...mono, upscale: 'off' }).scale, 1)
  assert.equal(monoTraceScale(img, { ...mono, upscale: 'ai' }).scale, 1)
  assert.equal(monoTraceScale(img, { ...mono, upscale: 'auto' }).scale, 3)
  assert.equal(monoTraceScale(img, mono).scale, 3, 'omitted means auto')
})

/* ------------------------------------------------ the cut follows the thin ink */

/** Paint a 1px horizontal line of grey `g` (a sub-pixel stroke's peak coverage). */
function hair(img: ImageDataLike, y: number, g: number): void {
  for (let x = 4; x < img.width - 4; x++) {
    const i = (y * img.width + x) * 4
    img.data[i] = img.data[i + 1] = img.data[i + 2] = g
  }
}

test('the raise follows the lost share: nothing under the gate, the square root above it, capped', () => {
  assert.equal(hairlineRaise(0), 0)
  assert.equal(hairlineRaise(HAIRLINE_MIN_SHARE / 2), 0)
  assert.equal(hairlineRaise(HAIRLINE_FULL_SHARE), Math.round(HAIRLINE_MAX_RAISE * 255))
  assert.equal(hairlineRaise(1), Math.round(HAIRLINE_MAX_RAISE * 255), 'capped at the full share')
  assert.equal(hairlineRaise(HAIRLINE_FULL_SHARE / 4), Math.round((HAIRLINE_MAX_RAISE * 255) / 2), 'a quarter of the share is half the raise')
  assert.equal(hairlineRaise(HAIRLINE_FULL_SHARE, 100), Math.round(HAIRLINE_MAX_RAISE * 100), 'scaled by the ink-to-paper span')
})

test('sub-pixel strokes the midpoint loses raise the cut; solid strokes do not', () => {
  const img = paper(200, 200)
  for (let y = 10; y < 190; y += 6) hair(img, y, 160) // 30 hairlines at luma 160
  fill(img, 20, 20, 8, 8) // a little solid ink
  const read = hairlineCut(img, 128, false)
  assert.ok(read.lostShare > HAIRLINE_FULL_SHARE, 'nearly all of this ink is sub-pixel')
  assert.equal(read.ridgeLuma, 160)
  assert.equal(read.cut, 128 + hairlineRaise(read.lostShare))
  const solid = paper(200, 200)
  fill(solid, 20, 20, 160, 30)
  fill(solid, 20, 80, 12, 100)
  const none = hairlineCut(solid, 128, false)
  assert.equal(none.lostShare, 0)
  assert.equal(none.cut, 128)
})

test('a sliver of thin ink stays under the gate; a real share clears it', () => {
  const img = paper(200, 200)
  fill(img, 10, 10, 180, 150) // 27 000 px of solid
  hair(img, 180, 170) // one hairline, 192 px: 0.7%
  const little = hairlineCut(img, 128, false)
  assert.ok(little.lostShare < HAIRLINE_MIN_SHARE)
  assert.equal(little.cut, 128)
  for (let y = 164; y < 196; y += 3) hair(img, y, 170) // eleven more: ~7.6%
  const more = hairlineCut(img, 128, false)
  assert.ok(more.lostShare > HAIRLINE_MIN_SHARE)
  assert.equal(more.cut, 128 + hairlineRaise(more.lostShare))
})

test('light ink on dark paper: the same read, the cut lowered so the ridges rise above it', () => {
  const dark = paper(200, 200)
  for (let i = 0; i < dark.data.length; i += 4) dark.data[i] = dark.data[i + 1] = dark.data[i + 2] = 0
  for (let y = 10; y < 190; y += 6) hair(dark, y, 95) // luma 95 = darkness 160 on the inverted axis
  const inv = hairlineCut(dark, 127, true)
  assert.equal(inv.ridgeLuma, 95)
  assert.equal(inv.cut, 127 - hairlineRaise(inv.lostShare))
})

test('an anti-aliased edge of a thick stroke is a ramp, not a ridge', () => {
  const img = paper(200, 200)
  fill(img, 20, 20, 160, 60)
  // a two-step ramp along the bottom edge: 90 then 180, then paper
  for (let x = 20; x < 180; x++) {
    const a = (80 * 200 + x) * 4
    const b = (81 * 200 + x) * 4
    img.data[a] = img.data[a + 1] = img.data[a + 2] = 90
    img.data[b] = img.data[b + 1] = img.data[b + 2] = 180
  }
  const read = hairlineCut(img, 128, false)
  // The ramp's two END pixels read as diagonal ridges (a one-pixel ledge end); that is
  // dust, far under the gate. Everything along the ramp is a ramp.
  assert.ok(read.lostShare < 0.001, 'the ramp pixel at 180 has a darker neighbour on one side')
  assert.equal(read.cut, 128)
})

