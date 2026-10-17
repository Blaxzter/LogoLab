// Simplify path: fewer nodes, the same drawing within a tolerance.
//
// The result's nodes are a SUBSET of the path's own nodes — a span between two
// kept nodes is refitted as one line or one cubic, never moved off the path's
// node positions. That is what keeps the three promises cheap to hold:
//
//   * corners stay sharp — a node whose two sides meet at more than
//     `cornerDeg` is always kept, and a span ending there leaves along that
//     side's own tangent;
//   * straight runs stay straight — a span whose every point lies within the
//     tolerance of its chord, and whose ends leave along the chord, is a line
//     with no handles (a rounded rectangle's sides, collinear clutter);
//   * nothing redundant-free changes — a span that can't be refitted keeps the
//     original segment byte for byte, so a path with no slack comes back as the
//     same object.
//
// Spans are grown greedily from each kept node (the longest one that fits), and
// a fit is checked against points sampled densely off the ORIGINAL path, so the
// tolerance is a distance from the drawing, not from the previous fit. Open and
// closed subpaths, and every hole of a compound path, are simplified alone.

import type { DocItem, EditableDoc, PathItem, SubPath, Vec } from '../path/types.ts'
import { isGroup, isText, walkItems } from '../path/docTree.ts'
import { paintedStroke } from './strokePieces.ts'
import { subPathsTightBounds } from '../path/geometry.ts'
import {
  type Cubic,
  add,
  angleBetween,
  cross,
  cubicPoint,
  cubicTangent,
  cubicsToNodes,
  dist,
  dot,
  fitCubic,
  isStraight,
  len,
  lineCubic,
  sub,
  subPathCubics,
  unit,
} from './bezierFit.ts'

/** A node whose sides meet at more than this (degrees) is a corner and always kept. */
export const SIMPLIFY_CORNER_DEG = 30

/** How far a line's ends may lean off the tangents of the smooth nodes it joins (degrees). */
const LINE_TANGENT_DEG = 2

/** A line span this share of the longest curve span's length wins over the curve. */
const LINE_SHARE = 0.5

/** Failed extensions in a row before a span stops growing. */
const GIVE_UP_AFTER = 3

/** Per-segment sample cap: bounds the cost on a very long segment at a tiny tolerance. */
const MAX_SAMPLES = 48

/**
 * One subpath with redundant nodes removed. `tol` is a distance in viewBox
 * units. Returns the same object when nothing could be removed.
 */
