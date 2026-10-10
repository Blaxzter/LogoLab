// Where a stroke ENDS, and how. Thinning stops a skeleton about half a width short of
// the ink's end (the cap is peeled from every side at once), so a free end is walked
// forward along its tangent until the coverage drops below 0.5 — that is the ink's end.
// Whether the cap is flat or round is read there too: just inside a flat (butt / square)
// end the ink is still full-width, so a sample on either flank at 0.85 r is ink; inside
// a round cap those flanks have already fallen away. A round cap's centreline ends one
// radius short of the ink; a flat one ends at the ink.
//
// A stroke that stops because it entered a fill (blobAt*) is walked with the fill
// counted as paper and then pushed half a width into it, so the stroke and the fill
// overlap rather than leave a hairline gap between them.

import type { Vec } from '../../path/types'
import { covAt, type CoverageField } from './profile.ts'

export type CapKind = 'butt' | 'round'

/** Unit direction of the run's last `span` px at `side`, pointing OUT of the run. */
export function outwardTangent(pts: Vec[], side: 'a' | 'b', span: number): Vec | null {
  const n = pts.length
  if (n < 2) return null
  const seq = side === 'b' ? pts : pts.slice().reverse()
  // Accumulate arc length backwards from the end until `span`.
  let acc = 0
  let k = n - 1
  while (k > 0 && acc < span) {
    acc += Math.hypot(seq[k].x - seq[k - 1].x, seq[k].y - seq[k - 1].y)
    k--
  }
  // Least-squares direction over seq[k..n-1], oriented toward the end.
  let mx = 0
  let my = 0
  const m = n - k
  for (let i = k; i < n; i++) {
    mx += seq[i].x
    my += seq[i].y
  }
  mx /= m
  my /= m
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (let i = k; i < n; i++) {
    const dx = seq[i].x - mx
    const dy = seq[i].y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  let dx: number
  let dy: number
  if (m < 3 || sxx + syy < 1e-9) {
    dx = seq[n - 1].x - seq[k].x
    dy = seq[n - 1].y - seq[k].y
  } else {
    // Principal axis of the 2×2 scatter.
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    dx = Math.cos(theta)
    dy = Math.sin(theta)
    // Orient toward the end.
    const ex = seq[n - 1].x - seq[k].x
    const ey = seq[n - 1].y - seq[k].y
    if (dx * ex + dy * ey < 0) {
      dx = -dx
      dy = -dy
    }
  }
  const len = Math.hypot(dx, dy)
  if (len < 1e-9) return null
  return { x: dx / len, y: dy / len }
}

/** How far back from a free end, in half-widths, a hook may reach. */
export const END_HOOK_R = 2
/** A hook point lies more than this many half-widths off the run's line. */
export const END_HOOK_TOL_R = 0.15

/**
 * Drop a free end's HOOK: thinning keeps a flat end's corner pixels, so the chain's own
 * last points curl into one corner of the butt cap (not a branch, so spur pruning never
 * sees it). Within `END_HOOK_R` half-widths of the end, trailing points more than
 * `END_HOOK_TOL_R` half-widths off the line the run follows before them are cut;
 * `readEnd` then walks the end out along that line. Returns `pts` itself when nothing is
 * cut.
 */
export function dropEndHook(pts: Vec[], side: 'a' | 'b', r: number): Vec[] {
  const n = pts.length
  const seq = side === 'b' ? pts : pts.slice().reverse()
  const reach = Math.max(2, END_HOOK_R * r)
  // The body: the points before the last `reach` px.
  let k = n - 1
  let acc = 0
  while (k > 0 && acc < reach) {
    acc += Math.hypot(seq[k].x - seq[k - 1].x, seq[k].y - seq[k - 1].y)
    k--
  }
  if (k < 2) return pts
  const body = seq.slice(0, k + 1)
  const t = outwardTangent(body, 'b', Math.max(3, 3 * r))
  if (!t) return pts
  const at = body[body.length - 1]
  const tol = Math.max(0.5, END_HOOK_TOL_R * r)
  const off = (p: Vec): number => Math.abs((p.x - at.x) * t.y - (p.y - at.y) * t.x)
  let m = n
  while (m - 1 > k && off(seq[m - 1]) > tol) m--
  if (m === n) return pts
  const kept = seq.slice(0, m)
  return side === 'b' ? kept : kept.reverse()
}

export interface EndRead {
  /** Where the centreline ends. */
  end: Vec
  cap: CapKind
  /** How far past the run's last point the end lies (negative = the run overshot). */
  advance: number
}

/**
 * Walk a free end out to the ink's end and read the cap. `r` is the stroke's half-width
 * at this end; `stop`, when given, is a mask (1 = fill) that counts as paper.
 */
export function readEnd(
  pts: Vec[],
  side: 'a' | 'b',
  r: number,
  f: CoverageField,
  stop: Uint8Array | null,
  intoFill: boolean,
): EndRead {
  const last = side === 'b' ? pts[pts.length - 1] : pts[0]
  const t = outwardTangent(pts, side, Math.max(3, 3 * r))
  if (!t) return { end: last, cap: 'round', advance: 0 }
  const cov = (x: number, y: number): number => {
    if (stop) {
      const px = Math.floor(x)
      const py = Math.floor(y)
      if (px >= 0 && py >= 0 && px < f.width && py < f.height && stop[py * f.width + px]) return 0
    }
    return covAt(f, x, y)
  }
  const STEP = 0.25
  const maxS = 3 * r + 3
  let s = 0
  let prev = cov(last.x, last.y)
  let inkEnd = 0
  // The run's last point can sit just outside the 0.5 contour on a hairline; give it a
  // pixel of grace before requiring coverage.
  if (prev < 0.5) {
    let found = false
    for (let s2 = STEP; s2 <= 1.5; s2 += STEP) {
      if (cov(last.x + s2 * t.x, last.y + s2 * t.y) >= 0.5) {
        s = s2
        prev = 1
        found = true
        break
      }
    }
    if (!found) return { end: last, cap: 'round', advance: 0 }
  }
  for (;;) {
    const s2 = s + STEP
    const c = cov(last.x + s2 * t.x, last.y + s2 * t.y)
    if (c < 0.5 || s2 > maxS) {
      inkEnd = c < 0.5 ? s + ((prev - 0.5) / Math.max(1e-6, prev - c)) * STEP : s2
      break
    }
    prev = c
    s = s2
  }
  if (intoFill) {
    // Overlap the fill by half a width; the paint order hides it.
    const adv = inkEnd + r
    return { end: { x: last.x + adv * t.x, y: last.y + adv * t.y }, cap: 'butt', advance: adv }
  }
  // Cap read, 0.25 r inside the ink's end: a flat cap is still full-width there, a
  // round one (centre r inside) has thinned to √(1 − 0.75²) = 0.66 r, so flanks at
  // 0.85 r are ink for flat and paper for round.
  const n = { x: -t.y, y: t.x }
  const q = { x: last.x + (inkEnd - 0.25 * r) * t.x, y: last.y + (inkEnd - 0.25 * r) * t.y }
  const flank = 0.85 * r
  const flat =
    r >= 1 && cov(q.x + flank * n.x, q.y + flank * n.y) >= 0.5 && cov(q.x - flank * n.x, q.y - flank * n.y) >= 0.5
  const adv = flat ? inkEnd : inkEnd - r
  return { end: { x: last.x + adv * t.x, y: last.y + adv * t.y }, cap: flat ? 'butt' : 'round', advance: adv }
}

/**
 * Apply an end read to a run: drop trailing points that lie past the new end along the
 * tangent, then append it. Returns the new point list (widths for the added point are
 * the caller's to fill).
 */
export function applyEnd(pts: Vec[], side: 'a' | 'b', read: EndRead): Vec[] {
  const seq = side === 'b' ? pts.slice() : pts.slice().reverse()
  const t = outwardTangent(seq, 'b', 3)
  if (t) {
    const proj = read.end.x * t.x + read.end.y * t.y
    while (seq.length > 2 && seq[seq.length - 1].x * t.x + seq[seq.length - 1].y * t.y >= proj - 0.05) seq.pop()
  }
  seq.push({ x: read.end.x, y: read.end.y })
  return side === 'b' ? seq : seq.reverse()
}
