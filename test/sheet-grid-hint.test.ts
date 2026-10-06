// The sheet detector's answers to a real icon-set run (src/lib/sheet/detect.ts):
//
//   node --test test/sheet-grid-hint.test.ts
//
// An agent splitting ten generated sheets hit four where an icon drawn as
// separate pieces — a dashed curve, four corner brackets, a dashboard of four
// rectangles — broke the lattice: the pieces were further apart than the icons,
// so no `gap` value could join them without joining neighbours, and the sheet
// fell to a free layout. What it then reported was wrong too: row/col carried the
// rejected lattice's numbers, caption boxes were squared to 640px around a 20px
// line (reaching above the sheet), and crop boxes slid off the sheet.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectSheetIcons } from '../src/lib/sheet/index.ts'
import type { ImageDataLike } from '../src/lib/sheet/index.ts'

interface Paint {
  x: number
  y: number
  w: number
  h: number
}

function sheet(w: number, h: number, shapes: Paint[]): ImageDataLike {
  const data = new Uint8ClampedArray(w * h * 4).fill(255)
  for (const s of shapes) {
    for (let y = s.y; y < s.y + s.h; y++) {
      for (let x = s.x; x < s.x + s.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const o = (y * w + x) * 4
        data[o] = 20
        data[o + 1] = 30
        data[o + 2] = 40
      }
    }
  }
  return { width: w, height: h, data }
}

/** Icon 0 is four 24px corner brackets 56px apart; icons 1–3 are solid, 46px from each other. */
function bracketSheet(): ImageDataLike {
  const shapes: Paint[] = []
  for (const [x, y] of [
    [30, 30],
    [110, 30],
    [30, 110],
    [110, 110],
  ]) {
    shapes.push({ x, y, w: 24, h: 24 })
  }
  for (const x of [180, 330, 480]) shapes.push({ x, y: 30, w: 104, h: 104 })
  return sheet(620, 170, shapes)
}

test('a grid hint keeps an icon whole whose pieces are further apart than its neighbours', () => {
  const auto = detectSheetIcons(bracketSheet())
  const autoIcons = auto.tiles.filter((t) => t.kind === 'icon')
  // The gap rule has to choose between joining the brackets (56px) and keeping the
  // icons apart (46px); it cannot have both.
  assert.notEqual(autoIcons.length, 4, 'the control: auto-detection does not get this sheet right')

  const hinted = detectSheetIcons(bracketSheet(), { grid: { rows: 1, cols: 4 } })
  const icons = hinted.tiles.filter((t) => t.kind === 'icon')
  assert.equal(icons.length, 4)
  assert.deepEqual(hinted.grid && { rows: hinted.grid.rows, cols: hinted.grid.cols }, { rows: 1, cols: 4 })
  assert.deepEqual(
    icons.map((t) => [t.row, t.col]),
    [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
    ],
  )
  assert.deepEqual(icons[0].ink, { x: 30, y: 30, w: 104, h: 104 }, 'the four brackets are one icon')
  assert.ok(!hinted.warnings.some((w) => /grid hint/.test(w)), hinted.warnings.join(' | '))
})

test('a hint the sheet does not fill says so', () => {
  const result = detectSheetIcons(bracketSheet(), { grid: { rows: 2, cols: 4 } })
  assert.ok(result.grid)
  assert.ok(
    result.warnings.some((w) => /grid hint does not fit/.test(w) && /no artwork/.test(w)),
    result.warnings.join(' | '),
  )
})

test('a free layout reports row and col as -1, in reading order', () => {
  // No lattice fits: two big marks with two small ones between them, closer to
  // each other than the big marks' size — one column cluster, two icons in it.
  const result = detectSheetIcons(
    sheet(760, 300, [
      { x: 40, y: 40, w: 200, h: 200 },
      { x: 300, y: 100, w: 40, h: 40 },
      { x: 380, y: 100, w: 40, h: 40 },
      { x: 500, y: 58, w: 200, h: 200 },
    ]),
  )
  assert.equal(result.grid, null)
  const icons = result.tiles.filter((t) => t.kind === 'icon')
  assert.equal(icons.length, 4)
  for (const t of icons) assert.deepEqual([t.row, t.col], [-1, -1])
  // Reading order survives: the small marks sit higher than the big ones and the
  // last mark is drawn 18px lower than the first, and the row still reads left to right.
  assert.deepEqual(
    icons.map((t) => t.ink.x),
    [40, 300, 380, 500],
  )
})

test('a caption box is the padded text line, never squared', () => {
  const shapes: Paint[] = []
  for (let c = 0; c < 3; c++) {
    shapes.push({ x: 60 + c * 200, y: 60, w: 100, h: 100 })
    shapes.push({ x: 50 + c * 200, y: 180, w: 120, h: 14 })
  }
  const result = detectSheetIcons(sheet(640, 260, shapes))
  const labels = result.tiles.filter((t) => t.kind === 'label')
  assert.equal(labels.length, 3)
  for (const l of labels) {
    assert.ok(l.box.h < 2 * l.ink.h, `a ${l.ink.h}px line gets a ${l.box.h}px box`)
    assert.ok(l.box.y >= 0 && l.box.y + l.box.h <= 260, 'the box stays on the sheet')
    assert.ok(l.box.w >= l.ink.w)
  }
  // Icons are still squared.
  for (const t of result.tiles.filter((t) => t.kind === 'icon')) assert.equal(t.box.w, t.box.h)
})

test('a uniform box around a small icon stays on the sheet when nothing is in the way', () => {
  // A 40px mark at the left edge next to a 200px one: the uniform box is ~232px,
  // and centred on the small mark it would start at x ≈ -90.
  const result = detectSheetIcons(
    sheet(700, 400, [
      { x: 5, y: 150, w: 40, h: 40 },
      { x: 400, y: 20, w: 200, h: 200 },
    ]),
  )
  const small = result.tiles.find((t) => t.kind === 'icon' && t.ink.w === 40)
  assert.ok(small)
  assert.ok(small.box.w > 200, 'uniform sizing gave it the big box')
  assert.equal(small.box.x, 0)
  assert.ok(small.box.y >= 0)
  assert.ok(small.box.x <= small.ink.x && small.box.x + small.box.w >= small.ink.x + small.ink.w)
})
