// UPSCALER IN FRONT OF THE TRACER — issue #42, Phase 0. Does anything beat bilinear 3×?
//
//   node --experimental-strip-types src/devtest/upscaleDiag.ts fixtures            # answer-sheet lane
//   node --experimental-strip-types src/devtest/upscaleDiag.ts sheets              # real tiles, 2048 crop = truth
//   … --res 128,256            fixture raster sizes (long side)          default 128,256
//   … --sheet-res 1024,768     the small sheet's long side               default 1024,768
//   … --cases a,b / --sheets weather,travel / --tiles 1,11   (sheet lane: only these tile numbers)
//   … --up none,bilinear3,lanczos3,swin2sr-lw-x2,waifu2x-cunet-x2,…      default: the shipped control + every model
//   … --list                   print the upscaler roster and exit
//   … --json out.json          machine-readable rows
//   … --contact dir            sheet lane: write one contact-sheet PNG per sheet × res
//   … --dump dir               fixture lane: write <case>-<res>-<up>-{in,out}.png (the upscaled raster, the trace rendered on it)
//   … --models-dir dir         where the raw ONNX files live (see MODELS below)
//   … --hf-cache dir           transformers.js download cache (default .cache/hf under the repo)
//   … --sheets-dir dir         the example sheets decoded to PNG (default .cache/sheets)
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// §30 showed the tracer places every edge to a constant accuracy in NATIVE px, so in
// artwork units its error falls 1:1 with the raster — the only lever left for small
// rasters is more pixels in front of the tracer. The sheet path already does bilinear 3×
// (measured: 4× buys nothing over 3× — bilinear adds no information). An AI upscaler is the
// one thing that COULD add information past that, and it is also the one thing that could
// invent edges the tracer then traces faithfully. §15.5 rejected it on that argument and
// never on a number. This is the number.
//
// Two lanes, two kinds of truth:
//   fixtures — the flat tier-0 authored SVGs rasterized SMALL (128 / 256), each upscaler's
//              output traced, the trace affine-scaled into the 512 reference space and scored
//              against the AUTHORED geometry with the truth-gate lenses. `cornersInvented`
//              and the region count are the hallucination counters: an invented edge is an
//              invented corner or an invented region, so "does it hallucinate" is a count.
//   sheets   — the four example sheets (2048, model output, real icon art). The 2048 crop is
//              the truth; the same sheet Lanczos-downscaled to 1024 / 768 is the input (the
//              tile sizes /sheet looks bad at — 125–250px). Each tile goes through the
//              PRODUCTION plan (planTileBase: mono/colour, threshold, invert, size-scaled
//              smoothing) with the upscaler swapped in, the result is rendered in the truth
//              crop's space and scored against the truth's INK MASK: area drift, IoU,
//              boundary distance both ways (missed / spurious), SSIM, nodes, time.
//
// Every AI row has a plain control at the SAME factor (bilinear2 for the ×2 models,
// bilinear4 for the ×4 ones) plus the shipped bilinear3; Lanczos is there because the
// issue asked. Rows are per case — a mean over cases would hide exactly the one tile a
// model hallucinates on.
//
// MODELS (all run in-browser too — onnxruntime-web is what transformers.js ships):
//   swin2sr-lw-x2     Xenova/swin2SR-lightweight-x2-64 (transformers.js, 8 MB fp32, DIV2K photos)
//   swin2sr-cl-x2/x4  Xenova/swin2SR-classical-sr-x{2,4}-64 (55 MB) — opt-in, photo-trained
//   swin2sr-rw-x4     Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr (53 MB) — opt-in, degradation-trained
//   waifu2x-cunet-x2  nunif waifu2x cunet/art scale2x (5 MB, MIT) — line art / anime
//   waifu2x-swin-x2   nunif waifu2x swin_unet/art scale2x (17 MB, MIT)
//   waifu2x-swin-x4   nunif waifu2x swin_unet/art scale4x (19 MB, MIT)
//   realesrgan-anime-x4  RealESRGAN_x4plus_anime_6B ONNX (18 MB, BSD-3) — anime / flat art
// The raw ONNX files are NOT in the repo (they are someone else's weights); download them
// into --models-dir under the file names in RAW_MODELS. The transformers.js ones fetch
// themselves into --hf-cache.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { ensureImageData } from './nodeHarness.ts'
import { decodePng } from './png.ts'
import { encodePng } from './pngEncode.ts'
import { traceImage, suggestGradients, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry, scoreRegions } from './geomScore.ts'
import { scaleDoc } from './scaleScore.ts'
import { GATED_CORPUS } from './truthCorpus.ts'
import { rasterizeDoc } from '../lib/render/raster.ts'
import { fidelity } from './metrics.ts'
import { detectSheetIcons, cropTile, upscaleImageData, isInkPixel, estimateBackground } from '../lib/sheet/index.ts'
import { planTileBase, tileSmoothing } from '../lib/sheet/plan.ts'
import type { ImageDataLike, SheetBackground } from '../lib/sheet/types.ts'
import type { EditableDoc } from '../lib/path/types.ts'
import type { VectorizeOptions } from '../types.ts'

