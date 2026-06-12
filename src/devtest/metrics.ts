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
import { srgbToLab, luma709 } from './color.ts'

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
   * Seam score: max render-vs-source CIE76 ΔE over boundary pixels that lie in a
   * SMOOTH part of the source (low local source gradient). A genuine high-contrast
   * edge has a high source gradient and is excluded — so its unavoidable ~1px AA
   * placement error does not count. What remains are cracks (page bleeding through
   * a smooth field) and mismatched gradient patches (a rendered discontinuity where
   * the source is continuous) — exactly the artifacts mean error averages away.
   */
  seamMax: number
  /** 99.5th-percentile of that smooth-field boundary ΔE (robust seam score). */
  seamP995: number
}

/** Source is "smooth" at a pixel when its max neighbour ΔE is below this — a
 *  true edge sits well above it, a ramp well below. */
const SMOOTH_GRAD = 8

/** Neighbourhood (px) within which a source edge and a render edge are treated as
 *  the SAME edge — i.e. the tracer reproduced it, give or take sub-pixel
 *  placement. Kept to 1px so the exclusion forgives only unavoidable placement,
 *  never a real artifact sitting near an edge. */
const EDGE_NEIGHBORHOOD = 1

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
  // Composite both images over the SAME opaque white background before any
  // comparison. The render is already opaque-over-white; the source may carry
  // alpha (e.g. white line-art on transparency), and scoring its raw RGB would
  // treat transparent pixels as black and wildly inflate the error.
  const sOpaque = overWhite(source, n)
  const rOpaque = overWhite(render, n)

  // Pack both images to Lab once (also used for the source-smoothness map).
  const sLab = new Float32Array(n * 3)
  const rLab = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const s = srgbToLab(sOpaque[o], sOpaque[o + 1], sOpaque[o + 2])
    const r = srgbToLab(rOpaque[o], rOpaque[o + 1], rOpaque[o + 2])
    sLab[i * 3] = s[0]
    sLab[i * 3 + 1] = s[1]
    sLab[i * 3 + 2] = s[2]
    rLab[i * 3] = r[0]
    rLab[i * 3 + 1] = r[1]
    rLab[i * 3 + 2] = r[2]
  }

  let l1Sum = 0
  let deSum = 0
  const de = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const k = i * 3
    const dl = sLab[k] - rLab[k]
    const da = sLab[k + 1] - rLab[k + 1]
    const db = sLab[k + 2] - rLab[k + 2]
    de[i] = Math.sqrt(dl * dl + da * da + db * db)
    deSum += de[i]
    l1Sum += Math.abs(dl) + Math.abs(da) + Math.abs(db)
  }

  // Seam score over boundary pixels that are NOT a correctly-reproduced edge.
  // A genuine high-contrast edge is excluded ONLY where both the source AND the
  // render have an edge within 1px — meaning the tracer placed the same edge, and
  // the residual is unavoidable sub-pixel placement, not an artifact. A crack
  // (page through a smooth field), a mismatched gradient patch, or a boundary
  // OVERSHOOT into a smooth region has an edge in one image but not the other (or
  // neither), so it is kept. This is what stops the exclusion from hiding the very
  // artifacts the seam metric exists to catch when they sit near an edge.
  let seamMax = 0
  const seamVals: number[] = []
  if (boundary) {
    const sZone = dilate(edgeMask(sLab, width, height), width, height, EDGE_NEIGHBORHOOD)
    const rZone = dilate(edgeMask(rLab, width, height), width, height, EDGE_NEIGHBORHOOD)
    for (let i = 0; i < n; i++) {
      if (!boundary[i] || (sZone[i] && rZone[i])) continue
      const d = de[i]
      if (d > seamMax) seamMax = d
      seamVals.push(d)
    }
  }

  return {
    l1Lab: l1Sum / n,
    meanDeltaE: deSum / n,
    p95DeltaE: percentile(de, 0.95),
    ssim: meanSSIM(sOpaque, rOpaque, width, height),
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
function overWhite(px: Uint8ClampedArray | Uint8Array, n: number): Uint8ClampedArray {
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
