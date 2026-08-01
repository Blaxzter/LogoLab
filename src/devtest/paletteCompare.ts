// A/B the flat-art segmentation: Mumford–Shah ('smooth') vs palette-first ('palette')
// on Schild at 2048, gradients off. Reports the distinct-fill count (the AA-blend
// defect = lots of junk colours), fidelity, and writes full renders + diff + two
// colour-junction crops, into crispness-study/palette/. Run:
//   node src/devtest/paletteCompare.ts

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ensureImageData, loadPng } from './nodeHarness.ts'
import { downscale } from './traceGolden.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'
import { rasterizeDoc } from './raster.ts'
import { scoreDoc } from './scoreboard.ts'
import { encodePng } from './pngEncode.ts'
import { overWhite, cropZoom } from './crispLib.ts'

ensureImageData()

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'crispness-study', 'palette')
const DIM = 2048
const CROPS = [
  { name: 'oj-topright', x: 1330, y: 360, w: 520, h: 520 }, // orange↔teal junction
  { name: 'yt-botleft', x: 360, y: 1320, w: 520, h: 520 }, // yellow↔teal junction
]

function distinctFills(svg: string): string[] {
  return [...new Set([...svg.matchAll(/fill="(#[0-9a-fA-F]+)"/g)].map((m) => m[1].toLowerCase()))]
}

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const srcImg = loadPng('examples/test-files/Schild.png')
  const input = downscale(srcImg, DIM) // 2048 source → identity
  const src2048 = overWhite(srcImg.data, srcImg.width * srcImg.height)
  writeFileSync(join(OUT, 'source.png'), encodePng(src2048, DIM, DIM))
  for (const c of CROPS) {
    const z = cropZoom(src2048, DIM, c, 2)
    writeFileSync(join(OUT, `source.${c.name}.png`), encodePng(z.data, z.w, z.h))
  }
  const target = { width: DIM, height: DIM, data: src2048 }

  for (const [id, flatPalette] of [['smooth-MS', false], ['palette-first', true]] as const) {
    const opts = {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar' as const,
      gradients: false,
      smoothing: 50,
      flatPalette,
    }
    const doc = await traceImage(input as unknown as ImageData, opts)
    const svg = serializeDoc(doc, 3)
    const fills = distinctFills(svg)
    const render = rasterizeDoc(doc, DIM, DIM)
    const score = scoreDoc(target, doc)
    writeFileSync(join(OUT, `${id}.svg`), svg)
    writeFileSync(join(OUT, `${id}.png`), encodePng(render, DIM, DIM))
    for (const c of CROPS) {
      const z = cropZoom(render, DIM, c, 2)
      writeFileSync(join(OUT, `${id}.${c.name}.png`), encodePng(z.data, z.w, z.h))
    }
    console.log(
      `${id.padEnd(14)} fills=${String(fills.length).padStart(2)} paths=${String(doc.items.length).padStart(3)} ` +
      `ΔE=${score.meanDeltaE.toFixed(3)} ssim=${score.ssim.toFixed(4)} nodes=${score.nodes} ${(Buffer.byteLength(svg) / 1024).toFixed(1)}kB`,
    )
    console.log(`  fills: ${fills.sort().join(' ')}`)
  }
  console.log(`\nArtifacts in ${OUT}`)
}

await main()
