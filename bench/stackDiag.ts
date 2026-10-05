// Stacked vs tiled output (src/lib/trace/planarStack.ts) over the A/B corpus: does
// stacking ever make the picture worse, how many holes does it close, what does it cost?
//
// Reads the input rasters an A/B stamp already holds (the 1024 lane PNGs), so nothing
// is re-rasterized: run `pnpm gen:absnapshot <stamp>` first.
//
//   node bench/stackDiag.ts [stamp=before-stacked] [--grad]
//
// Per case: ΔE of each trace against the source (the shipped deltaEField, rendered
// over white like the studio), the same over a green backdrop the art never uses
// (a tiled seam lets it through; the gap is the seam), loops tiled → stacked, and
// the trace time each way.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodePng } from '../src/lib/png/decode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { deltaEField, deltaEStats } from '../src/lib/render/fidelity.ts'
import type { EditableDoc } from '../src/lib/path/types.ts'
import type { VectorizeOptions } from '../src/types.ts'

ensureImageData()

const args = process.argv.slice(2)
const stamp = args.find((a) => !a.startsWith('--')) ?? 'before-stacked'
const grad = args.includes('--grad')
const dir = join('test', 'ab-snapshots', stamp)
if (!existsSync(dir)) throw new Error(`no stamp at ${dir}`)

const cases = readdirSync(dir)
  .filter((f) => f.endsWith('.r1024.png'))
  .map((f) => f.slice(0, -'.r1024.png'.length))
  .filter((id) => existsSync(join(dir, `${id}.flat.svg`)))

const opts = (layering: 'tiled' | 'stacked'): VectorizeOptions => ({
  ...DEFAULT_VECTORIZE_OPTIONS,
  mode: 'color',
  gradients: grad,
  layering,
})
const loopCount = (doc: EditableDoc) =>
  doc.items.reduce((n, it) => n + (it.kind === 'path' && it.loops ? it.loops.length : 0), 0)
const err = (src: ImageData, doc: EditableDoc, bg: [number, number, number]) =>
  deltaEStats(
    deltaEField(src.data, rasterizeDoc(doc, src.width, src.height, { background: bg }), src.width, src.height).de,
  ).meanDeltaE

console.log(`stamp ${stamp}, ${grad ? 'gradients on' : 'flat'} @1024, ${cases.length} cases`)
console.log('case'.padEnd(26), 'ΔE tiled  stacked   | green tiled stacked | loops     | ms tiled stacked')
let worse = 0
let closed = 0
let tMs = 0
let sMs = 0
for (const id of cases) {
  const png = decodePng(readFileSync(join(dir, `${id}.r1024.png`)))
  const img = new ImageData(new Uint8ClampedArray(png.data), png.width, png.height)
  let t0 = performance.now()
  const tiled = await traceImage(img, opts('tiled'))
  const tm = performance.now() - t0
  t0 = performance.now()
  const stacked = await traceImage(img, opts('stacked'))
  const sm = performance.now() - t0
  tMs += tm
  sMs += sm
  const W: [number, number, number] = [255, 255, 255]
  const G: [number, number, number] = [0, 255, 0]
  const et = err(img, tiled, W)
  const es = err(img, stacked, W)
  const gt = err(img, tiled, G)
  const gs = err(img, stacked, G)
  const lt = loopCount(tiled)
  const ls = loopCount(stacked)
  closed += lt - ls
  const bad = es > et + 0.02
  if (bad) worse++
  console.log(
    `${bad ? '!' : ' '} ${id.padEnd(24)} ${et.toFixed(3).padStart(6)} ${es.toFixed(3).padStart(8)}   | ${gt
      .toFixed(2)
      .padStart(6)} ${gs.toFixed(2).padStart(7)}  | ${String(lt).padStart(4)} → ${String(ls).padEnd(4)} | ${tm
      .toFixed(0)
      .padStart(6)} ${sm.toFixed(0).padStart(7)}`,
  )
}
console.log(
  `\n${worse} case(s) worse by > 0.02 ΔE; ${closed} holes closed; trace time ${(tMs / 1000).toFixed(1)} s tiled vs ${(sMs / 1000).toFixed(1)} s stacked`,
)
