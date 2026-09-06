// The `minRegionArea` area-floor family (issue #37) — census + counterfactual. MEASUREMENT
// ONLY: nothing under src/lib/trace is modified, and nothing here is a fix.
//
//   node --experimental-strip-types src/devtest/floorDiag.ts --lane tier2 --res 256,512
//   node --experimental-strip-types src/devtest/floorDiag.ts --lane gallery --res 256,1024 [--limit N] [mark ...]
//   node --experimental-strip-types src/devtest/floorDiag.ts --lane gallery --res 256 ibm fedex-wm --verbose
//
// Two questions, both answered PER RASTER, because the whole issue is that the floors are
// absolute px² while the art they judge scales with the raster:
//
//  1. CENSUS — how many authored features sit under each floor the Despeckle dial drives.
//     Per authored colour (parsed from the SVG's fills, crossed with the raster):
//       real[] / anchor   its 3×3 flat-interior pixel count (paletteSegment flatInteriorCounts
//                         per label, quantize flatCount per exact RGB — the same measurement)
//       modal[]           its exact-RGB pixel count (modalColorCounts)
//     Per 4-connected component of its ≥50%-coverage footprint (nearest authored colour):
//       despeckle         the component's pixel count — with or without the §20 evidence
//                         (a 3×3 block of its own hex inside the component) that would spare it
//     Counted against the production floor (F_DIAL, 50 at dial 25) AND the raster-relative
//     floor the counterfactual uses, so the two contracts can be read side by side.
//
//  2. COUNTERFACTUAL — the issue's first candidate shape: keep the dial's number at 512 and
//     express the INTERNAL floors relative to the raster with the dial as the multiplier,
//         F_rel(w) = round(F_DIAL · (w / 512)²)          (13 @256, 50 @512, 200 @1024)
//     Three recipes, each traced through the PRODUCTION pipeline and scored the tier-2 region
//     lane's way (scoreRegions: regions recovered + ink kept), against production P:
//       A   anchor / real / modal at F_rel; restore + despeckle at F_DIAL   ← the issue's shape
//       B   all five at F_rel                                              ← "the dial is a strength"
//       C   anchor / real / modal at F_DIAL; restore + despeckle at F_rel  ← the complement, for attribution
//     At 512 every recipe equals P by construction; the tier-2 lane traces it anyway as the control.
//
// HOW the split reaches production code without touching it: paletteSegment.ts reads
// `opts.minRegionArea` in exactly five places, one per consumer. A SHADOW copy written to the
// OS temp dir rewrites each read to `__floor(opts, '<consumer>')` (an optional per-consumer
// override riding on the existing `paletteSegment` options spread; absent ⇒ `opts.minRegionArea`,
// the production value), and a shadow index.ts imports that copy. Every other byte is the
// production source with its relative imports resolved to the real modules, so the shadow shares
// quantize / planar / beautify with the real tracer. Each rewrite must match EXACTLY ONCE or the
// run aborts — a refactor cannot silently desync it. The shadow with no override is asserted
// byte-identical (hashDoc) to the real `traceImage` on the tier-2 lane and a gallery sample.
//
// Cost control: a recipe is only worth fitting if it changed the segmentation. The shadow taps the
// final label map + palette right before `tracePlanar`, and a recipe whose labels AND palette equal
// P's aborts there — segmentation cost only, no fit — and is reported as identical.

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Resvg } from '@resvg/resvg-js'
import { decodePng } from './png.ts'
import { ensureImageData } from './nodeHarness.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { scoreRegions, type RegionScore } from './geomScore.ts'
import { hashDoc } from './metrics.ts'
import { TIER2_REGION_CORPUS, TRUTH_CORPUS } from './truthCorpus.ts'
import type { EditableDoc } from '../lib/path/types'
import type { PaletteColor } from '../lib/trace/types'

ensureImageData()
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const VALUE_FLAGS = new Set(['--lane', '--res', '--limit', '--fidelity', '--json'])
const flag = (k: string): string => (argv.includes(k) ? (argv[argv.indexOf(k) + 1] ?? '') : '')
const LANE = (flag('--lane') || 'tier2') as 'tier2' | 'tier0' | 'gallery'
const RESOLUTIONS = (flag('--res') || (LANE === 'gallery' ? '256,1024' : '256,512')).split(',').map(Number).filter(Number.isFinite)
const LIMIT = Number(flag('--limit')) || Infinity
/** 'sample' (tier-2 lane in full + the first 8 gallery marks), 'all', or 'none'. */
const FIDELITY = flag('--fidelity') || 'sample'
const VERBOSE = argv.includes('--verbose')
const JSON_OUT = flag('--json')
const ONLY = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])))