ensureImageData()
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const lane = argv.find((a) => !a.startsWith('--')) ?? 'fixtures'
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string): boolean => argv.includes(`--${name}`)
const list = (name: string, dflt: string): string[] =>
  (flag(name) ?? dflt)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const MODELS_DIR = flag('models-dir') ?? join(ROOT, '.cache', 'sr-models')
const HF_CACHE = flag('hf-cache') ?? join(ROOT, '.cache', 'hf')

// ---------------------------------------------------------------------------
// Upscalers
// ---------------------------------------------------------------------------

interface Upscaler {
  name: string
  factor: number
  kind: 'plain' | 'ai'
  load(): Promise<void>
  run(img: ImageDataLike): Promise<ImageDataLike>
}

const identity: Upscaler = { name: 'none', factor: 1, kind: 'plain', load: async () => {}, run: async (img) => img }

const bilinear = (k: number): Upscaler => ({
  name: `bilinear${k}`,
  factor: k,
  kind: 'plain',
  load: async () => {},
  run: async (img) => upscaleImageData(img, k),
})

/** Lanczos-3, separable, integer factor, same sample placement as `upscaleImageData`. */
function lanczosUpscale(img: ImageDataLike, k: number): ImageDataLike {
  const A = 3
  const kernel = (x: number): number => {
    if (x === 0) return 1
    if (Math.abs(x) >= A) return 0
    const px = Math.PI * x
    return (A * Math.sin(px) * Math.sin(px / A)) / (px * px)
  }
  const pass = (
    src: Float32Array,
    sw: number,
    sh: number,
    horizontal: boolean,
  ): { out: Float32Array; w: number; h: number } => {
    const w = horizontal ? sw * k : sw
    const h = horizontal ? sh : sh * k
    const out = new Float32Array(w * h * 4)
    const n = horizontal ? sw : sh
    // The taps repeat with period k — build them once per output index anyway (cheap).
    const taps: { i: number; wgt: number }[][] = []
    for (let o = 0; o < (horizontal ? w : h); o++) {
      const s = (o + 0.5) / k - 0.5
      const i0 = Math.floor(s) - A + 1
      const t: { i: number; wgt: number }[] = []
      let sum = 0
      for (let i = i0; i < i0 + 2 * A; i++) {
        const wgt = kernel(s - i)
        if (wgt === 0) continue
        const ci = Math.min(n - 1, Math.max(0, i))
        t.push({ i: ci, wgt })
        sum += wgt
      }
      for (const e of t) e.wgt /= sum
      taps.push(t)
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = taps[horizontal ? x : y]
        const o = (y * w + x) * 4
        for (let c = 0; c < 4; c++) {
          let v = 0
          for (const e of t) v += src[(horizontal ? y * sw + e.i : e.i * sw + x) * 4 + c] * e.wgt
          out[o + c] = v
        }
      }
    }
    return { out, w, h }
  }
  const f = Float32Array.from(img.data)
  const h1 = pass(f, img.width, img.height, true)
  const v1 = pass(h1.out, h1.w, h1.h, false)
  const data = new Uint8ClampedArray(v1.w * v1.h * 4)
  for (let i = 0; i < data.length; i++) data[i] = Math.round(v1.out[i])
  return { width: v1.w, height: v1.h, data }
}

const lanczos = (k: number): Upscaler => ({
  name: `lanczos${k}`,
  factor: k,
  kind: 'plain',
  load: async () => {},
  run: async (img) => lanczosUpscale(img, k),
})

