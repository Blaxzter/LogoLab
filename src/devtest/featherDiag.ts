// §0 #13 soft-alpha feather diagnosis — measure the feather cluster's full evidence
// signature at the classifyBlends stage and calibrate the proposed alpha-aware gate.
//
//   node src/devtest/featherDiag.tmp.ts
//
// Sections:
//   A  repro "examples/test-files/100 years tour.png" @2048 (the app's flat-art cap):
//      per-cluster evidence table at the classifyBlends stage — share, alpha mode /
//      share-at-mode / std / p10-p90, edge fraction, flat-interior (real), modal
//      count, blend verdict + nearest accepted-pair segment distance, adjacency.
//   B  feather anatomy — per-pixel alpha↔RGB ramp fit for every alphaMode<255
//      cluster: is RGB linear in alpha, and does the a→255 end land on the parent?
//   C  healthy control — synthetic authored-translucent SVG (opaque disc + wide
//      translucent disc + THIN translucent bar, all over a TRANSPARENT canvas)
//      rendered via resvg: the same table, so the separator has a calibrated
//      healthy side (the thin translucent bar is the adversarial case: edgy, no
//      flat interior, alphaMode<255 — exactly the feather signature except alpha
//      DISPERSION).
//   D  workaround verification — traceImage default vs locked palette minus the
//      feather swatch (the §0 #13 "delete the swatch" numbers, 575 → 240 nodes).
//
// PURELY DIAGNOSTIC: no src/lib/trace/ code is modified; paletteSegment's private
// evidence functions (flatInteriorCounts, edgeFractions, classifyBlends,
// modalColorCounts) are re-implemented here verbatim rather than exported.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng, type DecodedImage } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { downscale } from './traceCorpus.ts'
import { quantize, dropMinorColors } from '../lib/trace/quantize.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { segmentFlatPalette } from '../lib/trace/paletteSegment.ts'
import type { PaletteColor } from '../lib/trace/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const f = (v: number, d = 2): string => (Number.isFinite(v) ? v.toFixed(d) : '∞')

// --- paletteOptionsFor(DEFAULT_VECTORIZE_OPTIONS) — index.ts:958, verbatim -----
// detail 0, despeckle 25 ⇒ minShare 0.007, minRegionArea max(24, 50) = 50.
const OPTS = { maxColors: 16, minShare: 0.007, modePasses: 2, minRegionArea: 50, regionEvidence: true }

// --- paletteSegment.ts private evidence functions, re-implemented verbatim -----

/** paletteSegment.ts:109 flatInteriorCounts */
function flatInteriorCounts(img: DecodedImage, labels: Int32Array, paletteLen: number): Int32Array {
  const { width: w, height: h, data } = img
  const counts = new Int32Array(paletteLen)
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = labels[i]
      if (l < 0) continue
      const k = rgbAt(i)
      if (
        rgbAt(i - w - 1) === k && rgbAt(i - w) === k && rgbAt(i - w + 1) === k &&
        rgbAt(i - 1) === k && rgbAt(i + 1) === k &&
        rgbAt(i + w - 1) === k && rgbAt(i + w) === k && rgbAt(i + w + 1) === k
      ) counts[l]++
    }
  }
  return counts
}

/** paletteSegment.ts:233 edgeFractions */
function edgeFractions(labels: Int32Array, w: number, h: number, paletteLen: number): Float64Array {
  const total = new Int32Array(paletteLen)
  const edge = new Int32Array(paletteLen)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const l = labels[i]
      if (l < 0) continue
      total[l]++
      if (
        (x > 0 && labels[i - 1] !== l) || (x < w - 1 && labels[i + 1] !== l) ||
        (y > 0 && labels[i - w] !== l) || (y < h - 1 && labels[i + w] !== l)
      ) edge[l]++
    }
  }
  const out = new Float64Array(paletteLen)
  for (let l = 0; l < paletteLen; l++) out[l] = total[l] > 0 ? edge[l] / total[l] : 0
  return out
}

/** paletteSegment.ts:141/146 BLEND_LINE_EPS + segDist2 */
const BLEND_LINE_EPS = 10
function segDist2(c: PaletteColor, a: PaletteColor, b: PaletteColor): number {
  const abr = b.r - a.r, abg = b.g - a.g, abb = b.b - a.b
  const len2 = abr * abr + abg * abg + abb * abb
  let t = len2 > 0 ? ((c.r - a.r) * abr + (c.g - a.g) * abg + (c.b - a.b) * abb) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const dr = c.r - (a.r + t * abr), dg = c.g - (a.g + t * abg), db = c.b - (a.b + t * abb)
  return dr * dr + dg * dg + db * db
}

