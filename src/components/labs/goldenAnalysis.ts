// The pixel maths behind the Golden-corpus lab's error maps.
//
// The GATED numbers come from scoreDoc() — the SAME function the Node gate's recordCase()
// calls — so the value the lab shows IS the value CI asserts. Nothing here recomputes a
// gated metric.
//
// The ΔE map and the seam overlay, though, have no public function to borrow: metrics.ts
// keeps its seam internals private. They are reproduced here, mirroring fidelity()'s rule
// exactly — SMOOTH_GRAD 8, a 1px edge neighbourhood — and were verified to reproduce its
// seamMax to the last decimal. They are pictures OF the gate, not a second opinion on it.

import { getImageData } from '../../lib/image'
import { labTrace } from './labTrace'
import type { EditableDoc } from '../../lib/path/types'
import { rasterizeDoc, boundaryMask } from '../../lib/render/raster'
import { scoreDoc } from '../../devtest/scoreboard'
import { hashDoc } from '../../devtest/metrics'
import { srgbToLab } from '../../devtest/color'
import {
  downscale,
  geomSignature,
  evaluateGates,
  type GoldenCase,
  type GoldenRecord,
  type GateRow,
  type RgbaImage,
} from '../../devtest/traceCorpus'
import { rgbaToUrl } from './raster'

/** Source gradient below this ⇒ the pixel sits in a SMOOTH field. Mirrors metrics.ts. */
const SMOOTH_GRAD = 8
/** Radius within which a source edge and a render edge count as the SAME edge. */
const EDGE_NEIGHBORHOOD = 1

function overWhite(px: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const a = px[o + 3] / 255
    out[o] = px[o] * a + 255 * (1 - a)
    out[o + 1] = px[o + 1] * a + 255 * (1 - a)
    out[o + 2] = px[o + 2] * a + 255 * (1 - a)
    out[o + 3] = 255
  }
  return out
}

function toLab(px: Uint8ClampedArray, n: number): Float32Array {
  const lab = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const c = srgbToLab(px[o], px[o + 1], px[o + 2])
    lab[i * 3] = c[0]
    lab[i * 3 + 1] = c[1]
    lab[i * 3 + 2] = c[2]
  }
  return lab
}

function localGradient(lab: Float32Array, w: number, h: number, x: number, y: number): number {
  const k = (y * w + x) * 3
  let g = 0
  const probe = (nx: number, ny: number): void => {
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return
    const j = (ny * w + nx) * 3
    const dl = lab[k] - lab[j]
    const da = lab[k + 1] - lab[j + 1]
    const db = lab[k + 2] - lab[j + 2]
    const d = Math.sqrt(dl * dl + da * da + db * db)
    if (d > g) g = d
  }
  probe(x - 1, y)
  probe(x + 1, y)
  probe(x, y - 1)
  probe(x, y + 1)
  return g
}

function edgeMask(lab: Float32Array, w: number, h: number): Uint8Array {
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (localGradient(lab, w, h, x, y) >= SMOOTH_GRAD) m[y * w + x] = 1
  return m
}

function dilate(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  let cur = mask
  for (let p = 0; p < radius; p++) {
    const next = new Uint8Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!cur[y * w + x]) continue
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) next[ny * w + nx] = 1
          }
      }
    cur = next
  }
  return cur
}

export interface GoldenAnalysis {
  width: number
  height: number
  doc: EditableDoc
  score: ReturnType<typeof scoreDoc>
  gates: GateRow[]
  hash: string
  geomSig: string
  /** Per-pixel CIE76 ΔE, source vs render (both composited over white). */
  de: Float32Array
  /** 1 where the seam metric actually counts the pixel. */
  seam: Uint8Array
  seamCount: number
  /** Worst seam pixel — the one that IS the seamMax the gate asserts. */
  seamArgmax: { x: number; y: number; de: number } | null
  /** Worst seam pixel ignoring a 1px image border. Reveals when seamMax is pinned by a
   *  border artifact rather than a real interior seam. NOT a gate. */
  interiorSeamMax: number
  interiorArgmax: { x: number; y: number } | null
  /** Luma of the render, for the seam map's near-white ghost. */
  ghost: Uint8Array
  /** The rasterizeDoc render — exactly what the metrics score. */
  renderUrl: string
  traceMs: number
}

/** Trace one golden case and measure it. `url` is where the case's pixels come from. */
export async function analyzeGolden(c: GoldenCase, g: GoldenRecord, url: string): Promise<GoldenAnalysis> {
  // Load at NATIVE resolution, then apply the corpus's own box-downscale — the same two
  // steps loadCase() performs in Node. Going through getImageData's canvas resampling
  // instead would feed the tracer different pixels than the gate sees.
  const native = await getImageData(url, 1e9)
  const img: RgbaImage = c.maxDim > 0 ? downscale(native, c.maxDim) : native
  const w = img.width
  const h = img.height
  const n = w * h

  // Includes worker spin-up, so it reads a little higher than the old main-thread timing.
  // It's a diagnostic, not a gated number — the gates score the document, not the clock.
  const t0 = performance.now()
  const doc = await labTrace(img as unknown as ImageData, c.options)
  const traceMs = performance.now() - t0

  const score = scoreDoc(img, doc)
  const gates = evaluateGates(g, score)
  const render = rasterizeDoc(doc, w, h)

  const sO = overWhite(img.data, n)
  const rO = overWhite(render, n)
  const sLab = toLab(sO, n)
  const rLab = toLab(rO, n)
  const de = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const k = i * 3
    const dl = sLab[k] - rLab[k]
    const da = sLab[k + 1] - rLab[k + 1]
    const db = sLab[k + 2] - rLab[k + 2]
    de[i] = Math.sqrt(dl * dl + da * da + db * db)
  }

  const bmask = boundaryMask(doc, w, h, 1)
  const sZone = dilate(edgeMask(sLab, w, h), w, h, EDGE_NEIGHBORHOOD)
  const rZone = dilate(edgeMask(rLab, w, h), w, h, EDGE_NEIGHBORHOOD)
  const seam = new Uint8Array(n)
  let seamCount = 0
  let seamArgmax: GoldenAnalysis['seamArgmax'] = null
  let interiorSeamMax = 0
  let interiorArgmax: GoldenAnalysis['interiorArgmax'] = null
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!bmask[i] || (sZone[i] && rZone[i])) continue
      seam[i] = 1
      seamCount++
      if (!seamArgmax || de[i] > seamArgmax.de) seamArgmax = { x, y, de: de[i] }
      const onBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1
      if (!onBorder && de[i] > interiorSeamMax) {
        interiorSeamMax = de[i]
        interiorArgmax = { x, y }
      }
    }

  const ghost = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const l = 0.2126 * rO[o] + 0.7152 * rO[o + 1] + 0.0722 * rO[o + 2]
    ghost[i] = 235 - (235 - l) * 0.12 // near-white ghost of the render
  }

  return {
    width: w,
    height: h,
    doc,
    score,
    gates,
    hash: hashDoc(doc),
    geomSig: geomSignature(doc),
    de,
    seam,
    seamCount,
    seamArgmax,
    interiorSeamMax,
    interiorArgmax,
    ghost,
    renderUrl: rgbaToUrl(rO, w, h),
    traceMs,
  }
}
