// Band-boundary PULL diagnosis (user-reported 2026-07-30, /labs/gallery, Affinity Designer):
// on a FLAT trace of ramp art, the posterization band boundaries (low colour contrast) plant
// junctions on the logo's REAL edges (high contrast) — and the real edge is visibly damaged
// there: a straight bar edge bends, a smooth rounded-rect corner grows bumps.
//
//   node --experimental-strip-types src/devtest/bandPullDiag.ts [logo-file.svg] [--res 512]
//
// The question this answers FIRST (before any hypothesis about the mechanism): does the
// damage correlate with band junctions at all, and how big is it? Per shared edge it reports
// the colour contrast across it (ΔE between the two regions that own it — post-hoc from the
// doc's own topology, no pipeline internals) and its geometric deviation; per junction it
// reports the TANGENT BREAK of the high-contrast chain passing through.
//
// A clean edge through a T-junction has a tangent break near 0° (a straight bar) or a small
// smooth turn (a rounded corner); a PULLED one kinks. PURELY DIAGNOSTIC — src/lib/trace
// untouched (gearDiag / rimCapDiag precedent).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { srgbToLab, deltaE76 } from './color.ts'
import type { EditableDoc, PathItem, PathNode, Vec } from '../lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 512
const FILE = argv.find((a) => a.endsWith('.svg')) ?? 'affinity-designer.svg'

/** The gallery's raster: resvg, fit WIDTH to 512, composited on white. */
function rasterize(svgPath: string, size: number) {
  const svg = readFileSync(svgPath, 'utf8')
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'white' }).render().asPng()
  return decodePng(png)
}

const hexToLab = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return srgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255)
}

function cubicAt(p0: PathNode, p1: PathNode, t: number): Vec {
  const c1 = p0.hOut ?? { x: p0.x, y: p0.y }
  const c2 = p1.hIn ?? { x: p1.x, y: p1.y }
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  }
}

/** Dense polyline of a shared edge's fitted nodes, ~1 sample per px of arc.
 *  Straight segments must be sampled too — the pull being measured happens ALONG a
 *  line whose two endpoints are both on the true edge. */
function flatten(nodes: PathNode[], closed: boolean): Vec[] {
  const out: Vec[] = [{ x: nodes[0].x, y: nodes[0].y }]
  const last = closed ? nodes.length : nodes.length - 1
  for (let i = 0; i < last; i++) {
    const a = nodes[i]
    const b = nodes[(i + 1) % nodes.length]
    const c1 = a.hOut ?? a
    const c2 = b.hIn ?? b
    // control-polygon length is an upper bound on the arc — good enough to pick a rate
    const approx = Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y)
    const n = Math.max(1, Math.ceil(approx))
    for (let s = 1; s <= n; s++) out.push(cubicAt(a, b, s / n))
  }
  return out
}

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)

function polyLen(p: Vec[]): number {
  let s = 0
  for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i])
  return s
}

/** Max distance of the polyline from the straight chord between its ends. */
function chordDev(p: Vec[]): number {
  const a = p[0]
  const b = p[p.length - 1]
  const L = dist(a, b)
  if (L < 1e-9) return 0
  const dx = (b.x - a.x) / L
  const dy = (b.y - a.y) / L
  let m = 0
  for (const q of p) m = Math.max(m, Math.abs((q.x - a.x) * dy - (q.y - a.y) * dx))
  return m
}

/** Unit tangent leaving an endpoint, measured over the first `span` px of the curve. */
function endTangent(pts: Vec[], atEnd: boolean, span = 6): Vec {
  const seq = atEnd ? [...pts].reverse() : pts
  const p0 = seq[0]
  let q = seq[seq.length - 1]
  for (const p of seq) {
    if (dist(p, p0) >= span) {
      q = p
      break
    }
  }
  const L = dist(p0, q) || 1
  return { x: (q.x - p0.x) / L, y: (q.y - p0.y) / L }
}

// --- the honest damage metric: distance from the TRUE sub-pixel edge ----------
// chordDev cannot tell a pulled edge from an honestly curved one, and a tangent break
// cannot tell a kink from a real corner. So measure against the pixels: at each sample
// on the fitted curve, read the source colour a few px to either side along the normal
// and find where the transition between THOSE two colours crosses its midpoint. The
// signed offset of that crossing from the fitted curve is the error, in px.
//
// Reading the two sides locally (rather than from the region fills) is what makes this
// work on posterized ramp art: the far side's colour drifts band to band, and the
// midpoint of the LOCAL profile is still the boundary the artist drew.
interface Img { width: number; height: number; data: Uint8ClampedArray }