/** paletteSegment.ts:189 classifyBlends — instrumented: also returns, for EVERY
 *  entry, the min distance to any accepted-pair segment at its processing time
 *  (√, unbounded — the "12.6 RGB off the nearest accepted-pair segment" number). */
function classifyBlendsInstrumented(
  palette: PaletteColor[],
  real: readonly boolean[],
  edgy: readonly boolean[],
): { blend: boolean[]; routeTo: Int32Array; minSegDist: Float64Array } {
  const eps2 = BLEND_LINE_EPS * BLEND_LINE_EPS
  const accepted: number[] = []
  const blend = new Array<boolean>(palette.length).fill(false)
  const routeTo = new Int32Array(palette.length).fill(-1)
  const minSegDist = new Float64Array(palette.length).fill(Infinity)
  const d2 = (a: PaletteColor, b: PaletteColor): number => {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
    return dr * dr + dg * dg + db * db
  }
  for (let i = 0; i < palette.length; i++) {
    let bestD = Infinity
    let bestAny = Infinity
    for (let a = 0; a < accepted.length; a++) {
      for (let b = a + 1; b < accepted.length; b++) {
        const d = segDist2(palette[i], palette[accepted[a]], palette[accepted[b]])
        if (d < bestAny) bestAny = d
        if (!real[i] && edgy[i] && d <= eps2 && d < bestD) {
          bestD = d
          const ia = accepted[a], ib = accepted[b]
          routeTo[i] = d2(palette[i], palette[ia]) <= d2(palette[i], palette[ib]) ? ia : ib
        }
      }
    }
    minSegDist[i] = Math.sqrt(bestAny)
    if (routeTo[i] >= 0) blend[i] = true
    else accepted.push(i)
  }
  return { blend, routeTo, minSegDist }
}

/** paletteSegment.ts:261 modalColorCounts */
function modalColorCounts(labels: Int32Array, data: Uint8ClampedArray, paletteLen: number): Int32Array {
  const hist: Map<number, number>[] = Array.from({ length: paletteLen }, () => new Map<number, number>())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    const h = hist[l]
    h.set(key, (h.get(key) ?? 0) + 1)
  }
  const out = new Int32Array(paletteLen)
  for (let l = 0; l < paletteLen; l++) {
    let best = 0
    for (const c of hist[l].values()) if (c > best) best = c
    out[l] = best
  }
  return out
}

// --- new measurements (the proposed gate's inputs) -----------------------------

interface AlphaStats { mode: number; modeShare: number; mean: number; std: number; p10: number; p90: number }

/** Per-label alpha statistics over kept (label ≥ 0) pixels. */
function alphaStats(labels: Int32Array, data: Uint8ClampedArray, paletteLen: number): AlphaStats[] {
  // 256-bin histogram per label — exact quantiles, no sampling.
  const hist = Array.from({ length: paletteLen }, () => new Int32Array(256))
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    hist[l][data[i * 4 + 3]]++
  }
  return hist.map((h) => {
    let n = 0, sum = 0, sum2 = 0, mode = 255, modeC = 0
    for (let a = 0; a < 256; a++) {
      const c = h[a]
      n += c
      sum += a * c
      sum2 += a * a * c
      if (c > modeC) { modeC = c; mode = a }
    }
    if (n === 0) return { mode: 255, modeShare: 0, mean: 255, std: 0, p10: 255, p90: 255 }
    const mean = sum / n
    const std = Math.sqrt(Math.max(0, sum2 / n - mean * mean))
    const q = (p: number): number => {
      const target = p * n
      let acc = 0
      for (let a = 0; a < 256; a++) {
        acc += h[a]
        if (acc >= target) return a
      }
      return 255
    }
    return { mode, modeShare: modeC / n, mean, std, p10: q(0.1), p90: q(0.9) }
  })
}

/** Per-label 4-neighbour contact counts: adj[l] = Map(otherLabel → contacts),
 *  with -1 = transparent. The dominant OTHER label is the "parent" candidate. */
