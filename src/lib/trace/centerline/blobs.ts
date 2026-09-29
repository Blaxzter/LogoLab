// Stroke or fill? Line art is mostly strokes of one width, and the rest — a note head
// under its stem, the dot of an i, a solid wheel — is ink no stroke explains. The
// split is decided on the ink, not on the skeleton: paint every centreline point's disc
// (its measured half-width plus a margin) into a STROKE mask, and whatever ink is left
// over is a blob. That makes it indifferent to what thinning did inside the blob, where
// the skeleton is a thicket of spurs the pruning removes anyway.
//
// The one number this rests on is the picture's stroke width W: the median of every
// readable point width. A point wider than max(1.6·W, W + 2) is inside something fatter
// than a stroke and is left out of the stroke mask; the leftover ink it sits in becomes a
// fill — unless the wide stretch is long and its width uniform, which is a thick stroke
// beside thin ones, not a fill (`blobFlags`). Leftover slivers that only touch a stroke (a miter tip beyond
// a round join, the corners of a butt cap) are residue and are dropped; an island of ink
// that touches no stroke at all is always kept, whatever its size — a dot is a mark.

import type { Centreline } from './profile.ts'

export const BLOB_K = 1.6
/** Margin (px) added to a point's half-width when painting the stroke mask. */
const STROKE_MASK_MARGIN = 0.75
/** A blob point's inscribed radius must be at least this share of the blob width: a wide
 *  PROFILE with a small radius is two thin strokes side by side (a slur running along a
 *  staff line), not a fill. */
export const BLOB_MIN_DT_K = 0.4
/** A leftover blob grows into stroke-mask pixels beside it whose inscribed radius is at
 *  least this share of the blob width: the band a staff line paints through a note head
 *  is deep ink that belongs to the head, and the head comes back whole. */
const BLOB_GROW_DT_K = 0.4
/** A blob also grows into a stroke-mask pixel whose ink, measured ACROSS the stroke, runs
 *  further than the stroke's own width plus this (px): the mouth of the bay a stem's
 *  channel cuts into a disc's rim, where the inscribed radius is already too small for the
 *  rule above (it is bounded by the paper pockets beside the stem) but the ink through
 *  the pixel is the disc's, not the stem's. */
const BLOB_BRIDGE_RUN_PLUS = 2.5

export interface BlobSplit {
  /** The picture's stroke width (px). */
  W: number
  /** Width above which a point is inside a blob. */
  blobWidth: number
  /** 1 where the ink is a fill, or null when the picture is strokes only. */
  blobMask: Uint8Array | null
  blobPixels: number
}

/** Length-weighted median of the readable widths, or `fallback` when none are readable. */
export function strokeWidthOf(lines: Centreline[], fallback: number): number {
  const ws: number[] = []
  for (const l of lines) for (let k = 0; k < l.w.length; k++) if (Number.isFinite(l.w[k]) && l.w[k] > 0) ws.push(l.w[k])
  if (ws.length === 0) return fallback
  ws.sort((a, b) => a - b)
  return ws[ws.length >> 1]
}

