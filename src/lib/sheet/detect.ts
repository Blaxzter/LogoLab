// Find the individual icons in an icon SHEET.
//
// The shape of the problem, from the real sheets image models produce: a flat
// background, icons laid out on a lattice, and — very often — a caption under
// every icon plus a title across the top. So the two things that actually go
// wrong are (a) one icon arriving as several disconnected blobs (a "wifi" arc
// stack is 4 components) and (b) caption text being mistaken for an icon.
//
// The pipeline answers those in order:
//
//   1. background   → border-ring median; alpha alone when the sheet is transparent
//   2. ink mask     → downscaled, OR-reduced so hairlines survive the downscale
//   3. components   → 8-connected blobs with boxes and ink weight
//   4. BANDS        → maximal y-intervals that contain blobs. A captioned sheet
//                     alternates tall icon bands with short text bands, and the
//                     caption sits CLOSER to its icon (≈18px) than some icons'
//                     own parts are to each other — so no gap threshold can tell
//                     them apart. Band height can, and does.
//   5. grouping     → single-linkage merge inside each band, at a gap chosen by
//                     scale-space persistence (§pickGap) rather than a constant
//   6. classify     → labels/noise, grid inference, boxes refined at full res
//
// Everything is pure and works on plain RGBA, so the browser and the Node test
// harness run the identical code.

import type {
  DetectOptions,
  ImageDataLike,
  Rect,
  SheetBackground,
  SheetDetection,
  SheetGrid,
  SheetTile,
  TileKind,
} from './types'

export const DETECT_DEFAULTS = {
  threshold: 24,
  detectSize: 1000,
  padding: 0.08,
  square: true,
  uniform: true,
  dropLabels: true,
  noiseFraction: 0.02,
} as const

/** Blobs below this many mask pixels are dust — they never reach the grouping. */
const SPECK_MASK_AREA = 3
/** A band shorter than this fraction of the tallest band is caption text. */
const LABEL_BAND_RATIO = 0.55
/**
 * …unless the group itself is this tall against the median icon, and no wider
 * than LABEL_RESCUE_ASPECT × its height. Captions on a real sheet run 23–30px
 * against 130px icons (≈0.2), so a 0.45 cut sits in open space between the two
 * populations rather than splitting either.
 */
const LABEL_RESCUE_HEIGHT = 0.45
const LABEL_RESCUE_ASPECT = 2.5
/** Hard cap on blobs fed to the O(n²) linkage. */
const MAX_BLOBS = 1500

