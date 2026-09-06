// Unit tests for the icon-sheet splitter.
//
//   node --test test/sheet-detect.test.ts
//
// The detector works on plain {width,height,data}, so these build synthetic
// sheets in Node without a canvas. Each one isolates ONE thing the real sheets
// do: a plain lattice, icons made of disconnected pieces, captions under every
// icon, transparent paper.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cropTile, detectSheetIcons, gridTiles, nameStem, probeInk, upscaleImageData } from '../src/lib/sheet/index.ts'
import { planTileBase, tileSmoothing, traceScale } from '../src/lib/sheet/plan.ts'
import { DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { ImageDataLike } from '../src/lib/sheet/index.ts'

interface Paint {
  x: number
  y: number
  w: number
  h: number
  rgba?: [number, number, number, number]
}

function sheet(w: number, h: number, bg: [number, number, number, number], shapes: Paint[]): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0]
    data[i * 4 + 1] = bg[1]
    data[i * 4 + 2] = bg[2]
    data[i * 4 + 3] = bg[3]
  }
  for (const s of shapes) {
    const [r, g, b, a] = s.rgba ?? [20, 30, 40, 255]
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const o = (y * w + x) * 4
        data[o] = r
        data[o + 1] = g
        data[o + 2] = b
        data[o + 3] = a
      }
    }
  }
  return { width: w, height: h, data }
}

const WHITE: [number, number, number, number] = [255, 255, 255, 255]

test('finds a 3x3 lattice of icons and reports it as a grid', () => {
  const shapes: Paint[] = []
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      shapes.push({ x: 60 + c * 200, y: 60 + r * 200, w: 90, h: 90 })
    }
  }
  const result = detectSheetIcons(sheet(640, 640, WHITE, shapes))
  const icons = result.tiles.filter((t) => t.kind === 'icon')

  assert.equal(icons.length, 9)
  assert.ok(result.grid, 'a lattice should be reported as a grid')
  assert.equal(result.grid?.rows, 3)
  assert.equal(result.grid?.cols, 3)
  // Row-major order, so tile n is at row/col n.
  assert.deepEqual(
    icons.map((t) => `${t.row}${t.col}`),
    ['00', '01', '02', '10', '11', '12', '20', '21', '22'],
  )
  // The tight ink box is the shape itself; the crop box is padded around it.
  assert.deepEqual(icons[0].ink, { x: 60, y: 60, w: 90, h: 90 })
  assert.ok(icons[0].box.w > 90 && icons[0].box.w === icons[0].box.h, 'padded and square')
  assert.equal(result.background.r, 255)
  assert.ok(result.background.uniform)
})

test('an icon made of separate pieces stays ONE icon', () => {
  // Four disconnected bars per "icon" — the wifi-arc case. The pieces are 8px
  // apart; the icons are 120px apart.
  const shapes: Paint[] = []
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 4; k++) {
      shapes.push({ x: 40 + c * 160, y: 40 + k * 20, w: 70, h: 12 })
    }
  }
  const result = detectSheetIcons(sheet(700, 180, WHITE, shapes))
  const icons = result.tiles.filter((t) => t.kind === 'icon')
  assert.equal(icons.length, 4)
  for (const icon of icons) {
    assert.equal(icon.ink.w, 70)
    assert.ok(icon.ink.h >= 72, `all four bars in the box, got ${icon.ink.h}`)
  }
})

