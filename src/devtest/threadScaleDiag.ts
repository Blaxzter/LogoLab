// THREAD SCALE DIAG — the PAIRED per-junction census issue #14 asked for before any fix.
//
//   node --experimental-strip-types src/devtest/threadScaleDiag.ts                 # band-cross
//   node --experimental-strip-types src/devtest/threadScaleDiag.ts --case seam-corner
//   node --experimental-strip-types src/devtest/threadScaleDiag.ts --res 256,512,1024,2048 --k 2
//
// WHY. The audit measured that the §14 contrast rank reads the SAME authored junction's
// chord turn as 21.4° @256 and 7.1° @2048 (THROUGH_SPAN is 12px of raw lattice at every
// raster, so at 256 it covers twice the art). §0.1 re-measured the consequence: the junction
// is no longer DROPPED at the coarse end — §17 catches it on the apex branch — so the defect
// is now "the same art is routed down a different branch depending on the raster". Whether
// that is WRONG, and by how much, was never measured: `threadDiag` prints one raster's
// verdicts, and the junction POPULATION differs per raster, so its rates are not a paired
// comparison. This is the paired one.
//
// WHAT IT DOES. For one authored case, at every raster: the production flat-palette pipeline
// up to the survey (threadDiag's lines, verbatim), then `surveyJunctions` THREE ways —
//   HEAD     the shipped constants (span 12 / dev 1.2);
//   SCALED   span·(res/512), dev·(res/512) — the issue's literal prescription, with the
//            audit's tripwire honoured (THROUGH_DEV scales WITH the span);
//   WIDE     span·K (K = --k, default 2), the second window of the two-window hypothesis:
//            an arc's chord turn grows in proportion to the window, a corner's does not,
//            so turn(WIDE)/turn(HEAD) is scale-invariant by construction.
// Every junction is keyed by its position in the 512-px ARTWORK space and paired across
// rasters; every placement is scored as its distance off the AUTHORED strong boundary (the
// shapes painted in the mark's own colour — the band seams are the weak boundaries and are
// deliberately NOT ground truth here, since the along-seam position is free, §14.2), in
// artwork px, so the lanes are comparable. Ground truth also says what the boundary IS at
// each junction: a line, an arc (with its radius), or a corner.
//
// WHAT TO READ. Per paired junction, per raster: the branch each survey took and the error
// each placement carries, next to the lattice corner's own error (what NOT moving costs).
// The bottom table folds it: if HEAD's error is flat across rasters the branch flip is
// harmless and the issue closes as measured-inert; if it climbs at the coarse end, the
// column that fixes it says which shape the fix should take.
//
// PURELY DIAGNOSTIC — no gate, no fix, no production behaviour change (`tune` is undefined
// in production and `surveyJunctions` is byte-identical without it).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { segmentFlatPalette } from '../lib/trace/paletteSegment.ts'
import { buildPlanarNetwork } from '../lib/trace/planarNetwork.ts'
import { edgeContrast, surveyJunctions, type JunctionVerdict } from '../lib/trace/planarThread.ts'
import { healColorSpikes } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, type GroundShape } from './svgGround.ts'
import { sharpCorners } from './geomScore.ts'
import type { SubPath, Vec } from '../lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (n: string): string | null => {
  const i = argv.indexOf(n)
  if (i < 0) return null
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const LOGO = flag('--logo')
const CASE = LOGO || flag('--case') || 'band-cross'
const RESOLUTIONS = (flag('--res') || '256,512,1024,2048').split(',').map(Number).filter(Number.isFinite)
const K = Number(flag('--k') || 2)
/** The reference (artwork) space every lane is compared in. */
const REF = 512
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '—')

// A fixture from edge-cases, or (--logo name) a mark from the private gallery corpus. On a
// real mark the band seams are POSTERIZATION of an authored gradient — they exist in the
// raster only, never in the SVG — so every authored shape is strong ground truth there.
const svgText = readFileSync(
  LOGO ? join(root, 'examples', 'logos', `${LOGO.replace(/\.svg$/, '')}.svg`) : join(root, 'public', 'examples', 'edge-cases', `${CASE}.svg`),
  'utf8',
)
const gt = parseGroundTruth(svgText)

// --- ground truth: the STRONG shapes, and what the boundary is at a point -------------------

/** The mark's own ink: every fill that is not one of the light band colours. For the
 *  fixtures this is the navy the §14 rank calls STRONG (ΔE ≥ 25 against every band). */
