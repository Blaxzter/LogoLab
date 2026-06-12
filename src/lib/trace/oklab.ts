// Oklab colour space (Björn Ottosson, 2020) for perceptually-uniform distances.
//
// The mending decisions (does one gradient fit these regions? is this band the
// same paint as that ramp?) used raw-RGB Euclidean distance, whose meaning swings
// wildly across hues — a fixed RGB tolerance is lax in dark blues and harsh in
// greens. Oklab ΔE (plain Euclidean here) is roughly perceptually uniform, so one
// tolerance behaves consistently. Pure, deterministic, ~30 lines.

export type Oklab = [number, number, number]

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** sRGB (channels 0–255) → Oklab. White → ~[1,0,0], black → [0,0,0]. */
export function srgbToOklab(r: number, g: number, b: number): Oklab {
  const lr = srgbToLinear(r / 255)
  const lg = srgbToLinear(g / 255)
  const lb = srgbToLinear(b / 255)

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb

  const l_ = Math.cbrt(l)
  const m_ = Math.cbrt(m)
  const s_ = Math.cbrt(s)

  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

/** Euclidean ΔE in Oklab (≈ perceptual difference; ~1.0 ≈ black↔white). */
export function oklabDeltaE(a: Oklab, b: Oklab): number {
  const dl = a[0] - b[0]
  const da = a[1] - b[1]
  const db = a[2] - b[2]
  return Math.sqrt(dl * dl + da * da + db * db)
}

/** ΔE between two sRGB triples (0–255), measured in Oklab. */
export function srgbDeltaEOk(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  return oklabDeltaE(srgbToOklab(r1, g1, b1), srgbToOklab(r2, g2, b2))
}
