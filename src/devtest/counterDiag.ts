// THIN-COUNTER DIAGNOSTIC — where do the two walls of a converging white wedge end up?
// (issue #11: the Instagram 'a' loses the gap at the top of its counter under §15's
// sub-pixel edge placement.)
//
//   node --experimental-strip-types src/devtest/counterDiag.ts --logo instagram --roi 303,112,36,20
//   node --experimental-strip-types src/devtest/counterDiag.ts --svg public/examples/edge-cases/wedge-counter.svg
//   node --experimental-strip-types src/devtest/counterDiag.ts --logo instagram --res 512 --ascii
//
// It answers three questions with numbers, in the order a diagnosis needs them:
//
//  1. WHAT MOVED — for every chain point inside the ROI: the lattice position, the left
//     normal, the estimator's OUTCOME (moved / which guard declined it) and the signed
//     displacement. This is the "per-point displacement dump on the two wall chains" the
//     issue asks for; it reads the pass's own observational hook (SubpixelDiag), so there
//     is no second copy of the estimator that can drift from the shipped one.
//  2. WHERE THE WALLS ARE — per raster row, the WHITE RUN between the two walls, measured
//     three ways in the SAME units: the source raster's own coverage (the answer), the
//     lattice chains, and the displaced chains. A wedge closing is a run that goes to zero
//     rows before it should.
//  3. WHAT THE FIT DID WITH IT — the same per-row run measured on the RENDERED trace, with
//     and without the pass. The estimator can be innocent and the fit still close a wedge.
//
// The measurement traps this is built against (each produced a wrong conclusion in this
// repo before): no rasterizeDoc of a SCALED doc (it crops — everything here renders at
// native size); no mean as a headline (per-row runs, and the row where a run first hits
// zero); and the ROI is quoted in raster px so two runs are comparable by construction.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import { subpixelEdgeChains, type SubpixelDiagRecord } from '../lib/trace/planarSubpixel.ts'
import type { PinDiagRecord } from '../lib/trace/planarFit.ts'
import type { EditableDoc } from '../lib/path/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  if (!argv.includes(name)) return null
  const v = argv[argv.indexOf(name) + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}

const RES = Number(flag('--res') ?? 512)
const GRAD = argv.includes('--gradients')
const logo = flag('--logo')
const svgArg = flag('--svg')
const svgPath = svgArg ? svgArg : logo ? `examples/logos/${logo.replace(/\.svg$/, '')}.svg` : null
if (!svgPath) {
  console.log('usage: counterDiag.ts (--logo <name> | --svg <path>) [--roi x,y,w,h] [--res 512] [--gradients] [--ascii]')
  if (logo === '') {
    const dir = join(root, 'examples', 'logos')
    try {
      console.log('  logos on disk:', readdirSync(dir).length)
    } catch {
      console.log('  (examples/logos/ absent — `npm run fetch:logos`)')
    }
  }
  process.exit(1)
}

const svg = readFileSync(join(root, svgPath), 'utf8')
const pngBytes = new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()
const img = decodePng(pngBytes)
const W = img.width
const H = img.height

const roiArg = (flag('--roi') ?? '').split(',').map(Number)
const ROI =
  roiArg.length === 4 && roiArg.every((n) => Number.isFinite(n))
    ? { x: roiArg[0], y: roiArg[1], w: roiArg[2], h: roiArg[3] }
    : { x: 0, y: 0, w: W, h: H }

console.log(`${svgPath} @ ${W}×${H}${GRAD ? ' (gradients ON)' : ''}   ROI x${ROI.x} y${ROI.y} ${ROI.w}×${ROI.h}\n`)

// --- trace twice, and capture the label map the planar tracer actually used ----------
let labels: Int32Array | null = null
const pins: PinDiagRecord[] = []
const trace = async (subpixelEdges: boolean): Promise<EditableDoc> =>
  await traceImage(
    img as unknown as ImageData,
    {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: GRAD,
      planarFit: { subpixelEdges, ...(subpixelEdges ? { pinDiag: (r: PinDiagRecord) => pins.push(r) } : {}) },
    },
    undefined, // onProgress
    undefined, // signal
    undefined, // onPreMerge
    undefined, // onStage
    (l) => {
      labels = l.labels
    },
  )

const docOn = await trace(true)
const docOff = await trace(false)
if (!labels) throw new Error('no label map — the planar engine did not run')

