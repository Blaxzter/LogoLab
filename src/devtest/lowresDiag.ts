// Low-resolution segmentation diagnosis (§0 #6/#11) — WHERE do the thin bars and the
// small regions die @256?
//
//   node --experimental-strip-types src/devtest/lowresDiag.ts [case ...] [--res 256]
//
// Default cases: the four KNOWN_DEFECTS_LOWRES drivers (hairlines, fluent-flute-flat,
// fluent-parachute-flat, fluent-beverage-box-flat). The gearDiag.ts recipe, one pipeline
// stage earlier: rather than ASSUME which absolute floor eats the feature (the §10.5
// hypothesis was wrong; measure first), this replays segmentFlatPalette's AUTO path tap
// by tap and reports, for every authored colour, what fraction of its pixels still carry
// a near-authored label after each stage:
//
//   assign     quantize + nearest-centroid assignment (the palette itself)
//   blends     classifyBlends dissolution (blend entries → their endpoints)
//   share      dropMinorColors (minShare floor vs flat-interior/modal protection)
//   mode       modeFilter (3×3 majority × modePasses — erodes/erases thin features)
//   restore    restoreErasedComponents (whole-component rescue, ≥ minRegionArea only)
//   despeckle  despeckleComponents (< minRegionArea components dissolved)
//   FINAL      the real traceImage doc, scored by scoreRegions (the gate's own lens)
//
// PURELY DIAGNOSTIC: no src/lib/trace code is modified. Private pipeline pieces
// (flatInteriorCounts, edgeFractions, classifyBlends, modalColorCounts,
// restoreErasedComponents, despeckleComponents, snapPaletteToModes, paletteOptionsFor)
// are re-implemented here verbatim rather than exported — gearDiag precedent.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, healColorSpikes, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { quantize, dropMinorColors, modeFilter } from '../lib/trace/quantize.ts'
import { tracePlanar } from '../lib/trace/planarAssemble.ts'
import { DEFAULT_PLANAR_FIT, FLAT_LINE_COST } from '../lib/trace/planarFit.ts'
import { planarBeautify } from '../lib/trace/planarBeautify.ts'
import { weldConvergedJunctions } from '../lib/trace/planarReseat.ts'
import { materializeRegion, edgeMap } from '../lib/path/topology.ts'
import { DEFAULT_BEAUTIFY_OPTIONS } from '../lib/trace/beautify.ts'
import type { PaletteColor, QuantizeResult } from '../lib/trace/types'
import { rasterizeDoc } from '../lib/render/raster.ts'
import { scoreRegions } from './geomScore.ts'
import { srgbToLab, deltaE76 } from './color.ts'
import { TRUTH_CORPUS } from './truthCorpus.ts'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const RES = Number(argv[argv.indexOf('--res') + 1]) || 256
const names = argv.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a))
const CASES = names.length ? names : ['hairlines', 'fluent-flute-flat', 'fluent-parachute-flat', 'fluent-beverage-box-flat']

// --- paletteOptionsFor (index.ts, verbatim at the gate's defaults) -----------
const DESPECKLE = DEFAULT_VECTORIZE_OPTIONS.despeckle ?? 0 // 25
const minRegionAreaFor = (d: number): number => Math.round((Math.min(100, Math.max(0, d)) / 100) ** 2 * 800)
const OPTS = {
  maxColors: 16,
  minShare: Math.max(0.0006, 0.006 + (DESPECKLE / 100) * 0.004), // detail 0
  modePasses: 2,
  minRegionArea: Math.max(24, minRegionAreaFor(DESPECKLE)),
}

// --- paletteSegment.ts private pieces, verbatim ------------------------------
type Img = { width: number; height: number; data: Uint8ClampedArray }

function flatInteriorCounts(img: Img, labels: Int32Array, paletteLen: number): Int32Array {
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

function modalColorCounts(labels: Int32Array, data: Uint8ClampedArray, paletteLen: number): Int32Array {
  const hist: Map<number, number>[] = Array.from({ length: paletteLen }, () => new Map())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    hist[l].set(key, (hist[l].get(key) ?? 0) + 1)
  }
  const out = new Int32Array(paletteLen)
  for (let l = 0; l < paletteLen; l++) {
    let best = 0
    for (const c of hist[l].values()) if (c > best) best = c
    out[l] = best
  }
  return out
}

