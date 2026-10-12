// What an export has to know about the logo's PIXELS before it fills anything:
// which colour an opaque icon should be filled with when the caller named none,
// and whether the art has see-through holes that will show whatever is behind it.
//
// Both read a small render of the logo (alpha included), never the source file,
// so an SVG and a raster answer the same way.

import { hasOpaqueBorder } from '../lib/path/paper.ts'

interface Pixels {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

/** Where the fill of the opaque icons came from — reported, so the caller can override it. */
export type OpaqueSource = 'chosen' | 'background' | 'logo' | 'contrast'

export interface OpaquePick {
  color: string
  source: OpaqueSource
}

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

/** WCAG relative luminance of an sRGB colour (0–255 channels). */
function luminance(r: number, g: number, b: number): number {
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

const contrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * The fill for an opaque icon when the caller named none.
 *
 * A logo on its own opaque ground (border ring and all four corners) already says what goes behind it: the per-channel
 * median of that border ring (median, as the paper rule: anti-aliasing pulls a mean).
 * A logo on transparency does not, and its own dominant colour is the one choice that
 * is certainly wrong (the mark would vanish into it) — so it gets white or black,
 * whichever stands further off the ink's average luminance.
 */
export function pickOpaqueBackground(img: Pixels): OpaquePick {
  const { width, height, data } = img
  // A ground fills the corners too. A full-bleed ROUNDED tile reaches every edge
  // but not the corners, and is the mark itself: filling with it erases the mark.
  const cornersOpaque = [0, width - 1, (height - 1) * width, height * width - 1].every((p) => data[p * 4 + 3] >= 128)
  if (cornersOpaque && hasOpaqueBorder(img as { width: number; height: number; data: Uint8ClampedArray })) {
    const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
    let n = 0
    const visit = (x: number, y: number) => {
      const i = (y * width + x) * 4
      if (data[i + 3] < 128) return
      h[0][data[i]]++
      h[1][data[i + 1]]++
      h[2][data[i + 2]]++
      n++
    }
    for (let x = 0; x < width; x++) {
      visit(x, 0)
      visit(x, height - 1)
    }
    for (let y = 1; y < height - 1; y++) {
      visit(0, y)
      visit(width - 1, y)
    }
    const median = (c: Uint32Array) => {
      let acc = 0
      for (let v = 0; v < 256; v++) if ((acc += c[v]) * 2 >= n) return v
      return 255
    }
    return { color: hex(median(h[0]), median(h[1]), median(h[2])), source: 'logo' }
  }

  // Alpha-weighted mean luminance of the ink.
  let sum = 0
  let weight = 0
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255
    if (a <= 0) continue
    sum += a * luminance(data[i], data[i + 1], data[i + 2])
    weight += a
  }
  const ink = weight > 0 ? sum / weight : 0
  return contrast(ink, 1) >= contrast(ink, 0)
    ? { color: '#ffffff', source: 'contrast' }
    : { color: '#000000', source: 'contrast' }
}

/** One enclosed transparent area, in fractions of the image (0–1). */
export interface SeeThroughArea {
  x: number
  y: number
  width: number
  height: number
  /** Share of the whole image's area. */
  area: number
}

/**
 * Transparent areas the art ENCLOSES: alpha under 128, not reachable from the image
 * border. A window in a calendar, the inside of a badge exported without its fill —
 * on a light preview they read as white, on a dark taskbar as a black hole. A ring's
 * or a letter's counter is one too, on purpose; the caller can only report, not judge.
 * Areas under `minArea` of the image (anti-aliasing gaps between strokes) are skipped.
 */
export function seeThroughAreas(img: Pixels, minArea = 0.005): SeeThroughArea[] {
  const { width: w, height: h, data } = img
  const n = w * h
  // 0 = ink, 1 = clear, 2 = clear and reached (from the border, or already grouped).
  const state = new Uint8Array(n)
  for (let i = 0; i < n; i++) state[i] = data[i * 4 + 3] < 128 ? 1 : 0

  const stack: number[] = []
  const reach = (q: number) => {
    if (state[q] !== 1) return
    state[q] = 2
    stack.push(q)
  }
  const flood = (seed: number, onPixel?: (p: number) => void) => {
    reach(seed)
    while (stack.length) {
      const p = stack.pop() as number
      onPixel?.(p)
      const x = p % w
      const y = (p - x) / w
      if (x > 0) reach(p - 1)
      if (x < w - 1) reach(p + 1)
      if (y > 0) reach(p - w)
      if (y < h - 1) reach(p + w)
    }
  }

  for (let x = 0; x < w; x++) {
    if (state[x] === 1) flood(x)
    if (state[(h - 1) * w + x] === 1) flood((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    if (state[y * w] === 1) flood(y * w)
    if (state[y * w + w - 1] === 1) flood(y * w + w - 1)
  }

  const out: SeeThroughArea[] = []
  for (let i = 0; i < n; i++) {
    if (state[i] !== 1) continue
    let count = 0
    let x0 = w
    let y0 = h
    let x1 = 0
    let y1 = 0
    flood(i, (p) => {
      count++
      const x = p % w
      const y = (p - x) / w
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    })
    if (count / n < minArea) continue
    out.push({ x: x0 / w, y: y0 / h, width: (x1 - x0 + 1) / w, height: (y1 - y0 + 1) / h, area: count / n })
  }
  return out.sort((a, b) => b.area - a.area)
}

/** One line for a tool summary, or null when there is nothing to say. */
export function seeThroughNote(areas: SeeThroughArea[]): string | null {
  if (!areas.length) return null
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const big = areas[0]
  const where = `${pct(big.width)}×${pct(big.height)} at (${pct(big.x)}, ${pct(big.y)})`
  return (
    `${areas.length === 1 ? 'One enclosed area is' : `${areas.length} enclosed areas are`} see-through ` +
    `(${areas.length === 1 ? '' : 'largest '}${pct(big.area)} of the image, ${where}): it will show whatever is behind the icon — ` +
    'a dark taskbar, a wallpaper. Fine for a ring or a letter counter; if it is meant to be white, fill it in the source.'
  )
}