export function splitBlobs(
  lines: Centreline[],
  ink: Uint8Array,
  dt: Float32Array,
  width: number,
  height: number,
): BlobSplit {
  // Fallback W: twice the typical inscribed radius of the ink.
  let dtSum = 0
  let dtN = 0
  for (let i = 0; i < ink.length; i++)
    if (ink[i]) {
      dtSum += dt[i]
      dtN++
    }
  const W = strokeWidthOf(lines, dtN ? (2 * dtSum) / dtN : 2)
  const blobWidth = Math.max(BLOB_K * W, W + 2)

  const stroke = new Uint8Array(width * height)
  const paint = (cx: number, cy: number, r: number): void => {
    const x0 = Math.max(0, Math.floor(cx - r))
    const x1 = Math.min(width - 1, Math.ceil(cx + r))
    const y0 = Math.max(0, Math.floor(cy - r))
    const y1 = Math.min(height - 1, Math.ceil(cy + r))
    const r2 = r * r
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx
        if (dx * dx + dy * dy <= r2) stroke[y * width + x] = 1
      }
    }
  }
  // Per channel pixel, the stroke that painted it: its normal (quantized angle over
  // [0, π)) and its chain's own width, for the bridge rule below.
  const chanAng = new Uint8Array(width * height)
  const chanW = new Float32Array(width * height)
  for (const l of lines) {
    const wAt = filledWidths(l)
    const flags = blobFlags(l, blobWidth)
    const wChain = strokeWidthOf([l], W)
    const n = l.pts.length
    for (let k = 0; k < n; k++) {
      const wk = wAt[k]
      if (!Number.isFinite(wk) || flags[k]) continue
      // A reading past the chain's own width and a quarter (or the blob bar, whichever
      // is more) is the profile FLARING into a fill or across a junction, not a wider
      // stroke: painted at its own width it reached 16 px into a note head from the
      // stem's last points before the rim. Capping at the blob bar ALONE also capped a
      // uniform thick stroke (an 18 px S beside 6 px ones, whose chain median is 18)
      // and its outer band became a fill; the chain's own width cannot cap itself.
      const r = Math.min(wk, Math.max(blobWidth, 1.25 * wChain)) / 2 + STROKE_MASK_MARGIN
      const p0 = l.pts[Math.max(0, k - 1)]
      const p1 = l.pts[Math.min(n - 1, k + 1)]
      const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) + Math.PI / 2
      const q = Math.round(((((ang % Math.PI) + Math.PI) % Math.PI) / Math.PI) * 256) & 255
      const cx = l.pts[k].x
      const cy = l.pts[k].y
      const x0 = Math.max(0, Math.floor(cx - r))
      const x1 = Math.min(width - 1, Math.ceil(cx + r))
      const y0 = Math.max(0, Math.floor(cy - r))
      const y1 = Math.min(height - 1, Math.ceil(cy + r))
      for (let y = y0; y <= y1; y++) {
        const dy = y + 0.5 - cy
        for (let x = x0; x <= x1; x++) {
          const dx = x + 0.5 - cx
          if (dx * dx + dy * dy > r * r) continue
          const i = y * width + x
          chanAng[i] = q
          chanW[i] = wChain
        }
      }
      paint(cx, cy, r)
    }
  }

  // Leftover ink → components; drop residue (small AND touching a stroke).
  const n = width * height
  const left = new Uint8Array(n)
  for (let i = 0; i < n; i++) left[i] = ink[i] && !stroke[i] ? 1 : 0
  const minArea = Math.max(6, 1.2 * W * W)
  const seen = new Uint8Array(n)
  const blob = new Uint8Array(n)
  const stack: number[] = []
  const members: number[] = []
  let blobPixels = 0
  for (let s = 0; s < n; s++) {
    if (!left[s] || seen[s]) continue
    stack.length = 0
    members.length = 0
    stack.push(s)
    seen[s] = 1
    let touches = false
    let maxDt = 0
    while (stack.length) {
      const p = stack.pop()!
      members.push(p)
      if (dt[p] > maxDt) maxDt = dt[p]
      const x = p % width
      const y = (p / width) | 0
      const nb = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]
      for (const q of nb) {
        if (q < 0) continue
        if (stroke[q]) touches = true
        if (left[q] && !seen[q]) {
          seen[q] = 1
          stack.push(q)
        }
      }
    }
    if (touches && (members.length < minArea || maxDt < blobWidth / 2)) continue
    for (const p of members) blob[p] = 1
    blobPixels += members.length
  }
  if (blobPixels > 0) {
    // Grow each blob into the deep stroke-mask ink beside it (a stroke crossing a fill
    // painted its band through it; the band's pixels inside the fill read a large
    // radius, the band outside does not).
    // Deeper than the blob bar AND deeper than any plain stroke: a 2 px staff line cut
    // to 3 px by the mono threshold reads a radius of 2, and at 0.4 of a 4 px blob
    // width the growth ran the length of the staff.
    const growDt = Math.max(BLOB_GROW_DT_K * blobWidth, W + 0.5)
    // The bridge rule: the ink through the pixel, measured along the stroke's normal
    // both ways to paper, is longer than the stroke is wide. Inside the bay a stem cuts
    // into a disc's rim that run is the disc's chord; on the stem past the rim it is the
    // stem's width. Cached per pixel — the queue asks about a pixel once per neighbour.
    const bridged = new Uint8Array(n) // 0 unasked, 1 yes, 2 no
    const runsAcross = (q: number): boolean => {
      if (bridged[q]) return bridged[q] === 1
      let ok = false
      if (stroke[q]) {
        const ang = (chanAng[q] / 256) * Math.PI
        const nx = Math.cos(ang)
        const ny = Math.sin(ang)
        const need = chanW[q] + 2 * STROKE_MASK_MARGIN + BLOB_BRIDGE_RUN_PLUS
        const reach = Math.ceil(need) + 1
        const x = (q % width) + 0.5
        const y = ((q / width) | 0) + 0.5
        let run = 1
        for (const sgn of [1, -1]) {
          for (let s = 1; s <= reach; s++) {
            const px = Math.floor(x + sgn * nx * s)
            const py = Math.floor(y + sgn * ny * s)
            if (px < 0 || py < 0 || px >= width || py >= height || !ink[py * width + px]) break
            run++
          }
        }
        ok = run > need
      }
      bridged[q] = ok ? 1 : 2
      return ok
    }
    const queue: number[] = []
    for (let i = 0; i < n; i++) if (blob[i]) queue.push(i)
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head]
      const x = p % width
      const y = (p / width) | 0
      const nb = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]
      for (const q of nb) {
        if (q < 0 || blob[q] || !ink[q]) continue
        // Residue — leftover ink no stroke disc painted, dropped above as too small or
        // too shallow to be a fill by itself — is the fill's when the fill reaches it.
        // Inside a note head the stem's chain points read the head's chord and are
        // flagged as blob, so they paint nothing while their neighbours' discs cover
        // everything around them: their own pixels were one- and two-pixel islands
        // ringed by stroke mask, dropped, and holes in the head (three fills at 2048).
        // A miter tip beside a stroke that never meets a fill is never reached.
        if (!left[q] && dt[q] < growDt && !runsAcross(q)) continue
        blob[q] = 1
        blobPixels++
        queue.push(q)
      }
    }
    // Holes. An island of ink the growth did not reach but the fill SURROUNDS — no
    // pixel of it touches paper or the border — is the fill's: the ink has no hole
    // there, so the fill must not either. The stem's chain runs on into a note head
    // along the head's own axis, and the discs its points paint there carry that
    // diagonal as their normal; near the pocket where the stem meets the rim the run
    // along that diagonal is short on both sides, and a few pixels stayed unclaimed
    // inside the head — three fills at 2048, the head's with 19 nodes, `missed` 6.7 px
    // of the stem's own centreline.
    const seenIsle = new Uint8Array(n)
    const isle: number[] = []
    for (let s0 = 0; s0 < n; s0++) {
      if (!ink[s0] || blob[s0] || seenIsle[s0]) continue
      isle.length = 0
      stack.length = 0
      stack.push(s0)
      seenIsle[s0] = 1
      let open = false
      while (stack.length) {
        const p = stack.pop()!
        isle.push(p)
        const x = p % width
        const y = (p / width) | 0
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) open = true
        const nb = [
          x > 0 ? p - 1 : -1,
          x < width - 1 ? p + 1 : -1,
          y > 0 ? p - width : -1,
          y < height - 1 ? p + width : -1,
        ]
        for (const q of nb) {
          if (q < 0) continue
          if (!ink[q]) {
            open = true
            continue
          }
          if (blob[q] || seenIsle[q]) continue
          seenIsle[q] = 1
          stack.push(q)
        }
      }
      if (open) continue
      for (const p of isle) {
        blob[p] = 1
        blobPixels++
      }
    }
  }
  return { W, blobWidth, blobMask: blobPixels > 0 ? blob : null, blobPixels }
}