// --- 1. per-point displacement dump ---------------------------------------------------
const net = buildPlanarNetwork(labels, W, H)
const recs: SubpixelDiagRecord[] = []
subpixelEdgeChains(net, labels, { data: img.data, width: W, height: H }, (r) => {
  if (r.x >= ROI.x && r.x <= ROI.x + ROI.w && r.y >= ROI.y && r.y <= ROI.y + ROI.h) recs.push(r)
})
// One row per chain point: the estimator's verdict, plus whether the corner self-guard
// then took the point back to the lattice (the guard fires AFTER the estimate, and its
// ±TURN_GUARD windows overlap, so the raw stream repeats indices — collapse them).
interface PointRow {
  edgeId: number
  index: number
  x: number
  y: number
  nx: number
  ny: number
  outcome: string
  delta: number
  reverted: boolean
}
const byPoint = new Map<string, PointRow>()
for (const r of recs) {
  const k = `${r.edgeId}:${r.index}`
  const cur = byPoint.get(k)
  if (r.outcome === 'corner-revert') {
    if (cur) cur.reverted = true
    else byPoint.set(k, { ...r, outcome: '—', reverted: true })
  } else if (cur) {
    cur.outcome = r.outcome
    cur.delta = r.delta
    cur.nx = r.nx
    cur.ny = r.ny
  } else byPoint.set(k, { ...r, reverted: false })
}
const rows = [...byPoint.values()]
const byEdge = new Map<number, PointRow[]>()
for (const r of rows) {
  let a = byEdge.get(r.edgeId)
  if (!a) byEdge.set(r.edgeId, (a = []))
  a.push(r)
}
console.log(`chain points in ROI: ${rows.length} across ${byEdge.size} edge(s)`)
const tally = new Map<string, number>()
const key = (r: PointRow): string => (r.reverted ? `${r.outcome}+revert` : r.outcome)
for (const r of rows) tally.set(key(r), (tally.get(key(r)) ?? 0) + 1)
console.log(
  '  outcomes: ' +
    [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
)
if (!argv.includes('--quiet'))
  for (const [id, rs] of [...byEdge.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const e = net.edges.find((x) => x.id === id)!
    console.log(`\n  edge ${id}  left=${e.left} right=${e.right}  ${e.closed ? 'closed' : 'open'}  ${e.pts.length} pts`)
    console.log('     i     x      y     n=(nx,ny)        outcome        δ   final')
    for (const r of rs.sort((a, b) => a.index - b.index)) {
      const fx = r.reverted ? r.x : r.x + r.delta * r.nx
      const fy = r.reverted ? r.y : r.y + r.delta * r.ny
      console.log(
        `  ${String(r.index).padStart(4)}  ${r.x.toFixed(1).padStart(5)}  ${r.y.toFixed(1).padStart(5)}  ` +
          `(${r.nx.toFixed(2).padStart(5)},${r.ny.toFixed(2).padStart(5)})  ${(r.reverted ? `${r.outcome}/REVERT` : r.outcome).padEnd(18)} ` +
          `${r.delta.toFixed(3).padStart(6)}  ${fx.toFixed(2)},${fy.toFixed(2)}`,
      )
    }
  }

// --- 1b. the tangent pins that fired in the ROI ---------------------------------------
// The estimator can be innocent and the FIT still close a wedge: §15's tangent pin rotates
// an apex handle onto its arm line, and where that arm is curved the line is a chord, not a
// tangent (issue #11). `shift` is what the rotation does to the handle's tip — the term the
// curve actually feels, and the one that separates a tangent correction from a re-fit.
const inRoi = pins.filter((p) => p.x >= ROI.x && p.x <= ROI.x + ROI.w && p.y >= ROI.y && p.y <= ROI.y + ROI.h)
console.log(`\ntangent-pin candidates in ROI: ${inRoi.length} (${inRoi.filter((p) => p.applied).length} applied)`)
if (inRoi.length) console.log('     apex            side   rot°    bow   chord    n   handle   shift  applied')
for (const p of inRoi.sort((a, b) => b.rotDeg - a.rotDeg)) {
  const shift = 2 * p.handle * Math.sin((p.rotDeg * Math.PI) / 360)
  console.log(
    `  (${p.x.toFixed(1)},${p.y.toFixed(1)})`.padEnd(20) +
      `${p.side.padEnd(5)} ${p.rotDeg.toFixed(1).padStart(6)} ${p.bow.toFixed(2).padStart(6)} ` +
      `${p.chord.toFixed(1).padStart(6)} ${String(p.n).padStart(4)} ${p.handle.toFixed(1).padStart(7)} ${shift.toFixed(2).padStart(7)}  ${p.applied ? 'yes' : 'no'}`,
  )
}

// --- 2 + 3. per-row white run, four ways ----------------------------------------------
// A "white run" is the widest horizontal run of BACKGROUND coverage inside the ROI on that
// row. On the source raster it is the answer; on a render it is what the trace kept.
// The run that matters is the one BETWEEN the walls — an ROI-wide widest-run would report
// the page background. So: find the first and last ink pixel on the row inside the ROI,
// and measure the longest background run strictly between them (0 = the wedge is closed
// on that row, which is the failure this diagnostic exists to date).
const INK_MAX = 200 // mean RGB below this counts as ink (the wordmark is near-black navy)
const lum = (buf: Uint8ClampedArray | Uint8Array, x: number, y: number): number => {
  const i = (y * W + x) * 4
  return (buf[i] + buf[i + 1] + buf[i + 2]) / 3
}
const runOn = (buf: Uint8ClampedArray | Uint8Array, y: number): number => {
  let first = -1
  let last = -1
  for (let x = ROI.x; x < ROI.x + ROI.w; x++)
    if (lum(buf, x, y) <= INK_MAX) {
      if (first < 0) first = x
      last = x
    }
  if (first < 0 || last <= first) return 0
  let best = 0
  let run = 0
  for (let x = first + 1; x < last; x++) {
    if (lum(buf, x, y) > INK_MAX) best = Math.max(best, ++run)
    else run = 0
  }
  return best
}
const rOn = rasterizeDoc(docOn, W, H)
const rOff = rasterizeDoc(docOff, W, H)
console.log('\nINTERIOR white run per row (px, widest background run between the row’s outermost ink)')
console.log('   row   source   subpix-OFF   subpix-ON')
for (let y = ROI.y; y < ROI.y + ROI.h; y++) {
  const s = runOn(img.data, y)
  const off = runOn(rOff, y)
  const on = runOn(rOn, y)
  const mark = on === 0 && off > 0 ? '   <- ON closed it' : off === 0 && on > 0 ? '   <- OFF closed it' : ''
  console.log(`  ${String(y).padStart(4)}  ${String(s).padStart(6)}  ${String(off).padStart(11)}  ${String(on).padStart(10)}${mark}`)
}

// --- the fitted nodes each side put inside the ROI ------------------------------------
// Same ROI, both docs: which NODES (and their handles) landed here. A chain that the pass
// reverted to the lattice can still be fitted differently — the fit is a DP over the whole
// chain, and the tangent pin is per-EDGE — so this separates "the samples moved" from "the
// fit moved".
const nodesIn = (doc: EditableDoc): string[] => {
  const out: string[] = []
  doc.items.forEach((item, ii) => {
    if (item.kind !== 'path') return
    item.subPaths.forEach((sp, si) => {
      sp.nodes.forEach((n, ni) => {
        if (n.x >= ROI.x && n.x <= ROI.x + ROI.w && n.y >= ROI.y && n.y <= ROI.y + ROI.h)
          out.push(
            `    item${ii}/sub${si}/node${ni} ${n.kind.padEnd(6)} (${n.x.toFixed(2)},${n.y.toFixed(2)})` +
              `  in(${n.hIn ? `${n.hIn.x.toFixed(2)},${n.hIn.y.toFixed(2)}` : '—'})` +
              `  out(${n.hOut ? `${n.hOut.x.toFixed(2)},${n.hOut.y.toFixed(2)}` : '—'})`,
          )
      })
    })
  })
  return out
}
const nOff = nodesIn(docOff)
const nOn = nodesIn(docOn)
console.log(`\nfitted nodes in ROI — subpix-OFF ${nOff.length}, subpix-ON ${nOn.length}`)
if (!argv.includes('--quiet')) {
  console.log('  OFF:')
  for (const s of nOff) console.log(s)
  console.log('  ON:')
  for (const s of nOn) console.log(s)
}

// --- optional ASCII of the three rasters ----------------------------------------------
if (argv.includes('--ascii')) {
  const glyph = (buf: Uint8ClampedArray | Uint8Array, x: number, y: number): string => {
    const i = (y * W + x) * 4
    const l = (buf[i] + buf[i + 1] + buf[i + 2]) / 3
    return l > 235 ? '.' : l > 180 ? ':' : l > 120 ? '+' : l > 70 ? '*' : '#'
  }
  console.log('\nsource | subpix-OFF | subpix-ON')
  for (let y = ROI.y; y < ROI.y + ROI.h; y++) {
    const row = [img.data, rOff, rOn].map((b) => {
      let s = ''
      for (let x = ROI.x; x < ROI.x + ROI.w; x++) s += glyph(b, x, y)
      return s
    })
    console.log(String(y).padStart(4) + ' ' + row.join('  '))
  }
}
