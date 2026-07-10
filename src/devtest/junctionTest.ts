// Dev-only A/B view for planar trace FEATURES (served by Vite at
// /vectorize-ab.html). Traces the example corpus — plus any image you drop
// in — with the planar engine under each VARIANT, side by side, so a change can be
// JUDGED VISUALLY on real logos, not just corpus metrics.
//
// Meant to STAY in the tree and grow with future features. To A/B a new feature:
//   • add a VARIANT below with its `planarFit` override (index.ts merges it last), or
//   • add a CASE (or just drop an image in the running page).
// A shared pan/zoom "camera" drives every box together, so you can inspect one detail
// (a band↔ring junction, a wedge crossing) across all variants at the same framing.
// Box size / gradients / camera persist in localStorage.

import { getImageData } from '../lib/image'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace'
import type { VectorizeOptions } from '../types'
import { serializeDoc } from '../lib/path/model'
import type { EditableDoc } from '../lib/path/types'
import type { PlanarFitOptions } from '../lib/trace/planarFit'

/** One trace configuration rendered per case. `planarFit` overrides the fit
 *  tunables; `opts` overrides any other VectorizeOptions (e.g. backgroundGradient). */
interface Variant { name: string; cls?: string; planarFit?: Partial<PlanarFitOptions>; opts?: Partial<VectorizeOptions> }
const VARIANTS: Variant[] = [
  { name: 'Baseline', cls: 'base', planarFit: { arcSnap: false, refineJunctions: false } },
  { name: 'Arc-snap (shipped)', cls: 'shipped', planarFit: { arcSnap: true, refineJunctions: false } },
  { name: 'Sub-pixel + G¹', cls: 'refine', planarFit: { arcSnap: false, refineJunctions: true } },
  { name: 'Weld ≤3px', cls: 'refine', planarFit: { arcSnap: false, refineJunctions: false, weldJunctions: 3 } },
  { name: 'Weld + snap + G¹', planarFit: { arcSnap: true, refineJunctions: true, weldJunctions: 3 } },
  { name: 'BG gradient + weld', cls: 'refine', opts: { backgroundGradient: true }, planarFit: { arcSnap: true, refineJunctions: false, weldJunctions: 3 } },
]

interface Case { name: string; src: string; kind: 'png' | 'svg' }
const CASES: Case[] = [
  { name: 'orbit (ring)', kind: 'svg', src: '/examples/orbit.svg' },
  { name: 'bloom (crossings)', kind: 'svg', src: '/examples/bloom.svg' },
  { name: 'outline', kind: 'svg', src: '/examples/outline.svg' },
  { name: 'summit', kind: 'svg', src: '/examples/summit.svg' },
  { name: 'aurora', kind: 'svg', src: '/examples/aurora.svg' },
  { name: 'nebula', kind: 'png', src: '/examples/nebula.png' },
  { name: 'petals', kind: 'png', src: '/examples/petals.png' },
  // Handcrafted "difficult case" corpus — authored as SVG (src/devtest/genEdgeCases.ts →
  // regenerate with `node --experimental-strip-types src/devtest/genEdgeCases.ts`), so the
  // Input-px switch rasterizes each at any size: same vector content, varying resolution.
  // Each isolates one hard problem; flip "gradients on" and compare Weld / BG-gradient.
  { name: '⟐ bg-ramp — posterization bands', kind: 'svg', src: '/examples/edge-cases/bg-ramp.svg' },
  { name: '⟐ bg-ramp-twin — colour-class DELETE risk', kind: 'svg', src: '/examples/edge-cases/bg-ramp-twin.svg' },
  { name: '⟐ cross-bars — junction cluster (weld)', kind: 'svg', src: '/examples/edge-cases/cross-bars.svg' },
  { name: '⟐ concentric — circle/concentric snap', kind: 'svg', src: '/examples/edge-cases/concentric.svg' },
  { name: '⟐ hairlines — sub-pixel strokes', kind: 'svg', src: '/examples/edge-cases/hairlines.svg' },
  { name: '⟐ aa-seam — nearest-colour crispness', kind: 'svg', src: '/examples/edge-cases/aa-seam.svg' },
  { name: '⟐ checker — high-frequency aliasing', kind: 'svg', src: '/examples/edge-cases/checker.svg' },
  { name: '⟐ radial-glow — 2-D gradient field', kind: 'svg', src: '/examples/edge-cases/radial-glow.svg' },
  { name: '⟐ gradient-flat — render gate', kind: 'svg', src: '/examples/edge-cases/gradient-flat.svg' },
  { name: '⟐ sharp-star — corner detection', kind: 'svg', src: '/examples/edge-cases/sharp-star.svg' },
  { name: '⟐ annulus — hole winding + alpha', kind: 'svg', src: '/examples/edge-cases/annulus.svg' },
  { name: '⟐ overlap — layer decomposition', kind: 'svg', src: '/examples/edge-cases/overlap.svg' },
]