function adjacency(labels: Int32Array, w: number, h: number, paletteLen: number): Map<number, number>[] {
  const adj: Map<number, number>[] = Array.from({ length: paletteLen }, () => new Map())
  const touch = (l: number, m: number): void => {
    if (l < 0) return
    adj[l].set(m, (adj[l].get(m) ?? 0) + 1)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const l = labels[i]
      if (x < w - 1) {
        const m = labels[i + 1]
        if (l !== m) { touch(l, m); touch(m, l) }
      }
      if (y < h - 1) {
        const m = labels[i + w]
        if (l !== m) { touch(l, m); touch(m, l) }
      }
    }
  }
  return adj
}

/** Least-squares linear fit RGB(α) over one label's pixels: each channel c(α) =
 *  c0 + c1·α. Returns rms residual (px RGB distance to its own fitted point) and
 *  the fitted endpoints at α=128 and α=255. This is the "RGB explainable as
 *  parent×t along the alpha ramp" measurement. */
function alphaRampFit(labels: Int32Array, data: Uint8ClampedArray, label: number):
  { n: number; rms: number; at128: PaletteColor; at255: PaletteColor } | null {
  let n = 0, sa = 0, saa = 0
  const sc = [0, 0, 0], sca = [0, 0, 0]
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== label) continue
    const o = i * 4
    const a = data[o + 3]
    n++
    sa += a
    saa += a * a
    for (let c = 0; c < 3; c++) { sc[c] += data[o + c]; sca[c] += data[o + c] * a }
  }
  if (n < 16) return null
  const det = n * saa - sa * sa
  const c0 = [0, 0, 0], c1 = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    c1[c] = det !== 0 ? (n * sca[c] - sa * sc[c]) / det : 0
    c0[c] = (sc[c] - c1[c] * sa) / n
  }
  let se = 0
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== label) continue
    const o = i * 4
    const a = data[o + 3]
    for (let c = 0; c < 3; c++) {
      const e = data[o + c] - (c0[c] + c1[c] * a)
      se += e * e
    }
  }
  const at = (a: number): PaletteColor => ({
    r: Math.round(c0[0] + c1[0] * a),
    g: Math.round(c0[1] + c1[1] * a),
    b: Math.round(c0[2] + c1[2] * a),
  })
  return { n, rms: Math.sqrt(se / n), at128: at(128), at255: at(255) }
}

const rgbDist = (a: PaletteColor, b: PaletteColor): number =>
  Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b)
const hex = (c: PaletteColor): string =>
  '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')

// --- the analysis driver -------------------------------------------------------

