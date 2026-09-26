// Background removal: magic-wand flood fill + global color key, with a
// tolerance threshold and optional soft (anti-aliased) edges. Operates in
// place on an ImageData so the caller can keep an undo history of snapshots.

import { hexToRgb } from '../colorUtils.ts'

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
 * Contiguous magic-wand restore, the inverse of `floodRemove`: floods over the
 * pristine `source` from (sx,sy) and writes `source` RGBA back into `img` for
 * connected pixels within tolerance, feathering alpha at the band. Keying off
 * `source` lets the flood cross already-erased pixels. Mutates `img`; returns
 * pixels affected, or 0 if the dimensions don't match.
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
 * Global color key: clear every pixel within tolerance of `key`, connected or
 * not. Mutates `img`. Returns pixels affected.
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
 * Suppress the colored fringe a removed background leaves on soft edges.
 *
 * Anti-aliased edge pixels keep the RGB of their blend with the old background,
 * and that colour cannot be un-mixed from the pixel alone. So each
 * semi-transparent pixel takes the average colour of the solid pixels within
 * `R` instead, blended by `amount`; alpha is untouched, so the soft edge
 * survives. Specks with no solid neighbour are pushed away from `key` (the
 * removed colour; corner colour when omitted).
 *
 * `amount` 0 = off, 1 = full. Mutates `img`.
 */
export function defringe(img: ImageData, key?: RGB, amount = 1): void {
  if (amount <= 0) return
  const { width: w, height: h, data } = img
  // Sample colors from a stable snapshot so the bleed can't feed on itself.
  const src = new Uint8ClampedArray(data)
  const k = key ?? sampleCornerColor(img)
  const SOLID = 250 // alpha at/above which a pixel counts as solid foreground
  const R = 3 // reach (px) for foreground color to bleed across the soft edge
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const a = src[o + 3]
      if (a === 0 || a >= SOLID) continue // clear & solid interior: nothing to fix
      let sr = 0
      let sg = 0
      let sb = 0
      let n = 0
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const no = (yy * w + xx) * 4
          if (src[no + 3] < SOLID) continue
          sr += src[no]
          sg += src[no + 1]
          sb += src[no + 2]
          n++
        }
      }
      if (n > 0) {
        // Bleed the surrounding solid foreground color into the edge pixel.
        data[o] = Math.round(src[o] + (sr / n - src[o]) * amount)
        data[o + 1] = Math.round(src[o + 1] + (sg / n - src[o + 1]) * amount)
        data[o + 2] = Math.round(src[o + 2] + (sb / n - src[o + 2]) * amount)
      } else {
        // No foreground nearby — push the speck's RGB away from the key color.
        const t = (1 - a / 255) * amount
        data[o] = Math.round(src[o] - (k.r - src[o]) * t)
        data[o + 1] = Math.round(src[o + 1] - (k.g - src[o + 1]) * t)
        data[o + 2] = Math.round(src[o + 2] - (k.b - src[o + 2]) * t)
      }
    }
  }
}

/**
 * Suppress the thin anti-aliasing seam left where two separately removed
 * background regions meet. Their blended transition pixels fall outside the
 * tolerance of both keys, and raising the tolerance would let the flood bleed
 * into the logo, so seams are closed structurally instead.
 *
 * A pixel is a seam when it is opaque, sits in an opaque run no wider than
 * `maxWidth` along some axis (H, V or a diagonal) with removed pixels on both
 * flanks, and its colour is a near-linear blend of those two flanks. The blend
 * test spares genuine thin foreground lines, which have their own colour; an
 * edge against kept foreground has a solid flank and never qualifies. Matches
 * fade in proportion to how cleanly they blend.
 *
 * Run after each remove and before `defringe`, so the flank colours are still
 * the raw background. Mutates `img`; returns pixels changed.
 */
