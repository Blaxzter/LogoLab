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

// `--fit k=v,k2=v2` overrides PlanarFitOptions for the FINAL traceImage + autopsy only
// (the stage replay above it is segmentation, which no fit flag touches). This is the
// mechanism bisect: §0 #14's collapse is present with `subpixelEdges=false` and absent
// with it on, and turning `junctionReseat=false` off on TOP of that says whether §10.4
// is the pincher or merely the trigger.
const fitArg = argv.includes('--fit') ? argv[argv.indexOf('--fit') + 1] : ''
const FIT_OVERRIDE: Record<string, unknown> = {}
for (const kv of fitArg ? fitArg.split(',') : []) {
  const [k, v] = kv.split('=')
  FIT_OVERRIDE[k] = v === 'true' ? true : v === 'false' ? false : Number(v)
}
// `--roi x0,y0,x1,y1` scopes the per-colour masks (and so the survival table and the
// component census) to a pixel box. A whole-image survival number is BLIND to a small
// feature: issue #8's ▼ is ~30px of an ink mask ~40 000px wide, so every stage reads
// "flat" while the ▼ dies. Scope the lens to the feature and the killing stage shows.
const roiArg = argv.includes('--roi') ? argv[argv.indexOf('--roi') + 1] : ''
const ROI = roiArg.split(',').map(Number).filter(Number.isFinite)
// `--floor N` / `--share F` override minRegionArea / minShare INDEPENDENTLY. The
// Despeckle dial moves both at once (index.ts paletteOptionsFor), so the dial alone
// cannot attribute a loss to one of them — these can.
const floorArg = argv.includes('--floor') ? Number(argv[argv.indexOf('--floor') + 1]) : NaN
const shareArg = argv.includes('--share') ? Number(argv[argv.indexOf('--share') + 1]) : NaN
const names = argv.filter(
  (a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== fitArg && a !== roiArg && !/^[\d.]+$/.test(a),
)
const CASES = names.length ? names : ['hairlines', 'fluent-flute-flat', 'fluent-parachute-flat', 'fluent-beverage-box-flat']

// --- paletteOptionsFor (index.ts, verbatim at the gate's defaults) -----------
const DESPECKLE = DEFAULT_VECTORIZE_OPTIONS.despeckle ?? 0 // 25
const minRegionAreaFor = (d: number): number => Math.round((Math.min(100, Math.max(0, d)) / 100) ** 2 * 800)
const OPTS = {
  maxColors: 16,
  minShare: Number.isFinite(shareArg) ? shareArg : Math.max(0.0006, 0.006 + (DESPECKLE / 100) * 0.004), // detail 0
  modePasses: 2,
  minRegionArea: Number.isFinite(floorArg) ? floorArg : Math.max(24, minRegionAreaFor(DESPECKLE)),
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

// ---------------------------------------------------------------------------
// `--effect`: what the §20 evidence veto actually DOES to the corpus. Score every
// svgGround-scorable gallery mark flat @RES with `regionEvidence` off and on, and report
// every mark that moves — on the defect's own metrics (missed boundary, corner recall)
// AND on the metric the floor buys (node count). A fix measured only on its witness is a
// fix measured on the case it was fitted to.
// ---------------------------------------------------------------------------
if (argv.includes('--effect')) {
  const { readdirSync } = await import('node:fs')
  const { scoreGeometry } = await import('./geomScore.ts')
  const { parseGroundTruth, toRasterSpace, unscorable } = await import('./svgGround.ts')
  const dir = join(root, 'examples', 'logos')
  const only = argv.filter((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a))
  // PASS 1 — every mark, cheaply: does the veto change the OUTPUT at all? A mark with no
  // spared component is byte-identical by construction, and proving that beats asserting
  // it. Only a fingerprint is retained per mark (scoreGeometry is the expensive part and
  // runs in pass 2, on the movers alone).
  const movers: string[] = []
  let scanned = 0
  const fingerprint = async (img: ReturnType<typeof decodePng>, ev: boolean): Promise<string> => {
    const doc = await traceImage(img as unknown as ImageData, {
      ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, paletteSegment: { regionEvidence: ev },
    })
    let s = ''
    for (const it of doc.items) {
      if (it.kind !== 'path') continue
      s += `${it.fill}|${it.subPaths.length}|`
      for (const sp of it.subPaths) for (const n of sp.nodes) s += `${n.x.toFixed(3)},${n.y.toFixed(3)};`
    }
    return s
  }
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
    if (only.length && !only.includes(file.replace(/\.svg$/, ''))) continue
    let img
    try {
      img = decodePng(new Resvg(readFileSync(join(dir, file), 'utf8'), { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
    } catch { continue }
    scanned++
    if ((await fingerprint(img, false)) !== (await fingerprint(img, true))) movers.push(file)
  }
  console.log(`\n━━━ §20 EFFECT @ ${RES}px flat ━━━  pass 1: ${movers.length} of ${scanned} gallery marks change AT ALL`)

  interface Row { mark: string; dChamfer: number; dMissed: number; dCorners: number; dNodes: number; on: string }
  const rows: Row[] = []
  let scorable = 0
  // PASS 2 — the movers, scored against their authored geometry.
  for (const file of movers) {
    const text = readFileSync(join(dir, file), 'utf8')
    let gt
    try { gt = parseGroundTruth(text) } catch { console.log(`  ${file}: moves, but has no parsable ground truth`); continue }
    if (unscorable(gt)) { console.log(`  ${file}: moves, but is not svgGround-scorable`); continue }
    let img
    try {
      img = decodePng(new Resvg(text, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng())
    } catch { continue }
    scorable++
    const sh = toRasterSpace(gt, img.width)
    const score = async (ev: boolean): Promise<{ chamfer: number; missed: number; corners: number; got: number; nodes: number }> => {
      const doc = await traceImage(img as unknown as ImageData, {
        ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: false, paletteSegment: { regionEvidence: ev },
      })
      const g = scoreGeometry(sh, doc, img.width, img.height, img)
      const nodes = doc.items.reduce((s, it) => s + (it.kind === 'path' ? it.subPaths.reduce((t, sp) => t + sp.nodes.length, 0) : 0), 0)
      return { chamfer: g.chamfer, missed: g.missedMax, corners: g.gtCorners, got: g.cornersRecovered, nodes }
    }
    const off = await score(false)
    const on = await score(true)
    // No "unchanged ⇒ skip" filter here: pass 1 already proved this mark's geometry moves,
    // and a mover whose scores are flat is itself a result worth printing.
    rows.push({
      mark: file.replace(/\.svg$/, ''),
      dChamfer: on.chamfer - off.chamfer,
      dMissed: on.missed - off.missed,
      dCorners: on.got - off.got,
      dNodes: on.nodes - off.nodes,
      on: `chamfer ${on.chamfer.toFixed(4)}  missedMax ${on.missed.toFixed(2)}  corners ${on.got}/${on.corners}  nodes ${on.nodes}`,
    })
  }
  rows.sort((a, b) => a.dChamfer - b.dChamfer)
  console.log(`\n  pass 2: ${rows.length} of the ${scorable} scorable movers, scored against authored geometry`)
  console.log(`  ${'mark'.padEnd(28)}${'Δchamfer'.padStart(10)}${'ΔmissedMax'.padStart(12)}${'Δcorners'.padStart(10)}${'Δnodes'.padStart(8)}   after`)
  for (const r of rows)
    console.log(
      `  ${r.mark.padEnd(28)}${r.dChamfer.toFixed(4).padStart(10)}${r.dMissed.toFixed(2).padStart(12)}` +
        `${(r.dCorners > 0 ? '+' : '') + r.dCorners}`.padStart(10) + `${(r.dNodes > 0 ? '+' : '') + r.dNodes}`.padStart(8) + `   ${r.on}`,
    )
  const sum = (f: (r: Row) => number): number => rows.reduce((s, r) => s + f(r), 0)
  console.log(
    `\n  totals: Δchamfer ${sum((r) => r.dChamfer).toFixed(4)}  Δcorners ${sum((r) => r.dCorners) > 0 ? '+' : ''}${sum((r) => r.dCorners)}` +
      `  Δnodes ${sum((r) => r.dNodes) > 0 ? '+' : ''}${sum((r) => r.dNodes)}` +
      `   (marks better ${rows.filter((r) => r.dChamfer < 0).length}, worse ${rows.filter((r) => r.dChamfer > 0).length})`,
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// `--census`: the JOINT DISTRIBUTION behind issue #8's fix. Replay the palette path to
// the exact input of despeckleComponents on every scorable mark, enumerate every
// component the floor is about to dissolve, and dump each one's candidate evidence
// against an INDEPENDENT truth: what the art looks like at 4× the resolution.
//
// Truth axis `cov4` — the mean 4×-subpixel coverage of the component's own colour over
// its footprint. A component of authored ink reads ~1.0 (the shape really is solid
// there); a fringe speck that only snapped to the far colour reads well under 0.5 (the
// art there is mostly the OTHER colour). It is read off a higher-resolution render, so
// it is not a restatement of the 1× floors the fix would change.
//
// Candidate evidence axes (the §9.4 shape — flat interior at an accepted colour):
//   exactFrac  share of the component's pixels that are EXACTLY the palette hex in source
//   flat3      pixels whose full 3×3 source block is that exact hex
// The question this answers is whether they SEPARATE, and where — not whether the
// hypothesis feels right. Three §0 exits died of skipping this.
// ---------------------------------------------------------------------------
if (argv.includes('--census')) {
  const { readdirSync } = await import('node:fs')
  const limitArg = argv.includes('--limit') ? Number(argv[argv.indexOf('--limit') + 1]) : Infinity
  // Default lanes: the tier-0 fixtures (where the floor's CONTROLS live — aa-seam and
  // the sliver family) plus the gallery marks (where the defect was reported, and the
  // product target). The 218 Fluent tier-1/2 glyphs are opt-in with `--all`: each costs a
  // 2048px render, and tier 1 is gradient art the flat palette path never runs on.
  const sources: { name: string; svg: string }[] = []
  for (const c of TRUTH_CORPUS) if (argv.includes('--all') || c.tier === 0) sources.push({ name: c.name, svg: c.svg })
  for (const f of readdirSync(join(root, 'examples', 'logos')).filter((x) => x.endsWith('.svg')))
    sources.push({ name: f.replace(/\.svg$/, ''), svg: `examples/logos/${f}` })

  interface Rec {
    mark: string
    hex: string
    size: number
    exactPx: number
    flat3: number
    cov4: number
  }
  const recs: Rec[] = []
  let marks = 0
  for (const src of sources) {
    if (marks >= limitArg) break
    let svg: string
    try { svg = readFileSync(join(root, src.svg), 'utf8') } catch { continue }
    let img: Img, big: Img
    try {
      img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()) as unknown as Img
      big = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES * 4 }, background: 'white' }).render().asPng()) as unknown as Img
    } catch { continue }
    // The 4× render must be an exact 4× of the 1× one for the footprint mapping below.
    if (big.width !== img.width * 4 || big.height !== img.height * 4) continue
    marks++
    const { width: w, height: h, data } = img

    // Replay segmentFlatPalette's AUTO path to the input of despeckleComponents.
    let q: QuantizeResult = quantize(img as unknown as ImageData, OPTS.maxColors, OPTS.minRegionArea)
    const flat = flatInteriorCounts(img, q.labels, q.palette.length)
    const real = Array.from(flat, (v) => v >= OPTS.minRegionArea)
    const edgy = Array.from(edgeFractions(q.labels, w, h, q.palette.length), (fr) => fr >= EDGE_LOCAL_MIN)
    const { blend, routeTo } = classifyBlends(q.palette, real, edgy)
    const modal = modalColorCounts(q.labels, data, q.palette.length)
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
        if (l >= 0 && blend[l]) { labels[i] = routeTo[l]; snapExclude[i] = 1 }
      }
      q = { palette: q.palette, labels, counts }
    }
    const protect = real.map((r, i) => r || (!blend[i] && modal[i] >= OPTS.minRegionArea))
    q = dropMinorColors(q, OPTS.minShare, protect)
    const snapped = snapPaletteToModes(q.palette, q.labels, data, snapExclude)
    const smoothed = modeFilter(q.labels, w, h, OPTS.modePasses)
    const restored = restoreErasedComponents(q.labels, smoothed, w, h, OPTS.minRegionArea, data)

    // Every component the floor is about to eat.
    const n = w * h
    const seen = new Uint8Array(n)
    const labToLab = snapped.map((p) => srgbToLab(p.r, p.g, p.b))
    for (let start = 0; start < n; start++) {
      if (seen[start] || restored[start] < 0) continue
      const lab = restored[start]
      const px: number[] = [start]
      seen[start] = 1
      const stack = [start]
      while (stack.length) {
        const p = stack.pop()!
        const x = p % w, y = (p / w) | 0
        const push = (nb: number): void => {
          if (seen[nb] || restored[nb] !== lab) return
          seen[nb] = 1; stack.push(nb); px.push(nb)
        }
        if (x > 0) push(p - 1)
        if (x < w - 1) push(p + 1)
        if (y > 0) push(p - w)
        if (y < h - 1) push(p + w)
      }
      if (px.length >= OPTS.minRegionArea) continue
      const c = snapped[lab]
      let exactPx = 0, flat3 = 0, cov = 0
      const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
      const key = (c.r << 16) | (c.g << 8) | c.b
      for (const i of px) {
        if (rgbAt(i) === key) exactPx++
        const x = i % w, y = (i / w) | 0
        if (x > 0 && x < w - 1 && y > 0 && y < h - 1) {
          let all = true
          for (let dy = -1; dy <= 1 && all; dy++) for (let dx = -1; dx <= 1; dx++) if (rgbAt(i + dy * w + dx) !== key) { all = false; break }
          if (all) flat3++
        }
        // 4× footprint: the 4×4 subpixel block this pixel expands to.
        let hit = 0
        for (let dy = 0; dy < 4; dy++) {
          for (let dx = 0; dx < 4; dx++) {
            const bi = ((y * 4 + dy) * big.width + (x * 4 + dx)) * 4
            if (deltaE76(srgbToLab(big.data[bi], big.data[bi + 1], big.data[bi + 2]), labToLab[lab]) <= 4) hit++
          }
        }
        cov += hit / 16
      }
      recs.push({ mark: src.name, hex: hex(c), size: px.length, exactPx, flat3, cov4: cov / px.length })
    }
  }

  console.log(`\n━━━ SUB-FLOOR COMPONENT CENSUS @ ${RES}px ━━━  ${recs.length} components below the ${OPTS.minRegionArea}px floor across ${marks} marks`)
  const bucket = (r: Rec): string => (r.cov4 >= 0.9 ? 'SOLID  (cov4 ≥ .90)' : r.cov4 >= 0.5 ? 'MIXED  (.50–.90)' : 'FRINGE (cov4 < .50)')
  const groups = new Map<string, Rec[]>()
  for (const r of recs) groups.set(bucket(r), [...(groups.get(bucket(r)) ?? []), r])
  const pct = (v: number[], p: number): number => (v.length ? v.slice().sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN)
  console.log(`\n  truth bucket        n     size p10/p50/p90      exactFrac p10/p50/p90      flat3 p50   flat3=0`)
  for (const k of ['SOLID  (cov4 ≥ .90)', 'MIXED  (.50–.90)', 'FRINGE (cov4 < .50)']) {
    const g = groups.get(k) ?? []
    if (!g.length) { console.log(`  ${k.padEnd(20)} 0`); continue }
    const sz = g.map((r) => r.size), ef = g.map((r) => r.exactPx / r.size), f3 = g.map((r) => r.flat3)
    console.log(
      `  ${k.padEnd(20)}${String(g.length).padStart(4)}   ${pct(sz, 0.1)}/${pct(sz, 0.5)}/${pct(sz, 0.9)}`.padEnd(52) +
        `${pct(ef, 0.1).toFixed(3)}/${pct(ef, 0.5).toFixed(3)}/${pct(ef, 0.9).toFixed(3)}`.padEnd(28) +
        `${pct(f3, 0.5)}`.padEnd(12) + `${g.filter((r) => r.flat3 === 0).length}`,
    )
  }
  // Separability: sweep each candidate veto and report what it does to BOTH classes.
  const solid = recs.filter((r) => r.cov4 >= 0.9), mixed = recs.filter((r) => r.cov4 >= 0.5 && r.cov4 < 0.9), fringe = recs.filter((r) => r.cov4 < 0.5)
  console.log(`\n  SEPARABILITY A — "keep a sub-floor component when exactFrac ≥ t"`)
  console.log(`    t       SOLID kept        MIXED kept        FRINGE kept (regressions)`)
  for (const t of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) {
    const k = (g: Rec[]): string => `${g.filter((r) => r.exactPx / r.size >= t).length}/${g.length}`
    console.log(`    ${t.toFixed(2)}    ${k(solid).padEnd(18)}${k(mixed).padEnd(18)}${k(fringe)}`)
  }
  console.log(`\n  SEPARABILITY B — "keep a sub-floor component when flat3 ≥ t" (the §9.4 axis, per COMPONENT)`)
  console.log(`    t       SOLID kept        MIXED kept        FRINGE kept (regressions)`)
  for (const t of [1, 2, 3, 4, 5, 6, 8, 10, 12, 16]) {
    const k = (g: Rec[]): string => `${g.filter((r) => r.flat3 >= t).length}/${g.length}`
    console.log(`    ${String(t).padEnd(6)}  ${k(solid).padEnd(18)}${k(mixed).padEnd(18)}${k(fringe)}`)
  }
  const withF3 = recs.filter((r) => r.flat3 > 0).sort((a, b) => a.flat3 - b.flat3)
  console.log(`\n  flat3 > 0 population (${withF3.length} of ${recs.length}) — every one, so the margin is visible, not assumed`)
  for (const r of withF3)
    console.log(
      `    flat3 ${String(r.flat3).padStart(3)}  ${r.mark.padEnd(26)} ${r.hex}  ${String(r.size).padStart(3)}px` +
        `  exactFrac ${(r.exactPx / r.size).toFixed(3)}  cov4 ${r.cov4.toFixed(3)}  ${r.cov4 >= 0.9 ? 'SOLID' : r.cov4 >= 0.5 ? 'MIXED' : '⇐ FRINGE'}`,
    )
  console.log(`\n  the 12 largest SOLID components (what the floor is destroying)`)
  for (const r of solid.slice().sort((a, b) => b.size - a.size).slice(0, 12))
    console.log(`    ${r.mark.padEnd(26)} ${r.hex}  ${String(r.size).padStart(3)}px  exactFrac ${(r.exactPx / r.size).toFixed(3)}  flat3 ${String(r.flat3).padStart(3)}  cov4 ${r.cov4.toFixed(3)}`)
  console.log(`\n  the 12 FRINGE components with the highest exactFrac (what a veto would resurrect)`)
  for (const r of fringe.slice().sort((a, b) => b.exactPx / b.size - a.exactPx / a.size).slice(0, 12))
    console.log(`    ${r.mark.padEnd(26)} ${r.hex}  ${String(r.size).padStart(3)}px  exactFrac ${(r.exactPx / r.size).toFixed(3)}  flat3 ${String(r.flat3).padStart(3)}  cov4 ${r.cov4.toFixed(3)}`)
  process.exit(0)
}