function analyse(name: string, img: DecodedImage): void {
  const { width: w, height: h } = img
  console.log(`\n================ ${name} (${w}×${h}) ================`)

  // Alpha profile of the raster itself.
  {
    const bands = { a0: 0, semi: 0, opaque: 0 }
    for (let i = 0; i < w * h; i++) {
      const a = img.data[i * 4 + 3]
      if (a === 0) bands.a0++
      else if (a < 255) bands.semi++
      else bands.opaque++
    }
    console.log(`alpha profile: transparent ${bands.a0}, semi(1-254) ${bands.semi}, opaque ${bands.opaque}`)
  }

  // Stage: quantize exactly as segmentFlatPalette does (paletteSegment.ts:508).
  const q = quantize(img as unknown as ImageData, OPTS.maxColors, OPTS.minRegionArea)
  const flat = flatInteriorCounts(img, q.labels, q.palette.length)
  const real = Array.from(flat, (c) => c >= OPTS.minRegionArea)
  const edgeF = edgeFractions(q.labels, w, h, q.palette.length)
  const edgy = Array.from(edgeF, (v) => v >= 0.6)
  const { blend, routeTo, minSegDist } = classifyBlendsInstrumented(q.palette, real, edgy)
  const modal = modalColorCounts(q.labels, img.data, q.palette.length)
  const alpha = alphaStats(q.labels, img.data, q.palette.length)
  const adj = adjacency(q.labels, w, h, q.palette.length)
  const total = q.counts.reduce((a, b) => a + b, 0)

  console.log(`\nquantize: ${q.palette.length} clusters over ${total} opaque px  (minShare ${OPTS.minShare} ⇒ floor ${Math.round(total * OPTS.minShare)} px, minRegionArea ${OPTS.minRegionArea})`)
  console.log('  #  colour   share%    flatInt real  edgeF edgy  modal  blend→ segd   αmode αm.shr αmean  αstd  αp10-p90  top adjacency')
  for (let i = 0; i < q.palette.length; i++) {
    const a = alpha[i]
    const neigh = [...adj[i].entries()].sort((x, y) => y[1] - x[1]).slice(0, 3)
      .map(([l, c]) => `${l < 0 ? 'TRANS' : '#' + l}:${((100 * c) / [...adj[i].values()].reduce((s, v) => s + v, 0)).toFixed(0)}%`)
      .join(' ')
    console.log(
      `  ${String(i).padStart(2)} ${hex(q.palette[i])} ${f((100 * q.counts[i]) / total, 2).padStart(7)}` +
      ` ${String(flat[i]).padStart(9)} ${real[i] ? ' R  ' : ' .  '}` +
      ` ${f(edgeF[i], 2).padStart(5)} ${edgy[i] ? ' E  ' : ' .  '}` +
      ` ${String(modal[i]).padStart(6)}` +
      ` ${(blend[i] ? '→' + routeTo[i] : '  .').padStart(5)} ${f(minSegDist[i], 1).padStart(5)}` +
      ` ${String(a.mode).padStart(5)} ${f(a.modeShare, 2).padStart(5)} ${f(a.mean, 0).padStart(5)} ${f(a.std, 1).padStart(6)}` +
      ` ${String(a.p10).padStart(4)}-${String(a.p90).padEnd(4)} ${neigh}`,
    )
  }

  // Feather candidates under the CURRENT machinery: unexplained (not blend) +
  // edge-local + no real evidence + translucent alpha mode. The proposed gate's
  // separator columns are αstd / p90-p10 / αmodeShare above.
  console.log('\nfeather-shaped clusters (edgy + !real + !blend + αmode<255):')
  for (let i = 0; i < q.palette.length; i++) {
    if (!(edgy[i] && !real[i] && !blend[i] && alpha[i].mode < 255)) continue
    const fit = alphaRampFit(q.labels, img.data, i)
    if (!fit) continue
    // Parent candidate = the most-contacted ACCEPTED opaque label.
    const parent = [...adj[i].entries()]
      .filter(([l]) => l >= 0 && !blend[l] && alpha[l].mode === 255)
      .sort((x, y) => y[1] - x[1])[0]?.[0]
    const parentStr = parent !== undefined
      ? `parent #${parent} ${hex(q.palette[parent])}, d(α→255 end, parent) = ${f(rgbDist(fit.at255, q.palette[parent]), 1)}`
      : 'no opaque accepted neighbour'
    console.log(
      `  #${i} ${hex(q.palette[i])}: ramp fit over ${fit.n} px — rms residual ${f(fit.rms, 2)} RGB, ` +
      `α=128 end ${hex(fit.at128)}, α=255 end ${hex(fit.at255)}; ${parentStr}`,
    )
  }

  // The FINAL palette the pipeline emits (through dissolve/drop/mode-snap/alpha-tag).
  const fp = segmentFlatPalette(img, OPTS)
  console.log(`\nsegmentFlatPalette FINAL: ${fp.palette.length} colours, flatCoverage ${f(fp.flatCoverage, 3)}, dominantColors ${fp.dominantColors}`)
  const ftotal = fp.counts.reduce((a, b) => a + b, 0)
  fp.palette.forEach((c, i) =>
    console.log(`  ${i}: ${hex(c)} a=${c.a ?? 255}  share ${f((100 * fp.counts[i]) / ftotal, 2)}%`))
}

// --- A/B: the repro file @2048 -------------------------------------------------

const reproBytes = readFileSync(join(root, 'examples/test-files/100 years tour.png'))
const reproNative = decodePng(new Uint8Array(reproBytes.buffer, reproBytes.byteOffset, reproBytes.byteLength))
const repro = downscale(reproNative, 2048)
analyse('100 years tour.png @2048', repro)

// --- C: healthy control — authored translucent flats over TRANSPARENCY ---------
// The adversarial healthy case for the gate is the 4px translucent BAR: edgy=1,
// real=false (no flat interior at that width... actually 4px wide has a 2px-wide
// interior line of exact pixels — measured below), alphaMode<255. Only its alpha
// DISPERSION differs from a feather. Rendered with NO background ⇒ canvas stays
// transparent, fill-opacity 0.55 ⇒ alpha 140 flats.

