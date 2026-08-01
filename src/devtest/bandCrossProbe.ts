// Does the weak boundary have to come from a RAMP?
//
//   node --experimental-strip-types src/devtest/bandCrossProbe.ts
//
// The flat-authored `band-cross` case scores green (chamfer 0.14 / p95 0.49 @512), so a weak
// boundary alone does NOT bend a strong edge — the first hypothesis is dead. The candidate
// difference against the Affinity mark: there the weak boundary is a POSTERIZATION iso-line
// of a smooth ramp, whose own position is decided by where quantization falls, not by an
// authored edge. This builds the SAME geometry two ways — flat bands vs a linear ramp — and
// measures the identical navy flank against the identical authored line.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { PathNode, Vec } from '../lib/path/types.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const V = 256

// The bar, verbatim from genEdgeCases' band-cross: thickLine(40, 8, 96, 248, 20).
const X1 = 40, Y1 = 8, X2 = 96, Y2 = 248, WBAR = 20
const dxb = X2 - X1, dyb = Y2 - Y1
const lenb = Math.hypot(dxb, dyb)
const nx = (-dyb / lenb) * (WBAR / 2)
const ny = (dxb / lenb) * (WBAR / 2)
// RIGHT flank (the -normal side), in 512-space (the case is authored at 256, gated at 512)
const F0: Vec = { x: (X1 - nx) * 2, y: (Y1 - ny) * 2 }
const F1: Vec = { x: (X2 - nx) * 2, y: (Y2 - ny) * 2 }

const DEEP = 'rgb(19,72,129)'
const shapes =
  `<polygon points="${[
    [X1 + nx, Y1 + ny], [X2 + nx, Y2 + ny], [X2 - nx, Y2 - ny], [X1 - nx, Y1 - ny],
  ].map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ')}" fill="${DEEP}"/>` +
  `<circle cx="170" cy="80" r="40" fill="${DEEP}"/>` +
  `<path d="M140,165 H240 V245 H168 A28,28 0 0,1 140,217 Z" fill="${DEEP}"/>` +
  `<rect x="205" y="8" width="40" height="40" fill="${DEEP}"/>`

const below = (y0: number, y1: number, fill: string): string =>
  `<polygon points="0,${y0} ${V},${y1} ${V},${V} 0,${V}" fill="${fill}"/>`

const FLAT =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">` +
  `<rect width="${V}" height="${V}" fill="rgb(90,213,251)"/>` +
  below(62, 96, 'rgb(73,201,250)') + below(132, 166, 'rgb(56,189,250)') + below(196, 230, 'rgb(40,176,247)') +
  shapes + '</svg>\n'

// The ramp spans the SAME colours over the same direction, so a flat trace posterizes it
// into bands in roughly the same places — but as iso-lines, not authored edges.
const RAMP =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">` +
  `<defs><linearGradient id="r" x1="0" y1="0" x2="0.13" y2="1">` +
  `<stop offset="0" stop-color="rgb(96,217,251)"/><stop offset="1" stop-color="rgb(34,172,247)"/>` +
  `</linearGradient></defs>` +
  `<rect width="${V}" height="${V}" fill="url(#r)"/>` + shapes + '</svg>\n'

function cubicAt(p0: PathNode, p1: PathNode, t: number): Vec {
  const c1 = p0.hOut ?? { x: p0.x, y: p0.y }
  const c2 = p1.hIn ?? { x: p1.x, y: p1.y }
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
  }
}
const dist = (a: Vec, b: Vec) => Math.hypot(a.x - b.x, a.y - b.y)
const lineDist = (p: Vec, a: Vec, b: Vec) =>
  Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) / dist(a, b)

console.log('\n  The SAME navy bar, the SAME authored flank, two backgrounds.')
console.log('  Deviation of the traced boundary from the authored flank line, along its length.\n')
console.log('    s(px)      flat bands        ramp (posterized)')

