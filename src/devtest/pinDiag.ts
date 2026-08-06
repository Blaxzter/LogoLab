// TANGENT-PIN HISTOGRAM — the evidence behind §15's guard 2, across the corpus.
//
//   node --experimental-strip-types src/devtest/pinDiag.ts                 # tier 0
//   node --experimental-strip-types src/devtest/pinDiag.ts --logos         # the gallery slice
//   node --experimental-strip-types src/devtest/pinDiag.ts --logos instagram --top 20
//   node --experimental-strip-types src/devtest/pinDiag.ts --res 256,512,1024
//
// WHY. The pin rotates an apex handle onto its fitted ARM LINE, on the argument that the
// line reads the flank's true direction while the arc fit's end tangent is free within ε
// (§15.7 guard 2). That argument holds for a STRAIGHT arm. Where the flank is genuinely
// curved, the "arm line" is a CHORD of the curve — its direction is not the boundary's
// direction at the apex — and pinning to it rotates the handle off the art (issue #11:
// the Instagram 'a' crown, 29.3° of rotation just under the 30° cap, sags ~2px and the
// counter's white tip merges with the page).
//
// So the discriminator to measure is not "how far does the pin want to rotate" (the
// shipped cap) but "does this arm have a tangent at all": `bow`, the max deviation of the
// arm's own samples from the line fitted through them. A straight arm's bow is raster
// noise; a curved arm's bow is the arc's sagitta over the window. This CLI dumps both,
// jointly, so a threshold is read off the corpus instead of guessed.
//
// Reported per case: how many pin candidates, how many the 30° cap already refuses, and
// the joint (bow × rotation) histogram. `--top N` lists the largest-rotation candidates
// with their bow, which is where a regression shows up as a named apex.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { PinDiagRecord } from '../lib/trace/planarFit.ts'
import { tierCases } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  if (!argv.includes(name)) return null
  const v = argv[argv.indexOf(name) + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const RES = (flag('--res') ?? '512')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const TOP = Number(flag('--top') ?? 0)

/** The gallery slice §15.7 measured its guards on, plus issue #11's witness. */
const WITNESSES = ['instagram', 'chupa-chups', 'coca-cola', 'cnn', 'fedex', 'ahrefs-wordmark']

interface Case {
  name: string
  svg: string
  gradients: boolean
}
const logoCases = (): Case[] => {
  const dir = join(root, 'examples', 'logos')
  let onDisk: string[]
  try {
    onDisk = readdirSync(dir).filter((f) => f.endsWith('.svg'))
  } catch {
    console.log('  (examples/logos/ is absent — `npm run fetch:logos` rehydrates it)\n')
    return []
  }
  const arg = flag('--logos')
  const wanted = arg === 'all' ? onDisk.map((f) => f.replace(/\.svg$/, '')) : arg ? arg.split(',').map((s) => s.trim()) : WITNESSES
  return wanted.filter((w) => onDisk.includes(`${w}.svg`)).map((w) => ({ name: w, svg: `examples/logos/${w}.svg`, gradients: false }))
}
const cases: Case[] = argv.includes('--logos')
  ? logoCases()
  : argv.includes('--tier2')
    ? tierCases(2).map((c) => ({ name: c.name, svg: c.svg, gradients: c.gradients }))
    : tierCases(0).map((c) => ({ name: c.name, svg: c.svg, gradients: c.gradients }))

const BOW_EDGES = [0.25, 0.5, 0.75, 1.0, 1.5, Infinity]
const ROT_EDGES = [5, 10, 15, 20, 25, 30, Infinity]
const SHIFT_EDGES = [0.25, 0.5, 1.0, 1.5, 2.0, 3.0, 5.0, Infinity]
/** What the rotation does to the handle's TIP — the term the curve feels. */
const shiftOf = (r: PinDiagRecord): number => 2 * r.handle * Math.sin((r.rotDeg * Math.PI) / 360)
const bucket = (v: number, edges: number[]): number => edges.findIndex((e) => v < e)

const q = (xs: number[], p: number): number => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN)
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : ' n/a').padStart(6)

