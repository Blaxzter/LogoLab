// Crispness A/B study harness (one-off, dev/test only).
//
// Goal: trace examples/test-files/Schild.png through the SAME pipeline the app
// uses, across a ladder of variants (baseline → +precision → +resolution → all
// fixes), and for each variant emit:
//   • <id>.svg              — the emitted SVG (exactly what the app would write)
//   • <id>.png              — that doc rasterized at 2048² (what you SEE scaled up)
//   • <id>.diff.png         — red/yellow heatmap of where it differs from the source
//   • a row of metrics      — geometry (paths / cubics / lines / sharp corners /
//                             coord precision) + fidelity (meanΔE / SSIM vs source)
//
// Everything is written to crispness-study/schild/ plus a REPORT.md, so the
// regressions are eyeball-able. Run:  node src/devtest/crispnessStudy.ts
//
// Honest caveat baked into the report: the app downscales in a browser canvas
// (bilinear, quality 'low'); this harness uses the repo's BOX downscale
// (traceGolden.downscale). For an exact 2x reduction (2048→1024) the two are
// close, but the harness baseline is if anything slightly CRISPER than the real
// app — so the real-world gap is at least as large as shown here.

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { ensureImageData, loadPng } from './nodeHarness.ts'
import { downscale, GOLDEN_CORPUS, caseAvailable, loadCase } from './traceGolden.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { serializeDoc } from '../lib/path/model.ts'
import { rasterizeDoc } from './raster.ts'
import { scoreDoc } from './scoreboard.ts'
import { encodePng } from './pngEncode.ts'
import type { EditableDoc } from '../lib/path/types.ts'
import type { VectorizeOptions } from '../types'
import { overWhite, resampleNearest, cropZoom, diffHeat, geomMetrics, type GeomMetrics } from './crispLib.ts'

ensureImageData()

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OUT = join(ROOT, 'crispness-study')
const OUT_SCHILD = join(OUT, 'schild')

const SOURCE = 'examples/test-files/Schild.png'
const RENDER_DIM = 2048 // every variant is rendered to this common size for fair compare

interface Variant {
  id: string
  label: string
  maxDim: number // long-side cap before tracing (the "downscale")
  precision: number // emit precision (decimals)
  smoothing: number // 0–100 dial
  lineCost: number // planar line/cubic balance (3.9 = original, 4.5 = de-facet)
  note: string
}

// The fix ladder. baseline reproduces the ORIGINAL app (1024 / 2dp / lineCost 3.9);
// each row adds one shipped fix so its isolated effect is visible.
const VARIANTS: Variant[] = [
  { id: '0-baseline', label: 'Baseline (original app)', maxDim: 1024, precision: 2, smoothing: 50, lineCost: 3.9, note: 'RASTER_MAX_DIM=1024, precision=2, lineCost=3.9' },
  { id: '1-fixB-prec3', label: '+ Fix B: precision 3', maxDim: 1024, precision: 3, smoothing: 50, lineCost: 3.9, note: 'precision only, still 1024' },
  { id: '2-fixA-2048', label: '+ Fix A: trace at 2048', maxDim: 2048, precision: 2, smoothing: 50, lineCost: 3.9, note: 'full-res trace' },
  { id: '3-fixAB-2048-p3', label: '+ Fix A+B: 2048 & precision 3', maxDim: 2048, precision: 3, smoothing: 50, lineCost: 3.9, note: 'resolution + precision' },
  { id: '4-fixABC-cubics', label: '+ Fix C: prefer cubics (lineCost 4.5)', maxDim: 2048, precision: 3, smoothing: 50, lineCost: 4.5, note: 'de-faceting — the shipped flat-art config' },
]

// ---------------------------------------------------------------------------
// doc transforms
// ---------------------------------------------------------------------------

/** Round every coordinate to `p` decimals (mirrors serializeDoc's quantization,
 *  so the rendered PNG reflects exactly the emitted SVG). In trace space. */