const BLEND_LINE_EPS = 10
const EDGE_LOCAL_MIN = 0.6

function segDist2(c: PaletteColor, a: PaletteColor, b: PaletteColor): number {
  const abr = b.r - a.r, abg = b.g - a.g, abb = b.b - a.b
  const len2 = abr * abr + abg * abg + abb * abb
  let t = len2 > 0 ? ((c.r - a.r) * abr + (c.g - a.g) * abg + (c.b - a.b) * abb) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const dr = c.r - (a.r + t * abr), dg = c.g - (a.g + t * abg), db = c.b - (a.b + t * abb)
  return dr * dr + dg * dg + db * db
}

function classifyBlends(
  palette: PaletteColor[],
  real: readonly boolean[],
  edgy: readonly boolean[],
): { blend: boolean[]; routeTo: Int32Array } {
  // The alpha-feather endpoint is omitted: the truth gate rasterizes on WHITE, so every
  // pixel is opaque and the feather flags are structurally all-false there (§11).
  const eps2 = BLEND_LINE_EPS * BLEND_LINE_EPS
  const accepted: number[] = []
  const blend = new Array<boolean>(palette.length).fill(false)
  const routeTo = new Int32Array(palette.length).fill(-1)
  const d2 = (a: PaletteColor, b: PaletteColor): number => {
    const dr = a.r - b.r, dg = a.g - b.g, db = a.b - b.b
    return dr * dr + dg * dg + db * db
  }
  for (let i = 0; i < palette.length; i++) {
    let bestD = Infinity
    if (!real[i] && edgy[i]) {
      for (let a = 0; a < accepted.length; a++) {
        for (let b = a + 1; b < accepted.length; b++) {
          const d = segDist2(palette[i], palette[accepted[a]], palette[accepted[b]])
          if (d <= eps2 && d < bestD) {
            bestD = d
            const ia = accepted[a], ib = accepted[b]
            routeTo[i] = d2(palette[i], palette[ia]) <= d2(palette[i], palette[ib]) ? ia : ib
          }
        }
      }
    }
    if (routeTo[i] >= 0) blend[i] = true
    else accepted.push(i)
  }
  // Fixpoint passes + path compression (§0 #6) — mirrors paletteSegment.ts.
  for (;;) {
    const live = accepted.filter((i) => !blend[i])
    const found: { i: number; route: number }[] = []
    for (const i of live) {
      if (real[i] || !edgy[i]) continue
      let bestD = Infinity
      let route = -1
      for (let a = 0; a < live.length; a++) {
        if (live[a] === i) continue
        for (let b = a + 1; b < live.length; b++) {
          if (live[b] === i) continue
          const d = segDist2(palette[i], palette[live[a]], palette[live[b]])
          if (d <= eps2 && d < bestD) {
            bestD = d
            const ia = live[a], ib = live[b]
            route = d2(palette[i], palette[ia]) <= d2(palette[i], palette[ib]) ? ia : ib
          }
        }
      }
      if (route >= 0) found.push({ i, route })
    }
    if (found.length === 0) break
    for (const { i, route } of found) {
      blend[i] = true
      routeTo[i] = route
    }
  }
  for (let i = 0; i < palette.length; i++) {
    if (!blend[i]) continue
    while (routeTo[i] >= 0 && blend[routeTo[i]]) routeTo[i] = routeTo[routeTo[i]]
  }
  return { blend, routeTo }
}

const RESTORE_MAX_SURVIVAL = 0.3

