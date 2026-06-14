// Background removal: magic-wand flood fill + global color key, with a
// tolerance threshold and optional soft (anti-aliased) edges. Operates in
// place on an ImageData so the caller can keep an undo history of snapshots.

import { hexToRgb } from './colorUtils.ts'

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
 * Contiguous magic-wand restore: the inverse of `floodRemove`. Floods from
 * (sx,sy) over the PRISTINE `source` color at the seed, writing `source` RGBA
 * back into `img` for connected pixels within tolerance (feathering alpha at the
 * tolerance band via `keepFactor`). Mutates `img`. Returns pixels affected.
 *
 * Keying off `source` instead of the working image is what lets the flood bridge
 * already-transparent working pixels — the mirror of floodRemove's "pass through
 * transparent" rule — so a previously-erased region can be brought back wholesale.
 * Returns 0 if `source` dimensions don't match `img`.
 */
export function floodRestore(
  img: ImageData,
  source: ImageData,
  sx: number,
  sy: number,
  opts: RemoveOptions,
): number {
  const { width: w, height: h, data } = img
  if (source.width !== w || source.height !== h) return 0
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return 0
  const src = source.data
  const seed = pixelAt(source, sx, sy)
  const visited = new Uint8Array(w * h)
  const stack: number[] = [sy * w + sx]
  let affected = 0

  while (stack.length) {
    const idx = stack.pop()!
    if (visited[idx]) continue
    visited[idx] = 1

    const o = idx * 4
    const x = idx % w
    const y = (idx - x) / w

    // Key off the pristine source color so transparent working pixels don't stop
    // the flood: the boundary is the source's own background, not the matte.
    const dist = colorDistance(src[o], src[o + 1], src[o + 2], seed.r, seed.g, seed.b)
    if (dist >= opts.tolerance) continue // boundary: keep, stop spreading here

    // Feather alpha at the band so restored edges stay anti-aliased.
    const factor = keepFactor(dist, opts.tolerance, opts.softness)
    const newR = src[o]
    const newG = src[o + 1]
    const newB = src[o + 2]
    const newA = Math.round(src[o + 3] * (1 - factor))
    if (data[o] !== newR || data[o + 1] !== newG || data[o + 2] !== newB || data[o + 3] !== newA) {
      data[o] = newR
      data[o + 1] = newG
      data[o + 2] = newB
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
 * Light touch; mutates `img`. When `key` is omitted it falls back to the corner
 * color (the same heuristic auto-remove keys off of).
 */
export function defringe(img: ImageData, key?: RGB, amount = 1): void {
  const { data } = img
  const k = key ?? sampleCornerColor(img)
  for (let o = 0; o < data.length; o += 4) {
    const a = data[o + 3]
    if (a === 0 || a === 255) continue
    const t = (1 - a / 255) * amount
    data[o] = Math.round(data[o] - (k.r - data[o]) * t)
    data[o + 1] = Math.round(data[o + 1] - (k.g - data[o + 1]) * t)
    data[o + 2] = Math.round(data[o + 2] - (k.b - data[o + 2]) * t)
  }
}

export function cloneImageData(img: ImageData): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
}

/* ------------------------------------------------------------ manual brush */

export type BrushMode = 'erase' | 'restore'

/**
 * Paint a single soft circular brush stamp centered at (cx, cy).
 *
 * - `erase`   — fades alpha toward 0 (rub out background the auto/flood tools
 *   miss, e.g. enclosed holes the corner flood can't reach).
 * - `restore` — blends RGBA back from `source` (the pristine upload) to undo
 *   over-erasing locally without losing the rest of your edits.
 *
 * `hardness` (0–1) is the fraction of the radius that paints at full strength
 * before the edge feathers out to 0, so strokes have soft, anti-aliased edges.
 * Mutates `img`. Callers stamp repeatedly along a drag to form a stroke.
 * Returns the number of pixels actually changed (0 when the stamp is a no-op,
 * e.g. erasing already-transparent pixels), so callers can skip dead history.
 */
export function brushStamp(
  img: ImageData,
  cx: number,
  cy: number,
  radius: number,
  hardness: number,
  mode: BrushMode,
  source?: ImageData | null,
): number {
  const { width: w, height: h, data } = img
  const r = Math.max(0.5, radius)
  const minX = Math.max(0, Math.floor(cx - r))
  const maxX = Math.min(w - 1, Math.ceil(cx + r))
  const minY = Math.max(0, Math.floor(cy - r))
  const maxY = Math.min(h - 1, Math.ceil(cy + r))
  const inner = r * Math.max(0, Math.min(1, hardness))
  const src = mode === 'restore' ? source?.data : undefined
  if (mode === 'restore' && !src) return 0 // nothing to restore from
  let affected = 0

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist > r) continue
      // Falloff: full strength inside `inner`, linearly fading to 0 at the edge.
      let t = 1
      if (dist > inner) t = r <= inner ? 0 : 1 - (dist - inner) / (r - inner)
      if (t <= 0) continue
      const o = (y * w + x) * 4
      if (mode === 'erase') {
        const a = data[o + 3]
        const newA = Math.round(a * (1 - t))
        if (newA < a) {
          data[o + 3] = newA
          affected++
        }
      } else if (src) {
        // Blend each channel toward the original; `t` weights the stamp center.
        const r0 = data[o]
        const g0 = data[o + 1]
        const b0 = data[o + 2]
        const a0 = data[o + 3]
        data[o] = Math.round(r0 + (src[o] - r0) * t)
        data[o + 1] = Math.round(g0 + (src[o + 1] - g0) * t)
        data[o + 2] = Math.round(b0 + (src[o + 2] - b0) * t)
        data[o + 3] = Math.round(a0 + (src[o + 3] - a0) * t)
        if (data[o] !== r0 || data[o + 1] !== g0 || data[o + 2] !== b0 || data[o + 3] !== a0)
          affected++
      }
    }
  }
  return affected
}

