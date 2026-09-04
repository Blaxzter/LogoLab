// XING DIAG — at an EQUAL-STRENGTH junction, which incident arms continue one another?
//
//   node --experimental-strip-types src/devtest/xingDiag.ts                  # olympic-rings @512
//   node --experimental-strip-types src/devtest/xingDiag.ts --case ring-cross --all
//   node --experimental-strip-types src/devtest/xingDiag.ts --scales 256,512,1024,2048
//   node --experimental-strip-types src/devtest/xingDiag.ts --corpus         # exposure sweep
//
// WHY. §24.9 / docs/handoff-through-chains.md §4: the residue on `olympic-rings` is 18 arcs
// that never reach a co-circular family, and the direction worth trying is to decide
// membership from the TOPOLOGY at the junction — which incident edges are CONTINUATIONS of
// one another — rather than from each arc's own circle fit, which for a short arc is noise
// (r 18 and r 99 on a ring authored at 66.6).
//
// `planarThread.ts` (§14) already joins two arms across a junction and fits them as one
// window, but it is gated on the CONTRAST RANK: exactly two STRONG arms (ΔE ≥ 25) and every
// other arm WEAK (ΔE ≤ 12). On five saturated rings on white every arm is ΔE ≥ 60, so the
// rank has zero candidates and 0 of 46 junctions move. The open question §14 never had to
// answer is which pairing is right when three or four EQUALLY STRONG arms meet — for
// weak/strong the strong pair IS the through-pair, for free.
//
// This diag answers exactly that, and it is a MEASUREMENT, not a fix: it enumerates every
// pairing of the arms at every junction, scores each with §14's own continuity signal (the
// chord turn, plus the joined window's residual against one line / one circle), takes the
// matching tangent continuity would choose, and compares it against GROUND TRUTH — which
// arms lie on the SAME AUTHORED CIRCLE.
//
// THREE THINGS THAT ARE EASY TO GET WRONG HERE, each of which changed the answer:
//
//   1. GROUND TRUTH IS A MATCHING, NOT A PAIR. At a degree-4 crossing of two circles BOTH
//      pairings are true continuations at once (`bloom`'s triple point is exactly this).
//      Scoring one chosen pair against one "the" GT pair marks a right answer wrong.
//   2. A CANVAS-CLIP JUNCTION IS NOT A CROSSING. Where a ring runs off the raster its
//      region boundary continues ALONG the straight image edge, so "on the circle" and "on
//      the border" agree to a fraction of a pixel and read turn 0.0° exactly. olympic-rings
//      is authored tangent to its own canvas on all four sides and has 14 of them.
//   3. A SHORT ARM'S CHORD DIRECTION IS STAIRCASE NOISE. §14's MIN_ARM (6px) already says
//      so; without it `overlap`'s two 3px lens tips look like counter-evidence and are not.
//
// `olympic-rings` is stroked, so `svgGround` refuses it; its authored circles are read here
// directly off the `<circle>` elements (centre ± half the stroke width = the inner and outer
// edge of each band), which is the construction §24.8 measured with. Filled art
// (`ring-cross`, `bloom`) goes through `geomScore.authoredCircles` as usual.
//
// PURELY DIAGNOSTIC (threadDiag / ringDiag / gearDiag precedent). It reproduces threadDiag's
// FLAT-PALETTE segmentation verbatim, so the same caveat applies: art that falls through to
// the Mumford–Shah segmenter reaches the tracer with a different label map.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { segmentFlatPalette } from '../lib/trace/paletteSegment.ts'
import { buildPlanarNetwork, EXT, type PlanarNetwork } from '../lib/trace/planarNetwork.ts'
import { edgeContrast } from '../lib/trace/planarThread.ts'
import { circleMaxDev, fitCircle } from '../lib/trace/planarFit.ts'
import { lineFit } from '../lib/trace/curveFit.ts'
import { healColorSpikes } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace } from './svgGround.ts'
import { authoredCircles } from './geomScore.ts'
import { GATED_CORPUS } from './truthCorpus.ts'
import type { Vec } from '../lib/path/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  if (i < 0) return null
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const CASE = flag('--case')
const FILE = argv.find((a) => a.endsWith('.svg')) ?? 'olympic-rings.svg'
const SPAN = Number(flag('--span') ?? 12) // §14 THROUGH_SPAN
const SHOW_ALL = argv.includes('--all')
const SCALES = (flag('--scales') || String(Number(flag('--res') ?? 512))).split(',').map(Number)

