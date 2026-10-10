// Centreline tracer diagnostic: trace the line-art corpus (public/examples/line-art/)
// as strokes, score each case against its authored centrelines, and render a contact
// strip per case for the eye — source | stroked trace | centreline wire over the source
// | fills and strokes tinted apart.
//
//   node bench/centerlineDiag.ts [--res 2048] [--only la-junctions,lucide-house] [--png]
//   node bench/centerlineDiag.ts --res 256,512 --json         # one row per case × res
//
// Writes PNGs to crispness-study/centerline/ (gitignored). The table is the same
// scorer test/centerline-gate.test.ts gates on (bench/centerlineScore.ts). In the
// third panel, orange rings are authored centreline the trace's ink does not cover
// (the "missed" column) and green rings are traced samples more than 1.5 px off their
// authored centreline (the "ctr" columns) — where a number comes from, not just what.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { serializeDoc, subPathsToD } from '../src/lib/path/model.ts'
import { isPaper } from '../src/lib/path/paper.ts'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../src/lib/trace/index.ts'
import { decideInkMode } from '../src/lib/traceInput/ink.ts'
import { ensureImageData } from './nodeHarness.ts'
import { AB_LINE_ART_CASES as LINE_ART_CASES } from './abCorpus.ts'
import { centerlineTol, scoreCenterline, type CenterlineScore } from './centerlineScore.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const arg = (name: string): string | null => (argv.includes(name) ? (argv[argv.indexOf(name) + 1] ?? '') : null)
const resList = (arg('--res') ?? '512,2048').split(',').map(Number)
const only = arg('--only')
  ?.split(',')
  .map((s) => s.trim())
const wantPng = argv.includes('--png') || !argv.includes('--json')
const json = argv.includes('--json')
const outDir = join(root, 'crispness-study', 'centerline')
mkdirSync(outDir, { recursive: true })

const cases = LINE_ART_CASES.filter((c) => !only || only.includes(c.id))
const rows: (CenterlineScore & { id: string; res: number; ms: number; nodes: number; paths: number })[] = []