/** RGBA over white → float planes NCHW in [0,1] (what every SR model here eats). */
function toPlanes(img: ImageDataLike): Float32Array {
  const { width: W, height: H, data } = img
  const x = new Float32Array(3 * W * H)
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++) x[c * W * H + i] = (data[i * 4 + c] * a + 255 * (1 - a)) / 255
  }
  return x
}

function fromPlanes(x: Float32Array, W: number, H: number): ImageDataLike {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(Math.min(1, Math.max(0, x[c * W * H + i])) * 255)
    data[i * 4 + 3] = 255
  }
  return { width: W, height: H, data }
}

/** Symmetric (reflect) padding of float planes. */
function padPlanes(x: Float32Array, W: number, H: number, l: number, t: number, r: number, b: number): Float32Array {
  const PW = W + l + r
  const PH = H + t + b
  const out = new Float32Array(3 * PW * PH)
  const refl = (i: number, n: number): number => {
    let j = i
    while (j < 0 || j >= n) j = j < 0 ? -j - 1 : 2 * n - j - 1
    return j
  }
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < PH; y++) {
      const sy = refl(y - t, H)
      for (let xx = 0; xx < PW; xx++) out[c * PW * PH + y * PW + xx] = x[c * W * H + sy * W + refl(xx - l, W)]
    }
  return out
}

function cropPlanes(x: Float32Array, W: number, H: number, l: number, t: number, w: number, h: number): Float32Array {
  const out = new Float32Array(3 * w * h)
  for (let c = 0; c < 3; c++)
    for (let y = 0; y < h; y++)
      for (let xx = 0; xx < w; xx++) out[c * w * h + y * w + xx] = x[c * W * H + (y + t) * W + xx + l]
  return out
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

/** onnxruntime-node ships with @huggingface/transformers; pnpm hides it under .pnpm. */
async function loadOrt(): Promise<Any> {
  const direct = join(ROOT, 'node_modules', 'onnxruntime-node', 'dist', 'index.js')
  if (existsSync(direct)) return import(pathToFileURL(direct).href)
  const pnpm = join(ROOT, 'node_modules', '.pnpm')
  const dir = readdirSync(pnpm).find((d) => d.startsWith('onnxruntime-node@'))
  if (!dir) throw new Error('onnxruntime-node is not installed')
  return import(pathToFileURL(join(pnpm, dir, 'node_modules', 'onnxruntime-node', 'dist', 'index.js')).href)
}

interface RawModel {
  file: string
  factor: number
  /** Border the model eats (input px per side) — its output is factor·(W − 2·border). */
  border: number
  /** Input must be a multiple of this (after padding). */
  multiple: number
}

const RAW_MODELS: Record<string, RawModel> = {
  'waifu2x-cunet-x2': { file: 'waifu2x_cunet_art_2x.onnx', factor: 2, border: 18, multiple: 2 },
  'waifu2x-swin-x2': { file: 'waifu2x_swin_unet_art_2x.onnx', factor: 2, border: 8, multiple: 64 },
  'waifu2x-swin-x4': { file: 'waifu2x_swin_unet_art_4x.onnx', factor: 4, border: 8, multiple: 64 },
  'realesrgan-anime-x4': { file: 'realesrgan_anime6b.onnx', factor: 4, border: 0, multiple: 1 },
}

const rawOnnx = (name: string): Upscaler => {
  const m = RAW_MODELS[name]
  let ort: Any
  let sess: Any
  return {
    name,
    factor: m.factor,
    kind: 'ai',
    async load() {
      ort = await loadOrt()
      const path = join(MODELS_DIR, m.file)
      if (!existsSync(path)) throw new Error(`${name}: ${path} missing — see the MODELS note at the top of upscaleDiag.ts`)
      sess = await ort.InferenceSession.create(path, { executionProviders: ['cpu'], logSeverityLevel: 3 })
    },
    async run(img) {
      const { width: W, height: H } = img
      const b = m.border
      // Pad the border the model eats, then up to the multiple it demands (right/bottom).
      let PW = W + 2 * b
      let PH = H + 2 * b
      const extraW = (m.multiple - (PW % m.multiple)) % m.multiple
      const extraH = (m.multiple - (PH % m.multiple)) % m.multiple
      PW += extraW
      PH += extraH
      const x = padPlanes(toPlanes(img), W, H, b, b, b + extraW, b + extraH)
      const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, PH, PW]) })
      const y = out[sess.outputNames[0]]
      const OW = y.dims[3] as number
      const OH = y.dims[2] as number
      // The model already dropped its border: output covers (PW − 2b) × (PH − 2b) at ×factor.
      const k = m.factor
      const expectW = (PW - 2 * b) * k
      if (OW !== expectW) throw new Error(`${name}: output ${OW} for padded ${PW}, expected ${expectW}`)
      const planes = cropPlanes(y.data as Float32Array, OW, OH, 0, 0, W * k, H * k)
      return fromPlanes(planes, W * k, H * k)
    },
  }
}