function strongShapes(shapes: GroundShape[]): GroundShape[] {
  if (LOGO) return shapes
  const counts = new Map<string, number>()
  for (const s of shapes) counts.set(s.fill ?? '', (counts.get(s.fill ?? '') ?? 0) + 1)
  // Heuristic that is exact for band-cross / seam-corner: the ink is the fill used by the
  // MOST elements (bar, disc, plate, square); the bands are one element each.
  let ink = ''
  let best = 0
  for (const [fill, n] of counts) if (n > best) { best = n; ink = fill }
  return shapes.filter((s) => s.fill === ink)
}

interface GtSeg {
  pts: Vec[]
  kind: 'line' | 'curve'
}

/** Flatten every segment of every strong subpath, keeping its kind. */
function gtSegments(shapes: GroundShape[]): GtSeg[] {
  const out: GtSeg[] = []
  const cubic = (p0: Vec, c1: Vec, c2: Vec, p3: Vec, n: number): Vec[] => {
    const pts: Vec[] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const u = 1 - t
      pts.push({
        x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
        y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
      })
    }
    return pts
  }
  for (const sh of shapes) {
    for (const sp of sh.subPaths as SubPath[]) {
      const n = sp.nodes.length
      const segs = sp.closed ? n : n - 1
      for (let i = 0; i < segs; i++) {
        const a = sp.nodes[i]
        const b = sp.nodes[(i + 1) % n]
        if (!a.hOut && !b.hIn) out.push({ pts: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }], kind: 'line' })
        else out.push({ pts: cubic(a, a.hOut ?? a, b.hIn ?? b, b, 64), kind: 'curve' })
      }
    }
  }
  return out
}

/** Circumradius of three points (Infinity when collinear). */
function circumR(a: Vec, b: Vec, c: Vec): number {
  const ab = Math.hypot(b.x - a.x, b.y - a.y)
  const bc = Math.hypot(c.x - b.x, c.y - b.y)
  const ca = Math.hypot(a.x - c.x, a.y - c.y)
  const area2 = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y))
  return area2 < 1e-9 ? Infinity : (ab * bc * ca) / (2 * area2)
}

interface GtNear {
  dist: number
  kind: 'line' | 'arc' | 'corner'
  /** Local radius for an arc (native px). */
  r: number
}

/** Distance from `p` to the nearest strong boundary, and what that boundary is. */
function nearestStrong(segs: GtSeg[], corners: Vec[], p: Vec, cornerTol: number): GtNear {
  let best = Infinity
  let bestSeg: GtSeg | null = null
  let bestI = 0
  for (const s of segs) {
    for (let i = 1; i < s.pts.length; i++) {
      const a = s.pts[i - 1]
      const b = s.pts[i]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
      if (d < best) {
        best = d
        bestSeg = s
        bestI = i
      }
    }
  }
  for (const c of corners) if (Math.hypot(c.x - p.x, c.y - p.y) <= cornerTol) return { dist: best, kind: 'corner', r: 0 }
  if (!bestSeg || bestSeg.kind === 'line') return { dist: best, kind: 'line', r: Infinity }
  const pts = bestSeg.pts
  const i = Math.max(2, Math.min(pts.length - 3, bestI))
  return { dist: best, kind: 'arc', r: circumR(pts[i - 2], pts[i], pts[i + 2]) }
}

// --- one lane -------------------------------------------------------------------------------

interface Cell {
  res: number
  x: number
  y: number
  /** Position in the REF artwork space. */
  ax: number
  ay: number
  arm: number
  gt: GtNear
  latErr: number
  head: JunctionVerdict
  scaled: JunctionVerdict
  wide: JunctionVerdict
  headErr: number
  scaledErr: number
  /** Every estimator's own error (gates ignored) — line / circle / apex projections. */
  altErr: { line: number; circle: number; apex: number; r: number }
  /** The same estimators over the WIDE window (span 12·K). */
  wideErr: { line: number; circle: number; apex: number; r: number }
}

