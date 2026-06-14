// Pure visualizations of the structure-first pipeline's intermediate stages, as
// RGBA buffers (no DOM). Shared by the dev scoreboard (src/devtest/vectorizeDebug)
// and the user-facing "How it works" explainer (components/vectorize), so both
// render the same pictures. Each function returns a Uint8ClampedArray of
// width*height*4 a caller can drop into an ImageData / canvas.

import type { MumfordShahResult } from './mumfordShah'

/** Mumford–Shah smoothed channels → opaque RGBA (transparent where not opaque). */
export function smoothedToRgba(ms: MumfordShahResult): Uint8ClampedArray {
  const { width, height, r, g, b, opaque } = ms
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    if (!opaque[i]) continue // leave transparent
    out[o] = Math.round(r[i] * 255)
    out[o + 1] = Math.round(g[i] * 255)
    out[o + 2] = Math.round(b[i] * 255)
    out[o + 3] = 255
  }
  return out
}

/** Discontinuity map 𝒟 → dark edges on a light field (opaque RGBA). */
export function discontinuityToRgba(ms: MumfordShahResult): Uint8ClampedArray {
  const { width, height, discontinuity } = ms
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    const v = discontinuity[i] ? 30 : 245
    out[o] = v
    out[o + 1] = v
    out[o + 2] = v
    out[o + 3] = 255
  }
  return out
}

/** Deterministic vivid colour per region index (golden-ratio hue spin). */
export function labelColor(label: number): [number, number, number] {
  const h = (label * 0.61803398875) % 1
  const s = 0.6
  const v = 0.95
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  const [rr, gg, bb] = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ][i % 6]
  return [Math.round(rr * 255), Math.round(gg * 255), Math.round(bb * 255)]
}

/** Segmentation labels → one vivid hue per macro-region (transparent where < 0). */
export function segmentsToRgba(labels: Int32Array, width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const l = labels[i]
    if (l < 0) continue
    const o = i * 4
    const [r, g, b] = labelColor(l)
    out[o] = r
    out[o + 1] = g
    out[o + 2] = b
    out[o + 3] = 255
  }
  return out
}

/** Segmentation labels → each region painted its actual fitted fill colour. */
export function regionFillsToRgba(
  labels: Int32Array,
  palette: { r: number; g: number; b: number }[],
  width: number,
  height: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    const l = labels[i]
    if (l < 0 || l >= palette.length) continue
    const o = i * 4
    out[o] = palette[l].r
    out[o + 1] = palette[l].g
    out[o + 2] = palette[l].b
    out[o + 3] = 255
  }
  return out
}