const HF_MODELS: Record<string, { id: string; factor: number }> = {
  'swin2sr-lw-x2': { id: 'Xenova/swin2SR-lightweight-x2-64', factor: 2 },
  'swin2sr-cl-x2': { id: 'Xenova/swin2SR-classical-sr-x2-64', factor: 2 },
  'swin2sr-cl-x4': { id: 'Xenova/swin2SR-classical-sr-x4-64', factor: 4 },
  'swin2sr-rw-x4': { id: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr', factor: 4 },
}

const hfPipeline = (name: string): Upscaler => {
  const m = HF_MODELS[name]
  let pipe: Any
  let RawImage: Any
  return {
    name,
    factor: m.factor,
    kind: 'ai',
    async load() {
      const tf: Any = await import('@huggingface/transformers')
      tf.env.cacheDir = HF_CACHE
      tf.env.allowLocalModels = false
      RawImage = tf.RawImage
      pipe = await tf.pipeline('image-to-image', m.id, { dtype: 'fp32' })
    },
    async run(img) {
      const { width: W, height: H } = img
      const planes = toPlanes(img)
      const rgb = new Uint8Array(W * H * 3)
      for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.round(planes[c * W * H + i] * 255)
      const out = await pipe(new RawImage(rgb, W, H, 3))
      // The processor pads to the window size; the output is larger than k·W then. Crop.
      const k = m.factor
      const OW = out.width as number
      const od = out.data as Uint8Array
      const oc = out.channels as number
      const data = new Uint8ClampedArray(W * k * H * k * 4)
      for (let y = 0; y < H * k; y++)
        for (let x = 0; x < W * k; x++) {
          const s = (y * OW + x) * oc
          const o = (y * W * k + x) * 4
          data[o] = od[s]
          data[o + 1] = od[s + 1]
          data[o + 2] = od[s + 2]
          data[o + 3] = 255
        }
      return { width: W * k, height: H * k, data }
    },
  }
}

const ROSTER: Record<string, () => Upscaler> = {
  none: () => identity,
  bilinear2: () => bilinear(2),
  bilinear3: () => bilinear(3),
  bilinear4: () => bilinear(4),
  lanczos2: () => lanczos(2),
  lanczos3: () => lanczos(3),
  lanczos4: () => lanczos(4),
  ...Object.fromEntries(Object.keys(HF_MODELS).map((n) => [n, () => hfPipeline(n)])),
  ...Object.fromEntries(Object.keys(RAW_MODELS).map((n) => [n, () => rawOnnx(n)])),
}

const DEFAULT_UP =
  'none,bilinear2,bilinear3,bilinear4,lanczos3,swin2sr-lw-x2,waifu2x-cunet-x2,waifu2x-swin-x2,waifu2x-swin-x4,realesrgan-anime-x4'

if (has('list')) {
  for (const n of Object.keys(ROSTER)) console.log(n)
  process.exit(0)
}

async function loadUpscalers(): Promise<Upscaler[]> {
  const ups: Upscaler[] = []
  for (const n of list('up', DEFAULT_UP)) {
    const mk = ROSTER[n]
    if (!mk) throw new Error(`unknown upscaler ${n} (--list)`)
    const u = mk()
    const t0 = performance.now()
    await u.load()
    const took = Math.round(performance.now() - t0)
    if (u.kind === 'ai') console.error(`  loaded ${n} in ${took} ms`)
    ups.push(u)
  }
  return ups
}

const ms = (t0: number): number => Math.round((performance.now() - t0) * 10) / 10
const nodesOf = (doc: EditableDoc): number => {
  let n = 0
  for (const it of doc.items) if (it.kind === 'path') for (const sp of it.subPaths) n += sp.nodes.length
  return n
}
const pathsOf = (doc: EditableDoc): number => doc.items.filter((it) => it.kind === 'path' && it.visible !== false).length
const f2 = (v: number): string => (Number.isFinite(v) ? v.toFixed(2) : '—')
const pad = (s: string | number, n: number): string => String(s).padStart(n)
const padr = (s: string | number, n: number): string => String(s).padEnd(n)

// ---------------------------------------------------------------------------
// Lane 1 — fixtures (authored answer sheet)
// ---------------------------------------------------------------------------

const REF = 512

interface FixtureRow {
  lane: 'fixtures'
  case: string
  res: number
  up: string
  factor: number
  inputPx: number
  chamfer: number
  p95: number
  parsimony: number
  gtCorners: number
  cornersRecovered: number
  cornersInvented: number
  trueRegions: number
  recovered: number
  docNodes: number
  docPaths: number
  upMs: number
  traceMs: number
}

async function runFixtures(ups: Upscaler[]): Promise<FixtureRow[]> {
  const RES = list('res', '128,256').map(Number)
  const only = flag('cases')?.split(',')
  const dumpDir = flag('dump')
  const cases = GATED_CORPUS.filter((c) => c.tier === 0 && !c.gradients && (!only || only.includes(c.name)))
  const rows: FixtureRow[] = []
  for (const c of cases) {
    const svg = readFileSync(join(ROOT, c.svg), 'utf8')
    const gt = parseGroundTruth(svg)
    const why = unscorable(gt)
    if (why) {
      console.log(`${c.name}: not scorable — ${why}`)
      continue
    }
    const refImg = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: REF }, background: 'white' }).render().asPng())
    const gtRef = toRasterSpace(gt, refImg.width)
    console.log(`\n## ${c.name}`)
    console.log(
      `${padr('res', 4)} ${padr('upscaler', 20)} ${pad('in', 5)} ${pad('chamfer', 8)} ${pad('p95', 7)} ${pad('pars', 6)} ${pad('corners', 8)} ${pad('invent', 7)} ${pad('regions', 8)} ${pad('nodes', 6)} ${pad('paths', 6)} ${pad('up ms', 7)} ${pad('trace', 7)}`,
    )
    for (const res of RES) {
      const img = decodePng(new Resvg(svg, { fitTo: { mode: 'width', value: res }, background: 'white' }).render().asPng())
      for (const up of ups) {
        const t0 = performance.now()
        const input = await up.run(img)
        const upMs = ms(t0)
        const t1 = performance.now()
        const doc = await traceImage(input as unknown as ImageData, {
          ...DEFAULT_VECTORIZE_OPTIONS,
          engine: 'planar',
          gradients: false,
        })
        const traceMs = ms(t1)
        const docRef = scaleDoc(doc, refImg.width / input.width)
        const g = scoreGeometry(gtRef, docRef, refImg.width, refImg.height, refImg)
        const r = scoreRegions(refImg, docRef, { inkFamilies: c.inkFamilies })
        const row: FixtureRow = {
          lane: 'fixtures',
          case: c.name,
          res,
          up: up.name,
          factor: up.factor,
          inputPx: input.width,
          chamfer: g.chamfer,
          p95: g.p95,
          parsimony: g.parsimony,
          gtCorners: g.gtCorners,
          cornersRecovered: g.cornersRecovered,
          cornersInvented: g.cornersInvented,
          trueRegions: r.trueRegions,
          recovered: r.recovered,
          docNodes: nodesOf(doc),
          docPaths: pathsOf(doc),
          upMs,
          traceMs,
        }
        rows.push(row)
        if (dumpDir) {
          mkdirSync(dumpDir, { recursive: true })
          writeFileSync(join(dumpDir, `${c.name}-${res}-${up.name}-in.png`), encodePng(input.data, input.width, input.height))
          const render = rasterizeDoc(doc, input.width, input.height)
          writeFileSync(join(dumpDir, `${c.name}-${res}-${up.name}-out.png`), encodePng(render, input.width, input.height))
        }
        console.log(
          `${padr(res, 4)} ${padr(up.name, 20)} ${pad(input.width, 5)} ${pad(f2(g.chamfer), 8)} ${pad(f2(g.p95), 7)} ${pad(f2(g.parsimony), 6)} ${pad(`${g.cornersRecovered}/${g.gtCorners}`, 8)} ${pad(g.cornersInvented, 7)} ${pad(`${r.recovered}/${r.trueRegions}`, 8)} ${pad(row.docNodes, 6)} ${pad(row.docPaths, 6)} ${pad(upMs, 7)} ${pad(traceMs, 7)}`,
        )
      }
    }
  }
  return rows
}

