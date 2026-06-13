// Dev measurement for V6 translucent layer decomposition (plan §9). Traces bloom
// (a true translucent source) and petals.png WITH overlap regions present (markers
// + Region detail), comparing the opaque-band output against the translucent
// decomposition through the harness rasterizer.  Run:  node src/devtest/measureV6.ts

import { ensureImageData, loadPng } from './nodeHarness.ts'
import { SYNTHETIC_CORPUS, syntheticSource } from './lineArtCorpus.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { scoreDoc } from './scoreboard.ts'
import type { VectorizeOptions } from '../types'

ensureImageData()
type Img = { width: number; height: number; data: Uint8ClampedArray }

async function measure(name: string, src: Img, markers: { x: number; y: number }[], regionDetail: number) {
  const opts: VectorizeOptions = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'crisp', gradients: true, markers, regionDetail }
  const opaqueDoc = await traceImage(src as unknown as ImageData, { ...opts, layeredDecomposition: false })
  const transDoc = await traceImage(src as unknown as ImageData, { ...opts, layeredDecomposition: true })
  const so = scoreDoc(src, opaqueDoc)
  const st = scoreDoc(src, transDoc)
  const fired = st.paths !== so.paths || st.nodes !== so.nodes
  console.log(`\n===== ${name} (${markers.length} markers, regionDetail=${regionDetail}) — decomposition ${fired ? 'FIRED' : 'no-op'} =====`)
  const row = (tag: string, r: typeof so) =>
    console.log(`  ${tag}: meanΔE=${r.meanDeltaE.toFixed(2)} P95=${r.p95DeltaE.toFixed(1)} SSIM=${r.ssim.toFixed(4)} seamMax=${r.seamMax.toFixed(1)} seamP995=${r.seamP995.toFixed(1)} paths=${r.paths} nodes=${r.nodes} grad=${r.gradients}`)
  row('opaque     ', so)
  row('translucent', st)
  if (fired) for (const it of transDoc.items) if (it.kind === 'path') console.log(`     ${it.id} fill=${it.fill} op=${(it.fillOpacity ?? 1).toFixed(3)} nodes=${it.subPaths.reduce((a, s) => a + s.nodes.length, 0)}`)
}

const W = 512
const bloom = syntheticSource(SYNTHETIC_CORPUS.find((c) => c.name === 'bloom')!)
// 3 circles, no triple region (the disks share no common point): 3 exclusive +
// 3 pairwise overlaps. Markers placed at each region centre; Region detail raised
// so the ~10–13 ΔE overlap colours separate from the circles instead of fusing.
const bloomMarkers = [
  { x: 256 / W, y: 90 / W }, { x: 110 / W, y: 350 / W }, { x: 402 / W, y: 350 / W },
  { x: 211 / W, y: 251 / W }, { x: 301 / W, y: 251 / W }, { x: 256 / W, y: 330 / W },
]
await measure('bloom', bloom, bloomMarkers, 95)
await measure('bloom', bloom, bloomMarkers, 0) // partial overlaps ⇒ gate should fall back

const petals = loadPng('public/examples/petals.png') as unknown as Img
const petalMarkers = [
  { x: 263 / W, y: 140 / W }, { x: 360 / W, y: 300 / W }, { x: 150 / W, y: 330 / W },
  { x: 256 / W, y: 250 / W }, { x: 230 / W, y: 250 / W }, { x: 290 / W, y: 300 / W }, { x: 256 / W, y: 285 / W },
]
await measure('petals', petals, petalMarkers, 0)
await measure('petals', petals, petalMarkers, 85)
