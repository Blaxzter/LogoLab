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
import {
  cutFraction,
  decideInkMode,
  inkLumaRange,
  monoThreshold,
  probeInk,
  snapCutToGap,
  type ImageDataLike,
  type PaperColor,
} from '../src/lib/ink.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { docStats } from '../src/lib/path/model.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { ensureImageData, loadPng } from '../src/devtest/nodeHarness.ts'

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

/* ------------------------------------------- what a cut admits (#47 controls) */

// These drive the Threshold slider's struck-out spans and the Invert readout, so
// they have to agree with `thresholdToMask` exactly: a readout that disagreed at
// the boundary would be worse than none. The end-to-end check below is the real
// contract — the fraction predicts whether the trace comes back empty.

test('cutFraction mirrors the mask: below the ink nothing is selected, above it everything', () => {
  const img = art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255])
  assert.equal(cutFraction(img, 0, false), 0, 'no pixel is darker than 0')
  assert.equal(cutFraction(img, 255, false), 1, 'every pixel is lighter than the max cut')
  // The rect is the middle half of the canvas = a quarter of it.
  const mid = cutFraction(img, 128, false)
  assert.ok(mid > 0.2 && mid < 0.3, `expected ~25%, got ${(mid * 100).toFixed(1)}%`)
  // Inverted is the complement at the same cut.
  assert.ok(Math.abs(cutFraction(img, 128, true) + mid - 1) < 1e-9)
})

test('cutFraction counts only VISIBLE pixels, so transparency is not background', () => {
  const img = art(64, 64, [0, 0, 0, 0], [255, 255, 255, 255])
  // A quarter of the canvas is opaque white; the rest is transparent and uncounted.
  assert.equal(cutFraction(img, 128, true), 1, 'all VISIBLE pixels are above the cut')
  assert.equal(cutFraction(img, 128, false), 0)
})

test('inkLumaRange spans the visible pixels and ignores transparency', () => {
  const onWhite = inkLumaRange(art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255]))!
  assert.ok(onWhite.min < 25 && onWhite.max > 250, `${onWhite.min}..${onWhite.max}`)
  const onAlpha = inkLumaRange(art(64, 64, [0, 0, 0, 0], [255, 255, 255, 255]))!
  assert.ok(onAlpha.min > 250, 'only the white ink is visible')
  assert.equal(onAlpha.visible, (64 >> 1) * (64 >> 1), 'the middle-half rect')
  assert.equal(inkLumaRange(art(8, 8, [0, 0, 0, 0], [0, 0, 0, 0])), null, 'nothing visible at all')
})

// The contract the UI leans on: a 0% readout must mean the trace really is empty,
// and a non-zero one must mean it really is not. If these ever disagree the panel
// would strike out a live setting, or fail to strike out a dead one.
test('a 0% cut traces to nothing, and a non-zero one does not', async () => {
  const img = art(96, 96, [0, 0, 0, 0], [255, 255, 255, 255])
  for (const invert of [false, true]) {
    const frac = cutFraction(img, 128, invert)
    const doc = await traceImage(img as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      mode: 'mono',
      threshold: 128,
      invert,
    })
    const paths = docStats(doc).paths
    assert.equal(
      frac === 0,
      paths === 0,
      `invert=${invert}: readout says ${(frac * 100).toFixed(1)}% but the trace has ${paths} paths`,
    )
  }
})

test('the dead span is exactly the cuts that select nothing', () => {
  const img = art(64, 64, [0, 0, 0, 0], [255, 255, 255, 255])
  const range = inkLumaRange(img)!
  const deadOn = Math.ceil(range.max)
  // Inverted: at or above the lightest pixel nothing is selected; one below, something is.
  assert.equal(cutFraction(img, deadOn, true), 0, 'the first struck-out cut is really dead')
  assert.ok(cutFraction(img, deadOn - 1, true) > 0, 'the cut just outside it is really live')
})

/* --------------------------------------------- shaded colour art vs an AA edge */

