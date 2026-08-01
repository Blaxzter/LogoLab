// Rim-cap render (§13) — the green disc's right cap: source | current | reseat-off.
//   node --experimental-strip-types src/devtest/rimCapRender.ts [out.png]
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodePng } from './png.ts'
import { encodePng } from './pngEncode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const out = process.argv[2] ?? join(root, 'twin-cap.png')
const img = decodePng(readFileSync(join(root, 'test', 'ab-snapshots', 'before-lowres', 'bg-ramp-twin.png')))

const X0 = 168, Y0 = 222, CW = 46, CH = 76, Z = 7 // crop window + zoom (right cap of the green disc)

const crop = (rgba: Uint8ClampedArray | Uint8Array, w: number): Uint8ClampedArray => {
  const o = new Uint8ClampedArray(CW * Z * CH * Z * 4)
  for (let y = 0; y < CH * Z; y++)
    for (let x = 0; x < CW * Z; x++) {
      const s = ((Y0 + Math.floor(y / Z)) * w + X0 + Math.floor(x / Z)) * 4
      const d = (y * CW * Z + x) * 4
      o[d] = rgba[s]; o[d + 1] = rgba[s + 1]; o[d + 2] = rgba[s + 2]; o[d + 3] = 255
    }
  return o
}

const panels: Uint8ClampedArray[] = [crop(img.data, img.width)]
for (const over of [{}, { planarFit: { junctionReseat: false } }]) {
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, ...over,
  })
  panels.push(crop(rasterizeDoc(doc, 512, 512, { background: [255, 255, 255] }), 512))
}

const GAP = 10
const W = panels.length * CW * Z + (panels.length - 1) * GAP
const H = CH * Z
const sheet = new Uint8ClampedArray(W * H * 4).fill(255)
panels.forEach((p, i) => {
  const ox = i * (CW * Z + GAP)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < CW * Z; x++) {
      const s = (y * CW * Z + x) * 4
      const d = (y * W + ox + x) * 4
      sheet[d] = p[s]; sheet[d + 1] = p[s + 1]; sheet[d + 2] = p[s + 2]; sheet[d + 3] = 255
    }
})
writeFileSync(out, encodePng(sheet, W, H))
console.log(`wrote ${out}  (source | baseline | reseat-off), crop ${X0},${Y0} ${CW}×${CH} @${Z}×`)
