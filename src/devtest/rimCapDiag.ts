// Rim-cap diagnosis (§13) — is a disc whose rim is SPLIT by junctions still round?
//
//   node --experimental-strip-types src/devtest/rimCapDiag.ts
//
// Per disc of `bg-ramp-twin` (flat), per rim arc: the radial error of the fitted
// CURVE against the authored circle, not just its anchors — the §13 defect put the
// anchors 0.68px out and the cubic between them 3.26px out. Swept over the knobs
// that bracket the mechanism (fidelity, junctionReseat, arcSnap), because the
// visible failure is a §1d co-circular snap VETOED by a §10.4 re-seat artifact.
// Companion render: rimCapRender.ts. PURELY DIAGNOSTIC — src/lib/trace untouched.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { PathItem, PathNode } from '../lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const snapDir = join(root, 'test', 'ab-snapshots', 'before-lowres')
const img = decodePng(readFileSync(join(snapDir, 'bg-ramp-twin.png')))

// authored truth @512: green disc cx=144 cy=256 r=52 ; blue disc cx=368 cy=256 r=66
const DISCS = [
  { tag: 'GREEN', hex: /^#1[ea]a/i, cx: 144, cy: 256, r: 52 },
  { tag: 'BLUE ', hex: /^#2[89]4/i, cx: 368, cy: 256, r: 66 },
]

const cubic = (p0: PathNode, p1: PathNode, t: number) => {
  const c1 = p0.hOut ?? { x: p0.x, y: p0.y }
  const c2 = p1.hIn ?? { x: p1.x, y: p1.y }
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  }
}

const CONFIGS: Array<[string, Record<string, unknown>]> = [
  ['baseline', {}],
  ['fidelity 3.0', { fidelity: 3.0 }],
  ['reseat OFF', { planarFit: { junctionReseat: false } }],
  ['arcSnap OFF', { planarFit: { arcSnap: false } }],
]

for (const [label, over] of CONFIGS) {
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: false,
    ...over,
  })
  console.log(`\n########## ${label}`)
  const paths = doc.items.filter((i): i is PathItem => i.kind === 'path')
  for (const d of DISCS) {
    const p = paths.find((x) => d.hex.test(x.fill))
    if (!p) { console.log(`${d.tag} missing`); continue }
    const loop = p.loops?.[0] ?? []
    console.log(` ${d.tag} loop of ${loop.length} edge(s)`)
    for (const ref of loop) {
      const e = doc.topology!.edges[ref.edge]
      // radial error of the fitted CURVE (dense sample) vs the authored circle
      let curveErr = 0, anchorErr = 0, arcDeg = 0
      for (let i = 0; i + 1 < e.nodes.length; i++)
        for (let s = 0; s <= 24; s++) {
          const q = cubic(e.nodes[i], e.nodes[i + 1], s / 24)
          curveErr = Math.max(curveErr, Math.abs(Math.hypot(q.x - d.cx, q.y - d.cy) - d.r))
        }
      for (const n of e.nodes) anchorErr = Math.max(anchorErr, Math.abs(Math.hypot(n.x - d.cx, n.y - d.cy) - d.r))
      const a = e.nodes[0], b = e.nodes[e.nodes.length - 1]
      const ang = (n: PathNode) => Math.atan2(n.y - d.cy, n.x - d.cx)
      arcDeg = Math.abs(((ang(b) - ang(a)) * 180) / Math.PI)
      if (arcDeg > 180) arcDeg = 360 - arcDeg
      console.log(
        `   edge#${e.id} nodes=${e.nodes.length} arc≈${arcDeg.toFixed(0)}°` +
          `  anchorErr=${anchorErr.toFixed(2)}px  CURVE-err=${curveErr.toFixed(2)}px` +
          (curveErr > 1.5 ? '   ⇐ BULGES past the 1.5px fidelity' : ''),
      )
    }
  }
}
