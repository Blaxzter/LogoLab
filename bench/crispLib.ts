// Shared pure helpers for the crispness/faceting dev harnesses (Node only):
// pixel compositing, diff heatmaps, crop+zoom, and SVG-path geometry metrics.

/** Composite straight-alpha RGBA over an opaque white background. */
export function overWhite(rgba: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(rgba[i * 4 + c] * a + 255 * (1 - a))
    out[i * 4 + 3] = 255
  }
  return out
}

/** Nearest-neighbour resample of an RGBA buffer to dim×dim. */
export function resampleNearest(src: Uint8ClampedArray, sw: number, sh: number, dim: number): Uint8ClampedArray {
  if (sw === dim && sh === dim) return src
  const out = new Uint8ClampedArray(dim * dim * 4)
  for (let y = 0; y < dim; y++)
    for (let x = 0; x < dim; x++) {
      const sx = Math.min(sw - 1, Math.floor((x / dim) * sw))
      const sy = Math.min(sh - 1, Math.floor((y / dim) * sh))
      const o = (y * dim + x) * 4, s = (sy * sw + sx) * 4
      out[o] = src[s]; out[o + 1] = src[s + 1]; out[o + 2] = src[s + 2]; out[o + 3] = src[s + 3]
    }
  return out
}

/** Crop an x,y,w,h region (in `dim` space) and upscale ×zoom nearest-neighbour. */
export function cropZoom(
  img: Uint8ClampedArray,
  dim: number,
  c: { x: number; y: number; w: number; h: number },
  zoom: number,
): { data: Uint8ClampedArray; w: number; h: number } {
  const ow = c.w * zoom, oh = c.h * zoom
  const out = new Uint8ClampedArray(ow * oh * 4)
  for (let y = 0; y < oh; y++)
    for (let x = 0; x < ow; x++) {
      const sx = Math.min(dim - 1, c.x + Math.floor(x / zoom))
      const sy = Math.min(dim - 1, c.y + Math.floor(y / zoom))
      const o = (y * ow + x) * 4, s = (sy * dim + sx) * 4
      out[o] = img[s]; out[o + 1] = img[s + 1]; out[o + 2] = img[s + 2]; out[o + 3] = img[s + 3]
    }
  return { data: out, w: ow, h: oh }
}

/** Red→yellow heatmap of |a−b| (both opaque). Returns the heatmap + mean abs diff. */
export function diffHeat(a: Uint8ClampedArray, b: Uint8ClampedArray, n: number): { img: Uint8ClampedArray; mean: number } {
  const out = new Uint8ClampedArray(n * 4)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = Math.max(
      Math.abs(a[i * 4] - b[i * 4]),
      Math.abs(a[i * 4 + 1] - b[i * 4 + 1]),
      Math.abs(a[i * 4 + 2] - b[i * 4 + 2]),
    )
    sum += d
    const t = Math.min(1, d / 64)
    out[i * 4] = Math.round(255 * Math.min(1, t * 2))
    out[i * 4 + 1] = Math.round(255 * Math.max(0, t * 2 - 1))
    out[i * 4 + 2] = 0
    out[i * 4 + 3] = 255
  }
  return { img: out, mean: sum / n }
}

// --- SVG geometry metrics (parses the emitted path data) --------------------

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

export interface GeomMetrics {
  paths: number
  cubics: number
  lines: number
  moves: number
  closes: number
  numbers: number
  intFraction: number
  avgDecimals: number
  sharp60: number
  sharp100: number
}

export function geomMetrics(svg: string): GeomMetrics {
  const ds = [...svg.matchAll(/\bd="([^"]*)"/g)].map((m) => m[1])
  let cubics = 0, lines = 0, moves = 0, closes = 0, numbers = 0, ints = 0, decSum = 0
  let sharp60 = 0, sharp100 = 0

  for (const d of ds) {
    const groups = d.match(/([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g) || []
    let cx = 0, cy = 0, sx = 0, sy = 0
    const anchors: { x: number; y: number }[] = []
    let closed = false

    for (const g of groups) {
      const letter = g[0]
      const up = letter.toUpperCase()
      const rel = letter !== up && up !== 'Z'
      const strs = g.slice(1).match(/-?\d*\.?\d+(?:[eE]-?\d+)?/g) || []
      for (const t of strs) {
        numbers++
        const dot = t.indexOf('.')
        const dec = dot < 0 ? 0 : t.length - dot - 1
        decSum += dec
        if (dec === 0) ints++
      }
      const nums = strs.map(Number)
      const arity = ARITY[up] ?? 0
      if (up === 'Z') { closed = true; cx = sx; cy = sy; continue }
      let first = up === 'M'
      for (let i = 0; i + arity <= nums.length; i += arity) {
        let nx: number, ny: number
        if (up === 'H') { nx = rel ? cx + nums[i] : nums[i]; ny = cy }
        else if (up === 'V') { nx = cx; ny = rel ? cy + nums[i] : nums[i] }
        else { const ex = nums[i + arity - 2], ey = nums[i + arity - 1]; nx = rel ? cx + ex : ex; ny = rel ? cy + ey : ey }

        if (up === 'M' && first) { sx = nx; sy = ny; moves++ }
        else if (up === 'C') cubics++
        else lines++

        cx = nx; cy = ny
        anchors.push({ x: nx, y: ny })
        first = false
      }
    }

    const N = anchors.length
    const lim = closed ? N : N - 1
    for (let k = closed ? 0 : 1; k < lim; k++) {
      const p = anchors[k]
      const a = anchors[(k - 1 + N) % N]
      const b = anchors[(k + 1) % N]
      const v1x = p.x - a.x, v1y = p.y - a.y, v2x = b.x - p.x, v2y = b.y - p.y
      const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y)
      if (l1 < 1e-6 || l2 < 1e-6) continue
      const cross = v1x * v2y - v1y * v2x
      const dot = v1x * v2x + v1y * v2y
      const turn = Math.abs((Math.atan2(cross, dot) * 180) / Math.PI)
      if (turn > 60) sharp60++
      if (turn > 100) sharp100++
    }
  }

  return {
    paths: ds.length,
    cubics, lines, moves, closes,
    numbers,
    intFraction: numbers ? ints / numbers : 0,
    avgDecimals: numbers ? decSum / numbers : 0,
    sharp60, sharp100,
  }
}