export function closeSeams(img: ImageData, maxWidth = 3, seamTol = 48): number {
  const { width: w, height: h, data } = img
  const SOLID = 200 // alpha at/above which a pixel is sliver material (vs. removed)
  // Snapshot alpha so the scan is order-independent: fading one sliver can't
  // shrink a run mid-pass and hide an adjacent one.
  const sa = new Uint8ClampedArray(w * h)
  for (let i = 0, o = 3; i < sa.length; i++, o += 4) sa[i] = data[o]
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]
  let affected = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x
      if (sa[idx] < SOLID) continue // only solid pixels can be a leftover seam

      // Thinnest opaque run through this pixel with a removed flank on both
      // sides within maxWidth; the flanks are background colours A and B.
      let best = Infinity
      let aIdx = -1
      let bIdx = -1
      for (const [dx, dy] of axes) {
        // Walk + until a non-solid flank (else OOB / run wider than maxWidth).
        let pos = 0
        let pe = -1
        for (let s = 1; s <= maxWidth; s++) {
          const xx = x + dx * s
          const yy = y + dy * s
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break // OOB: no valid flank
          const j = yy * w + xx
          if (sa[j] < SOLID) {
            pe = j
            break
          }
          pos = s
        }
        if (pe < 0) continue
        let neg = 0
        let ne = -1
        for (let s = 1; s <= maxWidth; s++) {
          const xx = x - dx * s
          const yy = y - dy * s
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break
          const j = yy * w + xx
          if (sa[j] < SOLID) {
            ne = j
            break
          }
          neg = s
        }
        if (ne < 0) continue
        const thick = pos + neg + 1
        if (thick <= maxWidth && thick < best) {
          best = thick
          aIdx = ne
          bIdx = pe
        }
      }
      if (aIdx < 0) continue // not a thin sliver bridging two removed regions

      // Collinearity gate: is this pixel's color a linear blend of A and B?
      const o = idx * 4
      const ao = aIdx * 4
      const bo = bIdx * 4
      const ex = data[bo] - data[ao]
      const ey = data[bo + 1] - data[ao + 1]
      const ez = data[bo + 2] - data[ao + 2]
      const len2 = ex * ex + ey * ey + ez * ez
      let t = 0
      if (len2 > 0)
        t = ((data[o] - data[ao]) * ex + (data[o + 1] - data[ao + 1]) * ey + (data[o + 2] - data[ao + 2]) * ez) / len2
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const residual = colorDistance(
        data[o],
        data[o + 1],
        data[o + 2],
        data[ao] + ex * t,
        data[ao + 1] + ey * t,
        data[ao + 2] + ez * t,
      )
      if (residual >= seamTol) continue // a real (non-blend) color → keep it

      // Fade: a clean blend (residual≈0) goes fully transparent; a marginal one
      // keeps proportionally more alpha so the cut stays smooth.
      const newA = Math.round(sa[idx] * (residual / seamTol))
      if (newA < data[o + 3]) {
        data[o + 3] = newA
        affected++
      }
    }
  }
  return affected
}

/**
 * Remove small islands of leftover pixels stranded in removed territory: the
 * specks and crumbs a flood leaves on a noisy or softly anti-aliased background.
 *
 * Labels 8-connected visible components (alpha >= `visible`) that touch removed
 * pixels and clears one when any of:
 *   - size <= `hardIsland`;
 *   - size <= `maxIsland` and its mean colour is within `keyTol` of the removed
 *     background around it;
 *   - it is a hairline (bbox min dimension <= 2) of at most `hairMax` px.
 * The logo body and anything attached to it form one large component and are
 * never touched. Mutates `img`; returns pixels cleared.
 */
export function despeckle(
  img: ImageData,
  maxIsland = 24,
  keyTol = 110,
  hardIsland = 4,
  hairMax = 64,
): number {
  const { width: w, height: h, data } = img
  const visible = 16 // alpha at/above which a pixel is part of an island
  const cap = Math.max(maxIsland, hairMax) // largest component we still track to clear
  const n = w * h
  const seen = new Uint8Array(n)
  const stack: number[] = []
  let affected = 0

  for (let start = 0; start < n; start++) {
    if (seen[start] || data[start * 4 + 3] < visible) continue
    // Flood this component. The cell list is kept only while it is small enough
    // to clear; past `cap` labelling continues so it isn't rescanned.
    let cells: number[] | null = []
    let size = 0
    let sr = 0
    let sg = 0
    let sb = 0
    // Bounding box, for the hairline (thin-streak) test.
    let minX = w
    let maxX = -1
    let minY = h
    let maxY = -1
    // Border = the removed pixels touching the component (the local background).
    let br = 0
    let bg = 0
    let bb = 0
    let bn = 0
    seen[start] = 1
    stack.length = 0
    stack.push(start)
    while (stack.length) {
      const idx = stack.pop()!
      const o = idx * 4
      size++
      sr += data[o]
      sg += data[o + 1]
      sb += data[o + 2]
      if (cells) {
        if (size > cap) cells = null // too big to be residue — stop tracking
        else cells.push(idx)
      }
      const x = idx % w
      const y = (idx - x) / w
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const j = yy * w + xx
          const jo = j * 4
          if (data[jo + 3] >= visible) {
            if (!seen[j]) {
              seen[j] = 1
              stack.push(j)
            }
          } else {
            br += data[jo]
            bg += data[jo + 1]
            bb += data[jo + 2]
            bn++
          }
        }
      }
    }
    // bn === 0 means the component touches nothing removed (it's the whole image
    // or an interior hole) — never a stranded speck.
    if (!cells || bn === 0) continue
    const minDim = Math.min(maxX - minX + 1, maxY - minY + 1)
    const nearBg =
      size <= maxIsland &&
      colorDistance(sr / size, sg / size, sb / size, br / bn, bg / bn, bb / bn) <= keyTol
    const isHairline = minDim <= 2 && size <= hairMax
    if (size > hardIsland && !nearBg && !isHairline) continue
    for (const idx of cells) {
      if (data[idx * 4 + 3] !== 0) {
        data[idx * 4 + 3] = 0
        affected++
      }
    }
  }
  return affected
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
 * Stamp the brush along (x0,y0)→(x1,y1) at ¼-radius spacing so a fast drag
 * leaves a continuous stroke. Mutates `img`; returns pixels changed.
 *
 * The start point is skipped: the previous stamp already covered it, and
 * re-stamping would double the feather at every segment seam.
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
 * Colour-carrying dilate of the matte: grows the opaque region by `radius` px
 * (separable local max), and each revealed pixel takes the RGBA of the pixel it
 * grew from. A plain alpha dilate would expose the stale background RGB under
 * transparent pixels as a coloured ring. Ties keep their own colour; the alpha
 * result equals a plain max-dilate. Mutates `img`; no-op at radius 0. Returns
 * pixels whose alpha changed.
 */
