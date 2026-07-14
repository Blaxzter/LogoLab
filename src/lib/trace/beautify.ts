// Shape beautification (Stage 3 of the V3 vectorizer — plan §3.3 / §6 V3).
//
// A PURE post-processing pass over the traced contours, run AFTER the tracer and
// BEFORE the EditableDoc is assembled, so it works for BOTH engines (potrace and
// crisp). It does NOT re-segment — it only regularises the geometry the tracer
// already produced:
//
//   1. Per closed loop — snap to a primitive (circle / axis-aligned ellipse) when
//      the loop genuinely is one; straighten near-straight cubic runs to lines,
//      merge collinear vertices, and snap rectilinear edges to horizontal/vertical.
//   2. Cross-shape relation solver — detect concentric centres and equal radii
//      across all loops/items and reconcile them with one small mean adjustment.
//
// Every snap is gated by ONE user-facing tolerance — the FIDELITY knob: a snap is
// accepted only if the maximum deviation it introduces from the raw flattened
// trace stays ≤ `fidelity` px. This is the single knob that says how far from the
// source PNG the output may drift. `fidelity = 0` disables beautification.
//
// Pure and deterministic (fixed sample counts, fixed scan/cluster orders, no PRNG
// / Date): runs unchanged under `node --test`.

import type { SubPath, PathNode, Vec } from '../path/types'
import { cubicAt } from '../path/geometry.ts'
import {
  FLATTEN_PER_SEG,
  flatten,
  anchorSignedArea,
  fitCircle,
  maxRadialDev,
  fitEllipse,
  maxEllipseDev,
  maxEllipseToPolyDev,
  makeCircleSubPath,
  makeEllipseSubPath,
  perpDistance,
  relationSolveCircles,
} from './circleFit.ts'

export interface BeautifyOptions {
  /**
   * Max deviation (px) any snap may introduce from the raw trace — the user
   * fidelity knob. A snap is accepted only when its worst-case drift stays under
   * this. 0 disables all beautification (output is the raw trace).
   */
  fidelity: number
  /** Concentric-centre / equal-radius detection radius, as a fraction of the
   *  whole-document bbox long side (plan §3.3: ~1/10). */
  relationFrac: number
  /** Angle (deg) within which a straight edge snaps to horizontal/vertical. */
  hvAngleDeg: number
}

export const DEFAULT_BEAUTIFY_OPTIONS: BeautifyOptions = {
  fidelity: 1.5,
  relationFrac: 0.1,
  hvAngleDeg: 10,
}

/**
 * Drift ceiling (px) for the LINE cleanups — straighten, collinear-merge, H-V
 * snap. Deliberately a small value (well under 1 px) and NOT scaled up by the
 * fidelity knob. Each line cleanup repositions a single boundary vertex, so any
 * drift over ~1 px reads as a seam (the harness flags boundary moves the source
 * edge cannot account for) and second-guesses the tracer's own fit — measured to
 * regress petals' organic edges and aurora's translucent strokes when run at the
 * full 1.5 px budget. The knob's larger drift budget belongs to WHOLE-SHAPE
 * primitive snaps (circles/ellipses): there the deviation is distributed smoothly
 * around a perfect shape and the perceptual payoff justifies it, whereas nudging
 * one vertex never does. (`min(fidelity, …)` still lets a user tighten below it.)
 */
const LINE_POLISH_CAP = 0.3

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Beautify the traced subpaths of every item. `groups` is one `SubPath[]` per
 * item, in paint order; the return value has the same outer shape (each subpath
 * possibly replaced by a regularised one), so the caller reassembles items
 * unchanged. Loop winding (outer vs hole) is always preserved so nonzero/evenodd
 * fills keep rendering holes as holes.
 */
export function beautify(groups: SubPath[][], opts: BeautifyOptions): SubPath[][] {
  if (!(opts.fidelity > 0)) return groups

  // Whole-document bbox long side drives the relation-solver detection radius.
  const L = docLongSide(groups)

  // Per-loop pass: analyse every closed loop into a shape record (circle / poly).
  const records: ShapeRecord[][] = groups.map((g) =>
    g.map((sp) => analyseLoop(sp, opts)),
  )

  // Relation solver across all circle records (concentric centres, equal radii).
  relationSolve(records, opts, L)

  // Materialise the (possibly adjusted) records back into subpaths.
  return records.map((g) => g.map((rec) => rec.subPath))
}

// ---------------------------------------------------------------------------
// Shape records
// ---------------------------------------------------------------------------

interface CircleRecord {
  kind: 'circle'
  subPath: SubPath
  cx: number
  cy: number
  r: number
  /** Sign of the original loop's winding, to regenerate with matching orientation. */
  positive: boolean
  /** The original flattened trace, so any later (relation) adjustment can be
   *  re-checked against the RAW trace, never against the snapped circle. */
  raw: Vec[]
}

