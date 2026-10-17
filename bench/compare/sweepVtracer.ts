// Pick vtracer-swept on the IN-SAMPLE corpora only — VTracer's dev / held-out discipline.
//
//   node --experimental-strip-types bench/compare/sweepVtracer.ts [--res 512]
//
// Grid (frozen; printed into adapters/external.ts VTRACER_SWEPT with the pick):
//   color_precision {6,7,8} × layer_difference {8,16,32} × filter_speckle {0,2,4}
//   × hierarchical {stacked,cutout}; path_precision 2; everything else VTracer's default.
// Cases: truth0 + fluent2 (56), never svgemoji. Each config is scored through the SAME
// score.ts path as the comparison; the pick is the lowest sum of its rank on median ΔE and
// its rank on median chamfer (ties → fewer median nodes). Writes
// .bench-tools/results/vtracer-sweep/sweep.json.

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureImageData } from '../nodeHarness.ts'
import { encodePng } from '../../src/lib/png/encode.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../svgGround.ts'
import { loadCorpus } from './corpus.ts'
import { renderGround } from './render.ts'
import { scoreTrace } from './score.ts'
import { VTRACER } from './adapters/external.ts'
import { RESULTS } from './paths.ts'

ensureImageData()
const run = promisify(execFile)
const RES = Number(process.argv[process.argv.indexOf('--res') + 1] || 512) || 512
const dir = join(RESULTS, 'vtracer-sweep')
mkdirSync(join(dir, 'png'), { recursive: true })

const cases = [...loadCorpus('truth0'), ...loadCorpus('fluent2')].map((c) => {
  const svg = readFileSync(c.svgPath, 'utf8')
  const img = renderGround(svg, RES)
  const gt = parseGroundTruth(svg)
  const refusal = unscorable(gt)
  const png = join(dir, 'png', `${c.id.replace(/[^\w.-]+/g, '_')}.png`)
  writeFileSync(png, encodePng(img.data, img.width, img.height))
  return { c, png, truth: { img, shapes: refusal ? null : toRasterSpace(gt, img.width), refusal } }
})

const grid: string[][] = []
for (const p of [6, 7, 8])
  for (const g of [8, 16, 32])
    for (const f of [0, 2, 4])
      for (const hier of ['stacked', 'cutout'])
        grid.push(['-p', `${p}`, '-g', `${g}`, '-f', `${f}`, '--hierarchical', hier])

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const results: { args: string[]; dE: number; chamfer: number; nodes: number; regionsAll: number }[] = []
for (const [gi, args] of grid.entries()) {
  const out = join(dir, 'svg', `${gi}`)
  mkdirSync(out, { recursive: true })
  const svgs = await Promise.all(
    cases.map(async (k, i) => {
      const o = join(out, `${i}.svg`)
      await run(VTRACER, ['-i', k.png, '-o', o, ...args, '--path_precision', '2'])
      return readFileSync(o, 'utf8')
    }),
  )
  const dE: number[] = []
  const ch: number[] = []
  const nodes: number[] = []
  let regionsAll = 0
  for (const [i, k] of cases.entries()) {
    const { row } = scoreTrace(k.c, k.truth, 'vtracer-sweep', svgs[i], 0, 'colour', { docVisible: true })
    if (row.meanDeltaE !== undefined) dE.push(row.meanDeltaE)
    if (row.chamfer !== undefined) ch.push(row.chamfer)
    if (row.docNodes !== undefined) nodes.push(row.docNodes)
    if (row.flat && (row.regionsTrue ?? 0) > 0 && row.regionsRecovered === row.regionsTrue) regionsAll++
  }
  const r = { args, dE: median(dE), chamfer: median(ch), nodes: median(nodes), regionsAll }
  results.push(r)
  console.log(
    `${gi + 1}/${grid.length} ${args.join(' ')}  ΔE ${r.dE.toFixed(3)}  chamfer ${r.chamfer.toFixed(3)}  nodes ${r.nodes}  regions ${regionsAll}`,
  )
}

const rank = (k: 'dE' | 'chamfer'): Map<string[], number> =>
  new Map([...results].sort((a, b) => a[k] - b[k]).map((r, i) => [r.args, i]))
const rd = rank('dE')
const rc = rank('chamfer')
const scored = results
  .map((r) => ({ ...r, score: (rd.get(r.args) ?? 0) + (rc.get(r.args) ?? 0) }))
  .sort((a, b) => a.score - b.score || a.nodes - b.nodes)
writeFileSync(join(dir, 'sweep.json'), JSON.stringify({ res: RES, cases: cases.length, ranked: scored }, null, 1))
console.log('\nTop 5 (rank ΔE + rank chamfer):')
for (const r of scored.slice(0, 5))
  console.log(
    `  ${r.args.join(' ')}  ΔE ${r.dE.toFixed(3)} chamfer ${r.chamfer.toFixed(3)} nodes ${r.nodes} regions ${r.regionsAll}  score ${r.score}`,
  )
const def = results.find((r) => r.args.join(' ') === '-p 6 -g 16 -f 4 --hierarchical stacked')
if (def)
  console.log(
    `  (default: ΔE ${def.dE.toFixed(3)} chamfer ${def.chamfer.toFixed(3)} nodes ${def.nodes} regions ${def.regionsAll})`,
  )
console.log(`\nPICK: ${JSON.stringify(scored[0].args)}`)
