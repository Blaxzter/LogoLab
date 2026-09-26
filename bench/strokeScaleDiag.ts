// MONO ENLARGEMENT CENSUS — what `monoTraceScale` (src/lib/traceCaps.ts) decides on
// real marks, and what the decision buys.
//
//   node bench/strokeScaleDiag.ts                      # gallery @256 + @512
//   … --res 256,512          rasters to test (long side)
//   … --logos a,b            only these gallery marks (file stems)
//   … --limit N              first N gallery marks
//   … --png a.png,b.png      extra rasters at their native size (e.g. the sheet-music page)
//   … --sheets               the four example icon sheets, split into tiles at 2048 and 1024
//   … --sheet-res 2048,1024  sheet long sides for that lane
//   … --quantiles 0.05,0.1,0.15,0.5   thickness quantiles to print
//   … --no-trace             decisions only (fast)
//
// Each mono mark is traced twice — at native and at the factor the policy picks —
// and BOTH traces are rendered back at the native size (rasterizeDoc with
// scale 1/k; render enlarged into a native buffer and it crops) and scored against
// the source with the product's own scorer (`fidelity`: mean ΔE, SSIM). Nodes and
// time ride along. The rows are the evidence; the summary counts.

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ensureImageData } from './nodeHarness.ts'
import { loadSource, rasterizeSource, renderSvg } from '../src/mcp/image.ts'
import { decideInkMode, type ImageDataLike } from '../src/lib/ink.ts'
import { inkThickness, thicknessAt } from '../src/lib/strokeWidth.ts'
import { monoTraceScale } from '../src/lib/traceCaps.ts'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../src/lib/trace/index.ts'
import { cropTile, downscaleImageData, toImageData, upscaleImageData } from '../src/lib/sheet/crop.ts'
import { detectSheetIcons } from '../src/lib/sheet/detect.ts'
import { repaintDoc } from '../src/lib/sheet/traceTile.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { fidelity } from '../src/lib/render/fidelity.ts'
import { docStats } from '../src/lib/path/model.ts'
import type { VectorizeOptions } from '../src/types'

ensureImageData()

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? '') : null
}
const RES = (arg('res') ?? '256,512').split(',').map(Number)
const ONLY = arg('logos')?.split(',').filter(Boolean) ?? null
const LIMIT = arg('limit') ? Number(arg('limit')) : Infinity
const PNGS = arg('png')?.split(',').filter(Boolean) ?? []
const QUANTILES = (arg('quantiles') ?? '0.05,0.1,0.15,0.5').split(',').map(Number)
const TRACE = !process.argv.includes('--no-trace')
const SHEETS = process.argv.includes('--sheets')
const SHEET_RES = (arg('sheet-res') ?? '2048,1024').split(',').map(Number)

interface Row {
  name: string
  res: number
  w: number
  h: number
  thickness: number[]
  scale: number
  by: string
  native?: Score
  scaled?: Score
}
interface Score {
  meanDeltaE: number
  ssim: number
  nodes: number
  ms: number
}

async function scoreTrace(px: ImageDataLike, opts: VectorizeOptions, k: number, recolor: string | null): Promise<Score> {
  const t0 = Date.now()
  const input = k > 1 ? upscaleImageData(px, k) : px
  const traced = await traceImage(toImageData(input), opts)
  // A mono trace comes back black; the product repaints it with the probed ink.
  const doc = recolor ? repaintDoc(traced, recolor) : traced
  const ms = Date.now() - t0
  const render = rasterizeDoc(doc, px.width, px.height, { scale: 1 / k })
  const f = fidelity(px.data, render, px.width, px.height)
  return { meanDeltaE: f.meanDeltaE, ssim: f.ssim, nodes: docStats(doc).nodes, ms }
}

