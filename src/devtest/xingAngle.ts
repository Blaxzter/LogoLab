// XING ANGLE — the second symptom of §24.9: the CORNER AT A CROSSING comes out at the
// wrong angle when one of its arms was never snapped to a circle.
//
//   node --experimental-strip-types src/devtest/xingAngle.ts            # olympic-rings @512
//   node --experimental-strip-types src/devtest/xingAngle.ts --nochain  # the §24 tracer
//   node --experimental-strip-types src/devtest/xingAngle.ts --res 1024
//
// WHY. docs/handoff-through-chains.md §2 states the defect in two halves and insists they
// are ONE job: a ring that does not line up across a crossing, and a corner at a crossing
// that traces at the wrong angle "because one of its arms is one of the 18". The first half
// has a lens (`circleRecovery`); the second had a hand measurement and no instrument.
//
// This is the instrument. A corner at a crossing is CORRECT and must not be removed — the
// covered band's region genuinely ends there and its outline turns to follow the covering
// band's edge. What must be right is its ANGLE, and the authored answer is exact: where two
// authored circles cross, the angle between them is fixed by the geometry, so the traced
// corner can be scored against a number rather than against a baseline.
//
// The measurement walks the TRACED TOPOLOGY (not the raw network): for every pair of
// authored circles that intersect, take each intersection point, find the traced vertex
// nearest it, and read the tangent of every incident edge at that vertex from its own fitted
// handles — which is the whole point, since an arc snapped to a circle carries the circle's
// tangent by construction and a freehand arc carries whatever its fit landed on. Arms are
// attributed to an authored circle by where their points lie, and the angle between the two
// arms on DIFFERENT circles is compared with the authored crossing angle.
//
// PURELY DIAGNOSTIC.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { strokedCircleGround, flattenSubPath } from './geomScore.ts'
import { fitCircle } from '../lib/trace/circleFit.ts'
import { reverseEdgeNodes } from '../lib/path/topology.ts'
import type { SharedEdge, Vec } from '../lib/path/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 512
const NOCHAIN = argv.includes('--nochain')
const CASE = argv.indexOf('--case') >= 0 ? argv[argv.indexOf('--case') + 1] : 'olympic-rings'
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '   —  ')

const file = [join(root, 'examples', 'logos', `${CASE}.svg`), join(root, 'public', 'examples', 'edge-cases', `${CASE}.svg`)].find((p) => {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
})!
const text = readFileSync(file, 'utf8')
const img = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
const doc = await traceImage(img as unknown as ImageData, {
  ...DEFAULT_VECTORIZE_OPTIONS,
  engine: 'planar',
  gradients: false,
  ...(NOCHAIN ? { planarFit: { chainArcs: false } } : {}),
})
const topo = doc.topology
if (!topo) throw new Error('no topology on the traced doc')

// Authored circles, in raster space (a stroked circle authors two — §24.3 / geomScore).
const circles = strokedCircleGround(text, RES)
  .map((sh) => {
    const c = fitCircle(flattenSubPath(sh.subPaths[0]))
    return c
  })
  .filter((c): c is { cx: number; cy: number; r: number } => !!c)

/** Unit tangent of an edge at one of its ends, from the fitted handle (falling back to the
 *  anchor chord when a node carries none). This is the quantity the defect is about. */
function endTangent(e: SharedEdge, atEnd: boolean): Vec | null {
  const n = e.nodes
  if (n.length < 2) return null
  const a = atEnd ? n[n.length - 1] : n[0]
  const h = atEnd ? a.hIn : a.hOut
  const b = atEnd ? n[n.length - 2] : n[1]
  // Handles are ABSOLUTE control points (see segmentControls), not offsets.
  const dx = h ? h.x - a.x : b.x - a.x
  const dy = h ? h.y - a.y : b.y - a.y
  const l = Math.hypot(dx, dy)
  return l < 1e-9 ? null : { x: dx / l, y: dy / l }
}

/**
 * Which authored circle an arm lies on — read AWAY from the junction, which is the whole
 * difficulty. At a crossing the two circles pass through the SAME point, so any window that
 * starts at the vertex reads every arm as lying on whichever circle you test first: measured
 * over the first few nodes, all three arms of a blue×yellow junction come back "blue inner,
 * 0.05px". The arms only separate once you are far enough along them, so the window is a
 * BAND of arc length, skipping the near field entirely.
 */
const ARM_NEAR = 4
const ARM_FAR = 12
function armCircle(e: SharedEdge, atEnd: boolean): { i: number; dev: number; len: number } {
  // reverseEdgeNodes, not Array.reverse: a reversed node list must also swap hIn/hOut or
  // the flattened curve is nonsense.
  const poly = flattenSubPath({ nodes: atEnd ? reverseEdgeNodes(e.nodes) : e.nodes, closed: false })
  // RESAMPLE at a fixed step. A snapped arc flattens to as few as two points over 14px
  // (it is that close to straight), so taking flatten output directly leaves nothing in the
  // band and every such arm reads "unattributable".
  const pts: Vec[] = []
  let acc = 0
  for (let k = 1; k < poly.length; k++) {
    const a = poly[k - 1]
    const b = poly[k]
    const seg = Math.hypot(b.x - a.x, b.y - a.y)
    for (let t = 0; t < seg; t += 0.5) {
      const s0 = acc + t
      if (s0 >= ARM_NEAR && s0 <= ARM_FAR) pts.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg })
    }
    acc += seg
    if (acc > ARM_FAR) break
  }
  if (pts.length < 2) return { i: -1, dev: Infinity, len: acc }
  let best = -1
  let bd = Infinity
  for (let i = 0; i < circles.length; i++) {
    let s = 0
    for (const p of pts) s += Math.abs(Math.hypot(p.x - circles[i].cx, p.y - circles[i].cy) - circles[i].r)
    const d = s / pts.length
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return { i: best, dev: bd, len: acc }
}

