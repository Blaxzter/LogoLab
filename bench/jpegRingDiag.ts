// JPEG ringing census: the truth corpus's flat cases, round-tripped through a real JPEG
// encoder, traced with and without a planar-fit variant, scored against the AUTHORED
// geometry. The PNG corpus has no compression artefacts, so the truth gate cannot see a
// change that only acts on ringing (planarSubpixel's palette anchors); this can.
//
//   node --experimental-strip-types bench/jpegRingDiag.ts [--q 75] [--res 512]
//        [--variant '{"subpixelPaletteAnchors":false}'] [--png]
//
// --png skips the JPEG round trip (the control: a variant must not move clean art).
// Needs cjpeg/djpeg (libjpeg-turbo) on PATH.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from './nodeHarness.ts'
import { decodePng } from '../src/lib/png/decode.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry } from './geomScore.ts'
import { GATED_CORPUS, TRUTH_CORPUS } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k)
  return i >= 0 ? process.argv[i + 1] : d
}
const Q = arg('--q', '75')
const RES = Number(arg('--res', '512'))
const VARIANT = JSON.parse(arg('--variant', '{}'))
/** Palette-segment override for the variant (e.g. '{"dissolve":"grow"}'). */
const SEG = JSON.parse(arg('--seg', '{}'))
const PNG = process.argv.includes('--png')
const ALL = process.argv.includes('--all')

/** RGBA → binary PPM (white matte; the corpus renders opaque on white anyway). */
function toPpm(img: { width: number; height: number; data: Uint8ClampedArray }): Buffer {
  const head = Buffer.from(`P6\n${img.width} ${img.height}\n255\n`)
  const body = Buffer.alloc(img.width * img.height * 3)
  for (let i = 0, j = 0; i < img.data.length; i += 4, j += 3) {
    body[j] = img.data[i]
    body[j + 1] = img.data[i + 1]
    body[j + 2] = img.data[i + 2]
  }
  return Buffer.concat([head, body])
}

/** Binary PPM → RGBA. */
function fromPpm(buf: Buffer): { width: number; height: number; data: Uint8ClampedArray } {
  let pos = 0
  const tok = (): string => {
    while (/\s/.test(String.fromCharCode(buf[pos]))) pos++
    let s = ''
    while (!/\s/.test(String.fromCharCode(buf[pos]))) s += String.fromCharCode(buf[pos++])
    return s
  }
  if (tok() !== 'P6') throw new Error('not P6')
  const width = Number(tok())
  const height = Number(tok())
  tok()
  pos++
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, j = pos; i < data.length; i += 4, j += 3) {
    data[i] = buf[j]
    data[i + 1] = buf[j + 1]
    data[i + 2] = buf[j + 2]
    data[i + 3] = 255
  }
  return { width, height, data }
}

const jpegRoundTrip = (img: { width: number; height: number; data: Uint8ClampedArray }) =>
  fromPpm(execFileSync('djpeg', ['-pnm'], { input: execFileSync('cjpeg', ['-quality', Q], { input: toPpm(img) }) }))

const cases = (ALL ? TRUTH_CORPUS : GATED_CORPUS).filter((c) => !c.gradients)
console.log(
  `${PNG ? 'PNG (control)' : `JPEG q${Q}`} @${RES} · variant ${JSON.stringify({ planarFit: VARIANT, paletteSegment: SEG })} vs production`,
)
console.log('case'.padEnd(22), 'chamfer prod → var'.padEnd(22), 'p95 prod → var'.padEnd(20), 'nodes prod → var')
let sumA = 0,
  sumB = 0,
  n = 0
for (const c of cases) {
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const gt = parseGroundTruth(svg)
  if (unscorable(gt)) continue
  const clean = decodePng(
    new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng(),
  )
  const img = PNG ? clean : jpegRoundTrip(clean)
  const gtr = toRasterSpace(gt, img.width)
  const score = async (variant: boolean) => {
    const doc = await traceImage(img as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      gradients: false,
      ...(variant ? { planarFit: VARIANT, paletteSegment: SEG } : {}),
    })
    const g = scoreGeometry(gtr, doc, img.width, img.height, img)
    const nodes = doc.items.reduce(
      (t, it) => t + (it.kind === 'path' ? it.subPaths.reduce((u, s) => u + s.nodes.length, 0) : 0),
      0,
    )
    return { chamfer: g.chamfer, p95: g.p95, nodes }
  }
  const a = await score(false)
  const b = await score(true)
  sumA += a.chamfer
  sumB += b.chamfer
  n++
  const mark = Math.abs(b.chamfer - a.chamfer) < 0.005 ? ' ' : b.chamfer > a.chamfer ? '▲' : '▼'
  console.log(
    `${mark} ${c.name.padEnd(20)}`,
    `${a.chamfer.toFixed(3)} → ${b.chamfer.toFixed(3)}`.padEnd(22),
    `${a.p95.toFixed(2)} → ${b.p95.toFixed(2)}`.padEnd(20),
    `${a.nodes} → ${b.nodes}`,
  )
}
console.log(`mean chamfer over ${n}: production ${(sumA / n).toFixed(4)} · variant ${(sumB / n).toFixed(4)}`)
console.log('▲ = production (first column) is better by ≥0.005px; ▼ = the variant is')
