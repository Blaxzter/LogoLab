// Unit tests for the pure pixel ops added to src/lib/bgRemove.ts:
//
//   node --test test/bgRemove.test.ts
//
// These cover the headless, UI-free operations that power the Cleanup view's
// guided markers and edge-refinement tools: floodRestore (seeded restore from a
// pristine source), grow/shrinkMatte (alpha dilate/erode), featherAlpha (alpha
// blur), alphaBounds + cropPad (crop & pad), compositeOver (matte flatten) and
// the keyless defringe fallback. They run over hand-built ImageData fields so
// every assertion is exact.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import {
  floodRestore,
  growMatte,
  shrinkMatte,
  featherAlpha,
  alphaBounds,
  cropPad,
  compositeOver,
  defringe,
  recolor,
} from '../src/lib/bgRemove.ts'

// The crop/composite ops construct `new ImageData(...)`, which Node lacks.
ensureImageData()

type ColorFn = (x: number, y: number) => [number, number, number, number?]

/** Build an ImageData from an (x,y) => [r,g,b,a?] function (a defaults to 255). */
function img(w: number, h: number, color: ColorFn): ImageData {
  const out = new ImageData(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = color(x, y)
      const o = (y * w + x) * 4
      out.data[o] = r
      out.data[o + 1] = g
      out.data[o + 2] = b
      out.data[o + 3] = a ?? 255
    }
  }
  return out
}

const NO_FEATHER = { tolerance: 30, softness: 0 }

/* --------------------------------------------------------------- floodRestore */

test('floodRestore brings back a connected region from the pristine source', () => {
  // Two solid red squares on a transparent working field; the source is the same
  // two squares fully opaque. Restoring from inside the left square must repaint
  // exactly that square and leave the (disconnected) right square untouched.
  const W = 24
  const H = 12
  const inLeft = (x: number, y: number) => x >= 2 && x < 8 && y >= 3 && y < 9
  const inRight = (x: number, y: number) => x >= 16 && x < 22 && y >= 3 && y < 9
  const source = img(W, H, (x, y) =>
    inLeft(x, y) || inRight(x, y) ? [200, 30, 40, 255] : [0, 0, 0, 0],
  )
  // Working: both squares present but with alpha zeroed (over-erased background).
  const working = img(W, H, (x, y) =>
    inLeft(x, y) || inRight(x, y) ? [200, 30, 40, 0] : [0, 0, 0, 0],
  )

  const affected = floodRestore(working, source, 4, 5, NO_FEATHER)
  assert.equal(affected, 36, 'restored the 6×6 left square only')

  const at = (x: number, y: number) => working.data[(y * W + x) * 4 + 3]
  assert.equal(at(4, 5), 255, 'left square is opaque again')
  assert.equal(at(18, 5), 0, 'disconnected right square stays transparent')
  // RGBA is copied straight from the source.
  const o = (5 * W + 4) * 4
  assert.deepEqual(
    [working.data[o], working.data[o + 1], working.data[o + 2], working.data[o + 3]],
    [200, 30, 40, 255],
  )
})

test('floodRestore returns 0 when the source dimensions do not match', () => {
  const working = img(10, 10, () => [0, 0, 0, 0])
  const source = img(8, 10, () => [255, 255, 255, 255])
  assert.equal(floodRestore(working, source, 5, 5, NO_FEATHER), 0)
})

