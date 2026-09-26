// HAIRLINE CUT — Phase 0. Where should the mono cut sit on art whose strokes are
// thinner than a pixel, and can the raster tell us?
//
//   node bench/hairlineCutDiag.ts --svg a.svg,b.svg [--res 400,499,600,800] [--cuts 128,136,…]
//   … --gallery N            also the first N gallery marks @256/@512 as the control (ridge stats only)
//   … --out dir              where the synthetic hairline SVGs are written (default scratch)
//
// For each SVG × raster size: rasterize on transparency at S (what a user's PNG is),
// enlarge by the production Auto factor, trace mono at every cut, render the trace at
// the enlarged size and score it against the SVG ITSELF rendered at that size on white
// (`fidelity`: SSIM, mean ΔE). The truth is the vector, not the blurry PNG, so the
// score answers "does the trace reproduce the page?" and the SSIM-optimal cut is a
// real optimum. Beside it, the RIDGE statistic at the native raster: pixels whose
// composited luma is a local darkness maximum across a thin stroke (both neighbours
// lighter by a margin in some direction) — the centres of sub-pixel strokes. Those
// with luma at or above the midpoint cut are the ink the cut LOSES; their share of the
// picture and their luma percentiles are what a rule could read.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureImageData } from './nodeHarness.ts'
import { renderSvg } from '../src/mcp/image.ts'
import { cutLuma, decideInkMode, VISIBLE_ALPHA, type ImageDataLike } from '../src/lib/traceInput/ink.ts'
import { monoTraceScale } from '../src/lib/traceInput/traceCaps.ts'
import { DEFAULT_VECTORIZE_OPTIONS, traceImage } from '../src/lib/trace/index.ts'
import { toImageData, upscaleImageData } from '../src/lib/sheet/crop.ts'
import { rasterizeDoc } from '../src/lib/render/raster.ts'
import { fidelity } from '../src/lib/render/fidelity.ts'
import { docStats } from '../src/lib/path/model.ts'
import type { VectorizeOptions } from '../src/types'

ensureImageData()
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null }
const RES = (arg('res') ?? '400,499,600,800').split(',').map(Number)
const CUTS = (arg('cuts') ?? '128,136,144,152,160,168,176,184,192,200').split(',').map(Number)
const GALLERY = Number(arg('gallery') ?? '0')
const OUT = arg('out') ?? join(process.cwd(), '.cache', 'hairline')
mkdirSync(OUT, { recursive: true })

// ------------------------------------------------------------ synthetic hairline art
// Authored in a 512-unit box, so at raster S a stroke of w units is w·S/512 px.
const synth: Record<string, string> = {
  'synth-staff': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <g stroke="#000" fill="none">
      ${[0, 1, 2, 3, 4].map((i) => `<line x1="20" y1="${80 + i * 12}" x2="492" y2="${80 + i * 12}" stroke-width="0.9"/>`).join('')}
      ${[0, 1, 2, 3, 4].map((i) => `<line x1="20" y1="${200 + i * 12}" x2="492" y2="${200 + i * 12}" stroke-width="0.6"/>`).join('')}
      ${[0, 1, 2, 3, 4].map((i) => `<line x1="20" y1="${320 + i * 12}" x2="492" y2="${320 + i * 12}" stroke-width="0.45"/>`).join('')}
      ${[120, 250, 380].map((x) => `<line x1="${x}" y1="80" x2="${x}" y2="128" stroke-width="0.9"/><line x1="${x}" y1="200" x2="${x}" y2="248" stroke-width="0.6"/><line x1="${x}" y1="320" x2="${x}" y2="368" stroke-width="0.45"/>`).join('')}
      ${[0, 1, 2, 3].map((i) => `<line x1="${60 + i * 110}" y1="${92 + i * 12}" x2="${60 + i * 110}" y2="${52 + i * 12}" stroke-width="1.4"/>`).join('')}
    </g>
    ${[0, 1, 2, 3].map((i) => `<ellipse cx="${64 + i * 110}" cy="${92 + i * 12}" rx="5.5" ry="4" transform="rotate(-20 ${64 + i * 110} ${92 + i * 12})" fill="#000"/>`).join('')}
    ${[0, 1, 2, 3].map((i) => `<ellipse cx="${64 + i * 110}" cy="${212 + i * 12}" rx="5.5" ry="4" transform="rotate(-20 ${64 + i * 110} ${212 + i * 12})" fill="#000"/>`).join('')}
    <text x="40" y="440" font-family="serif" font-size="22" fill="#000">Ich weiß, an wen ich glaube</text>
    <text x="40" y="470" font-family="serif" font-size="14" fill="#000">wenn alles hier im Staube wie Staub und Rauch verweht</text>
  </svg>`,
  'synth-diagram': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <g stroke="#000" fill="none">
      <rect x="40" y="40" width="200" height="120" stroke-width="0.7"/>
      <rect x="280" y="40" width="200" height="120" stroke-width="1.2"/>
      <circle cx="140" cy="300" r="80" stroke-width="0.5"/>
      <circle cx="380" cy="300" r="80" stroke-width="1"/>
      <line x1="40" y1="420" x2="480" y2="500" stroke-width="0.6"/>
      <line x1="40" y1="500" x2="480" y2="420" stroke-width="0.9"/>
      <path d="M60 200 Q140 240 220 200 T380 200" stroke-width="0.6"/>
    </g>
    <rect x="100" y="70" width="80" height="60" fill="#000"/>
    <circle cx="380" cy="300" r="20" fill="#000"/>
  </svg>`,
}
for (const [name, svg] of Object.entries(synth)) writeFileSync(join(OUT, `${name}.svg`), svg)

