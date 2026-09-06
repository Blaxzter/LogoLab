// Captions → names on an icon sheet.
//
//   node --test test/sheet-captions.test.ts
//
// The pairing (which caption is whose) and the preprocessing (what the OCR is
// shown) are pure and run here without an engine; the OCR itself is exercised
// against the real example sheets by hand (see captions.ts for the numbers).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  captionToName,
  cleanAffix,
  detectSheetIcons,
  exportName,
  matchCaptions,
  prepareCaption,
} from '../src/lib/sheet/index.ts'
import type { ImageDataLike, SheetBackground, SheetGrid, SheetTile, TileKind } from '../src/lib/sheet/index.ts'

function tile(id: string, kind: TileKind, x: number, y: number, w: number, h: number): SheetTile {
  return { id, kind, ink: { x, y, w, h }, box: { x, y, w, h }, inkArea: w * h, row: -1, col: -1 }
}

/** 2 rows × 3 columns of 100px icons, a 20px caption 20px under each, a title across the top. */
function captionedLayout() {
  const tiles: SheetTile[] = [tile('title', 'label', 150, 10, 300, 40)]
  const captionOf = new Map<string, string>()
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 3; c++) {
      const x = 50 + c * 200
      const y = 80 + r * 220
      tiles.push(tile(`icon-${r}${c}`, 'icon', x, y, 100, 100))
      tiles.push(tile(`cap-${r}${c}`, 'label', x + 20, y + 120, 60, 20))
      captionOf.set(`icon-${r}${c}`, `cap-${r}${c}`)
    }
  }
  const grid: SheetGrid = { rows: 2, cols: 3, pitchX: 200, pitchY: 220 }
  return { tiles, grid, captionOf }
}

test('every icon gets the caption under it; the title belongs to nobody', () => {
  const { tiles, grid, captionOf } = captionedLayout()
  const matches = matchCaptions(tiles, grid)
  assert.equal(matches.size, 6)
  for (const [iconId, capId] of captionOf) {
    const m = matches.get(iconId)
    assert.ok(m, `${iconId} should have a caption`)
    assert.deepEqual(m.labels.map((l) => l.id), [capId])
  }
  const claimed = new Set([...matches.values()].flatMap((m) => m.labels.map((l) => l.id)))
  assert.ok(!claimed.has('title'), 'the title spans the row and is no icon\'s caption')
})

test('a caption between two rows goes to the icon above it, never the one below', () => {
  const { tiles, grid } = captionedLayout()
  const matches = matchCaptions(tiles, grid)
  // Row 0's captions sit 20px above row 1's icons — closer than row 1's own
  // captions are, if "distance" were the only rule.
  assert.deepEqual(matches.get('icon-10')!.labels.map((l) => l.id), ['cap-10'])
  assert.deepEqual(matches.get('icon-00')!.labels.map((l) => l.id), ['cap-00'])
})

test('pairs without a grid too', () => {
  const { tiles, captionOf } = captionedLayout()
  const matches = matchCaptions(tiles, null)
  assert.equal(matches.size, 6)
  for (const [iconId, capId] of captionOf) {
    assert.deepEqual(matches.get(iconId)!.labels.map((l) => l.id), [capId])
  }
})

test('a two-line caption is stitched back into one', () => {
  const tiles = [
    tile('icon', 'icon', 100, 100, 100, 100),
    tile('line-1', 'label', 105, 220, 90, 20),
    tile('line-2', 'label', 120, 246, 60, 20),
    // Text far below is the next row's business, not a third line.
    tile('far', 'label', 120, 400, 60, 20),
  ]
  const matches = matchCaptions(tiles, null)
  const m = matches.get('icon')
  assert.ok(m)
  assert.deepEqual(m.labels.map((l) => l.id), ['line-1', 'line-2'])
  assert.deepEqual(m.ink, { x: 105, y: 220, w: 90, h: 46 })
})

test('a section title wider than a column is not a caption, even directly under an icon', () => {
  const tiles = [
    tile('a', 'icon', 50, 80, 100, 100),
    tile('b', 'icon', 250, 80, 100, 100),
    tile('wide', 'label', 0, 200, 500, 30),
  ]
  const grid: SheetGrid = { rows: 1, cols: 2, pitchX: 200, pitchY: 0 }
  assert.equal(matchCaptions(tiles, grid).size, 0)
})

test('an icon with nothing under it gets no caption; nothing above counts', () => {
  const tiles = [tile('above', 'label', 60, 20, 80, 20), tile('icon', 'icon', 50, 80, 100, 100)]
  assert.equal(matchCaptions(tiles, null).size, 0)
})

// ---------------------------------------------------------------- detector

function sheet(w: number, h: number, bg: [number, number, number, number], boxes: { x: number; y: number; w: number; h: number }[]): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) data.set(bg, i * 4)
  for (const s of boxes) {
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        data.set([20, 30, 40, 255], (y * w + x) * 4)
      }
    }
  }
  return { width: w, height: h, data }
}