const grand = new Map<string, number>()

for (const res of RES) {
  console.log(`\n=== ${res}px ===`)
  console.log('case                pins  applied  rot° p50/p90/max      bow p50/p90/max   shift p50/p90/max')
  for (const c of cases) {
    const svg = readFileSync(join(root, c.svg), 'utf8')
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng()
    const img = decodePng(png)
    const recs: PinDiagRecord[] = []
    await traceImage(img as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: c.gradients,
      planarFit: { pinDiag: (r) => recs.push(r) },
    })
    const rot = recs.map((r) => r.rotDeg)
    const bow = recs.map((r) => r.bow)
    const applied = recs.filter((r) => r.applied).length
    const shift = recs.filter((r) => r.applied).map(shiftOf)
    console.log(
      `${c.name.padEnd(18)}${String(recs.length).padStart(5)}${String(applied).padStart(9)}   ` +
        `${f2(q(rot, 0.5))}/${f2(q(rot, 0.9))}/${f2(Math.max(0, ...rot))}   ${f2(q(bow, 0.5))}/${f2(q(bow, 0.9))}/${f2(Math.max(0, ...bow))}` +
        `   ${f2(q(shift, 0.5))}/${f2(q(shift, 0.9))}/${f2(Math.max(0, ...shift))}`,
    )
    for (const r of recs) {
      if (!r.applied) continue
      const k = `${bucket(r.bow, BOW_EDGES)}:${bucket(r.rotDeg, ROT_EDGES)}`
      const ks = `s${bucket(shiftOf(r), SHIFT_EDGES)}`
      grand.set(ks, (grand.get(ks) ?? 0) + 1)
      grand.set(k, (grand.get(k) ?? 0) + 1)
    }
    if (TOP) {
      const top = recs
        .filter((r) => r.applied)
        .sort((a, b) => b.rotDeg - a.rotDeg)
        .slice(0, TOP)
      for (const r of top)
        console.log(
          `    apex (${r.x.toFixed(1)},${r.y.toFixed(1)}) ${r.side}  rot ${r.rotDeg.toFixed(1)}°  bow ${r.bow.toFixed(2)}px  ` +
            `chord ${r.chord.toFixed(1)}px  n=${r.n}  handle ${r.handle.toFixed(1)}px  shift ${shiftOf(r).toFixed(2)}px`,
        )
    }
  }
}

// The joint histogram — the thing a threshold is read off.
console.log('\nAPPLIED pins, bow (rows) × rotation (cols)')
const rotHdr = ROT_EDGES.map((e, i) => (e === Infinity ? `≥${ROT_EDGES[i - 1]}°` : `<${e}°`).padStart(7)).join('')
console.log('  bow \\ rot' + rotHdr)
for (let b = 0; b < BOW_EDGES.length; b++) {
  const label = BOW_EDGES[b] === Infinity ? `≥${BOW_EDGES[b - 1]}` : `<${BOW_EDGES[b]}`
  let row = `  ${label.padEnd(9)}`
  for (let r = 0; r < ROT_EDGES.length; r++) row += String(grand.get(`${b}:${r}`) ?? 0).padStart(7)
  console.log(row)
}

// The handle-TIP shift the rotation causes — the same population, in the units the curve
// feels. A tangent correction is small here by construction; a re-fit is not.
console.log('\nAPPLIED pins by handle-tip shift (px)')
for (let i = 0; i < SHIFT_EDGES.length; i++) {
  const label = SHIFT_EDGES[i] === Infinity ? `>= ${SHIFT_EDGES[i - 1]}` : `< ${SHIFT_EDGES[i]}`
  console.log(`  ${label.padEnd(9)} ${String(grand.get(`s${i}`) ?? 0).padStart(6)}`)
}
