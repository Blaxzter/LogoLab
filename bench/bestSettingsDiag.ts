// "FIND BEST SETTINGS" CENSUS — what the Vectorize studio's search
// (src/components/vectorize/studio/bestSettings.ts) would pick, how long it takes,
// and whether the pick at the reduced resolution is the pick at full resolution.
//
//   node bench/bestSettingsDiag.ts                   # examples + line art + sheets + gallery
//   … --res 256,352,384      reduced long sides to try (the search's resolution)
//   … --lanes examples,line,sheets,gallery
//   … --logos a,b | --limit N   gallery slice
//   … --no-full              skip the full-resolution traces (timing only)
//   … --json out.json        dump every row (re-analyse with --from)
//   … --from out.json        re-analyse a dump; no tracing
//
// Every case is traced with every candidate twice: at the reduced size, scored
// against the source at that same size (what the studio does), and at the
// production cap (`rasterCapFor`), scored at 1024 like the status bar. Mono gets
// the production enlargement (`monoTraceScale`) in both. The score is the shipped
// one (deltaEField + deltaEStats) over the candidate's own paint (recolour
// included), against the source WITH its alpha.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureImageData } from './nodeHarness.ts'
import { loadSource, rasterizeSource, renderSvg } from '../src/mcp/image.ts'
import { decideInkMode, type ImageDataLike } from '../src/lib/traceInput/ink.ts'
import { monoTraceScale, rasterCapFor } from '../src/lib/traceInput/traceCaps.ts'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../src/lib/trace/index.ts'
import { cropTile, downscaleImageData, toImageData, upscaleImageData } from '../src/lib/sheet/crop.ts'
import { detectSheetIcons } from '../src/lib/sheet/detect.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { deltaEField, deltaEStats } from '../src/lib/render/fidelity.ts'
import { docStats } from '../src/lib/path/model.ts'
import {
  buildCandidates,
  CANDIDATE_ORDER,
  forceColorDoc,
  pickWinner,
  poolWallMs,
  TRACE_ORDER,
  type Candidate,
  type CandidateId,
  type CandidateScore,
} from '../src/components/vectorize/studio/bestSettings.ts'

ensureImageData()

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? '') : null
}
const RES = (arg('res') ?? '256,352').split(',').map(Number)
const LANES = (arg('lanes') ?? 'examples,line,sheets,gallery').split(',')
const ONLY = arg('logos')?.split(',').filter(Boolean) ?? null
const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity
const FULL = !process.argv.includes('--no-full')
const JSON_OUT = arg('json')
const FROM = arg('from')
const SCORE_MAX_DIM = 1024

interface Run {
  meanDeltaE: number
  nodes: number
  /** Trace + render + score, ms. */
  ms: number
  traceMs: number
}
interface Row {
  name: string
  lane: string
  /** The ink probe's Auto plan: what the studio would already do. */
  auto: 'color' | 'mono'
  /** Reduced-resolution runs, per long side. */
  reduced: Record<string, Partial<Record<CandidateId, Run>>>
  full: Partial<Record<CandidateId, Run>>
}

/** A source the bench can rasterize at any long side, the way the studio decodes it. */
interface Source {
  name: string
  lane: string
  at: (longSide: number) => Promise<ImageDataLike>
}

async function runCandidate(source: ImageDataLike, traceInput: ImageDataLike, c: Candidate): Promise<Run> {
  const t0 = performance.now()
  const plan = monoTraceScale(traceInput, c.opts)
  const input = plan.scale > 1 ? upscaleImageData(traceInput, plan.scale) : traceInput
  const traced = await traceImage(toImageData(input), c.opts)
  const traceMs = performance.now() - t0
  const doc = c.forceColorOn && c.forceColor ? forceColorDoc(traced, c.forceColor) : traced
  const render = rasterizeDoc(doc, source.width, source.height, { scale: source.width / doc.viewBox[2] })
  const { de } = deltaEField(source.data, render, source.width, source.height)
  const { meanDeltaE } = deltaEStats(de)
  return { meanDeltaE, nodes: docStats(doc).nodes, ms: performance.now() - t0, traceMs }
}

