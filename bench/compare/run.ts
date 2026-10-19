// Vectorizer comparison: LogoLab vs VTracer / Potrace / StarVector on authored-SVG corpora.
//
//   node --experimental-strip-types bench/compare/run.ts [--tools a,b] [--corpus x,y] [--limit n]
//        [--res 512] [--run name] [--no-svgbench] [--no-cache] [--gate-exact]
//
// Why authored SVGs: the answer sheet has to be the vector art that produced the pixels, or
// "correct" cannot be told from "like the other tracer". StarVector's SVG-Bench scores the
// same way (it rasterizes the dataset's source SVG), so the headline corpus is ITS published
// held-out split — svg-emoji test, frozen in manifests/ — and the in-sample LogoLab corpora
// (truth tier 0, Fluent flat twins) run as a labelled development lane. See corpus.ts.
//
// Every tool gets the same input — the case's authored SVG rasterized with resvg on white at
// --res (the truth gate's own raster) — and every output goes through ONE scoring path
// (score.ts): resvg render → shipped ΔE, svgGround geometry → truth-gate metrics, and the
// SVG-Bench metrics in one Python batch pass (py/svgbench_metrics.py). StarVector resizes
// that PNG to its native 224px itself; its output is scored at --res like everyone else.
// A trace that fails, or renders nothing resvg can draw, is a FAILURE row, never dropped.
//
// Tools (all local, under the gitignored .bench-tools/):
//   logolab-auto, logolab-product, logolab-gate   in-process (adapters/logolab.ts) + 3 ablation rows
//   vtracer-default, vtracer-poster, vtracer-swept cargo install vtracer --version 0.6.4 --locked --root .bench-tools/vtracer
//   potrace (mono lane), potrace-bin (every case) potrace-1.16.win64.zip → .bench-tools/potrace/
//   starvector-1b                                 .bench-tools/starvector-venv + HF weights (adapters/starvector.ts)
// Setup (all of it, pinned): bench/compare/py/setup.sh. Data: py/fetch_svgbench.py.
// --skip-tools a,b drops tools for one run (e.g. starvector on the 668-row corpus).
//
// Output: .bench-tools/results/<run>/ — cases/<corpus>/<case>/{truth.png,<tool>.svg,<tool>.png},
// results.json (every row + run metadata), summary.md, pairs.jsonl / svgbench.jsonl, and an
// overlay.json per case (node + kink positions, overlay.ts).
// External tools are cached by (tool version, PNG bytes) in .bench-tools/compare-cache/;
// LogoLab is always re-traced (it is what changes).
//
// --gate-exact scores the traced side WITHOUT the visible-boundary filter, which is how the
// truth gate scores; with it, logolab-gate on truth0 reproduces test/truth-gate.test.ts.

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ensureImageData } from '../nodeHarness.ts'
import { encodePng } from '../../src/lib/png/encode.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../svgGround.ts'
import { CACHE, PY, RESULTS, REPO, VENV_PY } from './paths.ts'
import { CORPORA, DEFAULT_CORPORA, inkOf, loadCorpus } from './corpus.ts'
import { renderGround } from './render.ts'
import { scoreTrace, type Truth } from './score.ts'
import { summaryMarkdown } from './report.ts'
import { writeOverlays } from './overlay.ts'
import { logolabAblation, logolabAuto, logolabGate, logolabProduct, provenance } from './adapters/logolab.ts'
import { potrace, potraceBin, vtracerDefault, vtracerPoster, vtracerSwept, VTRACER_SWEPT } from './adapters/external.ts'
import { starvector, starvectorProvenance } from './adapters/starvector.ts'
import type { CompareCase, CorpusId, ScoreRow, TraceInput, TraceResult, TracerAdapter } from './types.ts'

ensureImageData()

// Order is the table's: the user-facing LogoLab row first, the oracle reference row after.
const ALL_TOOLS: TracerAdapter[] = [
  logolabAuto,
  logolabProduct,
  logolabGate,
  vtracerDefault,
  vtracerPoster,
  vtracerSwept,
  starvector,
  potrace,
  potraceBin,
  ...logolabAblation,
]

