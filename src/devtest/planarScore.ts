// TEMP: compare the planar engine vs crisp on the PNG corpus + the shield.
import { ensureImageData, loadPng } from './nodeHarness.ts'
import type { DecodedImage } from './png.ts'
import { traceImage, DEFAULT_VECTORIZE_OPTIONS } from '../lib/trace/index.ts'
import { scoreDoc } from './scoreboard.ts'
import { hashDoc } from './metrics.ts'

ensureImageData()
function downscale(img: DecodedImage, maxDim: number): DecodedImage {
  const { width: w, height: h, data } = img
  const scale = Math.min(1, maxDim / Math.max(w, h))
  if (scale >= 1) return img
  const nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale))
  const out = new Uint8ClampedArray(nw * nh * 4)
  for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
    const sx0 = Math.floor((x / nw) * w), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) / nw) * w))
    const sy0 = Math.floor((y / nh) * h), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) / nh) * h))
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (let sy = sy0; sy < sy1; sy++) for (let sx = sx0; sx < sx1; sx++) {
      const o = (sy * w + sx) * 4
      r += data[o]; g += data[o + 1]; b += data[o + 2]; a += data[o + 3]; n++
    }
    const o = (y * nw + x) * 4
    out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n
  }
  return { width: nw, height: nh, data: out }
}

const cases: { name: string; img: DecodedImage }[] = [
  { name: 'nebula', img: loadPng('public/examples/nebula.png') },
  { name: 'petals', img: loadPng('public/examples/petals.png') },
  { name: 'shield', img: downscale(loadPng('examples/generated_image.png'), 512) },
]

for (const { name, img } of cases) {
  const src = img as unknown as { width: number; height: number; data: Uint8ClampedArray }
  for (const engine of ['crisp', 'planar'] as const) {
    const doc = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true })
    const doc2 = await traceImage(img as unknown as ImageData, { ...DEFAULT_VECTORIZE_OPTIONS, engine, gradients: true })
    const s = scoreDoc(src, doc)
    const det = hashDoc(doc) === hashDoc(doc2) ? 'det✓' : 'det✗'
    console.log(
      `${name.padEnd(7)} ${engine.padEnd(6)} meanDE ${s.meanDeltaE.toFixed(2)} SSIM ${s.ssim.toFixed(4)} ` +
      `seamMax ${s.seamMax.toFixed(1).padStart(5)} seamP995 ${s.seamP995.toFixed(1).padStart(5)} paths ${String(s.paths).padStart(3)} nodes ${String(s.nodes).padStart(4)} ${det}`,
    )
  }
}