interface PolyRecord {
  kind: 'poly'
  subPath: SubPath
}

type ShapeRecord = CircleRecord | PolyRecord

/**
 * Analyse one subpath: try a circle/ellipse primitive first; otherwise apply the
 * line/collinear/H-V polish. Open subpaths and tiny loops are left untouched.
 */
function analyseLoop(sp: SubPath, opts: BeautifyOptions): ShapeRecord {
  if (!sp.closed || sp.nodes.length < 3) return { kind: 'poly', subPath: sp }

  const raw = flatten(sp)
  const positive = anchorSignedArea(sp.nodes) > 0

  // --- Circle ---------------------------------------------------------------
  const circle = fitCircle(raw)
  if (circle && circle.r > 2 * opts.fidelity && maxRadialDev(raw, circle) <= opts.fidelity) {
    return {
      kind: 'circle',
      subPath: makeCircleSubPath(circle.cx, circle.cy, circle.r, positive),
      cx: circle.cx,
      cy: circle.cy,
      r: circle.r,
      positive,
      raw,
    }
  }

  // --- Axis-aligned ellipse -------------------------------------------------
  const ell = fitEllipse(raw)
  // BOTH directions must hold: maxEllipseDev (polygon→ellipse) is blind to the
  // ellipse bulging into space the polygon never visits (maxEllipseToPolyDev).
  if (
    ell &&
    Math.min(ell.rx, ell.ry) > 2 * opts.fidelity &&
    maxEllipseDev(raw, ell) <= opts.fidelity &&
    maxEllipseToPolyDev(raw, ell) <= opts.fidelity
  ) {
    return { kind: 'poly', subPath: makeEllipseSubPath(ell.cx, ell.cy, ell.rx, ell.ry, positive) }
  }

  // --- Line / collinear / H-V polish ---------------------------------------
  return { kind: 'poly', subPath: polishLines(sp, opts) }
}

// ---------------------------------------------------------------------------
// Line / collinear / H-V polish (for loops that are not a primitive)
// ---------------------------------------------------------------------------

/**
 * Polish a non-primitive loop: straighten near-straight cubic segments to true
 * lines, merge collinear vertices, then snap near-axis-aligned edges to
 * horizontal/vertical. Every step is fidelity-gated and winding-preserving;
 * genuine curves (handles far off the chord) are untouched.
 */
function polishLines(sp: SubPath, opts: BeautifyOptions): SubPath {
  // All three line cleanups share the sub-fidelity drift cap (see LINE_POLISH_CAP)
  // so they only tidy near-exact cases and never move a true edge into a seam.
  const cap = Math.min(opts.fidelity, LINE_POLISH_CAP)
  let nodes = sp.nodes.map(cloneNode)

  // 1. Straighten: a cubic segment whose curve already sits within `cap` of its
  //    chord becomes a true line (both incident handles dropped).
  const count = sp.closed ? nodes.length : nodes.length - 1
  for (let seg = 0; seg < count; seg++) {
    const a = nodes[seg]
    const b = nodes[(seg + 1) % nodes.length]
    if (!a.hOut && !b.hIn) continue // already a line
    if (cubicChordDev(a, b) <= cap) {
      a.hOut = null
      b.hIn = null
    }
  }

  // 2. Merge collinear vertices: drop an anchor sitting (within `cap`) on the
  //    straight chord between its line-neighbours — a node-count win on
  //    rectilinear / pixel-staircase contours.
  nodes = mergeCollinear(nodes, sp.closed, cap)

  // 3. Snap near-axis-aligned straight edges to exact H/V (within `cap`; only
  //    near-exact axis edges fit the budget — aggressive angle-snapping would
  //    move long edges far enough to seam).
  snapAxisAligned(nodes, sp.closed, opts, cap)

  return { nodes, closed: sp.closed }
}

function cloneNode(n: PathNode): PathNode {
  return {
    x: n.x,
    y: n.y,
    hIn: n.hIn ? { x: n.hIn.x, y: n.hIn.y } : null,
    hOut: n.hOut ? { x: n.hOut.x, y: n.hOut.y } : null,
    kind: n.kind,
  }
}

/** Worst deviation of a cubic from its chord (a→b), sampled. */
function cubicChordDev(a: PathNode, b: PathNode): number {
  const p0: Vec = { x: a.x, y: a.y }
  const p3: Vec = { x: b.x, y: b.y }
  const c1 = a.hOut ?? p0
  const c2 = b.hIn ?? p3
  let m = 0
  for (let k = 1; k < FLATTEN_PER_SEG; k++) {
    const p = cubicAt(p0, c1, c2, p3, k / FLATTEN_PER_SEG)
    const d = perpDistance(p, p0, p3)
    if (d > m) m = d
  }
  return m
}

