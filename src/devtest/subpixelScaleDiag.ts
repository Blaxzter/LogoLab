// SUB-PIXEL PASS ACROSS RESOLUTIONS — issue #38 Phase 0 (benchmarks §30).
//
//   node --experimental-strip-types src/devtest/subpixelScaleDiag.ts                    # the three coarse-end scale KNOWN_DEFECTS
//   node --experimental-strip-types src/devtest/subpixelScaleDiag.ts overlap --res 256,1024
//   node --experimental-strip-types src/devtest/subpixelScaleDiag.ts band-cross --edges  # per-edge table
//
// §15.7 left three scale-gate cases (`overlap`, `aa-seam`, `band-cross` @256) with a written
// cause: "the @256 lane's AA is too wide relative to the guards' sampling geometry for the
// displacement to survive its own safety checks". counterDiag.ts already dumps every chain
// point's outcome for a ROI; this is the same hook (`SubpixelDiag`, so there is no second
// copy of the estimator) tabulated WHOLE-IMAGE per resolution, so the written cause can be
// checked instead of believed:
//
//  1. THE HISTOGRAM — per lane, how many chain points moved, and which guard declined the
//     rest (label / contrast / flatness / residual / monotone / |δ| cap), plus the corner
//     self-guard's reverts, which fire AFTER the estimate and are counted separately.
//  2. WHAT THE SURVIVING DISPLACEMENT IS WORTH — for cases whose answer sheet is analytic
//     (overlap: two circles; aa-seam: a circle and a line) the per-point distance to the
//     authored primitive before and after the move, by outcome, in the lane's OWN px. One
//     counterfactual rides along: the corner-reverted points at the δ the estimator gave
//     them, which bounds what removing that guard could buy.
//  3. THE ATTRIBUTION — the lattice chain, the displaced chain (exactly what the fitter is
//     handed), and the fitted output with the pass off and on, each scored against the
//     authored SVG with the scale gate's own arithmetic (scaleScore.ts: native px, and the
//     finest lane's reference px) — so "the samples moved" and "the fit kept it" are two
//     numbers, not one.
//
// Measurement traps, inherited: no rasterizeDoc of a scaled doc (geometry-only, scaleScore's
// rule); the chamfer is quoted next to a per-point mean because the two disagree by design
// (chamfer samples both boundaries; the per-point mean is over chain vertices only).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry } from './geomScore.ts'
import { scaleDoc, latticeDoc, SCALE_DRIFT_MAX, SCALE_SIGNAL_FLOOR } from './scaleScore.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import { subpixelEdgeChains, type SubpixelDiagRecord } from '../lib/trace/planarSubpixel.ts'
import type { EditableDoc, SubPath } from '../lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  if (!argv.includes(name)) return null
  const v = argv[argv.indexOf(name) + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const RES = (flag('--res') ?? '256,512,1024').split(',').map(Number).sort((a, b) => a - b)
const REF = RES[RES.length - 1]
const EDGES = argv.includes('--edges')
const flagValues = new Set(['--res'].map((f) => flag(f)).filter((v): v is string => v !== null && v !== ''))
const named = argv.filter((a) => !a.startsWith('--') && !flagValues.has(a))
const CASES = named.length ? named : ['overlap', 'aa-seam', 'band-cross']

/** The estimator's outcomes in the order the pass checks them (corner-revert is separate). */
const OUTCOMES = ['moved', 'label-left', 'label-right', 'contrast', 'flat-left', 'flat-right', 'residual', 'monotone', 'max-disp', 'zero', 'degenerate-tangent']

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

/** One row per chain point (counterDiag's collapse: the revert windows overlap, so the raw
 *  stream repeats indices). `outcome` is the ESTIMATOR's verdict; `reverted` is the corner
 *  self-guard's, applied afterwards. */
function collapse(recs: SubpixelDiagRecord[]): PointRow[] {
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
  return [...byPoint.values()]
}

const chainsDoc = (chains: { closed: boolean; pts: { x: number; y: number }[] }[], w: number, h: number): EditableDoc => ({
  viewBox: [0, 0, w, h],
  items: [
    {
      kind: 'path',
      id: 'chains',
      fill: '#000000',
      fillRule: 'nonzero',
      visible: true,
      subPaths: chains.map(
        (e): SubPath => ({ closed: e.closed, nodes: e.pts.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const })) }),
      ),
    },
  ],
})