export function detectSheetIcons(img: ImageDataLike, opts: DetectOptions = {}): SheetDetection {
  const threshold = opts.threshold ?? DETECT_DEFAULTS.threshold
  const detectSize = opts.detectSize ?? DETECT_DEFAULTS.detectSize
  const warnings: string[] = []

  const background = estimateBackground(img, threshold)
  const mask = buildMask(img, background, threshold, detectSize)
  const { mw, mh, scale } = mask

  if (mask.inkCells === 0) {
    return { tiles: [], background, grid: null, gap: 0, scale, warnings: ['The sheet looks empty — nothing differs from the background.'] }
  }
  if (mask.inkCells / (mw * mh) > 0.9) {
    warnings.push('Almost every pixel differs from the background — if this is a photo or a full-bleed design, splitting will not find icons.')
  }

  const blobs = connectedComponents(mask)
  const solid = blobs.filter((b) => b.maskArea > SPECK_MASK_AREA)
  if (solid.length === 0) {
    return { tiles: [], background, grid: null, gap: 0, scale, warnings: [...warnings, 'Only dust-sized specks found.'] }
  }
  if (blobs.length !== solid.length) warnings.push(`Ignored ${blobs.length - solid.length} speck${blobs.length - solid.length === 1 ? '' : 's'} smaller than a few pixels.`)

  // ---- 4. bands -----------------------------------------------------------
  const bands = findBands(solid)
  const tallest = bands.reduce((m, b) => Math.max(m, b.y1 - b.y0 + 1), 1)
  for (const band of bands) {
    const h = band.y1 - band.y0 + 1
    // A lone band is whatever it is — only call something a caption when there
    // is a taller band on the same sheet to be a caption FOR.
    band.isLabel = bands.length > 1 && h < LABEL_BAND_RATIO * tallest
  }
  const iconBands = bands.filter((b) => !b.isLabel)
  const labelBands = bands.filter((b) => b.isLabel)
  if (labelBands.length) {
    warnings.push(`${labelBands.length} short text band${labelBands.length === 1 ? '' : 's'} (titles/captions) kept out of the icon rows.`)
  }

  // ---- 5. grouping --------------------------------------------------------
  const linkage = buildLinkage(iconBands, warnings)
  const gapMask = opts.gap != null ? opts.gap * scale : pickGap(linkage, Math.min(mw, mh))
  const groups = groupsAtGap(linkage, gapMask)

  // Caption text that shares a band with its icon (side-by-side layouts) never
  // reaches the band filter, so the same question gets asked per group.
  const labelGroups = groupsAtGap(buildLinkage(labelBands, warnings), gapMask)

  // ---- 6. classify + boxes ------------------------------------------------
  const all = [
    ...groups.map((g) => ({ g, kind: 'icon' as TileKind })),
    ...labelGroups.map((g) => ({ g, kind: 'label' as TileKind })),
  ]
  const iconAreas = groups.map((g) => g.weight).sort((a, b) => a - b)
  const medianArea = iconAreas.length ? iconAreas[iconAreas.length >> 1] : 0
  const iconHeights = groups.map((g) => g.y1 - g.y0 + 1).sort((a, b) => a - b)
  const medianHeight = iconHeights.length ? iconHeights[iconHeights.length >> 1] : 0
  const noiseFraction = opts.noiseFraction ?? DETECT_DEFAULTS.noiseFraction

  for (const item of all) {
    if (item.kind !== 'icon') continue
    const w = item.g.x1 - item.g.x0 + 1
    const h = item.g.y1 - item.g.y0 + 1
    if (item.g.weight < noiseFraction * medianArea) item.kind = 'noise'
    // A wide, short group next to normal-height icons is a line of text.
    else if (medianHeight > 0 && h < 0.5 * medianHeight && w > 2.5 * h) item.kind = 'label'
  }

  // Rescue: a SHORT band is not automatically caption text. Sheets put a strip of
  // smaller icons ("Branding": upload, grid, sliders) between the full-size rows,
  // and one such band measured 83px against a 84px cut — a whole row of real icons
  // silently lost. Caption text is short AND text-shaped; these are neither, so ask
  // the group itself rather than trusting the band it fell in.
  let rescued = 0
  for (const item of all) {
    if (item.kind !== 'label') continue
    const w = item.g.x1 - item.g.x0 + 1
    const h = item.g.y1 - item.g.y0 + 1
    if (medianHeight <= 0 || h < LABEL_RESCUE_HEIGHT * medianHeight || w > LABEL_RESCUE_ASPECT * h) continue
    if (item.g.weight < noiseFraction * medianArea) continue
    item.kind = 'icon'
    rescued++
  }
  if (rescued > 0) {
    warnings.push(`${rescued} smaller icon${rescued === 1 ? '' : 's'} in a short row ${rescued === 1 ? 'was' : 'were'} kept as icons, not caption text.`)
  }

  const tiles = buildTiles(all, img, background, threshold, mask, opts)
  const grid = inferGrid(tiles)
  if (!grid && tiles.some((t) => t.kind === 'icon')) {
    warnings.push('Icons are not on a regular grid — boxes follow the artwork instead.')
  }

  applyBoxes(tiles, grid, opts, warnings)

  return { tiles, background, grid, gap: gapMask / scale, scale, warnings }
}

// ---------------------------------------------------------------------------
// 1. background
// ---------------------------------------------------------------------------

/**
 * The sheet's paper colour, read off the border ring: sheets are laid out with a
 * margin, so the outermost pixels are background almost by definition. Median,
 * not mean, so a logo that bleeds into one corner cannot drag it.
 */
export function estimateBackground(img: ImageDataLike, threshold: number): SheetBackground {
  const { width: W, height: H, data } = img
  const rs: number[] = []
  const gs: number[] = []
  const bs: number[] = []
  const as: number[] = []
  const stepX = Math.max(1, Math.floor(W / 400))
  const stepY = Math.max(1, Math.floor(H / 400))
  const push = (x: number, y: number) => {
    const i = (y * W + x) * 4
    rs.push(data[i])
    gs.push(data[i + 1])
    bs.push(data[i + 2])
    as.push(data[i + 3])
  }
  for (let x = 0; x < W; x += stepX) {
    push(x, 0)
    push(x, H - 1)
  }
  for (let y = 0; y < H; y += stepY) {
    push(0, y)
    push(W - 1, y)
  }
  const med = (a: number[]) => {
    a.sort((p, q) => p - q)
    return a.length ? a[a.length >> 1] : 0
  }
  // Copy before sorting: the deviation pass below needs the original order? No —
  // it only needs values, so sorting in place is fine.
  const r = med(rs)
  const g = med(gs)
  const b = med(bs)
  const a = med(as)

  // Uniformity: how much of the ring agrees with its own median.
  let agree = 0
  for (let i = 0; i < rs.length; i++) {
    // rs/gs/bs are sorted now, so compare the *distribution* instead: count ring
    // samples within tolerance using the sorted arrays' quantiles.
    if (Math.abs(rs[i] - r) <= threshold && Math.abs(gs[i] - g) <= threshold && Math.abs(bs[i] - b) <= threshold) agree++
  }
  const transparent = a < 16

  let inside = 0
  const total = Math.ceil(W / stepX) * Math.ceil(H / stepY)
  for (let y = 0; y < H; y += stepY) {
    for (let x = 0; x < W; x += stepX) {
      const i = (y * W + x) * 4
      if (transparent ? data[i + 3] < 16 : isNear(data, i, r, g, b, threshold)) inside++
    }
  }

  return {
    r,
    g,
    b,
    a,
    coverage: total ? inside / total : 0,
    transparent,
    uniform: agree / Math.max(1, rs.length) > 0.8,
  }
}