test('through the detector: every icon on a captioned sheet is paired with its own caption', () => {
  const boxes: { x: number; y: number; w: number; h: number }[] = []
  for (let r = 0; r < 2; r++) {
    const top = 40 + r * 200
    for (let c = 0; c < 4; c++) {
      boxes.push({ x: 40 + c * 160, y: top, w: 100, h: 100 })
      for (let k = 0; k < 6; k++) boxes.push({ x: 45 + c * 160 + k * 15, y: top + 120, w: 9, h: 14 })
    }
  }
  const result = detectSheetIcons(sheet(700, 440, [255, 255, 255, 255], boxes))
  const icons = result.tiles.filter((t) => t.kind === 'icon')
  const matches = matchCaptions(result.tiles, result.grid)
  assert.equal(icons.length, 8)
  assert.equal(matches.size, 8, 'each icon has a caption')
  for (const icon of icons) {
    const m = matches.get(icon.id)!
    assert.ok(m.ink.y >= icon.ink.y + icon.ink.h, 'the caption is below the icon')
    const cx = m.ink.x + m.ink.w / 2
    assert.ok(cx > icon.ink.x && cx < icon.ink.x + icon.ink.w, 'the caption is centred under its own icon')
  }
})

// ---------------------------------------------------------------- text → name

test('captionToName makes a file-name stem out of what the OCR read', () => {
  assert.equal(captionToName('Sun'), 'sun')
  assert.equal(captionToName('SECURITY CAMERA'), 'security-camera')
  assert.equal(captionToName('  Smoke\nDetector '), 'smoke-detector')
  assert.equal(captionToName('Café & Bar'), 'cafe-and-bar')
  assert.equal(captionToName('|Wi-Fi|'), 'wi-fi')
  assert.equal(captionToName('4K TV'), '4k-tv')
  assert.equal(captionToName(''), null)
  assert.equal(captionToName('| — ·'), null, 'punctuation alone is not a name')
  assert.ok(captionToName('word '.repeat(40))!.length <= 48, 'cut on a word boundary at the limit')
})

test('prefix and suffix wrap the name and cannot break the file name', () => {
  assert.equal(exportName('sun', 'ic-', '-24'), 'ic-sun-24')
  assert.equal(exportName('sun', '', ''), 'sun')
  assert.equal(cleanAffix('my icons '), 'my-icons-')
  assert.equal(cleanAffix('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij')
})

// ---------------------------------------------------------------- pixels

function paper(r: number, g: number, b: number, transparent = false): SheetBackground {
  return { r, g, b, a: transparent ? 0 : 255, coverage: 1, transparent, uniform: true }
}

/** A 60×30 sheet with one 20×14 "glyph" of colour `ink` at (20, 8). */
function glyphSheet(bg: [number, number, number, number], ink: [number, number, number, number]): ImageDataLike {
  const img = sheet(60, 30, bg, [])
  for (let y = 8; y < 22; y++) for (let x = 20; x < 40; x++) img.data.set(ink, (y * 60 + x) * 4)
  return img
}

const GLYPH = { x: 20, y: 8, w: 20, h: 14 }

function centreAndCorner(out: ImageDataLike) {
  const at = (x: number, y: number) => out.data[(y * out.width + x) * 4]
  return { centre: at(out.width >> 1, out.height >> 1), corner: at(1, 1) }
}

test('prepareCaption hands the OCR dark text on light paper, whatever the sheet looked like', () => {
  // Dark ink on white: as is.
  let out = prepareCaption(glyphSheet([255, 255, 255, 255], [20, 30, 40, 255]), GLYPH, paper(255, 255, 255))
  let px = centreAndCorner(out)
  assert.ok(px.centre < 64 && px.corner > 190, `light paper: centre ${px.centre}, corner ${px.corner}`)

  // Light ink on navy: inverted.
  out = prepareCaption(glyphSheet([30, 30, 60, 255], [240, 240, 245, 255]), GLYPH, paper(30, 30, 60))
  px = centreAndCorner(out)
  assert.ok(px.centre < 64 && px.corner > 190, `dark paper: centre ${px.centre}, corner ${px.corner}`)

  // White ink over transparency: alpha is the ink.
  out = prepareCaption(glyphSheet([0, 0, 0, 0], [255, 255, 255, 255]), GLYPH, paper(0, 0, 0, true))
  px = centreAndCorner(out)
  assert.ok(px.centre < 64 && px.corner > 190, `transparent paper: centre ${px.centre}, corner ${px.corner}`)
})

test('prepareCaption pads the crop and enlarges a small caption', () => {
  const out = prepareCaption(glyphSheet([255, 255, 255, 255], [0, 0, 0, 255]), GLYPH, paper(255, 255, 255))
  // 14px of text → ×3 to reach ~48px; 8px of air on every side first.
  assert.equal(out.width, (20 + 16) * 3)
  assert.equal(out.height, (14 + 16) * 3)
  // A caption already at the target size is left alone.
  const big = prepareCaption(sheet(200, 120, [255, 255, 255, 255], [{ x: 20, y: 20, w: 100, h: 50 }]), { x: 20, y: 20, w: 100, h: 50 }, paper(255, 255, 255))
  assert.equal(big.height, 50 + 2 * 30)
})
