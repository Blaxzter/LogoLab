// Live text (src/lib/text/): layout on the real HarfBuzz engine and a real
// bundled font, plus the run editing the text tool does.
//
// Shaping is checked by its EFFECT on geometry — a feature that "is set" but
// moves no outline is the failure this guards against — so the assertions
// measure widths, boxes and positions rather than glyph ids.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { GroupItem, TextData } from '../src/lib/path/types.ts'
import { faceFromBytes } from '../src/lib/text/engine.ts'
import type { FaceLookup } from '../src/lib/text/layout.ts'
import { layoutText } from '../src/lib/text/layout.ts'
import { makeTextGroup, newTextData, plainText, rangeStyle, replaceText, styleRange } from '../src/lib/text/edit.ts'
import { itemBox, transformItem, scaleAbout } from '../src/lib/editor/transform.ts'
import { ellipseShape } from '../src/lib/editor/shapes.ts'
import { serializeDoc } from '../src/lib/path/model.ts'
import { textToSvg } from '../src/lib/text/svgText.ts'

const font = (f: string) => {
  const b = readFileSync(new URL(`../public/fonts/${f}`, import.meta.url))
  return faceFromBytes(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}
const inter = font('inter.ttf')
const interItalic = font('inter-italic.ttf')
const lookup: FaceLookup = (id, italic) =>
  id === 'inter' ? (italic ? { face: interItalic, synthItalic: false } : { face: inter, synthItalic: false }) : null
const synthLookup: FaceLookup = (id, italic) => (id === 'inter' ? { face: inter, synthItalic: italic } : null)

const text = (s: string, patch: Partial<TextData> = {}): TextData => {
  const d = newTextData({ x: 0, y: 0 }, 100)
  return { ...replaceText(d, 0, 0, s), ...patch }
}
const group = (d: TextData, look = lookup): GroupItem => makeTextGroup('t', d, look)
const box = (d: TextData, look = lookup) => itemBox(group(d, look))!
const width = (d: TextData) => {
  const c = layoutText(d, lookup, String).carets
  return c[c.length - 1].top.x - c[0].top.x
}

test('a line lays out on its baseline, one compound path per fill, a caret per offset', () => {
  const d = text('Hi')
  const l = layoutText(d, lookup, (i) => `c${i}`)
  assert.equal(l.children.length, 1)
  assert.equal(l.carets.length, 3)
  assert.ok(l.carets[0].top.x < l.carets[1].top.x && l.carets[1].top.x < l.carets[2].top.x)
  const b = box(d)
  // Cap height of Inter ≈ 0.73 em, sitting on y = 0 (y down).
  assert.ok(Math.abs(b.y + b.h) < 1, `baseline at 0, bottom ${b.y + b.h}`)
  assert.ok(b.h > 65 && b.h < 80, `cap height ${b.h}`)
})

test('tracking adds its share of an em after every character but the last', () => {
  const a = width(text('ABCD'))
  const b = width(text('ABCD', { style: { ...text('').style, tracking: 100 } }))
  // 3 gaps × 0.1 em × 100 + the trailing tracking the caret runs over
  assert.ok(Math.abs(b - a - 4 * 10) < 1e-6, `${b - a}`)
})

test('kerning: turning it off moves a kerned pair apart', () => {
  const on = width(text('AV'))
  const off = width(text('AV', { kerning: false }))
  assert.ok(off > on + 1, `kern on ${on} off ${off}`)
})

test('an OpenType feature changes the outline (Inter zero = slashed zero)', () => {
  const plain = group(text('0'))
  const d = styleRange(text('0'), 0, 1, { features: { zero: 1 } })
  const slashed = group(d)
  const nodes = (g: GroupItem) => g.children.reduce((n, c) => n + (c.kind === 'path' ? c.subPaths.length : 0), 0)
  assert.notEqual(nodes(plain), nodes(slashed))
})

test('weight drives the variable wght axis: heavier is wider', () => {
  const light = width(styleRange(text('Heavy'), 0, 5, { weight: 300 }))
  const bold = width(styleRange(text('Heavy'), 0, 5, { weight: 800 }))
  assert.ok(bold > light * 1.05, `${light} → ${bold}`)
})

test('italic uses the italic face, or slants the upright when there is none', () => {
  const up = box(text('I'))
  const real = box(styleRange(text('I'), 0, 1, { italic: true }))
  const fake = box(styleRange(text('I'), 0, 1, { italic: true }), synthLookup)
  assert.ok(real.w > up.w + 5, 'the italic face leans')
  assert.ok(fake.w > up.w + 5, 'the synthetic slant leans')
})

test('per-character fills come out as separate paths', () => {
  const d = styleRange(text('Logo'), 0, 2, { fill: '#ff0000' })
  const g = group(d)
  const fills = g.children.map((c) => (c.kind === 'path' ? c.fill : '')).sort()
  assert.deepEqual(fills, ['#111827', '#ff0000'])
})

test('alignment: centred lines straddle x = 0', () => {
  const b = box(text('Centre', { align: 'center' }))
  assert.ok(Math.abs(b.x + b.w / 2) < 3, `centre ${b.x + b.w / 2}`)
})

test('lines advance by lineHeight × size', () => {
  const l = layoutText(text('A\nB'), lookup, String)
  // carets: A(0) \n(1) | B(2) end(3)
  const dy = l.carets[2].top.y - l.carets[0].top.y
  assert.ok(Math.abs(dy - 120) < 1e-6, `${dy}`)
  assert.equal(l.carets.length, 4)
})

test('the matrix places the text: scaling the group scales the glyphs with it', () => {
  const g = group(text('Ab'))
  const before = itemBox(g)!
  const scaled = transformItem(g, scaleAbout({ x: 0, y: 0 }, 2, 2)) as GroupItem
  const after = itemBox(scaled)!
  assert.ok(Math.abs(after.w - 2 * before.w) < 1e-6)
})

test('text on a path: glyphs sit along the curve', () => {
  // A circle of radius 200 about the origin; glyphs stand outside it.
  const circle = ellipseShape({ x: -200, y: -200 }, { x: 200, y: 200 })[0]
  const d = text('ROUND', { onPath: { path: circle, start: 0 } })
  const l = layoutText(d, lookup, String)
  for (const c of l.carets) {
    const r = Math.hypot(c.bottom.x, c.bottom.y)
    // The caret's bottom is the descent below the baseline, either side of r=200.
    assert.ok(r > 150 && r < 260, `caret radius ${r}`)
  }
})

/* ---------------------------------------------------------- run editing */

test('typing inherits the style of the character before the caret', () => {
  let d = styleRange(text('ab'), 1, 2, { fill: '#ff0000' })
  d = replaceText(d, 2, 2, 'c')
  assert.equal(plainText(d), 'abc')
  assert.equal(rangeStyle(d, 2, 3).fill, '#ff0000')
  assert.equal(d.runs.length, 2, 'b and c merge into one run')
})

test('replacing a selection removes it and inserts in its place', () => {
  const d = replaceText(text('hello world'), 0, 5, 'HELLO')
  assert.equal(plainText(d), 'HELLO world')
})

test('styling the whole text changes the base, not an override run', () => {
  const d = styleRange(styleRange(text('abc'), 1, 2, { fill: '#ff0000' }), 0, 3, { fill: '#00ff00' })
  assert.equal(d.style.fill, '#00ff00')
  assert.equal(d.runs.length, 1)
  assert.equal(d.runs[0].style, undefined)
})

test('a mixed range reports the property as mixed (absent)', () => {
  const d = styleRange(text('abc'), 0, 1, { weight: 700 })
  assert.equal(rangeStyle(d, 0, 3).weight, undefined)
  assert.equal(rangeStyle(d, 1, 3).weight, 400)
})

test('features merge key by key', () => {
  let d = styleRange(text('abc'), 0, 3, { features: { ss01: 1 } })
  d = styleRange(d, 0, 1, { features: { zero: 1 } })
  assert.deepEqual(rangeStyle(d, 0, 1).features, { ss01: 1, zero: 1 })
})

/* ------------------------------------------------------------ export */

test('export as outlines writes the glyph paths, no <text>', () => {
  const g = group(text('Hi'))
  const svg = serializeDoc({ viewBox: [0, 0, 100, 100], items: [g] })
  assert.ok(svg.includes('<path'))
  assert.ok(!svg.includes('<text'))
})

test('export as live text writes <text> with the family, lines and per-run styles', () => {
  const d = styleRange(text('Logo\nLab'), 5, 8, { weight: 700, fill: '#ff0000' })
  const svg = serializeDoc({ viewBox: [0, 0, 100, 100], items: [group(d), group(text('Two'))] }, 2, {
    group: textToSvg,
  })
  assert.ok(!svg.includes('<path fill'), 'no outlines')
  assert.match(svg, /<text transform="matrix\(1 0 0 1 0 0\)"/)
  assert.match(svg, /font-family="'Inter', sans-serif"/)
  assert.match(
    svg,
    /<tspan x="0" y="0">Logo<\/tspan><tspan x="0" y="120"><tspan font-weight="700" fill="#ff0000">Lab<\/tspan><\/tspan>/,
  )
  assert.equal(svg.match(/@import/g)?.length, 1, 'one @import for two texts in the same family')
})

test('live text on a path writes a textPath that references a path in <defs>', () => {
  const circle = ellipseShape({ x: -200, y: -200 }, { x: 200, y: 200 })[0]
  const svg = serializeDoc(
    { viewBox: [0, 0, 100, 100], items: [group(text('ROUND', { onPath: { path: circle, start: 0.25 } }))] },
    2,
    { group: textToSvg },
  )
  assert.match(svg, /<defs>.*<path id="tp-t" d="M/)
  assert.match(svg, /<textPath href="#tp-t" startOffset="25%">ROUND<\/textPath>/)
})
