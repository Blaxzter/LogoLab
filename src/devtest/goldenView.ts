// Dev-only VISUAL review of the trace regression corpus (served by Vite at
// /labs/vectorize-golden.html).
//
// The regression suite (test/trace-regression.test.ts) asserts NUMBERS against the
// blessed records in test/golden/trace-baseline.json. Nobody had ever LOOKED at what
// those numbers correspond to. This page renders, per golden case:
//
//   source │ current trace │ ΔE error map │ seam map (the pixels the seam gate scores)
//
// plus every HARD gate with its current value, its golden, its failing limit and the
// HEADROOM left — so "is this gate doing any work?" is answerable at a glance.
//
// Two properties make the page trustworthy rather than decorative:
//   • the case list + trace options come from ./traceCorpus.ts — the SAME module the
//     Node gate imports, so the page cannot silently trace something else;
//   • the gated numbers come from scoreDoc() — the SAME function recordCase() calls —
//     so the value shown IS the value asserted. Only the source pixels differ in
//     origin (canvas decode here, the local PNG decoder in Node); the page measures
//     that difference and warns when it matters.
//
// The ΔE map and seam overlay are computed here (metrics.ts keeps its seam internals
// private). They mirror fidelity()'s rule exactly — SMOOTH_GRAD 8, a 1px edge
// neighbourhood — and were verified to reproduce its seamMax to the last decimal.

import { getImageData } from '../lib/image'
import { traceImage } from '../lib/trace'
import { serializeDoc, subPathsToD } from '../lib/path/model'
import type { EditableDoc } from '../lib/path/types'
import { rasterizeDoc, boundaryMask } from '../lib/render/raster'
import { scoreDoc } from './scoreboard'
import { hashDoc } from './metrics'
import { srgbToLab } from './color'
import {
  GOLDEN_CORPUS, downscale, geomSignature, evaluateGates, caseUrl, TOL,
  type GoldenCase, type GoldenRecord, type GateRow, type RgbaImage,
} from './traceCorpus'

// --- persisted view state ---------------------------------------------------
interface Cam { x: number; y: number; w: number; h: number } // normalized [0,1] window
interface State { box: number; heat: number; wire: boolean; slow: boolean; about: boolean; cam: Cam }
/** Full-scale of the ΔE heat ramp. 2.3 ΔE ≈ "just noticeable"; 40 shows structure. */
const HEAT_SCALES = [5, 10, 20, 40, 100]
// `about` starts CLOSED: the explanation is worth reading once and worth getting out of the
// way every time after that. A fixed wall of prose leaves no room for the pictures.
const DEFAULT_STATE: State = { box: 260, heat: 20, wire: false, slow: true, about: false, cam: { x: 0, y: 0, w: 1, h: 1 } }
function load(): State {
  try { return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('goldenView') || '{}') } } catch { return { ...DEFAULT_STATE } }
}
const state = load()
const save = (): void => localStorage.setItem('goldenView', JSON.stringify(state))

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const out = $('out')
const status = $<HTMLElement>('status')
const sizeEl = $<HTMLInputElement>('size')
const heatEl = $<HTMLSelectElement>('heat')
const wireEl = $<HTMLInputElement>('wire')
const slowEl = $<HTMLInputElement>('slow')
const zoomEl = $<HTMLElement>('zoom')