test('floodRestore keys off the source so it bridges transparent working pixels', () => {
  // The distinctive behavior: the flood must follow the SOURCE region, not the
  // working image. Source is one contiguous opaque red square. Working has the
  // square's LEFT half as red and its RIGHT half cleared to transparent BLACK —
  // a barrier a working-keyed flood (red seed vs. black) would stop at. Seeding
  // in the left half must still restore the right half, proving it crossed the
  // transparent gap because the source stayed red there.
  const W = 16
  const H = 12
  const inSq = (x: number, y: number) => x >= 2 && x < 10 && y >= 3 && y < 9 // 8×6 = 48
  const leftHalf = (x: number) => x < 6
  const source = img(W, H, (x, y) => (inSq(x, y) ? [200, 30, 40, 255] : [0, 0, 0, 0]))
  const working = img(W, H, (x, y) =>
    inSq(x, y) ? (leftHalf(x) ? [200, 30, 40, 0] : [0, 0, 0, 0]) : [0, 0, 0, 0],
  )

  const affected = floodRestore(working, source, 3, 5, NO_FEATHER)
  assert.equal(affected, 48, 'restored the whole source square, bridging the cleared right half')

  const at = (x: number, y: number) => working.data[(y * W + x) * 4 + 3]
  assert.equal(at(3, 5), 255, 'seeded left half is opaque')
  assert.equal(at(8, 5), 255, 'right half (transparent black in working) was bridged via the source')
  const o = (5 * W + 8) * 4
  assert.deepEqual(
    [working.data[o], working.data[o + 1], working.data[o + 2]],
    [200, 30, 40],
    'bridged pixels take the source color, not the cleared black',
  )
})

/* ------------------------------------------------------------ grow/shrinkMatte */

test('growMatte expands a solid alpha bbox by radius on each side; RGB untouched', () => {
  const W = 20
  const H = 20
  const inSq = (x: number, y: number) => x >= 8 && x < 12 && y >= 8 && y < 12
  const m = img(W, H, (x, y) => [50, 60, 70, inSq(x, y) ? 255 : 0])
  const before = alphaBounds(m)!
  assert.deepEqual(before, { x: 8, y: 8, w: 4, h: 4 })

  const r = 2
  growMatte(m, r)
  const after = alphaBounds(m)!
  assert.deepEqual(
    after,
    { x: before.x - r, y: before.y - r, w: before.w + 2 * r, h: before.h + 2 * r },
    'bbox grew by r on every side',
  )
  // Grow only recolors the pixels it reveals; a far, still-transparent pixel is
  // left exactly as it was.
  const o = (0 * W + 0) * 4
  assert.deepEqual([m.data[o], m.data[o + 1], m.data[o + 2]], [50, 60, 70])
})

test('growMatte carries the foreground color into the pixels it reveals', () => {
  // A solid white block sitting on dark background residue (color leftover at
  // alpha 0). Growing must reveal WHITE — the adjacent foreground — not the dark
  // color physically sitting under the transparent pixels.
  const W = 12
  const H = 12
  const inBlock = (x: number, y: number) => x >= 4 && x <= 8 && y >= 4 && y <= 8
  const m = img(W, H, (x, y) =>
    inBlock(x, y) ? [255, 255, 255, 255] : [20, 20, 40, 0],
  )

  growMatte(m, 1)

  // (3,6) is one pixel left of the block: now opaque AND white, not dark.
  const grown = (6 * W + 3) * 4
  assert.equal(m.data[grown + 3], 255, 'revealed pixel is opaque')
  assert.deepEqual(
    [m.data[grown], m.data[grown + 1], m.data[grown + 2]],
    [255, 255, 255],
    'revealed pixel took the white foreground color, not the dark residue',
  )
  // (1,6) is two pixels out — beyond radius 1 — so it stays clear and dark.
  const outside = (6 * W + 1) * 4
  assert.equal(m.data[outside + 3], 0, 'pixel beyond the grow radius stays clear')
  assert.deepEqual(
    [m.data[outside], m.data[outside + 1], m.data[outside + 2]],
    [20, 20, 40],
    'untouched transparent pixel keeps its color',
  )
})

test('shrinkMatte contracts a solid alpha bbox by radius on each side', () => {
  const W = 20
  const H = 20
  const inSq = (x: number, y: number) => x >= 6 && x < 14 && y >= 6 && y < 14
  const m = img(W, H, (x, y) => [0, 0, 0, inSq(x, y) ? 255 : 0])
  const before = alphaBounds(m)!
  assert.deepEqual(before, { x: 6, y: 6, w: 8, h: 8 })

  const r = 2
  shrinkMatte(m, r)
  const after = alphaBounds(m)!
  assert.deepEqual(
    after,
    { x: before.x + r, y: before.y + r, w: before.w - 2 * r, h: before.h - 2 * r },
    'bbox shrank by r on every side',
  )
})

