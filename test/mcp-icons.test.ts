// The MCP server's export pipeline (src/mcp) — the headless twin of the browser
// export.
//
//   node --test test/mcp-icons.test.ts
//
// What is actually at risk here is not "does it write files" but the two places
// where the headless path could silently disagree with the app:
//
//   1. GEOMETRY. Both renderers consume `iconLayout`, so a maskable icon must
//      keep its ink inside Android's safe CIRCLE and a rounded card must clear
//      its corners — measured on the rendered pixels, not on the numbers that
//      produced them (test/pwa-maskable.test.ts covers the canvas side).
//   2. CONTAINERS. A .ico and an .icns are byte layouts; a wrong offset is
//      invisible until Windows or macOS refuses the file, so they are decoded
//      back here.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng } from '../src/devtest/png.ts'
import { MASKABLE_SAFE_DIAMETER, encodeIcoBytes, iconLayout } from '../src/lib/iconSpec.ts'
import { encodeIcns } from '../src/mcp/icns.ts'
import { exportCollection } from '../src/mcp/export.ts'
import { prepareVector, renderIconPng } from '../src/mcp/render.ts'
import { ensureImageData } from '../src/mcp/runtime.ts'

ensureImageData()

/** A logo that fills its whole viewBox — the worst case for any safe zone. */
const FULL_BLEED_SQUARE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#e11d48"/></svg>'
const logo = () => prepareVector(FULL_BLEED_SQUARE, 100, 100)

const BASE = { background: 'transparent', shape: 'square' as const, radiusPct: 24, paddingPct: 0, scale: 1 }

/** Decode a rendered icon and hand back a pixel probe. */
function pixels(png: Uint8Array) {
  const img = decodePng(png)
  return {
    width: img.width,
    height: img.height,
    at(x: number, y: number) {
      const i = (y * img.width + x) * 4
      return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] }
    },
    /** Every pixel carrying the logo's own colour (the rose fill). */
    inkPixels(): { x: number; y: number }[] {
      const out: { x: number; y: number }[] = []
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4
          if (img.data[i] > 150 && img.data[i + 1] < 120 && img.data[i + 3] > 128) out.push({ x, y })
        }
      }
      return out
    },
  }
}

test('a maskable icon keeps its ink inside Android\'s safe circle', () => {
  const size = 256
  const png = renderIconPng(logo(), { ...BASE, size, maskable: true })
  const img = pixels(png)
  assert.equal(img.width, size)

  // The safe zone is a CIRCLE of 66.7% diameter, and full-bleed art reaches the
  // corners of its box — so what has to fit is the ink's distance from centre.
  const limit = (MASKABLE_SAFE_DIAMETER * size) / 2
  const centre = size / 2
  let maxR = 0
  for (const p of img.inkPixels()) {
    maxR = Math.max(maxR, Math.hypot(p.x + 0.5 - centre, p.y + 0.5 - centre))
  }
  assert.ok(maxR > 0, 'the logo was drawn at all')
  assert.ok(maxR <= limit + 1, `ink reaches ${maxR.toFixed(1)}px, safe radius is ${limit.toFixed(1)}px`)

  // Full-bleed and opaque: a transparent request becomes white, corners included.
  const corner = img.at(0, 0)
  assert.equal(corner.a, 255, 'maskable icons are opaque to the corner')
})

test('a rounded card clips its corners and paints its centre', () => {
  const size = 128
  const png = renderIconPng(logo(), { ...BASE, size, shape: 'rounded', radiusPct: 25, background: '#0f172a' })
  const img = pixels(png)
  assert.equal(img.at(1, 1).a, 0, 'the corner is outside the rounded card')
  assert.equal(img.at(size / 2, size / 2).a, 255, 'the centre is painted')
})

test('a transparent square icon is the source art, full bleed', () => {
  const png = renderIconPng(logo(), { ...BASE, size: 64 })
  const img = pixels(png)
  // paddingPct 0, scale 1, no card: the art covers the icon.
  assert.equal(img.at(0, 0).a, 255)
  assert.equal(img.at(63, 63).a, 255)
})

test('iconLayout contains a wide logo without distorting it', () => {
  const layout = iconLayout({ ...BASE, size: 100, paddingPct: 10 }, 200, 100)
  assert.ok(layout.content)
  const { width, height } = layout.content
  assert.ok(Math.abs(width / height - 2) < 1e-9, 'aspect ratio survives')
  assert.ok(width <= 80 + 1e-9, 'it fits inside the 10% inset box')
})