function roundDoc(doc: EditableDoc, p: number): EditableDoc {
  const r = (v: number) => Number(v.toFixed(p))
  const d = structuredClone(doc)
  for (const it of d.items) {
    if (it.kind !== 'path') continue
    for (const sp of it.subPaths)
      for (const nd of sp.nodes) {
        nd.x = r(nd.x); nd.y = r(nd.y)
        if (nd.hIn) { nd.hIn.x = r(nd.hIn.x); nd.hIn.y = r(nd.hIn.y) }
        if (nd.hOut) { nd.hOut.x = r(nd.hOut.x); nd.hOut.y = r(nd.hOut.y) }
      }
  }
  return d
}

/** Scale all geometry + viewBox by k (e.g. a 1024-viewBox doc → 2048 for render).
 *  Flat (gradients-off) docs have no gradient geometry, so only nodes scale. */
function scaleDoc(doc: EditableDoc, k: number): EditableDoc {
  if (k === 1) return doc
  const d = structuredClone(doc)
  d.viewBox = d.viewBox.map((v) => v * k) as [number, number, number, number]
  for (const it of d.items) {
    if (it.kind !== 'path') continue
    for (const sp of it.subPaths)
      for (const nd of sp.nodes) {
        nd.x *= k; nd.y *= k
        if (nd.hIn) { nd.hIn.x *= k; nd.hIn.y *= k }
        if (nd.hOut) { nd.hOut.x *= k; nd.hOut.y *= k }
      }
  }
  return d
}

// Telling regions (in 2048 space) to crop + zoom: the document's folded corner,
// the sharp bottom shield tip, and a rounded outer square corner.
const CROPS = [
  { name: 'fold', x: 980, y: 470, w: 420, h: 420 },
  { name: 'tip', x: 790, y: 1500, w: 420, h: 420 },
  { name: 'corner', x: 30, y: 30, w: 420, h: 420 },
]
const CROP_ZOOM = 3

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

interface Row {
  v: Variant
  bytes: number
  traceMs: number
  geom: GeomMetrics
  meanDeltaE: number
  ssim: number
  seamMax: number
  nodes: number
  pixelMeanDiff: number
}