test('grow/shrinkMatte keep a soft alpha ramp monotonic', () => {
  // A horizontal 0..255 ramp: the dilate (max) / erode (min) must not introduce
  // any local dips or peaks — alpha stays non-decreasing left to right.
  const W = 32
  const H = 4
  const ramp = (x: number) => Math.round((255 * x) / (W - 1))
  const monotonic = (m: ImageData) => {
    for (let y = 0; y < H; y++) {
      for (let x = 1; x < W; x++) {
        const a0 = m.data[(y * W + (x - 1)) * 4 + 3]
        const a1 = m.data[(y * W + x) * 4 + 3]
        assert.ok(a1 >= a0, `alpha non-decreasing at (${x},${y}): ${a0} -> ${a1}`)
      }
    }
  }
  const grown = img(W, H, (x) => [10, 20, 30, ramp(x)])
  growMatte(grown, 3)
  monotonic(grown)
  const shrunk = img(W, H, (x) => [10, 20, 30, ramp(x)])
  shrinkMatte(shrunk, 3)
  monotonic(shrunk)
})

/* -------------------------------------------------------------- featherAlpha */

test('featherAlpha softens a hard alpha step into a transition band; RGB untouched', () => {
  // Left half opaque, right half clear: a single sharp column. Feathering must
  // introduce intermediate alpha values straddling the seam while leaving the far
  // interior (fully opaque) and far exterior (fully clear) alone.
  const W = 32
  const H = 8
  const m = img(W, H, (x) => [90, 100, 110, x < 16 ? 255 : 0])
  const r = 2
  const affected = featherAlpha(m, r)
  assert.ok(affected > 0, 'feathering changed pixels in the transition band')

  const row = 4
  const at = (x: number) => m.data[(row * W + x) * 4 + 3]
  // The band around the seam now holds intermediate values.
  let hasIntermediate = false
  for (let x = 16 - 3 * r; x <= 16 + 3 * r; x++) {
    if (at(x) > 0 && at(x) < 255) hasIntermediate = true
  }
  assert.ok(hasIntermediate, 'transition band gained intermediate alpha')
  // Far interior / exterior unchanged.
  assert.equal(at(0), 255, 'far interior still fully opaque')
  assert.equal(at(W - 1), 0, 'far exterior still fully clear')
  // RGB is never blurred.
  const o = (row * W + 20) * 4
  assert.deepEqual([m.data[o], m.data[o + 1], m.data[o + 2]], [90, 100, 110])
})

/* --------------------------------------------------------------- alphaBounds */

test('alphaBounds returns null for a fully transparent image', () => {
  assert.equal(alphaBounds(img(8, 8, () => [255, 0, 0, 0])), null)
})

test('alphaBounds returns an exact 1×1 box around a single opaque pixel', () => {
  const m = img(10, 6, (x, y) => [0, 0, 0, x === 4 && y === 2 ? 255 : 0])
  assert.deepEqual(alphaBounds(m), { x: 4, y: 2, w: 1, h: 1 })
})

test('alphaBounds honors the threshold', () => {
  // A faint pixel (alpha 5) and an opaque one. The default threshold (1) sees
  // both; a higher threshold ignores the faint pixel.
  const m = img(12, 4, (x, y) => {
    if (x === 1 && y === 1) return [0, 0, 0, 5]
    if (x === 9 && y === 2) return [0, 0, 0, 255]
    return [0, 0, 0, 0]
  })
  assert.deepEqual(alphaBounds(m, 1), { x: 1, y: 1, w: 9, h: 2 }, 'low threshold includes the faint pixel')
  assert.deepEqual(alphaBounds(m, 10), { x: 9, y: 2, w: 1, h: 1 }, 'high threshold excludes it')
})

test('alphaBounds clamps threshold to >=1 so a 0 threshold still yields null when empty', () => {
  // threshold 0 must not match fully-transparent (alpha 0) pixels — otherwise an
  // empty cutout would report the whole frame and drive a bogus full-size crop.
  assert.equal(alphaBounds(img(8, 8, () => [0, 0, 0, 0]), 0), null)
  // A real opaque pixel is still found at threshold 0.
  const m = img(8, 8, (x, y) => (x === 3 && y === 4 ? [0, 0, 0, 255] : [0, 0, 0, 0]))
  assert.deepEqual(alphaBounds(m, 0), { x: 3, y: 4, w: 1, h: 1 })
})

