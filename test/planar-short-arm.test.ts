// §31 — the short-arm bypass, re-derived as a sample count (issue #36).
//
// `snapCornerToArms` keeps the raw lattice vertex when a corner's arms are too short to fit
// a line worth trusting (§10.6). That rule was written as `SNAP_GAP + 4` STEPS of window —
// "3 censored + 4 samples" under the fixed 3-px gap of the day — and swept upward only.
// The paired per-corner census (src/devtest/cornerScaleDiag.ts, benchmarks §31) measured
// the other side on the driver at the lab raster: with `armGap` censoring one step on a
// short arm, the bypass was refusing an intersection CLOSER to the authored corner than
// the vertex it kept on 6 of 8 gear-teeth corners. The floor is now SHORT_ARM_SAMPLES = 5
// samples per arm.
//
// Red-before-green STRUCTURALLY (§18.4's contract): each test traces the same raster under
// the old rule (`shortArmSamples: 7` — identical to the step rule on every arm whose gap is
// 1, which is every short arm on this loop) and the default in the same run, and the
// preconditions assert the old rule actually bypassed a population here, so the gate cannot
// pass by the rule never firing. The numbers come from the authored SVG, not a baseline.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { decodePng } from '../src/devtest/png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../src/lib/trace/index.ts'
import type { ApexDiagRecord } from '../src/lib/trace/planarFit.ts'
import { parseGroundTruth, toRasterSpace } from '../src/devtest/svgGround.ts'
import { sharpCorners, makeVisibleAt, scoreGeometry, CORNER_MIN_EDGE, type Corner } from '../src/devtest/geomScore.ts'
import type { EditableDoc, SubPath } from '../src/lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RES = 512
/** The pre-§31 rule, expressed in the new knob: `SNAP_GAP + 4` steps ≡ 7 samples at gap 1. */
const OLD_RULE = 7

interface Traced {
  doc: EditableDoc
  recs: ApexDiagRecord[]
  corners: Corner[]
  score: ReturnType<typeof scoreGeometry>
}

async function trace(name: string, shortArmSamples?: number): Promise<{ gt: Corner[]; t: Traced; img: ReturnType<typeof decodePng> }> {
  const svg = readFileSync(join(root, 'public', 'examples', 'edge-cases', `${name}.svg`), 'utf8')
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
  const shapes = toRasterSpace(parseGroundTruth(svg), img.width)
  const visible = makeVisibleAt(img)
  const gt = sharpCorners(shapes.map((s) => s.subPaths), CORNER_MIN_EDGE).filter(
    (c) => visible({ x: c.x, y: c.y, tx: c.itx, ty: c.ity }) || visible({ x: c.x, y: c.y, tx: c.otx, ty: c.oty }),
  )
  const recs: ApexDiagRecord[] = []
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: false,
    planarFit: { apexDiag: (r: ApexDiagRecord) => { recs.push(r) }, ...(shortArmSamples !== undefined ? { shortArmSamples } : {}) },
  })
  const sets: SubPath[][] = []
  for (const it of doc.items) if (it.kind === 'path' && it.visible !== false) sets.push(it.subPaths)
  return { gt, img, t: { doc, recs, corners: sharpCorners(sets), score: scoreGeometry(shapes, doc, img.width, img.height, img) } }
}

const nearest = (p: { x: number; y: number }, xs: { x: number; y: number }[]): number => {
  let best = Infinity
  for (const q of xs) best = Math.min(best, Math.hypot(q.x - p.x, q.y - p.y))
  return best
}
/** The apex record whose detected vertex is nearest an authored corner (≤ 6 px), or null. */
const recordAt = (g: Corner, recs: ApexDiagRecord[]): ApexDiagRecord | null => {
  let best: ApexDiagRecord | null = null
  let bd = 6
  for (const r of recs) {
    const d = Math.hypot(r.cx - g.x, r.cy - g.y)
    if (d < bd) {
      bd = d
      best = r
    }
  }
  return best
}

test('§31 gear-teeth @512: the corners the old rule bypassed are placed closer to their authored apex', async () => {
  const { gt, t: oldT } = await trace('gear-teeth', OLD_RULE)
  const { t: newT } = await trace('gear-teeth')
  // Precondition: the old rule bypassed a real population here (6+ corners), so the
  // comparison below is between two rules that actually differ on this raster.
  const bypassed = gt.filter((g) => recordAt(g, oldT.recs)?.outcome === 'short-arm')
  assert.ok(bypassed.length >= 6, `old rule bypassed ${bypassed.length} authored corners; the gate needs a population`)
  const sumOld = bypassed.reduce((a, g) => a + nearest(g, oldT.corners), 0)
  const sumNew = bypassed.reduce((a, g) => a + nearest(g, newT.corners), 0)
  // Measured 2026-09-06: Σ 1.04 px/corner kept vs 0.54 reconstructed on 8 corners — the
  // bound is half the measured gain, so a partial regression still trips it.
  assert.ok(sumNew <= 0.75 * sumOld, `Σ placement over the ${bypassed.length} bypassed corners: old ${sumOld.toFixed(2)} → new ${sumNew.toFixed(2)} px (limit 0.75×)`)
  // …and the change buys placement without spending recall or precision on the driver.
  assert.ok(newT.score.cornersRecovered >= oldT.score.cornersRecovered, `corners recovered ${oldT.score.cornersRecovered} → ${newT.score.cornersRecovered}`)
  assert.ok(newT.score.cornersInvented <= oldT.score.cornersInvented, `corners invented ${oldT.score.cornersInvented} → ${newT.score.cornersInvented}`)
  assert.ok(newT.score.chamfer <= oldT.score.chamfer + 0.005, `chamfer ${oldT.score.chamfer.toFixed(4)} → ${newT.score.chamfer.toFixed(4)}`)
})

test('§31 the corners the new floor still bypasses are ones the intersection would not improve', async () => {
  const { gt, t } = await trace('gear-teeth')
  // Every corner the default rule still refuses at 512 keeps a vertex at least as close to
  // the authored corner as the intersection it refused (the census's `kept better`/`same`
  // buckets, ±0.25 px) — the floor sits at the wall, not past it.
  const still = gt.map((g) => ({ g, r: recordAt(g, t.recs) })).filter((x) => x.r?.outcome === 'short-arm')
  for (const { g, r } of still) {
    if (!Number.isFinite(r!.hx)) continue
    const kept = Math.hypot(r!.ax - g.x, r!.ay - g.y)
    const hit = Math.hypot(r!.hx - g.x, r!.hy - g.y)
    assert.ok(hit >= kept - 0.25, `still-bypassed corner @(${g.x.toFixed(0)},${g.y.toFixed(0)}): kept ${kept.toFixed(2)} px, refused intersection ${hit.toFixed(2)} px`)
  }
})

test('§31 the floor is inert where the bypass was never the placer: bar-caps and sharp-star are byte-identical', async () => {
  for (const name of ['bar-caps', 'sharp-star']) {
    const a = await trace(name, OLD_RULE)
    const b = await trace(name)
    assert.deepEqual(b.t.doc, a.t.doc, `${name} @${RES} differs between the old and new rule`)
  }
})