export function growMatte(img: ImageData, radius: number): number {
  const r = Math.floor(radius)
  if (r <= 0) return 0
  const { width: w, height: h, data } = img
  const n = w * h
  // Snapshot the rgba planes so each pass reads settled values, not its own output.
  const sr = new Uint8ClampedArray(n)
  const sg = new Uint8ClampedArray(n)
  const sb = new Uint8ClampedArray(n)
  const sa = new Uint8ClampedArray(n)
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    sr[i] = data[o]
    sg[i] = data[o + 1]
    sb[i] = data[o + 2]
    sa[i] = data[o + 3]
  }
  // Horizontal pass: carry the arg-max-alpha pixel's rgba into tmp planes.
  const tr = new Uint8ClampedArray(n)
  const tg = new Uint8ClampedArray(n)
  const tb = new Uint8ClampedArray(n)
  const ta = new Uint8ClampedArray(n)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let bi = row + x // best (arg-max) index, defaulting to self so ties keep self
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      for (let k = lo; k <= hi; k++) {
        if (sa[row + k] > sa[bi]) bi = row + k
      }
      const oi = row + x
      tr[oi] = sr[bi]
      tg[oi] = sg[bi]
      tb[oi] = sb[bi]
      ta[oi] = sa[bi]
    }
  }
  // Vertical pass: same arg-max carry, write back to the image, count alpha changes.
  let affected = 0
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let bi = y * w + x
      const lo = Math.max(0, y - r)
      const hi = Math.min(h - 1, y + r)
      for (let k = lo; k <= hi; k++) {
        if (ta[k * w + x] > ta[bi]) bi = k * w + x
      }
      const o = (y * w + x) * 4
      if (data[o + 3] !== ta[bi]) affected++
      data[o] = tr[bi]
      data[o + 1] = tg[bi]
      data[o + 2] = tb[bi]
      data[o + 3] = ta[bi]
    }
  }
  return affected
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
  const a = new Float32Array(w * h)
  for (let i = 0, o = 3; i < a.length; i++, o += 4) a[i] = data[o]
  const tmp = new Float32Array(w * h)
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
  // Clamp to >= 1, or a 0 threshold matches transparent pixels and an empty
  // cutout returns the whole frame instead of null.
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

/**
 * Flat-recolor the cutout: set every non-transparent pixel's RGB to `hex`,
 * leaving alpha as-is. For single-colour art; it also overwrites an opaque
 * background rim the alpha-aware edge tools cannot reach. `hex` falls back to
 * white. Mutates `img`; returns pixels changed.
 */
export function recolor(img: ImageData, hex: string): number {
  const { data } = img
  const c = hexToRgb(hex) ?? { r: 255, g: 255, b: 255 }
  let affected = 0
  for (let o = 0; o < data.length; o += 4) {
    if (data[o + 3] === 0) continue // leave fully-transparent pixels alone
    if (data[o] !== c.r || data[o + 1] !== c.g || data[o + 2] !== c.b) affected++
    data[o] = c.r
    data[o + 1] = c.g
    data[o + 2] = c.b
  }
  return affected
}
