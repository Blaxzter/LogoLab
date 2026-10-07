// Centreline tracer on REAL icon sheets: the field-report witness, headless.
//
//   node bench/centerlineSheetDiag.ts <sheet.png|jpg|fixture.svg> [more…] [--grid 2x4]
//        [--only 5,6] [--out dir] [--look 5:x,y,w,h[:z]] [--near x,y,r] [--stubs [--thin]]
//        [--res 512] [--json]
//
// Each sheet is split exactly as `split_icon_sheet` does it (detect → crop → plan → the
// mono upscale → trace with `strokes`), and every tile's trace is written beside a contact
// strip — crop | trace | wire over the crop (strokes red, fills blue, nodes dark). A
// line-art fixture (.svg) is one tile, rasterized at `--res` on white as the gate does. The
// table is the census docs/vectorization-benchmarks.md §39.8 is built on, per tile:
//
//   W        the picture's stroke width (px at trace resolution)
//   strokes  stroked paths, and how many of them two micro-stub rules flag:
//            `abs` — bounding-box span under 2 W (the first census's absolute rule; dashes
//            and dots read here), `rel` — thinner than 0.6 of the widest stroke its ink
//            touches AND shorter than that width (`--thin` drops the length bar, to list
//            every thin stroke that touches a thicker one; `--stubs` prints them)
//   fills    filled paths, and the share of the ink they paint
//   junc     junctions the assembly placed
//
// `--look t:x,y,w,h` renders tile t's window (trace px) at zoom z (default 6) with the
// skeleton chains, the junction nodes and their radii (welded ones violet), each arm's
// line (green, grey when unreadable), the meets (red) and the final strokes — the place to
// see what a junction did. `--near x,y,r` prints every stroke run within r of a point:
// its end nodes, length and widths. `--json` dumps the rows.
//
// The sheets are not in the repo (the field report's were Gemini output); point it at
// any directory of them. Writes to crispness-study/centerline-sheets/ (gitignored).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { encodePng } from '../src/lib/png/encode.ts'
import { serializeDoc, subPathsToD } from '../src/lib/path/model.ts'
import type { EditableDoc, PathItem, Vec } from '../src/lib/path/types.ts'
import { cropTile, downscaleImageData } from '../src/lib/sheet/crop.ts'
import { planTileTrace, tileTraceInput } from '../src/lib/sheet/traceTile.ts'
import type { ImageDataLike } from '../src/lib/sheet/types'
import {
  beautifyOptionsFor,
  DEFAULT_VECTORIZE_OPTIONS,
  planarFitOptionsFor,
  traceImage,
} from '../src/lib/trace/index.ts'
import { traceCenterline, type CenterlineStages } from '../src/lib/trace/centerline/index.ts'
import type { JunctionDiag } from '../src/lib/trace/centerline/assemble.ts'
import { monoLabels } from '../src/lib/trace/mono.ts'
import { decideInkMode } from '../src/lib/traceInput/ink.ts'
import { rasterCapFor } from '../src/lib/traceInput/traceCaps.ts'
import type { VectorizeOptions } from '../src/types.ts'
import { loadSource } from '../src/mcp/image.ts'
import { detectSheet } from '../src/mcp/sheet.ts'
import { baseOptions } from '../src/mcp/trace.ts'
import { ensureImageData } from './nodeHarness.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flagged = new Set(['--grid', '--only', '--out', '--look', '--res', '--near'])
const flag = (n: string): string | null => (argv.includes(n) ? (argv[argv.indexOf(n) + 1] ?? '') : null)
const sheets = argv.filter((a, i) => !a.startsWith('--') && !flagged.has(argv[i - 1]))
const gridArg = flag('--grid')
const grid = gridArg ? { rows: Number(gridArg.split('x')[0]), cols: Number(gridArg.split('x')[1]) } : undefined
const only = flag('--only')?.split(',').map(Number) ?? null
const outDir = flag('--out') ?? join(root, 'crispness-study', 'centerline-sheets')
const json = argv.includes('--json')
const looks = argv
  .map((a, i) => (argv[i - 1] === '--look' ? a : null))
  .filter((a): a is string => a !== null)
  .map((a) => {
    const [t, box, z] = a.split(':')
    const [x, y, w, h] = box.split(',').map(Number)
    return { tile: Number(t), x, y, w, h, z: Number(z ?? 6) }
  })
