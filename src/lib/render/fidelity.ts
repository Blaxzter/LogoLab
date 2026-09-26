// How far a render is from the image it was traced from, as numbers and as a
// per-pixel heat, both derived from one ΔE field.
//
// Metrics: mean L1 in CIELAB and SSIM (the pair used by the reference paper),
// P95 ΔE, and a seam score (max ΔE on traced boundaries in smooth source areas,
// which catches cracks and patch seams a mean averages away).
//
// This is the single implementation for both the studio's ΔE readout and the
// benchmark harness (src/devtest/metrics.ts re-exports it). Don't give the app
// its own copy of the ΔE math: the studio uses `deltaEField` + `deltaEStats`,
// the harness layers SSIM and seams on the same field.
//
// Pure (no DOM or Node APIs): runs in the scoring worker, the labs and tests.

import { srgbToLab } from '../trace/lab.ts'
import { heatColor, HEAT_BG_RGB } from '../heat.ts'

export interface FidelityMetrics {
  /** Mean over pixels of |ΔL|+|Δa|+|Δb| in CIELAB units. */
  l1Lab: number
  /** Mean CIE76 ΔE over pixels. */
  meanDeltaE: number
  /** 95th-percentile CIE76 ΔE over pixels. */
  p95DeltaE: number
  /** Mean SSIM (11×11 Gaussian windows) over the luma images. */
  ssim: number
  /**
   * Seam score: max CIE76 ΔE over boundary pixels that are not a correctly
   * reproduced edge. Real edges are excluded so their unavoidable sub-pixel AA
   * error does not count; what remains are cracks and mismatched gradient
   * patches.
   */
  seamMax: number
  /** 99.5th-percentile of that smooth-field boundary ΔE (robust seam score). */
  seamP995: number
}

/** A pixel is an edge when its max neighbour ΔE reaches this; ramps stay below. */
const SMOOTH_GRAD = 8

/** Distance (px) within which a source edge and a render edge count as the same
 *  edge. Kept at 1 so only sub-pixel placement is forgiven. */
const EDGE_NEIGHBORHOOD = 1

/**
 * Per-pixel CIELAB difference between a render and its source; every fidelity
 * number and the Difference view derive from it.
 *
 * Pass the source with its alpha: both buffers are composited over white here.
 * Decoding the source onto another background, or scoring raw RGB, makes art on
 * transparency score as badly wrong.
 *
 * The Lab buffers are returned too because the seam metric reuses them.
 */
export interface DeltaEField {
  /** CIE76 ΔE per pixel, source vs render. */
  de: Float64Array
  /** Source in CIELAB, 3 floats per pixel (composited over white). */
  sourceLab: Float32Array
  /** Render in CIELAB, 3 floats per pixel (composited over white). */
  renderLab: Float32Array
  /** Mean over pixels of |ΔL|+|Δa|+|Δb|. */
  l1Lab: number
}

export function deltaEField(
  source: Uint8ClampedArray | Uint8Array,
  render: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): DeltaEField {
  const n = width * height
  const sOpaque = overWhite(source, n)
  const rOpaque = overWhite(render, n)

  const sourceLab = new Float32Array(n * 3)
  const renderLab = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const s = srgbToLab(sOpaque[o], sOpaque[o + 1], sOpaque[o + 2])
    const r = srgbToLab(rOpaque[o], rOpaque[o + 1], rOpaque[o + 2])
    sourceLab[i * 3] = s[0]
    sourceLab[i * 3 + 1] = s[1]
    sourceLab[i * 3 + 2] = s[2]
    renderLab[i * 3] = r[0]
    renderLab[i * 3 + 1] = r[1]
    renderLab[i * 3 + 2] = r[2]
  }

  let l1Sum = 0
  const de = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const k = i * 3
    const dl = sourceLab[k] - renderLab[k]
    const da = sourceLab[k + 1] - renderLab[k + 1]
    const db = sourceLab[k + 2] - renderLab[k + 2]
    de[i] = Math.sqrt(dl * dl + da * da + db * db)
    l1Sum += Math.abs(dl) + Math.abs(da) + Math.abs(db)
  }

  return { de, sourceLab, renderLab, l1Lab: l1Sum / n }
}