const SVGS = [...Object.keys(synth).map((n) => join(OUT, `${n}.svg`)), ...(arg('svg')?.split(',').filter(Boolean) ?? [])]

// ------------------------------------------------------------ ridge statistic
interface RidgeStats { ink: number; ridges: number; lost: number; lostShare: number; p: number[] }
const RIDGE_MARGIN = 10
const FAINT = 240
function ridgeStats(px: ImageDataLike, cut: number, invert: boolean): RidgeStats {
  const { width: W, height: H, data } = px
  const L = new Float32Array(W * H).fill(255)
  for (let i = 0; i < W * H; i++) if (data[i * 4 + 3] >= VISIBLE_ALPHA) L[i] = cutLuma(data, i * 4, invert)
  const dark = (l: number) => (invert ? 255 - l : l) // darkness axis: ink is low
  let ink = 0, ridges = 0
  const lostL: number[] = []
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    const d = dark(L[i])
    if (d < cut) ink++
    if (d >= FAINT) continue
    let ridge = false
    for (const [dx, dy] of dirs) {
      const a = dark(L[(y - dy) * W + (x - dx)]), b = dark(L[(y + dy) * W + (x + dx)])
      if (d + RIDGE_MARGIN <= a && d + RIDGE_MARGIN <= b) { ridge = true; break }
    }
    if (!ridge) continue
    ridges++
    if (d >= cut) lostL.push(d)
  }
  lostL.sort((a, b) => a - b)
  const q = (f: number) => (lostL.length ? lostL[Math.min(lostL.length - 1, Math.floor(f * lostL.length))] : NaN)
  return { ink, ridges, lost: lostL.length, lostShare: lostL.length / Math.max(1, ink + lostL.length), p: [q(0.25), q(0.5), q(0.75), q(0.9)] }
}

// ------------------------------------------------------------ the sweep
interface Row { name: string; res: number; k: number; stats: RidgeStats; best: number; bestSsim: number; at128: number; curve: string }
const rows: Row[] = []
for (const file of SVGS) {
  const svg = readFileSync(file, 'utf8')
  const name = file.replace(/\\/g, '/').split('/').pop()!.replace(/\.svg$/, '')
  for (const S of RES) {
    const px = renderSvg(svg, S) // transparent, like a user's PNG
    const ink = decideInkMode(px, 128, { colorMode: 'mono' })
    const base: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, mode: 'mono', threshold: ink.threshold, invert: ink.invert }
    const k = monoTraceScale(px, base).scale
    const input = k > 1 ? upscaleImageData(px, k) : px
    const truth = renderSvg(svg, S * k, '#ffffff')
    const stats = ridgeStats(px, ink.threshold, ink.invert)
    let best = 0, bestSsim = -1, at128 = 0
    const curve: string[] = []
    for (const cut of CUTS) {
      const doc = await traceImage(toImageData(input), { ...base, threshold: cut })
      const render = rasterizeDoc(doc, truth.width, truth.height)
      const f = fidelity(truth.data, render, truth.width, truth.height)
      curve.push(`${cut}:${f.ssim.toFixed(3)}/${f.meanDeltaE.toFixed(2)}/${docStats(doc).nodes}`)
      if (f.ssim > bestSsim) { bestSsim = f.ssim; best = cut }
      if (cut === 128) at128 = f.ssim
    }
    rows.push({ name, res: S, k, stats, best, bestSsim, at128, curve: curve.join(' ') })
    process.stdout.write(
      `${name.padEnd(14)} @${String(S).padStart(3)} ×${k}  midpoint ${ink.threshold}  ink ${stats.ink}  ridges ${stats.ridges}  lost ${stats.lost} (${(100 * stats.lostShare).toFixed(1)}%)  lost-luma p25/50/75/90 ${stats.p.map((v) => (Number.isNaN(v) ? '—' : v.toFixed(0))).join('/')}  → best cut ${best} (ssim ${bestSsim.toFixed(3)} vs ${at128.toFixed(3)} @128)\n`,
    )
    process.stdout.write(`    ${rows[rows.length - 1].curve}\n`)
  }
}

if (GALLERY > 0) {
  const dir = join(process.cwd(), 'examples', 'logos')
  const files = readdirSync(dir).filter((f) => f.endsWith('.svg')).sort().slice(0, GALLERY)
  let shown = 0
  for (const f of files) {
    const svg = readFileSync(join(dir, f), 'utf8')
    for (const S of [256, 512]) {
      const px = renderSvg(svg, S, '#ffffff')
      const ink = decideInkMode(px, 128, { colorMode: 'auto' })
      if (ink.mode !== 'mono') continue
      const st = ridgeStats(px, ink.threshold, ink.invert)
      if (shown++ < 12 || st.lostShare > 0.01)
        process.stdout.write(`gallery ${f.replace(/\.svg$/, '').padEnd(24)} @${S}  ink ${st.ink}  ridges ${st.ridges}  lost ${st.lost} (${(100 * st.lostShare).toFixed(2)}%)  p50 ${Number.isNaN(st.p[1]) ? '—' : st.p[1].toFixed(0)}\n`)
    }
  }
}
