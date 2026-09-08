// Colour-vs-mono, the mono cut, and the invert flag — the decision in
// src/lib/ink.ts that /vectorize, /sheet and the MCP server all read.
//
//   node --test test/ink-mode.test.ts
//
// The cases that matter are the ones where the naive answer is wrong: art whose
// ink is LIGHTER than its ground (the cut has to flip), art on TRANSPARENCY
// (there is no paper luminance to split against), and forced modes (a user who
// picks Mono still wants the measured cut, not the black-on-white default).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideInkMode, probeInk, type ImageDataLike, type PaperColor } from '../src/lib/ink.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { docStats } from '../src/lib/path/model.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'

// The mono path builds its mask with `new ImageData(w, h)`.
ensureImageData()

type RGBA = [number, number, number, number]

/** A `w`×`h` image on `bg` with one filled rect of `ink`. */
function art(w: number, h: number, bg: RGBA, ink: RGBA): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]
    data[i * 4 + 1] = bg[1]
    data[i * 4 + 2] = bg[2]
    data[i * 4 + 3] = bg[3]
  }
  for (let y = (h >> 2); y < h - (h >> 2); y++) {
    for (let x = (w >> 2); x < w - (w >> 2); x++) {
      const o = (y * w + x) * 4
      data[o] = ink[0]
      data[o + 1] = ink[1]
      data[o + 2] = ink[2]
      data[o + 3] = ink[3]
    }
  }
  return { width: w, height: h, data }
}

const paper = (r: number, g: number, b: number): PaperColor => ({
  r,
  g,
  b,
  a: 255,
  coverage: 0.75,
  transparent: false,
  uniform: true,
})
const TRANSPARENT: PaperColor = { r: 0, g: 0, b: 0, a: 0, coverage: 0.75, transparent: true, uniform: true }

const WHITE = paper(255, 255, 255)
const NAVY = paper(16, 24, 56)

/* --------------------------------------------------------------- the basics */

test('dark ink on light paper: auto picks mono, cut between the two, not inverted', () => {
  const img = art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'auto', background: WHITE })
  assert.equal(plan.mode, 'mono')
  assert.equal(plan.invert, false)
  assert.ok(plan.threshold > 20 && plan.threshold < 255, `cut ${plan.threshold} sits between ink and paper`)
  assert.equal(plan.recolor, '#141414')
})

test('light ink on dark paper: auto picks mono with the cut INVERTED', () => {
  const img = art(64, 64, [16, 24, 56, 255], [255, 255, 255, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'auto', background: NAVY })
  assert.equal(plan.mode, 'mono')
  assert.equal(plan.invert, true, 'the ink is the lighter of the two')
  assert.equal(plan.recolor, '#ffffff')
})

test('two inks: auto stays on the colour path', () => {
  const img = art(64, 64, [255, 255, 255, 255], [200, 30, 30, 255])
  // Paint a second, clearly different ink over part of the rect.
  for (let y = 20; y < 30; y++) {
    for (let x = 20; x < 44; x++) {
      const o = (y * 64 + x) * 4
      img.data[o] = 30
      img.data[o + 1] = 60
      img.data[o + 2] = 200
    }
  }
  const plan = decideInkMode(img, 128, { colorMode: 'auto', background: WHITE })
  assert.equal(plan.mode, 'color')
  assert.ok(plan.inks >= 2, `saw ${plan.inks} inks`)
  assert.equal(plan.recolor, null, 'colour traces are never repainted')
})

/* ------------------------------------------------------------ forced modes */

test('a forced Mono still gets the measured cut and the flip, not the 128 default', () => {
  const img = art(64, 64, [16, 24, 56, 255], [255, 255, 255, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'mono', background: NAVY })
  assert.equal(plan.mode, 'mono')
  assert.equal(plan.invert, true)
  assert.notEqual(plan.threshold, 128, 'the fallback is the thing this replaces')
})

test('a forced Color ignores a one-ink probe', () => {
  const img = art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'color', background: WHITE })
  assert.equal(plan.mode, 'color')
  assert.equal(plan.invert, false)
})

