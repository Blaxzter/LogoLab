// Apex probe — the Affinity mark's inner Λ apex, measured against the AUTHORED geometry.
//
//   node --experimental-strip-types src/devtest/apexProbe.ts
//
// affinity-designer.svg is 1020 bytes of plain path data, so the truth here is exact rather
// than sampled. Subpath 4 of the gradient path is
//     M2437 75 c… v501.355 h-347.48 l-135.41-234.495 L2171.1 75 H2437 Z
// under transform translate(-1528) and viewBox 1024 → raster 512 (scale ½), giving
//     P0 = (321.550,  37.500)   start of the upper-right arm   (L2171.1 75)
//     A  = (233.055, 190.775)   THE APEX                        (l-135.41-234.495)
//     P1 = (300.760, 308.022)   end of the lower arm            (h-347.48 → v501.355)
// The apex is where the user sees the bar bow (image #3). Reported per variant: how far the
// nearest traced node lands from A, and how far the traced boundary strays from the authored
// ARM between the junctions — a tilt of the whole arm is what reads as a bend.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'
import type { PathNode, Vec } from '../lib/path/types.ts'
import { srgbToLab, deltaE76 } from './color.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const svg = readFileSync(join(root, 'examples', 'logos', 'affinity-designer.svg'), 'utf8')
const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: 512 }, background: 'white' }).render().asPng())

const A: Vec = { x: 233.055, y: 190.7745 }
const P0: Vec = { x: 321.55, y: 37.5 }
const P1: Vec = { x: 300.76, y: 308.022 }

// The INNER triangle (subpath 3 of the same path):
//     M2090.17 616.044 h-150.22 c… l75.15-130.17 115.72 200.432 Z
// → B = (223.225, 207.806) its apex, C = (281.085, 308.022) its lower-right vertex.
// B→C is the left flank of the same navy bar — the edge the user's image #3 shows bending.
const B: Vec = { x: 223.225, y: 207.806 }
const C: Vec = { x: 281.085, y: 308.022 }

const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)
/** Perpendicular distance of p from the infinite line through a,b. */
function lineDist(p: Vec, a: Vec, b: Vec): number {
  const L = dist(a, b)
  return Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / L
}
/** Is p's projection onto ab inside the segment, with `pad` px of slack cut off each end? */
function within(p: Vec, a: Vec, b: Vec, pad: number): boolean {
  const L = dist(a, b)
  const t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L)
  return t > pad / L && t < 1 - pad / L
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

const VARIANTS: Array<[string, Record<string, unknown>]> = [
  ['flat (shipped)', {}],
  ['reseat off', { planarFit: { junctionReseat: false } }],
  ['arcSnap off', { planarFit: { arcSnap: false } }],
  ['beautify off', { fidelity: 0 }],
  ['gradients ON', { gradients: true }],
]

console.log('\n  APEX A = (233.055, 190.775) — authored. Arms: P0(321.6,37.5)→A and A→P1(300.8,308.0)')
console.log('  "arm stray" = max perpendicular distance of the traced boundary from the authored')
console.log('  arm line, over the middle of the arm (8px cut from each end so the corner and the')
console.log('  junction rounding do not dominate).\n')
console.log('  variant            errA(out) errB(in)   arm P0→A       arm A→P1      arm B→C (inner flank)')
const profiles = new Map<string, Vec[]>()