mkdirSync(outDir, { recursive: true })

export interface StubCensus {
  strokes: number
  abs: number
  rel: number
  /** The rel-flagged strokes: length, width, and the width of what they touch. */
  relList: { len: number; w: number; nw: number; at: string }[]
}

const polyLen = (pts: Vec[]): number => {
  let L = 0
  for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y)
  return L
}

/** Flattened stroke centrelines of a doc (cubics sampled), with their widths. */
function strokeLines(doc: EditableDoc): { pts: Vec[]; w: number }[] {
  const out: { pts: Vec[]; w: number }[] = []
  for (const it of doc.items) {
    if (it.kind !== 'path' || !it.stroke || it.fill !== 'none') continue
    for (const sp of it.subPaths) {
      const pts: Vec[] = []
      const n = sp.nodes.length
      const segs = sp.closed ? n : n - 1
      for (let i = 0; i < segs; i++) {
        const a = sp.nodes[i]
        const b = sp.nodes[(i + 1) % n]
        const c1 = a.hOut ?? a
        const c2 = b.hIn ?? b
        for (let t = 0; t < 8; t++) {
          const s = t / 8
          const u = 1 - s
          pts.push({
            x: u * u * u * a.x + 3 * u * u * s * c1.x + 3 * u * s * s * c2.x + s * s * s * b.x,
            y: u * u * u * a.y + 3 * u * u * s * c1.y + 3 * u * s * s * c2.y + s * s * s * b.y,
          })
        }
      }
      const last = sp.closed ? sp.nodes[0] : sp.nodes[n - 1]
      if (last) pts.push({ x: last.x, y: last.y })
      out.push({ pts, w: it.stroke.width })
    }
  }
  return out
}

/** Both micro-stub rules over a traced doc. */
export function stubCensus(doc: EditableDoc): StubCensus {
  const lines = strokeLines(doc)
  let abs = 0
  let rel = 0
  const relList: StubCensus['relList'] = []
  const near = (p: Vec, q: { pts: Vec[] }, d: number): boolean => q.pts.some((r) => Math.hypot(r.x - p.x, r.y - p.y) <= d)
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const p of L.pts) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
    if (Math.max(x1 - x0, y1 - y0) < 2 * L.w) abs++
    // Touching strokes: any of this one's points within the two half-widths of the other's.
    let nw = 0
    for (let j = 0; j < lines.length; j++) {
      if (j === i) continue
      const M = lines[j]
      if (L.pts.some((p) => near(p, M, (L.w + M.w) / 2 + 1))) nw = Math.max(nw, M.w)
    }
    const len = polyLen(L.pts)
    if (nw > 0 && L.w < 0.6 * nw && (len < nw || argv.includes('--thin'))) {
      rel++
      relList.push({ len: Math.round(len * 10) / 10, w: L.w, nw, at: `${L.pts[0].x.toFixed(0)},${L.pts[0].y.toFixed(0)}` })
    }
  }
  return { strokes: lines.length, abs, rel, relList }
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const pngOf = (img: ImageDataLike): Uint8Array => encodePng(img.data, img.width, img.height)

function wireOf(doc: EditableDoc, k: number): string {
  let wire = ''
  for (const it of doc.items as PathItem[]) {
    if (it.kind !== 'path' || it.id === 'paper') continue
    const d = subPathsToD(it.subPaths, 2)
    const stroke = it.stroke && it.fill === 'none'
    wire += stroke
      ? `<path d="${d}" fill="none" stroke="#e11d48" stroke-width="${1.5 * k}" stroke-linecap="round"/>`
      : `<path d="${d}" fill="#2563eb" fill-opacity="0.45"/>`
    for (const sp of it.subPaths)
      for (const nd of sp.nodes)
        wire += `<circle cx="${nd.x.toFixed(2)}" cy="${nd.y.toFixed(2)}" r="${(2.2 * k).toFixed(2)}" fill="${stroke ? '#0f172a' : '#1d4ed8'}"/>`
  }
  return wire
}