// §14's own constants, re-declared here so the diag reports the gates it judges against.
const THROUGH_TURN_DEG = 20
const THROUGH_DEV = 1.2
/** §14 MIN_ARM — below this a chord direction is staircase-phase noise (§10.6's lesson). */
const MIN_ARM = 6
/** Max mean radial residual (px) for an arm or a chain to be called "on" a circle. */
const GT_BAND = 1.5

const path = CASE
  ? [
      join(root, 'public', 'examples', 'edge-cases', `${CASE}.svg`),
      join(root, 'public', 'examples', `${CASE}.svg`),
      join(root, 'examples', 'logos', `${CASE}.svg`),
    ].find((p) => {
      try {
        readFileSync(p)
        return true
      } catch {
        return false
      }
    })!
  : FILE.includes('/')
    ? join(root, FILE)
    : join(root, 'examples', 'logos', FILE)
let text = readFileSync(path, 'utf8')

const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '   —  ')

// --- authored circles, including STROKED ones --------------------------------
interface GtCircle {
  cx: number
  cy: number
  r: number
  ring: string
  side: 'inner' | 'outer' | 'fill'
}

/** A stroked `<circle>` authors TWO boundaries: r ± strokeWidth/2. */
function strokedCircles(svg: string, res: number): GtCircle[] {
  const wm = /<svg[^>]*\bwidth="([\d.]+)"/.exec(svg)
  const vb = /<svg[^>]*\bviewBox="([-\d.\s]+)"/.exec(svg)
  const srcW = vb ? Number(vb[1].trim().split(/\s+/)[2]) : wm ? Number(wm[1]) : res
  const k = res / srcW
  const out: GtCircle[] = []
  let i = 0
  for (const m of svg.matchAll(/<circle\b[^>]*>/g)) {
    const tag = m[0]
    const attr = (n: string): string | null => new RegExp(`\\b${n}="([^"]*)"`).exec(tag)?.[1] ?? null
    const before = svg.slice(0, m.index)
    // stroke-width may be inherited from an ancestor <g>; the innermost declaration before
    // the element is enough for this corpus's flat one-group files.
    const sw = attr('stroke-width') ? Number(attr('stroke-width')) : Number([...before.matchAll(/stroke-width="([\d.]+)"/g)].pop()?.[1] ?? 0)
    const cx = Number(attr('cx') ?? 0) * k
    const cy = Number(attr('cy') ?? 0) * k
    const r = Number(attr('r') ?? 0) * k
    const ring = attr('stroke') ?? attr('fill') ?? `c${i}`
    if (sw > 0 && (attr('fill') === 'none' || /fill="none"/.test(before.slice(-400)))) {
      out.push({ cx, cy, r: r - (sw * k) / 2, ring, side: 'inner' })
      out.push({ cx, cy, r: r + (sw * k) / 2, ring, side: 'outer' })
    } else {
      out.push({ cx, cy, r, ring, side: 'fill' })
    }
    i++
  }
  return out
}

/** Every authored circle, whichever way the case authors one. */
function allAuthoredCircles(res: number): GtCircle[] {
  const stroked = strokedCircles(text, res)
  if (stroked.length) return stroked
  return authoredCircles(toRasterSpace(parseGroundTruth(text), res)).map((c, i) => ({
    cx: c.cx,
    cy: c.cy,
    r: c.r,
    ring: `p${i}`,
    side: 'fill' as const,
  }))
}