// --- the run -----------------------------------------------------------------

for (const name of CASES) {
  // Fixture corpus first; else the private gallery corpus (issue #8's ▼ lives on
  // logo-ibm — `npm run fetch:logos` rehydrates examples/logos/).
  // The gallery fallback must carry `gradients: false` explicitly: leaving it undefined
  // makes the FINAL/autopsy sections below trace the mark with gradients ON (index.ts
  // reads `gradients !== false`) — i.e. down the Mumford–Shah path, not the flat palette
  // path this whole file replays. It reported the two lanes as one.
  const c: { svg: string; gradients: boolean } =
    TRUTH_CORPUS.find((x) => x.name === name) ?? { svg: `examples/logos/${name}.svg`, gradients: false }
  let svg: string
  try {
    svg = readFileSync(join(root, c.svg), 'utf8')
  } catch {
    console.log(`⨯ unknown case ${name}`)
    continue
  }
  const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: RES }, background: 'white' }).render().asPng()) as unknown as Img
  const { width: w, height: h, data } = img
  const total = w * h
  const authored = authoredColors(svg)

  console.log(`\n━━━ ${name} @ ${RES}px ━━━  floors: minShare ${OPTS.minShare} (${Math.round(OPTS.minShare * total)}px of ${total}), minRegionArea ${OPTS.minRegionArea}px`)

  // The ROI lens, if asked for. `inRoi` gates the per-colour masks below; every stage
  // number downstream of them (survival, component census) is then ROI-local.
  const roiBox = ROI.length === 4 ? { x0: ROI[0], y0: ROI[1], x1: ROI[2], y1: ROI[3] } : null
  const inRoi = (i: number): boolean => {
    if (!roiBox) return true
    const x = i % w, y = (i / w) | 0
    return x >= roiBox.x0 && x <= roiBox.x1 && y >= roiBox.y0 && y <= roiBox.y1
  }
  if (roiBox) console.log(`  ROI ${roiBox.x0},${roiBox.y0} → ${roiBox.x1},${roiBox.y1}  (masks + survival + census scoped to it)`)

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
    if (best >= 0 && inRoi(i)) masks[best][i] = 1
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

  // ROI COMPONENT CENSUS — the survival table is a per-pixel FRACTION, which reports a
  // whole small component vanishing and its neighbour bleeding in as the same number.
  // The area floors are per-COMPONENT, so census the components themselves: 4-connected
  // (despeckleComponents' own connectivity), sized on the FULL label map (the size the
  // floor actually reads), listed for every stage. A component that appears in one row
  // and is gone from the next names the killing stage AND its size vs the floor.
  if (roiBox) {
    console.log(`\n  ROI COMPONENT CENSUS — 4-conn components of the ROI's ink label, sized whole (floor ${OPTS.minRegionArea}px)`)
    // Which authored colour dominates the ROI? That is the feature under test.
    let ink = -1, inkN = 0
    for (let a = 0; a < authored.length; a++) {
      const n = masks[a].reduce((s, v) => s + v, 0)
      // Skip the paper: the ROI's background is whatever covers the most of it, and the
      // feature is the SECOND colour. Rank by "not the ROI majority" instead of guessing.
      if (n > inkN) { inkN = n; ink = a }
    }
    // The feature colour = the ROI's minority authored colour with ≥ 4px of mask.
    let feat = -1, featN = 0
    for (let a = 0; a < authored.length; a++) {
      if (a === ink) continue
      const n = masks[a].reduce((s, v) => s + v, 0)
      if (n > featN) { featN = n; feat = a }
    }
    for (const [who, a] of [['ROI-majority', ink], ['ROI-feature', feat]] as [string, number][]) {
      if (a < 0) continue
      const tLab = srgbToLab(authored[a].r, authored[a].g, authored[a].b)
      console.log(`    ${who} ${hex(authored[a])} (${masks[a].reduce((s, v) => s + v, 0)}px of ROI mask)`)
      for (const st of stages) {
        const near = st.palette.map((p) => deltaE76(srgbToLab(p.r, p.g, p.b), tLab) <= 4)
        const seen = new Int32Array(total).fill(0)
        const sizes: number[] = []
        // Seed only from ROI pixels, but flood the WHOLE component (the floor's view).
        for (let i = 0; i < total; i++) {
          if (!masks[a][i] || seen[i]) continue
          const lab = st.labels[i]
          if (lab < 0 || !near[lab]) continue
          const stack = [i]
          seen[i] = 1
          let size = 0
          while (stack.length) {
            const p = stack.pop()!
            size++
            const x = p % w, y = (p / w) | 0
            const push = (nb: number): void => {
              if (seen[nb] || st.labels[nb] !== lab) return
              seen[nb] = 1
              stack.push(nb)
            }
            if (x > 0) push(p - 1)
            if (x < w - 1) push(p + 1)
            if (y > 0) push(p - w)
            if (y < h - 1) push(p + w)
          }
          sizes.push(size)
        }
        sizes.sort((p, r) => r - p)
        console.log(
          `      ${st.name.padEnd(10)} ${String(sizes.length).padStart(2)} comp  [${sizes.slice(0, 6).join(', ')}${sizes.length > 6 ? ', …' : ''}]` +
            `${sizes.length === 0 ? '   ⇐ GONE' : sizes.every((s) => s < OPTS.minRegionArea) ? `   ⇐ all below the ${OPTS.minRegionArea}px floor` : ''}`,
        )
      }
    }
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
  const doc = await traceImage(img as unknown as ImageData, {
    ...DEFAULT_VECTORIZE_OPTIONS,
    engine: 'planar',
    gradients: c.gradients,
    ...(Object.keys(FIT_OVERRIDE).length ? { planarFit: FIT_OVERRIDE } : {}),
  })
  const r = scoreRegions(img as unknown as ImageData, doc)
  const fitNote = Object.keys(FIT_OVERRIDE).length ? `  [planarFit ${fitArg}]` : ''
  console.log(`\n  FINAL (traceImage + scoreRegions): ${r.recovered}/${r.trueRegions} regions${fitNote}`)
  for (const miss of r.missing) console.log(`    ✗ ${miss.hex} (${miss.areaPx}px) painted ${miss.paintedHex}, ΔE ${miss.deltaE.toFixed(1)}`)

  // Doc-level autopsy per authored colour: does a path with that fill even EXIST, and
  // with what geometry? Separates "the label died in segmentation" from "the label
  // survived and the FIT/doc-build collapsed it" (the §9.5 zero-area-path family, which
  // boundary metrics are blind to — renders are part of the exit protocol for a reason).
  //
  // Runs for EVERY authored colour, not only the ones scoreRegions already calls missing:
  // §0 #14 is exactly a region whose median survives (so the gate is green) while its INK
  // is a fraction of the source's — the collapse is a ratio, not a flip, and a
  // missing-only autopsy cannot see it coming (or going).
  {
    const render = rasterizeDoc(doc, w, h)
    console.log(`\n  DOC AUTOPSY — ink kept per authored colour (src px vs rendered px, ΔE ≤ 4)`)
    for (let a = 0; a < authored.length; a++) {
      const target = authored[a]
      if (masks[a].reduce((s, v) => s + v, 0) < 8) continue
      const tLab = srgbToLab(target.r, target.g, target.b)
      const carriers = doc.items.filter((it) => {
        if (it.kind !== 'path') return false
        const f = parseInt(it.fill.slice(1), 16)
        return deltaE76(srgbToLab((f >> 16) & 0xff, (f >> 8) & 0xff, f & 0xff), tLab) <= 4
      })
      let rendered = 0
      let src = 0
      for (let i = 0; i < w * h; i++) {
        const lab = srgbToLab(render[i * 4], render[i * 4 + 1], render[i * 4 + 2])
        if (deltaE76(lab, tLab) <= 4) rendered++
        const o = i * 4
        if (data[o] === target.r && data[o + 1] === target.g && data[o + 2] === target.b) src++
      }
      const keep = src > 0 ? rendered / src : NaN
      console.log(
        `    ${hex(target)}  src ${String(src).padStart(7)}px  render ${String(rendered).padStart(7)}px` +
          `  ink ${(keep * 100).toFixed(1).padStart(6)}%  ${carriers.length} item(s)` +
          `${Number.isFinite(keep) && keep < 0.5 ? '   ⇐ INK COLLAPSED' : ''}`,
      )
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
