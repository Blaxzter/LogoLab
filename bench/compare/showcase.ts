// The public /benchmark page's examples, frozen out of a comparison run.
//
//   node --experimental-strip-types bench/compare/showcase.ts [--run full-v1]
//
// The page argues one thing — a pixel score cannot tell a good SVG from a bad one — and it
// argues it with CASES, so the cases have to be real outputs, not screenshots of them. This
// copies a handful of a run's case directories into public/benchmark/ (the authored SVG and
// each tool's SVG, small and redistributable: Twemoji is CC-BY 4.0, the traces are
// derivatives of it) and writes src/components/benchmark/showcase.generated.ts: every
// number the page prints, the anchors of every SVG, and where each counted tangent break
// sits — read off the SAME parse (traceSvg.ts) and the SAME locator (geomScore.ts) the run
// scored with, so a dot on the page is a break in the table.
//
// The curation is the list below, with the reason each case is on it. It was picked by
// mining results.json for the pattern each section claims (2026-10-17, full-v1), and it
// includes the cases LogoLab loses — a page that only shows wins is an advert.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureImageData } from '../nodeHarness.ts'
import { parseGroundTruth, toRasterSpace } from '../svgGround.ts'
import { makeVisibleAt, tangentBreaks } from '../geomScore.ts'
import { renderGround } from './render.ts'
import { parseTraceSvg } from './traceSvg.ts'
import { REPO, RESULTS } from './paths.ts'
import {
  METRIC_BY_KEY,
  caseTable,
  paired,
  summarize,
  type BenchResults,
  type BenchRow,
} from '../../src/components/labs/bench/benchData.ts'
import type { SubPath } from '../../src/lib/path/types.ts'
import type { ShowMetrics, Showcase } from '../../src/components/benchmark/showcaseTypes.ts'

ensureImageData()

const argv = process.argv.slice(2)
const RUN = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : 'full-v1'
const CORPUS = 'svgemoji-v0'
const OUT_PUBLIC = join(REPO, 'public', 'benchmark')
const OUT_DATA = join(REPO, 'src', 'components', 'benchmark', 'showcase.generated.ts')

/** The page's cases. `why` is for the next person to curate, not for the page. */
const EXAMPLES: { slug: string; caseId: string; tools: string[]; why: string }[] = [
  {
    slug: 'smiling-face',
    caseId: 'svgemoji-v0/1f60a-twemoji',
    tools: ['logolab-auto', 'vtracer-default', 'starvector-1b'],
    why: 'DINO 0.9999 / 0.9998 / 0.9996 — the same picture to the metric; 68 vs 235 nodes, 0 vs 19 breaks.',
  },
  {
    slug: 'shushing-face',
    caseId: 'svgemoji-v0/1f92b-twemoji',
    tools: ['logolab-auto', 'vtracer-default'],
    why: 'Identical DINO, LPIPS prefers VTracer, which is 3× further off the drawing with 54 kinks to 6.',
  },
  {
    slug: 'crystal-ball',
    caseId: 'svgemoji-v0/1f52e-twemoji',
    tools: ['logolab-auto', 'vtracer-default'],
    why: 'DINO and LPIPS both rank VTracer first; chamfer 0.43 vs 0.12 px, 3.3× the nodes.',
  },
  {
    slug: 'leg',
    caseId: 'svgemoji-v0/1f9b5-1f3ff-twemoji',
    tools: ['logolab-auto', 'starvector-1b', 'potrace-bin'],
    why: 'A black silhouette (ΔE 15) scores DINO 0.967; StarVector 0.998 while 3.3 px off the outline.',
  },
  {
    slug: 'bat',
    caseId: 'svgemoji-v0/1f987-twemoji',
    tools: ['vtracer-default', 'logolab-auto', 'potrace-bin'],
    why: 'LogoLab LOSES (two greys merged, wings gone). DINO also ranks the black outline above it.',
  },
  {
    slug: 'camera',
    caseId: 'svgemoji-v0/1f4f9-twemoji',
    tools: ['vtracer-default', 'logolab-auto'],
    why: 'LogoLab LOSES: ΔE 5.77 vs 0.44, the grey parts of the camera are gone.',
  },
]

/** Tools in the headline table, in the page's order. */
const TABLE_TOOLS = ['logolab-auto', 'vtracer-default', 'vtracer-swept', 'starvector-1b', 'potrace-bin']
const ROW_KEYS = [
  'sbDino',
  'sbLpips',
  'sbSsim',
  'sbMse',
  'meanDeltaE',
  'chamfer',
  'p95',
  'docNodes',
  'nodeRatio',
  'tangentBreaks',
  'cornersInvented',
  'bytes',
  'regionsRecovered',
  'regionsTrue',
  'gtNodes',
  'status',
]

