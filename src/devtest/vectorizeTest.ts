// Dev-only evaluation harness, browser side. Served by Vite at
// /labs/vectorize-test.html. Runs the real trace engine (potrace WASM + crisp) on the
// corpus and turns the old eyeball viewer into a SCOREBOARD: it renders the
// traced doc to pixels with the pure rasterizer and reports the plan §5 metrics
// (L1 CIELAB, SSIM, P95 ΔE, seam score, path/node/gradient counts, runtime,
// determinism) for BOTH engines, alongside the visual previews.
//
// The same pure scoreboard code runs under `node --test` (test/harness.test.ts)
// for the crisp engine; potrace needs the browser (WASM + DOMParser), so its
// numbers come from here. Dump the JSON from the console to record a baseline.
//
// Not part of the app bundle — only reachable via its own HTML entry.

import { getImageData } from '../lib/image'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace'
import { serializeDoc } from '../lib/path/model'
import type { EditableDoc } from '../lib/path/types'
import { score, type ScoreRow, type SourceImage } from './scoreboard.ts'

const MAX_DIM = 512
const ENGINES: ('crisp' | 'potrace')[] = ['potrace', 'crisp']

interface Case {
  name: string
  /** 'png' = raster source; 'svg' = hand-made ground-truth rasterized at MAX_DIM. */
  kind: 'png' | 'svg'
  src: string
  /** Optional visual reference (e.g. Affinity export) shown in the strip. */
  reference?: string
}

const CASES: Case[] = [
  { name: 'nebula', kind: 'png', src: '/examples/nebula.png', reference: '/examples/nebula.affinity.svg' },
  { name: 'petals', kind: 'png', src: '/examples/petals.png', reference: '/examples/petals.affinity.svg' },
  { name: 'aurora', kind: 'svg', src: '/examples/aurora.svg' },
  { name: 'orbit', kind: 'svg', src: '/examples/orbit.svg' },
  { name: 'outline', kind: 'svg', src: '/examples/outline.svg' },
  { name: 'summit', kind: 'svg', src: '/examples/summit.svg' },
  { name: 'bloom', kind: 'svg', src: '/examples/bloom.svg' },
]

const out = document.getElementById('out') as HTMLElement
const status = document.getElementById('status') as HTMLElement
const board = document.getElementById('board') as HTMLElement

async function sourceFor(c: Case): Promise<{ image: ImageData; refSvg?: string }> {
  if (c.kind === 'svg') {
    const svgText = await (await fetch(c.src)).text()
    return { image: await getImageData(c.src, MAX_DIM, svgText) }
  }
  const image = await getImageData(c.src, MAX_DIM)
  const refSvg = c.reference ? await (await fetch(c.reference)).text() : undefined
  return { image, refSvg }
}

function box(inner: string): string {
  return `<div class="box">${inner}</div>`
}

async function runCase(c: Case): Promise<ScoreRow[]> {
  status.textContent = `Tracing ${c.name}…`
  const { image, refSvg } = await sourceFor(c)
  const source: SourceImage = image

  const rows: ScoreRow[] = []
  const svgs: Record<string, string> = {}
  for (const engine of ENGINES) {
    const row = await score(c.name, engine, source, () =>
      traceImage(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true }),
    )
    rows.push(row)
    // Re-trace once for the visual preview (cheap; keeps score() pure of DOM).
    const doc = await traceImage(image, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true })
    svgs[engine] = serializeDoc(doc, 2)
  }

  const row = document.createElement('div')
  row.className = 'row'
  const cells: string[] = [
    `<div class="cell"><div class="label"><b>Source ${c.kind}</b><span>${image.width}×${image.height}</span></div>${box(
      c.kind === 'svg' ? `<img src="${c.src}" alt="" />` : `<img src="${c.src}" alt="" />`,
    )}</div>`,
  ]
  for (const engine of ENGINES) {
    const r = rows.find((x) => x.engine === engine)!
    cells.push(
      `<div class="cell"><div class="label"><b>${engine}</b><span>${r.runtimeMs.toFixed(0)} ms</span></div>${box(svgs[engine])}` +
        `<div class="stats">${r.paths}p · ${r.nodes}n · ${r.gradients}g · ΔE ${r.meanDeltaE.toFixed(2)} · SSIM ${r.ssim.toFixed(3)} · seam ${r.seamMax.toFixed(0)} · ${r.determinism}</div></div>`,
    )
  }
  if (refSvg) cells.push(`<div class="cell"><div class="label"><b>reference</b><span>flat</span></div>${box(refSvg)}</div>`)

  row.innerHTML = `<h2>${c.name}</h2><div class="cells">${cells.join('')}</div>`
  out.appendChild(row)
  return rows
}

function renderBoard(rows: ScoreRow[]): void {
  const head =
    '<tr><th>image</th><th>engine</th><th>L1 Lab</th><th>meanΔE</th><th>P95 ΔE</th><th>SSIM</th>' +
    '<th>seam max</th><th>seam P99.5</th><th>paths</th><th>nodes</th><th>grad</th><th>ms</th><th>det</th></tr>'
  const body = rows
    .map(
      (r) =>
        `<tr><td>${r.name}</td><td>${r.engine}</td><td>${r.l1Lab.toFixed(2)}</td><td>${r.meanDeltaE.toFixed(2)}</td>` +
        `<td>${r.p95DeltaE.toFixed(1)}</td><td>${r.ssim.toFixed(4)}</td><td>${r.seamMax.toFixed(1)}</td>` +
        `<td>${r.seamP995.toFixed(1)}</td><td>${r.paths}</td><td>${r.nodes}</td><td>${r.gradients}</td>` +
        `<td>${r.runtimeMs.toFixed(0)}</td><td class="${r.determinism}">${r.determinism}</td></tr>`,
    )
    .join('')
  board.innerHTML = `<table>${head}${body}</table>`
}

async function main(): Promise<void> {
  const all: ScoreRow[] = []
  for (const c of CASES) {
    try {
      all.push(...(await runCase(c)))
      renderBoard(all)
    } catch (err) {
      const div = document.createElement('div')
      div.className = 'row'
      div.innerHTML = `<h2>${c.name}</h2><p style="color:#c0392b">Failed: ${String(err)}</p>`
      out.appendChild(div)
      console.error(c.name, err)
    }
  }
  status.textContent = 'Done.'
  // Machine-readable dump for recording potrace/crisp baselines.
  console.log('SCOREBOARD_JSON ' + JSON.stringify(all))
}

void main()