/** Widths with the unreadable (junction-zone) points borrowing the nearest readable one. */
function filledWidths(l: Centreline): Float32Array {
  const wAt = new Float32Array(l.w.length)
  let lastW = NaN
  for (let k = 0; k < l.w.length; k++) {
    if (Number.isFinite(l.w[k])) lastW = l.w[k]
    wAt[k] = lastW
  }
  lastW = NaN
  for (let k = l.w.length - 1; k >= 0; k--) {
    if (Number.isFinite(l.w[k])) lastW = l.w[k]
    if (!Number.isFinite(wAt[k])) wAt[k] = lastW
  }
  return wAt
}

/** Shortest stretch of blob-wide points that can still be a stroke, in its own widths. */
const THICK_STROKE_MIN_LEN = 2
/** p90/p10 of the widths along a wide stretch below which it is a uniform stroke. */
const THICK_STROKE_MAX_SPREAD = 1.3
/** A wide stretch inside a chain no longer than this many blob-widths is a corner or a crossing. */
const CROSSING_MAX_LEN_W = 1.5

/**
 * Which points of a centreline are inside a blob: wider than `blobWidth` AND deep
 * (an inscribed radius of at least 0.4 of it — a wide profile over a shallow radius is
 * two thin strokes running side by side), unless the wide stretch is long (≥ 2 of its
 * own widths) and UNIFORM — that is a thick stroke
 * beside thin ones (the wide end of a width ladder, a bold rule under fine text), not
 * a fill — or short and flanked by stroke on both sides, which is a sharp corner or a
 * crossing the profile read across. A fill's width varies along its skeleton, and the
 * stretch sits at the chain's end (the stem stops inside the note head).
 */