const CONTROL_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
  `<circle cx="150" cy="230" r="115" fill="#20418a"/>` +
  `<circle cx="345" cy="200" r="105" fill="#e33529" fill-opacity="0.55"/>` +
  `<rect x="60" y="430" width="392" height="4" fill="#0f8f6a" fill-opacity="0.55"/>` +
  `</svg>`
const control = decodePng(new Resvg(CONTROL_SVG, { fitTo: { mode: 'width', value: 512 } }).render().asPng())
analyse('control: authored translucent flats (opacity 0.55, transparent canvas)', control)

// --- D: workaround verification (delete-the-swatch) ----------------------------

const countDoc = (doc: Awaited<ReturnType<typeof traceImage>>): { items: number; subpaths: number; nodes: number } => {
  let items = 0, subpaths = 0, nodes = 0
  for (const it of doc.items) {
    if (it.kind !== 'path') continue
    items++
    subpaths += it.subPaths.length
    for (const sp of it.subPaths) nodes += sp.nodes.length
  }
  return { items, subpaths, nodes }
}

console.log('\n================ workaround verification @2048 ================')
const baseOpts = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: false }
const doc = await traceImage(repro as unknown as ImageData, baseOpts)
const dc = countDoc(doc)
console.log(`default trace: ${dc.items} items, ${dc.subpaths} subpaths, ${dc.nodes} nodes  [§0 #13: 575 total]`)
for (const it of doc.items) {
  if (it.kind !== 'path') continue
  const n = it.subPaths.reduce((s, sp) => s + sp.nodes.length, 0)
  console.log(`  item ${it.id}: fill ${it.fill}${it.fillOpacity !== undefined ? ` opacity ${f(it.fillOpacity, 3)} (α ${Math.round(it.fillOpacity * 255)})` : ''} — ${it.subPaths.length} subpaths, ${n} nodes`)
}

// Locked palette = the auto palette minus every translucent swatch (what the user
// does in the PaletteEditor).
const fpFinal = segmentFlatPalette(repro, OPTS)
const lockedPalette = fpFinal.palette.filter((c) => c.a === undefined || c.a >= 255).map((c) => ({ r: c.r, g: c.g, b: c.b }))
console.log(`\nlocked palette (${lockedPalette.length} colours): ${lockedPalette.map(hex).join(' ')}`)
const doc2 = await traceImage(repro as unknown as ImageData, { ...baseOpts, palette: lockedPalette })
const dc2 = countDoc(doc2)
console.log(`locked trace: ${dc2.items} items, ${dc2.subpaths} subpaths, ${dc2.nodes} nodes  [§0 #13: 240]`)

// --- E: fix simulation ---------------------------------------------------------
// classifyBlends WITH the proposed feather branch: a cluster that is edgy + !real
// + unexplained by any accepted-pair segment + αmode<255 + αstd ≥ FEATHER_ALPHA_STD
// (and αmodeShare ≤ FEATHER_MODE_SHARE) routes to the nearest ACCEPTED entry by
// RGB. Then the exact relabel + dropMinorColors the real pipeline runs. Verifies:
// every translucent cluster dissolves, the final palette is the two authored
// colours, and the parent regions' alpha modes stay 255 (no translucent survivor).

const FEATHER_ALPHA_STD = 10
const FEATHER_MODE_SHARE = 0.15

