// Band-pull render companion (see bandPullDiag.ts) — source | trace variants, cropped & zoomed.
//
//   node --experimental-strip-types src/devtest/bandPullRender.ts \
//        [logo.svg] [--crop x,y,w,h] [--zoom 6] [--res 512] [--out file.png] [--variants a,b]
//
// Variants: base | reseat-off | arcsnap-off | grad (the gradient trace, where the bands —
// and therefore the junctions under investigation — do not exist).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { encodePng } from './pngEncode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const arg = (k: string, d: string): string => {
  const i = argv.indexOf(k)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const FILE = argv.find((a) => a.endsWith('.svg') && !a.startsWith('--')) ?? 'affinity-designer.svg'
const RES = Number(arg('--res', '512'))
const Z = Number(arg('--zoom', '6'))
const OUT = arg('--out', join(root, 'band-pull.png'))
const [X0, Y0, CW, CH] = arg('--crop', `0,0,${RES},${RES}`).split(',').map(Number)

const VARIANTS: Record<string, Record<string, unknown>> = {
  base: {},
  'reseat-off': { planarFit: { junctionReseat: false } },
  'arcsnap-off': { planarFit: { arcSnap: false } },
  grad: { gradients: true },
}
const picked = arg('--variants', 'base').split(',')

const svg = readFileSync(join(root, 'examples', 'logos', FILE), 'utf8')
const png = new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()
const img = decodePng(png)

const crop = (rgba: Uint8ClampedArray | Uint8Array, w: number): Uint8ClampedArray => {
  const o = new Uint8ClampedArray(CW * Z * CH * Z * 4)
  for (let y = 0; y < CH * Z; y++)
    for (let x = 0; x < CW * Z; x++) {
      const sx = X0 + Math.floor(x / Z)
      const sy = Y0 + Math.floor(y / Z)
      const s = (sy * w + sx) * 4
      const d = (y * CW * Z + x) * 4
      o[d] = rgba[s]; o[d + 1] = rgba[s + 1]; o[d + 2] = rgba[s + 2]; o[d + 3] = 255
    }
  return o
}

const panels: Uint8ClampedArray[] = [crop(img.data, img.width)]
const labels = ['source']
for (const name of picked) {
  const over = VARIANTS[name]
  if (!over) throw new Error(`unknown variant ${name} (have: ${Object.keys(VARIANTS).join(', ')})`)
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, ...over,
  })
  panels.push(crop(rasterizeDoc(doc, img.width, img.height, { background: [255, 255, 255] }), img.width))
  labels.push(name)
}

const GAP = 12
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
writeFileSync(OUT, encodePng(sheet, W, H))
console.log(`wrote ${OUT}  (${labels.join(' | ')}), crop ${X0},${Y0} ${CW}×${CH} @${Z}×`)