/* ------------------------------------------------------------------- cropPad */

test('cropPad pads dims and offsets the source by pad with a transparent border', () => {
  const W = 8
  const H = 8
  // A distinctly-colored sub-rect so we can find it after the blit.
  const inRect = (x: number, y: number) => x >= 2 && x < 5 && y >= 1 && y < 4
  const m = img(W, H, (x, y) => (inRect(x, y) ? [11, 22, 33, 255] : [0, 0, 0, 0]))
  const bounds = { x: 2, y: 1, w: 3, h: 3 }
  const pad = 2

  const out = cropPad(m, bounds, pad)
  assert.equal(out.width, bounds.w + 2 * pad)
  assert.equal(out.height, bounds.h + 2 * pad)

  const px = (im: ImageData, x: number, y: number) => {
    const o = (y * im.width + x) * 4
    return [im.data[o], im.data[o + 1], im.data[o + 2], im.data[o + 3]]
  }
  // Original sub-rect lands at +pad offset.
  assert.deepEqual(px(out, pad, pad), [11, 22, 33, 255], 'top-left of rect at (pad,pad)')
  assert.deepEqual(px(out, pad + 2, pad + 2), [11, 22, 33, 255], 'bottom-right of rect')
  // The border ring is fully transparent.
  for (let x = 0; x < out.width; x++) {
    assert.equal(px(out, x, 0)[3], 0, `top border (${x},0) clear`)
    assert.equal(px(out, x, out.height - 1)[3], 0, `bottom border (${x}) clear`)
  }
  for (let y = 0; y < out.height; y++) {
    assert.equal(px(out, 0, y)[3], 0, `left border (0,${y}) clear`)
    assert.equal(px(out, out.width - 1, y)[3], 0, `right border (${y}) clear`)
  }
})

test('cropPad with pad=0 is an exact crop', () => {
  const W = 6
  const H = 6
  const m = img(W, H, (x, y) => [x, y, 0, 255])
  const out = cropPad(m, { x: 1, y: 2, w: 3, h: 2 }, 0)
  assert.equal(out.width, 3)
  assert.equal(out.height, 2)
  // out(0,0) is source(1,2).
  const o = 0
  assert.deepEqual([out.data[o], out.data[o + 1]], [1, 2])
  // out(2,1) is source(3,3).
  const o2 = (1 * 3 + 2) * 4
  assert.deepEqual([out.data[o2], out.data[o2 + 1]], [3, 3])
})

/* --------------------------------------------------------------- compositeOver */

test('compositeOver flattens a 50% red cutout onto white ≈ (255,128,128,255)', () => {
  const m = img(2, 2, () => [255, 0, 0, 128]) // alpha 128 ≈ 50%
  const out = compositeOver(m, '#ffffff')
  const o = 0
  // 255*0.5 + 255*0.5 = 255; 0*0.5 + 255*0.5 ≈ 128.
  assert.ok(Math.abs(out.data[o] - 255) <= 1, `R ≈ 255, got ${out.data[o]}`)
  assert.ok(Math.abs(out.data[o + 1] - 128) <= 1, `G ≈ 128, got ${out.data[o + 1]}`)
  assert.ok(Math.abs(out.data[o + 2] - 128) <= 1, `B ≈ 128, got ${out.data[o + 2]}`)
  assert.equal(out.data[o + 3], 255, 'output is fully opaque')
})

test('compositeOver: a fully transparent pixel becomes the exact background color', () => {
  const m = img(1, 1, () => [123, 45, 67, 0])
  const out = compositeOver(m, '#204060')
  assert.deepEqual([...out.data], [0x20, 0x40, 0x60, 255])
})