for (const [label, over] of VARIANTS) {
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, ...over,
  })
  // Only HIGH-CONTRAST edges are sampled. A band edge leaving the junction runs
  // near-perpendicular to the arm and its first few px sit inside the 4px corridor —
  // measuring those would report the band's own geometry as arm damage (it did).
  const owners = new Map<number, Set<string>>()
  for (const it of doc.items) {
    if (it.kind !== 'path' || !it.loops) continue
    for (const loop of it.loops) for (const r of loop) {
      let s = owners.get(r.edge)
      if (!s) owners.set(r.edge, (s = new Set()))
      s.add(it.fill)
    }
  }
  const contrast = (id: number): number => {
    const f = [...(owners.get(id) ?? [])]
    if (f.length < 2) return 999 // borders the exterior — still a real edge
    const lab = (h: string) => {
      const n = parseInt(h.slice(1), 16)
      return srgbToLab((n >> 16) & 255, (n >> 8) & 255, n & 255)
    }
    return deltaE76(lab(f[0]), lab(f[1]))
  }
  // every fitted point on a high-contrast edge, densely sampled
  const pts: Vec[] = []
  let best = Infinity
  for (const e of doc.topology?.edges ?? []) {
    if (contrast(e.id) < 25) continue
    const n = e.nodes
    const last = e.closed ? n.length : n.length - 1
    for (let i = 0; i < last; i++) {
      const a = n[i]
      const b = n[(i + 1) % n.length]
      for (let s = 0; s <= 24; s++) pts.push(cubicAt(a, b, s / 24))
    }
    for (const q of n) best = Math.min(best, dist(q, A))
  }
  const arm = (a: Vec, b: Vec) => {
    const on = pts.filter((p) => within(p, a, b, 8) && lineDist(p, a, b) < 4)
    if (!on.length) return { mean: NaN, max: NaN, at: null as Vec | null }
    const ds = on.map((p) => lineDist(p, a, b))
    let mi = 0
    for (let i = 1; i < ds.length; i++) if (ds[i] > ds[mi]) mi = i
    return { mean: ds.reduce((s, v) => s + v, 0) / ds.length, max: ds[mi], at: on[mi] }
  }
  const u = arm(P0, A)
  const v = arm(A, P1)
  const w = arm(B, C)
  let bB = Infinity
  for (const e of doc.topology?.edges ?? []) {
    if (contrast(e.id) < 25) continue
    for (const q of e.nodes) bB = Math.min(bB, dist(q, B))
  }
  const f = (x: number) => (Number.isNaN(x) ? '  —  ' : x.toFixed(2).padStart(5))
  const at = (p: Vec | null) => (p ? `(${p.x.toFixed(0)},${p.y.toFixed(0)})` : '—')
  console.log(
    `  ${label.padEnd(18)}${best.toFixed(2).padStart(7)}${bB.toFixed(2).padStart(9)}   ` +
      `${f(u.mean)} /${f(u.max)}   ${f(v.mean)} /${f(v.max)}   ${f(w.mean)} /${f(w.max)} @${at(w.at)}`,
  )
  profiles.set(label, pts)
}
console.log()

// The inner flank B→C, profiled along its length. `pad` above cut 8px from each end so a
// corner would not dominate — but the BEND the user sees lives in exactly that last stretch,
// so here nothing is cut. Distance from the authored line, per px of arc from B.
console.log('  INNER FLANK B(223.2,207.8) → C(281.1,308.0), distance from the authored line:')
console.log('    s(px)   ' + [...profiles.keys()].map((k) => k.padStart(14)).join(''))
const LEN = dist(B, C)
for (let s = 4; s <= LEN - 1; s += 4) {
  const t = s / LEN
  const q = { x: B.x + (C.x - B.x) * t, y: B.y + (C.y - B.y) * t }
  const row = [...profiles.values()].map((pts) => {
    // nearest sampled boundary point to this station, measured perpendicular to the line
    let bestD = Infinity
    for (const p of pts) {
      if (dist(p, q) > 6) continue
      const d = lineDist(p, B, C)
      if (d < bestD) bestD = d
    }
    return (bestD === Infinity ? '   —  ' : bestD.toFixed(2).padStart(6)).padStart(14)
  })
  console.log(`   ${s.toFixed(0).padStart(5)}   ` + row.join(''))
}
console.log()

// ---------------------------------------------------------------------------------------
// What the EYE sees: the rendered navy↔light boundary, scanned perpendicular to the authored
// flank, in the source vs each rendered trace. Everything above measures fitted geometry and
// has to guess which edge belongs to the arm; this measures the picture.
const W = img.width
// BILINEAR, not nearest-neighbour. With Math.round the scan quantizes to whole pixels, and
// a gradual TILT of the edge reads as a sudden STEP — which is exactly the wrong conclusion
// (a step means a local label flip; a tilt means the edge is pinned to a bad endpoint).
const lum = (d: Uint8ClampedArray | Uint8Array, x: number, y: number): number => {
  const cx = Math.max(0, Math.min(W - 1.001, x))
  const cy = Math.max(0, Math.min(img.height - 1.001, y))
  const x0 = Math.floor(cx), y0 = Math.floor(cy)
  const fx = cx - x0, fy = cy - y0
  const at = (px: number, py: number): number => {
    const i = (py * W + px) * 4
    return 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
  }
  const a = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx
  const b = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx
  return a * (1 - fy) + b * fy
}
const MID = 115 // between navy #134881 (≈62) and light #43c5fa (≈168)
/** Signed offset along +n from p to the navy/light transition, or null. */
function scan(d: Uint8ClampedArray | Uint8Array, p: Vec, n: Vec): number | null {
  const STEP = 0.05
  for (let i = 1; i <= 8 / STEP; i++) {
    for (const sg of [1, -1]) {
      const t1 = sg * i * STEP
      const t0 = sg * (i - 1) * STEP
      const a = lum(d, p.x + n.x * t0, p.y + n.y * t0) - MID
      const b = lum(d, p.x + n.x * t1, p.y + n.y * t1) - MID
      if (a * b < 0) return t0 + (-a / (b - a)) * (t1 - t0)
    }
  }
  return null
}
const renders = new Map<string, Uint8ClampedArray>()
for (const [label, over] of VARIANTS) {
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, ...over,
  })
  renders.set(label, rasterizeDoc(doc, W, img.height, { background: [255, 255, 255] }) as Uint8ClampedArray)
}
const dirx = (C.x - B.x) / LEN
const diry = (C.y - B.y) / LEN
const nrm = { x: -diry, y: dirx }
console.log('  RENDERED flank displacement (px, + = navy edge moved toward the light side).')
console.log('  Station s runs from the triangle apex B toward C. src column = the offset of the')
console.log('  offset from the authored line (rasterization truth); the rest are trace − source.')
console.log('    s(px)     src' + [...renders.keys()].map((k) => k.padStart(16)).join(''))
for (let s = 6; s <= LEN - 4; s += 6) {
  const p = { x: B.x + dirx * s, y: B.y + diry * s }
  const sv = scan(img.data, p, nrm)
  const cells = [...renders.values()].map((r) => {
    const tv = scan(r, p, nrm)
    return (sv == null || tv == null ? '    —  ' : (tv - sv).toFixed(2).padStart(7)).padStart(16)
  })
  console.log(`   ${s.toFixed(0).padStart(5)}  ${sv == null ? '   —  ' : sv.toFixed(2).padStart(6)}` + cells.join(''))
}
console.log()

