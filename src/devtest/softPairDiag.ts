// SOFT-PAIR DIAG — issue #15: is the boundary between two palette entries an EDGE or a RAMP?
//
//   node --experimental-strip-types src/devtest/softPairDiag.ts --case shaded-ink [--res 512]
//   node --experimental-strip-types src/devtest/softPairDiag.ts examples/logos/ibm.svg
//   node --experimental-strip-types src/devtest/softPairDiag.ts --census [--res 512] [--min 24]
//
// The colour path keeps ONE ink's shading tones as separate palette entries and cuts every
// shape where the nearest-colour assignment flips (#15). The issue's own numbers say a colour
// DISTANCE cannot separate that from two authored colours (shading pair ΔE 4.44, flute-flat's
// authored pair ΔE 4.5), so this measures the other dimension — WHERE the two entries meet:
//
//   • two AUTHORED flats meet at an anti-aliased seam. Nearest-colour assignment sends the one
//     blend pixel to whichever side it is closer to, so across the label boundary the SOURCE
//     colour still jumps by at least HALF the two colours' distance (a pixel-aligned seam: the
//     whole distance). That is not a calibration — it is what "nearest" means.
//   • shading tones meet through a RAMP. The label boundary falls at the ramp's midpoint, and
//     the two source pixels either side of it differ by ONE 8-bit posterization level — a
//     small fraction of the tone distance, and smaller the wider the ramp.
//
// So per adjacent pair of quantize clusters, over every 4-adjacent pixel pair straddling their
// boundary: the step |src(p) − src(q)| relative to the pair's own (modal) colour distance, as
// a HARD share (step ≥ ½·distance) and a median. Measured on quantize's raw labels — before any
// cleanup, which is where a fix would have to read it.
//
// --census labels every pair across the truth fixtures + the gallery by ground truth: a source
// SVG that authors NO gradient cannot contain a ramp, so a soft pair there is a false positive
// by definition (a blur, a shadow filter, a raster). PURELY DIAGNOSTIC.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { quantize } from '../lib/trace/quantize.ts'
import { fuseShadingTones } from '../lib/trace/shadingFuse.ts'
import { srgbToLab, deltaE76 } from '../lib/trace/lab.ts'
import { TRUTH_CORPUS } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const arg = (k: string): string | null => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null)
const RES = Number(arg('--res')) || 512
const MIN_N = Number(arg('--min')) || 24
const CASE = arg('--case')
const CENSUS = argv.includes('--census')
const FILE = argv.find((a) => a.endsWith('.svg') || a.endsWith('.png'))
/** Rasterize on transparency instead of white — the /labs/ab FIXTURE lane's input. */
const TRANSPARENT = argv.includes('--transparent')

// threadDiag's reproduction of traceImage's flat path: detail 0, despeckle 25.
const MAX_COLORS = 16
const MIN_REGION_AREA = Math.max(24, Math.round(0.25 * 0.25 * 800))
const HARD_RATIO = 0.5
const BINS = 20

type Img = { width: number; height: number; data: Uint8ClampedArray }

function rasterize(path: string): Img {
  if (path.endsWith('.png')) return decodePng(readFileSync(path)) as unknown as Img
  const svg = readFileSync(path, 'utf8')
  return decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, ...(TRANSPARENT ? {} : { background: 'white' }) }).render().asPng()) as unknown as Img
}

const hex = (k: number): string => '#' + k.toString(16).padStart(6, '0')
const labOf = (k: number) => srgbToLab((k >> 16) & 255, (k >> 8) & 255, k & 255)

interface PairStat {
  a: number
  b: number
  n: number
  hard: number
  hist: Int32Array // step ratio in BINS bins over [0, 1], last bin catches ≥ 1
  /** INTERIOR pairs only — both pixels' 4-neighbourhoods lie within {a, b}. This drops the
   *  1px halo a darker tone's anti-alias rim leaves in the lighter tone's colour cloud
   *  (its boundary with the dark interior is a real step and contaminates the share). */
  nInt: number
  hardInt: number
  histInt: Int32Array
}

interface Report {
  palette: { mode: number; count: number; flat: number }[]
  pairs: PairStat[]
}

