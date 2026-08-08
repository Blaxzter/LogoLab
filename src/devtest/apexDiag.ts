// APEX-RECONSTRUCTION HISTOGRAM — does the raster agree that the tip is out there?
//
//   node --experimental-strip-types src/devtest/apexDiag.ts                    # tier 0
//   node --experimental-strip-types src/devtest/apexDiag.ts --logos            # gallery witnesses
//   node --experimental-strip-types src/devtest/apexDiag.ts --logos all --top 15
//   node --experimental-strip-types src/devtest/apexDiag.ts --res 256,512,1024
//   node --experimental-strip-types src/devtest/apexDiag.ts --case sharp-star --top 30
//
// WHY (issue #17). `snapCornerToArms` reconstructs a corner as the INTERSECTION of its two
// fitted arm lines. That is right for a raster-ERODED tip: a shallow star point genuinely
// sits px past the last labelled pixel, and §10.2/§10.6 measured the recall it buys
// (sharp-star 11/11, reconstructions up to 4.10px). On an ACUTE COUNTER the same arithmetic
// misfires — the arms converge slowly, so a fraction of a degree of slope error throws the
// intersection px along the bisector, and the scale-aware cap (`allow = max(inSpan,outSpan)`
// once both arms reach SNAP_SPAN) is far too loose to stop it. Measured on logo-instagram
// @512: the 'a' counter's fitted apex sits 3.4px above its lattice tip, where the source
// luminance is 57 — solid ink.
//
// So the question is not "how far did it move" (sharp-star moves far and is right) but
// WHETHER THE RASTER STILL CARRIES THE CORNER'S OWN REGION out where the apex landed.
// An eroded tip leaves a decaying trail of partial coverage between the lattice vertex and
// the true corner — that trail IS the erosion. A counter reconstructed into its own stem
// has no trail at all: coverage falls off a cliff at the lattice vertex and everything
// beyond is the other region, flat.
//
// This CLI measures that trail. Per reconstructed apex it walks the ray from the lattice
// vertex toward the apex and reports:
//
//   α(t)   coverage of the corner's OWN region at t px along the ray, recovered by
//          projecting the source colour onto the own↔other line in sRGB (which is where
//          the rasterizer composited it — Lab would curve the mixing line).
//   reach  how far α stays ≥ ALPHA_FLOOR — the distance the raster's own evidence extends.
//   over   moved − reach: how far the reconstruction ran PAST that evidence. The
//          discriminator under test.
//
// `own` is read from the raster BEHIND the lattice vertex (−2.5px along the ray), so the
// sign convention needs no assumption about convexity: whichever region fills the corner's
// interior is the one whose coverage we follow outward.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import type { ApexDiagRecord } from '../lib/trace/planarFit.ts'
import { tierCases } from './truthCorpus.ts'
import { srgbToLab, deltaE76 } from './color.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const flag = (name: string): string | null => {
  if (!argv.includes(name)) return null
  const v = argv[argv.indexOf(name) + 1]
  return v === undefined || v.startsWith('--') ? '' : v
}
const RES = (flag('--res') ?? '512')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)
const TOP = Number(flag('--top') ?? 0)
const ONLY = flag('--case')

/** The letterform marks issue #17 names, plus the controls it must not break. */
const WITNESSES = ['instagram', 'chupa-chups', 'coca-cola', 'fedex', 'mastercard', 'ahrefs-wordmark']

/** Coverage below this is "the own region is not here". */
const ALPHA_FLOOR = 0.1
/** Below this own↔other separation the projection is noise, so the apex is not scored. */
const MIN_SEP = 10

interface Case {
  name: string
  svg: string
  gradients: boolean
}
const logoCases = (): Case[] => {
  const dir = join(root, 'examples', 'logos')
  let onDisk: string[]
  try {
    onDisk = readdirSync(dir).filter((f) => f.endsWith('.svg'))
  } catch {
    console.log('  (examples/logos/ is absent — `npm run fetch:logos` rehydrates it)\n')
    return []
  }
  const arg = flag('--logos')
  const wanted = arg === 'all' ? onDisk.map((f) => f.replace(/\.svg$/, '')) : arg ? arg.split(',').map((s) => s.trim()) : WITNESSES
  return wanted.filter((w) => onDisk.includes(`${w}.svg`)).map((w) => ({ name: w, svg: `examples/logos/${w}.svg`, gradients: false }))
}
/** The A/B-lane fixtures (genEdgeCases → public/examples/edge-cases/), which are not in
 *  TRUTH_CORPUS — `wedge-counter` is the converging-counter anatomy this issue is about. */