const results = new Map<string, Vec[]>()
for (const [tag, markup] of [['flat', FLAT], ['ramp', RAMP]] as Array<[string, string]>) {
  writeFileSync(join(root, `.band-${tag}.svg`), markup)
  const img = decodePng(new Resvg(markup, { fitTo: { mode: 'width', value: 512 }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false,
  })
  const pts: Vec[] = []
  for (const e of doc.topology?.edges ?? []) {
    const n = e.nodes
    const last = e.closed ? n.length : n.length - 1
    for (let i = 0; i < last; i++) for (let k = 0; k <= 30; k++) pts.push(cubicAt(n[i], n[(i + 1) % n.length], k / 30))
  }
  results.set(tag, pts)
  const fills = doc.items.filter((i) => i.kind === 'path').map((i) => i.fill)
  console.log(`    (${tag}: ${fills.length} regions — ${fills.join(' ')})`)
}

const L = dist(F0, F1)
const ux = (F1.x - F0.x) / L
const uy = (F1.y - F0.y) / L
let worst = { flat: 0, ramp: 0 }
for (let s = 10; s <= L - 10; s += 10) {
  const q = { x: F0.x + ux * s, y: F0.y + uy * s }
  const cell = (tag: 'flat' | 'ramp') => {
    let best = Infinity
    for (const p of results.get(tag)!) {
      if (dist(p, q) > 7) continue
      const d = lineDist(p, F0, F1)
      if (d < best) best = d
    }
    if (best !== Infinity && best > worst[tag]) worst[tag] = best
    return best === Infinity ? '    —  ' : best.toFixed(2).padStart(7)
  }
  console.log(`   ${s.toFixed(0).padStart(5)}   ${cell('flat').padStart(12)}   ${cell('ramp').padStart(18)}`)
}
console.log(`\n    worst:  flat ${worst.flat.toFixed(2)}px   ramp ${worst.ramp.toFixed(2)}px\n`)
// PHASE SWEEP. A junction is an INTEGER lattice corner; the authored edge is sub-pixel. So a
// strong edge pinned between two weak junctions should tilt by an amount that depends on the
// edge's sub-pixel phase — and an edge with NO junctions on it should not care. Three
// backgrounds × 10 phases, same bar, measured against the same authored flank each time.
const uniform =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">` +
  `<rect width="${V}" height="${V}" fill="rgb(73,201,250)"/>`

function build(kind: 'none' | 'flat' | 'ramp', dx: number): { markup: string; f0: Vec; f1: Vec } {
  const bx1 = X1 + dx, bx2 = X2 + dx
  const bar =
    `<polygon points="${[
      [bx1 + nx, Y1 + ny], [bx2 + nx, Y2 + ny], [bx2 - nx, Y2 - ny], [bx1 - nx, Y1 - ny],
    ].map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).join(' ')}" fill="${DEEP}"/>`
  const bg =
    kind === 'none'
      ? uniform
      : kind === 'flat'
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">` +
          `<rect width="${V}" height="${V}" fill="rgb(90,213,251)"/>` +
          below(62, 96, 'rgb(73,201,250)') + below(132, 166, 'rgb(56,189,250)') + below(196, 230, 'rgb(40,176,247)')
        : `<svg xmlns="http://www.w3.org/2000/svg" width="${V}" height="${V}" viewBox="0 0 ${V} ${V}">` +
          `<defs><linearGradient id="r" x1="0" y1="0" x2="0.13" y2="1">` +
          `<stop offset="0" stop-color="rgb(96,217,251)"/><stop offset="1" stop-color="rgb(34,172,247)"/>` +
          `</linearGradient></defs><rect width="${V}" height="${V}" fill="url(#r)"/>`
  return {
    markup: bg + bar + '</svg>\n',
    f0: { x: (bx1 - nx) * 2, y: (Y1 - ny) * 2 },
    f1: { x: (bx2 - nx) * 2, y: (Y2 - ny) * 2 },
  }
}

async function worstFlank(kind: 'none' | 'flat' | 'ramp', dx: number): Promise<number> {
  const { markup, f0, f1 } = build(kind, dx)
  const img = decodePng(new Resvg(markup, { fitTo: { mode: 'width', value: 512 }, background: 'white' }).render().asPng())
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false,
  })
  const pts: Vec[] = []
  for (const e of doc.topology?.edges ?? []) {
    const n = e.nodes
    const last = e.closed ? n.length : n.length - 1
    for (let i = 0; i < last; i++) for (let k = 0; k <= 30; k++) pts.push(cubicAt(n[i], n[(i + 1) % n.length], k / 30))
  }
  const L = dist(f0, f1)
  const ux = (f1.x - f0.x) / L
  const uy = (f1.y - f0.y) / L
  let worst = 0
  for (let s = 12; s <= L - 12; s += 3) {
    const q = { x: f0.x + ux * s, y: f0.y + uy * s }
    let best = Infinity
    for (const p of pts) {
      if (dist(p, q) > 6) continue
      const d = lineDist(p, f0, f1)
      if (d < best) best = d
    }
    if (best !== Infinity && best > worst) worst = best
  }
  return worst
}

console.log('\n  WORST deviation of the navy flank from its authored line (px @512).')
console.log('  "none" = uniform background, no weak boundary anywhere on the edge — the control.\n')
console.log('   phase(px@512)     none      flat bands      ramp')
let mx = { none: 0, flat: 0, ramp: 0 }
for (let i = 0; i < 10; i++) {
  const dx = i / 20 // authored at 256 → 0.05px steps become 0.1px at 512
  const a = await worstFlank('none', dx)
  const b = await worstFlank('flat', dx)
  const c = await worstFlank('ramp', dx)
  mx = { none: Math.max(mx.none, a), flat: Math.max(mx.flat, b), ramp: Math.max(mx.ramp, c) }
  console.log(`   ${(dx * 2).toFixed(1).padStart(8)}     ${a.toFixed(2).padStart(6)}     ${b.toFixed(2).padStart(8)}   ${c.toFixed(2).padStart(8)}`)
}
console.log(`\n   worst over phase:  none ${mx.none.toFixed(2)}   flat ${mx.flat.toFixed(2)}   ramp ${mx.ramp.toFixed(2)}\n`)
