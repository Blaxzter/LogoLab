// What a tool's counted kinks JOIN: a line to a curve, two curves, or two lines.
//
//   node --experimental-strip-types bench/compare/kinkJoins.ts [--run v4] [--tool logolab-auto] [--case id]
//        [--show 'line|curve'] (print every site of one class)
//
// Reads a run's saved outputs (nothing traced), locates every tangent break with the same
// scorer the run used, finds the traced node it sits on, and classifies its two segments: a
// segment is a LINE when both its handles are absent (or lie on its chord), else a curve.
// Written for #16's last half: the general fit's line candidates are C⁰ at both ends, so a
// rounded corner traced as a line then a cubic kinks where they meet.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PathNode } from '../../src/lib/path/types.ts'
import { makeVisibleAt, tangentBreaks } from '../geomScore.ts'
import { ensureImageData } from '../nodeHarness.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from '../svgGround.ts'
import { renderGround } from './render.ts'
import { RESULTS } from './paths.ts'
import { parseTraceSvg } from './traceSvg.ts'

const argv = process.argv.slice(2)
const arg = (k: string, d: string) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const RUN = arg('--run', 'v4')
const TOOL = arg('--tool', 'logolab-auto')
const ONLY = arg('--case', '')
const SHOW = arg('--show', '')
const runDir = join(RESULTS, RUN)
const res = (JSON.parse(readFileSync(join(runDir, 'results.json'), 'utf8')) as { meta: { res: number } }).meta.res
ensureImageData()

/** Is the segment from a to b straight: no handles, or handles on the chord. */
function straight(a: PathNode, b: PathNode): boolean {
  const h = [a.hOut, b.hIn].filter(Boolean) as { x: number; y: number }[]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const L = Math.hypot(dx, dy)
  if (L < 1e-9) return true
  return h.every((p) => Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L < 0.05)
}

const tally = new Map<string, { n: number; deg: number[] }>()
const add = (k: string, deg: number) => {
  const t = tally.get(k) ?? { n: 0, deg: [] }
  t.n++
  t.deg.push(deg)
  tally.set(k, t)
}
for (const line of readFileSync(join(runDir, 'pairs.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue
  const p = JSON.parse(line) as { key: string; gt_svg: string; gen_svg: string }
  if (!p.key.startsWith(`${TOOL}|svgemoji-v0/`)) continue
  if (ONLY && !p.key.includes(ONLY)) continue
  const gtSvg = readFileSync(p.gt_svg, 'utf8')
  const img = renderGround(gtSvg, res)
  const gt = parseGroundTruth(gtSvg)
  if (unscorable(gt)) continue
  const shapes = toRasterSpace(gt, img.width)
  let svg: string
  try {
    svg = readFileSync(p.gen_svg, 'utf8')
  } catch {
    continue
  }
  const parsed = parseTraceSvg(svg, img.width, img.height)
  if (!parsed.shapes) continue
  const sets = parsed.shapes.map((s) => s.subPaths)
  const sites = tangentBreaks(shapes, sets, img.width, img.height, makeVisibleAt(img)).sites
  for (const s of sites) {
    let kind = 'unlocated'
    for (const sp of sets.flat()) {
      const n = sp.nodes.length
      const closed = sp.closed !== false
      const i = sp.nodes.findIndex((q) => Math.hypot(q.x - s.x, q.y - s.y) < 0.05)
      if (i < 0) continue
      const prev = i > 0 ? sp.nodes[i - 1] : closed ? sp.nodes[n - 1] : null
      const next = i < n - 1 ? sp.nodes[i + 1] : closed ? sp.nodes[0] : null
      if (!prev || !next) continue
      const a = straight(prev, sp.nodes[i])
      const b = straight(sp.nodes[i], next)
      kind = a && b ? 'line|line' : a || b ? 'line|curve' : 'curve|curve'
      // Where three colours meet, every outline through the point has a node there: an
      // edge's END, fitted on its own. Elsewhere the node is one the fit chose itself.
      let others = 0
      for (const sh of parsed.shapes)
        for (const q of sh.subPaths)
          if (q !== sp && q.nodes.some((o) => Math.hypot(o.x - s.x, o.y - s.y) < 0.5)) others++
      kind += others >= 2 ? ' junction' : others === 1 ? ' shared' : ' interior'
      break
    }
    add(kind, s.kink)
    if (ONLY || (SHOW && kind.startsWith(SHOW)))
      console.log(
        `${p.key.slice(p.key.indexOf('/') + 1)} ` +
          `(${s.x.toFixed(1)}, ${s.y.toFixed(1)}) ${s.kink.toFixed(0)}° ${kind}`,
      )
  }
}
const total = [...tally.values()].reduce((s, t) => s + t.n, 0)
console.log(`${RUN} · ${TOOL}: ${total} kinks`)
for (const [k, t] of [...tally].sort((a, b) => b[1].n - a[1].n)) {
  const d = t.deg.sort((x, y) => x - y)
  console.log(
    `${k.padEnd(12)} ${String(t.n).padStart(5)}  ${((100 * t.n) / total).toFixed(0).padStart(3)}%  median ${d[d.length >> 1].toFixed(0)}°  ≥30°: ${d.filter((x) => x >= 30).length}`,
  )
}