const edgeCases = (): Case[] => {
  const arg = flag('--edge')
  const wanted = arg ? arg.split(',').map((s) => s.trim()) : ['wedge-counter', 'seam-corner', 'scale-blind']
  return wanted.map((w) => ({ name: w, svg: `public/examples/edge-cases/${w}.svg`, gradients: false }))
}
let cases: Case[] = argv.includes('--edge')
  ? edgeCases()
  : argv.includes('--logos')
    ? logoCases()
    : argv.includes('--tier2')
      ? tierCases(2).map((c) => ({ name: c.name, svg: c.svg, gradients: c.gradients }))
      : tierCases(0).map((c) => ({ name: c.name, svg: c.svg, gradients: c.gradients }))
if (ONLY) cases = cases.filter((c) => c.name === ONLY)

type RGB = [number, number, number]
const hexRgb = (h: string): RGB | null => {
  if (!/^#[0-9a-f]{6}$/i.test(h)) return null
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** One scored apex: the record, plus what the raster says about where it landed. */
interface Scored {
  r: ApexDiagRecord
  /** Coverage of the own region at the apex, and halfway out to it. */
  alphaApex: number
  alphaHalf: number
  alphaMean: number
  /** Distance the own region's coverage actually extends past the lattice vertex. */
  reach: number
  /** moved − reach. */
  over: number
  ownHex: string
  otherHex: string
}

const q = (xs: number[], p: number): number => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN)
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : ' n/a').padStart(6)

/** Grand joint histogram: overshoot (rows) × tip angle (cols). */
const OVER_EDGES = [0.5, 1.0, 1.5, 2.0, 3.0, Infinity]
const TIP_EDGES = [15, 30, 45, 60, 90, Infinity]
const bucket = (v: number, edges: number[]): number => edges.findIndex((e) => v < e)
const grand = new Map<string, number>()
const byCase = new Map<string, Scored[]>()