// Cross-sections through the displaced stretch: what colours actually lie across the flank?
const hexAt = (d: Uint8ClampedArray | Uint8Array, x: number, y: number): string => {
  const xi = Math.max(0, Math.min(W - 1, Math.round(x)))
  const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)))
  const i = (yi * W + xi) * 4
  return '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('')
}
console.log('  CROSS-SECTIONS across the flank (navy on the left, light blue on the right).')
console.log('  Each row walks the normal from -3px to +5px in 1px steps.\n')
const XS: Array<[string, Uint8ClampedArray]> = [
  ['source', img.data],
  ['flat', renders.get('flat (shipped)')!],
  ['grad', renders.get('gradients ON')!],
]
for (const s of [40, 70, 90]) {
  const p = { x: B.x + dirx * s, y: B.y + diry * s }
  for (const [tag, d] of XS) {
    const row: string[] = []
    for (let t = -3; t <= 5; t++) row.push(hexAt(d, p.x + nrm.x * t, p.y + nrm.y * t))
    console.log(`   s=${String(s).padStart(3)} ${tag.padEnd(7)} ${row.join(' ')}`)
  }
  console.log()
}

// Which shared edges actually cover the flank, and over which stations? The 1px step has to
// land on an edge boundary (a junction) if the split is what causes it — or inside a single
// edge if the label map itself steps.
{
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false,
  })
  const owners = new Map<number, Set<string>>()
  for (const it of doc.items) {
    if (it.kind !== 'path' || !it.loops) continue
    for (const loop of it.loops) for (const r of loop) {
      let st = owners.get(r.edge)
      if (!st) owners.set(r.edge, (st = new Set()))
      st.add(it.fill)
    }
  }
  console.log('  EDGES COVERING THE FLANK (station range along B→C, within 2.5px of the line):')
  for (const e of doc.topology!.edges) {
    const n = e.nodes
    const last = e.closed ? n.length : n.length - 1
    let lo = Infinity
    let hi = -Infinity
    for (let i = 0; i < last; i++) {
      for (let k = 0; k <= 24; k++) {
        const p = cubicAt(n[i], n[(i + 1) % n.length], k / 24)
        if (lineDist(p, B, C) > 2.5) continue
        const t = ((p.x - B.x) * dirx + (p.y - B.y) * diry)
        if (t < -2 || t > LEN + 2) continue
        lo = Math.min(lo, t)
        hi = Math.max(hi, t)
      }
    }
    if (lo === Infinity || hi - lo < 3) continue
    const v0 = e.startVertex != null && e.startVertex >= 0 ? doc.topology!.vertices[e.startVertex] : null
    const v1 = e.endVertex != null && e.endVertex >= 0 ? doc.topology!.vertices[e.endVertex] : null
    const vs = (v: typeof v0) => (v ? `(${v.x.toFixed(0)},${v.y.toFixed(0)})` : 'loop')
    console.log(
      `    #${String(e.id).padEnd(3)} s ${lo.toFixed(0).padStart(4)} → ${hi.toFixed(0).padStart(4)}` +
        `   ${[...(owners.get(e.id) ?? [])].join(' ').padEnd(18)} ends ${vs(v0)} ${vs(v1)}  ${e.nodes.length} nodes`,
    )
  }
  console.log()
}