// --- shared camera (same pattern as junctionTest.ts) ------------------------
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const MIN_W = 0.01 // ~100× max zoom — a 1px seam is worth pixel-peeping
function clampCam(): void {
  const c = state.cam
  c.w = clamp(c.w, MIN_W, 1)
  c.h = c.w
  c.x = clamp(c.x, 0, 1 - c.w)
  c.y = clamp(c.y, 0, 1 - c.h)
}
function applyCam(): void {
  const c = state.cam
  for (const svg of document.querySelectorAll<SVGSVGElement>('svg.cam')) {
    const W = +(svg.dataset.w || 1)
    const H = +(svg.dataset.h || 1)
    svg.setAttribute('viewBox', `${c.x * W} ${c.y * H} ${c.w * W} ${c.h * H}`)
  }
  zoomEl.textContent = `${(1 / c.w).toFixed(1)}×`
  save()
}
let drag: { box: HTMLElement; x: number; y: number } | null = null
function attachCam(box: HTMLElement): void {
  box.addEventListener('pointerdown', (e) => { drag = { box, x: e.clientX, y: e.clientY }; box.setPointerCapture(e.pointerId) })
  box.addEventListener('pointermove', (e) => {
    if (!drag) return
    const px = box.clientWidth || 1
    state.cam.x -= ((e.clientX - drag.x) * state.cam.w) / px
    state.cam.y -= ((e.clientY - drag.y) * state.cam.h) / px
    drag.x = e.clientX
    drag.y = e.clientY
    clampCam(); applyCam()
  })
  const end = (e: PointerEvent): void => { drag = null; try { box.releasePointerCapture(e.pointerId) } catch { /* ignore */ } }
  box.addEventListener('pointerup', end)
  box.addEventListener('pointercancel', end)
  box.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = box.getBoundingClientRect()
    const lx = (e.clientX - r.left) / r.width
    const ly = (e.clientY - r.top) / r.height
    const c = state.cam
    const pxn = c.x + lx * c.w
    const pyn = c.y + ly * c.h
    c.w = clamp(c.w * (e.deltaY > 0 ? 1.12 : 1 / 1.12), MIN_W, 1)
    c.h = c.w
    c.x = pxn - lx * c.w
    c.y = pyn - ly * c.h
    clampCam(); applyCam()
  }, { passive: false })
}

// --- pixel maths (mirrors metrics.fidelity's seam rule) ---------------------

/** Source gradient below this ⇒ the pixel sits in a SMOOTH field. Mirrors metrics.ts. */
const SMOOTH_GRAD = 8
/** Radius within which a source edge and a render edge count as the SAME edge. */
const EDGE_NEIGHBORHOOD = 1

function overWhite(px: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const out2 = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const a = px[o + 3] / 255
    out2[o] = px[o] * a + 255 * (1 - a)
    out2[o + 1] = px[o + 1] * a + 255 * (1 - a)
    out2[o + 2] = px[o + 2] * a + 255 * (1 - a)
    out2[o + 3] = 255
  }
  return out2
}
function toLab(px: Uint8ClampedArray, n: number): Float32Array {
  const lab = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const c = srgbToLab(px[o], px[o + 1], px[o + 2])
    lab[i * 3] = c[0]; lab[i * 3 + 1] = c[1]; lab[i * 3 + 2] = c[2]
  }
  return lab
}
function localGradient(lab: Float32Array, w: number, h: number, x: number, y: number): number {
  const k = (y * w + x) * 3
  let g = 0
  const probe = (nx: number, ny: number): void => {
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
    const j = (ny * w + nx) * 3
    const dl = lab[k] - lab[j], da = lab[k + 1] - lab[j + 1], db = lab[k + 2] - lab[j + 2]
    const d = Math.sqrt(dl * dl + da * da + db * db)
    if (d > g) g = d
  }
  probe(x - 1, y); probe(x + 1, y); probe(x, y - 1); probe(x, y + 1)
  return g
}
function edgeMask(lab: Float32Array, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (localGradient(lab, w, h, x, y) >= SMOOTH_GRAD) m[y * w + x] = 1
  return m
}
function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let cur = mask
  for (let p = 0; p < radius; p++) {
    const next = new Uint8Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!cur[y * w + x]) continue
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx >= 0 && nx < w && ny >= 0 && ny < h) next[ny * w + nx] = 1
      }
    }
    cur = next
  }
  return cur
}

/** Perceptual heat ramp for a 0–1 normalized error. */
function heatColor(t: number): [number, number, number] {
  const c = clamp(t, 0, 1)
  const stops: [number, number, number][] = [
    [10, 12, 34], [40, 60, 180], [30, 160, 170], [120, 200, 80], [250, 220, 60], [240, 120, 30], [200, 20, 20],
  ]
  const s = c * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(s))
  const k = s - i
  const a = stops[i], b = stops[i + 1]
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

// --- per-case analysis ------------------------------------------------------

interface Analysis {
  img: RgbaImage
  doc: EditableDoc
  score: ReturnType<typeof scoreDoc>
  gates: GateRow[]
  hash: string
  geomSig: string
  /** Per-pixel CIE76 ΔE, source vs render (both over white). */
  de: Float64Array
  /** 1 where the seam metric actually counts the pixel. */
  seam: Uint8Array
  seamCount: number
  /** Worst seam pixel — the one that IS the seamMax the gate asserts. */
  seamArgmax: { x: number; y: number; de: number } | null
  /** Worst seam pixel ignoring a 1px image border. Reveals when seamMax is pinned by
   *  a border artifact rather than a real interior seam. NOT a gate. */
  interiorSeamMax: number
  interiorArgmax: { x: number; y: number } | null
  renderUrl: string
  heatUrl: string
  seamUrl: string
  traceMs: number
}