function restoreErasedComponents(pre: Int32Array, post: Int32Array, w: number, h: number, minArea: number, data: Uint8ClampedArray): Int32Array {
  const n = w * h
  let out = post
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let cid = 0
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || pre[start] < 0) continue
    const lab = pre[start]
    comp[start] = cid
    stack.length = 0
    stack.push(start)
    const pixels: number[] = []
    let kept = 0
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      if (post[p] === lab) kept++
      const x = p % w, y = (p / w) | 0
      const x0 = x > 0, x1 = x < w - 1, y0 = y > 0, y1 = y < h - 1
      const nb = [
        x0 ? p - 1 : -1, x1 ? p + 1 : -1, y0 ? p - w : -1, y1 ? p + w : -1,
        x0 && y0 ? p - w - 1 : -1, x1 && y0 ? p - w + 1 : -1,
        x0 && y1 ? p + w - 1 : -1, x1 && y1 ? p + w + 1 : -1,
      ]
      for (const q of nb) {
        if (q >= 0 && comp[q] === -1 && pre[q] === lab) { comp[q] = cid; stack.push(q) }
      }
    }
    if (kept <= pixels.length * RESTORE_MAX_SURVIVAL && pixels.length >= minArea) {
      if (out === post) out = post.slice()
      for (const p of pixels) out[p] = lab
      let mr = 0, mg = 0, mb = 0
      for (const p of pixels) {
        mr += data[p * 4]
        mg += data[p * 4 + 1]
        mb += data[p * 4 + 2]
      }
      mr /= pixels.length
      mg /= pixels.length
      mb /= pixels.length
      const d2mean = (p: number): number => {
        const dr = data[p * 4] - mr, dg = data[p * 4 + 1] - mg, db = data[p * 4 + 2] - mb
        return dr * dr + dg * dg + db * db
      }
      for (const p of pixels) {
        const x = p % w, y = (p / w) | 0
        if (y >= h - 1) continue
        for (const dx of [-1, 1]) {
          const qx = x + dx
          if (qx < 0 || qx >= w) continue
          const q = p + w + dx
          if (out[q] !== lab) continue
          const s1 = p + dx
          const s2 = p + w
          if (out[s1] === lab || out[s2] === lab) continue
          if (out[s1] < 0 && out[s2] < 0) continue
          const pick = out[s1] < 0 ? s2 : out[s2] < 0 ? s1 : d2mean(s1) <= d2mean(s2) ? s1 : s2
          out[pick] = lab
        }
      }
    }
    cid++
  }
  return out
}

function despeckleComponents(labels: Int32Array, w: number, h: number, minArea: number): Int32Array {
  if (minArea <= 0) return labels
  const n = w * h
  const out = labels.slice()
  const comp = new Int32Array(n).fill(-1)
  const stack: number[] = []
  let cid = 0
  for (let start = 0; start < n; start++) {
    if (comp[start] !== -1 || out[start] < 0) continue
    const lab = out[start]
    comp[start] = cid
    stack.length = 0
    stack.push(start)
    const pixels: number[] = []
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      const x = p % w, y = (p / w) | 0
      const x0 = x > 0, x1 = x < w - 1, y0 = y > 0, y1 = y < h - 1
      const nbAll = [
        x0 ? p - 1 : -1, x1 ? p + 1 : -1, y0 ? p - w : -1, y1 ? p + w : -1,
        x0 && y0 ? p - w - 1 : -1, x1 && y0 ? p - w + 1 : -1,
        x0 && y1 ? p + w - 1 : -1, x1 && y1 ? p + w + 1 : -1,
      ]
      for (const q of nbAll) {
        if (q >= 0 && comp[q] === -1 && out[q] === lab) { comp[q] = cid; stack.push(q) }
      }
    }
    if (pixels.length < minArea) {
      const border = new Map<number, number>()
      for (const p of pixels) {
        const x = p % w, y = (p / w) | 0
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
        for (const qq of nb) {
          if (qq < 0) continue
          const l = out[qq]
          if (l === lab || l < 0) continue
          border.set(l, (border.get(l) ?? 0) + 1)
        }
      }
      let best = -1, bestC = 0
      for (const [l, c] of border) if (c > bestC) { bestC = c; best = l }
      if (best >= 0) for (const p of pixels) out[p] = best
    }
    cid++
  }
  return out
}

function snapPaletteToModes(palette: PaletteColor[], labels: Int32Array, data: Uint8ClampedArray, exclude?: Uint8Array): PaletteColor[] {
  const hist: Map<number, number>[] = palette.map(() => new Map())
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i]
    if (l < 0 || exclude?.[i]) continue
    const o = i * 4
    const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
    hist[l].set(key, (hist[l].get(key) ?? 0) + 1)
  }
  return palette.map((c, l) => {
    let bestKey = -1, bestCount = 0
    for (const [key, count] of hist[l]) {
      if (count > bestCount || (count === bestCount && key < bestKey)) {
        bestCount = count
        bestKey = key
      }
    }
    if (bestKey < 0) return { r: c.r, g: c.g, b: c.b }
    return { r: (bestKey >> 16) & 0xff, g: (bestKey >> 8) & 0xff, b: bestKey & 0xff }
  })
}