function measure(img: Img): Report {
  const { width: w, height: h, data } = img
  const q = quantize(img as unknown as ImageData, MAX_COLORS, MIN_REGION_AREA)
  const K = q.palette.length
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  // Modal exact colour per label (what snapPaletteToModes will emit) + flat-interior evidence.
  const hist: Map<number, number>[] = Array.from({ length: K }, () => new Map())
  const flat = new Int32Array(K)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const l = q.labels[i]
      if (l < 0) continue
      const k = rgbAt(i)
      hist[l].set(k, (hist[l].get(k) ?? 0) + 1)
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        if (
          rgbAt(i - w - 1) === k && rgbAt(i - w) === k && rgbAt(i - w + 1) === k &&
          rgbAt(i - 1) === k && rgbAt(i + 1) === k &&
          rgbAt(i + w - 1) === k && rgbAt(i + w) === k && rgbAt(i + w + 1) === k
        ) flat[l]++
      }
    }
  }
  const mode = new Int32Array(K)
  for (let l = 0; l < K; l++) {
    let bk = -1, bc = 0
    for (const [k, c] of hist[l]) if (c > bc || (c === bc && k < bk)) { bc = c; bk = k }
    mode[l] = bk
  }
  const d2 = (p: number, r: number): number => {
    const dr = ((p >> 16) & 255) - ((r >> 16) & 255)
    const dg = ((p >> 8) & 255) - ((r >> 8) & 255)
    const db = (p & 255) - (r & 255)
    return dr * dr + dg * dg + db * db
  }
  const pairs = new Map<number, PairStat>()
  const visit = (i: number, j: number): void => {
    const a = q.labels[i], b = q.labels[j]
    if (a < 0 || b < 0 || a === b) return
    const lo = Math.min(a, b), hi = Math.max(a, b)
    const key = lo * K + hi
    let s = pairs.get(key)
    if (!s) pairs.set(key, (s = { a: lo, b: hi, n: 0, hard: 0, hist: new Int32Array(BINS), nInt: 0, hardInt: 0, histInt: new Int32Array(BINS) }))
    const dist2 = d2(mode[lo], mode[hi])
    const step2 = d2(rgbAt(i), rgbAt(j))
    s.n++
    const interior = within(i, a, b) && within(j, a, b)
    if (interior) s.nInt++
    if (dist2 === 0) return
    const ratio = Math.sqrt(step2 / dist2)
    const bin = Math.min(BINS - 1, Math.floor(ratio * BINS))
    if (ratio >= HARD_RATIO) s.hard++
    s.hist[bin]++
    if (interior) {
      if (ratio >= HARD_RATIO) s.hardInt++
      s.histInt[bin]++
    }
  }
  function within(i: number, a: number, b: number): boolean {
    const x = i % w, y = (i / w) | 0
    const ok = (l: number): boolean => l === a || l === b
    return (x === 0 || ok(q.labels[i - 1])) && (x === w - 1 || ok(q.labels[i + 1])) &&
      (y === 0 || ok(q.labels[i - w])) && (y === h - 1 || ok(q.labels[i + w]))
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (x < w - 1) visit(i, i + 1)
      if (y < h - 1) visit(i, i + w)
    }
  }
  return {
    palette: Array.from({ length: K }, (_, l) => ({ mode: mode[l], count: q.counts[l], flat: flat[l] })),
    pairs: [...pairs.values()].sort((p, r) => r.n - p.n),
  }
}

const medianOf = (h: Int32Array, n: number): number => {
  let acc = 0
  for (let b = 0; b < BINS; b++) {
    acc += h[b]
    if (acc * 2 >= n) return (b + 0.5) / BINS
  }
  return 1
}

function printOne(title: string, rep: Report): void {
  console.log(`\n━━━ ${title} @ ${RES}px ━━━ ${rep.palette.length} clusters\n`)
  console.log('  CLUSTERS (mode hex, px, flat-interior px):')
  rep.palette.forEach((p, l) => console.log(`    [${String(l).padStart(2)}] ${hex(p.mode)}  n=${String(p.count).padStart(7)}  flat=${String(p.flat).padStart(6)}`))
  console.log('\n  ADJACENT PAIRS (boundary pixel pairs n ≥ ' + MIN_N + '):')
  console.log('     a    b   modeA    modeB      ΔE    RGB      n   hard%  median │   nInt  hardI%  medI   verdict')
  for (const p of rep.pairs) {
    if (p.n < MIN_N) continue
    const A = rep.palette[p.a].mode, B = rep.palette[p.b].mode
    const de = deltaE76(labOf(A), labOf(B))
    const rgb = Math.sqrt(((A >> 16 & 255) - (B >> 16 & 255)) ** 2 + ((A >> 8 & 255) - (B >> 8 & 255)) ** 2 + ((A & 255) - (B & 255)) ** 2)
    const hardShare = p.hard / p.n
    const med = medianOf(p.hist, p.n)
    const hardI = p.nInt > 0 ? p.hardInt / p.nInt : NaN
    const medI = p.nInt > 0 ? medianOf(p.histInt, p.nInt) : NaN
    const verdict = p.nInt < MIN_N ? '(no interior boundary)' : hardI < 0.25 ? 'SOFT — a ramp' : hardI < 0.6 ? 'mixed' : 'edge'
    console.log(
      `    ${String(p.a).padStart(2)}   ${String(p.b).padStart(2)}  ${hex(A)}  ${hex(B)}  ${de.toFixed(2).padStart(6)}  ${rgb.toFixed(1).padStart(5)}  ${String(p.n).padStart(6)}  ${(hardShare * 100).toFixed(0).padStart(5)}%  ${med.toFixed(2).padStart(6)} │ ${String(p.nInt).padStart(6)}  ${(hardI * 100).toFixed(0).padStart(5)}%  ${medI.toFixed(2).padStart(5)}   ${verdict}`,
    )
  }
}

