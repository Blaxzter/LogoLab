// Where every node and every counted kink sits, per case — what /labs/bench and /benchmark
// draw over each SVG.
//
//   node --experimental-strip-types bench/compare/overlay.ts --run <name>   (backfill a run)
//
// run.ts writes `cases/<corpus>/<case>/overlay.json` for every case it scores; this CLI does
// the same for a run made before it did. The anchors come from the SAME parse the scorer reads
// (traceSvg.ts → svgGround) and the kinks from the SAME locator (geomScore.tangentBreaks over
// the truth raster's visibility), so a ring on the picture is a unit in the Breaks column. A
// case whose authored SVG svgGround refuses (strokes, clips) gets anchors and no kinks: there
// is no answer sheet to call a curve smooth against.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureImageData } from '../nodeHarness.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../svgGround.ts'
import { makeVisibleAt, tangentBreaks } from '../geomScore.ts'
import { renderGround } from './render.ts'
import { parseTraceSvg } from './traceSvg.ts'
import { RESULTS } from './paths.ts'
import type { SubPath } from '../../src/lib/path/types.ts'

export interface ToolOverlay {
  /** Anchor points, flat [x, y, …], in the pixels of the `width`×`height` render. */
  anchors: number[]
  /** Counted tangent breaks, flat [x, y, kink°, …]. */
  breaks: number[]
  /** Per break, the unit tangents arriving and leaving: flat [itx, ity, otx, oty, …]. */
  dirs: number[]
}

export interface CaseOverlay {
  width: number
  height: number
  authored: number[]
  tools: Record<string, ToolOverlay>
}

const round = (v: number) => Math.round(v * 10) / 10
const unit = (v: number) => Math.round(v * 1000) / 1000
const anchorsOf = (sets: SubPath[][]) => sets.flat().flatMap((sp) => sp.nodes.flatMap((n) => [round(n.x), round(n.y)]))

/** Anchors and kinks of each tool's SVG, measured against one authored SVG at `res`. */
export function caseOverlay(authoredSvg: string, res: number, toolSvgs: Map<string, string>): CaseOverlay {
  ensureImageData()
  const img = renderGround(authoredSvg, res)
  const gt = parseGroundTruth(authoredSvg)
  const shapes = unscorable(gt) ? null : toRasterSpace(gt, img.width)
  const visible = makeVisibleAt(img)
  const tools: Record<string, ToolOverlay> = {}
  for (const [tool, svg] of toolSvgs) {
    const parsed = parseTraceSvg(svg, img.width, img.height)
    const sets = parsed.shapes?.map((s) => s.subPaths) ?? []
    const breaks = shapes && parsed.shapes ? tangentBreaks(shapes, sets, img.width, img.height, visible).sites : []
    tools[tool] = {
      anchors: anchorsOf(sets),
      breaks: breaks.flatMap((b) => [round(b.x), round(b.y), Math.round(b.kink)]),
      dirs: breaks.flatMap((b) => [unit(b.itx), unit(b.ity), unit(b.otx), unit(b.oty)]),
    }
  }
  return {
    width: img.width,
    height: img.height,
    authored: shapes ? anchorsOf(shapes.map((s) => s.subPaths)) : [],
    tools,
  }
}

/** Write overlay.json into every case directory of a run, from its pairs.jsonl. */
export function writeOverlays(runDir: string, res: number): number {
  const byCase = new Map<string, { gt: string; dir: string; tools: Map<string, string> }>()
  for (const line of readFileSync(join(runDir, 'pairs.jsonl'), 'utf8').split('\n')) {
    if (!line.trim()) continue
    const p = JSON.parse(line) as { key: string; gt_svg: string; gen_svg: string }
    const tool = p.key.slice(0, p.key.indexOf('|'))
    const caseId = p.key.slice(p.key.indexOf('|') + 1)
    let c = byCase.get(caseId)
    if (!c) byCase.set(caseId, (c = { gt: p.gt_svg, dir: dirname(p.gen_svg), tools: new Map() }))
    if (existsSync(p.gen_svg)) c.tools.set(tool, readFileSync(p.gen_svg, 'utf8'))
  }
  for (const c of byCase.values()) {
    if (!existsSync(c.gt)) continue
    const o = caseOverlay(readFileSync(c.gt, 'utf8'), res, c.tools)
    writeFileSync(join(c.dir, 'overlay.json'), JSON.stringify(o))
  }
  return byCase.size
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2)
  const run = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : null
  if (!run) throw new Error('usage: overlay.ts --run <name>')
  const runDir = join(RESULTS, run)
  const { meta } = JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as { meta: { res: number } }
  const t0 = performance.now()
  const n = writeOverlays(runDir, meta.res)
  console.log(`overlay: ${n} cases in ${run} (${Math.round(performance.now() - t0)} ms)`)
}
