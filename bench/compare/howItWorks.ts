// The /labs/how article's figures and numbers, frozen out of comparison runs.
//
//   node --experimental-strip-types bench/compare/howItWorks.ts [--base v6] [--list]
//
// The article explains the tracer one rule at a time, and every rule it names is shown the
// same way: the same case traced with that rule switched off and on, everything else equal.
// The "off" traces come from ablation runs of the benchmark itself, one per rule:
//
//   node --experimental-strip-types bench/compare/run.ts --tools logolab-auto \
//        --corpus svgemoji-v0,truth0,fluent2 --no-svgbench --fit <rule>=false --run abl-<rule>
//
// so the off and on columns went through the same scorer as the benchmark, and the census
// under each figure (what the rule is worth over the 100 held-out emoji) is a paired test on
// the same cases. The base run must be at the same tracer commit as the ablation runs; this
// refuses a pair whose LogoLab versions differ.
//
// --list prints, per rule, the cases its metric moves most, which is how RULES' cases were
// picked. The pipeline figure (pixels → regions → shared edges → SVG) is traced here, with
// the tracer's tiled defaults, because those intermediate stages are not in a run.
//
// Output: public/how-it-works/<slug>/{authored,on,off}.svg and the pipeline's stage files,
// and src/components/labs/how/howItWorks.generated.ts.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureImageData } from '../nodeHarness.ts'
import { decodePng } from '../../src/lib/png/decode.ts'
import { encodePng } from '../../src/lib/png/encode.ts'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../../src/lib/trace/index.ts'
import { labelColor } from '../../src/lib/trace/stageViz.ts'
import { docStats, serializeDoc, subPathsToD } from '../../src/lib/path/model.ts'
import { caseOverlay } from './overlay.ts'
import { REPO, RESULTS } from './paths.ts'
import {
  METRIC_BY_KEY,
  caseTable,
  paired,
  type BenchResults,
  type BenchRow,
} from '../../src/components/labs/bench/benchData.ts'
import type { HowItWorks, HowRule } from '../../src/components/labs/how/howTypes.ts'
import type { ShowMetrics } from '../../src/components/labs/bench/showcaseTypes.ts'

const argv = process.argv.slice(2)
const arg = (k: string, d: string): string => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const BASE = arg('--base', 'v6')
const LIST = argv.includes('--list')
const TOOL = 'logolab-auto'
const HELD_OUT = 'svgemoji-v0'
const OUT_PUBLIC = join(REPO, 'public', 'how-it-works')
const OUT_DATA = join(REPO, 'src', 'components', 'labs', 'how', 'howItWorks.generated.ts')

/** The rules the article shows. `metric` is the one the rule exists to move; `caseId` is the
 *  figure's case (picked with --list, read for a clear picture of the mechanism, not for the
 *  biggest number). `on` is the rule-on run when it is not --base: an ablation re-run after a
 *  commit is paired with a base traced at that commit. */
