// Bar-end cap resolver: classify a corner group as a cap and snap its two corners to the cap chord.

import type { Vec } from '../../path/types'
import { SNAP_COLLINEAR, SNAP_SPAN, armGap, armLine } from './arms.ts'
import { CORNER_WINDOW, readTurnCos } from './corners.ts'
import { dist, neg, perpDistance, sub, unit } from './geom.ts'

/**
 * Bar-end cap resolver. Inside a cap narrower than ~2·CORNER_WINDOW the ±win turn test
 * cannot separate the two 90° shoulders: every vertex on the cap sees both shoulders
 * through the window and reads a diluted 60–90° turn, so the apex count and placement
 * depend on staircase phase (one apex with the far corner bevelled away, three blunt
 * ones, or two a px off the corners).
 *
 * The resolver re-reads each apex group (sub-threshold runs joined across gaps
 * ≤ CAP_JOIN_GAP) and classifies it as a cap on three pieces of evidence:
 *   • through-turn: travel direction reverses across the group (a bar end U-turns; a
 *     zigzag of corners nets a small turn and never qualifies);
 *   • chord: the group spans a cap-sized chord (a rasterized tip plateau is ≤2px and
 *     stays a tip; a wider cap already resolves into two clean shoulder runs);
 *   • flatness: every group vertex sits within CAP_FLAT px of the group chord (a star
 *     tip's V dips several px below its shoulder chord — this is what makes a cap a cap
 *     and a tip a tip).
 * A classified cap contributes exactly two corners — the group's outermost sub-threshold
 * vertices — and the arc between them is fitted as a straight line with both endpoints
 * snapped to the intersection of the adjacent long arm with the cap-chord line
 * (displacement capped at CAP_SNAP_MAX). Unclassified groups keep their detector apexes.
 */
// The constants below sit on a plateau (±1 notch changes nothing) except
// CAP_EXTEND_DEV: lower costs cap placement, higher starts eating real corners.
/** Arms must be anti-parallel within this (deg): a butt cap U-turns (~180°). */
const CAP_ANTIPARALLEL_DEG = 150
const CAP_CHORD_MIN = 3
const CAP_CHORD_MAX = 10
/** Max perp deviation (px) of the A..B interior from the A→B chord — what makes
 *  a cap a cap and a star-tip V a tip. */
const CAP_FLAT = 1.3
const CAP_JOIN_GAP = 6
export const CAP_SNAP_MAX = 2.5
/** Arm seed starts this many steps outside the group center… */
const CAP_ARM_K = 10
/** …and spans this many vertices. Both sides must be straight (collinear). */
const CAP_ARM_SEED = 6
/** Arm-extension tolerance (px). Looser than SNAP_COLLINEAR: an AA edge at a half-pixel
 *  phase chatters ±1px around its mean line, which is noise, while the cap turn deviates
 *  2px+ and still stops the extension. */
const CAP_EXTEND_DEV = 1.2

interface ResolvedCaps {
  /** Revised corner list (raw pts indices, ascending). */
  corners: number[]
  /** Corner index c (a pts index) such that the arc c → next corner is a cap. */
  capStarts: Set<number>
}