export function simplifySubPath(sp: SubPath, tol: number, cornerDeg = SIMPLIFY_CORNER_DEG): SubPath {
  const n = sp.nodes.length
  const segs = sp.closed ? n : n - 1
  if (segs < 2 || !(tol > 0)) return sp
  const cubics = subPathCubics(sp.nodes, sp.closed)

  // Tangents either side of every node, and which nodes are corners.
  const outT: (Vec | null)[] = []
  const inT: (Vec | null)[] = []
  for (let i = 0; i < n; i++) {
    outT.push(i < segs ? cubicTangent(cubics[i], 0) : null)
    const prev = i > 0 ? i - 1 : sp.closed ? segs - 1 : -1
    inT.push(prev >= 0 ? cubicTangent(cubics[prev], 1) : null)
  }
  const corner = sp.nodes.map((_, i) => {
    const a = inT[i]
    const b = outT[i]
    return !a || !b || angleBetween(a, b) > cornerDeg
  })
  const smoothT = sp.nodes.map((_, i) => (corner[i] ? null : unit(add(inT[i]!, outT[i]!))))

  // Unroll: a closed loop starts at a corner (or node 0 when it has none) and
  // ends on the same node again, so every span is a plain index range.
  let start = 0
  if (sp.closed) {
    const c = corner.indexOf(true)
    if (c > 0) start = c
  }
  const node = (u: number) => (start + u) % n
  const seg = (u: number) => cubics[(start + u) % segs]

  // Dense samples of the original, and where each node sits in them.
  const pts: Vec[] = [cubics.length ? seg(0).p0 : { x: sp.nodes[0].x, y: sp.nodes[0].y }]
  const at: number[] = [0]
  for (let u = 0; u < segs; u++) {
    const c = seg(u)
    const L = approxLength(c)
    const m = isStraight(c)
      ? Math.min(MAX_SAMPLES, Math.max(1, Math.ceil(L / (2 * tol))))
      : Math.min(MAX_SAMPLES, Math.max(6, Math.ceil(L / tol)))
    for (let k = 1; k <= m; k++) pts.push(cubicPoint(c, k / m))
    at.push(pts.length - 1)
  }
  // Arc length along the samples, for weighing a line against a longer curve.
  const run: number[] = [0]
  for (let i = 1; i < pts.length; i++) run.push(run[i - 1] + dist(pts[i], pts[i - 1]))
  const arc = (a: number, b: number) => run[at[b]] - run[at[a]]

  const isCorner = (u: number) => corner[node(u)]
  const leaving = (u: number) => (isCorner(u) ? outT[node(u)] : smoothT[node(u)])
  const arriving = (u: number) => (isCorner(u) ? inT[node(u)] : smoothT[node(u)])
  const noCorner = sp.closed && !corner.includes(true)

  /** One line or cubic for nodes a..b (unrolled), or null when none fits. */
  const tryFit = (a: number, b: number): { cubic: Cubic; line: boolean } | null => {
    const sa = at[a]
    const sb = at[b]
    const p = pts[sa]
    const q = pts[sb]
    const ta = leaving(a)
    const tb = arriving(b)
    if (!ta || !tb) return null
    const chord = unit(sub(q, p))
    if (chord && withinChord(pts, sa, sb, tol)) {
      // At a smooth node the line may also simply carry on that side's own
      // segment (a polygon's side meeting a faceted arc).
      const along = (t: Vec | null) => t !== null && angleBetween(t, chord) <= LINE_TANGENT_DEG
      const okA = isCorner(a) || along(ta) || along(outT[node(a)])
      const okB = isCorner(b) || along(tb) || along(inT[node(b)])
      if (okA && okB) return { cubic: lineCubic(p, q), line: true }
    }
    if (dist(p, q) < 1e-9) return null
    const fit = fitCubic(pts, sa, sb, ta, tb)
    return fit.err <= tol && sane(fit.cubic) ? { cubic: fit.cubic, line: false } : null
  }

  // Corner-to-corner runs (the whole loop when there is none).
  const breaks = [0]
  for (let u = 1; u < segs; u++) if (isCorner(u)) breaks.push(u)
  breaks.push(segs)

  const out: Cubic[] = []
  let changed = false
  for (let r = 0; r + 1 < breaks.length; r++) {
    const A = breaks[r]
    const B = breaks[r + 1]
    let a = A
    while (a < B) {
      let best = a + 1
      let piece: Cubic | null = null
      let line: { k: number; cubic: Cubic } | null = null
      let fails = 0
      for (let k = a + 2; k <= B; k++) {
        // A loop with no corner can't be one span: its ends would be the same point.
        if (noCorner && a === A && k === B) break
        const fit = tryFit(a, k)
        if (fit) {
          best = k
          piece = fit.cubic
          if (fit.line) line = { k, cubic: fit.cubic }
          fails = 0
        } else if (++fails >= GIVE_UP_AFTER) break
      }
      // The longest fit is not always the right one: a curve that swallows a
      // straight side and a little of the arc after it fits too, and bends the
      // side. A line covering most of what the curve would is kept a line.
      if (line && line.k !== best && arc(a, line.k) >= LINE_SHARE * arc(a, best)) {
        best = line.k
        piece = line.cubic
      }
      if (piece) changed = true
      out.push(piece ?? seg(a))
      a = best
    }
  }
  if (!changed) return sp

  const nodes = cubicsToNodes(out, sp.closed)
  return { nodes, closed: sp.closed }
}

/** Every sample between the two ends within `tol` of their chord (the segment, not the line). */
function withinChord(pts: readonly Vec[], from: number, to: number, tol: number): boolean {
  const p = pts[from]
  const q = pts[to]
  const d = sub(q, p)
  const L2 = dot(d, d)
  for (let i = from + 1; i < to; i++) {
    const v = sub(pts[i], p)
    const t = L2 > 0 ? dot(v, d) / L2 : 0
    const off = t < 0 ? len(v) : t > 1 ? dist(pts[i], q) : Math.abs(cross(d, v)) / Math.sqrt(L2)
    if (off > tol) return false
  }
  return true
}

/** A fitted cubic whose handles overshoot its chord many times over is a loop, not a fit. */
function sane(c: Cubic): boolean {
  const L = dist(c.p0, c.p3)
  return dist(c.p0, c.c1) < 4 * L + 1e-9 && dist(c.p3, c.c2) < 4 * L + 1e-9
}

function approxLength(c: Cubic): number {
  let L = 0
  let prev = c.p0
  for (let k = 1; k <= 8; k++) {
    const p = cubicPoint(c, k / 8)
    L += dist(prev, p)
    prev = p
  }
  return L
}

/* ------------------------------------------------------------- the item */

/** The distance a tolerance percentage means for one path: that share of its larger side. */
export function simplifyTolerance(item: PathItem, percent: number): number {
  const b = subPathsTightBounds(item.subPaths)
  if (!b) return 0
  return (Math.max(b.w, b.h) * percent) / 100
}

/** A path with every subpath simplified. The same object when nothing changed. */
export function simplifyPath(item: PathItem, tol: number, cornerDeg = SIMPLIFY_CORNER_DEG): PathItem {
  let changed = false
  const subPaths = item.subPaths.map((sp) => {
    const next = simplifySubPath(sp, tol, cornerDeg)
    if (next !== sp) changed = true
    return next
  })
  // Leaving the planar graph, like every other path op: the edges would rebuild the old nodes.
  return changed ? { ...item, subPaths, loops: undefined } : item
}