const RULES: { rule: string; metric: string; caseId: string; on?: string }[] = [
  // A placement-only change: same nodes, no kinks either way, edges 0.29 → 0.20 px.
  { rule: 'subpixelEdges', metric: 'chamfer', caseId: 'truth0/cross-bars' },
  // The case the veto was written for: checker cells must not melt into blobs.
  { rule: 'cornerVeto', metric: 'cornersRecovered', caseId: 'truth0/checker' },
  // --fit fillets=false only reached the fit from 3469a57 on (planarFitOptionsFor), so this pair
  // is traced at that commit; how-base is byte-identical to v6's LogoLab SVGs (156 of 156, checked with cmp).
  // The fixture made for it: rounded rects, pills and pins, 40 kinks off, 9 on.
  { rule: 'fillets', metric: 'tangentBreaks', caseId: 'truth0/round-polys', on: 'how-base' },
  // The mouth runs past the cheeks: 8 kinks off, 0 on (and 68 → 58 nodes).
  { rule: 'throughPairs', metric: 'tangentBreaks', caseId: 'svgemoji-v0/1f60a-twemoji' },
  // Petals: 41 → 36 nodes and 2 → 0 kinks where the petals meet. The held-out census is mixed.
  { rule: 'junctionReseat', metric: 'chamfer', caseId: 'truth0/petals' },
  // The A button: straight sides into rounded corners, 9 kinks off, 0 on.
  { rule: 'lineTangents', metric: 'tangentBreaks', caseId: 'svgemoji-v0/1f170-twemoji' },
]
/** The census metrics, under every rule's figure and in the article's table. */
const CENSUS = ['meanDeltaE', 'chamfer', 'docNodes', 'tangentBreaks', 'cornersInvented', 'cornersRecovered']
const ROW_KEYS = [
  'meanDeltaE',
  'chamfer',
  'p95',
  'docNodes',
  'nodeRatio',
  'tangentBreaks',
  'cornersInvented',
  'cornersRecovered',
  'gtNodes',
]
/** The pipeline figure's case: a flat emoji with shapes meeting at three-way junctions. */
const PIPELINE_CASE = 'svgemoji-v0/1f60a-twemoji'