function isNear(data: Uint8ClampedArray, i: number, r: number, g: number, b: number, threshold: number): boolean {
  return (
    Math.abs(data[i] - r) <= threshold &&
    Math.abs(data[i + 1] - g) <= threshold &&
    Math.abs(data[i + 2] - b) <= threshold
  )
}

/** True when this source pixel is ink (i.e. not the sheet background). */
export function isInkPixel(data: Uint8ClampedArray, i: number, bg: SheetBackground, threshold: number): boolean {
  const alpha = data[i + 3]
  if (bg.transparent) return alpha > 16
  if (alpha <= 16) return false
  // A pixel that is partly transparent over a background it doesn't match is ink
  // regardless of its colour distance — composite before comparing.
  return !isNear(data, i, bg.r, bg.g, bg.b, threshold) || alpha < 240
}

// ---------------------------------------------------------------------------
// 2. mask
// ---------------------------------------------------------------------------

interface Mask {
  cells: Uint8Array
  /** Source-pixel ink count per mask cell — the honest area, post-downscale. */
  weight: Uint32Array
  mw: number
  mh: number
  scale: number
  inkCells: number
}

/**
 * Downscale to a working resolution with OR reduction: a mask cell is ink when
 * ANY source pixel inside it is. Averaging would erase 1px hairlines at 3× — and
 * a dropped hairline splits an icon into pieces, which is exactly the failure the
 * grouping stage then has to guess its way out of.
 */
function buildMask(img: ImageDataLike, bg: SheetBackground, threshold: number, detectSize: number): Mask {
  const { width: W, height: H, data } = img
  const scale = Math.min(1, detectSize / Math.max(W, H))
  const mw = Math.max(1, Math.round(W * scale))
  const mh = Math.max(1, Math.round(H * scale))
  const cells = new Uint8Array(mw * mh)
  const weight = new Uint32Array(mw * mh)
  let inkCells = 0
  for (let y = 0; y < H; y++) {
    const my = Math.min(mh - 1, ((y * mh) / H) | 0)
    const rowOff = my * mw
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      if (!isInkPixel(data, i, bg, threshold)) continue
      const mx = Math.min(mw - 1, ((x * mw) / W) | 0)
      const c = rowOff + mx
      if (!cells[c]) {
        cells[c] = 1
        inkCells++
      }
      weight[c]++
    }
  }
  return { cells, weight, mw, mh, scale, inkCells }
}

// ---------------------------------------------------------------------------
// 3. connected components
// ---------------------------------------------------------------------------

interface Blob {
  x0: number
  y0: number
  x1: number
  y1: number
  maskArea: number
  /** Source-pixel ink count. */
  weight: number
}

function connectedComponents(mask: Mask): Blob[] {
  const { cells, weight, mw, mh } = mask
  const seen = new Uint8Array(mw * mh)
  const stack = new Int32Array(mw * mh)
  const out: Blob[] = []
  for (let s = 0; s < cells.length; s++) {
    if (!cells[s] || seen[s]) continue
    let top = 0
    stack[top++] = s
    seen[s] = 1
    let x0 = s % mw
    let x1 = x0
    let y0 = (s / mw) | 0
    let y1 = y0
    let area = 0
    let w = 0
    while (top > 0) {
      const p = stack[--top]
      const px = p % mw
      const py = (p / mw) | 0
      area++
      w += weight[p]
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= mh) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          if (nx < 0 || nx >= mw) continue
          const q = ny * mw + nx
          if (cells[q] && !seen[q]) {
            seen[q] = 1
            stack[top++] = q
          }
        }
      }
    }
    out.push({ x0, y0, x1, y1, maskArea: area, weight: w })
  }
  return out
}

