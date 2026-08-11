// §18 (issue #17) — the apex evidence veto, swept against the gates it must keep.
//
//   node --experimental-strip-types src/devtest/apexSweep.ts
//
// WHY A SWEEP. The first rule tried was "refuse a reconstruction that lands more than X px
// past the raster's own coverage", and the corpus killed it: `acute-counter`'s own eroded
// 10° spike @256 overshoots 2.57px while landing 0.50px from its authored apex, and a
// `gear-teeth` tooth @256 overshoots 3.55px — both inside the range of the lens tips the
// veto exists to refuse (6.23–10.25 @256). Overshoot alone is not separable, and a
// threshold picked to spare the controls spares the defect too.
//
// So the rule gained a second term — how much of the distance the raster's own material
// actually covers (`reach ≥ frac · moved`) — and the pair is swept here rather than
// argued. Every row is judged on BOTH sides at once:
//
//   • the DEFECT metric: `acute-counter`'s fitted apexes vs their AUTHORED tips (the lens
//     tips are computed from genEdgeCases' own formulas, so this is geometry, not a
//     blessed baseline). Lower is better.
//   • the CONTROL metric: corner recall on the watchlist cases whose recall this snap
//     BUYS — sharp-star, gear-teeth, bar-caps, cross-bars. These may not drop.
//
// A rule that improves the first while moving the second is not a fix, it is a trade.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace } from './svgGround.ts'
import { scoreGeometry } from './geomScore.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** acute-counter's authored tips, recomputed from genEdgeCases' own formulas (viewBox units). */
const UNITS: [number, number, number, number, number][] = [
  [46, 46, 48, 32, 0], [128, 46, 40, 38, 23], [210, 46, 34, 44, 47],
  [46.5, 128.5, 30, 38, 11], [128.5, 128.5, 24, 44, 67], [210.5, 128.5, 20, 56, 90],
  [210, 210, 30, 96, 31],
]
const SPIKES: [number, number][] = [[24, 200], [24, 232]]
interface Tip { x: number; y: number; lens: boolean }
const TIPS: Tip[] = []
for (const [cx, cy, R, tip, rot] of UNITS) {
  const h = 2 * R * Math.sin((tip * Math.PI) / 360)
  const a = (rot * Math.PI) / 180
  for (const sy of [-h / 2, h / 2]) TIPS.push({ x: cx - sy * Math.sin(a), y: cy + sy * Math.cos(a), lens: true })
}
for (const [x, y] of SPIKES) TIPS.push({ x, y, lens: false })

const RES = [256, 512, 1024]
/** The cases whose corner recall this snap BUYS — the veto may not cost any of it. */
const CONTROLS = ['sharp-star', 'gear-teeth', 'bar-caps', 'cross-bars', 'band-cross', 'checker']

const svgOf = (n: string): string => readFileSync(join(root, 'public', 'examples', 'edge-cases', `${n}.svg`), 'utf8')
const rasterOf = (svg: string, res: number) =>
  decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())

/** Cache the rasters — every sweep row re-traces the same pixels. */
const imgs = new Map<string, ReturnType<typeof rasterOf>>()
for (const n of ['acute-counter', ...CONTROLS]) for (const r of RES) imgs.set(`${n}@${r}`, rasterOf(svgOf(n), r))

interface Row { label: string; over: number | null; frac: number | null }
const ROWS: Row[] = [
  { label: 'veto OFF (today)', over: null, frac: null },
  { label: 'over>2.5 only', over: 2.5, frac: 1e9 },
  { label: 'over>4.0 only', over: 4.0, frac: 1e9 },
  { label: 'over>2.5 & reach<0.50·m', over: 2.5, frac: 0.5 },
  { label: 'over>2.5 & reach<0.60·m', over: 2.5, frac: 0.6 },
  { label: 'over>2.5 & reach<0.70·m', over: 2.5, frac: 0.7 },
  { label: 'over>2.0 & reach<0.60·m', over: 2.0, frac: 0.6 },
  { label: 'over>3.0 & reach<0.60·m', over: 3.0, frac: 0.6 },
  { label: 'over>3.5 & reach<0.60·m', over: 3.5, frac: 0.6 },
]

const fitFor = (r: Row): Record<string, unknown> =>
  r.over === null ? { apexEvidence: false } : { apexOvershootMax: r.over, apexReachFrac: r.frac }

/** Σ and worst distance from each authored tip to the nearest fitted CORNER node. */
async function tipError(r: Row, res: number): Promise<{ lensSum: number; lensWorst: number; spikeWorst: number }> {
  const img = imgs.get(`acute-counter@${res}`)!
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: fitFor(r),
  })
  const nodes: { x: number; y: number }[] = []
  for (const e of doc.topology?.edges ?? []) for (const n of e.nodes) if (n.kind === 'corner') nodes.push(n)
  const s = res / 256
  let lensSum = 0
  let lensWorst = 0
  let spikeWorst = 0
  for (const t of TIPS) {
    let best = Infinity
    for (const n of nodes) best = Math.min(best, Math.hypot(n.x - t.x * s, n.y - t.y * s))
    // The 24° cells are dropped whole below @1024 (a thin-feature loss, not this mechanism)
    // and would swamp the sum with ~140px; excluded by a sanity bound, and reported as
    // `lost` so the exclusion can never hide a regression that CREATES one.
    if (best > 40) continue
    if (t.lens) {
      lensSum += best
      lensWorst = Math.max(lensWorst, best)
    } else spikeWorst = Math.max(spikeWorst, best)
  }
  return { lensSum, lensWorst, spikeWorst }
}

async function cornerRecall(r: Row, name: string, res: number): Promise<string> {
  const img = imgs.get(`${name}@${res}`)!
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: fitFor(r),
  })
  const g = scoreGeometry(toRasterSpace(parseGroundTruth(svgOf(name)), img.width), doc, img.width, img.height, img)
  return `${g.cornersRecovered}/${g.gtCorners}`
}

console.log('\nDEFECT SIDE — acute-counter, distance from each AUTHORED tip to the nearest fitted corner (px)')
console.log('  (lens tips are the defect; SPIKE worst is the eroded-tip CONTROL, which must NOT grow)\n')
console.log('  rule                        ' + RES.map((r) => `${r}px lensΣ  worst  spike`.padStart(24)).join(''))
const keep: Record<string, string> = {}
for (const r of ROWS) {
  let line = `  ${r.label.padEnd(28)}`
  for (const res of RES) {
    const e = await tipError(r, res)
    line += `${e.lensSum.toFixed(1).padStart(9)}${e.lensWorst.toFixed(2).padStart(8)}${e.spikeWorst.toFixed(2).padStart(7)}`
  }
  console.log(line)
}

console.log('\nCONTROL SIDE — corner recall on the cases this snap buys recall for (must not drop)\n')
console.log('  rule                        ' + CONTROLS.map((c) => c.slice(0, 10).padStart(12)).join('') + '   @res')
for (const res of [256, 512]) {
  for (const r of ROWS) {
    let line = `  ${r.label.padEnd(28)}`
    for (const c of CONTROLS) line += (await cornerRecall(r, c, res)).padStart(12)
    console.log(line + `   ${res}`)
    keep[`${r.label}@${res}`] = line
  }
  console.log()
}