/**
 * Stamp the brush along the segment from (x0,y0) to (x1,y1), spacing the stamps
 * densely enough (¼ radius) that a fast drag leaves a continuous stroke instead
 * of a dotted trail. Mutates `img`. Returns total pixels changed.
 *
 * The loop starts at i=1 (not 0): the start point was already stamped by the
 * previous stamp/stroke (caller advances its "last point" to each endpoint), so
 * re-stamping it would double-apply the feather at every segment seam.
 */
export function brushStroke(
  img: ImageData,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
  hardness: number,
  mode: BrushMode,
  source?: ImageData | null,
): number {
  const dx = x1 - x0
  const dy = y1 - y0
  const len = Math.sqrt(dx * dx + dy * dy)
  const step = Math.max(1, radius * 0.25)
  const n = Math.max(1, Math.ceil(len / step))
  let affected = 0
  for (let i = 1; i <= n; i++) {
    const f = i / n
    affected += brushStamp(img, x0 + dx * f, y0 + dy * f, radius, hardness, mode, source)
  }
  return affected
}

/* ----------------------------------------------------------- edge refinement */

/**
 * Morphological dilate of the matte: replace each alpha with the local MAX over a
 * (2*radius+1) square window, growing the opaque region outward by `radius` px.
 * Separable (horizontal then vertical pass) and runs over the ALPHA plane only —
 * RGB is untouched, so growing the edge can't reintroduce a background halo.
 * Soft anti-aliased edges survive because the 8-bit max is order-preserving.
 * Mutates `img`. `radius` is an integer ≥ 0 (a no-op at 0). Returns pixels whose
 * alpha changed.
 */
export function growMatte(img: ImageData, radius: number): number {
  return morphMatte(img, radius, true)
}

/**
 * Morphological erode of the matte: replace each alpha with the local MIN over a
 * (2*radius+1) square window, shrinking the opaque region inward by `radius` px.
 * Separable and alpha-plane only (see `growMatte`); soft edges are preserved by
 * the order-preserving 8-bit min. Mutates `img`. `radius` is an integer ≥ 0
 * (a no-op at 0). Returns pixels whose alpha changed.
 */
export function shrinkMatte(img: ImageData, radius: number): number {
  return morphMatte(img, radius, false)
}

/** Shared separable max/min over the alpha plane (dilate when `max`, else erode). */
function morphMatte(img: ImageData, radius: number, max: boolean): number {
  const r = Math.floor(radius)
  if (r <= 0) return 0
  const { width: w, height: h, data } = img
  // Copy alpha out first so each pass reads the previous (settled) plane rather
  // than feeding back on itself.
  const a = new Uint8ClampedArray(w * h)
  for (let i = 0, o = 3; i < a.length; i++, o += 4) a[i] = data[o]
  const tmp = new Uint8ClampedArray(w * h)
  const pick = max ? Math.max : Math.min

  // Horizontal pass: a -> tmp.
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let v = a[row + x]
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      for (let k = lo; k <= hi; k++) v = pick(v, a[row + k])
      tmp[row + x] = v
    }
  }
  // Vertical pass: tmp -> back into alpha, counting changes.
  let affected = 0
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = tmp[y * w + x]
      const lo = Math.max(0, y - r)
      const hi = Math.min(h - 1, y + r)
      for (let k = lo; k <= hi; k++) v = pick(v, tmp[k * w + x])
      const o = (y * w + x) * 4 + 3
      if (data[o] !== v) {
        data[o] = v
        affected++
      }
    }
  }
  return affected
}

/**
 * Feather the matte: separable box blur of the ALPHA plane only (RGB untouched),
 * run three times so the combined kernel approximates a gaussian. Each box pass
 * sweeps a sliding-window running sum horizontally then vertically over a
 * (2*radius+1) window. Mutates `img`. `radius` ≥ 0 (a no-op at 0). Returns pixels
 * whose alpha changed.
 */
