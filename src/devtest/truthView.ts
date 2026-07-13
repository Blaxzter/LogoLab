// Dev-only VISUAL review of the GROUND-TRUTH corpus (served by Vite at /labs/vectorize-truth.html).
//
// The sibling page (/labs/vectorize-golden.html) reviews the regression baseline — the tracer
// compared against its OWN previous output. That answers "did anything change". It cannot
// answer "is this correct", and its ±12% count bands actively forbid large improvements.
//
// This page answers "is this correct". Every case is an authored SVG: we rasterize it, trace
// the pixels, and score the recovered vectors against THE ART THAT MADE THEM. Every number
// has a known optimum (0px boundary error, parsimony 1.0, every region recovered), so an
// improvement is visibly an improvement and nothing ever needs re-blessing.
//
// Why the page matters and not just the numbers: a boundary score of "26px Hausdorff" is
// unfalsifiable until you can SEE which arc it is. The miss-heat and dropped-region panels
// exist so every number here can be located on the image and argued with.
//
// Trust properties, same as the golden page:
//   • the case list, trace options and gates come from ./truthCorpus.ts — the SAME module
//     the Node runner imports, so this page cannot silently score something else;
//   • the metrics come from ./geomScore.ts — the SAME functions the Node runner calls.
//   • the ONE difference is the rasterizer: this page rasterizes the SVG with the browser's
//     canvas, the Node runner uses resvg. Anti-aliasing differs slightly, so numbers here
//     may differ from the CLI in the last decimal. It is measured, not hidden — see the
//     rasterizer note in the header.

import { getImageData } from '../lib/image'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace'
import { serializeDoc } from '../lib/path/model'
import { parseGroundTruth, toRasterSpace, unscorable } from './svgGround.ts'
import { scoreGeometry, scoreRegions, flattenSubPath, type GeomScore, type RegionScore, type DistPoint } from './geomScore.ts'
import { TRUTH_CORPUS, TRUTH_RESOLUTIONS, TRUTH_TOL, evaluateTruthGates, truthUrl, type TruthCase } from './truthCorpus.ts'
import type { EditableDoc, SubPath } from '../lib/path/types'

// --- state ------------------------------------------------------------------
interface State { box: number; res: number; heat: number; about: boolean; cam: { x: number; y: number; w: number; h: number } }
const HEAT_SCALES = [1, 2, 5, 10, 25]
// `about` starts CLOSED: the explanation is worth reading once, and worth getting out of the
// way every time after that. A fixed wall of prose leaves no room for the data.
const DEFAULT_STATE: State = { box: 260, res: 512, heat: 5, about: false, cam: { x: 0, y: 0, w: 1, h: 1 } }
function load(): State {
  try { return { ...DEFAULT_STATE, ...JSON.parse(localStorage.getItem('truthView') ?? '{}') } } catch { return { ...DEFAULT_STATE } }
}
const state = load()
const save = (): void => localStorage.setItem('truthView', JSON.stringify(state))

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const out = $('out')
const status = $<HTMLElement>('status')

// --- shared camera (same pattern as goldenView) -----------------------------
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const MIN_W = 0.01
function clampCam(): void {
  const c = state.cam
  c.w = clamp(c.w, MIN_W, 1); c.h = c.w
  c.x = clamp(c.x, 0, 1 - c.w); c.y = clamp(c.y, 0, 1 - c.h)
}
function applyCam(): void {
  clampCam()
  const { x, y, w, h } = state.cam
  for (const el of document.querySelectorAll<SVGSVGElement>('svg[data-cam]')) {
    const s = Number(el.dataset.side)
    el.setAttribute('viewBox', `${x * s} ${y * s} ${w * s} ${h * s}`)
  }
  $('zoom').textContent = `${(1 / state.cam.w).toFixed(1)}×`
  save()
}
function attachCam(box: HTMLElement): void {
  let drag: { px: number; py: number } | null = null
  box.addEventListener('pointerdown', (e) => { drag = { px: e.clientX, py: e.clientY }; box.setPointerCapture(e.pointerId) })
  box.addEventListener('pointerup', (e) => { drag = null; box.releasePointerCapture(e.pointerId) })
  box.addEventListener('pointermove', (e) => {
    if (!drag) return
    const r = box.getBoundingClientRect()
    state.cam.x -= ((e.clientX - drag.px) / r.width) * state.cam.w
    state.cam.y -= ((e.clientY - drag.py) / r.height) * state.cam.h
    drag = { px: e.clientX, py: e.clientY }
    applyCam()
  })
  box.addEventListener('wheel', (e) => {
    e.preventDefault()
    const r = box.getBoundingClientRect()
    const ux = (e.clientX - r.left) / r.width, uy = (e.clientY - r.top) / r.height
    const k = Math.exp(e.deltaY * 0.0015)
    const nw = clamp(state.cam.w * k, MIN_W, 1)
    state.cam.x += (state.cam.w - nw) * ux
    state.cam.y += (state.cam.h - nw) * uy
    state.cam.w = state.cam.h = nw
    applyCam()
  }, { passive: false })
}