for (const res of RES) {
  console.log(`\n=== ${res}px ===`)
  console.log('case                corners  recon  short  cap  veto |  scored  moved p50/p90/max   reach p50   over p50/p90/max   over>1px')
  for (const c of cases) {
    const svg = readFileSync(join(root, c.svg), 'utf8')
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng()
    const img = decodePng(png)
    const recs: ApexDiagRecord[] = []
    const doc = await traceImage(img as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS,
      engine: 'planar',
      gradients: c.gradients,
      planarFit: { apexDiag: (r) => recs.push(r), ...(argv.includes('--noveto') ? { apexEvidence: false } : {}) },
    })

    // edge id → the fills of the regions that reference it (apexProbe's idiom).
    const owners = new Map<number, Set<string>>()
    for (const it of doc.items) {
      if (it.kind !== 'path' || !it.loops) continue
      for (const loop of it.loops)
        for (const rf of loop) {
          let s = owners.get(rf.edge)
          if (!s) owners.set(rf.edge, (s = new Set()))
          s.add(it.fill)
        }
    }

    const W = img.width
    const H = img.height
    const src = img.data as Uint8ClampedArray | Uint8Array
    /** Bilinear sRGB sample — nearest-neighbour would quantize the coverage trail we
     *  are trying to measure into whole pixels (§14's trap, apexProbe's note). */
    const rgbAt = (x: number, y: number): RGB => {
      const cx = Math.max(0, Math.min(W - 1.001, x))
      const cy = Math.max(0, Math.min(H - 1.001, y))
      const x0 = Math.floor(cx)
      const y0 = Math.floor(cy)
      const fx = cx - x0
      const fy = cy - y0
      const at = (px: number, py: number, k: number): number => src[(py * W + px) * 4 + k]
      const ch = (k: number): number => {
        const a = at(x0, y0, k) * (1 - fx) + at(x0 + 1, y0, k) * fx
        const b = at(x0, y0 + 1, k) * (1 - fx) + at(x0 + 1, y0 + 1, k) * fx
        return a * (1 - fy) + b * fy
      }
      return [ch(0), ch(1), ch(2)]
    }

    const scored: Scored[] = []
    let nRecon = 0
    let nShort = 0
    let nCap = 0
    let nVeto = 0
    let nSkipSep = 0
    let nSkipOwners = 0
    for (const r of recs) {
      if (r.outcome === 'short-arm') nShort++
      if (r.outcome === 'over-cap') nCap++
      if (r.outcome === 'past-evidence') nVeto++
      if (r.outcome !== 'reconstructed') continue
      nRecon++
      if (r.moved < 0.05) continue
      const fills = [...(owners.get(r.edge ?? -1) ?? [])]
      const rgbs = fills.map(hexRgb).filter((v): v is RGB => v !== null)
      if (rgbs.length !== 2) {
        nSkipOwners++
        continue
      }
      const ux = (r.ax - r.cx) / r.moved
      const uy = (r.ay - r.cy) / r.moved
      // Which region fills the corner's INTERIOR — read behind the lattice vertex, so
      // convex and concave corners need no separate treatment.
      const behind = rgbAt(r.cx - ux * 2.5, r.cy - uy * 2.5)
      const lab = (v: RGB) => srgbToLab(v[0], v[1], v[2])
      const dBehind = rgbs.map((v) => deltaE76(lab(behind as RGB), lab(v)))
      const ownI = dBehind[0] <= dBehind[1] ? 0 : 1
      const own = rgbs[ownI]
      const other = rgbs[1 - ownI]
      const sep = deltaE76(lab(own), lab(other))
      if (sep < MIN_SEP) {
        nSkipSep++
        continue
      }
      const dx = own[0] - other[0]
      const dy = own[1] - other[1]
      const dz = own[2] - other[2]
      const den = dx * dx + dy * dy + dz * dz
      const alphaAt = (t: number): number => {
        const p = rgbAt(r.cx + ux * t, r.cy + uy * t)
        const a = ((p[0] - other[0]) * dx + (p[1] - other[1]) * dy + (p[2] - other[2]) * dz) / den
        return Math.max(0, Math.min(1, a))
      }
      // How far the own region's coverage survives outward. Two consecutive samples
      // under the floor end it, so a single AA dip does not truncate a real trail.
      const STEP = 0.25
      let reach = 0
      let miss = 0
      for (let t = STEP; t <= r.moved + 4; t += STEP) {
        if (alphaAt(t) >= ALPHA_FLOOR) {
          reach = t
          miss = 0
        } else if (++miss >= 2) break
      }
      // The MEAN own-coverage along the whole reconstruction segment. `over` turned out to
      // separate only on aggregate: a legitimately eroded 10° spike @256 reads over 2.57
      // while an over-reconstructed lens tip at the same tip angle reads 10.25 — the same
      // scale, so no distance threshold holds at both ends. What actually differs is
      // whether the segment runs THROUGH the shape's own material (erosion: coverage
      // decays from ~0.5 to 0, mean ~0.25) or leaves it at once (over-reconstruction:
      // a cliff at the lattice vertex, mean ~0).
      let sum = 0
      let cnt = 0
      for (let t = STEP; t <= r.moved; t += STEP) {
        sum += alphaAt(t)
        cnt++
      }
      scored.push({
        r,
        alphaApex: alphaAt(r.moved),
        alphaHalf: alphaAt(r.moved / 2),
        alphaMean: cnt ? sum / cnt : 1,
        reach,
        over: r.moved - reach,
        ownHex: fills[ownI],
        otherHex: fills[1 - ownI],
      })
    }

    const moved = scored.map((s) => s.r.moved)
    const over = scored.map((s) => s.over)
    const reach = scored.map((s) => s.reach)
    const over1 = scored.filter((s) => s.over > 1).length
    console.log(
      `${c.name.padEnd(18)}${String(recs.length).padStart(7)}${String(nRecon).padStart(7)}${String(nShort).padStart(7)}` +
        `${String(nCap).padStart(5)}${String(nVeto).padStart(6)} |${String(scored.length).padStart(8)}   ` +
        `${f2(q(moved, 0.5))}/${f2(q(moved, 0.9))}/${f2(Math.max(0, ...moved))}   ${f2(q(reach, 0.5))}   ` +
        `${f2(q(over, 0.5))}/${f2(q(over, 0.9))}/${f2(Math.max(0, ...over))}${String(over1).padStart(10)}`,
    )
    if (nSkipOwners + nSkipSep > 0) console.log(`${''.padEnd(18)}  (unscored: ${nSkipOwners} not a 2-solid-fill edge, ${nSkipSep} own/other ΔE < ${MIN_SEP})`)

    byCase.set(`${c.name}@${res}`, scored)
    for (const s of scored) grand.set(`${bucket(s.over, OVER_EDGES)}:${bucket(s.r.tipDeg, TIP_EDGES)}`, (grand.get(`${bucket(s.over, OVER_EDGES)}:${bucket(s.r.tipDeg, TIP_EDGES)}`) ?? 0) + 1)

    if (TOP) {
      const top = scored.slice().sort((a, b) => b.over - a.over).slice(0, TOP)
      for (const s of top)
        console.log(
          `    apex (${s.r.ax.toFixed(2)},${s.r.ay.toFixed(2)}) ← lattice (${s.r.cx.toFixed(1)},${s.r.cy.toFixed(1)})  ` +
            `moved ${s.r.moved.toFixed(2)} reach ${s.reach.toFixed(2)} over ${s.over.toFixed(2)}  ` +
            `α(apex) ${s.alphaApex.toFixed(2)} α(½) ${s.alphaHalf.toFixed(2)} α̅ ${s.alphaMean.toFixed(3)}  tip ${s.r.tipDeg.toFixed(0)}°  ` +
            `bow ${s.r.inBow.toFixed(2)}/${s.r.outBow.toFixed(2)}  span ${s.r.inSpan}/${s.r.outSpan}  allow ${s.r.allow.toFixed(1)}  ` +
            `own ${s.ownHex} other ${s.otherHex}  e${s.r.edge}`,
        )
    }
  }
}