function rgbaToUrl(px: Uint8ClampedArray, w: number, h: number): string {
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('no 2d ctx')
  // Fill a canvas-owned ImageData rather than `new ImageData(px, …)`: our buffers are
  // plain Uint8ClampedArrays, which the DOM constructor's ArrayBuffer-narrowed type
  // rejects.
  const id = ctx.createImageData(w, h)
  id.data.set(px)
  ctx.putImageData(id, 0, 0)
  return cv.toDataURL('image/png')
}

async function analyze(c: GoldenCase, g: GoldenRecord): Promise<Analysis> {
  // Load at NATIVE resolution, then apply the corpus's own box-downscale — the same
  // two steps loadCase() performs in Node. Going through getImageData's canvas
  // resampling instead would feed the tracer different pixels than the gate sees.
  const native = await getImageData(caseUrl(c), 1e9)
  const img: RgbaImage = c.maxDim > 0 ? downscale(native, c.maxDim) : native
  const w = img.width, h = img.height, n = w * h

  const t0 = performance.now()
  const doc = await traceImage(img as unknown as ImageData, c.options)
  const traceMs = performance.now() - t0

  const score = scoreDoc(img, doc)
  const gates = evaluateGates(g, score)
  const render = rasterizeDoc(doc, w, h)

  const sO = overWhite(img.data, n)
  const rO = overWhite(render, n)
  const sLab = toLab(sO, n), rLab = toLab(rO, n)
  const de = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const k = i * 3
    const dl = sLab[k] - rLab[k], da = sLab[k + 1] - rLab[k + 1], db = sLab[k + 2] - rLab[k + 2]
    de[i] = Math.sqrt(dl * dl + da * da + db * db)
  }

  const bmask = boundaryMask(doc, w, h, 1)
  const sZone = dilate(edgeMask(sLab, w, h), w, h, EDGE_NEIGHBORHOOD)
  const rZone = dilate(edgeMask(rLab, w, h), w, h, EDGE_NEIGHBORHOOD)
  const seam = new Uint8Array(n)
  let seamCount = 0
  let seamArgmax: Analysis['seamArgmax'] = null
  let interiorSeamMax = 0
  let interiorArgmax: Analysis['interiorArgmax'] = null
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (!bmask[i] || (sZone[i] && rZone[i])) continue
    seam[i] = 1
    seamCount++
    if (!seamArgmax || de[i] > seamArgmax.de) seamArgmax = { x, y, de: de[i] }
    const onBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1
    if (!onBorder && de[i] > interiorSeamMax) { interiorSeamMax = de[i]; interiorArgmax = { x, y } }
  }

  // Heat map of every pixel's ΔE.
  const heat = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const [r, gg, b] = heatColor(de[i] / state.heat)
    heat[i * 4] = r; heat[i * 4 + 1] = gg; heat[i * 4 + 2] = b; heat[i * 4 + 3] = 255
  }
  // Seam map: the render, desaturated, with ONLY the scored seam pixels lit.
  const seamPx = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (seam[i]) {
      const [r, gg, b] = heatColor(de[i] / state.heat)
      seamPx[o] = r; seamPx[o + 1] = gg; seamPx[o + 2] = b; seamPx[o + 3] = 255
    } else {
      const l = 0.2126 * rO[o] + 0.7152 * rO[o + 1] + 0.0722 * rO[o + 2]
      const v = 235 - (235 - l) * 0.12 // near-white ghost of the render
      seamPx[o] = v; seamPx[o + 1] = v; seamPx[o + 2] = v; seamPx[o + 3] = 255
    }
  }
  // Crosshair on the argmax pixel — that single pixel IS the gated seamMax.
  if (seamArgmax) {
    const { x, y } = seamArgmax
    for (let d = -6; d <= 6; d++) {
      for (const [px, py] of [[x + d, y], [x, y + d]] as [number, number][]) {
        if (px < 0 || py < 0 || px >= w || py >= h) continue
        if (Math.abs(d) < 2) continue
        const o = (py * w + px) * 4
        seamPx[o] = 255; seamPx[o + 1] = 0; seamPx[o + 2] = 255; seamPx[o + 3] = 255
      }
    }
  }

  return {
    img, doc, score, gates, hash: hashDoc(doc), geomSig: geomSignature(doc),
    de, seam, seamCount, seamArgmax, interiorSeamMax, interiorArgmax,
    renderUrl: rgbaToUrl(rO, w, h),
    heatUrl: rgbaToUrl(heat, w, h),
    seamUrl: rgbaToUrl(seamPx, w, h),
    traceMs,
  }
}

