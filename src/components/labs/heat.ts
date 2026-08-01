/**
 * The one cold→hot ramp the labs share. `goldenView` (ΔE per pixel) and `truthView`
 * (boundary distance per sample) had a copy each, with the same stops — so the two
 * pages already read alike, they just couldn't prove it. One module now.
 *
 * `t` is a 0..1 normalized error; the caller picks the full-scale.
 */
const STOPS: [number, number, number][] = [
  [10, 12, 34],
  [40, 60, 180],
  [30, 160, 170],
  [120, 200, 80],
  [250, 220, 60],
  [240, 120, 30],
  [200, 20, 20],
]

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Ramp colour as an RGB triple (0–255, un-rounded — callers writing pixels round). */
export function heatColor(t: number): [number, number, number] {
  const u = clamp01(t) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(u))
  const k = u - i
  const a = STOPS[i]
  const b = STOPS[i + 1]
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** Ramp colour as a CSS `rgb(...)` string. */
export function heatCss(t: number): string {
  const [r, g, b] = heatColor(t)
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
}

/** The near-black the heat/overlay panels sit on, so faint dots stay visible. */
export const HEAT_BG = '#0a0c16'
