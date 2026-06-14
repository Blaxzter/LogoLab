// CIELAB (D65) + CIE76 ΔE for the structure-first segmenter.
//
// The blueprint paper specifies its colour-difference segmentation and AA-merge
// thresholds (τ_s = 10) in CIELAB, so the segmenter measures colour distance in
// CIELAB to match. (The paint-model FIT quality stays in Oklab — see oklab.ts —
// matching V1's selection thresholds; the two spaces serve different stages.)
// Pure, deterministic, no DOM — runs under `node --test`.

export type Lab = [number, number, number]

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const Xn = 0.95047
const Yn = 1.0
const Zn = 1.08883
const DELTA = 6 / 29
const DELTA3 = DELTA * DELTA * DELTA
const labF = (t: number): number => (t > DELTA3 ? Math.cbrt(t) : t / (3 * DELTA * DELTA) + 4 / 29)

/** sRGB (channels 0–255) → CIELAB (D65). White → ~[100,0,0], black → [0,0,0]. */
export function srgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r / 255)
  const gl = srgbToLinear(g / 255)
  const bl = srgbToLinear(b / 255)
  const X = 0.4124 * rl + 0.3576 * gl + 0.1805 * bl
  const Y = 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
  const Z = 0.0193 * rl + 0.1192 * gl + 0.9505 * bl
  const fx = labF(X / Xn)
  const fy = labF(Y / Yn)
  const fz = labF(Z / Zn)
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

/** CIE76 ΔE: Euclidean distance in CIELAB. */
export function deltaE76(a: Lab, b: Lab): number {
  const dl = a[0] - b[0]
  const da = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dl * dl + da * da + db * db)
}