// --- rendering --------------------------------------------------------------

/** Nodes/edges wireframe of the planar shared-edge graph (same as junctionTest.ts):
 *  every shared edge stroked once, an anchor dot per node (square = corner, round =
 *  smooth), a ring per junction vertex. Node & junction COUNTS are gated, so this is
 *  the structure the numbers are counting. */
function wireGroup(doc: EditableDoc): string {
  const t = doc.topology
  if (!t || t.edges.length === 0) return ''
  const f = (n: number): string => n.toFixed(2)
  let edges = '', corners = '', smooths = '', verts = ''
  for (const e of t.edges) {
    edges += `<path d="${subPathsToD([{ nodes: e.nodes, closed: e.closed }], 2)}"/>`
    for (const n of e.nodes) {
      const dot = `<line x1="${f(n.x)}" y1="${f(n.y)}" x2="${f(n.x)}" y2="${f(n.y)}"/>`
      if (n.kind === 'corner') corners += dot
      else smooths += dot
    }
  }
  for (const v of t.vertices) {
    const at = `x1="${f(v.x)}" y1="${f(v.y)}" x2="${f(v.x)}" y2="${f(v.y)}"`
    verts += `<line class="v-out" ${at}/><line class="v-in" ${at}/>`
  }
  return `<g class="wire"><g class="w-edge">${edges}</g><g class="w-corner">${corners}</g><g class="w-smooth">${smooths}</g><g class="w-vert">${verts}</g></g>`
}

function camBox(inner: string, w: number, h: number): HTMLElement {
  const box = document.createElement('div')
  box.className = 'box'
  box.innerHTML = inner
  const svg = box.querySelector('svg')
  if (svg) { svg.classList.add('cam'); svg.dataset.w = String(w); svg.dataset.h = String(h) }
  attachCam(box)
  return box
}
const imgSvg = (url: string, w: number, h: number): string =>
  `<svg viewBox="0 0 ${w} ${h}"><image href="${url}" x="0" y="0" width="${w}" height="${h}" style="image-rendering: pixelated"/></svg>`

function cell(title: string, sub: string, boxEl: HTMLElement): HTMLElement {
  const c = document.createElement('div')
  c.className = 'cell'
  const lab = document.createElement('div')
  lab.className = 'label'
  lab.innerHTML = `<b>${title}</b><span>${sub}</span>`
  c.append(lab, boxEl)
  return c
}

const fmt = (v: number, d: number): string => (Number.isFinite(v) ? v.toFixed(d) : String(v))

/** One gate as a labelled headroom bar. The bar fills with the allowance ALREADY
 *  USED, so a nearly-full bar = about to fail, an empty bar = miles of slack. */
function gateRow(r: GateRow): string {
  const used = clamp(1 - r.headroom, 0, 1)
  const pctLeft = Math.round(r.headroom * 100)
  const cls = !r.pass ? 'fail' : r.headroom < 0.2 ? 'tight' : r.headroom < 0.5 ? 'warn' : 'ok'
  // A zero-allowance gate (junctionClusters) has no bar to draw — it is pass/fail.
  const bar = r.allowance === 0
    ? `<div class="bar zero"><span>no tolerance</span></div>`
    : `<div class="bar"><i class="${cls}" style="width:${(used * 100).toFixed(1)}%"></i></div>`
  const band = r.lo !== undefined ? ` <span class="dim">[${r.lo}, ${r.hi}]</span>` : ''
  const head = r.allowance === 0
    ? (r.pass ? '—' : 'FAIL')
    : `${pctLeft}%`
  return `<tr class="${cls}">
    <td class="k">${r.label}</td>
    <td class="rule">${r.rule}</td>
    <td class="num v">${fmt(r.value, r.digits)}</td>
    <td class="num g">${fmt(r.golden, r.digits)}</td>
    <td class="num l">${fmt(r.limit, r.digits)}${band}</td>
    <td class="barcell">${bar}</td>
    <td class="num head">${head}</td>
  </tr>`
}