export function featherAlpha(img: ImageData, radius: number): number {
  const r = Math.floor(radius)
  if (r <= 0) return 0
  const { width: w, height: h, data } = img
  // Work on a copy of the alpha plane; settle three box passes, then write back.
  let a = new Float32Array(w * h)
  for (let i = 0, o = 3; i < a.length; i++, o += 4) a[i] = data[o]
  let tmp = new Float32Array(w * h)
  for (let pass = 0; pass < 3; pass++) {
    boxBlurH(a, tmp, w, h, r)
    boxBlurV(tmp, a, w, h, r)
  }

  let affected = 0
  for (let i = 0, o = 3; i < a.length; i++, o += 4) {
    const v = Math.round(a[i])
    if (data[o] !== v) {
      data[o] = v
      affected++
    }
  }
  return affected
}

/** One horizontal box-blur pass over a w×h scalar plane via a running sum. */
function boxBlurH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    // Seed the window sum for x=0, clamping the out-of-bounds taps to the edge.
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[row + Math.max(0, Math.min(w - 1, k))]
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / win
      const add = Math.max(0, Math.min(w - 1, x + r + 1))
      const sub = Math.max(0, Math.min(w - 1, x - r))
      sum += src[row + add] - src[row + sub]
    }
  }
}

/** One vertical box-blur pass over a w×h scalar plane via a running sum. */
function boxBlurV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[Math.max(0, Math.min(h - 1, k)) * w + x]
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win
      const add = Math.max(0, Math.min(h - 1, y + r + 1))
      const sub = Math.max(0, Math.min(h - 1, y - r))
      sum += src[add * w + x] - src[sub * w + x]
    }
  }
}

/* --------------------------------------------------------- crop & composite */

/**
 * Bounding box of the visible cutout: the tightest rect covering every pixel with
 * alpha ≥ `threshold`. Returns null when the image is fully transparent (nothing
 * to crop to). Does not mutate `img`.
 */
export function alphaBounds(
  img: ImageData,
  threshold = 1,
): { x: number; y: number; w: number; h: number } | null {
  const { width: w, height: h, data } = img
  // Clamp to >=1: a 0 threshold makes `alpha >= threshold` match fully-transparent
  // pixels, which would return the whole frame for an empty cutout and break the
  // documented "null when fully transparent" contract.
  const t = Math.max(1, threshold)
  let minX = w
  let minY = h
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] >= t) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

/**
 * Crop `img` to `bounds` and surround it with `pad` px of transparency: returns a
 * NEW (bounds.w + 2*pad) × (bounds.h + 2*pad) ImageData with the source sub-rect
 * blitted at offset (pad, pad). `bounds` is clamped to the image first, so an
 * out-of-range box still yields a valid buffer. Does not mutate `img`.
 */
export function cropPad(
  img: ImageData,
  bounds: { x: number; y: number; w: number; h: number },
  pad = 0,
): ImageData {
  const { width: iw, height: ih, data } = img
  // Clamp the requested rect to the image so the blit can't read out of bounds.
  const bx = Math.max(0, Math.min(iw, bounds.x))
  const by = Math.max(0, Math.min(ih, bounds.y))
  const bw = Math.max(0, Math.min(iw - bx, bounds.w))
  const bh = Math.max(0, Math.min(ih - by, bounds.h))
  const ow = bw + 2 * pad
  const oh = bh + 2 * pad
  const out = new ImageData(ow, oh)
  const dst = out.data
  for (let y = 0; y < bh; y++) {
    const srcRow = ((by + y) * iw + bx) * 4
    const dstRow = ((y + pad) * ow + pad) * 4
    dst.set(data.subarray(srcRow, srcRow + bw * 4), dstRow)
  }
  return out
}

/**
 * Flatten the cutout onto a solid background color: returns a NEW fully-opaque
 * ImageData where each pixel is `src.rgb * a + bg.rgb * (1 - a)` (a = alpha/255)
 * and alpha 255. `hex` is parsed via `hexToRgb`, falling back to white on a
 * malformed value. Does not mutate `img`.
 */
export function compositeOver(img: ImageData, hex: string): ImageData {
  const { width: w, height: h, data } = img
  const bg = hexToRgb(hex) ?? { r: 255, g: 255, b: 255 }
  const out = new ImageData(w, h)
  const dst = out.data
  for (let o = 0; o < data.length; o += 4) {
    const a = data[o + 3] / 255
    dst[o] = Math.round(data[o] * a + bg.r * (1 - a))
    dst[o + 1] = Math.round(data[o + 1] * a + bg.g * (1 - a))
    dst[o + 2] = Math.round(data[o + 2] * a + bg.b * (1 - a))
    dst[o + 3] = 255
  }
  return out
}