// ---------------------------------------------------------------------------
// Lane 2 — real sheet tiles (the 2048 crop is the truth)
// ---------------------------------------------------------------------------

/** Exact Euclidean distance transform (Felzenszwalb–Huttenlocher) to the nearest set px. */
function edt(mask: Uint8Array, W: number, H: number): Float32Array {
  const INF = 1e12
  const f = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) f[i] = mask[i] ? 0 : INF
  const dt1 = (src: Float32Array, n: number, stride: number, base: number, out: Float32Array): void => {
    const v = new Int32Array(n)
    const z = new Float64Array(n + 1)
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    const fq = (q: number): number => src[base + q * stride]
    for (let q = 1; q < n; q++) {
      let s = (fq(q) + q * q - (fq(v[k]) + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (fq(q) + q * q - (fq(v[k]) + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++
      out[base + q * stride] = (q - v[k]) * (q - v[k]) + fq(v[k])
    }
  }
  const tmp = new Float32Array(W * H)
  for (let y = 0; y < H; y++) dt1(f, W, 1, y * W, tmp)
  const out = new Float32Array(W * H)
  for (let x = 0; x < W; x++) dt1(tmp, H, W, x, out)
  for (let i = 0; i < W * H; i++) out[i] = Math.sqrt(out[i])
  return out
}

function boundaryOf(mask: Uint8Array, W: number, H: number): Uint8Array {
  const b = new Uint8Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!mask[i]) continue
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - W] || !mask[i + W])
        b[i] = 1
    }
  return b
}