/** Mean and 95th percentile of a ΔE field — the two numbers the studio shows. */
export function deltaEStats(de: Float64Array): { meanDeltaE: number; p95DeltaE: number } {
  let sum = 0
  for (let i = 0; i < de.length; i++) sum += de[i]
  return {
    meanDeltaE: de.length ? sum / de.length : 0,
    p95DeltaE: percentile(de, 0.95),
  }
}

/**
 * ΔE at which the Difference heat reaches its hottest colour: about ten JNDs
 * (one CIE76 JND ≈ 2.3), where two colours are plainly different.
 */
export const HEAT_FULL_SCALE_DE = 25

/** Below this fraction of full scale a pixel is drawn as backdrop, so sub-JND
 *  noise does not tint the whole picture. */
export const HEAT_FLOOR = 0.02

/**
 * Paint a ΔE field as RGBA heat on the shared cold→hot ramp (lib/heat.ts), the
 * same ramp `/labs/ab` uses. The full scale is per view: the lab compares two
 * traces, this compares a trace against its source.
 */
export function deltaEHeat(de: Float64Array, fullScale = HEAT_FULL_SCALE_DE): Uint8ClampedArray {
  const out = new Uint8ClampedArray(de.length * 4)
  for (let i = 0; i < de.length; i++) {
    const o = i * 4
    const t = Math.min(1, de[i] / fullScale)
    if (t < HEAT_FLOOR) {
      out[o] = HEAT_BG_RGB[0]
      out[o + 1] = HEAT_BG_RGB[1]
      out[o + 2] = HEAT_BG_RGB[2]
      out[o + 3] = 255
      continue
    }
    const [r, g, b] = heatColor(t)
    out[o] = r
    out[o + 1] = g
    out[o + 2] = b
    out[o + 3] = 255
  }
  return out
}

/**
 * Compare a rendered RGBA buffer to the source RGBA buffer (same dimensions,
 * both opaque). `boundary` is the optional seam mask from raster.boundaryMask.
 */
export function fidelity(
  source: Uint8ClampedArray | Uint8Array,
  render: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  boundary?: Uint8Array,
): FidelityMetrics {
  const n = width * height
  const { de, sourceLab, renderLab, l1Lab } = deltaEField(source, render, width, height)

  // A boundary pixel is excluded only when both source and render have an edge
  // within 1px (the same edge, placed slightly differently). Cracks, patch seams
  // and overshoots have an edge in at most one image, so they still count.
  let seamMax = 0
  const seamVals: number[] = []
  if (boundary) {
    const sZone = dilate(edgeMask(sourceLab, width, height), width, height, EDGE_NEIGHBORHOOD)
    const rZone = dilate(edgeMask(renderLab, width, height), width, height, EDGE_NEIGHBORHOOD)
    for (let i = 0; i < n; i++) {
      if (!boundary[i] || (sZone[i] && rZone[i])) continue
      const d = de[i]
      if (d > seamMax) seamMax = d
      seamVals.push(d)
    }
  }

  const { meanDeltaE, p95DeltaE } = deltaEStats(de)
  return {
    l1Lab,
    meanDeltaE,
    p95DeltaE,
    ssim: meanSSIM(overWhite(source, n), overWhite(render, n), width, height),
    seamMax,
    seamP995: seamVals.length ? percentileArr(seamVals, 0.995) : 0,
  }
}

/** Grow a 0/1 mask by `radius` pixels (3×3 dilation, `radius` passes). */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  let cur = mask
  for (let pass = 0; pass < radius; pass++) {
    const next = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (!cur[y * width + x]) continue
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx
            const ny = y + dy
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) next[ny * width + nx] = 1
          }
        }
      }
    }
    cur = next
  }
  return cur
}

