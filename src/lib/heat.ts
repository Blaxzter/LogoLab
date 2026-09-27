/**
 * The cold→hot ramp every error view paints with: the studio's Difference view
 * and the labs' diff heat share it, so don't add a second set of stops.
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
export const HEAT_BG_RGB: [number, number, number] = [10, 12, 22]

/** The same colour as CSS, for panels that style a backdrop rather than write pixels. */
export const HEAT_BG = `#${HEAT_BG_RGB.map((c) => c.toString(16).padStart(2, '0')).join('')}`