const inc = new Map<number, { e: SharedEdge; atEnd: boolean }[]>()
for (const e of topo.edges) {
  if (e.closed || e.nodes.length < 2) continue
  for (const [v, atEnd] of [
    [e.startVertex, false],
    [e.endVertex, true],
  ] as [number | null, boolean][]) {
    if (v == null || v < 0) continue
    const a = inc.get(v)
    if (a) a.push({ e, atEnd })
    else inc.set(v, [{ e, atEnd }])
  }
}
const vById = new Map(topo.vertices.map((v) => [v.id, v]))

console.log(`\n━━━ CROSSING CORNER ANGLES — ${CASE} @${RES}${NOCHAIN ? '  NO-CHAIN (§24)' : '  §25 chained'} ━━━`)
console.log(`  ${circles.length} authored circles, ${topo.edges.length} edges, ${topo.vertices.length} vertices\n`)
console.log(`  ${'crossing'.padStart(18)}${'authored°'.padStart(11)}${'traced°'.padStart(10)}${'err'.padStart(8)}   arms (circle, mean dev px)`)

const errs: number[] = []
for (let a = 0; a < circles.length; a++) {
  for (let b = a + 1; b < circles.length; b++) {
    const A = circles[a]
    const B = circles[b]
    const dx = B.cx - A.cx
    const dy = B.cy - A.cy
    const d = Math.hypot(dx, dy)
    if (d < 1e-6 || d > A.r + B.r || d < Math.abs(A.r - B.r)) continue
    const t = (A.r * A.r - B.r * B.r + d * d) / (2 * d)
    const h2 = A.r * A.r - t * t
    if (h2 <= 0) continue
    const h = Math.sqrt(h2)
    const mx = A.cx + (t * dx) / d
    const my = A.cy + (t * dy) / d
    for (const sgn of [1, -1]) {
      const px = mx + (sgn * h * -dy) / d
      const py = my + (sgn * h * dx) / d
      if (px < 0 || py < 0 || px > img.width || py > img.height) continue
      // Authored angle between the two circles at this point: the angle between their
      // tangents, which are perpendicular to the radii.
      const ta = { x: -(py - A.cy) / A.r, y: (px - A.cx) / A.r }
      const tb = { x: -(py - B.cy) / B.r, y: (px - B.cx) / B.r }
      let authored = (Math.acos(Math.max(-1, Math.min(1, ta.x * tb.x + ta.y * tb.y))) * 180) / Math.PI
      if (authored > 90) authored = 180 - authored
      // The traced vertex nearest this crossing.
      let bestV = -1
      let bd = Infinity
      for (const v of topo.vertices) {
        const dd = Math.hypot(v.x - px, v.y - py)
        if (dd < bd) {
          bd = dd
          bestV = v.id
        }
      }
      if (bestV < 0 || bd > 3) continue
      const arms = (inc.get(bestV) ?? []).map((x) => ({ ...x, c: armCircle(x.e, x.atEnd), t: endTangent(x.e, x.atEnd) }))
      const onA = arms.filter((x) => x.c.i === a && x.t)
      const onB = arms.filter((x) => x.c.i === b && x.t)
      if (!onA.length || !onB.length) continue
      // The corner: one arm on each circle. Report the SHARPEST such pair, which is the
      // corner the outline actually turns through.
      let traced = NaN
      let bestErr = Infinity
      let picked: [(typeof arms)[number], (typeof arms)[number]] | null = null
      for (const x of onA)
        for (const y of onB) {
          let ang = (Math.acos(Math.max(-1, Math.min(1, x.t!.x * y.t!.x + x.t!.y * y.t!.y))) * 180) / Math.PI
          if (ang > 90) ang = 180 - ang
          const err = Math.abs(ang - authored)
          if (!(err < bestErr)) continue
          bestErr = err
          traced = ang
          picked = [x, y]
        }
      if (!picked) continue
      errs.push(Math.abs(traced - authored))
      const v = vById.get(bestV)!
      console.log(
        `  ${`(${v.x.toFixed(0)},${v.y.toFixed(0)})`.padStart(18)}${f(authored, 1).padStart(11)}${f(traced, 1).padStart(10)}${f(traced - authored, 1).padStart(8)}` +
          `   #${a}(${f(picked[0].c.dev)})  #${b}(${f(picked[1].c.dev)})`,
      )
    }
  }
}
errs.sort((x, y) => x - y)
const q = (t: number): number => errs[Math.min(errs.length - 1, Math.floor(t * errs.length))]
console.log(`\n  ${errs.length} crossings scored — |traced − authored| :  p50 ${f(q(0.5), 2)}°   p90 ${f(q(0.9), 2)}°   MAX ${f(errs[errs.length - 1], 2)}°`)
console.log(`  mean ${f(errs.reduce((s, e) => s + e, 0) / (errs.length || 1), 2)}°\n`)
