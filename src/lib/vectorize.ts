// Raster → SVG vectorization, wrapping imagetracerjs.
//
// Pure, synchronous helpers used by the Vectorize panel. The tracer is a
// classic global-style module exposing `imagedataToSVG(imageData, options)`.

import ImageTracer from 'imagetracerjs'
import type { VectorizeOptions } from '../types'

export const DEFAULT_VECTORIZE_OPTIONS: VectorizeOptions = {
  mode: 'color',
  colors: 12,
  simplify: 30,
  threshold: 128,
  removeBackground: false,
  forceColor: null,
}

/** A safe, minimal SVG returned when the tracer throws. */
const EMPTY_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>'

/** Clamp helper. */
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Map the user-facing 0–100 "simplify" dial onto imagetracer's error
 * thresholds and path-omit noise floor.
 *  - simplify 0   → very faithful (low ltres/qtres, keep tiny paths)
 *  - simplify 100 → coarse (high ltres/qtres, drop short paths)
 */
function simplifyToTracerParams(simplify: number): {
  ltres: number
  qtres: number
  pathomit: number
} {
  const t = clamp(simplify, 0, 100) / 100
  // 0.01 (faithful) → ~4 (coarse), eased so the low end stays detailed.
  const res = 0.01 + Math.pow(t, 1.4) * (4 - 0.01)
  const pathomit = Math.round(t * 20)
  return { ltres: res, qtres: res, pathomit }
}

/**
 * Vectorize an ImageData to SVG markup. Synchronous & pure: the input
 * ImageData is never mutated (mono mode clones before thresholding).
 */
export function vectorizeImageData(imageData: ImageData, opts: VectorizeOptions): string {
  const { ltres, qtres, pathomit } = simplifyToTracerParams(opts.simplify)

  const source = opts.mode === 'mono' ? thresholdImageData(imageData, opts.threshold) : imageData

  const tracerOptions = {
    numberofcolors: opts.mode === 'mono' ? 2 : clamp(Math.round(opts.colors), 2, 64),
    ltres,
    qtres,
    pathomit,
    roundcoords: 1,
    blurradius: 0,
    colorsampling: 2,
    rightangleenhance: true,
    // Emit a viewBox (not width/height) so downstream cleanup stays resolution-independent.
    viewbox: true,
  }

  try {
    const svg = (ImageTracer as { imagedataToSVG: (d: ImageData, o: unknown) => string }).imagedataToSVG(
      source,
      tracerOptions,
    )
    return typeof svg === 'string' && svg.includes('<svg') ? svg : EMPTY_SVG
  } catch {
    return EMPTY_SVG
  }
}

/**
 * Produce a thresholded black-on-transparent copy of ImageData for mono
 * tracing. Luminance uses Rec.709 weights. Nearly-transparent source pixels
 * (alpha < ~16) stay transparent; remaining pixels become opaque black when
 * darker than `threshold`, transparent otherwise. The input is not mutated.
 */
function thresholdImageData(imageData: ImageData, threshold: number): ImageData {
  const { width, height, data } = imageData
  const out = new ImageData(width, height)
  const dst = out.data
  const cut = clamp(Math.round(threshold), 0, 255)

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3]
    if (a < 16) {
      // Leave fully transparent (ImageData is zero-initialized already).
      continue
    }
    const lum = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    if (lum < cut) {
      dst[i] = 0
      dst[i + 1] = 0
      dst[i + 2] = 0
      dst[i + 3] = 255
    }
    // lighter pixels remain transparent (already zeroed)
  }

  return out
}