function lane(res: number): Cell[] {
  const img = decodePng(new Resvg(svgText, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
  // threadDiag's lines verbatim — traceImage's flat path: paletteOptionsFor(DEFAULTS +
  // gradients:false) is detail 0, despeckle 25.
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
  const contrast = edgeContrast(net, fp.palette)
  const s = res / REF
  const head = surveyJunctions(net, contrast, true, { alt: true })
  const scaled = surveyJunctions(net, contrast, true, { span: 12 * s, dev: 1.2 * s })
  const wide = surveyJunctions(net, contrast, true, { span: 12 * K, alt: true })

  const strong = strongShapes(toRasterSpace(gt, img.width))
  const segs = gtSegments(strong)
  const corners = sharpCorners([strong.flatMap((sh) => sh.subPaths)], 0).map((c) => ({ x: c.x, y: c.y }))
  const cornerTol = 3 * s

  const out: Cell[] = []
  for (let i = 0; i < head.length; i++) {
    const v = head[i]
    // Only junctions the rank actually SEES as a weak-into-strong T: two strong arms, the
    // rest weak. Everything else (degree<3, mixed contrast, one-edge loops) is not this
    // mechanism. Border junctions (an EXT arm) are the frame, not the art.
    if (v.reason === 'degree<3' || v.reason.startsWith('rank ') || v.reason === 'strong arms are one edge') continue
    if (v.ends.some((e) => !Number.isFinite(e.de))) continue
    const q = { x: v.x, y: v.y }
    const near = nearestStrong(segs, corners, q, cornerTol)
    const err = (p: Vec | null): number => (p ? nearestStrong(segs, corners, p, cornerTol).dist : near.dist) / s
    out.push({
      res,
      x: v.x,
      y: v.y,
      ax: v.x / s,
      ay: v.y / s,
      arm: Math.min(...v.ends.filter((e) => e.de >= 25).map((e) => e.arm)),
      gt: { ...near, dist: near.dist / s, r: near.r / s },
      latErr: near.dist / s,
      head: v,
      scaled: scaled[i],
      wide: wide[i],
      headErr: err(v.linked ? v.moveTo : null),
      scaledErr: err(scaled[i].linked ? scaled[i].moveTo : null),
      altErr: {
        line: v.alt?.line ? err(v.alt.line) : NaN,
        circle: v.alt?.circle ? err(v.alt.circle) : NaN,
        apex: v.alt?.apex ? err(v.alt.apex) : NaN,
        r: (v.alt?.r ?? NaN) / s,
      },
      wideErr: {
        line: wide[i].alt?.line ? err(wide[i].alt!.line) : NaN,
        circle: wide[i].alt?.circle ? err(wide[i].alt!.circle) : NaN,
        apex: wide[i].alt?.apex ? err(wide[i].alt!.apex) : NaN,
        r: (wide[i].alt?.r ?? NaN) / s,
      },
    })
  }
  return out
}

// --- pairing across lanes -------------------------------------------------------------------

const lanes = new Map<number, Cell[]>()
for (const res of RESOLUTIONS) lanes.set(res, lane(res))

/** Cluster every lane's cells by artwork position (greedy, 4 artwork px). */
const PAIR_TOL = 4
interface Row {
  ax: number
  ay: number
  cells: Map<number, Cell>
}
const rows: Row[] = []
for (const res of RESOLUTIONS) {
  for (const c of lanes.get(res)!) {
    let hit: Row | null = null
    let hd = PAIR_TOL
    for (const r of rows) {
      if (r.cells.has(res)) continue
      const d = Math.hypot(r.ax - c.ax, r.ay - c.ay)
      if (d < hd) {
        hd = d
        hit = r
      }
    }
    if (!hit) rows.push((hit = { ax: c.ax, ay: c.ay, cells: new Map() }))
    hit.cells.set(res, c)
  }
}
rows.sort((a, b) => a.ay - b.ay || a.ax - b.ax)

const branch = (v: JunctionVerdict): string => {
  if (v.linked) {
    if (v.kind === 'apex') return 'apex'
    if (v.extK != null) return `T-circ×${v.extK}`
    return (v.circleDev ?? Infinity) < (v.lineDev ?? Infinity) ? 'T-circ' : 'T-line'
  }
  if (v.reason.startsWith('corner, arm')) return 'ref:bow'
  if (v.reason.startsWith('break')) return 'ref:dev'
  if (v.reason.startsWith('move')) return 'ref:move'
  if (v.reason.startsWith('arm ')) return 'ref:arm'
  return 'ref:' + v.reason.slice(0, 6)
}
const gtName = (g: GtNear): string => (g.kind === 'arc' ? `arc r${f(g.r, 0)}` : g.kind)

console.log(`\n━━━ PAIRED THREAD CENSUS — ${CASE} @ ${RESOLUTIONS.join('/')}  (errors in ${REF}-px artwork units, off the AUTHORED strong boundary) ━━━`)
console.log(`    HEAD = span 12 / dev 1.2 · SCALED = span 12·(res/${REF}) / dev 1.2·(res/${REF}) · WIDE = span ${12 * K} (turn ratio WIDE/HEAD: arc → ~${K}, corner → ~1)`)
console.log(`    lat = the integer lattice corner's own error (what not moving costs)\n`)

for (const r of rows) {
  const any = [...r.cells.values()][0]
  console.log(`  junction @(${f(r.ax, 0)},${f(r.ay, 0)})  GT: ${gtName(any.gt)}`)
  console.log(`     ${'res'.padStart(5)}  ${'arm'.padStart(4)}  ${'lat'.padStart(5)}  ${'HEAD'.padEnd(8)} ${'err'.padStart(5)}  ${'turn'.padStart(5)}  ${'l/c dev'.padStart(9)}   ${'SCALED'.padEnd(8)} ${'err'.padStart(5)}  ${'turn'.padStart(5)}   ${'WIDE turn'.padStart(9)}  ${'ratio'.padStart(5)}   ${'each estimator: line'.padStart(20)} ${'circ(r)'.padStart(12)} ${'apex'.padStart(5)}`)
  for (const res of RESOLUTIONS) {
    const c = r.cells.get(res)
    if (!c) {
      console.log(`     ${String(res).padStart(5)}  (no junction here at this raster)`)
      continue
    }
    const h = c.head
    const sc = c.scaled
    const w = c.wide
    const ratio = h.turnDeg != null && w.turnDeg != null && h.turnDeg > 2 ? w.turnDeg / h.turnDeg : NaN
    const wideArm = Math.min(...w.ends.filter((e) => e.de >= 25).map((e) => e.arm))
    console.log(
      `     ${String(res).padStart(5)}  ${f(c.arm, 0).padStart(4)}  ${f(c.latErr).padStart(5)}  ${branch(h).padEnd(8)} ${f(c.headErr).padStart(5)}  ${f(h.turnDeg ?? NaN, 1).padStart(5)}  ${(f(h.lineDev ?? NaN) + '/' + f(h.circleDev ?? NaN)).padStart(9)}` +
        `   ${branch(sc).padEnd(8)} ${f(c.scaledErr).padStart(5)}  ${f(sc.turnDeg ?? NaN, 1).padStart(5)}   ${f(w.turnDeg ?? NaN, 1).padStart(9)}  ${f(ratio).padStart(5)}${wideArm < 12 * K - 0.5 ? ` (arm ${f(wideArm, 0)})` : '        '}` +
        `   ${f(c.altErr.line).padStart(20)} ${(f(c.altErr.circle) + '(' + f(c.altErr.r, 0) + ')').padStart(12)} ${f(c.altErr.apex).padStart(5)}` +
        `   wide: ${f(c.wideErr.line)} ${f(c.wideErr.circle)}(${f(c.wideErr.r, 0)}) ${f(c.wideErr.apex)}`,
    )
  }
}

// --- the fold ---------------------------------------------------------------------------------

console.log(`\n━━━ PER-RASTER FOLD (paired junctions only: present at EVERY raster) ━━━`)
const full = rows.filter((r) => RESOLUTIONS.every((res) => r.cells.has(res)))
console.log(`    ${full.length} of ${rows.length} junctions are present at every raster\n`)
console.log(`    ${'res'.padStart(5)}  ${'n'.padStart(3)}  ${'lat mean'.padStart(8)}  ${'HEAD mean'.padStart(9)}  ${'HEAD max'.padStart(8)}  ${'SCALED mean'.padStart(11)}  ${'SCALED max'.padStart(10)}   branches (HEAD)                    branches (SCALED)`)
for (const res of RESOLUTIONS) {
  const cells = full.map((r) => r.cells.get(res)!)
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
  const max = (xs: number[]): number => (xs.length ? Math.max(...xs) : NaN)
  const hist = (pick: (c: Cell) => JunctionVerdict): string => {
    const m = new Map<string, number>()
    for (const c of cells) m.set(branch(pick(c)), (m.get(branch(pick(c))) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · ')
  }
  console.log(
    `    ${String(res).padStart(5)}  ${String(cells.length).padStart(3)}  ${f(mean(cells.map((c) => c.latErr)), 3).padStart(8)}  ${f(mean(cells.map((c) => c.headErr)), 3).padStart(9)}  ${f(max(cells.map((c) => c.headErr)), 3).padStart(8)}` +
      `  ${f(mean(cells.map((c) => c.scaledErr)), 3).padStart(11)}  ${f(max(cells.map((c) => c.scaledErr)), 3).padStart(10)}   ${hist((c) => c.head).padEnd(34)} ${hist((c) => c.scaled)}`,
  )
}

// Each estimator on its own, gates ignored: is there ONE that beats the rule at every raster?
console.log(`\n━━━ EACH ESTIMATOR ALONE (paired junctions; mean / max error if it were used everywhere the rank fires) ━━━`)
console.log(`    ${'res'.padStart(5)}  ${'lattice'.padStart(13)}  ${'HEAD rule'.padStart(13)}  ${'always line'.padStart(13)}  ${'always circle'.padStart(13)}  ${'always apex'.padStart(13)}  ${'oracle (best of 3)'.padStart(18)}   ${`wide(${12 * K}) line`.padStart(14)}  ${`wide circle`.padStart(13)}  ${'wide apex'.padStart(13)}  ${'oracle incl. wide'.padStart(17)}`)
for (const res of RESOLUTIONS) {
  const cells = full.map((r) => r.cells.get(res)!)
  const stat = (xs: number[]): string => {
    const ok = xs.filter(Number.isFinite)
    if (!ok.length) return '—'
    return `${(ok.reduce((a, b) => a + b, 0) / ok.length).toFixed(3)} / ${Math.max(...ok).toFixed(3)}`
  }
  const oracle = cells.map((c) => Math.min(...[c.altErr.line, c.altErr.circle, c.altErr.apex].filter(Number.isFinite)))
  const oracle6 = cells.map((c) =>
    Math.min(...[c.altErr.line, c.altErr.circle, c.altErr.apex, c.wideErr.line, c.wideErr.circle, c.wideErr.apex].filter(Number.isFinite)),
  )
  console.log(
    `    ${String(res).padStart(5)}  ${stat(cells.map((c) => c.latErr)).padStart(13)}  ${stat(cells.map((c) => c.headErr)).padStart(13)}  ${stat(cells.map((c) => c.altErr.line)).padStart(13)}` +
      `  ${stat(cells.map((c) => c.altErr.circle)).padStart(13)}  ${stat(cells.map((c) => c.altErr.apex)).padStart(13)}  ${stat(oracle).padStart(18)}` +
      `   ${stat(cells.map((c) => c.wideErr.line)).padStart(14)}  ${stat(cells.map((c) => c.wideErr.circle)).padStart(13)}  ${stat(cells.map((c) => c.wideErr.apex)).padStart(13)}  ${stat(oracle6).padStart(17)}`,
  )
}

// Branch flips: the issue's re-scoped defect — same junction, different branch per raster.
console.log(`\n━━━ BRANCH FLIPS under HEAD (the §0.1 re-scoped defect) ━━━`)
let flips = 0
for (const r of full) {
  const bs = RESOLUTIONS.map((res) => branch(r.cells.get(res)!.head))
  if (new Set(bs).size > 1) {
    flips++
    const errs = RESOLUTIONS.map((res) => f(r.cells.get(res)!.headErr))
    console.log(`    @(${f(r.ax, 0)},${f(r.ay, 0)}) ${gtName(r.cells.get(RESOLUTIONS[0])!.gt).padEnd(10)} ${bs.map((b, i) => `${RESOLUTIONS[i]}:${b}(${errs[i]})`).join('  ')}`)
  }
}
console.log(`    ${flips} of ${full.length} paired junctions change branch across rasters\n`)

// The two-window ratio, by ground truth — does it separate arcs from corners at EVERY raster?
console.log(`━━━ TWO-WINDOW TURN RATIO by ground truth (WIDE/HEAD; arc → ~${K}, corner → ~1; needs both windows filled) ━━━`)
for (const res of RESOLUTIONS) {
  const byKind = new Map<string, number[]>()
  for (const c of lanes.get(res)!) {
    const h = c.head
    const w = c.wide
    if (h.turnDeg == null || w.turnDeg == null || h.turnDeg <= 2) continue
    const wideArm = Math.min(...w.ends.filter((e) => e.de >= 25).map((e) => e.arm))
    if (wideArm < 12 * K - 0.5) continue
    const k = c.gt.kind
    if (!byKind.has(k)) byKind.set(k, [])
    byKind.get(k)!.push(w.turnDeg / h.turnDeg)
  }
  const show = [...byKind.entries()].map(([k, rs]) => `${k}: ${rs.sort((a, b) => a - b).map((x) => x.toFixed(2)).join(' ')}`).join('   |   ')
  console.log(`    ${String(res).padStart(5)}  ${show || '(no junction with both windows filled and turn > 2°)'}`)
}
console.log()