function simulateFix(name: string, img: DecodedImage): void {
  const { width: w, height: h } = img
  const q = quantize(img as unknown as ImageData, OPTS.maxColors, OPTS.minRegionArea)
  const flat = flatInteriorCounts(img, q.labels, q.palette.length)
  const real = Array.from(flat, (c) => c >= OPTS.minRegionArea)
  const edgy = Array.from(edgeFractions(q.labels, w, h, q.palette.length), (v) => v >= 0.6)
  const stats = alphaStats(q.labels, img.data, q.palette.length)
  const feather = stats.map((s) => s.mode < 255 && s.std >= FEATHER_ALPHA_STD && s.modeShare <= FEATHER_MODE_SHARE)

  // classifyBlends + the feather branch (greedy, count-desc, verbatim otherwise).
  const eps2 = BLEND_LINE_EPS * BLEND_LINE_EPS
  const accepted: number[] = []
  const blend = new Array<boolean>(q.palette.length).fill(false)
  const routeTo = new Int32Array(q.palette.length).fill(-1)
  const via: string[] = new Array(q.palette.length).fill('')
  const d2 = (a: PaletteColor, b: PaletteColor): number => {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
    return dr * dr + dg * dg + db * db
  }
  for (let i = 0; i < q.palette.length; i++) {
    let bestD = Infinity
    if (!real[i] && edgy[i]) {
      for (let a = 0; a < accepted.length; a++) {
        for (let b = a + 1; b < accepted.length; b++) {
          const d = segDist2(q.palette[i], q.palette[accepted[a]], q.palette[accepted[b]])
          if (d <= eps2 && d < bestD) {
            bestD = d
            const ia = accepted[a], ib = accepted[b]
            routeTo[i] = d2(q.palette[i], q.palette[ia]) <= d2(q.palette[i], q.palette[ib]) ? ia : ib
            via[i] = 'pair'
          }
        }
      }
      // NEW: alpha-feather endpoint — unexplained + translucent + dispersed alpha.
      if (routeTo[i] < 0 && feather[i] && accepted.length > 0) {
        let best = accepted[0], bd = Infinity
        for (const a of accepted) {
          const d = d2(q.palette[i], q.palette[a])
          if (d < bd) { bd = d; best = a }
        }
        routeTo[i] = best
        via[i] = 'FEATHER'
      }
    }
    if (routeTo[i] >= 0) blend[i] = true
    else accepted.push(i)
  }

  const modal = modalColorCounts(q.labels, img.data, q.palette.length)
  console.log(`\n--- fix simulation: ${name} ---`)
  for (let i = 0; i < q.palette.length; i++) {
    if (blend[i]) console.log(`  #${i} ${hex(q.palette[i])} dissolved via ${via[i]} → #${routeTo[i]} ${hex(q.palette[routeTo[i]])}`)
  }
  // Relabel + drop, verbatim (paletteSegment.ts:537-555).
  const counts = q.counts.slice()
  for (let i = 0; i < counts.length; i++) {
    if (!blend[i]) continue
    counts[routeTo[i]] += counts[i]
    counts[i] = 0
  }
  const labels = q.labels.slice()
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l >= 0 && blend[l]) labels[i] = routeTo[l]
  }
  const protect = real.map((r, i) => r || (!blend[i] && modal[i] >= OPTS.minRegionArea))
  const dropped = dropMinorColors({ palette: q.palette, labels, counts }, OPTS.minShare, protect)
  const finalAlpha = alphaStats(dropped.labels, img.data, dropped.palette.length)
  const dTotal = dropped.counts.reduce((a, b) => a + b, 0)
  console.log(`  final palette (${dropped.palette.length}):`)
  dropped.palette.forEach((c, i) =>
    console.log(`    ${hex(c)}  share ${f((100 * dropped.counts[i]) / dTotal, 2)}%  αmode ${finalAlpha[i].mode} (share-at-mode ${f(finalAlpha[i].modeShare, 2)})`))
}

simulateFix('100 years tour.png @2048', repro)
simulateFix('control (authored translucent flats)', control)

// Under the PROPOSED dissolve (routeTo = parent), where would nearest-RGB have
// sent the feather pixels instead? (Sanity: does whole-cluster routing to the
// parent match the user-approved per-pixel nearest-RGB workaround?)
{
  const q = quantize(repro as unknown as ImageData, OPTS.maxColors, OPTS.minRegionArea)
  const alpha = alphaStats(q.labels, repro.data, q.palette.length)
  for (let i = 0; i < q.palette.length; i++) {
    if (alpha[i].mode === 255) continue
    let n = 0
    const votes = new Map<number, number>()
    for (let p = 0; p < q.labels.length; p++) {
      if (q.labels[p] !== i) continue
      n++
      const o = p * 4
      let best = -1, bestD = Infinity
      for (let c = 0; c < lockedPalette.length; c++) {
        const dr = repro.data[o] - lockedPalette[c].r
        const dg = repro.data[o + 1] - lockedPalette[c].g
        const db = repro.data[o + 2] - lockedPalette[c].b
        const d = dr * dr + dg * dg + db * db
        if (d < bestD) { bestD = d; best = c }
      }
      votes.set(best, (votes.get(best) ?? 0) + 1)
    }
    const dist = [...votes.entries()].sort((a, b) => b[1] - a[1])
      .map(([c, v]) => `${hex(lockedPalette[c])}:${((100 * v) / n).toFixed(1)}%`).join(' ')
    console.log(`cluster #${i} (αmode ${alpha[i].mode}, ${n} px) nearest-RGB in locked palette → ${dist}`)
  }
}