// The joint histogram — the thing a threshold would be read off, if one is separable.
console.log('\nSCORED apexes, overshoot past the raster evidence (rows) × tip angle (cols)')
const tipHdr = TIP_EDGES.map((e, i) => (e === Infinity ? `≥${TIP_EDGES[i - 1]}°` : `<${e}°`).padStart(8)).join('')
console.log('  over \\ tip' + tipHdr)
for (let b = 0; b < OVER_EDGES.length; b++) {
  const label = OVER_EDGES[b] === Infinity ? `≥${OVER_EDGES[b - 1]}` : `<${OVER_EDGES[b]}`
  let row = `  ${label.padEnd(10)}`
  for (let t = 0; t < TIP_EDGES.length; t++) row += String(grand.get(`${b}:${t}`) ?? 0).padStart(8)
  console.log(row)
}

// The separation question, stated as the two populations it has to tell apart.
console.log('\nPER-CASE α AT THE APEX (does the raster still carry the own region out there?)')
console.log('  case                       scored   α(apex) p10/p50/p90    α(½) p50   over>1px   over>2px')
for (const [k, s] of byCase) {
  if (!s.length) continue
  const aa = s.map((v) => v.alphaApex)
  const ah = s.map((v) => v.alphaHalf)
  console.log(
    `  ${k.padEnd(26)}${String(s.length).padStart(6)}   ${f2(q(aa, 0.1))}/${f2(q(aa, 0.5))}/${f2(q(aa, 0.9))}   ` +
      `${f2(q(ah, 0.5))}${String(s.filter((v) => v.over > 1).length).padStart(11)}${String(s.filter((v) => v.over > 2).length).padStart(11)}`,
  )
}
console.log()