const runDir = join(RESULTS, RUN)
const results = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as BenchResults
const gtSvg = new Map<string, string>()
for (const line of readFileSync(join(runDir, 'pairs.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue
  const p = JSON.parse(line) as { key: string; gt_svg: string }
  gtSvg.set(p.key.slice(p.key.indexOf('|') + 1), p.gt_svg)
}
const table = caseTable(results.rows, CORPUS)
const meta = new Map(results.meta.cases.map((c) => [c.id, c]))
const round = (v: number) => Math.round(v * 10) / 10
const anchors = (sets: SubPath[][]) => sets.flat().flatMap((sp) => sp.nodes.flatMap((n) => [round(n.x), round(n.y)]))

rmSync(OUT_PUBLIC, { recursive: true, force: true })
mkdirSync(OUT_PUBLIC, { recursive: true })
mkdirSync(join(REPO, 'src', 'components', 'benchmark'), { recursive: true })

const examples = EXAMPLES.map((ex) => {
  const authoredPath = gtSvg.get(ex.caseId)
  if (!authoredPath || !existsSync(authoredPath)) throw new Error(`${ex.caseId}: no authored SVG in ${RUN}`)
  const authored = readFileSync(authoredPath, 'utf8')
  const img = renderGround(authored, results.meta.res)
  const shapes = toRasterSpace(parseGroundTruth(authored), img.width)
  const visible = makeVisibleAt(img)
  const dir = join(OUT_PUBLIC, ex.slug)
  mkdirSync(dir)
  copyFileSync(authoredPath, join(dir, 'authored.svg'))
  const byTool = table.get(ex.caseId)
  if (!byTool) throw new Error(`${ex.caseId}: not in ${RUN}/${CORPUS}`)

  const tools = ex.tools.map((tool) => {
    const row = byTool.get(tool) as BenchRow | undefined
    if (!row) throw new Error(`${ex.caseId}: no ${tool} row`)
    const src = join(runDir, 'cases', ex.caseId, `${tool}.svg`)
    copyFileSync(src, join(dir, `${tool}.svg`))
    const parsed = parseTraceSvg(readFileSync(src, 'utf8'), img.width, img.height)
    const sets = parsed.shapes?.map((s) => s.subPaths) ?? []
    const breaks = parsed.shapes ? tangentBreaks(shapes, sets, img.width, img.height, visible).sites : []
    const metrics: ShowMetrics = {}
    for (const k of ROW_KEYS) {
      const v = row[k]
      if (typeof v === 'number' || typeof v === 'string') metrics[k] = v
    }
    return {
      tool,
      metrics,
      anchors: anchors(sets),
      breaks: breaks.flatMap((b) => [round(b.x), round(b.y), Math.round(b.kink)]),
    }
  })
  const m = meta.get(ex.caseId)
  return {
    slug: ex.slug,
    caseId: ex.caseId,
    license: m?.license ?? '',
    source: m?.source ?? '',
    width: img.width,
    height: img.height,
    authoredNodes: anchors(shapes.map((s) => s.subPaths)),
    tools,
  }
})

// The headline table and the paired test, computed by the lab's own stats module so the
// public page and /labs/bench cannot print different numbers for the same run.
const summary = summarize(results.rows, CORPUS, TABLE_TOOLS).map((s) => ({
  tool: s.tool,
  n: s.n,
  failures: s.failures,
  regionsAll: s.regionsAll,
  median: Object.fromEntries(Object.entries(s.metrics).map(([k, d]) => [k, d.n ? d.median : null])),
  scored: Object.fromEntries(Object.entries(s.metrics).map(([k, d]) => [k, d.n])),
}))
const pairedVsVtracer = ['sbDino', 'sbLpips', 'sbSsim', 'meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks'].map(
  (k) => {
    const metric = METRIC_BY_KEY.get(k)
    if (!metric) throw new Error(k)
    return { metric: k, ...paired(table, 'vtracer-default', 'logolab-auto', metric) }
  },
)

const manifest = JSON.parse(readFileSync(join(REPO, 'bench', 'compare', 'manifests', 'svg-emoji-test.json'), 'utf8'))
const showcase: Showcase = {
  run: RUN,
  date: results.meta.date,
  res: results.meta.res,
  corpus: CORPUS,
  cases: table.size,
  dataset: {
    id: manifest.dataset,
    revision: manifest.revision,
    split: manifest.split,
    parquetSha256: manifest.parquetSha256,
  },
  versions: Object.fromEntries(TABLE_TOOLS.map((t) => [t, results.meta.versions[t] ?? ''])),
  summary,
  pairedVsVtracer,
  examples,
}
writeFileSync(
  OUT_DATA,
  `// Generated by bench/compare/showcase.ts from run ${RUN}: do not edit, re-run it.
` +
    `import type { Showcase } from './showcaseTypes'

` +
    `export const SHOWCASE: Showcase = ${JSON.stringify(showcase)}
`,
)
console.log(`showcase: ${examples.length} examples → public/benchmark/, data → ${OUT_DATA}`)