// --- the flat-palette network (threadDiag's setup, verbatim) ------------------
function buildNet(res: number): { net: PlanarNetwork; contrast: Float64Array } {
  const img = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  const paletteOpts = {
    maxColors: 16,
    minShare: Math.max(0.0006, 0.006 - 0 * 0.0052 + 0.25 * 0.004),
    modePasses: 2,
    minRegionArea: Math.max(24, Math.round(0.25 * 0.25 * 800)),
    regionEvidence: true,
  }
  const fp = segmentFlatPalette(img as unknown as { width: number; height: number; data: Uint8ClampedArray }, paletteOpts, undefined)
  const labels = healColorSpikes(fp.labels, img.data as unknown as Uint8ClampedArray, img.width, img.height, fp.palette)
  const net = buildPlanarNetwork(labels, img.width, img.height)
  return { net, contrast: edgeContrast(net, fp.palette) }
}

// --- §14's arm geometry, re-implemented (the originals are module-private) ----
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
function armWindow(pts: Vec[], atEnd: boolean, span: number): Vec[] {
  const out: Vec[] = []
  let acc = 0
  const n = pts.length
  for (let k = 0; k < n; k++) {
    const p = atEnd ? pts[n - 1 - k] : pts[k]
    if (k > 0) acc += dist(out[out.length - 1], p)
    out.push({ x: p.x, y: p.y })
    if (acc >= span) break
  }
  return out
}
const armLen = (w: Vec[]): number => w.slice(1).reduce((s, p, i) => s + dist(w[i], p), 0)
function chordDir(w: Vec[]): Vec | null {
  const a = w[0]
  const b = w[w.length - 1]
  const l = dist(a, b)
  return l < 1e-9 ? null : { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
}

interface Arm {
  edge: number
  atEnd: boolean
  de: number
  len: number
  win: Vec[]
  gt: number
  gtDev: number
  border: boolean
}
interface Pair {
  i: number
  j: number
  turn: number
  lineDev: number
  circleDev: number
  isGt: boolean
}
interface Jn {
  x: number
  y: number
  arms: Arm[]
  /** Every pairing, straightest first. */
  pairs: Pair[]
  /** The matching tangent continuity picks: straightest first, each arm used once. */
  chosen: Pair[]
  /** Every pairing whose two arms are authored on ONE circle. */
  gtPairs: [number, number][]
  border: boolean
  shortArm: boolean
}

/** How far the straightest REJECTED pair sits behind the matching — the rank's decisiveness.
 *  A small margin is a coin flip, and this is the number the scale sweep has to hold. */
function marginOf(j: Jn): number {
  const rest = j.pairs.filter((p) => !j.chosen.includes(p))
  return rest.length && j.chosen.length ? rest[0].turn - j.chosen[j.chosen.length - 1].turn : Infinity
}
/** Every chosen pair is a true continuation, and every true continuation was chosen. */
function matchingCorrect(j: Jn): boolean {
  return j.chosen.every((p) => p.isGt) && j.chosen.length === j.gtPairs.length
}

function survey(res: number): { jns: Jn[]; gts: GtCircle[]; net: PlanarNetwork } {
  const { net, contrast } = buildNet(res)
  const gts = allAuthoredCircles(res)
  const cw = net.width + 1
  const inc = new Map<number, { edge: number; atEnd: boolean }[]>()
  const add = (c: number, e: { edge: number; atEnd: boolean }): void => {
    if (c < 0) return
    const a = inc.get(c)
    if (a) a.push(e)
    else inc.set(c, [e])
  }
  for (let i = 0; i < net.edges.length; i++) {
    const e = net.edges[i]
    if (e.closed) continue
    add(e.startV, { edge: i, atEnd: false })
    add(e.endV, { edge: i, atEnd: true })
  }

  const jns: Jn[] = []
  for (const corner of net.junctions) {
    const ends = inc.get(corner) ?? []
    if (ends.length < 3) continue
    const arms: Arm[] = ends.map((e) => {
      const win = armWindow(net.edges[e.edge].pts, e.atEnd, SPAN)
      let gt = -1
      let gtDev = Infinity
      for (let c = 0; c < gts.length; c++) {
        const g = gts[c]
        let s = 0
        for (const p of win) s += Math.abs(Math.hypot(p.x - g.cx, p.y - g.cy) - g.r)
        const d = s / win.length
        if (d < gtDev) {
          gtDev = d
          gt = c
        }
      }
      if (gtDev > GT_BAND) gt = -1
      const ed = net.edges[e.edge]
      return {
        edge: e.edge,
        atEnd: e.atEnd,
        de: contrast[e.edge],
        len: armLen(win),
        win,
        gt,
        gtDev,
        border: ed.left === EXT || ed.right === EXT,
      }
    })

    const gtPairs: [number, number][] = []
    for (let a = 0; a < arms.length; a++)
      for (let b = a + 1; b < arms.length; b++) if (arms[a].gt >= 0 && arms[a].gt === arms[b].gt) gtPairs.push([a, b])

    const pairs: Pair[] = []
    for (let a = 0; a < arms.length; a++) {
      for (let b = a + 1; b < arms.length; b++) {
        const wa = arms[a].win
        const wb = arms[b].win
        const ta = chordDir(wa)
        const tb = chordDir(wb)
        if (!ta || !tb) continue
        const d = Math.max(-1, Math.min(1, ta.x * tb.x + ta.y * tb.y))
        const turn = 180 - (Math.acos(d) * 180) / Math.PI
        const win = [...wa].reverse().concat(wb.slice(1))
        const lf = win.length >= 5 ? lineFit(win) : null
        pairs.push({
          i: a,
          j: b,
          turn,
          lineDev: lf ? lf.maxDev : Infinity,
          circleDev: (win.length >= 5 ? circleMaxDev(win) : null) ?? Infinity,
          isGt: gtPairs.some((g) => g[0] === a && g[1] === b),
        })
      }
    }
    pairs.sort((p, q) => p.turn - q.turn)
    // What tangent continuity CHOOSES: straightest first, each arm used once. RANK only —
    // no absolute threshold, which is the point (see the scale sweep).
    const used = new Set<number>()
    const chosen: Pair[] = []
    for (const p of pairs) {
      if (used.has(p.i) || used.has(p.j)) continue
      used.add(p.i)
      used.add(p.j)
      chosen.push(p)
    }
    jns.push({
      x: corner % cw,
      y: (corner / cw) | 0,
      arms,
      pairs,
      chosen,
      gtPairs,
      border: arms.some((a) => a.border),
      shortArm: Math.min(...arms.map((a) => a.len)) < MIN_ARM,
    })
  }
  return { jns, gts, net }
}

// --- through-chains ----------------------------------------------------------
// Walk the chosen matchings into chains: the object a RING would arrive as if membership
// came from the topology instead of from each arc's own circle fit.
interface Chain {
  edges: number[]
  pts: Vec[]
  sweep: number
  gt: number
  gtDev: number
  fit: { cx: number; cy: number; r: number } | null
}
function buildChains(jns: Jn[], net: PlanarNetwork, gts: GtCircle[]): Chain[] {
  const key = (edge: number, atEnd: boolean): number => edge * 2 + (atEnd ? 1 : 0)
  const link = new Map<number, number>()
  for (const j of jns) {
    if (j.border || j.shortArm) continue
    for (const p of j.chosen) {
      const a = j.arms[p.i]
      const b = j.arms[p.j]
      link.set(key(a.edge, a.atEnd), key(b.edge, b.atEnd))
      link.set(key(b.edge, b.atEnd), key(a.edge, a.atEnd))
    }
  }
  const isBorder = (e: number): boolean => net.edges[e].left === EXT || net.edges[e].right === EXT
  const seen = new Set<number>()
  const out: Chain[] = []
  for (let e0 = 0; e0 < net.edges.length; e0++) {
    // The canvas frame is not art: an edge against EXT is the raster's own boundary.
    if (seen.has(e0) || net.edges[e0].closed || isBorder(e0)) continue
    // Walk back to a free end (or all the way round a cycle), then forward from there.
    let cur = key(e0, false)
    const guard = new Set<number>()
    while (link.has(cur) && !guard.has(cur)) {
      guard.add(cur)
      const nxt = link.get(cur)!
      const ne = nxt >> 1
      if (ne === e0 && guard.size > 1) break
      cur = key(ne, (nxt & 1) === 0)
    }
    const chain: number[] = []
    const pts: Vec[] = []
    for (let n = 0; n < net.edges.length + 2; n++) {
      const edge = cur >> 1
      if (seen.has(edge)) break
      seen.add(edge)
      chain.push(edge)
      const ep = net.edges[edge].pts
      for (const p of (cur & 1) === 1 ? [...ep].reverse() : ep) pts.push(p)
      const nxt = link.get(key(edge, (cur & 1) === 0))
      if (nxt === undefined) break
      cur = nxt
    }
    if (!pts.length) continue
    let gt = -1
    let gtDev = Infinity
    for (let c = 0; c < gts.length; c++) {
      const g = gts[c]
      let s = 0
      for (const p of pts) s += Math.abs(Math.hypot(p.x - g.cx, p.y - g.cy) - g.r)
      const d = s / pts.length
      if (d < gtDev) {
        gtDev = d
        gt = c
      }
    }
    const fit = fitCircle(pts)
    // Angular sweep about the fitted centre, summed step by step so an arc past ±π adds up.
    let sweep = 0
    if (fit) {
      for (let i = 1; i < pts.length; i++) {
        const a0 = Math.atan2(pts[i - 1].y - fit.cy, pts[i - 1].x - fit.cx)
        const a1 = Math.atan2(pts[i].y - fit.cy, pts[i].x - fit.cx)
        let d = a1 - a0
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        sweep += d
      }
    }
    out.push({ edges: chain, pts, sweep: (Math.abs(sweep) * 180) / Math.PI, gt, gtDev, fit })
  }
  return out
}

// --- --corpus: how much of the rest of the corpus this rule would TOUCH ------
// The pairing being right on rings says nothing about art with no rings in it. This is the
// exposure count: every junction the rule would chain, per case, over §14's own admissible
// population (degree ≥3, every arm ≥ MIN_ARM), plus the rank margin.
if (argv.includes('--corpus')) {
  const MARGIN = 30
  const RES = Number(flag('--res') ?? 512)
  console.log(`\n━━━ EXPOSURE @${RES} — junctions a rank-with-margin rule would chain (margin ≥ ${MARGIN}°) ━━━`)
  console.log(`  'usable' drops canvas-clip and short-arm (< ${MIN_ARM}px) junctions; 'GT ok' scores the CHOSEN`)
  console.log(`  MATCHING against the co-circular one, where the art authors circles at all.\n`)
  console.log(`  ${'case'.padEnd(22)}${'jn'.padStart(5)}${'usable'.padStart(8)}${'chained'.padStart(9)}${'GT ok'.padStart(9)}${'minMargin'.padStart(11)}`)
  let gOk = 0
  let gAll = 0
  for (const c of GATED_CORPUS.filter((x) => x.tier === 0 && !x.gradients)) {
    text = readFileSync(join(root, c.svg), 'utf8')
    let jns: Jn[]
    try {
      ;({ jns } = survey(RES))
    } catch (e) {
      console.log(`  ${c.name.padEnd(22)} failed: ${(e as Error).message}`)
      continue
    }
    const usable = jns.filter((j) => !j.border && !j.shortArm)
    const admitted = usable.filter((j) => marginOf(j) >= MARGIN)
    const withGt = usable.filter((j) => j.gtPairs.length)
    const ok = withGt.filter(matchingCorrect).length
    gOk += ok
    gAll += withGt.length
    const margins = admitted.map(marginOf)
    console.log(
      `  ${c.name.padEnd(22)}${String(jns.length).padStart(5)}${String(usable.length).padStart(8)}${String(admitted.length).padStart(9)}` +
        `${(withGt.length ? `${ok}/${withGt.length}` : '    —').padStart(9)}${f(margins.length ? Math.min(...margins) : NaN, 1).padStart(11)}`,
    )
  }
  console.log(`\n  chosen matching correct on ${gOk}/${gAll} junctions of circle-bearing art\n`)
  process.exit(0)
}

for (const RES of SCALES) {
  const { jns, gts, net } = survey(RES)
  console.log(`\n━━━ ${CASE ?? FILE} @ ${RES}px ━━━ ${net.edges.length} edges, ${net.junctions.length} junctions, span ${SPAN}px\n`)

  if (SCALES.length === 1) {
    console.log('  AUTHORED CIRCLES (raster space — a stroked circle authors two):')
    for (let i = 0; i < gts.length; i++)
      console.log(`    #${String(i).padStart(2)}  ${gts[i].ring.padEnd(9)} ${gts[i].side.padEnd(6)} c=(${f(gts[i].cx, 1)},${f(gts[i].cy, 1)})  r=${f(gts[i].r, 2)}`)

    console.log('\n  JUNCTIONS of degree ≥3 — every pairing, straightest first (turn 0° = runs straight through)')
    for (const j of jns) {
      const tag = j.border ? ' [canvas clip]' : j.shortArm ? ` [arm < ${MIN_ARM}px]` : ''
      const gtTxt = j.gtPairs.length ? j.gtPairs.map((g) => `${g[0]}+${g[1]}`).join(',') : 'none'
      const ok = !j.gtPairs.length ? '· no GT' : matchingCorrect(j) ? '✓ MATCHES GT' : '✗ WRONG'
      console.log(
        `\n  (${String(j.x).padStart(3)},${String(j.y).padStart(3)}) deg ${j.arms.length}${tag}   GT ${gtTxt.padEnd(10)}` +
          ` chose ${j.chosen
            .map((p) => `${p.i}+${p.j}`)
            .join(',')
            .padEnd(10)} ${ok}  margin ${f(marginOf(j), 1)}°`,
      )
      if (SHOW_ALL || !matchingCorrect(j)) {
        console.log('      arm  edge  ΔE     armPx   authored circle (mean resid)')
        for (let a = 0; a < j.arms.length; a++) {
          const m = j.arms[a]
          const g = m.gt >= 0 ? `#${m.gt} ${gts[m.gt].ring} ${gts[m.gt].side}  (${f(m.gtDev)}px)` : `none (nearest ${f(m.gtDev)}px)`
          console.log(`      ${String(a).padStart(3)}  ${String(m.edge).padStart(4)}  ${Number.isFinite(m.de) ? f(m.de, 1).padStart(5) : '    ∞'}  ${f(m.len, 1).padStart(6)}   ${g}`)
        }
      }
      console.log('      pair    turn°   lineDev  circDev   §14 gates')
      for (const p of j.pairs) {
        const dev = Math.min(p.lineDev, p.circleDev)
        const gate = p.turn <= THROUGH_TURN_DEG ? (dev <= THROUGH_DEV ? 'through ✓' : `dev ${f(dev)} > ${THROUGH_DEV}`) : 'corner'
        console.log(
          `      ${p.i}+${p.j}   ${f(p.turn, 1).padStart(6)}   ${f(p.lineDev).padStart(6)}   ${f(p.circleDev).padStart(6)}   ${gate.padEnd(16)}` +
            `${j.chosen.includes(p) ? ' ← chose' : ''}${p.isGt ? ' GT' : ''}`,
        )
      }
    }
  }

  // --- the summary that decides whether this direction is real ---------------
  const usable = jns.filter((j) => !j.border && !j.shortArm && j.gtPairs.length)
  const clip = jns.filter((j) => j.border && j.gtPairs.length)
  const short = jns.filter((j) => !j.border && j.shortArm && j.gtPairs.length)
  const right = usable.filter(matchingCorrect)
  const margins = usable.map(marginOf).sort((a, b) => a - b)
  const gtTurns = usable.flatMap((j) => j.pairs.filter((p) => p.isGt).map((p) => p.turn)).sort((a, b) => a - b)
  const offTurns = usable.flatMap((j) => j.pairs.filter((p) => !p.isGt).map((p) => p.turn)).sort((a, b) => a - b)
  const q = (a: number[], t: number): number => a[Math.min(a.length - 1, Math.floor(t * a.length))]
  console.log(`\n  ══ @${RES}: ${jns.length} junctions deg≥3 — ${usable.length} usable (${clip.length} canvas-clip, ${short.length} short-arm set aside)`)
  console.log(`     CHOSEN MATCHING CORRECT:      ${right.length}/${usable.length}`)
  console.log(`     margin over the straightest REJECTED pair:  MIN ${f(margins[0], 1)}°  p50 ${f(q(margins, 0.5), 1)}°`)
  console.log(`     true continuation turn°:  min ${f(gtTurns[0], 1)}  p50 ${f(q(gtTurns, 0.5), 1)}  MAX ${f(gtTurns[gtTurns.length - 1], 1)}`)
  console.log(`     real corner       turn°:  MIN ${f(offTurns[0], 1)}  p50 ${f(q(offTurns, 0.5), 1)}  max ${f(offTurns[offTurns.length - 1], 1)}`)
  const sep = offTurns[0] - gtTurns[gtTurns.length - 1]
  console.log(
    `     separation: ${f(sep, 1)}°` +
      (sep > 0
        ? ` — a threshold DOES separate them here: THROUGH_TURN_DEG=${THROUGH_TURN_DEG} sits ${f(THROUGH_TURN_DEG / gtTurns[gtTurns.length - 1], 2)}× above the worst continuation, ${f(offTurns[0] / THROUGH_TURN_DEG, 2)}× below the tightest corner`
        : ' — OVERLAP: no absolute threshold separates them, only the rank does'),
  )
  const vetoed = usable.filter((j) => j.chosen.some((p) => p.isGt && p.turn > THROUGH_TURN_DEG)).length
  console.log(`     true continuations §14 would VETO at turn > ${THROUGH_TURN_DEG}°: ${vetoed}`)
  console.log(`     canvas-clip junctions, matching correct: ${clip.filter(matchingCorrect).length}/${clip.length}`)

  // --- what the pairing BUILDS: does a ring arrive as one object? ------------
  const chains = buildChains(jns, net, gts)
  const multi = chains.filter((c) => c.edges.length > 1)
  console.log('\n  ── THROUGH-CHAINS from the chosen matchings (clip and short-arm junctions not chained)')
  console.log(
    `     ${net.edges.filter((e) => !e.closed && e.left !== EXT && e.right !== EXT).length} interior open edges → ${chains.length} chains (${multi.length} of more than one edge)`,
  )
  console.log(`     ${'chain'.padStart(6)}${'edges'.padStart(7)}${'pts'.padStart(6)}${'sweep°'.padStart(9)}${'fitted r'.padStart(10)}${'authored'.padStart(26)}${'meanDev'.padStart(9)}`)
  for (const c of chains.slice().sort((a, b) => b.sweep - a.sweep)) {
    const g = c.gt >= 0 && c.gtDev <= GT_BAND ? `#${c.gt} ${gts[c.gt].ring} ${gts[c.gt].side}` : 'not on an authored circle'
    console.log(
      `     ${String(chains.indexOf(c)).padStart(6)}${String(c.edges.length).padStart(7)}${String(c.pts.length).padStart(6)}` +
        `${f(c.sweep, 0).padStart(9)}${f(c.fit ? c.fit.r : NaN, 2).padStart(10)}${g.padStart(26)}${f(c.gtDev).padStart(9)}`,
    )
  }
  // Per AUTHORED CIRCLE: fit the union of every chain on it, the object the §24 family pass
  // is trying to build. Two fits, because they answer different questions — the ALGEBRAIC
  // (Kåsa) fit the tracer uses is biased on a partial arc, so if the centre error is fit
  // bias a GEOMETRIC refit removes it, and if it survives the refit the evidence itself is
  // displaced and no fit will help.
  type Circ = { cx: number; cy: number; r: number }
  const geo = (pts: Vec[]): Circ | null => {
    const seed = fitCircle(pts)
    if (!seed) return null
    let c: Circ = seed
    // Landau's fixed point for the GEOMETRIC fit: r <- mean|p-c|, c <- mean(p) - r*mean(u).
    // It minimises the true orthogonal residual, where `fitCircle` minimises the ALGEBRAIC
    // one and is biased on a partial arc — which is exactly the hypothesis under test.
    const n = pts.length
    let mx = 0
    let my = 0
    for (const p of pts) {
      mx += p.x
      my += p.y
    }
    mx /= n
    my /= n
    for (let it = 0; it < 200; it++) {
      let sx = 0
      let sy = 0
      let sr = 0
      for (const p of pts) {
        const dx = p.x - c.cx
        const dy = p.y - c.cy
        const d = Math.hypot(dx, dy) || 1e-9
        sx += dx / d
        sy += dy / d
        sr += d
      }
      const r = sr / n
      const next: Circ = { cx: mx - (r * sx) / n, cy: my - (r * sy) / n, r }
      const move = Math.hypot(next.cx - c.cx, next.cy - c.cy)
      c = next
      if (move < 1e-10) break
    }
    return c
  }
  console.log(`\n  ── PER AUTHORED CIRCLE — the union of its chains, fitted two ways`)
  console.log(`     ${'authored'.padStart(24)}${'chains'.padStart(8)}${'cover°'.padStart(8)}${'Kåsa |Δc|'.padStart(11)}${'Δr'.padStart(8)}${'geo |Δc|'.padStart(10)}${'Δr'.padStart(8)}`)
  for (let g = 0; g < gts.length; g++) {
    const mine = chains.filter((c) => c.gt === g && c.gtDev <= GT_BAND)
    if (!mine.length) continue
    const pts = mine.flatMap((c) => c.pts)
    const k = fitCircle(pts)
    const gg = geo(pts)
    const cover = mine.reduce((s, c) => s + c.sweep, 0)
    const e = (c: Circ | null): string =>
      c ? `${f(Math.hypot(c.cx - gts[g].cx, c.cy - gts[g].cy)).padStart(11)}${f(c.r - gts[g].r).padStart(8)}` : '     —         —  '
    console.log(`     ${`#${g} ${gts[g].ring} ${gts[g].side}`.padStart(24)}${String(mine.length).padStart(8)}${f(cover, 0).padStart(8)}${e(k)}${e(gg)}`)
  }

  const onCircle = chains.filter((c) => c.gtDev <= GT_BAND)
  const perGt = new Map<number, number>()
  for (const c of onCircle) perGt.set(c.gt, (perGt.get(c.gt) ?? 0) + 1)
  console.log(`\n     chains lying on ONE authored circle: ${onCircle.length}/${chains.length}`)
  console.log(`     authored circles delivered by exactly ONE chain: ${[...perGt.values()].filter((v) => v === 1).length} of ${gts.length}`)
  // The conditioning claim. §24.8's whole blocker is that a short arc's own circle fit is
  // noise; if chaining does not fix THAT, it has not touched the problem.
  const good = multi.filter((c) => c.gtDev <= GT_BAND)
  if (good.length) {
    const chainErr = good.map((c) => Math.abs((c.fit?.r ?? NaN) - gts[c.gt].r))
    const memberErr: number[] = []
    for (const c of good)
      for (const e of c.edges) {
        const fe = fitCircle(net.edges[e].pts)
        if (fe) memberErr.push(Math.abs(fe.r - gts[c.gt].r))
      }
    console.log(
      `     |fitted r − authored r| — the CHAIN: max ${f(Math.max(...chainErr))}px over ${chainErr.length} chains;` +
        `  its member EDGES alone: max ${f(Math.max(...memberErr))}px over ${memberErr.length} edges`,
    )
  }
}
console.log()