// ---------------------------------------------------------------------------
// 4. bands
// ---------------------------------------------------------------------------

interface Band {
  y0: number
  y1: number
  blobs: Blob[]
  isLabel: boolean
}

/**
 * Maximal y-intervals covered by blobs. Two icon rows are separated by a gap no
 * blob crosses; a caption band is separated from its icon the same way — the two
 * are told apart by height afterwards, not here.
 */
function findBands(blobs: Blob[]): Band[] {
  const sorted = blobs.slice().sort((a, b) => a.y0 - b.y0)
  const bands: Band[] = []
  let cur: Band | null = null
  for (const b of sorted) {
    if (cur && b.y0 <= cur.y1 + 1) {
      cur.y1 = Math.max(cur.y1, b.y1)
      cur.blobs.push(b)
    } else {
      cur = { y0: b.y0, y1: b.y1, blobs: [b], isLabel: false }
      bands.push(cur)
    }
  }
  return bands
}

// ---------------------------------------------------------------------------
// 5. grouping — single linkage at a persistence-picked gap
// ---------------------------------------------------------------------------

interface Group {
  x0: number
  y0: number
  x1: number
  y1: number
  weight: number
}

interface Linkage {
  blobs: Blob[]
  /** MST edges (single-linkage dendrogram), ascending by gap. */
  edges: { a: number; b: number; gap: number }[]
}

/** Box gap: expand both boxes by g and they touch iff `boxGap <= 2g`. */
function boxGap(a: Blob, b: Blob): number {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1))
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1))
  return Math.max(dx, dy)
}

/**
 * Single-linkage clustering, computed once as a minimum spanning tree (Prim's,
 * O(n²) time but O(n) memory) so every gap threshold afterwards is just a prefix
 * of the sorted edges.
 *
 * Note what is NOT constrained here: merges are free to cross bands. Bands exist
 * to keep captions out of the icons, and once the caption bands are held back the
 * gap alone should decide — an icon drawn as two stacked bars puts every icon in
 * the row in its own band, and forbidding the merge would split all of them.
 */
function buildLinkage(bands: Band[], warnings: string[]): Linkage {
  let members = bands.flatMap((b) => b.blobs)
  if (members.length > MAX_BLOBS) {
    const total = members.length
    members = members.slice().sort((a, b) => b.weight - a.weight).slice(0, MAX_BLOBS)
    warnings.push(`The sheet has ${total} separate pieces of artwork — only the ${MAX_BLOBS} largest were grouped.`)
  }

  const edges: { a: number; b: number; gap: number }[] = []
  const n = members.length
  if (n >= 2) {
    const inTree = new Uint8Array(n)
    const best = new Float64Array(n).fill(Infinity)
    const bestFrom = new Int32Array(n).fill(-1)
    inTree[0] = 1
    for (let j = 1; j < n; j++) {
      best[j] = boxGap(members[0], members[j])
      bestFrom[j] = 0
    }
    for (let k = 1; k < n; k++) {
      let pick = -1
      let pickGapValue = Infinity
      for (let j = 0; j < n; j++) {
        if (!inTree[j] && best[j] < pickGapValue) {
          pickGapValue = best[j]
          pick = j
        }
      }
      if (pick < 0) break
      inTree[pick] = 1
      edges.push({ a: bestFrom[pick], b: pick, gap: pickGapValue })
      for (let j = 0; j < n; j++) {
        if (inTree[j]) continue
        const d = boxGap(members[pick], members[j])
        if (d < best[j]) {
          best[j] = d
          bestFrom[j] = pick
        }
      }
    }
    edges.sort((p, q) => p.gap - q.gap)
  }
  return { blobs: members, edges }
}

function groupsAtGap(link: Linkage, gap: number): Group[] {
  const n = link.blobs.length
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  for (const e of link.edges) {
    if (e.gap > gap) break
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra !== rb) parent[ra] = rb
  }
  const byRoot = new Map<number, Group>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const blob = link.blobs[i]
    const g = byRoot.get(root)
    if (!g) {
      byRoot.set(root, { x0: blob.x0, y0: blob.y0, x1: blob.x1, y1: blob.y1, weight: blob.weight })
    } else {
      g.x0 = Math.min(g.x0, blob.x0)
      g.y0 = Math.min(g.y0, blob.y0)
      g.x1 = Math.max(g.x1, blob.x1)
      g.y1 = Math.max(g.y1, blob.y1)
      g.weight += blob.weight
    }
  }
  return [...byRoot.values()].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
}

