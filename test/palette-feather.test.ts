// §0 #13 — the alpha-feather blend endpoint (paletteSegment.classifyBlends).
//
// Pins the DISCRIMINATION property the fix is built on: a soft-alpha FEATHER
// (an AI-export's 3–6px alpha ramp hugging an opaque shape) dissolves into its
// parent colour, while an AUTHORED translucent flat (one constant alpha) survives
// with its alpha intact. The separator is the alpha distribution — a feather
// RAMPS (α std ≥ FEATHER_ALPHA_STD, no modal plateau), a genuine translucent
// flat is ONE alpha (std ~0, mode share 1.0) — measured margins ≥ 1.5× both
// sides on the "100 years tour" repro + authored-flat controls (§0 #13).
//
//   node --test test/palette-feather.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { segmentFlatPalette } from '../src/lib/trace/paletteSegment.ts'

const SIZE = 128

/** Blank transparent RGBA canvas. */
function canvas(): Uint8ClampedArray {
  return new Uint8ClampedArray(SIZE * SIZE * 4)
}

function putPx(data: Uint8ClampedArray, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const o = (y * SIZE + x) * 4
  data[o] = r
  data[o + 1] = g
  data[o + 2] = b
  data[o + 3] = a
}

/** Opaque disc (r ≤ rCore) + alpha-feather rim (rCore < r ≤ rCore+4): the rim is
 *  ONE off-parent colour (the under-glow mix an AI export bakes in) whose alpha
 *  ramps 255→0 continuously — so the rim cluster's colour is off every accepted
 *  RGB segment while its alpha DISTRIBUTION ramps (high std, no modal plateau),
 *  the exact signature the feather gate keys on. Colour and alpha must be
 *  DECORRELATED like this: if colour tracked alpha, quantize would slice the rim
 *  into shells that are each one narrow alpha band (std < the gate). */
function featherDisc(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = canvas()
  const cx = 64, cy = 64, rCore = 40, rim = 4
  const mix = (c: number): number => Math.round(c + (255 - c) * 0.35)
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= rCore) putPx(data, x, y, 48, 96, 192, 255)
      else if (d <= rCore + rim) {
        const t = (d - rCore) / rim // 0..1 across the rim
        // ±1 deterministic jitter: a real feather's RGB varies pixel-to-pixel
        // (3-way mix), so it has ZERO exact-equality flat interior — without
        // this, the constant rim colour manufactures `real` evidence from its
        // own sub-α-mask neighbours (flatInteriorCounts is RGB-only) and gets
        // accepted before any blend/feather gate is consulted.
        const j = ((x * 7 + y * 13) % 3) - 1
        putPx(data, x, y, mix(48) + j, mix(96) + j, mix(192) + j, Math.round(255 * (1 - t)))
      }
    }
  }
  return { width: SIZE, height: SIZE, data }
}

/** Authored translucent flat: disc at ONE constant alpha (140), plus an opaque
 *  disc so the palette has an opaque anchor. */
function authoredTranslucent(): { width: number; height: number; data: Uint8ClampedArray } {
  const data = canvas()
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if (Math.hypot(x - 40, y - 64) <= 28) putPx(data, x, y, 48, 96, 192, 255)
      else if (Math.hypot(x - 92, y - 64) <= 28) putPx(data, x, y, 220, 60, 50, 140)
    }
  }
  return { width: SIZE, height: SIZE, data }
}

const OPTS = { maxColors: 8, minShare: 0.007, modePasses: 2, minRegionArea: 50 }

test('alpha feather dissolves into its parent (no translucent sliver survives)', () => {
  const res = segmentFlatPalette(featherDisc(), OPTS)
  const translucent = res.palette.filter((c) => c.a !== undefined && c.a < 255)
  assert.equal(
    translucent.length,
    0,
    `feather shells survived as translucent palette entries: ${JSON.stringify(translucent)}`,
  )
  // The parent colour must still be there (the feather routed INTO it, not away).
  const hasParent = res.palette.some((c) => Math.hypot(c.r - 48, c.g - 96, c.b - 192) < 20)
  assert.ok(hasParent, `parent colour missing from palette: ${JSON.stringify(res.palette)}`)
})

test('authored translucent flat survives with its alpha', () => {
  const res = segmentFlatPalette(authoredTranslucent(), OPTS)
  const translucent = res.palette.filter((c) => c.a !== undefined && c.a < 255)
  assert.equal(translucent.length, 1, `expected exactly the authored α140 flat: ${JSON.stringify(res.palette)}`)
  assert.equal(translucent[0].a, 140)
})