export function resolveLoopCaps(pts: Vec[], corners: number[], turnDeg: number, win = CORNER_WINDOW): ResolvedCaps {
  const n = pts.length
  const none = (): ResolvedCaps => ({ corners, capStarts: new Set() })
  if (corners.length < 1 || turnDeg >= 180 || n < 2 * win + 1) return none()
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  // Must be the same reading the detector used: a group here is a run of `sharp`
  // vertices, and a corner that falls in no group is dropped below.
  const cos = readTurnCos(pts, true, win, 0, n)
  const sharp = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (cos[i] < thr) sharp[i] = 1
  // Maximal cyclic runs of sub-threshold vertices, in loop order.
  const runs: { s: number; e: number }[] = []
  const seen = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!sharp[i] || seen[i]) continue
    let s = i
    while (sharp[wrap(s - 1)] && wrap(s - 1) !== i) s = wrap(s - 1)
    let e = s
    let len = 1
    seen[s] = 1
    while (sharp[wrap(e + 1)] && wrap(e + 1) !== s) {
      e = wrap(e + 1)
      seen[e] = 1
      len++
      if (len >= n) break
    }
    runs.push({ s, e })
  }
  if (runs.length === 0) return none()
  runs.sort((a, b) => a.s - b.s)
  // Join runs across gaps ≤ CAP_JOIN_GAP into groups (cyclic — the last may wrap onto
  // the first). A group is one candidate feature: a cap's two shoulder runs, or a
  // fused cap run, or an ordinary lone corner cluster.
  const gap = (a: { e: number }, b: { s: number }): number => wrap(b.s - a.e) - 1
  const groups: { s: number; e: number }[] = []
  let cur = { ...runs[0] }
  for (let k = 1; k < runs.length; k++) {
    if (gap(cur, runs[k]) <= CAP_JOIN_GAP) cur.e = runs[k].e
    else {
      groups.push(cur)
      cur = { ...runs[k] }
    }
  }
  groups.push(cur)
  if (groups.length >= 2 && gap(groups[groups.length - 1], groups[0]) <= CAP_JOIN_GAP) {
    groups[0].s = groups[groups.length - 1].s
    groups.pop()
  }

  const out: number[] = []
  const capStarts = new Set<number>()
  const arcLen = (s: number, e: number): number => wrap(e - s) + 1
  const inGroup = (g: { s: number; e: number }, i: number): boolean => wrap(i - g.s) <= wrap(g.e - g.s)
  // One arm of the cap hypothesis: seed a line fit CAP_ARM_K steps outside the group
  // center (on the long edge, clear of the confusion zone), then extend it inward while
  // collinear — the extension stops at the true corner. Returns the stop vertex + the
  // travel-oriented arm direction, or null when the seed itself is not straight (small
  // cells and teeth wrap other corners into the seed window and must not be touched).
  const findArm = (m: number, sign: -1 | 1): { stop: number; dir: Vec } | null => {
    const seed: Vec[] = []
    for (let o = CAP_ARM_K + CAP_ARM_SEED - 1; o >= CAP_ARM_K; o--) seed.push(pts[wrap(m + sign * o)])
    let line = armLine(seed)
    for (const p of seed) {
      const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
      if (dev > SNAP_COLLINEAR) return null
    }
    // Extend inward, re-fitting the line as each vertex joins: a fixed seed slope is
    // step-phase noise on a low-angle staircase and would stop early; the refit
    // converges on the true edge and the stop lands at the corner.
    let stop = wrap(m + sign * CAP_ARM_K)
    const acc = seed.slice()
    for (let o = CAP_ARM_K - 1; o >= 0; o--) {
      const i = wrap(m + sign * o)
      const dev = Math.abs((pts[i].x - line.c.x) * line.d.y - (pts[i].y - line.c.y) * line.d.x)
      if (dev > CAP_EXTEND_DEV) break
      acc.push(pts[i])
      line = armLine(acc)
      stop = i
    }
    // Orient the fitted direction along travel (ascending index order).
    const a = pts[wrap(m + sign * (CAP_ARM_K + CAP_ARM_SEED - 1))]
    const b = pts[wrap(m + sign * CAP_ARM_K)]
    const travel = sign === -1 ? sub(b, a) : sub(a, b)
    const d = travel.x * line.d.x + travel.y * line.d.y >= 0 ? line.d : neg(line.d)
    return { stop, dir: d }
  }
  for (const g of groups) {
    const members = corners.filter((c) => inGroup(g, c))
    const span = arcLen(g.s, g.e)
    // Classification — see the header comment. All evidence-gated; any failure
    // leaves the group's detector apexes exactly as they were.
    let cap: { a: number; b: number } | null = null
    if (span <= 24 && span < n - 2 * (CAP_ARM_K + CAP_ARM_SEED)) {
      const m = wrap(g.s + (span >> 1))
      const armIn = findArm(m, -1)
      const armOut = findArm(m, 1)
      if (armIn && armOut && armIn.stop !== armOut.stop) {
        const A = armIn.stop
        const B = armOut.stop
        const chord = dist(pts[A], pts[B])
        const cosT = armIn.dir.x * armOut.dir.x + armIn.dir.y * armOut.dir.y
        const uturn = (Math.acos(Math.max(-1, Math.min(1, cosT))) * 180) / Math.PI
        if (chord >= CAP_CHORD_MIN && chord <= CAP_CHORD_MAX && uturn >= CAP_ANTIPARALLEL_DEG) {
          let maxDev = 0
          for (let i = A; i !== B; i = wrap(i + 1)) maxDev = Math.max(maxDev, perpDistance(pts[i], pts[A], pts[B]))
          if (maxDev <= CAP_FLAT) cap = { a: A, b: B }
        }
      }
    }
    if (cap) {
      out.push(cap.a, cap.b)
      capStarts.add(cap.a)
    } else out.push(...members)
  }
  out.sort((a, b) => a - b)
  // Dedup (a group end could coincide with a member of a neighbouring group).
  const dedup: number[] = []
  for (const c of out) if (dedup[dedup.length - 1] !== c) dedup.push(c)
  return { corners: dedup, capStarts }
}

/** Least-squares line through the interior staircase vertices of a cap arc (its
 *  two corners excluded — they sit on the shoulder rounding). Falls back to the
 *  corner-to-corner chord when the interior is too short to fit. */
export function capChordLine(pts: Vec[], cIn: number, cOut: number): { c: Vec; d: Vec } {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const interior: Vec[] = []
  for (let i = wrap(cIn + 1); i !== cOut; i = wrap(i + 1)) interior.push(pts[i])
  if (interior.length >= 2) return armLine(interior)
  const d = unit(sub(pts[cOut], pts[cIn]))
  return { c: { x: pts[cIn].x, y: pts[cIn].y }, d }
}

/** Snap one cap corner to the intersection of its long arm's fitted line with the
 *  shared cap-chord line. `sign` −1 ⇒ the long arm precedes the corner (an arc
 *  ends at this cap), +1 ⇒ it follows (an arc starts here). Falls back to the raw
 *  lattice vertex when the arm is degenerate or the intersection runs away. */
export function snapCapCorner(
  pts: Vec[],
  c: number,
  sign: -1 | 1,
  toLong: number,
  capLine: { c: Vec; d: Vec },
  snapMax: number,
): Vec {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const gapN = armGap(toLong)
  const span = Math.min(SNAP_SPAN, Math.max(gapN + 1, toLong - 1))
  const arm: Vec[] = []
  for (let o = gapN; o <= span; o++) arm.push(pts[wrap(c + sign * o)])
  if (arm.length < 2) return { x: pts[c].x, y: pts[c].y }
  const a = armLine(arm)
  const det = a.d.x * -capLine.d.y - a.d.y * -capLine.d.x
  if (Math.abs(det) < 1e-6) return { x: pts[c].x, y: pts[c].y }
  const rx = capLine.c.x - a.c.x
  const ry = capLine.c.y - a.c.y
  const t = (rx * -capLine.d.y - ry * -capLine.d.x) / det
  const ix = a.c.x + t * a.d.x
  const iy = a.c.y + t * a.d.y
  if (dist({ x: ix, y: iy }, pts[c]) > snapMax) return { x: pts[c].x, y: pts[c].y }
  return { x: ix, y: iy }
}
