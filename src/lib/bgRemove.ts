// Background removal: magic-wand flood fill + global color key, with a
// tolerance threshold and optional soft (anti-aliased) edges. Operates in
// place on an ImageData so the caller can keep an undo history of snapshots.

export interface RemoveOptions {
  /** Max color distance (0–255-ish) still considered "background". */
  tolerance: number
  /** Edge softness 0–1: fraction of the tolerance band that fades out (feather). */
  softness: number
}

interface RGB {
  r: number
  g: number
  b: number
}

/** Perceptual-ish RGB distance (weighted), 0..~255. */
function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  // Weighted euclidean (eyes are most sensitive to green).
  return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db)
}

/**
 * Removal multiplier for a pixel at color `dist` from the key color.
 * 0 => fully removed, 1 => fully kept. The band [inner, tolerance] feathers.
 */
function keepFactor(dist: number, tolerance: number, softness: number): number {
  if (dist >= tolerance) return 1
  const inner = tolerance * (1 - Math.max(0, Math.min(1, softness)))
  if (dist <= inner) return 0
  if (tolerance === inner) return 0
  return (dist - inner) / (tolerance - inner)
}

function pixelAt(img: ImageData, x: number, y: number): RGB & { a: number } {
  const i = (y * img.width + x) * 4
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] }
}

/** Sample the average color of the four corners (typical solid AI-icon bg). */
export function sampleCornerColor(img: ImageData): RGB {
  const { width: w, height: h } = img
  const pts: [number, number][] = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ]
  let r = 0
  let g = 0
  let b = 0
  for (const [x, y] of pts) {
    const p = pixelAt(img, x, y)
    r += p.r
    g += p.g
    b += p.b
  }
  return { r: Math.round(r / 4), g: Math.round(g / 4), b: Math.round(b / 4) }
}

/** Get the color of a single pixel (for "remove this color" by click). */
export function colorAt(img: ImageData, x: number, y: number): RGB {
  const p = pixelAt(img, x, y)
  return { r: p.r, g: p.g, b: p.b }
}

/**
 * Contiguous magic-wand removal: flood from (sx,sy), clearing connected pixels
 * whose color is within tolerance of the seed. Mutates `img`.
 * Returns the number of pixels affected.
 */
export function floodRemove(img: ImageData, sx: number, sy: number, opts: RemoveOptions): number {
  const { width: w, height: h, data } = img
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0
  const seed = pixelAt(img, sx, sy)
  const visited = new Uint8Array(w * h)
  const stack: number[] = [sy * w + sx]
  let affected = 0

  while (stack.length) {
    const idx = stack.pop()!
    if (visited[idx]) continue
    visited[idx] = 1

    const o = idx * 4
    const a = data[o + 3]
    const x = idx % w
    const y = (idx - x) / w

    // Already-transparent pixels are background: pass straight through (no alpha
    // write, no tolerance test) so the flood can bridge a previously-removed
    // region and reach leftover background beyond it.
    if (a === 0) {
      if (x > 0) stack.push(idx - 1)
      if (x < w - 1) stack.push(idx + 1)
      if (y > 0) stack.push(idx - w)
      if (y < h - 1) stack.push(idx + w)
      continue
    }

    const dist = colorDistance(data[o], data[o + 1], data[o + 2], seed.r, seed.g, seed.b)
    if (dist >= opts.tolerance) continue // boundary: keep, stop spreading here

    const factor = keepFactor(dist, opts.tolerance, opts.softness)
    const newA = Math.round(a * factor)
    if (newA !== a) {
      data[o + 3] = newA
      affected++
    }

    if (x > 0) stack.push(idx - 1)
    if (x < w - 1) stack.push(idx + 1)
    if (y > 0) stack.push(idx - w)
    if (y < h - 1) stack.push(idx + w)
  }
  return affected
}

/**
 * Global color key: clear EVERY pixel within tolerance of `key`, anywhere in
 * the image (not just connected). Mutates `img`. Returns pixels affected.
 */
export function removeColor(img: ImageData, key: RGB, opts: RemoveOptions): number {
  const { data } = img
  let affected = 0
  for (let o = 0; o < data.length; o += 4) {
    const a = data[o + 3]
    if (a === 0) continue
    const dist = colorDistance(data[o], data[o + 1], data[o + 2], key.r, key.g, key.b)
    if (dist >= opts.tolerance) continue
    const factor = keepFactor(dist, opts.tolerance, opts.softness)
    const newA = Math.round(a * factor)
    if (newA !== a) {
      data[o + 3] = newA
      affected++
    }
  }
  return affected
}

/**
 * One-click auto: use the corner color as the key and remove it contiguously
 * from all four corners (handles vignettes better than a single flood).
 * Mutates `img`. Returns { color, affected }.
 */
export function autoRemove(
  img: ImageData,
  opts: RemoveOptions,
): { color: RGB; affected: number } {
  const color = sampleCornerColor(img)
  const { width: w, height: h } = img
  let affected = 0
  for (const [x, y] of [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ] as [number, number][]) {
    affected += floodRemove(img, x, y, opts)
  }
  return { color, affected }
}

/**
 * Optional defringe: for semi-transparent edge pixels, pull their RGB away from
 * the removed key color toward their own hue so a colored halo doesn't remain.
 * Light touch; mutates `img`.
 */
export function defringe(img: ImageData, key: RGB, amount = 1): void {
  const { data } = img
  for (let o = 0; o < data.length; o += 4) {
    const a = data[o + 3]
    if (a === 0 || a === 255) continue
    const t = (1 - a / 255) * amount
    data[o] = Math.round(data[o] - (key.r - data[o]) * t)
    data[o + 1] = Math.round(data[o + 1] - (key.g - data[o + 1]) * t)
    data[o + 2] = Math.round(data[o + 2] - (key.b - data[o + 2]) * t)
  }
}

export function cloneImageData(img: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
}