// --- persisted view state ---------------------------------------------------
interface Cam { x: number; y: number; w: number; h: number } // normalized [0,1] window
interface State { box: number; gradients: boolean; raster: number; cam: Cam }
/** Rasterization sizes offered by the Input-px switch (SVG cases re-render at each;
 *  raster cases only downscale, so they cap at their native size). */
const RASTER_SIZES = [128, 256, 512, 768, 1024]
const DEFAULT_STATE: State = { box: 300, gradients: false, raster: 512, cam: { x: 0, y: 0, w: 1, h: 1 } }
function load(): State {
  try { return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('junctionTest') || '{}') } } catch { return { ...DEFAULT_STATE } }
}
const state = load()
const save = (): void => localStorage.setItem('junctionTest', JSON.stringify(state))

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const out = $('out')
const status = $<HTMLElement>('status')
const sizeEl = $<HTMLInputElement>('size')
const gradEl = $<HTMLInputElement>('grad')
const resEl = $<HTMLSelectElement>('res')
const zoomEl = $<HTMLElement>('zoom')
const countEl = $<HTMLElement>('count')
const fileEl = $<HTMLInputElement>('file')
const dropEl = $<HTMLLabelElement>('drop')

// --- shared camera: one viewBox window applied to every .cam svg ------------
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const MIN_W = 0.02 // ~50× max zoom
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

// pan (drag) + zoom (wheel), anchored under the cursor, in normalized space.
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

// --- rendering --------------------------------------------------------------
function docStats(doc: EditableDoc): { paths: number; nodes: number } {
  let paths = 0, nodes = 0
  for (const it of doc.items) {
    if (it.kind !== 'path') continue
    paths++
    for (const sp of it.subPaths) nodes += sp.nodes.length
  }
  return { paths, nodes }
}

/** A camera-driven box: source shown via <image>, a trace via its serialized svg. */
function camBox(inner: string, w: number, h: number): HTMLElement {
  const box = document.createElement('div')
  box.className = 'box'
  box.innerHTML = inner
  const svg = box.querySelector('svg')
  if (svg) { svg.classList.add('cam'); svg.dataset.w = String(w); svg.dataset.h = String(h) }
  attachCam(box)
  return box
}

function cell(labelHtml: string, cls: string, boxEl: HTMLElement): HTMLElement {
  const c = document.createElement('div')
  c.className = `cell ${cls}`
  const lab = document.createElement('div')
  lab.className = 'label'
  lab.innerHTML = labelHtml
  c.append(lab, boxEl)
  return c
}