// --- the floors, verbatim from index.ts paletteOptionsFor at the gate's dials -----------
const DIAL = DEFAULT_VECTORIZE_OPTIONS.despeckle ?? 0
const F_DIAL = Math.max(24, Math.round((Math.min(100, Math.max(0, DIAL)) / 100) ** 2 * 800))
const REF_RES = 512
const relFloor = (w: number): number => Math.round(F_DIAL * (w / REF_RES) ** 2)

type Consumer = 'anchor' | 'real' | 'modal' | 'restore' | 'despeckle'
type Floors = Record<Consumer, number>
interface Recipe { key: string; label: string; floors: Floors }
const recipesFor = (w: number): Recipe[] => {
  const R = relFloor(w), F = F_DIAL
  return [
    { key: 'A', label: `A  internal ${R} · despeckle ${F}`, floors: { anchor: R, real: R, modal: R, restore: F, despeckle: F } },
    { key: 'B', label: `B  all ${R}`, floors: { anchor: R, real: R, modal: R, restore: R, despeckle: R } },
    { key: 'C', label: `C  internal ${F} · despeckle ${R}`, floors: { anchor: F, real: F, modal: F, restore: R, despeckle: R } },
  ]
}

// --- the shadow build --------------------------------------------------------------------
const traceDir = join(root, 'src', 'lib', 'trace')
const shadowDir = join(tmpdir(), 'logolab-floorDiag')
mkdirSync(shadowDir, { recursive: true })

/** Resolve every relative `from '…'` to the REAL module's file URL, so the shadow shares
 *  quantize / planar / beautify instances with the real tracer. */
const absolutize = (src: string, fromDir: string): string =>
  src.replace(/from '(\.\.?\/[^']+)'/g, (_m, rel: string) => `from '${pathToFileURL(join(fromDir, rel)).href}'`)

function patchOnce(src: string, find: string, replace: string, what: string): string {
  const n = src.split(find).length - 1
  if (n !== 1) {
    throw new Error(
      `floorDiag shadow patch "${what}": expected exactly 1 match, found ${n}.\n` +
        `The production source changed shape — re-verify the floor reads in paletteSegment.ts / index.ts before trusting this diag.`,
    )
  }
  return src.replace(find, replace)
}