function sampleRGB(img: Img, x: number, y: number): [number, number, number] {
  const cx = Math.max(0, Math.min(img.width - 1, x))
  const cy = Math.max(0, Math.min(img.height - 1, y))
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(img.width - 1, x0 + 1)
  const y1 = Math.min(img.height - 1, y0 + 1)
  const fx = cx - x0
  const fy = cy - y0
  const at = (px: number, py: number, k: number) => img.data[(py * img.width + px) * 4 + k]
  const out: [number, number, number] = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    const a = at(x0, y0, k) * (1 - fx) + at(x1, y0, k) * fx
    const b = at(x0, y1, k) * (1 - fx) + at(x1, y1, k) * fx
    out[k] = a * (1 - fy) + b * fy
  }
  return out
}

const PROBE = 3.5 // px to each side where the two "pure" colours are read
const SEARCH = 4.0 // px of normal search for the midpoint crossing
const MIN_SIDE_DE = 25 // the local profile must actually be a high-contrast edge

/** Signed offset (px along +normal) from the fitted point to the true edge, or null. */
function edgeOffset(img: Img, p: Vec, n: Vec): number | null {
  const cA = sampleRGB(img, p.x - n.x * PROBE, p.y - n.y * PROBE)
  const cB = sampleRGB(img, p.x + n.x * PROBE, p.y + n.y * PROBE)
  const labA = srgbToLab(cA[0], cA[1], cA[2])
  const labB = srgbToLab(cB[0], cB[1], cB[2])
  if (deltaE76(labA, labB) < MIN_SIDE_DE) return null
  const d = [labB[0] - labA[0], labB[1] - labA[1], labB[2] - labA[2]]
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2]
  const u = (t: number): number => {
    const c = sampleRGB(img, p.x + n.x * t, p.y + n.y * t)
    const l = srgbToLab(c[0], c[1], c[2])
    return ((l[0] - labA[0]) * d[0] + (l[1] - labA[1]) * d[1] + (l[2] - labA[2]) * d[2]) / dd
  }
  // Walk outward from t=0 in both directions; take the nearest midpoint crossing.
  const step = 0.05
  const steps = Math.round(SEARCH / step)
  for (let i = 1; i <= steps; i++) {
    for (const s of [1, -1]) {
      const t1 = s * i * step
      const t0 = s * (i - 1) * step
      const v0 = u(t0) - 0.5
      const v1 = u(t1) - 0.5
      if (v1 === 0) return t1
      if (v0 * v1 < 0) return t0 + ((0 - v0) / (v1 - v0)) * (t1 - t0)
    }
  }
  return null
}

/** Per-edge boundary error against the source pixels, ignoring `skip` px at each end.
 *
 *  Two different numbers matter, and conflating them hides the defect:
 *    • |err|  — how far off the true edge the trace sits. A CONSTANT offset here is the
 *               known sub-pixel placement limit (§0 #8) and is invisible to the eye.
 *    • swing  — how much that signed offset VARIES along the edge. This is what reads as
 *               a bump or a bend: the edge stops being the shape it is supposed to be.
 */
interface EdgeErr { n: number; mean: number; p95: number; max: number; at: Vec | null; swing: number; lo: Vec | null; hi: Vec | null }

function edgeError(img: Img, pts: Vec[], skip = 5): EdgeErr {
  const abs: number[] = []
  let max = 0
  let at: Vec | null = null
  let sMin = Infinity
  let sMax = -Infinity
  let lo: Vec | null = null
  let hi: Vec | null = null
  // arc-length positions so `skip` is in px, not samples
  let acc = 0
  const total = polyLen(pts)
  for (let i = 1; i < pts.length - 1; i++) {
    acc += dist(pts[i - 1], pts[i])
    if (acc < skip || acc > total - skip) continue
    const a = pts[i - 1]
    const b = pts[i + 1]
    const L = dist(a, b) || 1
    const n = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L }
    const off = edgeOffset(img, pts[i], n)
    if (off == null) continue
    const e = Math.abs(off)
    abs.push(e)
    if (e > max) { max = e; at = pts[i] }
    if (off < sMin) { sMin = off; lo = pts[i] }
    if (off > sMax) { sMax = off; hi = pts[i] }
  }
  if (!abs.length) return { n: 0, mean: 0, p95: 0, max: 0, at: null, swing: 0, lo: null, hi: null }
  abs.sort((x, y) => x - y)
  return {
    n: abs.length,
    mean: abs.reduce((s, v) => s + v, 0) / abs.length,
    p95: abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))],
    max,
    at,
    swing: sMax - sMin,
    lo,
    hi,
  }
}