async function renderRow(name: string, image: ImageData, displaySrc: string, gradients: boolean, onRemove?: () => void): Promise<void> {
  const W = image.width, H = image.height
  const row = document.createElement('div')
  row.className = 'row'
  const h2 = document.createElement('h2')
  h2.textContent = name
  if (onRemove) {
    const rm = document.createElement('span')
    rm.className = 'rm'
    rm.textContent = '✕ remove'
    rm.onclick = () => { row.remove(); onRemove() }
    h2.append(rm)
  }
  const cells = document.createElement('div')
  cells.className = 'cells'
  cells.append(cell(`<b>source</b><span>${W}×${H}</span>`, '', camBox(`<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"><image href="${displaySrc}" x="0" y="0" width="${W}" height="${H}"/></svg>`, W, H)))
  for (const v of VARIANTS) {
    const doc = await traceImage(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients, ...v.opts, planarFit: v.planarFit })
    const s = docStats(doc)
    const j = doc.topology?.vertices.length ?? 0 // junction vertices — watch this across the Input-px switch
    cells.append(cell(`<b>${v.name}</b><span>${s.paths}p · ${s.nodes}n · ${j}j</span>`, v.cls ?? '', camBox(serializeDoc(doc, 2), W, H)))
  }
  row.append(h2, cells)
  out.append(row)
}

// --- dropped images (session only; object URLs die on reload) ---------------
interface Extra { name: string; image: ImageData; url: string }
const extras: Extra[] = []

async function imageFor(c: Case): Promise<ImageData> {
  if (c.kind === 'svg') return getImageData(c.src, state.raster, await (await fetch(c.src)).text())
  return getImageData(c.src, state.raster)
}

let runToken = 0
async function rebuild(): Promise<void> {
  const token = ++runToken
  out.innerHTML = ''
  const gradients = state.gradients
  for (const c of CASES) {
    if (token !== runToken) return
    status.textContent = `Tracing ${c.name}…`
    try { await renderRow(c.name, await imageFor(c), c.src, gradients) }
    catch (err) { console.error(c.name, err) }
  }
  for (const e of extras) {
    if (token !== runToken) return
    await renderRow(e.name, e.image, e.url, gradients, () => { const i = extras.indexOf(e); if (i >= 0) extras.splice(i, 1) })
  }
  if (token === runToken) { status.textContent = `Done · gradients ${gradients ? 'on' : 'off'} · ${extras.length} dropped`; countEl.textContent = '' }
  applyCam()
}

async function addImage(file: File): Promise<void> {
  const url = URL.createObjectURL(file)
  const svgText = file.type.includes('svg') ? await file.text() : undefined
  const image = await getImageData(url, state.raster, svgText)
  const e: Extra = { name: file.name, image, url }
  extras.push(e)
  await renderRow(e.name, e.image, e.url, state.gradients, () => { const i = extras.indexOf(e); if (i >= 0) extras.splice(i, 1) })
  applyCam()
}

// --- wire controls ----------------------------------------------------------
sizeEl.value = String(state.box)
gradEl.checked = state.gradients
resEl.innerHTML = RASTER_SIZES.map((s) => `<option value="${s}"${s === state.raster ? ' selected' : ''}>${s}px</option>`).join('')
document.documentElement.style.setProperty('--box', `${state.box}px`)
sizeEl.addEventListener('input', () => { state.box = +sizeEl.value; document.documentElement.style.setProperty('--box', `${state.box}px`); save() })
gradEl.addEventListener('change', () => { state.gradients = gradEl.checked; save(); void rebuild() })
// Input-px switch: SVG cases re-rasterize at the chosen size; watch nodes/junctions move.
resEl.addEventListener('change', () => { state.raster = +resEl.value; save(); void rebuild() })
$('reset').addEventListener('click', () => { state.cam = { x: 0, y: 0, w: 1, h: 1 }; applyCam() })
fileEl.addEventListener('change', () => { const f = fileEl.files?.[0]; if (f) void addImage(f); fileEl.value = '' })
;['dragover', 'dragenter'].forEach((t) => dropEl.addEventListener(t, (e) => { e.preventDefault(); dropEl.classList.add('over') }))
;['dragleave', 'drop'].forEach((t) => dropEl.addEventListener(t, () => dropEl.classList.remove('over')))
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer?.files?.[0]; if (f && f.type.startsWith('image/')) void addImage(f) })

void rebuild()