test('captions under the icons are set aside, not returned as icons', () => {
  const shapes: Paint[] = []
  for (let r = 0; r < 2; r++) {
    const iconTop = 40 + r * 200
    for (let c = 0; c < 4; c++) {
      shapes.push({ x: 40 + c * 160, y: iconTop, w: 100, h: 100 })
      // A caption: a run of small letter-sized blobs, well below the icon.
      for (let k = 0; k < 6; k++) {
        shapes.push({ x: 45 + c * 160 + k * 15, y: iconTop + 120, w: 9, h: 14 })
      }
    }
  }
  const result = detectSheetIcons(sheet(700, 440, WHITE, shapes))
  const icons = result.tiles.filter((t) => t.kind === 'icon')
  const labels = result.tiles.filter((t) => t.kind === 'label')

  assert.equal(icons.length, 8, 'eight icons, no captions among them')
  assert.ok(labels.length >= 8, `captions are kept but flagged (got ${labels.length})`)
  for (const icon of icons) {
    assert.ok(icon.ink.h >= 100 && icon.ink.h < 140, `icon box must not swallow its caption (h=${icon.ink.h})`)
  }

  // The padded CROP must not reach into the caption either — that text would
  // otherwise be traced into every exported icon.
  for (const icon of icons) {
    for (const label of labels) {
      const overlaps =
        icon.box.x < label.ink.x + label.ink.w &&
        icon.box.x + icon.box.w > label.ink.x &&
        icon.box.y < label.ink.y + label.ink.h &&
        icon.box.y + icon.box.h > label.ink.y
      assert.ok(!overlaps, `crop ${JSON.stringify(icon.box)} reaches into caption ${JSON.stringify(label.ink)}`)
    }
    // …and it still contains the whole icon.
    assert.ok(
      icon.box.x <= icon.ink.x &&
        icon.box.y <= icon.ink.y &&
        icon.box.x + icon.box.w >= icon.ink.x + icon.ink.w &&
        icon.box.y + icon.box.h >= icon.ink.y + icon.ink.h,
      'the crop must still hold the whole icon',
    )
  }
})

test('a short row of SMALLER icons is not mistaken for caption text', () => {
  // Real sheets put a utility strip (upload, grid, sliders) between the full-size
  // rows. Its band is short, which is also what a caption band looks like — but
  // its contents are icon-shaped, and dropping them loses a whole row of icons.
  const shapes: Paint[] = []
  for (let r = 0; r < 2; r++) {
    const top = 40 + r * 200
    for (let c = 0; c < 4; c++) {
      shapes.push({ x: 40 + c * 160, y: top, w: 100, h: 100 })
      for (let k = 0; k < 6; k++) shapes.push({ x: 45 + c * 160 + k * 15, y: top + 120, w: 9, h: 14 })
    }
  }
  // The short strip: half-height, still square-ish.
  for (let c = 0; c < 3; c++) shapes.push({ x: 60 + c * 160, y: 460, w: 50, h: 50 })

  const result = detectSheetIcons(sheet(700, 560, WHITE, shapes))
  const icons = result.tiles.filter((t) => t.kind === 'icon')
  assert.equal(icons.length, 11, 'eight full-size icons plus the three small ones')
  const small = icons.filter((t) => t.ink.h <= 60)
  assert.equal(small.length, 3)
  // …and the captions are still not icons.
  assert.ok(result.tiles.filter((t) => t.kind === 'label').length >= 8)
})

test('transparent sheets separate on alpha alone', () => {
  const shapes: Paint[] = [
    { x: 20, y: 20, w: 60, h: 60, rgba: [255, 255, 255, 255] },
    { x: 140, y: 20, w: 60, h: 60, rgba: [255, 255, 255, 255] },
  ]
  const result = detectSheetIcons(sheet(220, 100, [0, 0, 0, 0], shapes))
  assert.ok(result.background.transparent)
  assert.equal(result.tiles.filter((t) => t.kind === 'icon').length, 2)
})

test('an empty sheet reports nothing rather than throwing', () => {
  const result = detectSheetIcons(sheet(100, 100, WHITE, []))
  assert.equal(result.tiles.length, 0)
  assert.ok(result.warnings.length > 0)
})

test('a single mark on a sheet is one icon', () => {
  const result = detectSheetIcons(sheet(400, 400, WHITE, [{ x: 150, y: 150, w: 100, h: 100 }]))
  const icons = result.tiles.filter((t) => t.kind === 'icon')
  assert.equal(icons.length, 1)
  assert.deepEqual(icons[0].ink, { x: 150, y: 150, w: 100, h: 100 })
})

test('uniform sizing gives every icon the same box, tight sizing does not', () => {
  const shapes: Paint[] = [
    { x: 40, y: 60, w: 120, h: 120 },
    { x: 260, y: 100, w: 40, h: 40 },
  ]
  const img = sheet(400, 240, WHITE, shapes)

  const uniform = detectSheetIcons(img, { uniform: true }).tiles.filter((t) => t.kind === 'icon')
  assert.equal(uniform.length, 2)
  assert.equal(uniform[0].box.w, uniform[1].box.w)
  // Relative size survives: the small mark is still small INSIDE its box.
  assert.equal(uniform[1].ink.w, 40)

  const tight = detectSheetIcons(img, { uniform: false, square: false, padding: 0 }).tiles.filter(
    (t) => t.kind === 'icon',
  )
  assert.equal(tight[0].box.w, 120)
  assert.equal(tight[1].box.w, 40)
})