export function nodeTotal(item: PathItem): number {
  return item.subPaths.reduce((acc, sp) => acc + sp.nodes.length, 0)
}

/** The paths a selection-wide command reaches: selected ones, and those inside selected groups (texts excluded). */
export function selectedPaths(items: readonly DocItem[], selection: ReadonlySet<string>): PathItem[] {
  const out: PathItem[] = []
  const walk = (list: readonly DocItem[], on: boolean) => {
    for (const it of list) {
      const sel = on || selection.has(it.id)
      if (isGroup(it)) {
        if (!it.text) walk(it.children, sel)
      } else if (sel && it.kind === 'path') out.push(it)
    }
  }
  walk(items, false)
  return out
}

/** A path Simplify could change: a subpath long enough to lose a node. */
export function canSimplify(item: PathItem): boolean {
  return item.subPaths.some((sp) => sp.nodes.length >= 3)
}

/**
 * What the selection-wide path commands reach: paths selected or inside a
 * selected group (never a live text's glyphs), how many of them paint a stroke
 * (Outline stroke) or could lose a node (Simplify), and how many texts are selected.
 */
export interface PathReach {
  stroked: number
  simplifiable: number
  texts: number
}

export function pathReach(items: readonly DocItem[], selection: ReadonlySet<string>): PathReach {
  const paths = selectedPaths(items, selection)
  let texts = 0
  walkItems(items, (it) => {
    if (isText(it) && selection.has(it.id)) texts++
  })
  return {
    stroked: paths.filter((p) => paintedStroke(p) !== null).length,
    simplifiable: paths.filter(canSimplify).length,
    texts,
  }
}

export interface SimplifyResult {
  doc: EditableDoc
  /** Nodes in the reached paths before and after. */
  before: number
  after: number
}

/**
 * Simplify every selected path (walking into selected groups, never into a
 * live text — its outlines are a cache of the words), each at `percent` of its
 * own size. `doc` is the input object when nothing changed.
 */
export function simplifySelected(doc: EditableDoc, selection: ReadonlySet<string>, percent: number): SimplifyResult {
  let before = 0
  let after = 0
  let changed = false
  const walk = (list: readonly DocItem[], on: boolean): DocItem[] =>
    list.map((it) => {
      const sel = on || selection.has(it.id)
      if (isGroup(it)) {
        if (it.text) return it
        const children = walk(it.children, sel)
        return children.some((c, i) => c !== it.children[i]) ? { ...it, children } : it
      }
      if (!sel || it.kind !== 'path') return it
      before += nodeTotal(it)
      const next = simplifyPath(it, simplifyTolerance(it, percent))
      after += nodeTotal(next)
      if (next !== it) changed = true
      return next
    })
  const items = walk(doc.items, false)
  return { doc: changed ? { ...doc, items } : doc, before, after }
}

/* ----------------------------------------------------------- the session */

/** An open Simplify session: the drawing it opened on, and the preview it shows. */
export interface SimplifySession {
  base: EditableDoc
  selection: ReadonlySet<string>
  shown: EditableDoc
}

/**
 * The document the editor reports outward (the editor slot, the working logo).
 * A preview the session is showing is not the drawing yet — leaving the tab
 * mid-preview must not write a simplification nobody applied — so while it is
 * up the session's base stands in. Any other document (an edit that ended the
 * session) is reported as it is.
 */
export function reportedDoc(doc: EditableDoc, session: SimplifySession | null): EditableDoc {
  return session && doc === session.shown ? session.base : doc
}

/* ------------------------------------------------------------ the slider */

/** The tolerance slider's range, in percent of a path's size: log-scaled, so the fine end has room. */
export const SIMPLIFY_MIN_PERCENT = 0.05
export const SIMPLIFY_MAX_PERCENT = 5
export const SIMPLIFY_DEFAULT_PERCENT = 0.5

/** Slider position (0–100) → tolerance percent. */
export function sliderPercent(v: number): number {
  const f = Math.min(100, Math.max(0, v)) / 100
  return SIMPLIFY_MIN_PERCENT * (SIMPLIFY_MAX_PERCENT / SIMPLIFY_MIN_PERCENT) ** f
}

/** Tolerance percent → slider position (0–100). */
export function percentSlider(percent: number): number {
  const p = Math.min(SIMPLIFY_MAX_PERCENT, Math.max(SIMPLIFY_MIN_PERCENT, percent))
  return (100 * Math.log(p / SIMPLIFY_MIN_PERCENT)) / Math.log(SIMPLIFY_MAX_PERCENT / SIMPLIFY_MIN_PERCENT)
}
