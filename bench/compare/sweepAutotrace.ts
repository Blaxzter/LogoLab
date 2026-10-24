// Pick autotrace-swept on the IN-SAMPLE corpora only, as sweepVtracer.ts picks vtracer-swept.
//
//   node --experimental-strip-types bench/compare/sweepAutotrace.ts [--res 512]
//
// Grid (frozen; the pick is copied into adapters/external.ts AUTOTRACE_SWEPT):
//   color-count {0 (off), 8, 16, 32} × despeckle-level {0, 2, 4, 8} × error-threshold {1, 2};
//   everything else AutoTrace's default. Cases: truth0 + fluent2, never svgemoji. Same
//   scorer and the same rule as the VTracer sweep: lowest sum of the rank on median ΔE and
//   the rank on median chamfer, ties to fewer median nodes. Writes
//   .bench-tools/results/autotrace-sweep/sweep.json.

import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureImageData } from '../nodeHarness.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../svgGround.ts'
import { loadCorpus } from './corpus.ts'
import { renderGround } from './render.ts'
import { scoreTrace } from './score.ts'
import { AUTOTRACE, toPpm } from './adapters/external.ts'
import { RESULTS } from './paths.ts'

ensureImageData()
const run = promisify(execFile)
const RES = Number(process.argv[process.argv.indexOf('--res') + 1] || 512) || 512
const dir = join(RESULTS, 'autotrace-sweep')
mkdirSync(join(dir, 'ppm'), { recursive: true })

const cases = [...loadCorpus('truth0'), ...loadCorpus('fluent2')].map((c) => {
  const svg = readFileSync(c.svgPath, 'utf8')
  const img = renderGround(svg, RES)
  const gt = parseGroundTruth(svg)
  const refusal = unscorable(gt)
  const ppm = join(dir, 'ppm', `${c.id.replace(/[^\w.-]+/g, '_')}.ppm`)
  writeFileSync(ppm, toPpm(img))
  return { c, ppm, truth: { img, shapes: refusal ? null : toRasterSpace(gt, img.width), refusal } }
})

const grid: string[][] = []
for (const cc of [0, 8, 16, 32])
  for (const d of [0, 2, 4, 8])
    for (const e of [1, 2])
      grid.push([
        ...(cc ? ['-color-count', `${cc}`] : []),
        ...(d ? ['-despeckle-level', `${d}`] : []),
        ...(e !== 2 ? ['-error-threshold', `${e}`] : []),
      ])

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
      await run(AUTOTRACE, ['-output-format', 'svg', '-output-file', o, ...args, k.ppm])
      return readFileSync(o, 'utf8')
    }),
  )
  const dE: number[] = []
  const ch: number[] = []
  const nodes: number[] = []
  let regionsAll = 0
  for (const [i, k] of cases.entries()) {
    const { row } = scoreTrace(k.c, k.truth, 'autotrace-sweep', svgs[i], 0, 'colour', { docVisible: true })
    if (row.meanDeltaE !== undefined) dE.push(row.meanDeltaE)
    if (row.chamfer !== undefined) ch.push(row.chamfer)
    if (row.docNodes !== undefined) nodes.push(row.docNodes)
    if (row.flat && (row.regionsTrue ?? 0) > 0 && row.regionsRecovered === row.regionsTrue) regionsAll++
  }
  const r = { args, dE: median(dE), chamfer: median(ch), nodes: median(nodes), regionsAll }
  results.push(r)
  console.log(
    `${gi + 1}/${grid.length} ${args.join(' ') || '(default)'}  ΔE ${r.dE.toFixed(3)}  chamfer ${r.chamfer.toFixed(3)}  nodes ${r.nodes}  regions ${regionsAll}`,
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
    `  ${r.args.join(' ') || '(default)'}  ΔE ${r.dE.toFixed(3)} chamfer ${r.chamfer.toFixed(3)} nodes ${r.nodes} regions ${r.regionsAll}  score ${r.score}`,
  )
const def = results.find((r) => r.args.length === 0)
if (def)
  console.log(
    `  (default: ΔE ${def.dE.toFixed(3)} chamfer ${def.chamfer.toFixed(3)} nodes ${def.nodes} regions ${def.regionsAll})`,
  )
console.log(`\nPICK: ${JSON.stringify(scored[0].args)}`)