// Both of these ask the SAME question — "is this one ink, or several?" — of the
// two cases the bucket histogram gets wrong in opposite directions.
//
// The buckets are 5 bits per channel, so a SHADED colour occupies dozens of them
// (a red balloon with a highlight is ~20 buckets of ~1% each) while a FLAT one
// occupies a single big one. Applying the 2% share floor to raw buckets therefore
// kept the flat colours and threw away the shaded ones: a sheet of ten colourful
// icons on white cards reported "1 ink" — the card's flat grey border, the only
// thing concentrated enough to clear the floor — and traced as grey silhouettes
// with the artwork's colour gone. Fusing first is what makes those 20 buckets one
// red again.
//
// Doing only that, though, breaks the other case: on an opaque raster every edge
// is a run of ink/paper MIXTURES that the renderer blended before the file was
// saved, and fused they are a second "ink" at 2–7% — enough to route black line
// art onto the colour path, which is exactly what the mono decision exists to
// avoid. So a mixture that lands on the paper→ink segment is not a colour.

/**
 * Fill `rect` with a linear ramp from `a` (top) to `b` (bottom), optionally bent
 * towards `side` across the width — a 2-D field, the way a highlight and a
 * shadow actually fall on a drawn shape, so the colour lands in dozens of 5-bit
 * buckets rather than one. `b` alone gives a flat fill.
 */
function shaded(
  img: ImageDataLike,
  rect: { x: number; y: number; w: number; h: number },
  a: RGBA,
  b: RGBA,
  side: RGBA = a,
): void {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    const ty = (y - rect.y) / Math.max(1, rect.h - 1)
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      const tx = (x - rect.x) / Math.max(1, rect.w - 1)
      const o = (y * img.width + x) * 4
      for (let c = 0; c < 4; c++) {
        img.data[o + c] = Math.round(a[c] + (b[c] - a[c]) * ty + (side[c] - a[c]) * tx)
      }
    }
  }
}

function blank(size: number, paper: RGBA): ImageDataLike {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = paper[0]
    data[i * 4 + 1] = paper[1]
    data[i * 4 + 2] = paper[2]
    data[i * 4 + 3] = paper[3]
  }
  return { width: size, height: size, data }
}

test('shaded colours beat one flat neutral: the icon-card sheet is COLOUR, not a grey silhouette', () => {
  // The shape of a real tile: a thin flat card border, and three smoothly shaded
  // colour blobs. Each blob holds ~4× the border's pixels — but spread so thinly
  // across the histogram that no single bucket of it clears the 2% floor.
  const PAPER: RGBA = [240, 241, 244, 255]
  const img = blank(200, PAPER)
  const border: RGBA = [181, 191, 203, 255]
  shaded(img, { x: 20, y: 20, w: 160, h: 4 }, border, border)
  shaded(img, { x: 20, y: 176, w: 160, h: 4 }, border, border)
  shaded(img, { x: 20, y: 20, w: 4, h: 160 }, border, border)
  shaded(img, { x: 176, y: 20, w: 4, h: 160 }, border, border)
  shaded(img, { x: 40, y: 40, w: 120, h: 36 }, [252, 120, 124, 255], [180, 24, 36, 255], [247, 78, 96, 255])
  shaded(img, { x: 40, y: 84, w: 120, h: 36 }, [130, 208, 246, 255], [24, 84, 150, 255], [70, 150, 220, 255])
  shaded(img, { x: 40, y: 128, w: 120, h: 36 }, [160, 220, 130, 255], [30, 110, 50, 255], [96, 176, 88, 255])

  const probe = probeInk(img, paper(240, 241, 244))
  assert.ok(probe.inks >= 3, `three shaded colours + a border should read as ≥3 inks, saw ${probe.inks}`)
  assert.equal(probe.mono, false, 'the reported bug: every colour dropped, the flat border left as "the ink"')
  assert.equal(probe.monoInverted, false)
  assert.equal(decideInkMode(img, 128, { colorMode: 'auto', background: paper(240, 241, 244) }).mode, 'color')
})