async function census(name: string, res: number, px: ImageDataLike, rows: Row[], tally: Record<string, number>): Promise<void> {
  const ink = decideInkMode(px, 128, { colorMode: 'auto' })
  if (ink.mode !== 'mono') {
    tally.colour = (tally.colour ?? 0) + 1
    return
  }
  const opts: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'mono', threshold: ink.threshold, invert: ink.invert }
  const t = inkThickness(px, opts.threshold, opts.invert === true)
  const plan = monoTraceScale(px, opts)
  const row: Row = {
    name,
    res,
    w: px.width,
    h: px.height,
    thickness: t ? QUANTILES.map((q) => thicknessAt(t.histogram, t.inkPixels, q)) : [],
    scale: plan.scale,
    by: plan.by,
  }
  tally[`x${plan.scale}`] = (tally[`x${plan.scale}`] ?? 0) + 1
  if (TRACE) {
    row.native = await scoreTrace(px, opts, 1, ink.recolor)
    if (plan.scale > 1) row.scaled = await scoreTrace(px, opts, plan.scale, ink.recolor)
  }
  rows.push(row)
  const f = (s?: Score) => (s ? `ΔE ${s.meanDeltaE.toFixed(2)} ssim ${s.ssim.toFixed(3)} ${String(s.nodes).padStart(5)}n ${String(s.ms).padStart(5)}ms` : '—')
  process.stdout.write(
    `${name.padEnd(28)} @${String(res).padStart(4)} ${String(px.width).padStart(4)}×${String(px.height).padEnd(4)} ` +
      `t[${row.thickness.join('/')}] ×${plan.scale} ${plan.by.padEnd(6)} | native ${f(row.native)} | scaled ${f(row.scaled)}\n`,
  )
}

const rows: Row[] = []
const tally: Record<string, number> = {}

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
files = files.slice(0, LIMIT)

for (const file of files) {
  const text = readFileSync(join(dir, file), 'utf8')
  for (const res of RES) {
    let px: ImageDataLike
    try {
      px = renderSvg(text, res, '#ffffff')
    } catch (e) {
      process.stdout.write(`${file}: render failed (${(e as Error).message})\n`)
      continue
    }
    await census(file.replace(/\.svg$/, ''), res, px, rows, tally)
  }
}
for (const p of PNGS) {
  const src = loadSource(p)
  const px = await rasterizeSource(src, 8192)
  await census(basename(p), Math.max(px.width, px.height), px, rows, tally)
}

// The icon-sheet lane: the four example sheets split by the production detector,
// each icon tile through the same census — at the sheet's native 2048 and at 1024
// (the size /sheet looked bad at, where the sheet's own ×3 rule was measured).
if (SHEETS) {
  const sheetsDir = join(process.cwd(), 'public', 'examples', 'sheets')
  for (const file of readdirSync(sheetsDir).filter((f) => f.endsWith('.webp')).sort()) {
    const full = await rasterizeSource(loadSource(join(sheetsDir, file)), 8192)
    for (const res of SHEET_RES) {
      const sheet = downscaleImageData(full, res)
      const det = detectSheetIcons(sheet)
      const icons = det.tiles.filter((t) => t.kind === 'icon')
      let n = 0
      for (const tile of icons) {
        n++
        const px = cropTile(sheet, tile.box, det.background)
        await census(`${file.replace(/\.webp$/, '')}#${String(n).padStart(2, '0')}`, res, px, rows, tally)
      }
    }
  }
}

// ------------------------------------------------------------------ summary
const scaled = rows.filter((r) => r.native && r.scaled)
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
process.stdout.write(`\ndecisions: ${Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join('  ')}  (mono rows ${rows.length})\n`)
if (scaled.length) {
  const de = (r: Row) => r.scaled!.meanDeltaE - r.native!.meanDeltaE
  const ss = (r: Row) => r.scaled!.ssim - r.native!.ssim
  const better = scaled.filter((r) => de(r) < -0.005).length
  const worse = scaled.filter((r) => de(r) > 0.005).length
  process.stdout.write(
    `enlarged rows ${scaled.length}: ΔE better ${better} / worse ${worse} / wash ${scaled.length - better - worse}; ` +
      `mean ΔE ${mean(scaled.map((r) => r.native!.meanDeltaE)).toFixed(3)} → ${mean(scaled.map((r) => r.scaled!.meanDeltaE)).toFixed(3)}, ` +
      `SSIM ${mean(scaled.map((r) => r.native!.ssim)).toFixed(4)} → ${mean(scaled.map((r) => r.scaled!.ssim)).toFixed(4)}, ` +
      `nodes ×${mean(scaled.map((r) => r.scaled!.nodes / Math.max(1, r.native!.nodes))).toFixed(2)}, ` +
      `time ×${mean(scaled.map((r) => r.scaled!.ms / Math.max(1, r.native!.ms))).toFixed(2)}\n`,
  )
  const worst = [...scaled].sort((a, b) => de(b) - de(a)).slice(0, 5)
  process.stdout.write(`worst by ΔE: ${worst.map((r) => `${r.name}@${r.res} ${de(r) >= 0 ? '+' : ''}${de(r).toFixed(3)} (ssim ${ss(r) >= 0 ? '+' : ''}${ss(r).toFixed(3)})`).join(', ')}\n`)
}