/**
 * Which gap makes "one icon"?
 *
 * Sweep the gap from 0 upwards and the group count falls in steps: first the
 * pieces of each icon fuse (the count settles on the number of icons and STAYS
 * there across a wide range of gaps), then whole rows fuse, then everything.
 * Pick the step that survives the widest *relative* range of gaps — with two
 * corrections, because raw persistence prefers the run-away merges:
 *
 *   compactness — icons are roughly as wide as they are tall; a fused row is
 *                 14:1 and scores near zero.
 *   consistency — an icon set is drawn at one size, so the spread of group sizes
 *                 is small exactly at the right answer.
 */
function pickGap(link: Linkage, maskMin: number): number {
  const n = link.blobs.length
  if (n === 0) return 0
  const gapCap = Math.max(4, maskMin * 0.2)

  const parent = new Int32Array(n)
  const box = new Float64Array(n * 4)
  for (let i = 0; i < n; i++) {
    parent[i] = i
    box[i * 4] = link.blobs[i].x0
    box[i * 4 + 1] = link.blobs[i].y0
    box[i * 4 + 2] = link.blobs[i].x1
    box[i * 4 + 3] = link.blobs[i].y1
  }
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }

  let bestGap = 0
  let bestScore = -1
  const consider = (from: number, to: number) => {
    // The plateau [from, to) — score the current partition.
    if (to <= from) return
    const roots: number[] = []
    for (let i = 0; i < n; i++) if (find(i) === i) roots.push(i)
    if (roots.length === 0) return
    const persistence = (to - from) / Math.max(1, from)
    let compact = 0
    const longs: number[] = []
    for (const r of roots) {
      const w = box[r * 4 + 2] - box[r * 4] + 1
      const h = box[r * 4 + 3] - box[r * 4 + 1] + 1
      compact += Math.min(w, h) / Math.max(w, h)
      longs.push(Math.max(w, h))
    }
    compact /= roots.length
    const mean = longs.reduce((a, b) => a + b, 0) / longs.length
    let varSum = 0
    for (const l of longs) varSum += (l - mean) * (l - mean)
    const cv = mean > 0 ? Math.sqrt(varSum / longs.length) / mean : 0
    const consistency = 1 / (1 + cv)
    const score = persistence * compact * consistency
    if (score > bestScore) {
      bestScore = score
      // Sit in the middle of the plateau (geometric mean): the safest place to
      // be when the next sheet's gaps are a little different.
      bestGap = from <= 0 ? Math.min(to - 1, 1) : Math.sqrt(from * to)
    }
  }

  let prev = 0
  for (const e of link.edges) {
    if (e.gap > gapCap) break
    if (e.gap > prev) {
      consider(prev, e.gap)
      prev = e.gap
    }
    const ra = find(e.a)
    const rb = find(e.b)
    if (ra === rb) continue
    box[rb * 4] = Math.min(box[ra * 4], box[rb * 4])
    box[rb * 4 + 1] = Math.min(box[ra * 4 + 1], box[rb * 4 + 1])
    box[rb * 4 + 2] = Math.max(box[ra * 4 + 2], box[rb * 4 + 2])
    box[rb * 4 + 3] = Math.max(box[ra * 4 + 3], box[rb * 4 + 3])
    parent[ra] = rb
  }
  consider(prev, gapCap)
  return bestGap
}

// ---------------------------------------------------------------------------
// 6. tiles, grid, boxes
// ---------------------------------------------------------------------------

function buildTiles(
  items: { g: Group; kind: TileKind }[],
  img: ImageDataLike,
  bg: SheetBackground,
  threshold: number,
  mask: Mask,
  _opts: DetectOptions,
): SheetTile[] {
  const tiles: SheetTile[] = []
  items.forEach((item, index) => {
    const coarse = maskRectToSource(item.g, mask, img)
    const ink = refineInk(img, bg, threshold, coarse) ?? coarse
    tiles.push({
      id: `tile-${index}`,
      box: { ...ink },
      ink,
      inkArea: item.g.weight,
      kind: item.kind,
      row: -1,
      col: -1,
    })
  })
  return tiles.sort((a, b) => a.ink.y - b.ink.y || a.ink.x - b.ink.x)
}

function maskRectToSource(g: Group, mask: Mask, img: ImageDataLike): Rect {
  const sx0 = Math.floor((g.x0 * img.width) / mask.mw)
  const sy0 = Math.floor((g.y0 * img.height) / mask.mh)
  const sx1 = Math.min(img.width - 1, Math.ceil(((g.x1 + 1) * img.width) / mask.mw) - 1)
  const sy1 = Math.min(img.height - 1, Math.ceil(((g.y1 + 1) * img.height) / mask.mh) - 1)
  return { x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1 }
}