const argv = process.argv.slice(2)
const arg = (k: string): string | undefined => {
  const i = argv.indexOf(k)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (k: string): boolean => argv.includes(k)
const list = (k: string): string[] | undefined =>
  arg(k)
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const RES = Number(arg('--res') ?? 512)
const LIMIT = arg('--limit') ? Number(arg('--limit')) : Infinity
const corpusIds = (list('--corpus') ?? DEFAULT_CORPORA) as CorpusId[]
for (const c of corpusIds) if (!CORPORA.includes(c)) throw new Error(`unknown corpus ${c} (have ${CORPORA.join(', ')})`)
const toolNames = list('--tools')
for (const t of toolNames ?? [])
  if (!ALL_TOOLS.some((a) => a.name === t))
    throw new Error(`unknown tool ${t} (have ${ALL_TOOLS.map((a) => a.name).join(', ')})`)
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const RUN = arg('--run') ?? stamp
const runDir = join(RESULTS, RUN)
const useCache = !has('--no-cache')
const docVisible = !has('--gate-exact')

const caseDir = (c: CompareCase): string => join(runDir, 'cases', c.corpus, c.name.replace(/[^\w.-]+/g, '_'))
const sha1 = (b: Uint8Array | string): string => createHash('sha1').update(b).digest('hex')

async function main(): Promise<void> {
  // ── provenance, taken ONCE before anything runs (HEAD can move during a long run)
  const prov = provenance()
  if (prov.dirty)
    console.log(
      `  ⚠ working tree differs from ${prov.head} under src/ bench/ (${prov.status.length} paths) — recorded in meta`,
    )
  // ── tools
  const skip = list('--skip-tools') ?? []
  const wanted = (toolNames ? ALL_TOOLS.filter((t) => toolNames.includes(t.name)) : ALL_TOOLS).filter(
    (t) => !skip.includes(t.name),
  )
  const tools: { a: TracerAdapter; version: string }[] = []
  for (const a of wanted) {
    const why = await a.available()
    if (why) {
      console.log(`  ⨯ ${a.name}: skipped — ${why}`)
      continue
    }
    tools.push({ a, version: await a.version() })
    console.log(`  ✓ ${a.name}: ${tools[tools.length - 1].version}`)
  }

  // ── cases: truth raster, answer sheet, lane
  const cases: { c: CompareCase; truth: Truth; input: TraceInput; gtSvgPath: string }[] = []
  for (const id of corpusIds) {
    const cs = loadCorpus(id).slice(0, LIMIT)
    console.log(`  ${id}: ${cs.length} cases`)
    for (const c of cs) {
      const svg = readFileSync(c.svgPath, 'utf8')
      const img = renderGround(svg, RES)
      const gt = parseGroundTruth(svg)
      const refusal = unscorable(gt)
      // Exactly as the truth gate maps the answer sheet (the raster is fitTo-width).
      const shapes = refusal ? null : toRasterSpace(gt, img.width)
      const dir = caseDir(c)
      mkdirSync(dir, { recursive: true })
      const pngPath = join(dir, 'truth.png')
      writeFileSync(pngPath, encodePng(img.data, img.width, img.height))
      cases.push({
        c,
        truth: { img, shapes, refusal },
        input: { pngPath, image: img, ...inkOf(img), case: c },
        gtSvgPath: c.svgPath,
      })
    }
  }
  console.log(
    `  ${cases.length} cases (${cases.filter((k) => k.input.lane === 'mono').length} mono), ${tools.length} tools, ${RES}px → ${relative(REPO, runDir)}`,
  )

  // ── trace
  const traces = new Map<string, TraceResult | { error: string }>() // `${tool}|${caseId}`
  for (const { a, version } of tools) {
    const mine = cases.filter((k) => a.lanes.includes(k.input.lane))
    console.log(`\n━━ ${a.name} — ${mine.length} cases`)
    const cacheable = !a.name.startsWith('logolab') && useCache
    const cachePath = (k: (typeof cases)[number]): string =>
      join(CACHE, a.name, `${sha1(version + sha1(readFileSync(k.input.pngPath)))}.json`)
    const todo: typeof mine = []
    for (const k of mine) {
      const p = cachePath(k)
      if (cacheable && existsSync(p)) traces.set(`${a.name}|${k.c.id}`, JSON.parse(readFileSync(p, 'utf8')))
      else todo.push(k)
    }
    if (todo.length < mine.length) console.log(`  ${mine.length - todo.length} from cache`)
    const store = (k: (typeof cases)[number], r: TraceResult | { error: string }): void => {
      traces.set(`${a.name}|${k.c.id}`, r)
      if (cacheable && !('error' in r)) {
        mkdirSync(join(CACHE, a.name), { recursive: true })
        writeFileSync(cachePath(k), JSON.stringify(r))
      }
    }
    if (a.traceBatch && todo.length) {
      const res = await a.traceBatch(
        todo.map((k) => k.input),
        join(runDir, 'batch', a.name),
      )
      for (const k of todo) store(k, res.get(k.c.id) ?? { error: 'no result from batch' })
    } else if (a.trace) {
      for (const k of todo) {
        try {
          const r = await a.trace(k.input)
          store(k, r)
          console.log(`  ${k.c.id}  ${r.ms.toFixed(0)}ms${r.notes ? `  ${r.notes.slice(0, 80)}` : ''}`)
        } catch (e) {
          store(k, { error: (e as Error).message.split('\n')[0] })
          console.log(`  ${k.c.id}  ✗ ${(e as Error).message.split('\n')[0]}`)
        }
      }
    }
  }

  // ── score
  const rows: ScoreRow[] = []
  const pairs: string[] = []
  for (const k of cases) {
    const dir = caseDir(k.c)
    for (const { a } of tools) {
      const t = traces.get(`${a.name}|${k.c.id}`)
      if (!t) continue // lane not run by this tool
      if ('error' in t) {
        rows.push({
          tool: a.name,
          caseId: k.c.id,
          corpus: k.c.corpus,
          heldOut: k.c.heldOut,
          res: RES,
          flat: !k.c.gradients,
          lane: k.input.lane,
          status: 'trace-failed',
          error: t.error,
          ms: null,
          geomRefusal: null,
          gtRefusal: k.truth.refusal,
        })
        continue
      }
      const svgOut = join(dir, `${a.name}.svg`)
      writeFileSync(svgOut, t.svg)
      let scored: ReturnType<typeof scoreTrace>
      try {
        scored = scoreTrace(k.c, k.truth, a.name, t.svg, t.ms, k.input.lane, { docVisible, notes: t.notes })
      } catch (e) {
        // A scorer crash on one output must not cost the run — and must not vanish.
        rows.push({
          tool: a.name,
          caseId: k.c.id,
          corpus: k.c.corpus,
          heldOut: k.c.heldOut,
          res: RES,
          flat: !k.c.gradients,
          lane: k.input.lane,
          status: 'render-failed',
          error: `scorer: ${(e as Error).message}`,
          ms: t.ms,
          geomRefusal: null,
          gtRefusal: k.truth.refusal,
        })
        continue
      }
      rows.push(scored.row)
      if (scored.render) {
        const pngOut = join(dir, `${a.name}.png`)
        writeFileSync(pngOut, encodePng(scored.render.data, scored.render.width, scored.render.height))
        pairs.push(
          JSON.stringify({
            key: `${a.name}|${k.c.id}`,
            gt_png: k.input.pngPath,
            gen_png: pngOut,
            gen_svg: svgOut,
            gt_svg: k.gtSvgPath,
          }),
        )
      }
      const r = scored.row
      console.log(
        `  ${a.name.padEnd(16)} ${k.c.id.padEnd(48).slice(0, 48)} ${r.status === 'ok' ? '' : r.status} ` +
          `ΔE ${r.meanDeltaE?.toFixed(2) ?? '—'}  chamfer ${r.chamfer?.toFixed(2) ?? r.geomRefusal ?? r.gtRefusal ?? '—'}  ` +
          `nodes ${r.docNodes ?? '—'}  gates ${r.gatesPassed ?? 0}/${r.gatesApplicable ?? 0}`,
      )
    }
  }

  // ── SVG-Bench metrics, one Python pass
  mkdirSync(runDir, { recursive: true })
  const pairsPath = join(runDir, 'pairs.jsonl')
  writeFileSync(pairsPath, pairs.join('\n') + '\n')
  // Node + kink positions per case, for the labs' node view (overlay.ts).
  console.log(`  overlays: ${writeOverlays(runDir, RES)} cases`)
  let sbNotes: unknown = 'skipped (--no-svgbench)'
  if (!has('--no-svgbench')) {
    if (!existsSync(VENV_PY)) sbNotes = `skipped: no Python venv at ${VENV_PY}`
    else {
      const out = join(runDir, 'svgbench.jsonl')
      console.log(`\n━━ SVG-Bench metrics (${pairs.length} pairs)`)
      const code = await new Promise<number>((resolve) => {
        const p = spawn(VENV_PY, ['-I', join(PY, 'svgbench_metrics.py'), '--pairs', pairsPath, '--out', out], {
          stdio: ['ignore', 'inherit', 'pipe'],
        })
        p.stderr.on('data', (b: Buffer) => {
          const s = b.toString()
          if (/unavailable|Error|Traceback/.test(s)) process.stderr.write(s)
        })
        p.on('close', (c) => resolve(c ?? 1))
        p.on('error', () => resolve(1))
      })
      if (code === 0 && existsSync(out)) {
        const lines = readFileSync(out, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
        sbNotes = lines[0].meta
        const byKey = new Map(lines.slice(1).map((l) => [l.key as string, l]))
        for (const r of rows) {
          const m = byKey.get(`${r.tool}|${r.caseId}`)
          if (!m) continue
          Object.assign(r, { sbMse: m.mse, sbSsim: m.ssim, sbLpips: m.lpips, sbDino: m.dino, sbTokens: m.tokens })
        }
      } else sbNotes = `failed (exit ${code})`
    }
  }

  // ── write
  const logolab = prov.dirty ? `${prov.head}+dirty` : prov.head
  const meta = {
    run: RUN,
    date: new Date().toISOString(),
    res: RES,
    logolab,
    docVisible,
    corpora: corpusIds,
    limit: Number.isFinite(LIMIT) ? LIMIT : null,
    tools: tools.map((t) => t.a.name),
    versions: Object.fromEntries(tools.map((t) => [t.a.name, t.version])),
    // What a critic needs to rebuild the run: the tree state the scorer AND the tracer ran
    // from, the pinned model / dataset revisions, and the StarVector batch's own report.
    provenance: {
      git: prov,
      vtracerSwept: VTRACER_SWEPT,
      starvector: tools.some((t) => t.a === starvector)
        ? starvectorProvenance(join(runDir, 'batch', starvector.name))
        : null,
    },
    svgbench: sbNotes,
    cases: cases.map((k) => ({
      id: k.c.id,
      lane: k.input.lane,
      license: k.c.license,
      source: k.c.source,
      gtRefusal: k.truth.refusal,
    })),
  }
  writeFileSync(join(runDir, 'results.json'), JSON.stringify({ meta, rows }, null, 1))
  writeFileSync(join(runDir, 'ATTRIBUTION.md'), ATTRIBUTION)
  const md = summaryMarkdown(rows, meta)
  writeFileSync(join(runDir, 'summary.md'), md)
  console.log(`\n${md}\n\nwrote ${relative(REPO, runDir)}/{results.json,summary.md}`)
}

const ATTRIBUTION = `# Attribution for the renders in this directory

The case renders (cases/*/*/truth.png and every tool's render of them) are derived from:

- svgemoji*: StarVector SVG-Bench \`starvector/svg-emoji\` test split (Hugging Face; the
  revision and parquet sha256 are in bench/compare/manifests/svg-emoji-test.json). Each row's
  licence is its emoji set's:
  - Twemoji: Copyright Twitter, Inc. and other contributors, CC-BY 4.0
    (https://creativecommons.org/licenses/by/4.0/). Maintained at https://github.com/jdecked/twemoji
    (twitter/twemoji is archived).
  - OpenMoji: HfG Schwäbisch Gmünd, CC-BY-SA 4.0 (https://openmoji.org).
  - Noto Emoji: Google, Apache-2.0 (https://github.com/googlefonts/noto-emoji).
- fluent2: Microsoft Fluent UI Emoji, MIT (https://github.com/microsoft/fluentui-emoji).
- truth0: LogoLab fixtures.

Renders and traces here are modified (rasterized and re-vectorized) versions of those works.
`

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