const load = (run: string): BenchResults => JSON.parse(readFileSync(join(RESULTS, run, 'results.json'), 'utf8'))
const gtSvgOf = (run: string): Map<string, string> => {
  const m = new Map<string, string>()
  for (const line of readFileSync(join(RESULTS, run, 'pairs.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const p = JSON.parse(line) as { key: string; gt_svg: string }
    m.set(p.key.slice(p.key.indexOf('|') + 1), p.gt_svg)
  }
  return m
}
const corpusOf = (caseId: string) => caseId.slice(0, caseId.indexOf('/'))
const num = (r: BenchRow | undefined, k: string): number | null =>
  r && typeof r[k] === 'number' && Number.isFinite(r[k] as number) ? (r[k] as number) : null

const base = load(BASE)
const gtSvg = gtSvgOf(BASE)

/** The tracer's code: what a dirty run may NOT have touched. Everything else under src and
 *  bench (this script, the labs pages, the app-only folders of src/lib) can be mid-edit while
 *  the ablations run. Inclusive on purpose: a new folder under src/lib counts as tracer. */
const TRACER = /^(src\/mcp\/|src\/types\.ts$|src\/lib\/(?!seo\/|persist\/|report\/|editor\/|text\/))/
interface Git {
  head: string
  status: string[]
}
const gitOf = (r: BenchResults): Git | undefined =>
  (r.meta as unknown as { provenance?: { git?: Git } }).provenance?.git
/** The ablation and the base must trace the same tracer: one commit, and no uncommitted
 *  change to the tracer's files in either run. */
function sameTracer(off: BenchResults, name: string, on: BenchResults, onName: string): void {
  const a = gitOf(off)
  const b = gitOf(on)
  if (!a || !b) throw new Error(`${name}: no provenance to compare with ${onName}`)
  if (a.head !== b.head) throw new Error(`${name} is at ${a.head}, ${onName} at ${b.head}`)
  for (const [run, g] of [
    [name, a],
    [onName, b],
  ] as const) {
    const touched = g.status.map((l) => l.slice(3)).filter((p) => TRACER.test(p))
    if (touched.length) throw new Error(`${run} ran with uncommitted tracer changes: ${touched.join(', ')}`)
  }
}

/** One table per corpus holding the rule-on row as `on` and the rule-off row as `off`. */
function joined(off: BenchResults, on: BenchResults, corpus: string): Map<string, Map<string, BenchRow>> {
  const t = new Map<string, Map<string, BenchRow>>()
  for (const [id, byTool] of caseTable(on.rows, corpus)) {
    const on = byTool.get(TOOL)
    if (on) t.set(id, new Map([['on', on]]))
  }
  for (const [id, byTool] of caseTable(off.rows, corpus)) {
    const r = byTool.get(TOOL)
    if (r) t.get(id)?.set('off', r)
  }
  return t
}

const rules: HowRule[] = []
if (!LIST) {
  rmSync(OUT_PUBLIC, { recursive: true, force: true })
  mkdirSync(OUT_PUBLIC, { recursive: true })
}

for (const spec of RULES) {
  const runName = `abl-${spec.rule}`
  if (!existsSync(join(RESULTS, runName, 'results.json'))) {
    console.warn(`${runName}: not run yet — skipped`)
    continue
  }
  const off = load(runName)
  const onName = spec.on ?? BASE
  const on = spec.on ? load(spec.on) : base
  sameTracer(off, runName, on, onName)
  const fit = (off.meta as unknown as { fit?: Record<string, unknown> }).fit
  if (!fit || fit[spec.rule] !== false) throw new Error(`${runName} was not run with --fit ${spec.rule}=false`)

  if (LIST) {
    console.log(`\n== ${spec.rule} (${spec.metric}, off − on; most moved first)`)
    for (const corpus of ['svgemoji-v0', 'truth0', 'fluent2']) {
      const moved = [...joined(off, on, corpus)]
        .map(([id, m]) => ({ id, a: num(m.get('off'), spec.metric), b: num(m.get('on'), spec.metric), m }))
        .filter((x) => x.a !== null && x.b !== null && x.a !== x.b)
        .sort((x, y) => Math.abs((y.a ?? 0) - (y.b ?? 0)) - Math.abs((x.a ?? 0) - (x.b ?? 0)))
      console.log(`  ${corpus}: ${moved.length} cases move`)
      for (const x of moved.slice(0, 6))
        console.log(
          `    ${x.id}  off ${x.a?.toFixed(2)}  on ${x.b?.toFixed(2)}  nodes ${num(x.m.get('off'), 'docNodes')}→${num(x.m.get('on'), 'docNodes')}  kinks ${num(x.m.get('off'), 'tangentBreaks')}→${num(x.m.get('on'), 'tangentBreaks')}`,
        )
    }
    continue
  }
  if (!spec.caseId) throw new Error(`${spec.rule}: no case picked (run --list)`)

  const census = CENSUS.map((k) => {
    const metric = METRIC_BY_KEY.get(k)
    if (!metric) throw new Error(k)
    const t = joined(off, on, HELD_OUT)
    const moved = [...t.values()].filter((m) => {
      const a = num(m.get('off'), k)
      const b = num(m.get('on'), k)
      return a !== null && b !== null && a !== b
    }).length
    return { metric: k, moved, ...paired(t, 'off', 'on', metric, 4000) }
  })

  const slug = spec.rule
  const dir = join(OUT_PUBLIC, slug)
  mkdirSync(dir)
  const authoredPath = gtSvg.get(spec.caseId)
  if (!authoredPath || !existsSync(authoredPath)) throw new Error(`${spec.caseId}: no authored SVG in ${BASE}`)
  copyFileSync(authoredPath, join(dir, 'authored.svg'))
  const svgs = new Map<string, string>()
  const rows = joined(off, on, corpusOf(spec.caseId)).get(spec.caseId)
  if (!rows?.get('on') || !rows.get('off')) throw new Error(`${spec.caseId}: missing a side`)
  for (const [side, run] of [
    ['off', runName],
    ['on', onName],
  ] as const) {
    const src = join(RESULTS, run, 'cases', spec.caseId, `${TOOL}.svg`)
    copyFileSync(src, join(dir, `${side}.svg`))
    svgs.set(side, readFileSync(src, 'utf8'))
  }
  const o = caseOverlay(readFileSync(authoredPath, 'utf8'), base.meta.res, svgs)
  const tools = (['off', 'on'] as const).map((side) => {
    const metrics: ShowMetrics = {}
    for (const k of ROW_KEYS) {
      const v = rows.get(side)?.[k]
      if (typeof v === 'number') metrics[k] = v
    }
    return { tool: side, metrics, ...o.tools[side] }
  })
  const meta = base.meta.cases.find((c) => c.id === spec.caseId)
  rules.push({
    rule: spec.rule,
    metric: spec.metric,
    census,
    example: {
      slug,
      caseId: spec.caseId,
      license: meta?.license ?? '',
      source: meta?.source ?? '',
      width: o.width,
      height: o.height,
      authoredNodes: o.authored,
      tools,
    },
  })
}

if (LIST) process.exit(0)

// --- The pipeline figure: the stages of one trace, with the tracer's tiled defaults. -----
ensureImageData()
const truth = decodePng(new Uint8Array(readFileSync(join(RESULTS, BASE, 'cases', PIPELINE_CASE, 'truth.png'))))
const image = new ImageData(new Uint8ClampedArray(truth.data), truth.width, truth.height)
let labels: Int32Array | null = null
const options = { ...DEFAULT_VECTORIZE_OPTIONS, gradients: false }
const doc = await traceImage(image, options, undefined, undefined, undefined, undefined, (l) => {
  labels = l.labels
})
if (!labels || !doc.topology) throw new Error('pipeline: no label map or topology')
const map = labels as Int32Array
const pdir = join(OUT_PUBLIC, 'pipeline')
mkdirSync(pdir)
copyFileSync(join(RESULTS, BASE, 'cases', PIPELINE_CASE, 'truth.png'), join(pdir, 'pixels.png'))
// Regions in false colour, the hue per label the studio's explainer uses.
const falseColour = new Uint8ClampedArray(map.length * 4)
for (let i = 0; i < map.length; i++) {
  const [r, g, b] = map[i] < 0 ? [255, 255, 255] : labelColor(map[i])
  falseColour.set([r, g, b, 255], i * 4)
}
writeFileSync(join(pdir, 'regions.png'), encodePng(falseColour, truth.width, truth.height))
// Every shared edge once, in its own hue, over a faint copy of the art; vertices as dots.
const { edges, vertices } = doc.topology
const edgePaths = edges
  .map((e, i) => {
    const [r, g, b] = labelColor(i)
    return `<path d="${subPathsToD([{ nodes: e.nodes, closed: e.closed }], 2)}" stroke="rgb(${r},${g},${b})"/>`
  })
  .join('')
const dots = vertices.map((v) => `<circle cx="${v.x.toFixed(2)}" cy="${v.y.toFixed(2)}" r="4"/>`).join('')
writeFileSync(
  join(pdir, 'edges.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${truth.width} ${truth.height}">` +
    `<image href="pixels.png" width="${truth.width}" height="${truth.height}" opacity="0.18"/>` +
    `<g fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${edgePaths}</g>` +
    `<g fill="#111" stroke="#fff" stroke-width="1.5">${dots}</g></svg>`,
)
const svg = serializeDoc(doc, 2)
writeFileSync(join(pdir, 'trace.svg'), svg)
const st = docStats(doc)
let regionCount = 0
{
  const seen = new Set<number>()
  for (const l of map) if (l >= 0) seen.add(l)
  regionCount = seen.size
}
const pipeline = {
  caseId: PIPELINE_CASE,
  width: truth.width,
  height: truth.height,
  regions: regionCount,
  edges: edges.length,
  vertices: vertices.length,
  paths: st.paths,
  nodes: st.nodes,
}

const out: HowItWorks = {
  base: BASE,
  date: base.meta.date,
  version: base.meta.versions[TOOL] ?? '',
  res: base.meta.res,
  heldOutCases: caseTable(base.rows, HELD_OUT).size,
  pipeline,
  rules,
}
mkdirSync(join(REPO, 'src', 'components', 'labs', 'how'), { recursive: true })
writeFileSync(
  OUT_DATA,
  `// Generated by bench/compare/howItWorks.ts from run ${BASE} and its abl-* runs: do not edit, re-run it.\n` +
    `import type { HowItWorks } from './howTypes'\n\n` +
    `export const HOW: HowItWorks = ${JSON.stringify(out)}\n`,
)
console.log(`how-it-works: ${rules.length} rules + pipeline → public/how-it-works/, data → ${OUT_DATA}`)
