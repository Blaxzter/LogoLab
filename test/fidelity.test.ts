// The trace fidelity metric and its heat (src/lib/render/fidelity.ts), plus the
// rasterizer's `scale` — the three pieces behind the studio's ΔE readout and its
// Difference view.
//
//   node --test test/fidelity.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deltaEField,
  deltaEStats,
  deltaEHeat,
  fidelity,
  HEAT_FULL_SCALE_DE,
} from '../src/lib/render/fidelity.ts'
import { heatColor, HEAT_BG_RGB } from '../src/lib/heat.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import type { EditableDoc, PathItem, SubPath } from '../src/lib/path/types.ts'

function buf(w: number, h: number, rgba: [number, number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    px[i * 4] = rgba[0]
    px[i * 4 + 1] = rgba[1]
    px[i * 4 + 2] = rgba[2]
    px[i * 4 + 3] = rgba[3]
  }
  return px
}

const heatAt = (px: Uint8ClampedArray, i: number): [number, number, number] => [
  px[i * 4],
  px[i * 4 + 1],
  px[i * 4 + 2],
]

test('identical buffers: no error, and a heat that is all backdrop', () => {
  const a = buf(8, 8, [120, 60, 200, 255])
  const f = deltaEField(a, a, 8, 8)
  const s = deltaEStats(f.de)
  assert.equal(s.meanDeltaE, 0)
  assert.equal(s.p95DeltaE, 0)
  const heat = deltaEHeat(f.de)
  for (let i = 0; i < 64; i++) assert.deepEqual(heatAt(heat, i), HEAT_BG_RGB)
})

test('black vs white: ΔE ~100, and the heat pins to the ramp\'s hottest stop', () => {
  const f = deltaEField(buf(8, 8, [0, 0, 0, 255]), buf(8, 8, [255, 255, 255, 255]), 8, 8)
  const s = deltaEStats(f.de)
  assert.ok(Math.abs(s.meanDeltaE - 100) < 1, `meanDeltaE ${s.meanDeltaE}`)
  const hottest = heatColor(1).map(Math.round)
  assert.deepEqual(heatAt(deltaEHeat(f.de), 0), hottest as [number, number, number])
})

// The note on the issue that filed this: the truth gate composites on white while
// the labs' fixture lane keeps transparency, and they are two different traces. A
// logo IS usually art on transparency, so scoring its raw RGB would read every
// transparent pixel as black and report a perfect trace as a catastrophic one.
test('a transparent source pixel is white, not black', () => {
  const src = buf(4, 4, [0, 0, 0, 0]) // fully transparent — RGB is meaningless
  const render = buf(4, 4, [255, 255, 255, 255]) // what the rasterizer emits there
  const s = deltaEStats(deltaEField(src, render, 4, 4).de)
  assert.equal(s.meanDeltaE, 0, 'transparency composited over white matches white')

  // And the same pixels scored raw (opaque black) are the disaster it would have
  // looked like — this is the number the guard above is preventing.
  const opaqueBlack = buf(4, 4, [0, 0, 0, 255])
  assert.ok(deltaEStats(deltaEField(opaqueBlack, render, 4, 4).de).meanDeltaE > 99)
})

test('the number and the picture come from ONE field', () => {
  // Left half wrong (black vs white), right half exact.
  const w = 8
  const h = 4
  const src = buf(w, h, [255, 255, 255, 255])
  const render = buf(w, h, [255, 255, 255, 255])
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w / 2; x++) {
      const o = (y * w + x) * 4
      render[o] = render[o + 1] = render[o + 2] = 0
    }
  const f = deltaEField(src, render, w, h)
  const s = deltaEStats(f.de)
  assert.ok(Math.abs(s.meanDeltaE - 50) < 1, `half wrong ⇒ half the error: ${s.meanDeltaE}`)

  const heat = deltaEHeat(f.de)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const cold = heatAt(heat, i)[0] === HEAT_BG_RGB[0] && heatAt(heat, i)[2] === HEAT_BG_RGB[2]
      assert.equal(cold, x >= w / 2, `pixel ${x},${y} is hot exactly where the render is wrong`)
    }
})

test('the heat saturates at HEAT_FULL_SCALE_DE and floors below a JND', () => {
  // A ΔE field written by hand, so the ramp is tested rather than the metric.
  const de = Float64Array.from([0, 0.4, HEAT_FULL_SCALE_DE, HEAT_FULL_SCALE_DE * 4])
  const heat = deltaEHeat(de)
  assert.deepEqual(heatAt(heat, 0), HEAT_BG_RGB)
  assert.deepEqual(heatAt(heat, 1), HEAT_BG_RGB, 'sub-JND noise would otherwise fog the whole view')
  const hottest = heatColor(1).map(Math.round) as [number, number, number]
  assert.deepEqual(heatAt(heat, 2), hottest, 'full scale is hot')
  assert.deepEqual(heatAt(heat, 3), hottest, 'and past it stays hot rather than wrapping')
})