/** Tighten a downscale-rounded box back to the exact ink extent at full res. */
function refineInk(img: ImageDataLike, bg: SheetBackground, threshold: number, r: Rect): Rect | null {
  const { width: W, data } = img
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (let y = r.y; y < r.y + r.h; y++) {
    const row = y * W
    for (let x = r.x; x < r.x + r.w; x++) {
      if (!isInkPixel(data, (row + x) * 4, bg, threshold)) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < x0) return null
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/**
 * Rows come from the bands; columns from clustering the x-centres across all
 * rows. It is a grid only when every row fills the same columns — otherwise the
 * caller keeps per-icon boxes, which is the honest answer for a free layout.
 */
function inferGrid(tiles: SheetTile[]): SheetGrid | null {
  const icons = tiles.filter((t) => t.kind === 'icon')
  if (icons.length < 2) return null

  const heights = icons.map((t) => t.ink.h).sort((a, b) => a - b)
  const medianH = heights[heights.length >> 1]
  const widths = icons.map((t) => t.ink.w).sort((a, b) => a - b)
  const medianW = widths[widths.length >> 1]

  const rowCentres = cluster1d(icons.map((t) => t.ink.y + t.ink.h / 2), medianH * 0.6)
  const colCentres = cluster1d(icons.map((t) => t.ink.x + t.ink.w / 2), medianW * 0.6)

  for (const t of icons) {
    t.row = nearestIndex(rowCentres, t.ink.y + t.ink.h / 2)
    t.col = nearestIndex(colCentres, t.ink.x + t.ink.w / 2)
  }
  // Re-sort row-major now that positions are known.
  tiles.sort((a, b) => (a.row - b.row) || (a.col - b.col) || (a.ink.y - b.ink.y) || (a.ink.x - b.ink.x))

  const seen = new Set<string>()
  let collision = false
  for (const t of icons) {
    const key = `${t.row}:${t.col}`
    if (seen.has(key)) collision = true
    seen.add(key)
  }
  if (collision || rowCentres.length < 1 || colCentres.length < 1) return null
  if (rowCentres.length === 1 && colCentres.length === 1) return null

  return {
    rows: rowCentres.length,
    cols: colCentres.length,
    pitchY: medianStep(rowCentres),
    pitchX: medianStep(colCentres),
  }
}

/** 1-D single-linkage: split wherever consecutive values are further than `gap`. */
function cluster1d(values: number[], gap: number): number[] {
  const sorted = values.slice().sort((a, b) => a - b)
  const centres: number[] = []
  let start = 0
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i] - sorted[i - 1] > gap) {
      let sum = 0
      for (let k = start; k < i; k++) sum += sorted[k]
      centres.push(sum / (i - start))
      start = i
    }
  }
  return centres
}