function strip(input: ImageDataLike, doc: EditableDoc, S: number): Uint8Array {
  const src = pngOf(input)
  const vb = doc.viewBox
  const traced = new Resvg(serializeDoc(doc, 2), { fitTo: { mode: 'width', value: S }, background: 'white' })
    .render()
    .asPng()
  const k = vb[2] / S
  const ov = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="${vb.join(' ')}"><rect width="${vb[2]}" height="${vb[3]}" fill="white"/><image href="data:image/png;base64,${b64(src)}" width="${vb[2]}" height="${vb[3]}" opacity="0.3"/>${wireOf(doc, k)}</svg>`
  const ovPng = new Resvg(ov, { fitTo: { mode: 'width', value: S } }).render().asPng()
  const sv =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S * 3 + 16}" height="${S}"><rect width="100%" height="100%" fill="#ddd"/>` +
    `<image href="data:image/png;base64,${b64(src)}" width="${S}" height="${S}"/>` +
    `<image href="data:image/png;base64,${b64(traced)}" x="${S + 8}" width="${S}" height="${S}"/>` +
    `<image href="data:image/png;base64,${b64(ovPng)}" x="${2 * S + 16}" width="${S}" height="${S}"/></svg>`
  return new Resvg(sv).render().asPng()
}

/** A zoomed window with the engine's intermediate stages drawn over the source. */
function look(
  input: ImageDataLike,
  doc: EditableDoc,
  st: CenterlineStages,
  junctions: JunctionDiag[],
  win: { x: number; y: number; w: number; h: number; z: number },
): Uint8Array {
  const { x, y, w, h, z } = win
  const W = input.width
  const src = pngOf(input)
  const hues = ['#f59e0b', '#10b981', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16', '#ec4899', '#0ea5e9']
  let body = `<image href="data:image/png;base64,${b64(src)}" width="${input.width}" height="${input.height}" opacity="0.35" style="image-rendering:pixelated"/>`
  // Fill mask.
  if (st.split.blobMask)
    for (let py = y; py < y + h; py++)
      for (let px = x; px < x + w; px++)
        if (st.split.blobMask[py * W + px]) body += `<rect x="${px}" y="${py}" width="1" height="1" fill="#2563eb" opacity="0.25"/>`
  // Skeleton chains, one hue each.
  st.graph.chains.forEach((c, i) => {
    if (!c.alive) return
    for (const p of c.pixels) {
      const px = p % W
      const py = (p / W) | 0
      if (px < x - 1 || py < y - 1 || px > x + w || py > y + h) continue
      body += `<rect x="${px + 0.3}" y="${py + 0.3}" width="0.4" height="0.4" fill="${hues[i % hues.length]}"/>`
    }
  })
  // Nodes and their radii.
  for (const n of st.graph.nodes) {
    if (!n.alive) continue
    body += `<circle cx="${n.x + 0.5}" cy="${n.y + 0.5}" r="${n.r}" fill="none" stroke="${n.welded ? '#7c3aed' : '#475569'}" stroke-width="0.15"/>`
    body += `<text x="${n.x + 0.5 + 0.6}" y="${n.y + 0.5 - 0.6}" font-size="1.6" fill="#334155">${n.id}</text>`
  }
  // Junction meets, and every arm's line.
  for (const j of junctions) {
    body += `<circle cx="${j.meet.x}" cy="${j.meet.y}" r="0.6" fill="#dc2626"/>`
    for (const a of j.arms)
      body += `<line x1="${a.at.x}" y1="${a.at.y}" x2="${a.at.x + a.dir.x * 6}" y2="${a.at.y + a.dir.y * 6}" stroke="${a.ok ? '#16a34a' : '#a3a3a3'}" stroke-width="0.2"/>`
  }
  // Final strokes and nodes.
  body += wireOf(doc, 0.2).replaceAll('fill-opacity="0.45"', 'fill-opacity="0.15"')
  const sv = `<svg xmlns="http://www.w3.org/2000/svg" width="${w * z}" height="${h * z}" viewBox="${x} ${y} ${w} ${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>${body}</svg>`
  return new Resvg(sv, { fitTo: { mode: 'width', value: w * z } }).render().asPng()
}

interface Row {
  sheet: string
  tile: number
  row: number
  col: number
  res: number
  W: number
  strokes: number
  abs: number
  rel: number
  fills: number
  fillShare: number
  junctions: number
  nodes: number
}
const rows: Row[] = []

/** One tile to trace: the pixels, the options, where it sat on its sheet. */
interface Job {
  stem: string
  n: number
  row: number
  col: number
  input: ImageDataLike
  opts: VectorizeOptions
}

/** A line-art fixture (.svg): rasterized on white at `--res` and traced as the gate does. */
function fixtureJob(svgPath: string): Job {
  const res = Number(flag('--res') ?? 512)
  const svg = readFileSync(svgPath, 'utf8')
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const plan = decideInkMode(img, 128, { colorMode: 'mono' })
  const opts = { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'mono' as const, centerline: true, threshold: plan.threshold, invert: plan.invert }
  return { stem: basename(svgPath, '.svg'), n: 1, row: 0, col: 0, input: img, opts }
}

async function sheetJobs(sheetPath: string): Promise<Job[]> {
  const src = loadSource(sheetPath)
  const { image, detection } = await detectSheet(src, { detect: grid ? { grid } : {} })
  const background = detection.background
  const fill =
    background && !background.transparent ? { r: background.r, g: background.g, b: background.b, a: 255 } : null
  const base = baseOptions({ strokes: true, removeBackground: true })
  const tiles = detection.tiles.filter((t) => t.kind === 'icon')
  const stem = basename(sheetPath).replace(/\.[^.]+$/, '').replace(/^Gemini_Generated_Image_/, '').slice(0, 6)
  const jobs: Job[] = []
  for (let i = 0; i < tiles.length; i++) {
    const n = i + 1
    if (only && !only.includes(n)) continue
    const tile = tiles[i]
    const pixels = cropTile(image, tile.box, fill)
    const plan = planTileTrace(pixels, base, { colorMode: 'auto', gradientMode: 'auto', background })
    if (plan.opts.mode !== 'mono') continue
    const input = downscaleImageData(tileTraceInput(pixels, plan.scale), rasterCapFor(plan.opts))
    jobs.push({ stem, n, row: tile.row, col: tile.col, input, opts: plan.opts })
  }
  return jobs
}

for (const sheetPath of sheets) {
  const jobs = sheetPath.endsWith('.svg') ? [fixtureJob(sheetPath)] : await sheetJobs(sheetPath)
  for (const { stem, n, row, col, input, opts } of jobs) {
    const doc = await traceImage(input as unknown as ImageData, opts)
    // The same engine once more, with the diagnostic sinks attached (fills skipped).
    const despeckle = Math.max(0, Math.min(100, opts.despeckle))
    const seg = monoLabels(input, opts.threshold, opts.invert === true, Math.max(1, Math.round((despeckle / 100) ** 2 * 64)))
    let stages: CenterlineStages | null = null
    const junctions: JunctionDiag[] = []
    const diag = traceCenterline({
      seg,
      width: input.width,
      height: input.height,
      fitOpts: planarFitOptionsFor(opts),
      fidelity: beautifyOptionsFor(opts).fidelity,
      traceFills: () => ({ items: [] }),
      onJunction: (j) => junctions.push(j),
      onStages: (s) => {
        stages = s
      },
    })
    const stubs = stubCensus(doc)
    const near = flag('--near')
    if (near && stages) {
      const [nx, ny, nr] = near.split(',').map(Number)
      const st = stages as CenterlineStages
      for (const r of st.runs) {
        const d = Math.min(...r.pts.map((p) => Math.hypot(p.x - nx, p.y - ny)))
        if (d > nr) continue
        const ws = Array.from(r.w).filter(Number.isFinite)
        const len = polyLen(r.pts)
        const node = (id: number): string => (id < 0 ? 'free' : `n${id}(r${st.graph.nodes[id].r.toFixed(1)}${st.graph.nodes[id].welded ? ',w' : ''})`)
        console.log(`  run ${node(r.a)}→${node(r.b)} len ${len.toFixed(1)} pts ${r.pts.length} w̃ ${ws.length ? ws.sort((a, b) => a - b)[ws.length >> 1].toFixed(2) : '—'} [${ws.map((w) => w.toFixed(1)).join(' ')}] blob ${r.blobAtA ? 'A' : ''}${r.blobAtB ? 'B' : ''} from ${r.pts[0].x.toFixed(0)},${r.pts[0].y.toFixed(0)} to ${r.pts[r.pts.length - 1].x.toFixed(0)},${r.pts[r.pts.length - 1].y.toFixed(0)}`)
      }
    }
    let fills = 0
    let nodes = 0
    for (const it of doc.items)
      if (it.kind === 'path' && it.id !== 'paper') {
        if (!(it.stroke && it.fill === 'none')) fills++
        for (const sp of it.subPaths) nodes += sp.nodes.length
      }
    rows.push({
      sheet: stem,
      tile: n,
      row,
      col,
      res: input.width,
      W: diag.report.strokeWidth,
      strokes: stubs.strokes,
      abs: stubs.abs,
      rel: stubs.rel,
      fills,
      fillShare: Math.round(diag.report.fillShare * 100) / 100,
      junctions: diag.report.junctions,
      nodes,
    })
    if (argv.includes('--stubs') && stubs.relList.length) console.log(`  ${stem}-${n} rel stubs`, JSON.stringify(stubs.relList))
    const name = `${stem}-${String(n).padStart(2, '0')}`
    writeFileSync(join(outDir, `${name}.svg`), serializeDoc(doc, 2))
    writeFileSync(join(outDir, `${name}.png`), strip(input, doc, Math.min(600, Math.max(300, input.width))))
    for (const lk of looks.filter((l) => l.tile === n))
      writeFileSync(join(outDir, `${name}-look-${lk.x}-${lk.y}.png`), look(input, doc, stages!, junctions, lk))
  }
}

if (json) console.log(JSON.stringify(rows, null, 1))
else {
  console.log('tile'.padEnd(12) + 'r,c'.padStart(6) + 'res'.padStart(6) + 'W'.padStart(7) + 'strokes'.padStart(8) + 'abs'.padStart(5) + 'rel'.padStart(5) + 'fills'.padStart(6) + 'fill%'.padStart(7) + 'junc'.padStart(6) + 'nodes'.padStart(7))
  for (const r of rows)
    console.log(
      `${r.sheet}-${String(r.tile).padStart(2, '0')}`.padEnd(12) +
        `${r.row},${r.col}`.padStart(6) +
        String(r.res).padStart(6) +
        r.W.toFixed(1).padStart(7) +
        String(r.strokes).padStart(8) +
        String(r.abs).padStart(5) +
        String(r.rel).padStart(5) +
        String(r.fills).padStart(6) +
        (r.fillShare * 100).toFixed(0).padStart(7) +
        String(r.junctions).padStart(6) +
        String(r.nodes).padStart(7),
    )
  const sum = (k: keyof Row): number => rows.reduce((s, r) => s + (r[k] as number), 0)
  console.log(`\n${rows.length} tiles: ${sum('strokes')} strokes, abs-flagged ${sum('abs')}, rel-flagged ${sum('rel')}, ${sum('fills')} fills, ${sum('nodes')} nodes`)
}