// --- diagnosis helpers -------------------------------------------------------

const hex = (c: PaletteColor): string =>
  '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')

/** Authored fills from the SVG source — both #rrggbb and rgb(r,g,b) forms. */
function authoredColors(svg: string): PaletteColor[] {
  const out = new Map<string, PaletteColor>()
  for (const m of svg.matchAll(/fill="#([0-9a-fA-F]{6})"/g)) {
    const v = parseInt(m[1], 16)
    out.set(m[1].toLowerCase(), { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff })
  }
  for (const m of svg.matchAll(/fill="rgb\((\d+),\s*(\d+),\s*(\d+)\)"/g)) {
    const c = { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) }
    out.set(hex(c), c)
  }
  return [...out.values()]
}

/** Fraction of `mask` pixels whose label's palette colour is within ΔE 4 of `target`
 *  (scoreRegions' own MATCH_DELTA_E — the gate's definition of "painted right"). */
function survival(labels: Int32Array, palette: PaletteColor[], mask: Uint8Array, target: PaletteColor): number {
  const tLab = srgbToLab(target.r, target.g, target.b)
  const near = palette.map((p) => deltaE76(srgbToLab(p.r, p.g, p.b), tLab) <= 4)
  let n = 0, ok = 0
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    n++
    const l = labels[i]
    if (l >= 0 && near[l]) ok++
  }
  return n > 0 ? ok / n : NaN
}

// --- the run -----------------------------------------------------------------

