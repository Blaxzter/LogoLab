// Exploded view of a stacked trace: the source, the stacked render, then every layer
// painted ALONE (bottom to top) over a checkerboard, with the tiled region it came from
// outlined — so a completion shows as fill past the outline. One PNG per case.
//
//   node bench/stackExplode.ts <stamp> [--full] case-id [case-id …]
//
// Reads the 1024 input an A/B stamp holds; writes crispness-study/stack/<case>.png.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng } from '../src/lib/png/decode.ts'
import { encodePng } from '../src/lib/png/encode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import type { EditableDoc, PathItem } from '../src/lib/path/types.ts'

ensureImageData()

const argv = process.argv.slice(2)
/** --full traces the stamp's primary (flat-cap) raster instead of its 1024 copy. */
const full = argv.includes('--full')
const [stamp, ...ids] = argv.filter((x) => x !== '--full')
const TILE = 320
const outDir = join('crispness-study', 'stack')
mkdirSync(outDir, { recursive: true })

for (const id of ids) {
  const png = decodePng(readFileSync(join('test', 'ab-snapshots', stamp, full ? `${id}.png` : `${id}.r1024.png`)))
  const img = new ImageData(new Uint8ClampedArray(png.data), png.width, png.height)
  const opts = { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'color' as const, gradients: false }
  const tiled = await traceImage(img, opts)
  const stacked = await traceImage(img, { ...opts, layering: 'stacked' })
  const layers = stacked.items.filter((it): it is PathItem => it.kind === 'path')
  const s = TILE / Math.max(png.width, png.height)
  const panels: Uint8ClampedArray[] = []
  const render = (doc: EditableDoc, bg: [number, number, number]) =>
    rasterizeDoc(doc, TILE, TILE, { background: bg, scale: s })
  panels.push(scaleNearest(png.data, png.width, png.height, TILE))
  panels.push(render(stacked, [255, 255, 255]))
  for (const layer of layers) {
    const solo = render({ ...stacked, items: [layer] }, [255, 0, 255])
    checker(solo)
    // The tiled region this layer's label came from, outlined in black.
    const base = layer.id.replace(/-d\d+$/, '')
    const t = tiled.items.find((it) => it.id === base)
    if (t && t.kind === 'path') outline(solo, render({ ...tiled, items: [{ ...t, fill: '#000000' }] }, [255, 255, 255]))
    panels.push(solo)
  }
  const cols = Math.min(panels.length, 6)
  const rows = Math.ceil(panels.length / cols)
  const W = cols * (TILE + 4)
  const H = rows * (TILE + 4)
  const out = new Uint8ClampedArray(W * H * 4).fill(60)
  panels.forEach((p, i) => {
    const ox = (i % cols) * (TILE + 4)
    const oy = Math.floor(i / cols) * (TILE + 4)
    for (let y = 0; y < TILE; y++) out.set(p.subarray(y * TILE * 4, (y + 1) * TILE * 4), ((oy + y) * W + ox) * 4)
  })
  const file = join(outDir, `${id}.png`)
  writeFileSync(file, encodePng(out, W, H))
  console.log(file, `${layers.length} layers:`, layers.map((l) => `${l.id} ${l.fill}`).join(', '))
}

/** Magenta background → a grey checkerboard, so a white layer still shows. */
function checker(px: Uint8ClampedArray): void {
  for (let i = 0; i < TILE * TILE; i++) {
    const p = i * 4
    if (px[p] === 255 && px[p + 1] === 0 && px[p + 2] === 255) {
      const c = (((i % TILE) >> 3) + ((i / TILE) >> 3)) & 1 ? 200 : 235
      px[p] = px[p + 1] = px[p + 2] = c
    }
  }
}

/** Draw the boundary of the dark region of `mask` onto `px` in red. */
function outline(px: Uint8ClampedArray, mask: Uint8ClampedArray): void {
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < TILE && y < TILE && mask[(y * TILE + x) * 4] < 128
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      if (dark(x, y) === dark(x + 1, y) && dark(x, y) === dark(x, y + 1)) continue
      const p = (y * TILE + x) * 4
      px[p] = 230
      px[p + 1] = 0
      px[p + 2] = 0
    }
}

function scaleNearest(src: Uint8Array | Uint8ClampedArray, w: number, h: number, size: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(size * size * 4).fill(255)
  const k = Math.max(w, h) / size
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const sx = Math.floor(x * k)
      const sy = Math.floor(y * k)
      if (sx >= w || sy >= h) continue
      const a = src[(sy * w + sx) * 4 + 3] / 255
      for (let c = 0; c < 3; c++) out[(y * size + x) * 4 + c] = src[(sy * w + sx) * 4 + c] * a + 255 * (1 - a)
    }
  return out
}