// --- painting ---------------------------------------------------------------
/** Cold→hot ramp; t is 0..1. Mirrors goldenView's ΔE ramp so the two pages read alike. */
function heat(t: number): string {
  const stops: [number, number, number][] = [[10, 12, 34], [40, 60, 180], [30, 160, 170], [120, 200, 80], [250, 220, 60], [240, 120, 30], [200, 20, 20]]
  const u = clamp(t, 0, 1) * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(u)), f = u - i
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f))
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

function rgbaToUrl(px: Uint8ClampedArray, w: number, h: number): string {
  const cv = document.createElement('canvas')
  cv.width = w; cv.height = h
  cv.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0)
  return cv.toDataURL()
}

/** Raster with DROPPED regions burned in red — the picture behind "5/7 recovered". */
function dropOverlay(img: ImageData, mask: Uint8Array): string {
  const px = new Uint8ClampedArray(img.data)
  for (let i = 0; i < mask.length; i++) {
    const o = i * 4
    if (mask[i]) { px[o] = 240; px[o + 1] = 20; px[o + 2] = 40 }
    else { px[o] = 255 - (255 - px[o]) * 0.18; px[o + 1] = 255 - (255 - px[o + 1]) * 0.18; px[o + 2] = 255 - (255 - px[o + 2]) * 0.18 }
  }
  return rgbaToUrl(px, img.width, img.height)
}

/** Boundary points as coloured dots, hot = far from the other side's boundary. */
function heatSvg(pts: DistPoint[], side: number, scale: number): string {
  const dots = pts.map((p) => `<rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="1.6" height="1.6" fill="${heat(p.d / scale)}"/>`).join('')
  return `<svg data-cam data-side="${side}" viewBox="0 0 ${side} ${side}" xmlns="http://www.w3.org/2000/svg"><rect width="${side}" height="${side}" fill="#0a0c16"/>${dots}</svg>`
}

/** Authored boundary (green) and traced boundary (magenta) superimposed. Where the tracer
 *  agrees they overprint; where it does not, you see one colour alone. */
function overlaySvg(gtPolys: string[], docPolys: string[], side: number): string {
  return `<svg data-cam data-side="${side}" viewBox="0 0 ${side} ${side}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${side}" height="${side}" fill="#0a0c16"/>
    <g fill="none" stroke="#22c55e" stroke-width="2.4" vector-effect="non-scaling-stroke" opacity="0.95">${gtPolys.join('')}</g>
    <g fill="none" stroke="#e879f9" stroke-width="1.1" vector-effect="non-scaling-stroke" opacity="0.95">${docPolys.join('')}</g>
  </svg>`
}

const polysOf = (sets: SubPath[][]): string[] => {
  const out: string[] = []
  for (const set of sets) {
    for (const sp of set) {
      const pts = flattenSubPath(sp)
      if (pts.length < 2) continue
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') + (sp.closed ? 'Z' : '')
      out.push(`<path d="${d}"/>`)
    }
  }
  return out
}

// --- per-case ---------------------------------------------------------------
interface Analysis {
  img: ImageData
  doc: EditableDoc
  geom: GeomScore & { diagnostics: { gtPoints: DistPoint[]; docPoints: DistPoint[] } }
  regions: RegionScore
  gtPolys: string[]
  docPolys: string[]
}