test('the .ico container decodes back to its images', () => {
  const members = [16, 32, 48].map((size) => ({ size, png: renderIconPng(logo(), { ...BASE, size }) }))
  const ico = encodeIcoBytes(members)
  const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength)

  assert.equal(view.getUint16(0, true), 0, 'reserved')
  assert.equal(view.getUint16(2, true), 1, 'type 1 = icon')
  assert.equal(view.getUint16(4, true), members.length)

  members.forEach((m, i) => {
    const at = 6 + 16 * i
    assert.equal(view.getUint8(at), m.size, 'declared width')
    const length = view.getUint32(at + 8, true)
    const offset = view.getUint32(at + 12, true)
    assert.equal(length, m.png.byteLength)
    // The payload really is a PNG, at the offset the directory promised.
    const sig = ico.slice(offset, offset + 4)
    assert.deepEqual([...sig], [0x89, 0x50, 0x4e, 0x47], `entry ${i} points at a PNG`)
    assert.equal(decodePng(ico.slice(offset, offset + length)).width, m.size)
  })
})

test('the .icns container is self-consistent', () => {
  const sizes = [16, 32, 128]
  const png = new Map(sizes.map((s) => [s, renderIconPng(logo(), { ...BASE, size: s })]))
  const icns = encodeIcns(png)
  const view = new DataView(icns.buffer, icns.byteOffset, icns.byteLength)

  assert.equal(String.fromCharCode(...icns.slice(0, 4)), 'icns')
  assert.equal(view.getUint32(4, false), icns.byteLength, 'the header length covers the whole file')

  // Walk the entries: each length must land exactly on the next one.
  let at = 8
  const types: string[] = []
  while (at < icns.byteLength) {
    const type = String.fromCharCode(...icns.slice(at, at + 4))
    const len = view.getUint32(at + 4, false)
    assert.ok(len > 8 && at + len <= icns.byteLength, `entry ${type} fits`)
    types.push(type)
    at += len
  }
  assert.equal(at, icns.byteLength, 'the entries tile the file exactly')
  // 16, 32 and 128 fill five slots: 32 is also 16@2x, 128 is 32@2x's neighbour.
  assert.ok(types.includes('icp4') && types.includes('ic07'), `got ${types.join(',')}`)
})

test('a pwa + tauri export writes the layout each platform expects', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-mcp-'))
  const report = exportCollection(logo(), out, {
    presets: ['pwa', 'tauri'],
    appName: 'Test App',
    svg: FULL_BLEED_SQUARE,
  })

  const expected = [
    'public/icons/favicon-16.png',
    'public/icons/apple-touch-icon.png',
    'public/icons/icon-512.png',
    'public/icons/maskable-512.png',
    'public/favicon.ico',
    'public/manifest.webmanifest',
    'head-snippet.html',
    'src-tauri/icons/128x128@2x.png',
    'src-tauri/icons/icon.ico',
    'src-tauri/icons/icon.icns',
    'src-tauri/icons/StoreLogo.png',
    'README.md',
  ]
  for (const path of expected) {
    assert.ok(existsSync(join(out, path)), `wrote ${path}`)
    assert.ok(report.files.some((f) => f.path === path), `reported ${path}`)
  }

  // The PNGs are the size their name claims.
  assert.equal(decodePng(readFileSync(join(out, 'public/icons/icon-512.png'))).width, 512)
  assert.equal(decodePng(readFileSync(join(out, 'src-tauri/icons/128x128@2x.png'))).width, 256)

  // The manifest names the app and lists both purposes.
  const manifest = JSON.parse(readFileSync(join(out, 'public/manifest.webmanifest'), 'utf8')) as {
    name: string
    icons: { purpose?: string; sizes: string }[]
  }
  assert.equal(manifest.name, 'Test App')
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'))
  assert.ok(manifest.icons.some((i) => i.purpose === 'any'))

  // Nothing was reported as replaced on a fresh directory.
  assert.ok(report.files.every((f) => !f.replaced))
})

test('an unknown preset names the ones that exist', () => {
  const out = mkdtempSync(join(tmpdir(), 'logolab-mcp-'))
  assert.throws(() => exportCollection(logo(), out, { presets: ['flatpak'] }), /Unknown preset .*pwa/s)
})