// The claim the move into src/lib/ exists to protect: "1.8 ΔE" in the studio's
// status bar and "1.8 ΔE" in the harness's benchmark table are the same number,
// because they are the same code. A second implementation would pass every test
// above and still quietly make them two different claims.
test('the studio\'s numbers are the harness\'s numbers', () => {
  const src = buf(16, 16, [30, 120, 200, 255])
  const render = buf(16, 16, [40, 110, 190, 255])
  const harness = fidelity(src, render, 16, 16)
  const studio = deltaEStats(deltaEField(src, render, 16, 16).de)
  assert.equal(studio.meanDeltaE, harness.meanDeltaE)
  assert.equal(studio.p95DeltaE, harness.p95DeltaE)
})

/* ------------------------------------------------------- rasterizer scale */

function rect(x: number, y: number, w: number, h: number): SubPath {
  const c = (px: number, py: number) => ({ x: px, y: py, hIn: null, hOut: null, kind: 'corner' as const })
  return { closed: true, nodes: [c(x, y), c(x + w, y), c(x + w, y + h), c(x, y + h)] }
}

/** A circle as four cubic quadrants — the case that catches flattening tolerance
 *  being applied in the wrong space (it goes visibly polygonal when upscaled). */
function circle(cx: number, cy: number, r: number): SubPath {
  const k = 0.5522847498 * r
  const n = (x: number, y: number, hIn: { x: number; y: number } | null, hOut: { x: number; y: number } | null) => ({
    x, y, hIn, hOut, kind: 'smooth' as const,
  })
  return {
    closed: true,
    nodes: [
      n(cx, cy - r, { x: cx + k, y: cy - r }, { x: cx - k, y: cy - r }),
      n(cx - r, cy, { x: cx - r, y: cy - k }, { x: cx - r, y: cy + k }),
      n(cx, cy + r, { x: cx - k, y: cy + r }, { x: cx + k, y: cy + r }),
      n(cx + r, cy, { x: cx + r, y: cy + k }, { x: cx + r, y: cy - k }),
    ],
  }
}

function doc(w: number, h: number, items: PathItem[]): EditableDoc {
  return { viewBox: [0, 0, w, h], items }
}

const item = (subPaths: SubPath[], fill: string, extra: Partial<PathItem> = {}): PathItem => ({
  kind: 'path', id: 'a', fill, fillRule: 'nonzero', subPaths, visible: true, ...extra,
})

/** Mean of the red channel — a coverage proxy for black-on-white art. */
function meanRed(px: Uint8ClampedArray): number {
  let sum = 0
  for (let i = 0; i < px.length; i += 4) sum += px[i]
  return sum / (px.length / 4)
}

test('scale renders the same picture smaller: coverage is scale-invariant', () => {
  const d = doc(256, 256, [item([rect(32, 32, 96, 96)], '#000000')])
  const native = meanRed(rasterizeDoc(d, 256, 256))
  for (const k of [0.5, 0.25]) {
    const n = Math.round(256 * k)
    const scaled = meanRed(rasterizeDoc(d, n, n, { scale: k }))
    assert.ok(Math.abs(scaled - native) < 1, `scale ${k}: ${scaled} vs ${native}`)
  }
})

test('curves stay curves when scaled UP — flattening tolerance is in output px', () => {
  // A cleaned SVG's viewBox can be 24 units wide, so rendering it at 480 is scale
  // 20. With the tolerance measured in USER units the chord error would be ~0.15
  // units — 3 OUTPUT pixels — and the circle would come back a visible polygon.
  //
  // Flattening always INSCRIBES (de Casteljau lands on the curve), so the area it
  // loses is the measurement: summed coverage against πr². The fix holds it to
  // 0.01% of the disc; measured in user units it is 0.6%, fifty times worse.
  const r = 10
  const scale = 20
  const n = 24 * scale
  const px = rasterizeDoc(doc(24, 24, [item([circle(12, 12, r)], '#000000')]), n, n, { scale })
  let covered = 0
  for (let i = 0; i < px.length; i += 4) covered += (255 - px[i]) / 255
  const truth = Math.PI * (r * scale) ** 2
  const deficit = (truth - covered) / truth
  assert.ok(deficit < 0.001, `disc is ${(deficit * 100).toFixed(3)}% short of round`)
})

test('a gradient ramps across the same span at any scale', () => {
  const gradient = {
    type: 'linear' as const,
    x1: 0, y1: 0, x2: 128, y2: 0,
    stops: [
      { offset: 0, color: '#000000' },
      { offset: 1, color: '#ffffff' },
    ],
  }
  const d = doc(128, 16, [item([rect(0, 0, 128, 16)], '#000000', { gradient })])
  const half = rasterizeDoc(d, 64, 8, { scale: 0.5 })
  const at = (x: number) => half[(4 * 64 + x) * 4]
  assert.ok(at(0) < 12, `left end is black: ${at(0)}`)
  assert.ok(at(63) > 243, `right end is white: ${at(63)}`)
  assert.ok(Math.abs(at(32) - 128) < 8, `midpoint is mid-grey: ${at(32)}`)
})