test('gridTiles divides the sheet evenly, with margin and gutter', () => {
  const tiles = gridTiles(300, 200, { rows: 2, cols: 3 })
  assert.equal(tiles.length, 6)
  assert.deepEqual(tiles[0].box, { x: 0, y: 0, w: 100, h: 100 })
  assert.deepEqual(tiles[5].box, { x: 200, y: 100, w: 100, h: 100 })

  const inset = gridTiles(320, 220, { rows: 2, cols: 2, margin: 10, gutter: 20 })
  assert.deepEqual(inset[0].box, { x: 10, y: 10, w: 140, h: 90 })
  assert.deepEqual(inset[3].box, { x: 170, y: 120, w: 140, h: 90 })
})

test('cropTile fills the overhang instead of clipping the box', () => {
  const img = sheet(50, 50, WHITE, [{ x: 0, y: 0, w: 50, h: 50, rgba: [10, 20, 30, 255] }])
  const out = cropTile(img, { x: -10, y: -10, w: 30, h: 30 }, { r: 1, g: 2, b: 3, a: 255 })
  assert.equal(out.width, 30)
  assert.equal(out.height, 30)
  // Top-left is outside the sheet → the fill colour.
  assert.deepEqual([out.data[0], out.data[1], out.data[2], out.data[3]], [1, 2, 3, 255])
  // (10,10) of the crop is (0,0) of the sheet → the artwork.
  const inside = (10 * 30 + 10) * 4
  assert.deepEqual([out.data[inside], out.data[inside + 1], out.data[inside + 2]], [10, 20, 30])
})

/* ------------------------------------------------------------------ ink probe */

// The colour path keeps an ink's SHADING as separate palette entries and carves
// the shapes along the line where the assignment flips (measured on a real sheet:
// a disc lost its upper-left arc). Counting the inks first is what routes such a
// tile to mono instead — so the probe has to fuse tonal variants and only tonal
// variants.