async function main() {
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT_SCHILD, { recursive: true })

  // Source at full res, composited over white, as the comparison target.
  const srcImg = loadPng(SOURCE)
  const src2048 = resampleNearest(overWhite(srcImg.data, srcImg.width * srcImg.height), srcImg.width, srcImg.height, RENDER_DIM)
  writeFileSync(join(OUT_SCHILD, 'source.png'), encodePng(src2048, RENDER_DIM, RENDER_DIM))
  for (const c of CROPS) {
    const z = cropZoom(src2048, RENDER_DIM, c, CROP_ZOOM)
    writeFileSync(join(OUT_SCHILD, `source.crop-${c.name}.png`), encodePng(z.data, z.w, z.h))
  }
  const target = { width: RENDER_DIM, height: RENDER_DIM, data: src2048 }

  const rows: Row[] = []

  for (const v of VARIANTS) {
    const input = downscale(srcImg, v.maxDim)
    const opts: VectorizeOptions = {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: false,
      smoothing: v.smoothing,
      planarFit: { lineCost: v.lineCost },
    }

    const t0 = performance.now()
    const doc = await traceImage(input as unknown as ImageData, opts)
    const traceMs = performance.now() - t0

    // SVG exactly as the app would emit it.
    const svg = serializeDoc(roundDoc(doc, v.precision), v.precision)
    writeFileSync(join(OUT_SCHILD, `${v.id}.svg`), svg)

    // Render the (precision-quantized) doc at the common 2048 size.
    const docR = scaleDoc(roundDoc(doc, v.precision), RENDER_DIM / v.maxDim)
    const render = rasterizeDoc(docR, RENDER_DIM, RENDER_DIM)
    writeFileSync(join(OUT_SCHILD, `${v.id}.png`), encodePng(render, RENDER_DIM, RENDER_DIM))

    const { img: heat, mean: pixelMeanDiff } = diffHeat(render, src2048, RENDER_DIM * RENDER_DIM)
    writeFileSync(join(OUT_SCHILD, `${v.id}.diff.png`), encodePng(heat, RENDER_DIM, RENDER_DIM))

    for (const c of CROPS) {
      const z = cropZoom(render, RENDER_DIM, c, CROP_ZOOM)
      writeFileSync(join(OUT_SCHILD, `${v.id}.crop-${c.name}.png`), encodePng(z.data, z.w, z.h))
    }

    const score = scoreDoc(target, docR)
    const geom = geomMetrics(svg)

    rows.push({
      v,
      bytes: Buffer.byteLength(svg),
      traceMs,
      geom,
      meanDeltaE: score.meanDeltaE,
      ssim: score.ssim,
      seamMax: score.seamMax,
      nodes: score.nodes,
      pixelMeanDiff,
    })

    console.log(
      `${v.id.padEnd(18)} ${String(v.maxDim).padStart(4)}px p${v.precision} s${String(v.smoothing).padStart(2)} | ` +
      `paths=${String(geom.paths).padStart(2)} cubic=${String(geom.cubics).padStart(3)} line=${String(geom.lines).padStart(3)} ` +
      `sharp>60=${String(geom.sharp60).padStart(3)} | dec=${geom.avgDecimals.toFixed(2)} int%=${(geom.intFraction * 100).toFixed(0)} | ` +
      `ΔE=${score.meanDeltaE.toFixed(2)} ssim=${score.ssim.toFixed(4)} pxΔ=${pixelMeanDiff.toFixed(2)} | ` +
      `${(rows.at(-1)!.bytes / 1024).toFixed(1)}kB ${traceMs.toFixed(0)}ms`,
    )
  }

  // Geometry of the two reference tracings (parsed from the files; rendered
  // externally so no fidelity score here). Coordinate spaces differ — see report.
  const refs: { name: string; geom: GeomMetrics }[] = []
  for (const [name, path] of [
    ['Affinity (≈2048 space)', 'examples/test-files/SchildAffinity.svg'],
    ['LogoLabs shipped (1024)', 'examples/test-files/SchildLogoLabs.svg'],
  ] as const) {
    try {
      refs.push({ name, geom: geomMetrics(readFileSync(join(ROOT, path), 'utf8')) })
    } catch { /* file optional */ }
  }

  await renderCorpus()

  writeReport(rows, refs)
  writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(rows.map((r) => ({ ...r, v: undefined, variant: r.v })), null, 2) + '\n')
  console.log(`\nArtifacts in ${OUT}`)
}

/** Render every regression-corpus case (same maxDim + options the golden uses) to
 *  a PNG + diff heatmap, so the "regression thingy" leaves eyeball-able images. */
async function renderCorpus() {
  const dir = join(OUT, 'corpus')
  mkdirSync(dir, { recursive: true })
  console.log('\ncorpus renders:')
  for (const c of GOLDEN_CORPUS) {
    if (c.slow || !caseAvailable(c)) {
      console.log(`  ${c.name.padEnd(16)} ${c.slow ? 'SKIPPED (slow)' : 'SKIPPED (missing)'}`)
      continue
    }
    const img = loadCase(c)
    const n = img.width * img.height
    const doc = await traceImage(img as unknown as ImageData, c.options)
    const render = rasterizeDoc(doc, img.width, img.height)
    const srcW = overWhite(img.data, n)
    const { img: heat, mean } = diffHeat(render, srcW, n)
    writeFileSync(join(dir, `${c.name}.png`), encodePng(render, img.width, img.height))
    writeFileSync(join(dir, `${c.name}.source.png`), encodePng(srcW, img.width, img.height))
    writeFileSync(join(dir, `${c.name}.diff.png`), encodePng(heat, img.width, img.height))
    const s = scoreDoc({ width: img.width, height: img.height, data: srcW }, doc)
    console.log(`  ${c.name.padEnd(16)} ${img.width}x${img.height} grad=${c.options.gradients !== false ? 'on ' : 'off'} paths=${String(s.paths).padStart(3)} nodes=${String(s.nodes).padStart(5)} ΔE=${s.meanDeltaE.toFixed(2)} ssim=${s.ssim.toFixed(4)} pxΔ=${mean.toFixed(2)}`)
  }
}

