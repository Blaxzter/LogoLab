// Dev-only visual harness for the raster→vector pipeline. Served by Vite at
// /vectorize-test.html. Runs the real trace engine (potrace WASM + canvas) on
// the bundled example PNGs, side-by-side with the Affinity-traced reference, so
// gradient fidelity and line cleanliness can be eyeballed (and screenshotted).
//
// Not part of the app bundle — it's only reachable via its own HTML entry.

import { getImageData } from '../lib/image'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace'
import { docStats, serializeDoc } from '../lib/path/model'
import type { EditableDoc } from '../lib/path/types'

const MAX_DIM = 512

interface Case {
  name: string
  png: string
  reference: string
}

const CASES: Case[] = [
  { name: 'Nebula', png: '/examples/nebula.png', reference: '/examples/nebula.affinity.svg' },
  { name: 'Petals', png: '/examples/petals.png', reference: '/examples/petals.affinity.svg' },
]

const out = document.getElementById('out') as HTMLElement
const status = document.getElementById('status') as HTMLElement

function gradientCount(doc: EditableDoc): number {
  let n = 0
  for (const it of doc.items) if (it.kind === 'path' && it.gradient) n++
  return n
}

function box(inner: string): string {
  return `<div class="box">${inner}</div>`
}

function statLine(doc: EditableDoc, bytes: number): string {
  const s = docStats(doc)
  const g = gradientCount(doc)
  const grad = g > 0 ? ` · <span class="grad">${g} gradient${g === 1 ? '' : 's'}</span>` : ''
  return `<div class="stats">${s.paths} paths · ${s.nodes} nodes · ${s.colors} colors · ${(bytes / 1024).toFixed(1)} KB${grad}</div>`
}

async function runCase(c: Case): Promise<void> {
  status.textContent = `Tracing ${c.name}…`
  const imageData = await getImageData(c.png, MAX_DIM)

  const t0 = performance.now()
  const crisp = await traceImage(imageData, { ...DEFAULT_VECTORIZE_OPTIONS, gradients: true, engine: 'crisp' })
  const t1 = performance.now()
  const potrace = await traceImage(imageData, { ...DEFAULT_VECTORIZE_OPTIONS, gradients: true, engine: 'potrace' })
  const t2 = performance.now()

  const svgCrisp = serializeDoc(crisp, 2)
  const svgPotrace = serializeDoc(potrace, 2)
  const refSvg = await (await fetch(c.reference)).text()

  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML = `
    <h2>${c.name}</h2>
    <div class="cells">
      <div class="cell">
        <div class="label"><b>Original PNG</b><span>${imageData.width}×${imageData.height}</span></div>
        ${box(`<img src="${c.png}" alt="" />`)}
      </div>
      <div class="cell">
        <div class="label"><b>Crisp + gradients</b><span>${(t1 - t0).toFixed(0)} ms</span></div>
        ${box(svgCrisp)}
        ${statLine(crisp, new TextEncoder().encode(svgCrisp).length)}
      </div>
      <div class="cell">
        <div class="label"><b>potrace + gradients</b><span>${(t2 - t1).toFixed(0)} ms</span></div>
        ${box(svgPotrace)}
        ${statLine(potrace, new TextEncoder().encode(svgPotrace).length)}
      </div>
      <div class="cell">
        <div class="label"><b>Affinity reference</b><span>flat</span></div>
        ${box(refSvg)}
      </div>
    </div>`
  out.appendChild(row)

  console.log(`[${c.name}] crisp: ${crisp.items.length} paths, ${gradientCount(crisp)} grad`)
  console.log(`[${c.name}] crisp SVG:\n${svgCrisp}`)
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