/** 0/1 mask of pixels whose local Lab gradient marks a true (high-contrast) edge. */
function edgeMask(lab: Float32Array, width: number, height: number): Uint8Array {
  const m = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (sourceGradient(lab, width, height, x, y) >= SMOOTH_GRAD) m[y * width + x] = 1
    }
  }
  return m
}

/** Max CIE76 ΔE between a pixel and its 4-neighbours in a Lab buffer (local gradient). */
function sourceGradient(lab: Float32Array, width: number, height: number, x: number, y: number): number {
  const k = (y * width + x) * 3
  let g = 0
  const probe = (nx: number, ny: number) => {
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) return
    const j = (ny * width + nx) * 3
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

/** Composite an RGBA buffer over opaque white, returning an opaque RGBA buffer. */
export function overWhite(px: Uint8ClampedArray | Uint8Array, n: number): Uint8ClampedArray {
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

function percentile(values: Float64Array, p: number): number {
  if (values.length === 0) return 0
  const sorted = Float64Array.from(values).sort()
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[idx]
}

function percentileArr(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))
  return sorted[idx]
}

// ---------------------------------------------------------------------------
// SSIM (Wang et al. 2004), Gaussian-windowed mean SSIM on luma
// ---------------------------------------------------------------------------

const SSIM_WIN = 11
const SSIM_SIGMA = 1.5
const C1 = (0.01 * 255) ** 2
const C2 = (0.03 * 255) ** 2

/** Rec.709 luma of an sRGB triple (0–255 in, 0–255 out). */
const luma709 = (r: number, g: number, b: number): number => 0.2126 * r + 0.7152 * g + 0.0722 * b

function meanSSIM(
  source: Uint8ClampedArray | Uint8Array,
  render: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): number {
  if (width < SSIM_WIN || height < SSIM_WIN) return 1 // too small to window; treat as match-or-not elsewhere
  const x = new Float64Array(width * height)
  const y = new Float64Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    x[i] = luma709(source[o], source[o + 1], source[o + 2])
    y[i] = luma709(render[o], render[o + 1], render[o + 2])
  }

  // Separable Gaussian weights.
  const half = (SSIM_WIN - 1) / 2
  const k = new Float64Array(SSIM_WIN)
  let ksum = 0
  for (let i = 0; i < SSIM_WIN; i++) {
    const d = i - half
    k[i] = Math.exp(-(d * d) / (2 * SSIM_SIGMA * SSIM_SIGMA))
    ksum += k[i]
  }
  for (let i = 0; i < SSIM_WIN; i++) k[i] /= ksum

  let ssimSum = 0
  let count = 0
  // Slide the full window over the valid (fully-covered) interior.
  for (let cy = half; cy < height - half; cy++) {
    for (let cx = half; cx < width - half; cx++) {
      let mx = 0
      let my = 0
      // First pass: weighted means.
      for (let wy = 0; wy < SSIM_WIN; wy++) {
        const row = (cy - half + wy) * width
        const kw = k[wy]
        for (let wx = 0; wx < SSIM_WIN; wx++) {
          const w = kw * k[wx]
          const idx = row + (cx - half + wx)
          mx += w * x[idx]
          my += w * y[idx]
        }
      }
      // Second pass: weighted (co)variances about the means.
      let vx = 0
      let vy = 0
      let vxy = 0
      for (let wy = 0; wy < SSIM_WIN; wy++) {
        const row = (cy - half + wy) * width
        const kw = k[wy]
        for (let wx = 0; wx < SSIM_WIN; wx++) {
          const w = kw * k[wx]
          const idx = row + (cx - half + wx)
          const dx = x[idx] - mx
          const dy = y[idx] - my
          vx += w * dx * dx
          vy += w * dy * dy
          vxy += w * dx * dy
        }
      }
      const s = ((2 * mx * my + C1) * (2 * vxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2))
      ssimSum += s
      count++
    }
  }
  return count ? ssimSum / count : 1
}