async function analyze(c: TruthCase, res: number): Promise<Analysis | { blocked: string }> {
  // Corpus paths outside public/ (examples/nebula.svg, examples/petals.svg) are served by
  // Vite's project-root fallback in DEV but are not copied into a production build — so say
  // so rather than rendering a blank box.
  const resp = await fetch(truthUrl(c))
  if (!resp.ok) {
    return { blocked: `source not served (HTTP ${resp.status} for ${truthUrl(c)}) — files outside public/ are dev-only` }
  }
  const svgText = await resp.text()
  const gt = parseGroundTruth(svgText)
  const why = unscorable(gt)
  if (why) return { blocked: why }

  const img = await getImageData(truthUrl(c), res, svgText)
  const doc = await traceImage(img, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar', gradients: c.gradients })

  const shapes = toRasterSpace(gt, img.width)
  const geom = scoreGeometry(shapes, doc, img.width, img.height)
  const regions = scoreRegions(img, doc)

  const docSubPaths: SubPath[][] = doc.items.flatMap((i) => (i.kind === 'path' ? [i.subPaths] : []))
  return { img, doc, geom, regions, gtPolys: polysOf(shapes.map((s) => s.subPaths)), docPolys: polysOf(docSubPaths) }
}

const cell = (label: string, note: string, inner: string): string =>
  `<div class="cell"><div class="label"><b>${label}</b><span>${note}</span></div><div class="box">${inner}</div></div>`

function gatesTable(c: TruthCase, geom: GeomScore, regions: RegionScore): string {
  const flatArt = !c.gradients
  const rows = evaluateTruthGates({
    samples: geom.samples, chamfer: geom.chamfer, p95: geom.p95, parsimony: geom.parsimony,
    trueRegions: regions.trueRegions, recovered: regions.recovered, flatArt,
  })
  const body = rows.map((g) => {
    if (!g.applicable) {
      const why = g.key === 'regions'
        ? 'gradient art — flat-region count is a quantisation artifact, not a region count'
        : 'no interior boundary to compare (the art\'s whole outline is the canvas border)'
      return `<tr class="na">
        <td class="k">${g.label}</td><td class="rule">${g.rule}</td>
        <td class="num v">n/a</td>
        <td class="barcell"><div class="bar zero"><span>nothing to measure</span></div></td>
        <td class="num head na">n/a</td>
      </tr><tr class="nawhy"><td colspan="5">${why}</td></tr>`
    }
    const cls = !g.pass ? 'fail' : g.headroom < 0.25 ? 'tight' : g.headroom < 0.5 ? 'warn' : 'ok'
    const pctLeft = clamp(g.headroom, 0, 1) * 100
    const shown = g.key === 'regions'
      ? `${regions.recovered}/${regions.trueRegions}`
      : g.value.toFixed(g.digits) + (g.key === 'parsimony' ? '×' : 'px')
    return `<tr class="${cls}">
      <td class="k">${g.label}</td>
      <td class="rule">${g.rule}${g.key === 'parsimony' ? '×' : g.key === 'regions' ? '' : 'px'}</td>
      <td class="num v">${shown}</td>
      <td class="barcell"><div class="bar"><i class="${cls}" style="width:${pctLeft.toFixed(0)}%"></i></div></td>
      <td class="num head">${g.pass ? `${pctLeft.toFixed(0)}% left` : 'FAIL'}</td>
    </tr>`
  }).join('')

  const swatch = (hex: string): string =>
    `<code style="background:${hex};color:#fff;text-shadow:0 0 2px #000;padding:1px 5px;border-radius:3px">${hex}</code>`
  const drops = flatArt
    ? regions.missing.map((m) =>
        `<div>✗ the art has ${swatch(m.hex)} (${m.areaPx}px) — the trace paints
         ${m.paintedHex === '—' ? '<b>nothing</b>' : swatch(m.paintedHex)} there instead, ΔE ${m.deltaE.toFixed(1)}</div>`).join('')
    : ''

  return `<div class="panel">
    <table class="gates"><thead><tr><th>gate</th><th>limit</th><th class="num">value</th><th>headroom</th><th class="num"></th></tr></thead><tbody>${body}</tbody></table>
    ${drops ? `<div class="warnbox">${drops}</div>` : ''}
    <div class="ungated">
      authored ${geom.gtShapes} shapes / ${geom.gtNodes} nodes · traced ${geom.docPaths} paths / ${geom.docNodes} nodes ·
      boundary ${geom.gtLength.toFixed(0)}px vs ${geom.docLength.toFixed(0)}px ·
      missed ${geom.missedMean.toFixed(2)}px (max ${geom.missedMax.toFixed(1)}) ·
      invented ${geom.spuriousMean.toFixed(2)}px (max ${geom.spuriousMax.toFixed(1)}) ·
      hausdorff ${geom.hausdorff.toFixed(1)}px
      <br><span class="dim">Shape and path counts need not match: compositing splits one authored shape into several
      visible regions, and regions sharing a fill merge into one path. That is why the gates score boundary geometry
      and region recovery, not counts.</span>
    </div>
  </div>`
}

async function render(): Promise<void> {
  out.innerHTML = ''
  const res = state.res
  let done = 0

  for (const c of TRUTH_CORPUS) {
    const row = document.createElement('section')
    row.className = 'row'
    row.innerHTML = `<h2>${c.name} <span class="dim">${c.note}</span></h2><div class="cells">…</div>`
    out.append(row)

    status.textContent = `Tracing ${c.name} @ ${res}px … (${++done}/${TRUTH_CORPUS.length})`
    await new Promise((r) => setTimeout(r, 0))

    const a = await analyze(c, res)

    if ('blocked' in a) {
      row.querySelector('.cells')!.remove()
      row.insertAdjacentHTML('beforeend',
        `<div class="warnbox"><b>Not scorable — no valid ground truth.</b> ${a.blocked}.
         <br>The tracer is not at fault here; the CASE cannot currently be scored. Re-author it with filled shapes
         (see <code>src/devtest/genEdgeCases.ts</code>) to bring it into the gate.</div>`)
      continue
    }

    const { img, doc, geom, regions, gtPolys, docPolys } = a
    const side = img.width
    const flatArt = !c.gradients
    const gates = evaluateTruthGates({
      samples: geom.samples, chamfer: geom.chamfer, p95: geom.p95, parsimony: geom.parsimony,
      trueRegions: regions.trueRegions, recovered: regions.recovered, flatArt,
    })
    const failing = gates.filter((g) => g.applicable && !g.pass)
    if (failing.length) {
      row.querySelector('h2')!.insertAdjacentHTML('beforeend', ` <span class="badge fail">${failing.map((g) => g.label).join(', ')}</span>`)
    }

    const cells = [
      cell('truth', 'the authored SVG — the answer sheet', `<img src="${truthUrl(c)}" style="width:100%;height:100%;object-fit:contain"/>`),
      cell('raster input', `what the tracer is handed @ ${side}px`, `<img src="${rgbaToUrl(img.data, img.width, img.height)}" style="width:100%;height:100%"/>`),
      cell('current trace', `${geom.docPaths} paths · ${geom.docNodes} nodes`, serializeDoc(doc).replace('<svg', '<svg data-cam data-side="' + side + '"')),
      cell('boundary overlay', 'green = authored · magenta = traced', overlaySvg(gtPolys, docPolys, side)),
    ]
    // Boundary heat is meaningless when there was no interior boundary to sample (bg-ramp).
    if (geom.samples > 0) {
      cells.push(
        cell('miss heat', `authored boundary, hot = tracer MISSED it (0→${state.heat}px)`, heatSvg(geom.diagnostics.gtPoints, side, state.heat)),
        cell('invented heat', `traced boundary, hot = tracer INVENTED it (0→${state.heat}px)`, heatSvg(geom.diagnostics.docPoints, side, state.heat)),
      )
    }
    // Region recovery is flat-art-only — on a gradient the "regions" are quantisation bands.
    if (flatArt) {
      cells.push(cell('dropped regions', `${regions.recovered}/${regions.trueRegions} recovered · red = region the art has and the trace does not`,
        `<img src="${dropOverlay(img, regions.dropMask)}" style="width:100%;height:100%"/>`))
    }
    row.querySelector('.cells')!.innerHTML = cells.join('')

    row.insertAdjacentHTML('beforeend', gatesTable(c, geom, regions))
    for (const b of row.querySelectorAll<HTMLElement>('.box')) attachCam(b)
    applyCam()
  }

  status.textContent = `${TRUTH_CORPUS.length} cases @ ${res}px. Nothing here reads or writes trace-baseline.json — every number is measured against the authored SVG.`
}

// --- controls ---------------------------------------------------------------
const sizeEl = $<HTMLInputElement>('size')
const resEl = $<HTMLSelectElement>('res')
const heatEl = $<HTMLSelectElement>('heat')

sizeEl.value = String(state.box)
document.documentElement.style.setProperty('--box', `${state.box}px`)
sizeEl.addEventListener('input', () => {
  state.box = Number(sizeEl.value)
  document.documentElement.style.setProperty('--box', `${state.box}px`)
  save()
})

resEl.innerHTML = TRUTH_RESOLUTIONS.map((r) => `<option value="${r}"${r === state.res ? ' selected' : ''}>${r}px</option>`).join('')
resEl.addEventListener('change', () => { state.res = Number(resEl.value); save(); void render() })

heatEl.innerHTML = HEAT_SCALES.map((s) => `<option value="${s}"${s === state.heat ? ' selected' : ''}>0 → ${s}px</option>`).join('')
heatEl.addEventListener('change', () => { state.heat = Number(heatEl.value); save(); void render() })

const aboutEl = $<HTMLDetailsElement>('about')
aboutEl.open = state.about
aboutEl.addEventListener('toggle', () => { state.about = aboutEl.open; save() })

$('reset').addEventListener('click', () => { state.cam = { ...DEFAULT_STATE.cam }; applyCam() })

void render()