function censusCases(): { name: string; path: string; gradients: number; lane: string }[] {
  const out: { name: string; path: string; gradients: number; lane: string }[] = []
  const seen = new Set<string>()
  const gradCount = (p: string): number => (readFileSync(p, 'utf8').match(/<(linear|radial)Gradient\b/g) ?? []).length
  for (const c of TRUTH_CORPUS) {
    if (c.tier !== 0 || seen.has(c.svg)) continue
    seen.add(c.svg)
    const p = join(root, c.svg)
    out.push({ name: c.name, path: p, gradients: gradCount(p), lane: 'fixture' })
  }
  const logos = join(root, 'examples', 'logos')
  if (existsSync(logos)) {
    for (const f of readdirSync(logos).filter((f) => f.endsWith('.svg')).sort()) {
      const p = join(logos, f)
      out.push({ name: f.replace(/\.svg$/, ''), path: p, gradients: gradCount(p), lane: 'gallery' })
    }
  }
  return out
}

if (CENSUS) {
  const cases = censusCases()
  type Row = { case: string; lane: string; gradients: number; A: number; B: number; de: number; n: number; hard: number; med: number; flatA: number; flatB: number; nInt: number; hardI: number; medI: number; cntA: number; cntB: number }
  const rows: Row[] = []
  let images = 0
  for (const c of cases) {
    let rep: Report
    try {
      rep = measure(rasterize(c.path))
    } catch (e) {
      console.log(`  skip ${c.name}: ${(e as Error).message}`)
      continue
    }
    images++
    for (const p of rep.pairs) {
      if (p.nInt < MIN_N) continue
      const A = rep.palette[p.a], B = rep.palette[p.b]
      rows.push({
        case: c.name, lane: c.lane, gradients: c.gradients, A: A.mode, B: B.mode,
        de: deltaE76(labOf(A.mode), labOf(B.mode)), n: p.n, hard: p.hard / p.n, med: medianOf(p.hist, p.n),
        flatA: A.flat, flatB: B.flat, nInt: p.nInt, hardI: p.hardInt / p.nInt, medI: medianOf(p.histInt, p.nInt),
        cntA: A.count, cntB: B.count,
      })
    }
  }
  console.log(`\n━━━ SOFT-PAIR CENSUS @ ${RES}px — ${images} images, ${rows.length} adjacent pairs with INTERIOR boundary n ≥ ${MIN_N} ━━━\n`)
  console.log('  INTERIOR HARD-SHARE HISTOGRAM (share of interior boundary pixel pairs whose source step ≥ ½ the pair distance):')
  const edges = [0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]
  for (let i = 0; i + 1 < edges.length; i++) {
    const inBin = rows.filter((r) => r.hardI >= edges[i] && r.hardI < edges[i + 1])
    if (!inBin.length) continue
    const noGrad = inBin.filter((r) => r.gradients === 0).length
    console.log(`    ${(edges[i] * 100).toFixed(0).padStart(3)}–${Math.min(100, edges[i + 1] * 100).toFixed(0).padStart(3)}%  ${'█'.repeat(Math.min(70, inBin.length))} ${inBin.length}  (no-gradient sources: ${noGrad})`)
  }
  console.log('\n  EVERY PAIR UNDER 60% INTERIOR-HARD (grad = gradients the SOURCE SVG authors; a no-gradient source cannot hold a ramp):')
  console.log('    case                       lane     grad   A        B          ΔE   nInt  hardI%  medI │ all-n  hard%   cntA/flatA        cntB/flatB')
  for (const r of rows.filter((r) => r.hardI < 0.6).sort((x, y) => x.hardI - y.hardI)) {
    console.log(
      `    ${r.case.padEnd(26)} ${r.lane.padEnd(8)} ${String(r.gradients).padStart(4)}   ${hex(r.A)}  ${hex(r.B)}  ${r.de.toFixed(1).padStart(6)}  ${String(r.nInt).padStart(5)}  ${(r.hardI * 100).toFixed(0).padStart(5)}%  ${r.medI.toFixed(2).padStart(5)} │ ${String(r.n).padStart(5)}  ${(r.hard * 100).toFixed(0).padStart(4)}%   ${String(r.cntA).padStart(7)}/${String(r.flatA).padEnd(7)}  ${String(r.cntB).padStart(7)}/${String(r.flatB).padEnd(7)}`,
    )
  }

  // SOFT COMPONENTS — the unit a fix would act on. Soft pairs (interior hard share ≤ SOFT_MAX)
  // chained by union-find; a component's DIAMETER is the max pairwise ΔE between its members'
  // modes. A subtle shading of one ink is a short chain of small diameter; a gradient traced
  // flat is a long chain spanning tens of ΔE. The diameter distribution is the calibration.
  const SOFT_MAX = Number(arg('--soft')) || 0.1
  type Comp = { case: string; lane: string; gradients: number; members: number[]; diameter: number; px: number; flat: number }
  const comps: Comp[] = []
  for (const c of cases) {
    const inCase = rows.filter((r) => r.case === c.name && r.hardI <= SOFT_MAX)
    if (!inCase.length) continue
    const parent = new Map<number, number>()
    const find = (k: number): number => {
      let r = k
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r)!
      return r
    }
    const union = (a: number, b: number): void => {
      if (!parent.has(a)) parent.set(a, a)
      if (!parent.has(b)) parent.set(b, b)
      const ra = find(a), rb = find(b)
      if (ra !== rb) parent.set(ra, rb)
    }
    for (const r of inCase) union(r.A, r.B)
    const groups = new Map<number, Set<number>>()
    for (const k of parent.keys()) {
      const r = find(k)
      let g = groups.get(r)
      if (!g) groups.set(r, (g = new Set()))
      g.add(k)
    }
    const info = new Map<number, { cnt: number; flat: number }>()
    for (const r of inCase) {
      info.set(r.A, { cnt: r.cntA, flat: r.flatA })
      info.set(r.B, { cnt: r.cntB, flat: r.flatB })
    }
    for (const g of groups.values()) {
      const members = [...g]
      let diameter = 0
      for (let i = 0; i < members.length; i++)
        for (let j = i + 1; j < members.length; j++)
          diameter = Math.max(diameter, deltaE76(labOf(members[i]), labOf(members[j])))
      comps.push({
        case: c.name, lane: c.lane, gradients: c.gradients, members, diameter,
        px: members.reduce((s, m) => s + (info.get(m)?.cnt ?? 0), 0),
        flat: members.reduce((s, m) => s + (info.get(m)?.flat ?? 0), 0),
      })
    }
  }
  console.log(`\n  SOFT COMPONENTS (pairs with interior hard share ≤ ${SOFT_MAX}, chained) — ${comps.length} components, sorted by DIAMETER (max pairwise ΔE of member modes):`)
  console.log('    case                       lane     grad  size  diameter       px     flat  members')
  for (const c of comps.sort((x, y) => x.diameter - y.diameter)) {
    console.log(
      `    ${c.case.padEnd(26)} ${c.lane.padEnd(8)} ${String(c.gradients).padStart(4)}  ${String(c.members.length).padStart(4)}  ${c.diameter.toFixed(1).padStart(8)}  ${String(c.px).padStart(7)}  ${String(c.flat).padStart(7)}  ${c.members.map(hex).join(' ')}`,
    )
  }
  console.log('\n  DIAMETER HISTOGRAM:')
  const dEdges = [0, 4, 8, 12, 16, 20, 25, 30, 40, 60, 1e9]
  for (let i = 0; i + 1 < dEdges.length; i++) {
    const inBin = comps.filter((c) => c.diameter >= dEdges[i] && c.diameter < dEdges[i + 1])
    if (!inBin.length) continue
    console.log(`    ${String(dEdges[i]).padStart(3)}–${dEdges[i + 1] > 1e8 ? '∞' : String(dEdges[i + 1]).padEnd(3)}  ${'█'.repeat(Math.min(70, inBin.length))} ${inBin.length}   ${inBin.map((c) => c.case).filter((v, i, a) => a.indexOf(v) === i).join(', ')}`)
  }
} else {
  const path = CASE
    ? join(root, 'public', 'examples', 'edge-cases', `${CASE}.svg`)
    : FILE
      ? FILE.includes('/') ? join(root, FILE) : join(root, 'examples', 'logos', FILE)
      : join(root, 'public', 'examples', 'edge-cases', 'shaded-ink.svg')
  const img = rasterize(path)
  printOne(CASE ?? FILE ?? 'shaded-ink', measure(img))
  // What the shipped rule (shadingFuse.ts) actually fuses on this input.
  const q = quantize(img as unknown as ImageData, MAX_COLORS, MIN_REGION_AREA)
  const { groups } = fuseShadingTones(img, q)
  console.log(`
  fuseShadingTones: ${groups.length} group(s) fused` + (groups.length ? ' — ' + groups.map((g) => '[' + g.map((i) => `${i}:${q.palette[i].r},${q.palette[i].g},${q.palette[i].b}`).join(' ') + ']').join(' ') : ''))
}
