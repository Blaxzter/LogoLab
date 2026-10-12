// One export, two kinds of icon: the ones a platform shows on whatever is behind
// them (favicons, the PWA "any" pair) and the ones it will not take transparent
// (apple-touch: iOS draws alpha as black; the maskable pair: Android crops it to
// a shape). An agent making a PWA set reported needing THREE runs to get both
// kinds right — `background` and `paddingPct` went on every file, a transparent
// export left apple-touch transparent and filled maskable with a white nobody
// chose, and the manifest carried LogoLab's own accent colour.
//
//   node --test test/mcp-opaque-icons.test.ts

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng } from '../src/lib/png/decode.ts'
import { wrapLoneItems } from '../src/mcp/call.ts'
import { exportCollection } from '../src/mcp/export.ts'
import { pickOpaqueBackground, seeThroughAreas } from '../src/mcp/logoProbe.ts'
import { prepareVector, renderIconPixels } from '../src/mcp/render.ts'
import { ensureImageData } from '../src/mcp/runtime.ts'

ensureImageData()

/** The reported case: a rounded calendar on transparency, its window left see-through, a heart inside. */
const CALENDAR =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path fill-rule="evenodd" fill="#2f5d50" d="M10 0h80a10 10 0 0 1 10 10v80a10 10 0 0 1-10 10H10A10 10 0 0 1 0 90V10A10 10 0 0 1 10 0zM15 30h70v55H15z"/>' +
  '<circle cx="50" cy="58" r="12" fill="#c0392b"/></svg>'
const calendar = () => prepareVector(CALENDAR, 100, 100)

const BRAND = '#f3ece0'

const corner = (out: string, file: string): number[] => {
  const img = decodePng(readFileSync(join(out, 'public/icons', file)))
  return Array.from(img.data.slice(0, 4))
}

/** Rows from the top until the first non-background pixel in the centre column. */
function topInset(out: string, file: string): number {
  const img = decodePng(readFileSync(join(out, 'public/icons', file)))
  const x = img.width >> 1
  const [r, g, b] = img.data.slice(0, 3)
  for (let y = 0; y < img.height; y++) {
    const i = (y * img.width + x) * 4
    if (Math.abs(img.data[i] - r) + Math.abs(img.data[i + 1] - g) + Math.abs(img.data[i + 2] - b) > 30) return y
  }
  return img.height
}

test('one export: favicons and "any" stay transparent, the opaque icons take the opaque group', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-opaque-'))
  const report = exportCollection(calendar(), out, {
    presets: ['pwa'],
    appearance: { opaque: { background: BRAND, paddingPct: 12 } },
  })

  // At 16px the art's own rounded corner half-covers pixel (0,0); a fill would make it 255.
  assert.ok(corner(out, 'favicon-16.png')[3] < 255, 'favicon corner is not filled')
  assert.deepEqual(corner(out, 'favicon-48.png'), [0, 0, 0, 0], 'favicon corner is transparent')
  assert.deepEqual(corner(out, 'icon-512.png'), [0, 0, 0, 0], '"any" icon corner is transparent')
  assert.deepEqual(corner(out, 'apple-touch-icon.png'), [243, 236, 224, 255], 'apple-touch is filled')
  assert.deepEqual(corner(out, 'maskable-512.png'), [243, 236, 224, 255], 'maskable is filled')

  // The padding went on apple-touch (12% of 180 ≈ 22px) and not on the "any" icon.
  const apple = topInset(out, 'apple-touch-icon.png')
  assert.ok(apple >= 20 && apple <= 24, `apple-touch inset ${apple}px`)

  assert.deepEqual(report.opaqueBackground, { color: BRAND, source: 'chosen' })
})

test('with no colour named, the opaque icons are filled with a picked one, and it is reported', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-opaque-'))
  const report = exportCollection(calendar(), out, { presets: ['pwa'] })

  // A dark-green mark on transparency: white stands off it. Not the frame's own
  // green — the frame reaches every edge, but a rounded tile is the mark, not a ground.
  assert.deepEqual(report.opaqueBackground, { color: '#ffffff', source: 'contrast' })
  assert.equal(corner(out, 'apple-touch-icon.png')[3], 255, 'apple-touch is never transparent')
  assert.deepEqual(corner(out, 'maskable-512.png'), [255, 255, 255, 255])
  assert.match(readFileSync(join(out, 'logolab-icons.md'), 'utf8'), /filled #ffffff \(picked for contrast/)
})