for (const name of CASES) {
  const c = TRUTH_CORPUS.find((x) => x.name === name)
  if (!c) {
    console.log(`⨯ unknown case ${name}`)
    continue
  }
  const svg = readFileSync(join(root, c.svg), 'utf8')
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()) as unknown as Img
  const { width: w, height: h, data } = img
  const total = w * h
  const authored = authoredColors(svg)

  console.log(`\n━━━ ${name} @ ${RES}px ━━━  floors: minShare ${OPTS.minShare} (${Math.round(OPTS.minShare * total)}px of ${total}), minRegionArea ${OPTS.minRegionArea}px`)

  // Masks per authored colour: EXACT source pixels (the evidence the floors read) and
  // NEAR pixels (nearest authored colour — the ≥50%-coverage footprint incl. AA).
  const masks = authored.map(() => new Uint8Array(total))
  const exact = new Int32Array(authored.length)
  for (let i = 0; i < total; i++) {
    if (data[i * 4 + 3] < 128) continue
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    let best = -1, bestD = Infinity
    for (let a = 0; a < authored.length; a++) {
      const dr = r - authored[a].r, dg = g - authored[a].g, db = b - authored[a].b
      const d = dr * dr + dg * dg + db * db
      if (d < bestD) { bestD = d; best = a }
      if (d === 0) exact[a]++
    }
    if (best >= 0) masks[best][i] = 1
  }
  // Flat-interior evidence per authored colour (3×3 exact block — §9.4's criterion).
  const flatEvidence = new Int32Array(authored.length)
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const k = rgbAt(i)
      const a = authored.findIndex((cc) => ((cc.r << 16) | (cc.g << 8) | cc.b) === k)
      if (a < 0) continue
      if (
        rgbAt(i - w - 1) === k && rgbAt(i - w) === k && rgbAt(i - w + 1) === k &&
        rgbAt(i - 1) === k && rgbAt(i + 1) === k &&
        rgbAt(i + w - 1) === k && rgbAt(i + w) === k && rgbAt(i + w + 1) === k
      ) flatEvidence[a]++
    }
  }

  console.log(`\n  AUTHORED EVIDENCE — what the floors can see (share floor ${Math.round(OPTS.minShare * total)}px, area floor ${OPTS.minRegionArea}px)`)
  for (let a = 0; a < authored.length; a++) {
    const m = masks[a].reduce((s, v) => s + v, 0)
    if (m < 8) continue
    console.log(
      `    ${hex(authored[a])}  near ${String(m).padStart(6)}px  exact ${String(exact[a]).padStart(6)}px  flat3×3 ${String(flatEvidence[a]).padStart(6)}px` +
        `  → share ${m >= Math.round(OPTS.minShare * total) ? '✓' : '✗'}  flatFloor ${flatEvidence[a] >= OPTS.minRegionArea ? '✓' : '✗'}  modalFloor ${exact[a] >= OPTS.minRegionArea ? '✓' : '✗'}`,
    )
  }

  // --- replay segmentFlatPalette with taps -----------------------------------
  let q: QuantizeResult = quantize(img as unknown as ImageData, OPTS.maxColors, OPTS.minRegionArea)
  const stages: { name: string; labels: Int32Array; palette: PaletteColor[] }[] = []
  stages.push({ name: 'assign', labels: q.labels, palette: q.palette })

  const flat = flatInteriorCounts(img, q.labels, q.palette.length)
  const real = Array.from(flat, (v) => v >= OPTS.minRegionArea)
  const edgy = Array.from(edgeFractions(q.labels, w, h, q.palette.length), (f) => f >= EDGE_LOCAL_MIN)
  const { blend, routeTo } = classifyBlends(q.palette, real, edgy)
  const modal = modalColorCounts(q.labels, data, q.palette.length)

  console.log(`\n  PALETTE DECISIONS (quantize → classify → share drop)`)
  const totalOpaque = q.counts.reduce((s, v) => s + v, 0)
  for (let i = 0; i < q.palette.length; i++) {
    const share = q.counts[i] / totalOpaque
    const protect = real[i] || (!blend[i] && modal[i] >= OPTS.minRegionArea)
    const fate = blend[i]
      ? `BLEND → ${hex(q.palette[routeTo[i]])}`
      : share < OPTS.minShare && !protect
        ? 'DROPPED by share'
        : protect && share < OPTS.minShare
          ? 'kept (protected)'
          : 'kept'
    console.log(
      `    [${String(i).padStart(2)}] ${hex(q.palette[i])}  n ${String(q.counts[i]).padStart(6)} (${(share * 100).toFixed(2)}%)` +
        `  flat ${String(flat[i]).padStart(5)}  modal ${String(modal[i]).padStart(5)}  edge ${edgy[i] ? 'Y' : 'n'}  → ${fate}`,
    )
  }

  let snapExclude: Uint8Array | undefined
  if (blend.some(Boolean)) {
    const counts = q.counts.slice()
    for (let i = 0; i < counts.length; i++) {
      if (!blend[i]) continue
      counts[routeTo[i]] += counts[i]
      counts[i] = 0
    }
    const labels = q.labels.slice()
    snapExclude = new Uint8Array(labels.length)
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i]
      if (l >= 0 && blend[l]) {
        labels[i] = routeTo[l]
        snapExclude[i] = 1
      }
    }
    q = { palette: q.palette, labels, counts }
  }
  stages.push({ name: 'blends', labels: q.labels, palette: q.palette })

  const protect = real.map((r, i) => r || (!blend[i] && modal[i] >= OPTS.minRegionArea))
  q = dropMinorColors(q, OPTS.minShare, protect)
  const snapped = snapPaletteToModes(q.palette, q.labels, data, snapExclude)
  stages.push({ name: 'share', labels: q.labels, palette: snapped })

  const smoothed = modeFilter(q.labels, w, h, OPTS.modePasses)
  stages.push({ name: 'mode', labels: smoothed, palette: snapped })
  const restored = restoreErasedComponents(q.labels, smoothed, w, h, OPTS.minRegionArea, data)
  stages.push({ name: 'restore', labels: restored, palette: snapped })
  const cleaned = despeckleComponents(restored, w, h, OPTS.minRegionArea)
  stages.push({ name: 'despeckle', labels: cleaned, palette: snapped })
  // Past segmentFlatPalette: the flat planar path's heal (index.ts) — mislabeled
  // near-junction pixels move to the 4-neighbour region their colour matches.
  const healed = healColorSpikes(cleaned, data, w, h, snapped)
  stages.push({ name: 'heal', labels: healed, palette: snapped })

  // modeFilter component post-mortem: which components of each label were eroded (lost
  // pixels but survived — the restore is BLIND to these) vs erased whole (rescued if
  // ≥ minRegionArea)?
  console.log(`\n  MODE-FILTER POST-MORTEM (per label: components erased whole / eroded / intact, px lost)`)
  {
    const n = w * h
    const comp = new Int32Array(n).fill(-1)
    const stack: number[] = []
    let cid = 0
    const byLabel = new Map<number, { whole: number; wholePx: number; eroded: number; erodedPx: number; intact: number }>()
    for (let start = 0; start < n; start++) {
      if (comp[start] !== -1 || q.labels[start] < 0) continue
      const lab = q.labels[start]
      comp[start] = cid
      stack.length = 0
      stack.push(start)
      let size = 0, kept = 0
      while (stack.length) {
        const p = stack.pop()!
        size++
        if (smoothed[p] === lab) kept++
        const x = p % w, y = (p / w) | 0
        if (x > 0 && comp[p - 1] === -1 && q.labels[p - 1] === lab) { comp[p - 1] = cid; stack.push(p - 1) }
        if (x < w - 1 && comp[p + 1] === -1 && q.labels[p + 1] === lab) { comp[p + 1] = cid; stack.push(p + 1) }
        if (y > 0 && comp[p - w] === -1 && q.labels[p - w] === lab) { comp[p - w] = cid; stack.push(p - w) }
        if (y < h - 1 && comp[p + w] === -1 && q.labels[p + w] === lab) { comp[p + w] = cid; stack.push(p + w) }
      }
      const s = byLabel.get(lab) ?? { whole: 0, wholePx: 0, eroded: 0, erodedPx: 0, intact: 0 }
      if (kept === 0) { s.whole++; s.wholePx += size }
      else if (kept < size) { s.eroded++; s.erodedPx += size - kept }
      else s.intact++
      byLabel.set(lab, s)
      cid++
    }
    for (const [lab, s] of [...byLabel].sort((a, b) => b[1].wholePx + b[1].erodedPx - (a[1].wholePx + a[1].erodedPx))) {
      if (s.whole === 0 && s.eroded === 0) continue
      console.log(
        `    ${hex(snapped[lab])}  erased-whole ${s.whole} comp (${s.wholePx}px${s.wholePx >= OPTS.minRegionArea ? ', restorable if one comp ≥ floor' : ''})` +
          `  eroded ${s.eroded} comp (−${s.erodedPx}px, invisible to restore)  intact ${s.intact}`,
      )
    }
  }

  console.log(`\n  SURVIVAL BY STAGE — fraction of each authored colour's NEAR mask labelled within ΔE 4`)
  console.log(`    ${'colour'.padEnd(9)}${stages.map((s) => s.name.padStart(10)).join('')}`)
  for (let a = 0; a < authored.length; a++) {
    const m = masks[a].reduce((s, v) => s + v, 0)
    if (m < 8) continue
    const row = stages.map((s) => {
      const v = survival(s.labels, s.palette, masks[a], authored[a])
      return (Number.isNaN(v) ? '—' : (v * 100).toFixed(1) + '%').padStart(10)
    })
    console.log(`    ${hex(authored[a]).padEnd(9)}${row.join('')}  (${m}px)`)
  }

  // DOC-BUILD — the full planar doc pipeline on the healed labels (the same calls
  // index.ts makes at the gate's dials): fit → beautify → weld → materialize. Which
  // labels still have loops, and which loops MATERIALIZE into subpaths? index.ts
  // silently `continue`s a label whose materializeRegion comes back empty.
  {
    const fitOpts = { ...DEFAULT_PLANAR_FIT, lineCost: FLAT_LINE_COST, smoothPasses: 2 }
    const trace = tracePlanar(healed, w, h, fitOpts)
    const loopsAfterFit = new Map<number, number>()
    const loopAnatomy = new Map<number, string[]>()
    for (const [l, loops] of trace.loopsByLabel) {
      loopsAfterFit.set(l, loops.length)
      loopAnatomy.set(
        l,
        loops.map((loop) =>
          loop
            .map((ref) => {
              const e = trace.edges.find((x) => x.id === ref.edge)!
              let len = 0
              for (let i = 0; i + 1 < e.nodes.length; i++) len += Math.hypot(e.nodes[i + 1].x - e.nodes[i].x, e.nodes[i + 1].y - e.nodes[i].y)
              return `e${e.id}[${e.closed ? 'closed' : `${e.startVertex}→${e.endVertex}`}, ${len.toFixed(1)}px, ${e.nodes.length}n]`
            })
            .join(' '),
        ),
      )
    }
    let reseated: ReadonlySet<number> = new Set<number>()
    const topology = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, DEFAULT_BEAUTIFY_OPTIONS, {
      arcSnap: fitOpts.arcSnap,
      localScaleK: fitOpts.localScaleK,
      cornerVeto: fitOpts.cornerVeto,
      reseat: fitOpts.junctionReseat,
      width: w,
      height: h,
      onReseat: (m: ReadonlySet<number>) => { reseated = m },
    })
    weldConvergedJunctions(topology.vertices, topology.edges, trace.loopsByLabel, w, h, reseated)
    const em = edgeMap(topology)
    const counts = new Map<number, number>()
    for (let i = 0; i < healed.length; i++) if (healed[i] >= 0) counts.set(healed[i], (counts.get(healed[i]) ?? 0) + 1)
    console.log(`\n  DOC-BUILD (fit → beautify → weld → materialize, per surviving label)`)
    for (const [l, n] of [...counts].sort((a, b) => b[1] - a[1])) {
      const afterFit = loopsAfterFit.get(l) ?? 0
      const loops = trace.loopsByLabel.get(l) ?? []
      const sub = loops.length ? materializeRegion(loops, em).length : 0
      console.log(
        `    ${hex(snapped[l])}  ${String(n).padStart(6)}px  → fit ${afterFit} loop(s), weld ${loops.length}, ${sub} subpath(s)` +
          `${afterFit === 0 ? '   ⇐ LABEL LOST ITS FACE IN THE FIT' : loops.length === 0 ? '   ⇐ LOOP DELETED BY THE WELD' : sub === 0 ? '   ⇐ LOOP FAILED TO MATERIALIZE (silently dropped)' : ''}`,
      )
      if (afterFit > 0 && (loops.length === 0 || n <= 2000))
        for (const anatomy of loopAnatomy.get(l) ?? []) console.log(`        pre-weld loop: ${anatomy}`)
    }
  }

  // FINAL — the real pipeline end to end, scored the gate's way.
  const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: c.gradients })
  const r = scoreRegions(img as unknown as ImageData, doc)
  console.log(`\n  FINAL (traceImage + scoreRegions): ${r.recovered}/${r.trueRegions} regions`)
  for (const miss of r.missing) console.log(`    ✗ ${miss.hex} (${miss.areaPx}px) painted ${miss.paintedHex}, ΔE ${miss.deltaE.toFixed(1)}`)

  // Doc-level autopsy for each missing colour: does a path with that fill even EXIST,
  // and with what geometry? Separates "the label died in segmentation" from "the label
  // survived and the FIT/doc-build collapsed it" (the §9.5 zero-area-path family, which
  // boundary metrics are blind to — renders are part of the exit protocol for a reason).
  if (r.missing.length) {
    const render = rasterizeDoc(doc, w, h)
    for (const miss of r.missing) {
      const v = parseInt(miss.hex.slice(1), 16)
      const target = { r: (v >> 16) & 0xff, g: (v >> 8) & 0xff, b: v & 0xff }
      const tLab = srgbToLab(target.r, target.g, target.b)
      const carriers = doc.items.filter((it) => {
        if (it.kind !== 'path') return false
        const f = parseInt(it.fill.slice(1), 16)
        return deltaE76(srgbToLab((f >> 16) & 0xff, (f >> 8) & 0xff, f & 0xff), tLab) <= 4
      })
      let rendered = 0
      for (let i = 0; i < w * h; i++) {
        const lab = srgbToLab(render[i * 4], render[i * 4 + 1], render[i * 4 + 2])
        if (deltaE76(lab, tLab) <= 4) rendered++
      }
      console.log(`    ${miss.hex}: ${carriers.length} doc item(s) carry the colour; render shows ${rendered}px of it`)
      for (const it of carriers) {
        if (it.kind !== 'path') continue
        // Shoelace over anchor polylines — coarse, but zero-vs-real area is what matters.
        let area = 0
        for (const sp of it.subPaths) {
          let a2 = 0
          const nn = sp.nodes.length
          for (let i = 0; i < nn; i++) {
            const p = sp.nodes[i], qn = sp.nodes[(i + 1) % nn]
            a2 += p.x * qn.y - qn.x * p.y
          }
          area += Math.abs(a2) / 2
        }
        console.log(`      · item ${it.id}: ${it.subPaths.length} subpath(s), ${it.subPaths.reduce((s, sp) => s + sp.nodes.length, 0)} nodes, ~${area.toFixed(1)}px² anchor-polygon area`)
      }
    }
  }
}
