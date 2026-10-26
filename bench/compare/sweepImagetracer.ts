// Pick imagetracer-swept on the IN-SAMPLE corpora only, as sweepVtracer.ts picks vtracer-swept.
//
//   node --experimental-strip-types bench/compare/sweepImagetracer.ts [--res 512]
//
// Grid (frozen; the pick is copied into adapters/imagetracer.ts IMAGETRACER_SWEPT):
//   numberofcolors {8, 16, 32, 64} × ltres = qtres {0.5, 1, 2} × pathomit {0, 8}, always
//   strokewidth 0 (the stroked default cannot be scored on geometry); everything else the
//   library's 'default' preset. Cases: truth0 + fluent2, never svgemoji. Same scorer and the
//   same rule as the other sweeps: lowest sum of the rank on median ΔE and the rank on median
//   chamfer, ties to fewer median nodes. Writes .bench-tools/results/imagetracer-sweep/sweep.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureImageData } from '../nodeHarness.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../svgGround.ts'
import { loadCorpus } from './corpus.ts'
import { renderGround } from './render.ts'
import { scoreTrace } from './score.ts'
import { imagetracer } from './adapters/imagetracer.ts'
import { RESULTS } from './paths.ts'
import { provenance } from './adapters/logolab.ts'

ensureImageData()
const RES = Number(process.argv[process.argv.indexOf('--res') + 1] || 512) || 512
const dir = join(RESULTS, 'imagetracer-sweep')
mkdirSync(dir, { recursive: true })

const cases = [...loadCorpus('truth0'), ...loadCorpus('fluent2')].map((c) => {
  const svg = readFileSync(c.svgPath, 'utf8')
  const img = renderGround(svg, RES)
  const gt = parseGroundTruth(svg)
  const refusal = unscorable(gt)
  return { c, img, truth: { img, shapes: refusal ? null : toRasterSpace(gt, img.width), refusal } }
})

const grid: Record<string, number>[] = []
for (const numberofcolors of [8, 16, 32, 64])
  for (const t of [0.5, 1, 2])
    for (const pathomit of [0, 8]) grid.push({ strokewidth: 0, numberofcolors, ltres: t, qtres: t, pathomit })

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const results: { opts: Record<string, number>; dE: number; chamfer: number; nodes: number; regionsAll: number }[] = []
for (const [gi, opts] of grid.entries()) {
  const tool = imagetracer('imagetracer-sweep', 'default', opts)
  const dE: number[] = []
  const ch: number[] = []
  const nodes: number[] = []
  let regionsAll = 0
  for (const k of cases) {
    // In-process: the adapter reads the pixels only, so no PNG is written.
    const { svg } = await (tool.trace as NonNullable<typeof tool.trace>)({
      case: k.c,
      image: k.img,
      pngPath: '',
      lane: 'colour',
      ink: '#000000',
    })
    const { row } = scoreTrace(k.c, k.truth, 'imagetracer-sweep', svg, 0, 'colour', { docVisible: true })
    if (row.meanDeltaE !== undefined) dE.push(row.meanDeltaE)
    if (row.chamfer !== undefined) ch.push(row.chamfer)
    if (row.docNodes !== undefined) nodes.push(row.docNodes)
    if (row.flat && (row.regionsTrue ?? 0) > 0 && row.regionsRecovered === row.regionsTrue) regionsAll++
  }
  const r = { opts, dE: median(dE), chamfer: median(ch), nodes: median(nodes), regionsAll }
  results.push(r)
  console.log(
    `${gi + 1}/${grid.length} ${JSON.stringify(opts)}  ΔE ${r.dE.toFixed(3)}  chamfer ${r.chamfer.toFixed(3)}  nodes ${r.nodes}  regions ${regionsAll}`,
  )
}

// Competition ranking: a configuration's rank is how many score strictly better, so tied
// medians share a rank and the documented tie-break (fewer nodes) decides between them,
// not the order the grid happened to list them in.
const rank = (k: 'dE' | 'chamfer'): Map<object, number> =>
  new Map(results.map((r) => [r.opts, results.filter((o) => o[k] < r[k]).length]))
const rd = rank('dE')
const rc = rank('chamfer')
const scored = results
  .map((r) => ({ ...r, score: (rd.get(r.opts) ?? 0) + (rc.get(r.opts) ?? 0) }))
  .sort((a, b) => a.score - b.score || a.nodes - b.nodes)
writeFileSync(
  join(dir, 'sweep.json'),
  JSON.stringify(
    { date: new Date().toISOString(), git: provenance(), res: RES, cases: cases.length, ranked: scored },
    null,
    1,
  ),
)
console.log('\nTop 5 (rank ΔE + rank chamfer):')
for (const r of scored.slice(0, 5))
  console.log(
    `  ${JSON.stringify(r.opts)}  ΔE ${r.dE.toFixed(3)} chamfer ${r.chamfer.toFixed(3)} nodes ${r.nodes} regions ${r.regionsAll}  score ${r.score}`,
  )
const def = results.find((r) => r.opts.numberofcolors === 16 && r.opts.ltres === 1 && r.opts.pathomit === 8)
if (def)
  console.log(
    `  (default, unstroked: ΔE ${def.dE.toFixed(3)} chamfer ${def.chamfer.toFixed(3)} nodes ${def.nodes} regions ${def.regionsAll})`,
  )
console.log(`\nPICK: ${JSON.stringify(scored[0].opts)}`)