test('an anti-aliased edge is a mixture, not a second ink: black line art stays MONO', () => {
  // A black bar on white with a 6px blend into the paper on each side — the same
  // ink/paper ramp a renderer leaves around every glyph, exaggerated so it holds
  // far more than the 2% a fused ink needs to count.
  const img = blank(200, [255, 255, 255, 255])
  const INK: RGBA = [12, 14, 18, 255]
  shaded(img, { x: 0, y: 60, w: 200, h: 6 }, [255, 255, 255, 255], INK)
  shaded(img, { x: 0, y: 66, w: 200, h: 68 }, INK, INK)
  shaded(img, { x: 0, y: 134, w: 200, h: 6 }, INK, [255, 255, 255, 255])

  const probe = probeInk(img, paper(255, 255, 255))
  assert.equal(probe.inks, 1, `the ramp greys are the same ink under AA, saw ${probe.inks}`)
  assert.equal(probe.mono, true)
  assert.equal(decideInkMode(img, 128, { colorMode: 'auto', background: WHITE }).mode, 'mono')
})

test('…but a darker tone of the ink is NOT on that ramp — it is past the ink, not between', () => {
  // The `t` bound in `onRamp`. A second blue at the same hue projects onto the
  // paper→ink line, so distance alone would swallow it; it sits BEYOND the ink,
  // where no paper is mixed in, which is what marks it as a tone the art has.
  const img = blank(200, [251, 245, 224, 255])
  shaded(img, { x: 20, y: 20, w: 160, h: 70 }, [173, 209, 234, 255], [173, 209, 234, 255])
  shaded(img, { x: 20, y: 100, w: 160, h: 70 }, [82, 160, 211, 255], [82, 160, 211, 255])
  const probe = probeInk(img, paper(251, 245, 224))
  assert.equal(probe.inks, 2, `two tones of blue are two inks, saw ${probe.inks}`)
})

/* ------------------------------------------------ where a mono cut may land */

// The midpoint between the ink and the paper is only a cut when those two really
// ARE the image's two populations. On full-bleed art the paper estimate is read
// off a border ring that does not agree with itself — nebula reports paper at 21%
// coverage — so most of the image counts as "ink", the dominant ink comes back as
// the gradient rather than the white ring drawn on it, and the cut lands halfway
// between the gradient and itself. Halfway INSIDE one population: it splits the
// gradient down the middle and inks 62% of the square as a single blob, while any
// cut from 130 to 254 traces the ring and the dot in 16 nodes.
//
// So the test is not "is the cut near the right value" but "does the cut have
// pixels sitting on it", and the repair is to slide it to the nearest luminance
// the image genuinely leaves empty.

/** A `size` square whose luma ramps from `lo` to `hi`, plus `marks` painted at 255. */
function fullBleed(size: number, lo: number, hi: number, marks: (x: number, y: number) => boolean): ImageDataLike {
  const data = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const v = marks(x, y) ? 255 : Math.round(lo + ((hi - lo) * (x + y)) / (2 * (size - 1)))
      data[o] = v
      data[o + 1] = v
      data[o + 2] = v
      data[o + 3] = 255
    }
  }
  return { width: size, height: size, data }
}

test('a cut with pixels sitting on it slides off them and into the gap', () => {
  // Two populations — a ground over luma 60–110, marks at 255 — and a cut asked
  // for at 85, in the middle of the ground. Anywhere from 111 to 254 separates
  // them; 85 splits the ground itself, which is the blob.
  const img = fullBleed(128, 60, 110, (x, y) => (x - 64) ** 2 + (y - 64) ** 2 < 900)
  const got = snapCutToGap(img, 85, true)
  assert.ok(got > 110 && got < 255, `cut moved to ${got}, expected the 111–254 gap`)
  const solid = cutFraction(img, got, true)
  assert.ok(solid > 0.02 && solid < 0.3, `expected the marks alone, inked ${(solid * 100).toFixed(1)}%`)
})

