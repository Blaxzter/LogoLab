// TEMP (Phase 6 verification): planar engine WITH edge-level beautify
// (fidelity 1.5, default) vs WITHOUT (fidelity 0) on the corpus + a synthetic
// geometric logo. Beautify should cut node counts on geometric shapes without
// raising seamMax / meanΔE beyond the fidelity budget.
import { ensureImageData, loadPng } from './nodeHarness.ts'
import type { DecodedImage } from './png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { scoreDoc } from './scoreboard.ts'
import { hashDoc } from './metrics.ts'

ensureImageData()

/** A geometric logo: outer ring (annulus) + inner disc + a square — exactly the
 *  shapes edge-beautify should collapse to clean circles / straight edges. */
function geometric(w = 128, h = 128): DecodedImage {
  const data = new Uint8ClampedArray(w * h * 4)
  const cx = w / 2, cy = h / 2
  const put = (i: number, r: number, g: number, b: number) => {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    const d = Math.hypot(x - cx, y - cy)
    // background
    put(i, 245, 245, 245)
    // square band in a corner
    if (x > 12 && x < 44 && y > 12 && y < 44) put(i, 30, 120, 200)
    // outer ring
    if (d < 52 && d > 38) put(i, 220, 60, 60)
    // inner disc
    if (d < 26) put(i, 250, 200, 40)
  }
  return { width: w, height: h, data }
}

const cases: { name: string; img: DecodedImage }[] = [
  { name: 'nebula', img: loadPng('public/examples/nebula.png') },
  { name: 'petals', img: loadPng('public/examples/petals.png') },
  { name: 'geom', img: geometric() },
]

console.log('image    fidelity  meanDE   SSIM   seamMax  seamP995  paths  nodes   det')
for (const { name, img } of cases) {
  const src = img as unknown as { width: number; height: number; data: Uint8ClampedArray }
  for (const fidelity of [0, DEFAULT_VECTORIZE_OPTIONS.fidelity ?? 1.5]) {
    const opts = { ...DEFAULT_VECTORIZE_OPTIONS, engine: 'planar' as const, gradients: true, fidelity }
    const doc = await traceImage(img as unknown as ImageData, opts)
    const doc2 = await traceImage(img as unknown as ImageData, opts)
    const s = scoreDoc(src, doc)
    const det = hashDoc(doc) === hashDoc(doc2) ? 'det✓' : 'det✗'
    console.log(
      `${name.padEnd(8)} ${String(fidelity).padEnd(8)} ${s.meanDeltaE.toFixed(2).padStart(6)} ${s.ssim.toFixed(4)} ` +
      `${s.seamMax.toFixed(1).padStart(7)} ${s.seamP995.toFixed(1).padStart(8)} ${String(s.paths).padStart(5)} ${String(s.nodes).padStart(6)}   ${det}`,
    )
  }
}