export function blobFlags(l: Centreline, blobWidth: number): Uint8Array {
  const n = l.w.length
  const wAt = filledWidths(l)
  const flags = new Uint8Array(n)
  const minDt = BLOB_MIN_DT_K * blobWidth
  for (let k = 0; k < n; k++) if (Number.isFinite(wAt[k]) && wAt[k] > blobWidth && l.dtAt[k] >= minDt) flags[k] = 1
  // Re-admit uniform thick stretches, and short ones with stroke on both sides. On a
  // ring the stretches wrap, so start the scan at an unflagged point.
  let flaggedAll = true
  let origin = 0
  for (let k = 0; k < n; k++)
    if (!flags[k]) {
      flaggedAll = false
      origin = k
      break
    }
  // A chain flagged end to end is one stretch: a thick stroke on its own (the wide end
  // of a width ladder), or a fill's whole skeleton — the uniformity test below decides.
  const idx = (k: number): number => (l.closed && !flaggedAll ? (origin + k) % n : k)
  let k = 0
  while (k < n) {
    if (!flags[idx(k)]) {
      k++
      continue
    }
    const s = k
    while (k < n && flags[idx(k)]) k++
    const ws: number[] = []
    let len = 0
    for (let i = s; i < k; i++) {
      ws.push(wAt[idx(i)])
      if (i > s) len += Math.hypot(l.pts[idx(i)].x - l.pts[idx(i - 1)].x, l.pts[idx(i)].y - l.pts[idx(i - 1)].y)
    }
    ws.sort((a, b) => a - b)
    const p10 = ws[Math.floor(0.1 * (ws.length - 1))]
    const p90 = ws[Math.floor(0.9 * (ws.length - 1))]
    const med = ws[ws.length >> 1]
    const uniformThick = len >= THICK_STROKE_MIN_LEN * med && p90 / Math.max(1e-6, p10) <= THICK_STROKE_MAX_SPREAD
    // A short wide stretch INSIDE a chain — stroke on both sides of it — is where the
    // profile crossed a corner or another stroke and read both, not a fill. Its widths
    // are unread (NaN) so they neither cut the chain nor shift its width.
    const interior = l.closed || (s > 0 && k < n)
    const shortCrossing = interior && len <= CROSSING_MAX_LEN_W * blobWidth
    if (uniformThick || shortCrossing) {
      for (let i = s; i < k; i++) {
        flags[idx(i)] = 0
        if (shortCrossing && !uniformThick) l.w[idx(i)] = NaN
      }
    }
  }
  return flags
}

/**
 * Cut every centreline into its stroke runs. A chain that ENDS inside a blob (a stem
 * into a note head) is cut there, and the run remembers that its end stopped at a
 * fill. A blob stretch INSIDE a chain — a staff line through a note head, a ring with
 * a dot on it — does not cut it: the stroke passes through the fill, drawn under it,
 * and the points inside (where the skeleton is the fill's, not the stroke's) are
 * dropped so the stroke bridges the fill straight.
 */
export interface StrokeRun {
  pts: { x: number; y: number }[]
  w: Float32Array
  /** The chain's end nodes, kept even where the run was cut back at a fill before them. */
  a: number
  b: number
  closed: boolean
  /** The run's start / end was cut at a blob (the stroke enters a fill there). */
  blobAtA: boolean
  blobAtB: boolean
  source: Centreline
}

export function strokeRuns(lines: Centreline[], split: BlobSplit, width: number): StrokeRun[] {
  const out: StrokeRun[] = []
  const onBlob = (p: { x: number; y: number }): boolean => {
    if (!split.blobMask) return false
    const x = Math.floor(p.x)
    const y = Math.floor(p.y)
    return split.blobMask[y * width + x] === 1
  }
  for (const l of lines) {
    const n = l.pts.length
    const isBlob = blobFlags(l, split.blobWidth)
    let any = false
    for (let k = 0; k < n; k++) {
      if (!isBlob[k] && onBlob(l.pts[k])) isBlob[k] = 1
      if (isBlob[k]) any = true
    }
    if (!any) {
      out.push({ pts: l.pts, w: l.w, a: l.a, b: l.b, closed: l.closed, blobAtA: false, blobAtB: false, source: l })
      continue
    }
    // Leading and trailing blob stretches (an open chain) cut the chain; interior ones
    // are bridged. A ring has no ends, so every stretch on it is bridged.
    let lo = 0
    let hi = n - 1
    if (!l.closed) {
      while (lo < n && isBlob[lo]) lo++
      while (hi >= 0 && isBlob[hi]) hi--
    }
    if (hi - lo < 1) continue
    const pts: { x: number; y: number }[] = []
    const w: number[] = []
    for (let k = lo; k <= hi; k++) {
      if (isBlob[k]) continue
      pts.push(l.pts[k])
      w.push(l.w[k])
    }
    if (pts.length < 2) continue
    // A run cut back at a fill keeps the node beyond it: the two halves of a staff
    // line meeting at a junction inside a note head still pair through it (bridged
    // straight under the fill), and a stem that ends in the head ends at the meet.
    out.push({
      pts,
      w: Float32Array.from(w),
      a: l.a,
      b: l.b,
      closed: l.closed,
      blobAtA: lo > 0,
      blobAtB: hi < n - 1,
      source: l,
    })
  }
  return out
}