function panel(c: GoldenCase, g: GoldenRecord, a: Analysis): HTMLElement {
  const el = document.createElement('div')
  el.className = 'panel'
  const s = a.score

  // Does the browser reproduce the Node gate's numbers? If the canvas PNG decode
  // differs from the harness's decoder the live values drift from the blessed ones,
  // and the headroom shown here would be measuring the wrong thing. Say so loudly.
  const drift = Math.abs(s.meanDeltaE - g.meanDeltaE)
  const driftWarn = drift > 0.02
    ? `<div class="warnbox">⚠ This page's live numbers differ from the blessed record
       (meanΔE ${fmt(s.meanDeltaE, 3)} vs ${g.meanDeltaE}). The browser's PNG decode does not
       match the Node harness's, so treat the headroom below as indicative, not exact.</div>`
    : `<div class="okbox">✓ Live numbers reproduce the blessed record exactly — the headroom below is what CI actually measures.</div>`

  const hashChanged = a.hash !== g.hash || a.geomSig !== g.geomSig
  const soft = `<div class="soft">
    <b>SOFT (logged, never fails):</b>
    hash <code>${g.hash}</code> → <code class="${a.hash !== g.hash ? 'moved' : ''}">${a.hash}</code> ·
    geomSig <code>${g.geomSig}</code> → <code class="${a.geomSig !== g.geomSig ? 'moved' : ''}">${a.geomSig}</code>
    ${hashChanged ? '<span class="moved">— output moved, build still green</span>' : ''}
  </div>`

  const seamAt = a.seamArgmax
    ? `worst seam pixel (${a.seamArgmax.x}, ${a.seamArgmax.y}) = ${fmt(a.seamArgmax.de, 1)} ΔE`
    : 'no seam pixels'
  const border = a.seamArgmax
    ? (a.seamArgmax.x === 0 || a.seamArgmax.y === 0 || a.seamArgmax.x === a.img.width - 1 || a.seamArgmax.y === a.img.height - 1)
    : false
  const seamNote = `<div class="note">
    <b>seam diagnostic (not a gate):</b> ${seamAt}${border ? ' — <b class="moved">ON THE IMAGE BORDER</b>' : ''}.
    Worst seam ignoring the 1px border: <b>${fmt(a.interiorSeamMax, 1)} ΔE</b>${a.interiorArgmax ? ` at (${a.interiorArgmax.x}, ${a.interiorArgmax.y})` : ''}.
    ${border ? `Because seamMax is a MAX pinned to a border pixel, the gate's limit
       (${fmt(g.seamMax + TOL.seamMax, 1)}) sits far above the worst genuine interior seam
       (${fmt(a.interiorSeamMax, 1)}) — a real interior seam could grow that far without failing.` : ''}
    ${a.seamCount} pixels scored.
  </div>`

  const ung = `<div class="ungated"><b>RECORDED BUT NOT GATED</b> — free to drift:
    p95 ΔE <b>${fmt(s.p95DeltaE, 2)}</b> <span class="dim">(g ${g.p95DeltaE})</span> ·
    clusterSpanMax <b>${fmt(s.clusterSpanMax, 2)}</b> <span class="dim">(g ${g.clusterSpanMax})</span> ·
    gradients <b>${s.gradients}</b> <span class="dim">(g ${g.gradientCount})</span> ·
    junctions <b>${s.junctions}</b> <span class="dim">(g ${g.junctions})</span> ·
    seam P99.5 <b>${fmt(s.seamP995, 1)}</b> <span class="dim">(not recorded)</span>
  </div>`

  el.innerHTML = `
    ${driftWarn}
    <table class="gates">
      <thead><tr>
        <th>HARD gate</th><th>rule</th><th class="num">current</th><th class="num">golden</th>
        <th class="num">fails at</th><th>allowance used</th><th class="num">headroom</th>
      </tr></thead>
      <tbody>${a.gates.map(gateRow).join('')}</tbody>
    </table>
    ${seamNote}
    ${ung}
    ${soft}
  `
  return el
}