// The case this came from, end to end on the real asset. nebula is a purple-to-
// magenta gradient with a white ring and dot on it: the ring is 14% of the image
// and everything else sits below luma 112, so every cut from 130 to 254 traces
// the ring and the dot in ~16 nodes. The paper estimate can't see that — the
// border ring of a full-bleed gradient doesn't agree with itself, 21% coverage —
// so the "dominant ink" came back as the gradient and the cut landed at 98,
// halfway between the gradient and itself. 62% of the square, one blob, 83 nodes.
test('nebula forced to Mono traces the ring and the dot, not the gradient it sits on', async () => {
  const src = loadPng('public/examples/nebula.png')
  const img: ImageDataLike = { width: src.width, height: src.height, data: src.data }
  const plan = decideInkMode(img, DEFAULT_VECTORIZE_OPTIONS.threshold, { colorMode: 'mono' })
  assert.equal(plan.mode, 'mono')
  assert.equal(plan.invert, true, 'the marks are the light side')
  assert.ok(plan.threshold > 112, `cut ${plan.threshold} still bisects the gradient`)
  const solid = cutFraction(img, plan.threshold, plan.invert)
  assert.ok(solid < 0.3, `inked ${(solid * 100).toFixed(1)}% — the blob is back`)

  const doc = await traceImage(img as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    mode: 'mono',
    threshold: plan.threshold,
    invert: plan.invert,
  })
  assert.ok(docStats(doc).nodes < 40, `${docStats(doc).nodes} nodes — a ring and a dot are ~16`)
})

test('a cut already in a gap is left exactly where it was', () => {
  // The property the whole repair leans on: a gap holds no pixels, so every case
  // whose cut already sits in one comes out bit-identical. Black ink on white
  // paper is the extreme of that — nothing at all between 20 and 255.
  const img = art(64, 64, [255, 255, 255, 255], [20, 20, 20, 255])
  const plan = decideInkMode(img, 128, { colorMode: 'auto', background: WHITE })
  assert.equal(snapCutToGap(img, plan.threshold, plan.invert), plan.threshold, 'the snap must decline')
  assert.equal(plan.threshold, monoThreshold(plan.probe, 128), 'so the cut is still the midpoint')
})

test('a pure ramp has no gap to move to, so the cut stays put', () => {
  // `bg-ramp`: every luminance is occupied, there is no honest place to cut, and
  // inventing one would be worse than the midpoint. The snap must decline.
  const img = fullBleed(128, 0, 255, () => false)
  const plan = decideInkMode(img, 128, { colorMode: 'mono' })
  const midpoint = monoThreshold({ inkLuma: plan.probe.inkLuma, paperLuma: plan.probe.paperLuma }, 128)
  assert.equal(plan.threshold, midpoint, 'no gap exists — the midpoint is what there is')
})

test('the empty run below the darkest pixel is not a gap to cut in', () => {
  // Arithmetic gives a "gap" from 0 to the darkest pixel on every image; a cut
  // there selects NOTHING (#47). A gap only counts when both sides hold pixels.
  const img = fullBleed(128, 90, 140, (x, y) => y > 110 && x > 110)
  const plan = decideInkMode(img, 128, { colorMode: 'mono' })
  assert.ok(
    cutFraction(img, plan.threshold, plan.invert) > 0,
    `cut ${plan.threshold} (invert ${plan.invert}) selects nothing`,
  )
})

test('snapCutToGap refuses a move that would ink almost everything', () => {
  // The guard that keeps `bg-ramp-twin` where it is: its one gap sits below the
  // bulk of the art, so moving there inks 97% — a filled square, not a shape.
  const img = fullBleed(128, 40, 80, (x, y) => y > 100)
  // A cut deep inside the ramp, with the only gap above the whole image.
  const asked = 60
  const got = snapCutToGap(img, asked, false)
  assert.ok(cutFraction(img, got, false) < 0.9, `moved to ${got}, which inks everything`)
})