interface EdgeInfo {
  id: number
  de: number // colour contrast across the edge (ΔE76), -1 when only one owner
  fills: string[]
  len: number
  dev: number
  closed: boolean
  sv: number | null
  ev: number | null
  pts: Vec[]
}

function analyze(doc: EditableDoc): { edges: Map<number, EdgeInfo>; verts: Map<number, Array<{ e: number; atEnd: boolean }>> } {
  const topo = doc.topology!
  const owners = new Map<number, Set<string>>()
  for (const it of doc.items) {
    if (it.kind !== 'path') continue
    const p = it as PathItem
    if (!p.loops) continue
    for (const loop of p.loops) for (const r of loop) {
      let s = owners.get(r.edge)
      if (!s) owners.set(r.edge, (s = new Set()))
      s.add(p.fill)
    }
  }
  const edges = new Map<number, EdgeInfo>()
  const verts = new Map<number, Array<{ e: number; atEnd: boolean }>>()
  for (const e of topo.edges) {
    const fills = [...(owners.get(e.id) ?? [])]
    const de = fills.length >= 2 ? deltaE76(hexToLab(fills[0]), hexToLab(fills[1])) : -1
    const pts = flatten(e.nodes, e.closed)
    edges.set(e.id, {
      id: e.id, de, fills, len: polyLen(pts), dev: chordDev(pts), closed: e.closed,
      sv: e.startVertex, ev: e.endVertex, pts,
    })
    if (!e.closed) {
      for (const [v, atEnd] of [[e.startVertex, false], [e.endVertex, true]] as Array<[number | null, boolean]>) {
        if (v == null || v < 0) continue
        let a = verts.get(v)
        if (!a) verts.set(v, (a = []))
        a.push({ e: e.id, atEnd })
      }
    }
  }
  return { edges, verts }
}

// --- run ---------------------------------------------------------------------
const svgPath = join(root, 'examples', 'logos', FILE)
const img = rasterize(svgPath, RES)
console.log(`\n━━━ ${FILE} @ ${RES}px → ${img.width}×${img.height} ━━━ flat planar trace (the gallery's config)\n`)

const doc = await traceImage(img as unknown as ImageData, {
  ...DEFAULT_VECTORIZE_OPTIONS,
  engine: 'planar',
  gradients: false,
})

const paths = doc.items.filter((i) => i.kind === 'path') as PathItem[]
console.log(`  ${paths.length} regions, ${doc.topology!.edges.length} shared edges, ${doc.topology!.vertices.length} vertices`)
console.log(`  fills: ${paths.map((p) => p.fill).join(' ')}\n`)

const { edges, verts } = analyze(doc)

// 1. The contrast spectrum + how far each edge sits from the TRUE boundary in the pixels.
const src = img as unknown as Img
const sorted = [...edges.values()].filter((e) => e.de >= 0).sort((a, b) => b.de - a.de)
console.log('  EDGE INVENTORY — ΔE = colour contrast across the edge; err = distance from the true')
console.log('  sub-pixel boundary in the SOURCE raster. SWING (signed max − min) is what the eye')
console.log('  sees: a constant offset is invisible, a varying one is a bump/bend.\n')
console.log('     ΔE     len     mean     p95   SWING   worst at        fills')
const errs = new Map<number, EdgeErr>()
for (const e of sorted) {
  if (e.len < 4) continue
  const er = edgeError(src, e.pts)
  errs.set(e.id, er)
  const worst = er.at ? `(${er.at.x.toFixed(0)},${er.at.y.toFixed(0)})` : '—'
  const flag = er.swing >= 1.0 ? '  ←' : ''
  console.log(
    `  ${e.de.toFixed(1).padStart(6)}${e.len.toFixed(0).padStart(8)}` +
      `${er.mean.toFixed(2).padStart(9)}${er.p95.toFixed(2).padStart(8)}${er.swing.toFixed(2).padStart(8)}` +
      `   ${worst.padEnd(12)}  ${e.fills.join(' ')}  #${e.id}${e.closed ? ' (loop)' : ''}${flag}`,
  )
}
const bad = [...errs.entries()].filter(([, v]) => v.swing >= 1.0).sort((a, b) => b[1].swing - a[1].swing)
console.log(`\n  WORST SWING (the visible damage), high-contrast edges first:`)
for (const [id, v] of bad) {
  const e = edges.get(id)!
  console.log(
    `    #${String(id).padEnd(3)} ΔE${e.de.toFixed(1).padStart(5)}  ${e.len.toFixed(0).padStart(4)}px  swing ${v.swing.toFixed(2)}px` +
      `   from (${v.lo!.x.toFixed(0)},${v.lo!.y.toFixed(0)}) to (${v.hi!.x.toFixed(0)},${v.hi!.y.toFixed(0)})   ${e.fills.join(' ')}`,
  )
}

