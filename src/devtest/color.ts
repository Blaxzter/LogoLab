// Color science for the vectorization evaluation harness (§5 of the plan).
//
// sRGB → CIELAB (D65) and CIE76 ΔE, plus Rec.709 luma for SSIM. Pure math, no
// DOM, no Node APIs — it runs identically in the browser harness and under
// `node --test`, so the metric numbers from either side are comparable.
//
// CIELAB (not Oklab) is used here on purpose: the blueprint paper reports its
// fidelity in average L1(CIELAB) + SSIM (its Tables 1–2), so measuring in the
// same space lets our scoreboard be read against its published bar. The
// pipeline's *fitting* color space (Oklab) is a separate concern handled inside
// src/lib/trace during V1.

/** A CIELAB color as [L (0–100), a, b]. */
export type Lab = [number, number, number]

// sRGB → linear-light. Input/output in [0, 1].
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

// D65 reference white in the same XYZ scale the matrix below produces (Y = 1).
const Xn = 0.95047
const Yn = 1.0
const Zn = 1.08883

// CIE Lab f(t): cube root above the linear-segment cutoff, linear below.
const DELTA = 6 / 29
const DELTA3 = DELTA * DELTA * DELTA
const labF = (t: number): number =>
  t > DELTA3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29

/**
 * Convert one sRGB color (channels 0–255) to CIELAB under a D65 white point.
 * White → ~[100, 0, 0], black → [0, 0, 0].
 */
export function srgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r / 255)
  const gl = srgbToLinear(g / 255)
  const bl = srgbToLinear(b / 255)

  // sRGB (D65) → CIE XYZ.
  const X = 0.4124 * rl + 0.3576 * gl + 0.1805 * bl
  const Y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
  const Z = 0.0193 * rl + 0.1192 * gl + 0.9505 * bl

  const fx = labF(X / Xn)
  const fy = labF(Y / Yn)
  const fz = labF(Z / Zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 colour difference: plain Euclidean distance in CIELAB. */
export function deltaE76(a: Lab, b: Lab): number {
  const dl = a[0] - b[0]
  const da = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dl * dl + da * da + db * db)
}

/** Sum of absolute Lab channel differences (the paper's "L1 in CIELAB"). */
export function l1Lab(a: Lab, b: Lab): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])
}

/** Rec.709 luma of an sRGB triple (0–255 in, 0–255 out). Used by SSIM. */
export function luma709(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Convert a flat RGBA buffer to a packed CIELAB buffer (3 floats per pixel).
 * Alpha is ignored — callers composite over a known background first so that
 * both images being compared are fully opaque.
 */
export function rgbaToLab(data: Uint8ClampedArray | Uint8Array): Float32Array {
  const n = data.length / 4
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    const lab = srgbToLab(data[o], data[o + 1], data[o + 2])
    out[i * 3] = lab[0]
    out[i * 3 + 1] = lab[1]
    out[i * 3 + 2] = lab[2]
  }
  return out
}
