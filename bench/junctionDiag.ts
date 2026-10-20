// JUNCTION DIAG — every junction the through rule touched, traced exactly as an A/B lane does.
//
//   node --experimental-strip-types bench/junctionDiag.ts <case id | file.svg|png> [--lane flat|grad|stack]
//                                                         [--near x,y,r] [--all] [--svg out.svg]
//
// threadDiag reproduces only the flat-palette label map; this one runs `traceImage` with the
// lane's own options (abCorpus AB_LANES) and listens on `PlanarFitOptions.threadDiag`, so a
// junction in the gradient lane (Mumford–Shah labels at the gradient cap) is the junction the
// stamp actually traced. One row per threaded junction (`--all`: every degree-3 one): where,
// which rule placed it, the chord turn, the joined window's line / circle residual, the stem,
// the move, and the tangent each through arm was handed. Coordinates are px of the lane's
// raster — a stamp row of 2048 shows them 1:1.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from '../src/lib/png/decode.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { JunctionVerdict } from '../src/lib/trace/planarThread.ts'
import { serializeDoc } from '../src/lib/path/model.ts'
import { AB_CORPUS, AB_LANES, AB_LOGO_CASES } from './abCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  return i < 0 ? null : (argv[i + 1] ?? '')
}
const target = argv[0]
const lane = AB_LANES.find((l) => l.key === (flag('--lane') ?? 'flat'))
if (!target || !lane) {
  console.error('usage: junctionDiag.ts <case id | file> [--lane flat|grad|stack] [--near x,y,r] [--all]')
  process.exit(1)
}
const near = flag('--near')?.split(',').map(Number)
const c = [...AB_CORPUS, ...AB_LOGO_CASES].find((k) => k.id === target)
const path = c ? join(root, c.path) : target
const bytes = readFileSync(path)
const img = path.endsWith('.png')
  ? decodePng(bytes)
  : decodePng(
      new Resvg(bytes.toString('utf8'), {
        fitTo: { mode: 'width', value: lane.res },
        ...(c?.background ? { background: c.background } : {}),
      })
        .render()
        .asPng(),
    )

const rows: JunctionVerdict[] = []
const doc = await traceImage(
  img as unknown as ImageData,
  {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    ...lane.opts,
    ...lane.resolve?.(img),
    planarFit: { threadDiag: (v: JunctionVerdict) => rows.push(v) },
  } as never,
)

// `--svg`: the trace itself, to compare against a stamp's file for the same lane.
const svgOut = flag('--svg')
if (svgOut) writeFileSync(svgOut, serializeDoc(doc))
const f = (v: number | null | undefined, d = 1): string => (v == null ? '—' : v.toFixed(d))
console.log(`${target} · ${lane.key} @${lane.res} · ${rows.length} junctions`)
for (const v of rows) {
  if (near && Math.hypot(v.x - near[0], v.y - near[1]) > near[2]) continue
  if (!argv.includes('--all') && !v.tangents && !v.linked) continue
  const t = (v.tangents ?? []).map(([k, u]) => `e${k >> 1}${k & 1 ? 'e' : 's'}→${f(u.x, 2)},${f(u.y, 2)}`).join(' ')
  console.log(
    `  (${v.x},${v.y}) ${v.reason.padEnd(30)} turn ${f(v.turnDeg)}° line ${f(v.lineDev, 2)} circ ${f(v.circleDev, 2)} ` +
      `stem ${f(v.stemDeg, 0)}° move ${f(v.move, 2)} ext ${v.extK ?? '—'}  ΔE ${v.ends.map((e) => f(e.de, 0)).join('/')}  ${t}`,
  )
}