function inkMask(img: ImageDataLike, bg: SheetBackground, threshold: number): Uint8Array {
  const m = new Uint8Array(img.width * img.height)
  for (let i = 0; i < m.length; i++) if (isInkPixel(img.data, i * 4, bg, threshold)) m[i] = 1
  return m
}

const percentile = (xs: number[], p: number): number => {
  if (!xs.length) return NaN
  const s = xs.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)

interface SheetRow {
  lane: 'sheets'
  sheet: string
  sheetRes: number
  tile: number
  tilePx: number
  mode: 'mono' | 'color'
  up: string
  factor: number
  /** Traced-ink area minus truth-ink area, in pp of the tile. */
  areaDrift: number
  iou: number
  /** Boundary distances in the SMALL tile's native px: truth→trace (missed) and trace→truth (spurious). */
  missedMean: number
  missedP95: number
  spuriousMean: number
  spuriousP95: number
  /** Share of traced boundary px more than 1.5 native px from any truth boundary. */
  spuriousShare: number
  ssim: number
  deltaE: number
  docNodes: number
  docPaths: number
  upMs: number
  traceMs: number
}

/** Trace one tile through the production plan with `up` in front. */
async function traceSmallTile(
  small: ImageDataLike,
  bg: SheetBackground,
  up: Upscaler,
): Promise<{ doc: EditableDoc; input: ImageDataLike; plan: ReturnType<typeof planTileBase>; upMs: number; traceMs: number }> {
  const base: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, removeBackground: true }
  const plan = planTileBase(small, base, { colorMode: 'auto', background: bg, hiRes: false })
  const long = Math.max(small.width, small.height)
  let opts: VectorizeOptions = { ...plan.opts, smoothing: tileSmoothing(base.smoothing, long * up.factor) }
  if (plan.color) {
    try {
      opts = { ...opts, gradients: suggestGradients(new ImageData(new Uint8ClampedArray(small.data), small.width, small.height)) }
    } catch {
      /* keep the default */
    }
  }
  const t0 = performance.now()
  const input = await up.run(small)
  const upMs = ms(t0)
  const t1 = performance.now()
  const doc = await traceImage(input as unknown as ImageData, opts)
  const traceMs = ms(t1)
  return { doc, input, plan, upMs, traceMs }
}

function repaint(doc: EditableDoc, fill: string | null): EditableDoc {
  if (!fill) return doc
  return { ...doc, items: doc.items.map((it) => (it.kind === 'path' ? { ...it, fill } : it)) }
}

