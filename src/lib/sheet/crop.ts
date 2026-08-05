// Cutting tiles out of a sheet.
//
// Deliberately plain: a box in, pixels out. The interesting decisions (what the
// box IS) belong to detect.ts, and the interesting pixel work afterwards —
// knocking the paper colour out, tracing — already exists elsewhere in the app
// and is called on the result of this.

import type { ImageDataLike, Rect } from './types'

export interface CropFill {
  r: number
  g: number
  b: number
  a: number
}

/**
 * Copy `rect` out of `img`. The box may hang off the edge of the sheet — an icon
 * in the corner with a uniform box around it does exactly that — and the outside
 * is filled with `fill` (the sheet's own paper colour, normally) rather than
 * clipped, so every tile keeps the size it was given.
 */
export function cropTile(img: ImageDataLike, rect: Rect, fill: CropFill | null): ImageDataLike {
  const w = Math.max(1, Math.round(rect.w))
  const h = Math.max(1, Math.round(rect.h))
  const x0 = Math.round(rect.x)
  const y0 = Math.round(rect.y)
  const out = new Uint8ClampedArray(w * h * 4)

  if (fill && fill.a > 0) {
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = fill.r
      out[i * 4 + 1] = fill.g
      out[i * 4 + 2] = fill.b
      out[i * 4 + 3] = fill.a
    }
  }

  const sx0 = Math.max(0, x0)
  const sy0 = Math.max(0, y0)
  const sx1 = Math.min(img.width, x0 + w)
  const sy1 = Math.min(img.height, y0 + h)
  for (let y = sy0; y < sy1; y++) {
    let s = (y * img.width + sx0) * 4
    let d = ((y - y0) * w + (sx0 - x0)) * 4
    for (let x = sx0; x < sx1; x++) {
      out[d] = img.data[s]
      out[d + 1] = img.data[s + 1]
      out[d + 2] = img.data[s + 2]
      out[d + 3] = img.data[s + 3]
      s += 4
      d += 4
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * Box-average downscale to a long-side cap. The tracer is capped per image, and
 * a tile is normally far below the cap — this only bites on huge sheets, where
 * skipping it would hand the tracer a 2000px crop and the O(S²) merge that comes
 * with it. Never upscales (same contract as `getImageData`).
 */
export function downscaleImageData(img: ImageDataLike, maxDim: number): ImageDataLike {
  const long = Math.max(img.width, img.height)
  if (long <= maxDim || maxDim <= 0) return img
  const scale = maxDim / long
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * img.height) / h)
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * img.height) / h))
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * img.width) / w)
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * img.width) / w))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * img.width + sx) * 4
          const al = img.data[i + 3]
          // Premultiply, so a transparent pixel's stale RGB can't bleed in.
          r += img.data[i] * al
          g += img.data[i + 1] * al
          b += img.data[i + 2] * al
          a += al
          n++
        }
      }
      const o = (y * w + x) * 4
      if (a > 0) {
        out[o] = r / a
        out[o + 1] = g / a
        out[o + 2] = b / a
      }
      out[o + 3] = a / Math.max(1, n)
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * Bilinear upscale by an integer factor.
 *
 * This adds no information — but it does recover some. A sheet icon is ~170px and
 * its anti-aliased edges encode SUB-pixel coverage; the tracer works on a pixel
 * lattice, so a finer lattice places each contour more precisely. Measured over 54
 * real tiles (see `traceScale`): the traced ink area drifts from the source's by
 * 0.75pp at 1× and 0.13pp at 3×, SSIM 0.864 → 0.946, with no tile left visibly
 * wrong — at 2.5× the trace time and +57% nodes.
 */
export function upscaleImageData(img: ImageDataLike, scale: number): ImageDataLike {
  const k = Math.max(1, Math.round(scale))
  if (k === 1) return img
  const w = img.width * k
  const h = img.height * k
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, (y + 0.5) / k - 0.5))
    const y0 = Math.floor(sy)
    const y1 = Math.min(img.height - 1, y0 + 1)
    const fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, (x + 0.5) / k - 0.5))
      const x0 = Math.floor(sx)
      const x1 = Math.min(img.width - 1, x0 + 1)
      const fx = sx - x0
      const o = (y * w + x) * 4
      const i00 = (y0 * img.width + x0) * 4
      const i01 = (y0 * img.width + x1) * 4
      const i10 = (y1 * img.width + x0) * 4
      const i11 = (y1 * img.width + x1) * 4
      for (let c = 0; c < 4; c++) {
        const a = img.data[i00 + c] * (1 - fx) + img.data[i01 + c] * fx
        const b = img.data[i10 + c] * (1 - fx) + img.data[i11 + c] * fx
        out[o + c] = a * (1 - fy) + b * fy
      }
    }
  }
  return { width: w, height: h, data: out }
}

/**
 * Bridge to the browser's `ImageData` (the tracer, canvas and cleanup all speak
 * it). Copies, so the result owns a plain ArrayBuffer and can be transferred to a
 * worker without taking the caller's pixels with it. Browser-only by virtue of
 * being CALLED there — the Node test harness never reaches this.
 */
export function toImageData(img: ImageDataLike): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
}

/** `icon-01`, `icon-02`, … — sheet tiles arrive nameless. */
export function defaultTileName(index: number, base?: string | null): string {
  const stem = (base ?? '').trim() || 'icon'
  return `${stem}-${String(index + 1).padStart(2, '0')}`
}

/** Strip the extension off an uploaded file name, for use as a tile-name stem. */
export function nameStem(fileName: string | null | undefined): string {
  if (!fileName) return 'icon'
  const stem = fileName.replace(/\.[^.]+$/, '').trim()
  // Model-generated names ("Gemini_Generated_Image_50d4ai50d4ai50d4") make awful
  // file names; keep them short and slug-safe, and cut on a word boundary rather
  // than mid-token ("…-image", not "…-image-5").
  const words = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter(Boolean)
  let slug = ''
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word
    if (next.length > 24) break
    slug = next
  }
  return slug || words[0]?.slice(0, 24) || 'icon'
}
