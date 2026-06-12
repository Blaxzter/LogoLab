// Fidelity + usefulness metrics for the vectorization scoreboard (plan §5).
//
// Fidelity (render vs source): average L1 in CIELAB and SSIM — the blueprint
// paper's exact pair, so our numbers read against its Tables 1–2 — plus P95 ΔE
// and a boundary-normal seam score (max ΔE on traced edges, which surfaces the
// hairline cracks and patch seams a mean-error metric averages away).
//
// Usefulness: path / node / gradient counts. Determinism: a canonical hash of
// the doc, so a byte-identical re-run can be asserted.
//
// All pure: no DOM, no Node APIs. serializeDoc/docStats are themselves pure
// string work, so they run here under `node --test` unchanged.

import type { EditableDoc, GradientFill } from '../lib/path/types.ts'
import { serializeDoc, docStats } from '../lib/path/model.ts'
import { srgbToLab, deltaE76, l1Lab, luma709, type Lab } from './color.ts'

export interface FidelityMetrics {
  /** Mean over pixels of |ΔL|+|Δa|+|Δb| in CIELAB units. */
  l1Lab: number
  /** Mean CIE76 ΔE over pixels. */
  meanDeltaE: number
  /** 95th-percentile CIE76 ΔE over pixels. */
  p95DeltaE: number
  /** Mean SSIM (11×11 Gaussian windows) over the luma images. */
  ssim: number
  /** Max CIE76 ΔE over pixels on/near a traced boundary (seam/crack detector). */
  seamMax: number
  /** 99.5th-percentile ΔE over boundary pixels (robust seam score). */
  seamP995: number
}

export interface UsefulnessMetrics {
  paths: number
  nodes: number
  gradients: number
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
  let l1Sum = 0
  let deSum = 0
  const de = new Float64Array(n)
  let seamMax = 0
  const seamVals: number[] = []

  for (let i = 0; i < n; i++) {
    const o = i * 4
    const s: Lab = srgbToLab(source[o], source[o + 1], source[o + 2])
    const r: Lab = srgbToLab(render[o], render[o + 1], render[o + 2])
    const d = deltaE76(s, r)
    de[i] = d
    deSum += d
    l1Sum += l1Lab(s, r)
    if (boundary && boundary[i]) {
      if (d > seamMax) seamMax = d
      seamVals.push(d)
    }
  }

  return {
    l1Lab: l1Sum / n,
    meanDeltaE: deSum / n,
    p95DeltaE: percentile(de, 0.95),
    ssim: meanSSIM(source, render, width, height),
    seamMax,
    seamP995: seamVals.length ? percentileArr(seamVals, 0.995) : 0,
  }
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

// ---------------------------------------------------------------------------
// Usefulness + determinism
// ---------------------------------------------------------------------------

/** Path / node counts (via docStats) plus distinct gradient paint-server count. */
export function usefulness(doc: EditableDoc): UsefulnessMetrics {
  const s = docStats(doc)
  const grads = new Set<GradientFill>()
  for (const item of doc.items) {
    if (item.kind === 'path' && item.visible && item.gradient) grads.add(item.gradient)
  }
  return { paths: s.paths, nodes: s.nodes, gradients: grads.size }
}

/** Canonical, high-precision serialization used for the determinism check. */
export function canonicalDoc(doc: EditableDoc): string {
  return serializeDoc(doc, 6)
}

/** FNV-1a hash of the canonical doc string (compact determinism fingerprint). */
export function hashDoc(doc: EditableDoc): string {
  const str = canonicalDoc(doc)
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