function buildShadow(): string {
  let ps = readFileSync(join(traceDir, 'paletteSegment.ts'), 'utf8').replace(/\r\n/g, '\n')
  if (/import\(\s*['"]\./.test(ps)) throw new Error('paletteSegment.ts has a relative dynamic import the shadow cannot resolve')
  ps = patchOnce(ps,
    `let q = quantize(img as ImageData, opts.maxColors, opts.minRegionArea)`,
    `let q = quantize(img as ImageData, opts.maxColors, __floor(opts, 'anchor'))`, 'anchor floor (quantize keepDistinctMinArea)')
  ps = patchOnce(ps,
    `const real = Array.from(flat, (c) => c >= opts.minRegionArea)`,
    `const real = Array.from(flat, (c) => c >= __floor(opts, 'real'))`, 'real[] flat-interior floor')
  ps = patchOnce(ps,
    `const protect = real.map((r, i) => r || (!blend[i] && modal[i] >= opts.minRegionArea))`,
    `const protect = real.map((r, i) => r || (!blend[i] && modal[i] >= __floor(opts, 'modal')))`, 'modal[] thin-feature floor')
  ps = patchOnce(ps,
    `const restored = restoreErasedComponents(labels, smoothed, img.width, img.height, opts.minRegionArea, img.data)`,
    `const restored = restoreErasedComponents(labels, smoothed, img.width, img.height, __floor(opts, 'restore'), img.data)`, 'restoreErasedComponents floor')
  ps = patchOnce(ps,
    `    opts.minRegionArea,\n    opts.regionEvidence !== false`,
    `    __floor(opts, 'despeckle'),\n    opts.regionEvidence !== false`, 'despeckleComponents floor')
  if (ps.includes('opts.minRegionArea')) throw new Error('floorDiag shadow: an unpatched `opts.minRegionArea` read remains in paletteSegment.ts')
  ps = `// SHADOW of src/lib/trace/paletteSegment.ts written by floorDiag.ts — five floor reads split per consumer. Not source.\n` +
    `const __floor = (o: any, k: string): number => o.__floors?.[k] ?? o.minRegionArea\n` + absolutize(ps, traceDir)
  const psPath = join(shadowDir, 'paletteSegment.shadow.ts')
  writeFileSync(psPath, ps)

  let ix = readFileSync(join(traceDir, 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
  if (/import\(\s*['"]\./.test(ix)) throw new Error('index.ts has a relative dynamic import the shadow cannot resolve')
  ix = patchOnce(ix, `from './paletteSegment.ts'`, `from '${pathToFileURL(psPath).href}'`, 'paletteSegment import')
  ix = patchOnce(ix,
    `    if (!locked && (fp.flatCoverage < FLAT_PALETTE_MIN_COVERAGE || fp.dominantColors > FLAT_PALETTE_MAX_COLORS)) fp = null`,
    `    ;(globalThis as any).__floorDiagFp = { dominantColors: fp.dominantColors, flatCoverage: fp.flatCoverage, paletteLen: fp.palette.length }\n` +
      `    if (!locked && (fp.flatCoverage < FLAT_PALETTE_MIN_COVERAGE || fp.dominantColors > FLAT_PALETTE_MAX_COLORS)) fp = null\n` +
      `    ;(globalThis as any).__floorDiagEngine = fp ? 'palette' : 'ms'`, 'engine gate tap')
  ix = patchOnce(ix,
    `    onPlanarLabels?.({ labels, width, height })`,
    `    ;(globalThis as any).__floorDiagPalette = q.palette\n    onPlanarLabels?.({ labels, width, height })`, 'palette tap')
  ix = `// SHADOW of src/lib/trace/index.ts written by floorDiag.ts — imports the shadow paletteSegment; two diagnostic taps. Not source.\n` +
    absolutize(ix, traceDir)
  const ixPath = join(shadowDir, 'index.shadow.ts')
  writeFileSync(ixPath, ix)
  return ixPath
}

const shadow = (await import(pathToFileURL(buildShadow()).href)) as { traceImage: typeof traceImage }

// --- tracing through the shadow ------------------------------------------------------------
type Img = { width: number; height: number; data: Uint8ClampedArray }
interface Traced {
  doc: EditableDoc
  labels: Int32Array
  palette: PaletteColor[]
  engine: string
  fp: { dominantColors: number; flatCoverage: number; paletteLen: number } | null
}
const IDENTICAL = new Error('floorDiag: identical segmentation')

const sameLabels = (a: Int32Array, b: Int32Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
const samePalette = (a: PaletteColor[], b: PaletteColor[]): boolean =>
  a.length === b.length && a.every((c, i) => c.r === b[i].r && c.g === b[i].g && c.b === b[i].b && (c.a ?? 255) === (b[i].a ?? 255))

async function traceWith(img: Img, floors: Floors | null, gradients: boolean, ref?: Traced): Promise<Traced | 'identical'> {
  const g = globalThis as any
  g.__floorDiagEngine = 'none'
  g.__floorDiagPalette = null
  g.__floorDiagFp = null
  let labels: Int32Array | null = null
  try {
    const doc = await shadow.traceImage(
      img as unknown as ImageData,
      {
        ...DEFAULT_VECTORIZE_OPTIONS,
        engine: 'planar',
        gradients,
        ...(floors ? { paletteSegment: { __floors: floors } as any } : {}),
      },
      undefined, undefined, undefined, undefined,
      (l) => {
        labels = l.labels
        if (ref && sameLabels(ref.labels, l.labels) && samePalette(ref.palette, g.__floorDiagPalette)) throw IDENTICAL
      },
    )
    return { doc, labels: labels!, palette: g.__floorDiagPalette, engine: g.__floorDiagEngine, fp: g.__floorDiagFp }
  } catch (e) {
    if (e === IDENTICAL) return 'identical'
    throw e
  }
}

const nodesOf = (doc: EditableDoc): number =>
  doc.items.reduce((s, it) => s + (it.kind === 'path' ? it.subPaths.reduce((t, sp) => t + sp.nodes.length, 0) : 0), 0)
const itemsOf = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path').length

// --- the census ----------------------------------------------------------------------------
const hexOf = (k: number): string => '#' + (k >>> 0).toString(16).padStart(6, '0')

/** Authored fills/strokes from the SVG source: fill="#hex", fill:#hex (style/CSS), rgb(). Gradient
 *  stops are excluded (a ramp is not a flat feature). 3/4-digit hex expanded, 8-digit truncated. */
function parseAuthored(svg: string): Set<number> {
  const out = new Set<number>()
  const addHex = (h: string): void => {
    let s = h
    if (s.length === 3 || s.length === 4) s = s.slice(0, 3).split('').map((c) => c + c).join('')
    else if (s.length === 8) s = s.slice(0, 6)
    if (s.length === 6) out.add(parseInt(s, 16))
  }
  for (const m of svg.matchAll(/(?:^|[\s;"'{])(?:fill|stroke)\s*[:=]\s*["']?\s*#([0-9a-fA-F]{3,8})\b/g)) addHex(m[1])
  for (const m of svg.matchAll(/(?:^|[\s;"'{])(?:fill|stroke)\s*[:=]\s*["']?\s*rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g))
    out.add((Number(m[1]) << 16) | (Number(m[2]) << 8) | Number(m[3]))
  return out
}

interface ColourCensus {
  hex: string
  key: number
  exactPx: number
  flat3: number
  /** 4-connected components of the colour's ≥50%-coverage footprint; `evidence` = the component
   *  contains a full 3×3 block of its own hex (what §20's veto reads). */
  comps: { size: number; evidence: boolean }[]
}

function census(img: Img, svg: string): { colours: ColourCensus[]; derived: boolean } {
  const { width: w, height: h, data } = img
  const n = w * h
  const rgbAt = (i: number): number => (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2]
  const exact = new Map<number, number>()
  for (let i = 0; i < n; i++) exact.set(rgbAt(i), (exact.get(rgbAt(i)) ?? 0) + 1)
  const flatMask = new Uint8Array(n)
  const flat3 = new Map<number, number>()
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const k = rgbAt(i)
      if (
        rgbAt(i - w - 1) === k && rgbAt(i - w) === k && rgbAt(i - w + 1) === k &&
        rgbAt(i - 1) === k && rgbAt(i + 1) === k &&
        rgbAt(i + w - 1) === k && rgbAt(i + w) === k && rgbAt(i + w + 1) === k
      ) { flatMask[i] = 1; flat3.set(k, (flat3.get(k) ?? 0) + 1) }
    }
  }
  // Authored colour set: the SVG's fills that actually appear in the raster, plus the paper.
  let keys = [...parseAuthored(svg)].filter((k) => (exact.get(k) ?? 0) > 0)
  let derived = false
  if (keys.filter((k) => k !== 0xffffff).length === 0) {
    // Nothing parsable (CSS classes, currentColor, …): fall back to the raster's own solid inks.
    derived = true
    keys = [...flat3.entries()].filter(([, c]) => c >= 16).map(([k]) => k)
  }
  if (!keys.includes(0xffffff) && (exact.get(0xffffff) ?? 0) > 0) keys.push(0xffffff)
  keys.sort((a, b) => (exact.get(b) ?? 0) - (exact.get(a) ?? 0))
  const cols = keys.map((k) => ({ r: (k >> 16) & 255, g: (k >> 8) & 255, b: k & 255 }))
  // Nearest authored colour per pixel — the ≥50%-coverage footprint, AA included.
  const assign = new Int32Array(n)
  const cache = new Map<number, number>()
  for (let i = 0; i < n; i++) {
    const k = rgbAt(i)
    let a = cache.get(k)
    if (a === undefined) {
      const r = (k >> 16) & 255, g = (k >> 8) & 255, b = k & 255
      let best = 0, bd = Infinity
      for (let c = 0; c < cols.length; c++) {
        const dr = r - cols[c].r, dg = g - cols[c].g, db = b - cols[c].b
        const d = dr * dr + dg * dg + db * db
        if (d < bd) { bd = d; best = c }
      }
      a = best
      cache.set(k, a)
    }
    assign[i] = a
  }
  const comps: { size: number; evidence: boolean }[][] = keys.map(() => [])
  const seen = new Uint8Array(n)
  const stack: number[] = []
  for (let start = 0; start < n; start++) {
    if (seen[start]) continue
    const a = assign[start]
    const key = keys[a]
    seen[start] = 1
    stack.length = 0
    stack.push(start)
    let size = 0, evidence = false
    while (stack.length) {
      const p = stack.pop()!
      size++
      if (!evidence && flatMask[p] && rgbAt(p) === key) evidence = true
      const x = p % w, y = (p / w) | 0
      if (x > 0 && !seen[p - 1] && assign[p - 1] === a) { seen[p - 1] = 1; stack.push(p - 1) }
      if (x < w - 1 && !seen[p + 1] && assign[p + 1] === a) { seen[p + 1] = 1; stack.push(p + 1) }
      if (y > 0 && !seen[p - w] && assign[p - w] === a) { seen[p - w] = 1; stack.push(p - w) }
      if (y < h - 1 && !seen[p + w] && assign[p + w] === a) { seen[p + w] = 1; stack.push(p + w) }
    }
    comps[a].push({ size, evidence })
  }
  return {
    derived,
    colours: keys.map((k, a) => ({
      hex: hexOf(k), key: k, exactPx: exact.get(k) ?? 0, flat3: flat3.get(k) ?? 0,
      comps: comps[a].sort((p, q) => q.size - p.size),
    })),
  }
}

interface FloorCounts {
  colours: number
  underReal: number
  underModal: number
  comps: number
  underDespeckle: number
  underDespeckleNoEvidence: number
  /** …of which ≥ 9px — big enough to hold a 3×3 block yet carrying none: thin or fringe, ambiguous. */
  underDespeckleNoEvidenceGe9: number
  /** colours whose EVERY footprint component is under the despeckle floor (the whole feature). */
  wholeColourUnder: number
}
function countUnder(cs: ColourCensus[], F: number): FloorCounts {
  const out: FloorCounts = { colours: cs.length, underReal: 0, underModal: 0, comps: 0, underDespeckle: 0, underDespeckleNoEvidence: 0, underDespeckleNoEvidenceGe9: 0, wholeColourUnder: 0 }
  for (const c of cs) {
    if (c.flat3 < F) out.underReal++
    if (c.exactPx < F) out.underModal++
    out.comps += c.comps.length
    let allUnder = c.comps.length > 0
    for (const k of c.comps) {
      if (k.size < F) {
        out.underDespeckle++
        if (!k.evidence) {
          out.underDespeckleNoEvidence++
          if (k.size >= 9) out.underDespeckleNoEvidenceGe9++
        }
      } else allUnder = false
    }
    if (allUnder) out.wholeColourUnder++
  }
  return out
}
const addCounts = (a: FloorCounts, b: FloorCounts): void => { for (const k of Object.keys(a) as (keyof FloorCounts)[]) a[k] += b[k] }
const zeroCounts = (): FloorCounts => ({ colours: 0, underReal: 0, underModal: 0, comps: 0, underDespeckle: 0, underDespeckleNoEvidence: 0, underDespeckleNoEvidenceGe9: 0, wholeColourUnder: 0 })

// --- sources ---------------------------------------------------------------------------------
interface Src { name: string; svg: string; gradients: boolean; inkFamilies?: string[][] }
let sources: Src[] =
  LANE === 'tier2'
    ? TIER2_REGION_CORPUS.map((c) => ({ name: c.name, svg: join(root, c.svg), gradients: c.gradients, inkFamilies: c.inkFamilies }))
    : LANE === 'tier0'
      ? // The flat tier-0 fixtures — the family's own witnesses live here (hairlines, peak-drop, scale-blind, checker).
        TRUTH_CORPUS.filter((c) => c.tier === 0 && !c.gradients).map((c) => ({ name: c.name, svg: join(root, c.svg), gradients: false, inkFamilies: c.inkFamilies }))
      : readdirSync(join(root, 'examples', 'logos'))
        .filter((f) => f.endsWith('.svg'))
        .map((f) => ({ name: f.replace(/\.svg$/, ''), svg: join(root, 'examples', 'logos', f), gradients: false }))
if (ONLY.length) sources = sources.filter((s) => ONLY.includes(s.name))
if (sources.length > LIMIT) sources = sources.slice(0, LIMIT)
if (sources.length === 0) {
  console.log(`⨯ no cases (lane ${LANE}${LANE === 'gallery' ? ' — is examples/logos fetched? `npm run fetch:logos`' : ''})`)
  process.exit(1)
}

// --- the run ---------------------------------------------------------------------------------
const pp = (v: number): string => (v * 100).toFixed(1) + '%'
const sgn = (v: number, d = 0): string => (v > 0 ? '+' : '') + v.toFixed(d)
interface InkRow { hex: string; kept: number; srcPx: number }
const inkOf = (r: RegionScore): InkRow[] => r.ink.map((i) => ({ hex: i.hex, kept: i.kept, srcPx: i.srcPx }))

interface CaseRow {
  res: number
  name: string
  width: number
  height: number
  derived: boolean
  censusAbs: FloorCounts
  censusRel: FloorCounts
  P: { regions: number; trueRegions: number; worstInk: number; nodes: number; items: number; engine: string; fp: Traced['fp']; hash: string }
  fidelity?: 'identical' | 'DIFFERS' | 'skipped'
  recipes: {
    key: string
    outcome: 'identical' | 'same-doc' | 'changed' | 'by-construction'
    regions?: number
    worstInk?: number
    nodes?: number
    items?: number
    engine?: string
    fp?: Traced['fp']
    inkDeltas?: { hex: string; from: number; to: number; srcPx: number }[]
    /** Σ|kept−1| over the scored regions, recipe minus P: negative = the render is nearer the source. */
    dInkDist?: number
    paletteP?: string[]
    paletteX?: string[]
    missingP?: string[]
    missingX?: string[]
  }[]
}
const rows: CaseRow[] = []

console.log(
  `━━━ floorDiag (issue #37) ━━━  lane ${LANE}, ${sources.length} case(s), res ${RESOLUTIONS.join('/')}` +
    `\n  Despeckle dial ${DIAL} ⇒ F_DIAL ${F_DIAL}px² (index.ts paletteOptionsFor, verbatim); F_rel(w) = round(${F_DIAL}·(w/${REF_RES})²)` +
    `\n  shadow: ${shadowDir}`,
)

let fidelityChecked = 0, fidelityFailed = 0
for (const res of RESOLUTIONS) {
  const R = relFloor(res)
  console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  @ ${res}px  —  F_DIAL ${F_DIAL}, F_rel ${R}  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  const aggAbs = zeroCounts(), aggRel = zeroCounts()
  let rendered = 0, derivedN = 0
  const recipeAgg = new Map<string, { n: number; identical: number; sameDoc: number; changed: number; byConstruction: number; dRegions: number; regionsUp: number; regionsDown: number; inkBetter: number; inkWorse: number; distNearer: number; distFarther: number; dInkDist: number; flips: number; dNodes: number; movers: string[] }>()
  for (const rc of recipesFor(res)) recipeAgg.set(rc.key, { n: 0, identical: 0, sameDoc: 0, changed: 0, byConstruction: 0, dRegions: 0, regionsUp: 0, regionsDown: 0, inkBetter: 0, inkWorse: 0, distNearer: 0, distFarther: 0, dInkDist: 0, flips: 0, dNodes: 0, movers: [] })

  for (const src of sources) {
    let svg: string, img: Img
    try {
      svg = readFileSync(src.svg, 'utf8')
      img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng()) as unknown as Img
    } catch (e) {
      console.log(`  ${src.name}: render failed (${(e as Error).message.split('\n')[0]}) — skipped`)
      continue
    }
    rendered++
    const t0 = Date.now()

    // 1. CENSUS
    const cen = census(img, svg)
    if (cen.derived) derivedN++
    const cAbs = countUnder(cen.colours, F_DIAL), cRel = countUnder(cen.colours, R)
    addCounts(aggAbs, cAbs)
    addCounts(aggRel, cRel)

    // 2. PRODUCTION through the shadow (no override), scored the lane's way.
    const P = (await traceWith(img, null, src.gradients)) as Traced
    const scoreP = scoreRegions(img, P.doc, { inkFamilies: src.inkFamilies })
    const hashP = hashDoc(P.doc)
    let fidelity: CaseRow['fidelity'] = 'skipped'
    const wantFidelity = FIDELITY === 'all' || (FIDELITY === 'sample' && (LANE !== 'gallery' || rendered <= 8))
    if (wantFidelity) {
      const real = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: src.gradients })
      fidelity = hashDoc(real) === hashP ? 'identical' : 'DIFFERS'
      fidelityChecked++
      if (fidelity === 'DIFFERS') fidelityFailed++
    }
    const row: CaseRow = {
      res, name: src.name, width: img.width, height: img.height, derived: cen.derived, censusAbs: cAbs, censusRel: cRel,
      P: { regions: scoreP.recovered, trueRegions: scoreP.trueRegions, worstInk: scoreP.worstInk, nodes: nodesOf(P.doc), items: itemsOf(P.doc), engine: P.engine, fp: P.fp, hash: hashP },
      fidelity, recipes: [],
    }

    // 3. RECIPES
    for (const rc of recipesFor(img.width)) {
      const ag = recipeAgg.get(rc.key)!
      ag.n++
      const allDial = (Object.values(rc.floors) as number[]).every((v) => v === F_DIAL)
      if (allDial && LANE === 'gallery') {
        // Every floor is the production number: identical by construction. The tier-2 lane
        // traces it regardless, as the control that proves the shadow's override is inert.
        row.recipes.push({ key: rc.key, outcome: 'by-construction' })
        ag.byConstruction++
        continue
      }
      const X = await traceWith(img, rc.floors, src.gradients, P)
      if (X === 'identical') {
        row.recipes.push({ key: rc.key, outcome: 'identical' })
        ag.identical++
        continue
      }
      const hashX = hashDoc(X.doc)
      if (hashX === hashP) {
        row.recipes.push({ key: rc.key, outcome: 'same-doc', engine: X.engine, fp: X.fp })
        ag.sameDoc++
        continue
      }
      const scoreX = scoreRegions(img, X.doc, { inkFamilies: src.inkFamilies })
      const inkP = new Map(inkOf(scoreP).map((i) => [i.hex, i]))
      const inkDeltas = inkOf(scoreX)
        .map((i) => ({ hex: i.hex, from: inkP.get(i.hex)?.kept ?? NaN, to: i.kept, srcPx: i.srcPx }))
        .filter((d) => !Number.isFinite(d.from) || Math.abs(d.to - d.from) >= 0.01)
        .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
      const inkDist = (r: RegionScore): number => r.ink.reduce((t, i) => t + Math.abs(i.kept - 1), 0)
      const hexP = (c: PaletteColor): string => '#' + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')
      const rec: CaseRow['recipes'][number] = {
        key: rc.key, outcome: 'changed',
        regions: scoreX.recovered, worstInk: scoreX.worstInk, nodes: nodesOf(X.doc), items: itemsOf(X.doc), engine: X.engine, fp: X.fp,
        inkDeltas,
        dInkDist: inkDist(scoreX) - inkDist(scoreP),
        paletteP: P.palette.map(hexP),
        paletteX: X.palette.map(hexP),
        missingP: scoreP.missing.map((m) => `${m.hex} (${m.areaPx}px → ${m.paintedHex}, ΔE ${m.deltaE.toFixed(1)})`),
        missingX: scoreX.missing.map((m) => `${m.hex} (${m.areaPx}px → ${m.paintedHex}, ΔE ${m.deltaE.toFixed(1)})`),
      }
      row.recipes.push(rec)
      ag.changed++
      ag.movers.push(src.name)
      const dR = scoreX.recovered - scoreP.recovered
      ag.dRegions += dR
      if (dR > 0) ag.regionsUp++
      if (dR < 0) ag.regionsDown++
      const dI = scoreX.worstInk - scoreP.worstInk
      if (dI >= 0.01) ag.inkBetter++
      if (dI <= -0.01) ag.inkWorse++
      if (X.engine !== P.engine) ag.flips++
      ag.dNodes += rec.nodes! - row.P.nodes
      ag.dInkDist += rec.dInkDist!
      if (rec.dInkDist! <= -0.01) ag.distNearer++
      if (rec.dInkDist! >= 0.01) ag.distFarther++
    }
    rows.push(row)

    // Per-case line. Census counts as under-abs/under-rel; recipes as their outcome.
    const cs = (c: FloorCounts): string =>
      `real ${c.underReal}/${c.colours} modal ${c.underModal}/${c.colours} comps ${c.underDespeckle}(${c.underDespeckleNoEvidence} no-ev)/${c.comps} whole ${c.wholeColourUnder}`
    const recipeStr = row.recipes
      .map((r) => {
        if (r.outcome !== 'changed') return `${r.key}=${r.outcome === 'identical' ? '=' : r.outcome === 'same-doc' ? '≈' : '·'}`
        return `${r.key}: Δregions ${sgn(r.regions! - row.P.regions)} (${r.regions}/${row.P.trueRegions}) ΔworstInk ${sgn((r.worstInk! - row.P.worstInk) * 100, 1)}pp Σ|ink−1| ${sgn(r.dInkDist! * 100, 1)}pp Δnodes ${sgn(r.nodes! - row.P.nodes)} Δitems ${sgn(r.items! - row.P.items)}${r.engine !== row.P.engine ? ` ⇐ ENGINE ${row.P.engine}→${r.engine}` : ''}`
      })
      .join('  ')
    console.log(
      `  ${src.name.padEnd(28)} ${img.width}×${img.height}${cen.derived ? ' (raster-derived colours)' : ''}  P ${scoreP.recovered}/${scoreP.trueRegions} regions, worstInk ${pp(scoreP.worstInk)}, ${row.P.nodes} nodes, ${row.P.items} items` +
        `${P.fp ? `, dominant ${P.fp.dominantColors} cov ${P.fp.flatCoverage.toFixed(2)}` : ''}${P.engine !== 'palette' ? ` ⇐ ENGINE ${P.engine}` : ''}` +
        `${fidelity !== 'skipped' ? `  fidelity ${fidelity}` : ''}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
    )
    console.log(`      census  @F_DIAL ${F_DIAL}: ${cs(cAbs)}   |   @F_rel ${R}: ${cs(cRel)}`)
    console.log(`      recipes ${recipeStr}`)
    const changed = row.recipes.filter((r) => r.outcome === 'changed')
    for (const r of changed) {
      if (r.inkDeltas!.length)
        console.log(`        ${r.key} ink: ${r.inkDeltas!.slice(0, 8).map((d) => `${d.hex} ${Number.isFinite(d.from) ? pp(d.from) : '—'}→${pp(d.to)} (${d.srcPx}px)`).join(', ')}${r.inkDeltas!.length > 8 ? ', …' : ''}`)
      if (r.missingP!.length || r.missingX!.length)
        console.log(`        ${r.key} missing: P [${r.missingP!.join('; ') || '—'}]  →  ${r.key} [${r.missingX!.join('; ') || '—'}]`)
      if (r.fp && row.P.fp && (r.fp.dominantColors !== row.P.fp.dominantColors || r.fp.paletteLen !== row.P.fp.paletteLen))
        console.log(`        ${r.key} palette: dominant ${row.P.fp.dominantColors}→${r.fp.dominantColors} (engine gate 14), entries ${row.P.fp.paletteLen}→${r.fp.paletteLen}`)
      const added = r.paletteX!.filter((h) => !r.paletteP!.includes(h)), gone = r.paletteP!.filter((h) => !r.paletteX!.includes(h))
      if (added.length || gone.length) console.log(`        ${r.key} palette entries: +[${added.join(' ')}] −[${gone.join(' ')}]`)
    }
    if (VERBOSE || (LANE !== 'gallery' && (cAbs.underReal + cAbs.underModal + cAbs.underDespeckle + cRel.underReal + cRel.underModal + cRel.underDespeckle) > 0)) {
      for (const c of cen.colours) {
        const under = c.comps.filter((k) => k.size < Math.max(F_DIAL, R))
        if (c.flat3 >= Math.max(F_DIAL, R) && c.exactPx >= Math.max(F_DIAL, R) && under.length === 0) continue
        console.log(
          `        ${c.hex}  exact ${String(c.exactPx).padStart(6)}  flat3 ${String(c.flat3).padStart(6)}  comps ${c.comps.length}` +
            `${under.length ? `  sub-floor comps: [${under.slice(0, 10).map((k) => `${k.size}${k.evidence ? '✓' : ''}`).join(', ')}${under.length > 10 ? ', …' : ''}]` : ''}` +
            `  → real/anchor ${c.flat3 < F_DIAL ? '✗' : '✓'}${F_DIAL !== R ? `/${c.flat3 < R ? '✗' : '✓'}` : ''}  modal ${c.exactPx < F_DIAL ? '✗' : '✓'}${F_DIAL !== R ? `/${c.exactPx < R ? '✗' : '✓'}` : ''}`,
        )
      }
    }
  }

  // Summary for this raster.
  console.log(`\n  ── CENSUS @ ${res}px — ${rendered} case(s)${derivedN ? `, ${derivedN} with raster-derived colour sets` : ''} ──`)
  console.log(`  ${'floor'.padEnd(18)}${'colours'.padStart(9)}${'<real/anchor'.padStart(14)}${'<modal'.padStart(9)}${'comps'.padStart(9)}${'<despeckle'.padStart(12)}${'(no evidence)'.padStart(15)}${'(no-ev ≥9px)'.padStart(14)}${'whole colour'.padStart(14)}`)
  for (const [lbl, c] of [[`F_DIAL ${F_DIAL}`, aggAbs], [`F_rel ${R}`, aggRel]] as [string, FloorCounts][])
    console.log(`  ${lbl.padEnd(18)}${String(c.colours).padStart(9)}${String(c.underReal).padStart(14)}${String(c.underModal).padStart(9)}${String(c.comps).padStart(9)}${String(c.underDespeckle).padStart(12)}${String(c.underDespeckleNoEvidence).padStart(15)}${String(c.underDespeckleNoEvidenceGe9).padStart(14)}${String(c.wholeColourUnder).padStart(14)}`)
  console.log(`\n  ── COUNTERFACTUAL @ ${res}px — recipes vs production P ──`)
  console.log(`  ${'recipe'.padEnd(34)}${'changed'.padStart(9)}${'identical'.padStart(11)}${'same-doc'.padStart(10)}${'Σ Δregions'.padStart(12)}${'cases ↑/↓'.padStart(11)}${'worstInk ↑/↓'.padStart(14)}${'Σ|ink−1| nearer/farther'.padStart(25)}${'ΣΔ'.padStart(9)}${'engine flips'.padStart(14)}${'Σ Δnodes'.padStart(10)}`)
  for (const rc of recipesFor(res)) {
    const a = recipeAgg.get(rc.key)!
    console.log(
      `  ${rc.label.padEnd(34)}${`${a.changed}/${a.n}`.padStart(9)}${String(a.identical).padStart(11)}${String(a.sameDoc).padStart(10)}` +
        `${sgn(a.dRegions).padStart(12)}${`${a.regionsUp}/${a.regionsDown}`.padStart(11)}${`${a.inkBetter}/${a.inkWorse}`.padStart(14)}${`${a.distNearer}/${a.distFarther}`.padStart(25)}${(sgn(a.dInkDist * 100, 1) + 'pp').padStart(9)}${String(a.flips).padStart(14)}${sgn(a.dNodes).padStart(10)}` +
        `${a.byConstruction ? `   (${a.byConstruction} identical by construction)` : ''}`,
    )
    if (a.movers.length) console.log(`      movers: ${a.movers.join(', ')}`)
  }
}

if (fidelityChecked) console.log(`\n  fidelity: shadow (no override) vs real traceImage — ${fidelityChecked - fidelityFailed}/${fidelityChecked} byte-identical${fidelityFailed ? '  ⇐ SHADOW DESYNC, do not trust the recipes' : ''}`)
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(rows, null, 1))
  console.log(`  rows → ${JSON_OUT}`)
}