async function renderCase(c: GoldenCase, g: GoldenRecord): Promise<void> {
  const row = document.createElement('div')
  row.className = 'row'

  const a = await analyze(c, g)
  const { width: W, height: H } = a.img

  const h2 = document.createElement('h2')
  const runs = !c.slow
  h2.innerHTML = `${c.name}
    <span class="badge ${runs ? 'runs' : 'skipped'}">${runs ? 'runs in default suite' : 'SKIPPED unless INCLUDE_SLOW=1'}</span>
    <span class="badge ${c.options.gradients ? 'grad' : 'flat'}">gradients ${c.options.gradients ? 'ON' : 'OFF'}</span>
    <span class="dim">${W}×${H} · ${a.traceMs.toFixed(0)} ms · ${c.path}</span>`

  const cells = document.createElement('div')
  cells.className = 'cells'
  cells.append(
    cell('source', `${W}×${H} — what the tracer is given`,
      camBox(imgSvg(caseUrl(c), W, H), W, H)),
    cell('current trace', `${a.score.paths}p · ${a.score.nodes}n · ${a.doc.topology?.vertices.length ?? 0}j`,
      camBox(`<svg viewBox="0 0 ${W} ${H}"><g class="fill">${serializeDoc(a.doc, 2).replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')}</g>${wireGroup(a.doc)}</svg>`, W, H)),
    cell('rasterizeDoc render', 'exactly what the metrics score',
      camBox(imgSvg(a.renderUrl, W, H), W, H)),
    cell('ΔE error map', `CIE76, 0 → ${state.heat} ΔE`,
      camBox(imgSvg(a.heatUrl, W, H), W, H)),
    cell('seam map', `${a.seamCount} scored px · ✚ = the gated max`,
      camBox(imgSvg(a.seamUrl, W, H), W, H)),
  )

  row.append(h2, cells, panel(c, g, a))
  out.append(row)
  applyCam()
}

// --- run --------------------------------------------------------------------
let runToken = 0
async function rebuild(): Promise<void> {
  const token = ++runToken
  out.innerHTML = ''
  let golden: Record<string, GoldenRecord>
  try {
    golden = await (await fetch('/test/golden/trace-baseline.json')).json()
  } catch {
    status.textContent = 'Could not load test/golden/trace-baseline.json — is the dev server serving the repo root?'
    return
  }
  const cases = GOLDEN_CORPUS.filter((c) => state.slow || !c.slow)
  for (const c of cases) {
    if (token !== runToken) return
    const g = golden[c.name]
    if (!g) continue
    status.textContent = `Tracing ${c.name}… (${cases.indexOf(c) + 1}/${cases.length})`
    try { await renderCase(c, g) }
    catch (err) {
      console.error(c.name, err)
      const e = document.createElement('div')
      e.className = 'row'
      e.innerHTML = `<h2>${c.name} <span class="badge skipped">FAILED TO RENDER</span></h2><pre>${String(err)}</pre>`
      out.append(e)
    }
  }
  if (token === runToken) status.textContent = `Done — ${cases.length} cases. Drag to pan, wheel to zoom (all boxes move together).`
}

// --- controls ---------------------------------------------------------------
sizeEl.value = String(state.box)
heatEl.innerHTML = HEAT_SCALES.map((s) => `<option value="${s}"${s === state.heat ? ' selected' : ''}>0–${s} ΔE</option>`).join('')
wireEl.checked = state.wire
slowEl.checked = state.slow
document.body.classList.toggle('wires', state.wire)
document.documentElement.style.setProperty('--box', `${state.box}px`)
sizeEl.addEventListener('input', () => { state.box = +sizeEl.value; document.documentElement.style.setProperty('--box', `${state.box}px`); save() })
heatEl.addEventListener('change', () => { state.heat = +heatEl.value; save(); void rebuild() })
wireEl.addEventListener('change', () => { state.wire = wireEl.checked; save(); document.body.classList.toggle('wires', state.wire) })
slowEl.addEventListener('change', () => { state.slow = slowEl.checked; save(); void rebuild() })
const aboutEl = $<HTMLDetailsElement>('about')
aboutEl.open = state.about
aboutEl.addEventListener('toggle', () => { state.about = aboutEl.open; save() })

$('reset').addEventListener('click', () => { state.cam = { x: 0, y: 0, w: 1, h: 1 }; applyCam() })

void rebuild()