/** Drop anchors that lie on the straight chord between their two line-neighbours. */
function mergeCollinear(nodes: PathNode[], closed: boolean, fid: number): PathNode[] {
  const minNodes = closed ? 3 : 2
  let changed = true
  while (changed && nodes.length > minNodes) {
    changed = false
    for (let i = 0; i < nodes.length; i++) {
      const prevI = (i - 1 + nodes.length) % nodes.length
      const nextI = (i + 1) % nodes.length
      if (!closed && (i === 0 || i === nodes.length - 1)) continue
      const prev = nodes[prevI]
      const cur = nodes[i]
      const next = nodes[nextI]
      // Both incident segments must be straight (line into and out of `cur`).
      if (prev.hOut || cur.hIn || cur.hOut || next.hIn) continue
      if (perpDistance(cur, prev, next) <= fid) {
        nodes.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return nodes
}

/**
 * Snap near-axis-aligned straight edges to exact H/V. For each straight edge
 * within `hvAngleDeg` of an axis, the two endpoints' minor coordinate is set to
 * their midpoint — but only when both endpoint moves stay ≤ `fidelity`. A rect
 * corner shared by a horizontal and a vertical edge gets its y from the former
 * and its x from the latter, yielding a clean axis-aligned rectangle.
 */
function snapAxisAligned(nodes: PathNode[], closed: boolean, opts: BeautifyOptions, fid: number): void {
  const tan = Math.tan((opts.hvAngleDeg * Math.PI) / 180)
  const count = closed ? nodes.length : nodes.length - 1
  for (const axis of ['h', 'v'] as const) {
    for (let seg = 0; seg < count; seg++) {
      const a = nodes[seg]
      const b = nodes[(seg + 1) % nodes.length]
      if (a.hOut || b.hIn) continue // only straight edges
      const dx = b.x - a.x
      const dy = b.y - a.y
      if (axis === 'h') {
        // Near-horizontal: |dy| small relative to |dx|.
        if (Math.abs(dx) < 1e-6 || Math.abs(dy) > Math.abs(dx) * tan) continue
        const my = (a.y + b.y) / 2
        if (Math.abs(my - a.y) > fid || Math.abs(my - b.y) > fid) continue
        shiftAnchorY(a, my)
        shiftAnchorY(b, my)
      } else {
        if (Math.abs(dy) < 1e-6 || Math.abs(dx) > Math.abs(dy) * tan) continue
        const mx = (a.x + b.x) / 2
        if (Math.abs(mx - a.x) > fid || Math.abs(mx - b.x) > fid) continue
        shiftAnchorX(a, mx)
        shiftAnchorX(b, mx)
      }
    }
  }
}

function shiftAnchorX(n: PathNode, x: number): void {
  const d = x - n.x
  n.x = x
  if (n.hIn) n.hIn.x += d
  if (n.hOut) n.hOut.x += d
}
function shiftAnchorY(n: PathNode, y: number): void {
  const d = y - n.y
  n.y = y
  if (n.hIn) n.hIn.y += d
  if (n.hOut) n.hOut.y += d
}

// ---------------------------------------------------------------------------
// Relation solver — concentric centres + equal radii
// ---------------------------------------------------------------------------

/**
 * Reconcile the snapped circles across all items via the shared
 * `relationSolveCircles` solver (concentric centres, equal radii — each gated
 * against the circle's RAW trace). It mutates each record's cx/cy/r in place and
 * reports which moved; we regenerate only those as fresh 4-node Bézier subpaths.
 */
function relationSolve(records: ShapeRecord[][], opts: BeautifyOptions, longSide: number): void {
  const circles: CircleRecord[] = []
  for (const g of records) for (const rec of g) if (rec.kind === 'circle') circles.push(rec)
  const changed = relationSolveCircles(circles, opts, longSide)
  for (let i = 0; i < circles.length; i++) {
    if (changed[i]) {
      const c = circles[i]
      c.subPath = makeCircleSubPath(c.cx, c.cy, c.r, c.positive)
    }
  }
}

// ---------------------------------------------------------------------------
// Misc geometry
// ---------------------------------------------------------------------------

/** Long side of the bbox over every anchor of every loop in the document. */
function docLongSide(groups: SubPath[][]): number {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const g of groups) {
    for (const sp of g) {
      for (const n of sp.nodes) {
        if (n.x < minX) minX = n.x
        if (n.x > maxX) maxX = n.x
        if (n.y < minY) minY = n.y
        if (n.y > maxY) maxY = n.y
      }
    }
  }
  if (minX === Infinity) return 0
  return Math.max(maxX - minX, maxY - minY)
}