for (const c of cases) {
  const svg = readFileSync(join(root, c.path), 'utf8')
  for (const res of resList) {
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng()
    const img = decodePng(png)
    const plan = decideInkMode(img, 128, { colorMode: 'mono' })
    const opts = {
      ...DEFAULT_VECTORIZE_OPTIONS,
      mode: 'mono' as const,
      centerline: true,
      threshold: plan.threshold,
      invert: plan.invert,
    }
    const t0 = performance.now()
    const doc = await traceImage(img as unknown as ImageData, opts)
    const ms = performance.now() - t0
    const score = scoreCenterline(svg, doc, img, centerlineTol(res))
    let nodes = 0
    let paths = 0
    for (const it of doc.items)
      if (it.kind === 'path') {
        paths++
        for (const sp of it.subPaths) nodes += sp.nodes.length
      }
    rows.push({ id: c.id, res, ms, nodes, paths, ...score })

    if (wantPng) {
      const traced = serializeDoc(doc, 2)
      const tracedPng = new Resvg(traced, { fitTo: { mode: 'width', value: res }, background: 'white' })
        .render()
        .asPng()
      // Wire: centrelines in magenta over the faded source; fills in blue.
      let wire = ''
      for (const it of doc.items) {
        if (it.kind !== 'path' || isPaper(it)) continue
        const d = subPathsToD(it.subPaths, 2)
        if (it.stroke && it.fill === 'none') {
          wire += `<path d="${d}" fill="none" stroke="#e11d48" stroke-width="1.5" stroke-linecap="round"/>`
          for (const sp of it.subPaths)
            for (const nd of sp.nodes)
              wire += `<circle cx="${nd.x.toFixed(1)}" cy="${nd.y.toFixed(1)}" r="2" fill="${nd.kind === 'corner' ? '#0f172a' : '#e11d48'}"/>`
        } else {
          wire += `<path d="${d}" fill="#2563eb" fill-opacity="0.45"/>`
        }
      }
      // Where the score is lost: missed authored samples in orange, off-centre traced
      // samples in green (radius grows with the error).
      for (const m of score.missedPts)
        wire += `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${Math.min(6, 1.5 + m.d / 4).toFixed(1)}" fill="none" stroke="#f97316" stroke-width="1"/>`
      for (const t of score.turnPts)
        wire += `<rect x="${(t.x - 5).toFixed(1)}" y="${(t.y - 5).toFixed(1)}" width="10" height="10" fill="none" stroke="#7c3aed" stroke-width="1.5"/>`
      for (const o of score.offPts)
        wire += `<circle cx="${o.x.toFixed(1)}" cy="${o.y.toFixed(1)}" r="${Math.min(6, 1 + o.d / 2).toFixed(1)}" fill="none" stroke="#16a34a" stroke-width="1"/>`
      const overlay = `<svg xmlns="http://www.w3.org/2000/svg" width="${res}" height="${res}" viewBox="0 0 ${res} ${res}"><rect width="${res}" height="${res}" fill="white"/><image href="data:image/png;base64,${Buffer.from(png).toString('base64')}" width="${res}" height="${res}" opacity="0.25"/>${wire}</svg>`
      const overlayPng = new Resvg(overlay, { fitTo: { mode: 'width', value: res } }).render().asPng()
      // Strip: three panels side by side.
      const strip =
        `<svg xmlns="http://www.w3.org/2000/svg" width="${res * 3 + 16}" height="${res}"><rect width="100%" height="100%" fill="#ddd"/>` +
        `<image href="data:image/png;base64,${Buffer.from(png).toString('base64')}" x="0" width="${res}" height="${res}"/>` +
        `<image href="data:image/png;base64,${Buffer.from(tracedPng).toString('base64')}" x="${res + 8}" width="${res}" height="${res}"/>` +
        `<image href="data:image/png;base64,${Buffer.from(overlayPng).toString('base64')}" x="${2 * res + 16}" width="${res}" height="${res}"/></svg>`
      writeFileSync(join(outDir, `${c.id}@${res}.png`), new Resvg(strip).render().asPng())
      writeFileSync(join(outDir, `${c.id}@${res}.svg`), traced)
    }
  }
}

if (json) {
  console.log(JSON.stringify(rows, null, 1))
} else {
  const f = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : '—')
  console.log(
    'case'.padEnd(22) +
      'res'.padStart(5) +
      'ms'.padStart(7) +
      'paths'.padStart(6) +
      'nodes'.padStart(6) +
      '  W̃trace/auth'.padEnd(14) +
      'ctr mean'.padStart(9) +
      'ctr p95'.padStart(8) +
      'missed'.padStart(7) +
      'width%'.padStart(8) +
      'ends Δ'.padStart(7) +
      'paths Δ'.padStart(8) +
      'turns'.padStart(6) +
      'fillIoU'.padStart(8) +
      'ΔE'.padStart(6) +
      '  gate',
  )
  for (const r of rows) {
    console.log(
      r.id.padEnd(22) +
        String(r.res).padStart(5) +
        f(r.ms, 0).padStart(7) +
        String(r.paths).padStart(6) +
        String(r.nodes).padStart(6) +
        `  ${f(r.widthTraced, 1)}/${f(r.widthAuthored, 1)}`.padEnd(14) +
        f(r.centreMean).padStart(9) +
        f(r.centreP95).padStart(8) +
        f(r.missedMean).padStart(7) +
        f(r.widthErr * 100, 0).padStart(8) +
        String(r.endsDelta).padStart(7) +
        String(r.pathsDelta).padStart(8) +
        String(r.turns).padStart(6) +
        f(r.fillIoU).padStart(8) +
        f(r.deltaE).padStart(6) +
        '  ' +
        (r.failures.length ? r.failures.join(', ') : 'ok'),
    )
  }
}