/* ------------------------------------------------ art on a transparent ground */

test('white art on transparency reads as one ink that no cut separates — auto stays colour', () => {
  const img = art(64, 64, [0, 0, 0, 0], [255, 255, 255, 255])
  const probe = probeInk(img, TRANSPARENT)
  assert.equal(probe.inks, 1)
  assert.equal(probe.mono, false)
  assert.equal(probe.monoInverted, false, 'ink and paper luma are both 255 — nothing to split')
  assert.equal(decideInkMode(img, 128, { colorMode: 'auto', background: TRANSPARENT }).mode, 'color')
})

// The #46 regression. On transparency `probeInk` reports paperLuma 255 by fiat,
// so a WHITE ink used to give a midpoint cut of exactly 255 — and whether the
// mask caught anything came down to luma(255,255,255) landing 3e-14 BELOW 255.
// Alpha already separates the art, so the cut is aimed at the far end instead.
test('white art on transparency, forced Mono: the cut clears the ink instead of landing on it', () => {
  const img = art(64, 64, [0, 0, 0, 0], [255, 255, 255, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'mono', background: TRANSPARENT })
  assert.equal(plan.mode, 'mono')
  assert.equal(plan.invert, true, 'light ink ⇒ the solid side is ABOVE the cut')
  assert.ok(plan.threshold <= 200, `cut ${plan.threshold} must sit clear of a 255 ink, not on it`)
  assert.equal(plan.recolor, '#ffffff')
})

test('dark art on transparency, forced Mono: cut aimed the other way, not inverted', () => {
  const img = art(64, 64, [0, 0, 0, 0], [20, 20, 20, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'mono', background: TRANSPARENT })
  assert.equal(plan.invert, false)
  assert.ok(plan.threshold >= 60, `cut ${plan.threshold} must sit clear of a 20 ink`)
})

/* ------------------------------------------------------------- end to end */

/** Fraction of the rendered doc that is inked, over white. */
function inkCoverage(doc: Parameters<typeof rasterizeDoc>[0], w: number, h: number): number {
  const px = rasterizeDoc(doc, w, h)
  let dark = 0
  for (let i = 0; i < px.length; i += 4) {
    if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 128) dark++
  }
  return dark / (w * h)
}

// The user-visible bug, both of the shapes it takes. The art here is a rect
// covering the middle half of the canvas, so a CORRECT mono trace inks ~25% of
// it. The studio's old settings — a constant cut of 128 and no invert control at
// all — instead give either nothing ("0 paths · 0 nodes · 70 B" on transparency,
// the blank canvas in the report) or the exact complement (the paper traced
// around a hole, on an opaque dark ground). One metric catches both.
test('the whole point: light art forced to Mono traces the ART, not nothing and not its complement', async () => {
  const SIZE = 96
  for (const [label, bg, paperColor] of [
    ['on transparency', [0, 0, 0, 0], TRANSPARENT],
    ['on navy', [16, 24, 56, 255], NAVY],
  ] as [string, RGBA, PaperColor][]) {
    const img = art(SIZE, SIZE, bg, [255, 255, 255, 255])
    const plan = decideInkMode(img, DEFAULT_VECTORIZE_OPTIONS.threshold, {
      colorMode: 'mono',
      background: paperColor,
    })
    const doc = await traceImage(img as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      mode: 'mono',
      threshold: plan.threshold,
      invert: plan.invert,
    })
    assert.ok(docStats(doc).paths > 0, `${label}: traced to nothing (cut ${plan.threshold}, invert ${plan.invert})`)
    const got = inkCoverage(doc, SIZE, SIZE)
    assert.ok(got > 0.15 && got < 0.4, `${label}: inked ${(got * 100).toFixed(1)}%, expected the ~25% rect`)

    const naive = await traceImage(img as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      mode: 'mono',
      threshold: 128,
      invert: false,
    })
    const before = inkCoverage(naive, SIZE, SIZE)
    assert.ok(
      before <= 0.15 || before >= 0.4,
      `${label}: the old default inked ${(before * 100).toFixed(1)}% — it was supposed to be the broken one`,
    )
  }
})