test('a light mark on transparency gets a dark fill; a mark on its own ground keeps that ground', () => {
  const light = renderIconPixels(
    prepareVector(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#fafafa"/></svg>',
      10,
      10,
    ),
    { size: 64, background: 'transparent', shape: 'square', radiusPct: 0, paddingPct: 0, scale: 1 },
  )
  assert.equal(pickOpaqueBackground(light).color, '#000000')

  const grounded = renderIconPixels(
    prepareVector(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123456"/><circle cx="5" cy="5" r="3" fill="#fff"/></svg>',
      10,
      10,
    ),
    { size: 64, background: 'transparent', shape: 'square', radiusPct: 0, paddingPct: 0, scale: 1 },
  )
  assert.deepEqual(pickOpaqueBackground(grounded), { color: '#123456', source: 'logo' })
})

test('the manifest and <head> snippet carry the colours asked for, else the opaque fill', () => {
  const asked = mkdtempSync(join(tmpdir(), 'logolab-opaque-'))
  exportCollection(calendar(), asked, {
    presets: ['pwa'],
    web: { themeColor: '#2f5d50', backgroundColor: BRAND, startUrl: '/wirksam/' },
  })
  const m = JSON.parse(readFileSync(join(asked, 'public/manifest.webmanifest'), 'utf8'))
  assert.equal(m.theme_color, '#2f5d50')
  assert.equal(m.background_color, BRAND)
  assert.equal(m.start_url, '/wirksam/')
  assert.equal(m.scope, '/wirksam/')
  assert.match(readFileSync(join(asked, 'head-snippet.html'), 'utf8'), /name="theme-color" content="#2f5d50"/)

  const derived = mkdtempSync(join(tmpdir(), 'logolab-opaque-'))
  exportCollection(calendar(), derived, { presets: ['pwa'], appearance: { opaque: { background: BRAND } } })
  const d = JSON.parse(readFileSync(join(derived, 'public/manifest.webmanifest'), 'utf8'))
  assert.equal(d.theme_color, BRAND)
  assert.equal(d.background_color, BRAND)
  const snippet = readFileSync(join(derived, 'head-snippet.html'), 'utf8')
  assert.ok(!snippet.includes('#5b5bd6'), "LogoLab's own accent never lands in someone's head")
})

test('the Android adaptive background colour is the opaque fill', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-opaque-'))
  exportCollection(calendar(), out, { presets: ['android'], appearance: { opaque: { background: BRAND } } })
  assert.match(readFileSync(join(out, 'res/values/ic_launcher_background.xml'), 'utf8'), new RegExp(BRAND))
})

test('an enclosed see-through area is found and reported; the outside is not one', () => {
  const probe = renderIconPixels(calendar(), {
    size: 256,
    background: 'transparent',
    shape: 'square',
    radiusPct: 0,
    paddingPct: 0,
    scale: 1,
  })
  const areas = seeThroughAreas(probe)
  assert.equal(areas.length, 1, 'the window, and not the transparent corners')
  assert.ok(Math.abs(areas[0].x - 0.15) < 0.01 && Math.abs(areas[0].width - 0.7) < 0.01)

  const out = mkdtempSync(join(tmpdir(), 'logolab-opaque-'))
  const report = exportCollection(calendar(), out, { presets: ['favicon'] })
  assert.ok(report.warnings.some((w) => /see-through/.test(w)))

  // A mark with nothing enclosed says nothing.
  const disc = renderIconPixels(
    prepareVector(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>',
      10,
      10,
    ),
    { size: 64, background: 'transparent', shape: 'square', radiusPct: 0, paddingPct: 0, scale: 1 },
  )
  assert.deepEqual(seeThroughAreas(disc), [])
})

test('from the shell, a single value for an array input is a list of one', () => {
  const props = { presets: { type: 'array' }, image: { type: 'string' } }
  assert.deepEqual(wrapLoneItems({ presets: 'pwa', image: 'a.png' }, props), { presets: ['pwa'], image: 'a.png' })
  assert.deepEqual(wrapLoneItems({ presets: ['pwa', 'favicon'] }, props), { presets: ['pwa', 'favicon'] })
})