function nearestIndex(centres: number[], v: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < centres.length; i++) {
    const d = Math.abs(centres[i] - v)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

function medianStep(centres: number[]): number {
  if (centres.length < 2) return 0
  const steps: number[] = []
  for (let i = 1; i < centres.length; i++) steps.push(centres[i] - centres[i - 1])
  steps.sort((a, b) => a - b)
  return steps[steps.length >> 1]
}

/**
 * Turn ink extents into crop boxes: pad, optionally square, and optionally give
 * every icon the SAME box so their relative sizes survive into the export (a
 * sheet draws a "plus" smaller than a "cloud" on purpose). Uniform boxes are
 * capped at the grid pitch so a tile can never eat its neighbour.
 */
function applyBoxes(tiles: SheetTile[], grid: SheetGrid | null, opts: DetectOptions, warnings: string[]): void {
  const padding = opts.padding ?? DETECT_DEFAULTS.padding
  const square = opts.square ?? DETECT_DEFAULTS.square
  const uniform = opts.uniform ?? DETECT_DEFAULTS.uniform
  const icons = tiles.filter((t) => t.kind === 'icon')

  // Nothing but this icon may end up inside its crop. On a captioned sheet the
  // caption sits ~18px under an icon that is 150px tall, so a padded box lands on
  // the words — and every exported icon would carry a slice of text.
  const blockers = tiles.filter((t) => t.kind !== 'noise')

  let uniformSize = 0
  if (uniform && icons.length > 1) {
    // The biggest icon sets the floor — a uniform box smaller than that would
    // CROP an icon, which is worse than any amount of padding lost. The ceiling
    // is the tightest CORRIDOR any icon sits in (its free room between the things
    // around it), so one size fits every icon without touching a caption.
    let need = 0
    for (const t of icons) need = Math.max(need, Math.max(t.ink.w, t.ink.h))
    let room = grid ? Math.min(grid.pitchX || Infinity, grid.pitchY || Infinity) : Infinity
    for (const t of icons) {
      const c = corridor(t.ink, blockers.filter((o) => o !== t).map((o) => o.ink))
      room = Math.min(room, c.w, c.h)
    }
    uniformSize = Math.max(need, Math.min(need * (1 + 2 * padding), room))
  }

  let crowded = 0
  for (const t of tiles) {
    let w: number
    let h: number
    if (uniformSize > 0 && t.kind === 'icon') {
      w = uniformSize
      h = uniformSize
    } else {
      w = t.ink.w * (1 + 2 * padding)
      h = t.ink.h * (1 + 2 * padding)
      if (square) {
        w = Math.max(w, h)
        h = w
      }
    }
    const others = blockers.filter((o) => o !== t).map((o) => o.ink)
    const placed = placeBox(t.ink, w, h, others)
    t.box = placed.box
    if (!placed.clear) crowded++
  }
  if (crowded > 0) {
    warnings.push(
      `${crowded} icon${crowded === 1 ? '' : 's'} sit${crowded === 1 ? 's' : ''} tight against a neighbour — those crops may catch a sliver of what is next to them.`,
    )
  }
}

/**
 * Place a box of a given size around one icon so it holds all of that icon and
 * none of anything else.
 *
 * The box may SLIDE — an icon shorter than its uniform box has room to spare, and
 * sliding up off a caption keeps every tile the same size, which is the whole
 * point of uniform boxes. Only when sliding cannot clear (a header above AND a
 * caption below) does it shrink, and never past the icon's own ink.
 */
function placeBox(ink: Rect, wantW: number, wantH: number, others: Rect[]): { box: Rect; clear: boolean } {
  let w = Math.max(wantW, ink.w)
  let h = Math.max(wantH, ink.h)

  // Only what could ever be reached matters — an icon at the far end of the sheet
  // is not a constraint, and the position search below is quadratic in this set.
  const reach = Math.max(w, h) + Math.max(ink.w, ink.h)
  const cx = ink.x + ink.w / 2
  const cy = ink.y + ink.h / 2
  const near = others.filter(
    (r) => r.x < cx + reach && r.x + r.w > cx - reach && r.y < cy + reach && r.y + r.h > cy - reach,
  )

  for (let attempt = 0; attempt < 4; attempt++) {
    const pos = findPosition(ink, w, h, near)
    if (pos) return { box: round(pos.x, pos.y, w, h), clear: true }

    // Boxed in on every side at this size (a header above AND a caption below is
    // the usual reason) — shrink against the worst offender and try again. The
    // neighbour's ink never overlaps this icon's own, so a shrink always exists,
    // and it can never cut into the icon itself.
    const x = clamp(cx - w / 2, ink.x + ink.w - w, ink.x)
    const y = clamp(cy - h / 2, ink.y + ink.h - h, ink.y)
    const worst = worstOverlap(x, y, w, h, near)
    if (!worst) return { box: round(x, y, w, h), clear: false }

    let best: { w: number; h: number } | null = null
    let bestArea = -1
    const tryShrink = (nw: number, nh: number) => {
      if (nw < ink.w - 0.001 || nh < ink.h - 0.001) return
      if (nw * nh > bestArea) {
        bestArea = nw * nh
        best = { w: nw, h: nh }
      }
    }
    // Each option keeps the ink and gives up the side the offender is on.
    tryShrink(worst.x - ink.x, h)
    tryShrink(ink.x + ink.w - (worst.x + worst.w), h)
    tryShrink(w, worst.y - ink.y)
    tryShrink(w, ink.y + ink.h - (worst.y + worst.h))
    if (!best) return { box: round(x, y, w, h), clear: false }
    w = (best as { w: number; h: number }).w
    h = (best as { w: number; h: number }).h
  }
  const x = clamp(cx - w / 2, ink.x + ink.w - w, ink.x)
  const y = clamp(cy - h / 2, ink.y + ink.h - h, ink.y)
  return { box: round(x, y, w, h), clear: !worstOverlap(x, y, w, h, near) }
}

/**
 * The position for a fixed-size box that holds `ink` and no `others`, closest to
 * centred on the ink.
 *
 * Every side of every blocker is a candidate edge, so the feasible set — if it is
 * non-empty — always contains one of the candidate positions. Trying them all is
 * what keeps this from oscillating: sliding "up off the caption, down off the
 * header, up off the caption…" never terminates when each move is chosen against
 * one blocker at a time.
 */
function findPosition(ink: Rect, w: number, h: number, others: Rect[]): { x: number; y: number } | null {
  const minX = ink.x + ink.w - w
  const maxX = ink.x
  const minY = ink.y + ink.h - h
  const maxY = ink.y
  if (minX > maxX + 0.001 || minY > maxY + 0.001) return null

  const wantX = clamp(ink.x + ink.w / 2 - w / 2, minX, maxX)
  const wantY = clamp(ink.y + ink.h / 2 - h / 2, minY, maxY)
  const xs = [wantX, minX, maxX]
  const ys = [wantY, minY, maxY]
  for (const r of others) {
    xs.push(r.x - w, r.x + r.w)
    ys.push(r.y - h, r.y + r.h)
  }

  let best: { x: number; y: number } | null = null
  let bestCost = Infinity
  for (const rawX of xs) {
    const x = clampExact(rawX, minX, maxX)
    if (x === null) continue
    for (const rawY of ys) {
      const y = clampExact(rawY, minY, maxY)
      if (y === null) continue
      const cost = Math.abs(x - wantX) + Math.abs(y - wantY)
      if (cost >= bestCost) continue
      if (worstOverlap(x, y, w, h, others)) continue
      bestCost = cost
      best = { x, y }
    }
  }
  return best
}

function worstOverlap(x: number, y: number, w: number, h: number, others: Rect[]): Rect | null {
  let worst: Rect | null = null
  let worstArea = 0
  for (const r of others) {
    const ox = Math.min(x + w, r.x + r.w) - Math.max(x, r.x)
    const oy = Math.min(y + h, r.y + r.h) - Math.max(y, r.y)
    if (ox <= 0.001 || oy <= 0.001) continue
    const area = ox * oy
    if (area > worstArea) {
      worstArea = area
      worst = r
    }
  }
  return worst
}

/**
 * The free room around an icon: how far it is to the nearest thing on each side,
 * counting only what lies across from it. This is the largest box the icon can
 * have without meeting a neighbour, and the tightest one over the whole sheet is
 * what a uniform size has to respect.
 */
function corridor(ink: Rect, others: Rect[]): { w: number; h: number } {
  let top = -Infinity
  let bottom = Infinity
  let left = -Infinity
  let right = Infinity
  for (const r of others) {
    if (r.x < ink.x + ink.w && r.x + r.w > ink.x) {
      if (r.y + r.h <= ink.y) top = Math.max(top, r.y + r.h)
      else if (r.y >= ink.y + ink.h) bottom = Math.min(bottom, r.y)
    }
    if (r.y < ink.y + ink.h && r.y + r.h > ink.y) {
      if (r.x + r.w <= ink.x) left = Math.max(left, r.x + r.w)
      else if (r.x >= ink.x + ink.w) right = Math.min(right, r.x)
    }
  }
  return { w: right - left, h: bottom - top }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** Like `clamp`, but rejects a value that was never in range to begin with. */
function clampExact(v: number, lo: number, hi: number): number | null {
  if (v < lo - 0.001 || v > hi + 0.001) return null
  return clamp(v, lo, hi)
}

function round(x: number, y: number, w: number, h: number): Rect {
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/**
 * The manual escape hatch: an evenly divided grid. When auto-detection reads a
 * sheet wrong (touching icons, a busy background), saying "3 × 3" is faster than
 * any amount of threshold twiddling — and it is exactly how these sheets are
 * generated in the first place.
 */
export function gridTiles(
  width: number,
  height: number,
  spec: { rows: number; cols: number; margin?: number; gutter?: number },
): SheetTile[] {
  const rows = Math.max(1, Math.round(spec.rows))
  const cols = Math.max(1, Math.round(spec.cols))
  const margin = Math.max(0, spec.margin ?? 0)
  const gutter = Math.max(0, spec.gutter ?? 0)
  const cellW = (width - 2 * margin - gutter * (cols - 1)) / cols
  const cellH = (height - 2 * margin - gutter * (rows - 1)) / rows
  const tiles: SheetTile[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const box: Rect = {
        x: Math.round(margin + c * (cellW + gutter)),
        y: Math.round(margin + r * (cellH + gutter)),
        w: Math.round(cellW),
        h: Math.round(cellH),
      }
      tiles.push({
        id: `grid-${r}-${c}`,
        box,
        ink: { ...box },
        inkArea: box.w * box.h,
        kind: 'icon',
        row: r,
        col: c,
      })
    }
  }
  return tiles
}
