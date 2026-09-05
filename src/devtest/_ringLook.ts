// SCRATCH — trace ring-cross + olympic-rings, write the traced SVG rendered at 512 and a 4× crop.
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SP = process.argv[2]
const jobs: [string, string, number, [number, number, number, number]][] = [
  ['ring-cross', join(root, 'public', 'examples', 'edge-cases', 'ring-cross.svg'), 512, [150, 60, 130, 130]],
  ['olympic', join(root, 'examples', 'logos', 'olympic-rings.svg'), 512, [120, 40, 130, 130]],
]
for (const [name, file, res, crop] of jobs) {
  const text = readFileSync(file, 'utf8')
  const img = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false })
  const out = serializeDoc(doc, 3)
  writeFileSync(join(SP, `${name}-trace.svg`), out)
  const [cx, cy, cw, ch] = crop
  const [vx, vy, vw, vh] = doc.viewBox
  // Crop by wrapping in an outer svg with a shifted viewBox, blown up 4×.
  const inner = out.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  const cropSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw * 4}" height="${ch * 4}" viewBox="${cx} ${cy} ${cw} ${ch}"><rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#fff"/>${inner}</svg>`
  writeFileSync(join(SP, `${name}-crop.png`), new Resvg(cropSvg, { fitTo: { mode: 'width', value: cw * 4 } }).render().asPng())
  console.log(`${name}: viewBox ${doc.viewBox.join(' ')}  items ${doc.items.length}`)
}