// 1b. --profile <id>: the SHAPE of one edge's error. A bow is a smooth arc of signed
// offset; a kink is a step. The fitted nodes are printed alongside — a node with long
// handles in the middle of a straight run is the fit bending the edge on purpose.
const profId = argv.indexOf('--profile') >= 0 ? Number(argv[argv.indexOf('--profile') + 1]) : null
if (profId != null) {
  const e = edges.get(profId)
  if (!e) throw new Error(`no edge #${profId}`)
  console.log(`\n  PROFILE of edge #${profId} (ΔE ${e.de.toFixed(1)}, ${e.len.toFixed(0)}px, ${e.fills.join(' ')})`)
  const raw = doc.topology!.edges.find((x) => x.id === profId)!
  console.log(`    fitted nodes (${raw.nodes.length}):`)
  for (const n of raw.nodes) {
    const h = (v: Vec | null, a: PathNode) => (v ? `${Math.hypot(v.x - a.x, v.y - a.y).toFixed(1)}px` : '—')
    console.log(`      (${n.x.toFixed(2)},${n.y.toFixed(2)})  hIn ${h(n.hIn, n)}  hOut ${h(n.hOut, n)}  ${n.kind}`)
  }
  console.log(`    signed offset from the true edge, every ~4px of arc (+ = toward the edge's left normal):`)
  let acc = 0
  let nextAt = 0
  for (let i = 1; i < e.pts.length - 1; i++) {
    acc += dist(e.pts[i - 1], e.pts[i])
    if (acc < nextAt) continue
    nextAt = acc + 4
    const a = e.pts[i - 1]
    const b = e.pts[i + 1]
    const L = dist(a, b) || 1
    const nrm = { x: -(b.y - a.y) / L, y: (b.x - a.x) / L }
    const off = edgeOffset(src, e.pts[i], nrm)
    const bar = off == null ? '' : '█'.repeat(Math.min(40, Math.round(Math.abs(off) * 12)))
    console.log(
      `      s=${acc.toFixed(0).padStart(4)}  (${e.pts[i].x.toFixed(1)},${e.pts[i].y.toFixed(1)})  ` +
        `${off == null ? '   —  ' : off.toFixed(2).padStart(6)}  ${bar}`,
    )
  }
}

// 2. The junction census — where a LOW-contrast edge lands on HIGH-contrast ones.
const LOW = Number(argv[argv.indexOf('--low') + 1]) || 12
const HIGH = Number(argv[argv.indexOf('--high') + 1]) || 25
console.log(`\n  T-JUNCTIONS: a band edge (ΔE < ${LOW}) meeting real edges (ΔE ≥ ${HIGH})`)
console.log('    the tangent break is measured BETWEEN the two high-contrast arms — 0° = the real edge')
console.log('    passes through straight; a large break is a visible kink.\n')
console.log('     vertex        at      break   arms (id ΔE len dev)')

const topo = doc.topology!
let pulled = 0
for (const [vid, inc] of [...verts.entries()].sort((a, b) => a[0] - b[0])) {
  const info = inc.map((i) => ({ ...i, e: edges.get(i.e)! }))
  const lows = info.filter((i) => i.e.de >= 0 && i.e.de < LOW)
  const highs = info.filter((i) => i.e.de >= HIGH)
  if (lows.length === 0 || highs.length < 2) continue
  const v = topo.vertices[vid]
  // tangent break between the two longest high-contrast arms
  const two = highs.sort((a, b) => b.e.len - a.e.len).slice(0, 2)
  const t0 = endTangent(two[0].e.pts, two[0].atEnd)
  const t1 = endTangent(two[1].e.pts, two[1].atEnd)
  // both tangents point AWAY from the junction, so 180° apart = straight through
  const dot = Math.max(-1, Math.min(1, t0.x * t1.x + t0.y * t1.y))
  const breakDeg = 180 - (Math.acos(dot) * 180) / Math.PI
  pulled++
  const arms = two.map((a) => `#${a.e.id} ΔE${a.e.de.toFixed(0)} ${a.e.len.toFixed(0)}px dev ${a.e.dev.toFixed(2)}`).join(' | ')
  const lowTags = lows.map((l) => `#${l.e.id} ΔE${l.e.de.toFixed(1)}`).join(',')
  console.log(
    `  v${String(vid).padEnd(4)} (${v.x.toFixed(1)},${v.y.toFixed(1)})${breakDeg.toFixed(1).padStart(9)}°  ${arms}   ← band ${lowTags}`,
  )
}
if (!pulled) console.log('    (none)')
console.log()