async function measure(src: Source): Promise<Row | null> {
  let probe: ImageDataLike
  try {
    probe = await src.at(512)
  } catch (e) {
    process.stdout.write(`${src.name}: decode failed (${(e as Error).message})\n`)
    return null
  }
  const auto = decideInkMode(probe, 128, { colorMode: 'auto' }).mode
  const cands = buildCandidates(DEFAULT_VECTORIZE_OPTIONS, probe as ImageData)
  const row: Row = { name: src.name, lane: src.lane, auto, reduced: {}, full: {} }
  for (const r of RES) {
    const px = await src.at(r)
    const runs: Partial<Record<CandidateId, Run>> = {}
    for (const c of cands) runs[c.id] = await runCandidate(px, px, c)
    row.reduced[r] = runs
  }
  if (FULL) {
    const scoreSrc = await src.at(SCORE_MAX_DIM)
    for (const c of cands) {
      const px = await src.at(rasterCapFor(c.opts))
      row.full[c.id] = await runCandidate(scoreSrc, px, c)
    }
  }
  const cell = (x?: Run) =>
    x
      ? `${x.meanDeltaE.toFixed(2).padStart(6)} ${String(x.nodes).padStart(5)}n ${String(Math.round(x.ms)).padStart(5)}ms`
      : '—'
  process.stdout.write(`\n${src.lane}/${src.name} (auto ${auto})\n`)
  for (const id of CANDIDATE_ORDER) {
    process.stdout.write(
      `  ${id.padEnd(10)} ${RES.map((r) => `@${r} ${cell(row.reduced[r][id])}`).join(' | ')} | full ${cell(row.full[id])}\n`,
    )
  }
  return row
}

/* ------------------------------------------------------------------ corpus */

function svgSource(lane: string, name: string, text: string, background?: string): Source {
  return { name, lane, at: async (n) => renderSvg(text, n, background) }
}
function rasterSource(lane: string, name: string, full: ImageDataLike): Source {
  return { name, lane, at: async (n) => downscaleImageData(full, n) }
}

async function corpus(): Promise<Source[]> {
  const out: Source[] = []
  const ex = join(process.cwd(), 'public', 'examples')
  if (LANES.includes('examples')) {
    for (const f of readdirSync(ex).sort()) {
      if (f.endsWith('.affinity.svg')) continue
      // The studio decodes an upload with its alpha; so does this.
      if (f.endsWith('.svg')) out.push(svgSource('examples', f, readFileSync(join(ex, f), 'utf8')))
      else if (f.endsWith('.png'))
        out.push(rasterSource('examples', f, await rasterizeSource(loadSource(join(ex, f)), 8192)))
    }
  }
  if (LANES.includes('line')) {
    const dir = join(ex, 'line-art')
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.svg'))
      .sort())
      out.push(svgSource('line', f.replace(/\.svg$/, ''), readFileSync(join(dir, f), 'utf8'), '#ffffff'))
  }
  if (LANES.includes('sheets')) {
    // Tiles as /sheet cuts them from a 1024 sheet — small rasters, their native size is "full".
    const dir = join(ex, 'sheets')
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith('.webp'))
      .sort()) {
      const sheet = downscaleImageData(await rasterizeSource(loadSource(join(dir, f)), 8192), 1024)
      const det = detectSheetIcons(sheet)
      let n = 0
      for (const tile of det.tiles.filter((t) => t.kind === 'icon')) {
        n++
        const px = cropTile(sheet, tile.box, det.background)
        out.push(rasterSource('sheets', `${f.replace(/\.webp$/, '')}#${String(n).padStart(2, '0')}`, px))
      }
    }
  }
  if (LANES.includes('gallery')) {
    const dir = join(process.cwd(), 'examples', 'logos')
    let files: string[] = []
    try {
      files = readdirSync(dir)
        .filter((f) => f.endsWith('.svg'))
        .sort()
    } catch {
      process.stdout.write('examples/logos is empty — run `npm run fetch:logos` for the gallery lane\n')
    }
    if (ONLY) files = files.filter((f) => ONLY.includes(f.replace(/\.svg$/, '')))
    // On white, exactly as /labs/gallery rasterizes the marks.
    for (const f of files.slice(0, LIMIT))
      out.push(svgSource('gallery', f.replace(/\.svg$/, ''), readFileSync(join(dir, f), 'utf8'), '#ffffff'))
  }
  return out
}

/* ----------------------------------------------------------------- summary */

const scoresOf = (runs: Partial<Record<CandidateId, Run>>, ids: readonly CandidateId[]): CandidateScore[] =>
  ids.flatMap((id) => (runs[id] ? [{ id, meanDeltaE: runs[id].meanDeltaE, nodes: runs[id].nodes }] : []))