test('compositeOver: a fully opaque pixel keeps its RGB', () => {
  const m = img(1, 1, () => [12, 200, 99, 255])
  const out = compositeOver(m, '#ffffff')
  assert.deepEqual([...out.data], [12, 200, 99, 255])
})

/* ------------------------------------------------------------------ defringe */

test('defringe bleeds the solid foreground color into the soft edge', () => {
  // Solid white block on the left (opaque), a translucent PURPLE seam at x=4
  // (the leftover halo), then cleared space. The seam sits beside the white
  // block, so its color must bleed to white while its alpha — the soft edge — is
  // preserved. Solid and clear pixels stay put.
  const W = 8
  const H = 8
  const m = img(W, H, (x) => {
    if (x < 4) return [255, 255, 255, 255] // solid white foreground
    if (x === 4) return [120, 80, 200, 128] // purple translucent fringe seam
    return [120, 80, 200, 0] // cleared: color leftover but alpha 0
  })

  defringe(m, undefined, 1) // full strength, keyless

  const seam = (3 * W + 4) * 4 // a seam pixel on row 3
  // Bled to the surrounding white; alpha (the soft edge) is untouched.
  assert.ok(m.data[seam] >= 250, `R bled toward white, got ${m.data[seam]}`)
  assert.ok(m.data[seam + 1] >= 250, `G bled toward white, got ${m.data[seam + 1]}`)
  assert.ok(m.data[seam + 2] >= 250, `B bled toward white, got ${m.data[seam + 2]}`)
  assert.equal(m.data[seam + 3], 128, 'seam alpha preserved')
  // Solid interior pixel and a fully-clear pixel are left exactly as they were.
  const solid = (3 * W + 1) * 4
  assert.deepEqual(
    [m.data[solid], m.data[solid + 1], m.data[solid + 2], m.data[solid + 3]],
    [255, 255, 255, 255],
    'solid foreground untouched',
  )
  const clear = (3 * W + 7) * 4
  assert.equal(m.data[clear + 3], 0, 'clear pixel still clear')
})

test('defringe falls back to pushing isolated specks away from the key color', () => {
  // A lone translucent pixel with no solid neighbor: nothing to bleed from, so
  // its RGB is pushed away from the key (white) instead, and alpha is untouched.
  const W = 8
  const H = 8
  const m = img(W, H, (x, y) => (x === 4 && y === 4 ? [120, 80, 200, 128] : [0, 0, 0, 0]))
  const o = (4 * W + 4) * 4

  defringe(m, { r: 255, g: 255, b: 255 }, 1)

  assert.ok(m.data[o] < 120, `R pushed away from white key, got ${m.data[o]}`)
  assert.ok(m.data[o + 1] < 80, `G pushed away from white key, got ${m.data[o + 1]}`)
  assert.ok(m.data[o + 2] < 200, `B pushed away from white key, got ${m.data[o + 2]}`)
  assert.equal(m.data[o + 3], 128, 'alpha untouched')
})

/* ------------------------------------------------------------------- recolor */

test('recolor repaints every non-transparent pixel one color, alpha untouched', () => {
  // A solid dark pixel, a semi-transparent dark pixel (a leftover rim), and a
  // fully-clear one. Recolor to white must whiten both visible pixels at their
  // existing alpha — including the opaque rim — and leave the clear pixel alone.
  const W = 3
  const H = 1
  const m = img(W, H, (x) => {
    if (x === 0) return [20, 20, 40, 255] // solid
    if (x === 1) return [20, 20, 40, 128] // semi-transparent rim
    return [20, 20, 40, 0] // fully clear
  })

  const affected = recolor(m, '#ffffff')
  assert.equal(affected, 2, 'only the two non-transparent pixels were recolored')

  const px = (x: number) => {
    const o = x * 4
    return [m.data[o], m.data[o + 1], m.data[o + 2], m.data[o + 3]]
  }
  assert.deepEqual(px(0), [255, 255, 255, 255], 'solid pixel whitened, alpha kept')
  assert.deepEqual(px(1), [255, 255, 255, 128], 'semi-transparent pixel whitened, alpha kept')
  assert.deepEqual(px(2), [20, 20, 40, 0], 'fully-clear pixel left untouched')
})