const pct = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(1)}%` : '–')
const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN)
const p95 = (a: number[]): number => {
  const b = [...a].sort((x, y) => x - y)
  return b.length ? b[Math.min(b.length - 1, Math.floor(0.95 * b.length))] : NaN
}

/** Analytic answer sheets, in the 256 viewBox the fixtures are authored in. Only cases whose
 *  every visible boundary is one of these primitives belong here. */
function primitives(name: string, k: number): ((x: number, y: number) => number)[] {
  const circle = (cx: number, cy: number, r: number) => (x: number, y: number) => Math.abs(Math.hypot(x - cx * k, y - cy * k) - r * k)
  const line = (ax: number, ay: number, bx: number, by: number) => {
    const L = Math.hypot((bx - ax) * k, (by - ay) * k)
    return (x: number, y: number) => Math.abs((bx - ax) * k * (y - ay * k) - (by - ay) * k * (x - ax * k)) / L
  }
  if (name === 'overlap') return [circle(107, 128, 61), circle(148, 128, 61)]
  if (name === 'aa-seam') return [circle(128, 128, 23), line(0, 64, 256, 204.8)]
  return []
}

for (const name of CASES) {
  const svgPath = name === 'petals' ? 'public/examples/petals.svg' : `public/examples/edge-cases/${name}.svg`
  const svg = readFileSync(join(root, svgPath), 'utf8')
  const gt = parseGroundTruth(svg)
  const why = unscorable(gt)
  if (why) {
    console.log(`${name}: unscorable (${why})`)
    continue
  }
  const refImg = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: REF }, background: 'white' }).render().asPng())
  const gtRef = toRasterSpace(gt, refImg.width)

  console.log(`\n=== ${name} ===`)
  const laneRef: { res: number; lattice: number; displaced: number; fitOff: number; fitOn: number }[] = []
  for (const res of RES) {
    const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
    const W = img.width
    const H = img.height
    let raw: { labels: Int32Array; width: number; height: number } | null = null
    const trace = (subpixelEdges: boolean): Promise<EditableDoc> =>
      traceImage(
        img as unknown as ImageData,
        { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, planarFit: { subpixelEdges } },
        undefined,
        undefined,
        undefined,
        undefined,
        (l) => {
          raw = l
        },
      )
    const docOn = await trace(true)
    const docOff = await trace(false)
    if (!raw) throw new Error('no label map — the planar engine did not run')
    const rr = raw as { labels: Int32Array; width: number; height: number }
    const net = buildPlanarNetwork(rr.labels, W, H)
    const recs: SubpixelDiagRecord[] = []
    const displacedMap = subpixelEdgeChains(net, rr.labels, { data: img.data, width: W, height: H }, (r) => recs.push(r))
    const rows = collapse(recs)
    const n = rows.length

    // --- 1. the histogram ---------------------------------------------------------------
    const tally = new Map<string, number>()
    let reverted = 0
    let surviving = 0
    for (const r of rows) {
      tally.set(r.outcome, (tally.get(r.outcome) ?? 0) + 1)
      if (r.reverted) reverted++
      if (r.outcome === 'moved' && !r.reverted) surviving++
    }
    console.log(`\n@${res}  ${W}×${H}  chain points ${n} on ${net.edges.filter((e) => e.pts.length >= 3).length} edges`)
    console.log('  estimator: ' + OUTCOMES.map((o) => `${o} ${tally.get(o) ?? 0} (${pct(tally.get(o) ?? 0, n)})`).join('  '))
    console.log(`  corner-revert (after the estimate, any outcome): ${reverted} (${pct(reverted, n)})   → SURVIVING moved: ${surviving} (${pct(surviving, n)})`)

    const bins = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.75, 1, 1.5, 2, Infinity]
    const hist = (vals: number[]): number[] => {
      const c = new Array<number>(bins.length).fill(0)
      for (const v of vals) c[bins.findIndex((b) => Math.abs(v) <= b)]++
      return c
    }
    const movedD = rows.filter((r) => r.outcome === 'moved' && !r.reverted).map((r) => Math.abs(r.delta))
    const capD = rows.filter((r) => r.outcome === 'max-disp').map((r) => Math.abs(r.delta))
    console.log(`  |δ| bins ≤ ${bins.slice(0, -1).join(' ')} >2`)
    console.log(`    moved (${movedD.length}, mean|δ| ${mean(movedD).toFixed(3)}):  ${hist(movedD).join(' ')}`)
    console.log(`    max-disp (${capD.length}, mean|δ| ${mean(capD).toFixed(3)}):  ${hist(capD).join(' ')}`)

    if (EDGES) {
      const byEdge = new Map<number, PointRow[]>()
      for (const r of rows) {
        let a = byEdge.get(r.edgeId)
        if (!a) byEdge.set(r.edgeId, (a = []))
        a.push(r)
      }
      console.log('  per edge:  id  L/R    pts  moved  revert  flat  resid  maxd  zero  label  mean|δ|(moved)')
      for (const [id, rs] of [...byEdge.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const e = net.edges.find((x) => x.id === id)!
        const c = (o: string): number => rs.filter((r) => r.outcome === o).length
        const mv = rs.filter((r) => r.outcome === 'moved' && !r.reverted)
        console.log(
          `    ${String(id).padStart(4)}  ${String(e.left).padStart(2)}/${String(e.right).padEnd(2)} ${String(rs.length).padStart(6)}  ${String(mv.length).padStart(5)}  ` +
            `${String(rs.filter((r) => r.reverted).length).padStart(6)}  ${String(c('flat-left') + c('flat-right')).padStart(4)}  ${String(c('residual')).padStart(5)}  ` +
            `${String(c('max-disp')).padStart(4)}  ${String(c('zero')).padStart(4)}  ${String(c('label-left') + c('label-right')).padStart(5)}  ${mean(mv.map((r) => Math.abs(r.delta))).toFixed(3)}`,
        )
      }
    }

    // --- 2. what the surviving displacement is worth (analytic cases) -----------------
    const prims = primitives(name, W / 256)
    if (prims.length) {
      const dist = (x: number, y: number): number => Math.min(...prims.map((f) => f(x, y)))
      const groups: Record<string, { before: number[]; after: number[] }> = {}
      const cf: number[] = [] // the reverted points, had they kept the estimator's δ
      for (const r of rows) {
        const g = r.reverted ? 'reverted' : r.outcome
        const o = (groups[g] ??= { before: [], after: [] })
        o.before.push(dist(r.x, r.y))
        const kept = r.outcome === 'moved' && !r.reverted
        o.after.push(kept ? dist(r.x + r.delta * r.nx, r.y + r.delta * r.ny) : dist(r.x, r.y))
        if (r.reverted) cf.push(r.outcome === 'moved' ? dist(r.x + r.delta * r.nx, r.y + r.delta * r.ny) : dist(r.x, r.y))
      }
      console.log('  |point − authored primitive| native px, by outcome:     n   before mean/p95   after mean/p95')
      for (const [g, o] of Object.entries(groups).sort((a, b) => b[1].before.length - a[1].before.length))
        console.log(`    ${g.padEnd(14)} ${String(o.before.length).padStart(6)}   ${mean(o.before).toFixed(3)} / ${p95(o.before).toFixed(3)}       ${mean(o.after).toFixed(3)} / ${p95(o.after).toFixed(3)}`)
      if (cf.length) console.log(`    counterfactual — the ${cf.length} reverted points at the estimator's own δ: ${mean(cf).toFixed(3)} / ${p95(cf).toFixed(3)}`)
    }

    // --- 3. attribution: chain vs fit, native and reference px ------------------------
    const s = refImg.width / W
    const latDoc = latticeDoc(rr.labels, W, H)
    const dispDoc = chainsDoc(net.edges.map((e) => ({ closed: e.closed, pts: displacedMap.get(e.id) ?? e.pts })), W, H)
    const gtNat = toRasterSpace(gt, W)
    const nat = (d: EditableDoc) => scoreGeometry(gtNat, d, W, H, img)
    const ref = (d: EditableDoc) => scoreGeometry(gtRef, scaleDoc(d, s), refImg.width, refImg.height, refImg)
    const table = [
      ['lattice chain', nat(latDoc), ref(latDoc)],
      ['displaced chain', nat(dispDoc), ref(dispDoc)],
      ['fitted, pass OFF', nat(docOff), ref(docOff)],
      ['fitted, pass ON', nat(docOn), ref(docOn)],
    ] as const
    console.log(`  vs AUTHORED (chamfer / p95):      native px            ref px @${REF}`)
    for (const [lbl, a, b] of table) console.log(`    ${lbl.padEnd(18)} ${a.chamfer.toFixed(3)} / ${a.p95.toFixed(3)}        ${b.chamfer.toFixed(3)} / ${b.p95.toFixed(3)}`)
    laneRef.push({ res, lattice: table[0][2].chamfer, displaced: table[1][2].chamfer, fitOff: table[2][2].chamfer, fitOn: table[3][2].chamfer })
  }

  // The gate's own reading, coarsest vs finest, with and without the pass.
  const c = laneRef[0]
  const f = laneRef[laneRef.length - 1]
  const gated = (coarse: number, fine: number): string => `${(coarse / Math.max(fine, SCALE_SIGNAL_FLOOR)).toFixed(2)}×`
  console.log(`\n  gate @${c.res} vs @${f.res} (coarse ≤ ${SCALE_DRIFT_MAX} · max(fine, ${SCALE_SIGNAL_FLOOR}) ref-px):`)
  console.log(`    pass ON   ${gated(c.fitOn, f.fitOn)}  (${c.fitOn.toFixed(3)} → ${f.fitOn.toFixed(3)})     pass OFF  ${gated(c.fitOff, f.fitOff)}  (${c.fitOff.toFixed(3)} → ${f.fitOff.toFixed(3)})`)
  console.log(`    displaced chain ${gated(c.displaced, f.displaced)}  (${c.displaced.toFixed(3)} → ${f.displaced.toFixed(3)})     lattice chain ${gated(c.lattice, f.lattice)}  (${c.lattice.toFixed(3)} → ${f.lattice.toFixed(3)})`)
  console.log(`    the coarse lane must reach ≤ ${(SCALE_DRIFT_MAX * Math.max(f.fitOn, SCALE_SIGNAL_FLOOR)).toFixed(3)} ref-px = ${((SCALE_DRIFT_MAX * Math.max(f.fitOn, SCALE_SIGNAL_FLOOR) * c.res) / f.res).toFixed(4)} native px @${c.res}`)
}
