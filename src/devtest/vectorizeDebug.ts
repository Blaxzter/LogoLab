// Dev-only pipeline DEBUG view. Served by Vite at /labs/vectorize-debug.html.
//
// Where vectorize-test.html scores the FINAL output, this page exposes the
// INTERMEDIATE stages of the structure-first pipeline so you can see WHY a trace
// looks the way it does — e.g. that 3 translucent overlapping circles collapse to
// a handful of opaque macro-regions (the overlap blends merged away), which is why
// the overlaps don't render. For each corpus image it shows, left to right:
//
//   source → Mumford–Shah smoothed → discontinuity map 𝒟 → segmentation (regions,
//   false-coloured + the actual region fills) → per-region paint models → the
//   final crisp & potrace traces.
//
// Not part of the app bundle — its own HTML entry, dev only.

import { getImageData } from '../lib/image'
import type { MumfordShahResult } from '../lib/trace/mumfordShah'
import { segmentImage, DEFAULT_SEGMENT_OPTIONS } from '../lib/trace/segment'
import { fitPaintLadder } from '../lib/trace/gradient'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace'
import { serializeDoc } from '../lib/path/model'
import { smoothedToRgba, discontinuityToRgba, segmentsToRgba, regionFillsToRgba } from '../lib/trace/stageViz'

const MAX_DIM = 512

interface Case {
  name: string
  kind: 'png' | 'svg'
  src: string
}

const CASES: Case[] = [
  { name: 'petals', kind: 'png', src: '/examples/petals.png' },
  { name: 'nebula', kind: 'png', src: '/examples/nebula.png' },
  { name: 'bloom', kind: 'svg', src: '/examples/bloom.svg' },
  { name: 'aurora', kind: 'svg', src: '/examples/aurora.svg' },
  { name: 'orbit', kind: 'svg', src: '/examples/orbit.svg' },
  { name: 'outline', kind: 'svg', src: '/examples/outline.svg' },
  { name: 'summit', kind: 'svg', src: '/examples/summit.svg' },
]

const out = document.getElementById('out') as HTMLElement
const status = document.getElementById('status') as HTMLElement

async function sourceFor(c: Case): Promise<ImageData> {
  if (c.kind === 'svg') {
    const svgText = await (await fetch(c.src)).text()
    return getImageData(c.src, MAX_DIM, svgText)
  }
  return getImageData(c.src, MAX_DIM)
}

/** A fresh canvas of the given size filled with an RGBA buffer. */
function canvasOf(width: number, height: number, rgba: Uint8ClampedArray): HTMLCanvasElement {
  const cv = document.createElement('canvas')
  cv.width = width
  cv.height = height
  const ctx = cv.getContext('2d')!
  const id = ctx.createImageData(width, height)
  id.data.set(rgba)
  ctx.putImageData(id, 0, 0)
  return cv
}

const smoothedCanvas = (ms: MumfordShahResult) => canvasOf(ms.width, ms.height, smoothedToRgba(ms))
const discontinuityCanvas = (ms: MumfordShahResult) => canvasOf(ms.width, ms.height, discontinuityToRgba(ms))
const segmentsCanvas = (labels: Int32Array, w: number, h: number) => canvasOf(w, h, segmentsToRgba(labels, w, h))
const regionFillCanvas = (labels: Int32Array, palette: { r: number; g: number; b: number }[], w: number, h: number) =>
  canvasOf(w, h, regionFillsToRgba(labels, palette, w, h))

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

function cell(label: string, sub: string, node: Node): HTMLElement {
  const div = document.createElement('div')
  div.className = 'cell'
  const cap = document.createElement('div')
  cap.className = 'label'
  cap.innerHTML = `<b>${label}</b><span>${sub}</span>`
  const box = document.createElement('div')
  box.className = 'box'
  box.appendChild(node)
  div.append(cap, box)
  return div
}

function svgCell(label: string, sub: string, svg: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.innerHTML = svg
  return cell(label, sub, wrap.firstElementChild ?? wrap)
}

async function runCase(c: Case): Promise<void> {
  status.textContent = `Analysing ${c.name}…`
  const image = await sourceFor(c)
  const w = image.width
  const h = image.height
  const rgba = image as unknown as { width: number; height: number; data: Uint8ClampedArray }

  // Stage 1 — segmentation into macro-regions (it carries the Mumford–Shah
  // smoothing + discontinuity map by-products in `seg.ms`).
  const seg = segmentImage(rgba, DEFAULT_SEGMENT_OPTIONS)
  const ms = seg.ms
  // Stage 2 — paint-model ladder per region.
  const paints = seg.regionSamples.map((s) => fitPaintLadder(s))
  // Stage 3–4 — final traces.
  const crisp = serializeDoc(await traceImage(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true }), 2)
  const potrace = serializeDoc(await traceImage(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'potrace', gradients: true }), 2)

  const row = document.createElement('div')
  row.className = 'row'
  const head = document.createElement('h2')
  head.textContent = `${c.name} · ${w}×${h} · ${seg.palette.length} regions (S₀ ${seg.fineSegments} before merge)`
  row.appendChild(head)

  const cells = document.createElement('div')
  cells.className = 'cells'

  const srcImg = document.createElement('img')
  srcImg.src = c.src
  cells.append(
    cell('1 · source', c.kind, srcImg),
    cell('2 · MS smoothed', 'denoised u', smoothedCanvas(ms)),
    cell('3 · discontinuity 𝒟', 'edge by-product', discontinuityCanvas(ms)),
    cell('4 · regions (false)', `${seg.palette.length} macro`, segmentsCanvas(seg.labels, w, h)),
    cell('4 · region fills', 'actual colours', regionFillCanvas(seg.labels, seg.palette, w, h)),
  )

  // Stage-2 paint-model summary: a swatch + model + residual per region.
  const paintWrap = document.createElement('div')
  paintWrap.className = 'paints'
  paints.forEach((p, label) => {
    const sw = document.createElement('div')
    sw.className = 'paint'
    const [r, g, b] = p.solid
    sw.innerHTML =
      `<span class="chip" style="background:${hex(r, g, b)}"></span>` +
      `<span class="m m-${p.model}">${p.model}</span>` +
      `<span class="px">px ${(seg.counts[label] ?? 0).toLocaleString()}</span>` +
      `<span class="res">res ${p.residualOklab.toFixed(3)}</span>`
    paintWrap.appendChild(sw)
  })
  cells.appendChild(cell('5 · paint models', `${paints.length}`, paintWrap))

  cells.append(
    svgCell('6 · crisp', 'final', crisp),
    svgCell('6 · potrace', 'final', potrace),
  )

  row.appendChild(cells)
  out.appendChild(row)
}

async function main(): Promise<void> {
  for (const c of CASES) {
    try {
      await runCase(c)
    } catch (err) {
      const div = document.createElement('div')
      div.className = 'row'
      div.innerHTML = `<h2>${c.name}</h2><p style="color:#c0392b">Failed: ${String(err)}</p>`
      out.appendChild(div)
      console.error(c.name, err)
    }
  }
  status.textContent = 'Done.'
}

void main()