function writeReport(rows: Row[], refs: { name: string; geom: GeomMetrics }[]) {
  const base = rows[0]
  const pct = (cur: number, b: number) => (b === 0 ? '—' : `${cur >= b ? '+' : ''}${(((cur - b) / b) * 100).toFixed(0)}%`)
  const lines: string[] = []
  lines.push('# Crispness study — Schild.png\n')
  lines.push('Source: `examples/test-files/Schild.png` (2048×2048). Every variant is rendered to 2048² and compared to the source.\n')
  lines.push('Reference tracings for eyeballing: `examples/test-files/SchildAffinity.svg` (Affinity, effective 2048 + 3dp) and `examples/test-files/SchildLogoLabs.svg` (the shipped LogoLabs output).\n')
  lines.push('> Note: the app downscales in a browser canvas (bilinear, quality "low"); this harness uses a BOX downscale, so the baseline here is if anything *slightly crisper* than the real app. The real gap is at least this large.\n')
  lines.push('## Metrics\n')
  lines.push('| variant | trace px | prec | smooth | paths | cubics | lines | sharp>60° | sharp>100° | avg dec | int% | meanΔE↓ | SSIM↑ | pixelΔ↓ | nodes | svg kB | ms |')
  lines.push('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|')
  for (const r of rows) {
    lines.push(
      `| **${r.v.label}** | ${r.v.maxDim} | ${r.v.precision} | ${r.v.smoothing} | ${r.geom.paths} | ${r.geom.cubics} | ${r.geom.lines} | ${r.geom.sharp60} | ${r.geom.sharp100} | ${r.geom.avgDecimals.toFixed(2)} | ${(r.geom.intFraction * 100).toFixed(0)}% | ${r.meanDeltaE.toFixed(3)} | ${r.ssim.toFixed(4)} | ${r.pixelMeanDiff.toFixed(2)} | ${r.nodes} | ${(r.bytes / 1024).toFixed(1)} | ${r.traceMs.toFixed(0)} |`,
    )
  }
  lines.push('\n_↓ lower is better, ↑ higher is better. meanΔE/SSIM/pixelΔ are vs the 2048 source._\n')
  lines.push('## vs baseline\n')
  lines.push('| variant | meanΔE | SSIM | lines (faceting) | sharp>60° |')
  lines.push('|---|--:|--:|--:|--:|')
  for (const r of rows) {
    lines.push(
      `| ${r.v.label} | ${pct(r.meanDeltaE, base.meanDeltaE)} | ${(r.ssim - base.ssim >= 0 ? '+' : '') + (r.ssim - base.ssim).toFixed(4)} | ${pct(r.geom.lines, base.geom.lines)} | ${pct(r.geom.sharp60, base.geom.sharp60)} |`,
    )
  }
  if (refs.length) {
    lines.push('\n## Reference tracings (geometry only)\n')
    lines.push('Parsed from the SVG files for an apples-to-apples geometry profile. Counts (cubics/lines/sharp corners) are coordinate-space invariant; "avg dec" is space-relative (Affinity ≈2048 space, LogoLabs 1024, so a like-for-like decimal compares to our matching variant).\n')
    lines.push('| tracing | paths | cubics | lines | sharp>60° | sharp>100° | avg dec | int% |')
    lines.push('|---|--:|--:|--:|--:|--:|--:|--:|')
    for (const r of refs) {
      lines.push(`| ${r.name} | ${r.geom.paths} | ${r.geom.cubics} | ${r.geom.lines} | ${r.geom.sharp60} | ${r.geom.sharp100} | ${r.geom.avgDecimals.toFixed(2)} | ${(r.geom.intFraction * 100).toFixed(0)}% |`)
    }
    lines.push('')
  }
  lines.push('\n## Images\n')
  lines.push('Open these side by side (source first):\n')
  lines.push('| variant | trace (2048) | diff vs source |')
  lines.push('|---|---|---|')
  lines.push('| source | ![src](schild/source.png) | — |')
  for (const r of rows) {
    lines.push(`| ${r.v.label} | ![t](schild/${r.v.id}.png) | ![d](schild/${r.v.id}.diff.png) |`)
  }
  lines.push('')
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
}

await main()