test('one shaded ink counts as ONE ink and goes mono', () => {
  // A dark shape whose two halves differ the way a lit/shadowed stroke does
  // (ΔE ≈ 7 apart, exactly the case that split the real sheet).
  const img = sheet(120, 120, WHITE, [
    { x: 20, y: 20, w: 80, h: 40, rgba: [15, 28, 19, 255] },
    { x: 20, y: 60, w: 80, h: 40, rgba: [5, 15, 6, 255] },
  ])
  const probe = probeInk(img, { r: 255, g: 255, b: 255, a: 255, coverage: 0.7, transparent: false, uniform: true })
  assert.equal(probe.inks, 1)
  assert.equal(probe.mono, true)
  assert.ok(probe.dominant && /^#[0-9a-f]{6}$/.test(probe.dominant))
})

test('two real colours stay two, and keep the colour path', () => {
  const img = sheet(120, 120, WHITE, [
    { x: 20, y: 20, w: 80, h: 40, rgba: [200, 30, 40, 255] },
    { x: 20, y: 60, w: 80, h: 40, rgba: [20, 60, 200, 255] },
  ])
  const probe = probeInk(img, { r: 255, g: 255, b: 255, a: 255, coverage: 0.7, transparent: false, uniform: true })
  assert.equal(probe.inks, 2)
  assert.equal(probe.mono, false)
})

test('light ink on dark paper does NOT go mono (it would invert)', () => {
  const img = sheet(120, 120, [10, 10, 12, 255], [{ x: 20, y: 20, w: 80, h: 80, rgba: [240, 240, 235, 255] }])
  const probe = probeInk(img, { r: 10, g: 10, b: 12, a: 255, coverage: 0.6, transparent: false, uniform: true })
  assert.equal(probe.inks, 1)
  assert.equal(probe.mono, false, 'mono thresholds dark-against-light')
})

test('an empty tile probes as no ink at all', () => {
  const probe = probeInk(sheet(60, 60, WHITE, []), {
    r: 255, g: 255, b: 255, a: 255, coverage: 1, transparent: false, uniform: true,
  })
  assert.equal(probe.inks, 0)
  assert.equal(probe.dominant, null)
  assert.equal(probe.mono, false)
})

/* ---------------------------------------------------------------- tile plan */

const WHITE_BG = { r: 255, g: 255, b: 255, a: 255, coverage: 0.7, transparent: false, uniform: true }

test('smoothing scales with the tile — a 170px crop must not get the 1024px tolerance', () => {
  // Absolute tolerance: at the full-size setting a small crop loses features a few
  // pixels wide (a ring melts shut and exports as a solid blob).
  assert.equal(tileSmoothing(50, 1024), 50)
  assert.equal(tileSmoothing(50, 2048), 50, 'never ABOVE what the user asked for')
  assert.equal(tileSmoothing(50, 170), 8)
  assert.equal(tileSmoothing(50, 512), 25)
  assert.equal(tileSmoothing(0, 170), 0, 'off stays off')
})

test('small tiles are traced enlarged, big ones as they are', () => {
  // The anti-aliasing of a 170px crop carries sub-pixel edge information the
  // tracer's pixel lattice cannot use at 1:1 (measured: ink-area drift 0.75pp at
  // 1× vs 0.13pp at 3×). Past ~512px there is nothing left to win.
  assert.equal(traceScale(170), 3)
  assert.equal(traceScale(256), 2)
  assert.equal(traceScale(512), 1)
  assert.equal(traceScale(900), 1)
  assert.equal(traceScale(40), 3, 'capped — 13× would be all interpolation')
})

test('upscaling keeps the picture, at integer scale', () => {
  const img = sheet(4, 4, WHITE, [{ x: 0, y: 0, w: 2, h: 4, rgba: [0, 0, 0, 255] }])
  const up = upscaleImageData(img, 3)
  assert.equal(up.width, 12)
  assert.equal(up.height, 12)
  // Left edge still black, right edge still white, and the seam interpolates.
  assert.equal(up.data[0], 0)
  assert.equal(up.data[(11 * 12 + 11) * 4], 255)
  assert.equal(upscaleImageData(img, 1), img, 'scale 1 is a pass-through, not a copy')
})

test('the trace scale feeds back into smoothing', () => {
  // 170px × 3 = 510px of raster, so the tolerance follows the raster the tracer
  // actually sees — the two scale corrections have to compose, not fight.
  const img = sheet(170, 170, WHITE, [{ x: 30, y: 30, w: 110, h: 110, rgba: [15, 28, 19, 255] }])
  const hi = planTileBase(img, { ...DEFAULT_VECTORIZE_OPTIONS, smoothing: 50 }, {
    colorMode: 'auto', background: WHITE_BG, hiRes: true,
  })
  assert.equal(hi.scale, 3)
  assert.equal(hi.opts.smoothing, 25)

  const native = planTileBase(img, { ...DEFAULT_VECTORIZE_OPTIONS, smoothing: 50 }, {
    colorMode: 'auto', background: WHITE_BG, hiRes: false,
  })
  assert.equal(native.scale, 1)
  assert.equal(native.opts.smoothing, 8)
})

test('a one-ink tile is planned as mono, repainted in its own ink', () => {
  const img = sheet(120, 120, WHITE, [
    { x: 20, y: 20, w: 80, h: 40, rgba: [15, 28, 19, 255] },
    { x: 20, y: 60, w: 80, h: 40, rgba: [5, 15, 6, 255] },
  ])
  const plan = planTileBase(img, { ...DEFAULT_VECTORIZE_OPTIONS, smoothing: 50 }, {
    colorMode: 'auto',
    background: WHITE_BG,
  })
  assert.equal(plan.opts.mode, 'mono')
  assert.equal(plan.color, false)
  assert.ok(plan.recolor?.startsWith('#'), 'mono traces come back black, so the ink colour rides along')
  // 120px × 3 = 360px of raster ⇒ 50 × 360/1024 ≈ 18: the smoothing follows the
  // raster the tracer will see, not the crop's own size.
  assert.equal(plan.scale, 3)
  assert.equal(plan.opts.smoothing, 18)
})

test('a two-colour tile keeps the colour path', () => {
  const img = sheet(120, 120, WHITE, [
    { x: 20, y: 20, w: 80, h: 40, rgba: [200, 30, 40, 255] },
    { x: 20, y: 60, w: 80, h: 40, rgba: [20, 60, 200, 255] },
  ])
  const plan = planTileBase(img, DEFAULT_VECTORIZE_OPTIONS, { colorMode: 'auto', background: WHITE_BG })
  assert.equal(plan.opts.mode, 'color')
  assert.equal(plan.color, true)
  assert.equal(plan.recolor, null)
})

test('a light ink on light paper gets its mono cut between the two, not the black-on-white default', () => {
  // The travel example's boarding ticket: orange (luma ≈ 174) on cream (≈ 244).
  // At the studio's default cut of 128 the ink is on the PAPER side, and the
  // tile traced to nothing.
  const CREAM_BG = { r: 251, g: 245, b: 223, a: 255, coverage: 0.8, transparent: false, uniform: true }
  const img = sheet(120, 120, [251, 245, 223, 255], [{ x: 20, y: 30, w: 80, h: 60, rgba: [245, 160, 58, 255] }])
  const plan = planTileBase(img, DEFAULT_VECTORIZE_OPTIONS, { colorMode: 'auto', background: CREAM_BG })
  assert.equal(plan.opts.mode, 'mono')
  const ink = 0.2126 * 245 + 0.7152 * 160 + 0.0722 * 58
  const paper = 0.2126 * 251 + 0.7152 * 245 + 0.0722 * 223
  assert.ok(
    plan.opts.threshold > ink && plan.opts.threshold < paper,
    `cut ${plan.opts.threshold} must sit between ink ${ink.toFixed(0)} and paper ${paper.toFixed(0)}`,
  )

  // Black on white keeps a cut near the studio default.
  const bw = planTileBase(
    sheet(120, 120, WHITE, [{ x: 20, y: 20, w: 80, h: 80, rgba: [15, 28, 19, 255] }]),
    DEFAULT_VECTORIZE_OPTIONS,
    { colorMode: 'auto', background: WHITE_BG },
  )
  assert.ok(bw.opts.threshold >= 120 && bw.opts.threshold <= 150, `black on white: ${bw.opts.threshold}`)
})

test('a light ink on dark paper is traced mono with the cut inverted, repainted light', () => {
  // The smart-home example: white glyphs on navy. On the colour path the
  // anti-aliasing band between glyph and paper survives as a dark sliver region
  // around every shape; mono has no palette to split, it just needs the cut
  // the other way up.
  const NAVY: [number, number, number, number] = [33, 39, 58, 255]
  const NAVY_BG = { r: 33, g: 39, b: 58, a: 255, coverage: 0.85, transparent: false, uniform: true }
  const img = sheet(120, 120, NAVY, [{ x: 30, y: 20, w: 60, h: 80, rgba: [255, 255, 255, 255] }])
  const plan = planTileBase(img, DEFAULT_VECTORIZE_OPTIONS, { colorMode: 'auto', background: NAVY_BG })
  assert.equal(plan.opts.mode, 'mono')
  assert.equal(plan.opts.invert, true)
  assert.equal(plan.recolor, '#ffffff')
  const paper = 0.2126 * 33 + 0.7152 * 39 + 0.0722 * 58
  assert.ok(plan.opts.threshold > paper && plan.opts.threshold < 255, `cut ${plan.opts.threshold}`)

  // Forcing mono on the same tile flips the cut too.
  assert.equal(planTileBase(img, DEFAULT_VECTORIZE_OPTIONS, { colorMode: 'mono', background: NAVY_BG }).opts.invert, true)
  // …and dark-on-light stays the right way up.
  const dark = planTileBase(
    sheet(120, 120, WHITE, [{ x: 20, y: 20, w: 80, h: 80, rgba: [15, 28, 19, 255] }]),
    DEFAULT_VECTORIZE_OPTIONS,
    { colorMode: 'auto', background: WHITE_BG },
  )
  assert.equal(dark.opts.invert, false)
})

test('forcing the mode overrules the probe', () => {
  const img = sheet(120, 120, WHITE, [{ x: 20, y: 20, w: 80, h: 80, rgba: [15, 28, 19, 255] }])
  assert.equal(planTileBase(img, DEFAULT_VECTORIZE_OPTIONS, { colorMode: 'color', background: WHITE_BG }).opts.mode, 'color')
  assert.equal(planTileBase(img, DEFAULT_VECTORIZE_OPTIONS, { colorMode: 'mono', background: WHITE_BG }).opts.mode, 'mono')
})

test('tile-name stems stay short and file-safe', () => {
  assert.equal(nameStem('Gemini_Generated_Image_50d4ai50d4ai50d4.png'), 'gemini-generated-image')
  assert.equal(nameStem(null), 'icon')
  assert.equal(nameStem('  '), 'icon')
})