function summarize(rows: Row[]) {
  const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '—')
  const quant = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b)
    return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN
  }
  const sets: Record<string, readonly CandidateId[]> = {
    all5: CANDIDATE_ORDER,
    noBackplate: ['strokes', 'mono', 'flat', 'gradients'],
    noStrokes: ['mono', 'flat', 'backplate', 'gradients'],
    four: ['mono', 'flat', 'gradients', 'strokes'],
  }
  const res = Object.keys(rows[0]?.reduced ?? {})
  for (const r of res) {
    // Time: the search is the sum of its candidates (sequential), per case.
    const total = (ids: readonly CandidateId[]) =>
      rows.map((row) => ids.reduce((s, id) => s + (row.reduced[r][id]?.ms ?? 0), 0))
    process.stdout.write(`\n=== @${r} ===\n`)
    for (const [name, ids] of Object.entries(sets)) {
      const t = total(ids)
      process.stdout.write(
        `time ${name.padEnd(12)} median ${Math.round(quant(t, 0.5))}ms  p90 ${Math.round(quant(t, 0.9))}ms  max ${Math.round(quant(t, 1))}ms\n`,
      )
    }
    // What the studio's pool takes: TRACE_ORDER onto 2 and 3 workers.
    for (const k of [2, 3]) {
      const t = rows.map((row) =>
        poolWallMs(
          TRACE_ORDER.map((id) => row.reduced[r][id]?.ms ?? 0),
          k,
        ),
      )
      process.stdout.write(
        `pool of ${k}         median ${Math.round(quant(t, 0.5))}ms  p90 ${Math.round(quant(t, 0.9))}ms  max ${Math.round(quant(t, 1))}ms  under 2s ${t.filter((x) => x < 2000).length}/${t.length}
`,
      )
    }
    for (const id of CANDIDATE_ORDER) {
      const t = rows.map((row) => row.reduced[r][id]?.ms ?? 0)
      process.stdout.write(
        `  ${id.padEnd(10)} median ${Math.round(quant(t, 0.5))}ms  max ${Math.round(quant(t, 1))}ms\n`,
      )
    }
    for (const margin of [0, 0.3, 0.5]) {
      for (const [name, ids] of Object.entries(sets)) {
        const wins: Record<string, number> = {}
        let agree = 0
        let withFull = 0
        const regret: number[] = []
        let monoOnColour = 0
        for (const row of rows) {
          const w = pickWinner(scoresOf(row.reduced[r], ids), margin)[0]
          if (!w) continue
          wins[w.id] = (wins[w.id] ?? 0) + 1
          if (row.auto === 'color' && (w.id === 'mono' || w.id === 'strokes')) monoOnColour++
          const full = scoresOf(row.full, ids)
          if (full.length === ids.length) {
            withFull++
            const fw = pickWinner(full, margin)[0]
            if (fw.id === w.id) agree++
            const got = full.find((s) => s.id === w.id)!
            regret.push(got.meanDeltaE - fw.meanDeltaE)
          }
        }
        process.stdout.write(
          `margin ${margin} ${name.padEnd(12)} wins ${CANDIDATE_ORDER.filter((id) => wins[id])
            .map((id) => `${id}=${wins[id]}`)
            .join(' ')}  | mono-on-colour ${monoOnColour}` +
            (withFull
              ? `  | agrees with full ${agree}/${withFull} (${pct(agree, withFull)}), regret ΔE mean ${(regret.reduce((a, b) => a + b, 0) / regret.length).toFixed(3)} max ${Math.max(...regret).toFixed(2)}`
              : '') +
            '\n',
        )
      }
    }
  }
}

let rows: Row[]
if (FROM) {
  rows = JSON.parse(readFileSync(FROM, 'utf8')) as Row[]
} else {
  rows = []
  for (const src of await corpus()) {
    const row = await measure(src)
    if (row) rows.push(row)
    if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(rows))
  }
}
const lanes = [...new Set(rows.map((r) => r.lane))]
for (const lane of lanes) {
  process.stdout.write(`\n##### lane ${lane} (${rows.filter((r) => r.lane === lane).length} cases)`)
  summarize(rows.filter((r) => r.lane === lane))
}
process.stdout.write(`\n##### ALL (${rows.length} cases)`)
summarize(rows)