/** Nearest-neighbour blit of `img` scaled to fit a `cell` square, onto an opaque RGBA canvas. */
function blit(canvas: Uint8ClampedArray, CW: number, img: ImageDataLike, cx: number, cy: number, cell: number): void {
  const s = cell / Math.max(img.width, img.height)
  const w = Math.round(img.width * s)
  const h = Math.round(img.height * s)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.floor(x / s))
      const sy = Math.min(img.height - 1, Math.floor(y / s))
      const si = (sy * img.width + sx) * 4
      const di = ((cy + y) * CW + cx + x) * 4
      const a = img.data[si + 3] / 255
      for (let c = 0; c < 3; c++) canvas[di + c] = Math.round(img.data[si + c] * a + 255 * (1 - a))
      canvas[di + 3] = 255
    }
}

async function runSheets(ups: Upscaler[]): Promise<SheetRow[]> {
  const SHEET_RES = list('sheet-res', '1024,768').map(Number)
  const sheetsDir = flag('sheets-dir') ?? join(ROOT, '.cache', 'sheets')
  const names = list('sheets', 'weather,travel,smart-home,productivity')
  const contactDir = flag('contact')
  const onlyTiles = flag('tiles')?.split(',').map(Number)
  const THRESH = 24
  const rows: SheetRow[] = []
  const loadSheet = (name: string, res: number): ImageDataLike | null => {
    const p = join(sheetsDir, `${name}-${res}.png`)
    if (!existsSync(p)) return null
    const bytes = readFileSync(p)
    return decodePng(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }
  for (const name of names) {
    const truthSheet = loadSheet(name, 2048)
    if (!truthSheet) {
      console.log(
        `${name}: no ${name}-2048.png in ${sheetsDir} — decode public/examples/sheets/${name}.webp to PNG there (PIL), plus Lanczos downscales named ${name}-1024.png / ${name}-768.png`,
      )
      continue
    }
    const det = detectSheetIcons(truthSheet)
    const icons = det.tiles
      .filter((t) => t.kind === 'icon')
      .map((t, i) => ({ ...t, no: i + 1 }))
      .filter((t) => !onlyTiles || onlyTiles.includes(t.no))
    for (const sheetRes of SHEET_RES) {
      const smallSheet = loadSheet(name, sheetRes)
      if (!smallSheet) {
        console.log(`${name}: no ${name}-${sheetRes}.png`)
        continue
      }
      const s = smallSheet.width / truthSheet.width
      const bgSmall = estimateBackground(smallSheet, THRESH)
      const paper: [number, number, number] = [det.background.r, det.background.g, det.background.b]
      const fill = { r: det.background.r, g: det.background.g, b: det.background.b, a: 255 }
      console.log(
        `\n## ${name} @${sheetRes} (${icons.length} icons, tiles ${Math.round((icons[0]?.box.w ?? 0) * s)}px, truth ${Math.round(icons[0]?.box.w ?? 0)}px)`,
      )
      console.log(
        `${padr('tile', 4)} ${padr('mode', 5)} ${padr('upscaler', 20)} ${pad('drift', 6)} ${pad('iou', 6)} ${pad('missed', 7)} ${pad('p95', 6)} ${pad('spur', 6)} ${pad('p95', 6)} ${pad('spur%', 6)} ${pad('ssim', 6)} ${pad('ΔE', 6)} ${pad('nodes', 6)} ${pad('paths', 6)} ${pad('up ms', 7)} ${pad('trace', 7)}`,
      )
      // Contact sheet: truth | small (nearest) | per upscaler: input, render.
      const CELL = Number(flag('cell') ?? 160)
      const cols = 2 + ups.length * 2
      const CW = cols * CELL
      const CH = icons.length * CELL
      const canvas = contactDir ? new Uint8ClampedArray(CW * CH * 4).fill(255) : null

      for (let ti = 0; ti < icons.length; ti++) {
        const tile = icons[ti]
        const truth = cropTile(truthSheet, tile.box, fill)
        const smallBox = { x: tile.box.x * s, y: tile.box.y * s, w: tile.box.w * s, h: tile.box.h * s }
        const small = cropTile(smallSheet, smallBox, fill)
        const truthMask = inkMask(truth, det.background, THRESH)
        let truthArea = 0
        for (let i = 0; i < truthMask.length; i++) truthArea += truthMask[i]
        const truthB = boundaryOf(truthMask, truth.width, truth.height)
        const dTruth = edt(truthB, truth.width, truth.height)
        if (canvas) {
          blit(canvas, CW, truth, 0, ti * CELL, CELL)
          blit(canvas, CW, small, CELL, ti * CELL, CELL)
        }
        for (let ui = 0; ui < ups.length; ui++) {
          const up = ups[ui]
          const { doc, input, plan, upMs, traceMs } = await traceSmallTile(small, bgSmall, up)
          // Into the truth crop's space, rendered over the paper in the ink's colour.
          const docT = scaleDoc(repaint(doc, plan.recolor), truth.width / input.width)
          const render = rasterizeDoc(docT, truth.width, truth.height, { background: paper })
          const renderImg: ImageDataLike = { width: truth.width, height: truth.height, data: render }
          const mask = inkMask(renderImg, det.background, THRESH)
          let inter = 0
          let union = 0
          let area = 0
          for (let i = 0; i < mask.length; i++) {
            area += mask[i]
            inter += mask[i] & truthMask[i]
            union += mask[i] | truthMask[i]
          }
          const traceB = boundaryOf(mask, truth.width, truth.height)
          const dTrace = edt(traceB, truth.width, truth.height)
          const missed: number[] = []
          const spurious: number[] = []
          for (let i = 0; i < mask.length; i++) {
            if (truthB[i]) missed.push(dTrace[i] * s)
            if (traceB[i]) spurious.push(dTruth[i] * s)
          }
          const fid = fidelity(truth.data, render, truth.width, truth.height)
          const row: SheetRow = {
            lane: 'sheets',
            sheet: name,
            sheetRes,
            tile: tile.no,
            tilePx: Math.max(small.width, small.height),
            mode: plan.color ? 'color' : 'mono',
            up: up.name,
            factor: up.factor,
            areaDrift: ((area - truthArea) / mask.length) * 100,
            iou: union ? inter / union : NaN,
            missedMean: mean(missed),
            missedP95: percentile(missed, 0.95),
            spuriousMean: mean(spurious),
            spuriousP95: percentile(spurious, 0.95),
            spuriousShare: spurious.length ? spurious.filter((d) => d > 1.5).length / spurious.length : NaN,
            ssim: fid.ssim,
            deltaE: fid.meanDeltaE,
            docNodes: nodesOf(doc),
            docPaths: pathsOf(doc),
            upMs,
            traceMs,
          }
          rows.push(row)
          console.log(
            `${padr(tile.no, 4)} ${padr(row.mode, 5)} ${padr(up.name, 20)} ${pad(f2(row.areaDrift), 6)} ${pad(f2(row.iou), 6)} ${pad(f2(row.missedMean), 7)} ${pad(f2(row.missedP95), 6)} ${pad(f2(row.spuriousMean), 6)} ${pad(f2(row.spuriousP95), 6)} ${pad(f2(row.spuriousShare * 100), 6)} ${pad(f2(row.ssim), 6)} ${pad(f2(row.deltaE), 6)} ${pad(row.docNodes, 6)} ${pad(row.docPaths, 6)} ${pad(upMs, 7)} ${pad(traceMs, 7)}`,
          )
          if (canvas) {
            blit(canvas, CW, input, (2 + ui * 2) * CELL, ti * CELL, CELL)
            blit(canvas, CW, renderImg, (3 + ui * 2) * CELL, ti * CELL, CELL)
          }
        }
      }
      if (canvas && contactDir) {
        mkdirSync(contactDir, { recursive: true })
        const out = join(contactDir, `${name}-${sheetRes}.png`)
        writeFileSync(out, encodePng(canvas, CW, CH))
        console.log(
          `contact sheet → ${out}  (columns: truth, small, then per upscaler: input | render — ${ups.map((u) => u.name).join(', ')})`,
        )
      }
    }
  }
  return rows
}

// ---------------------------------------------------------------------------

const ups = await loadUpscalers()
const rows = lane === 'sheets' ? await runSheets(ups) : await runFixtures(ups)
const jsonOut = flag('json')
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify(rows, null, 1))
  console.log(`\n${rows.length} rows → ${jsonOut}`)
}
