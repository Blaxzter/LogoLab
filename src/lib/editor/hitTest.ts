// Hit-testing for the editor canvas: what is under the pointer, and in what
// priority order.
//
// The single most important thing in this file is PRIORITY. When a handle dot,
// an anchor and a curve all sit within a few pixels of the pointer — which is
// the normal case, not the edge case, because a handle is often short — the
// editor must always resolve to the same one, and it must be the one the user
// is most likely to want. The order is:
//
//   handle → anchor → segment → fill
//
// Handles beat anchors because a handle sitting exactly on top of its anchor
// (a collapsed handle on a straight joint) is otherwise ungrabbable: you could
// never pull a curve out of a corner. Anchors beat segments because an anchor
// is always ON its segments, so the reverse order makes anchors unclickable.
//
// All tolerances arrive in VIEWBOX units, already divided by the zoom by the
// caller — so a 8px grab radius stays 8 screen px at any zoom, which is what
// makes small artwork editable at all.

import type { DocItem, PathItem, SubPath, Vec } from '../path/types.ts'
import { cubicAt, nearestPointOnItem, segmentControls, segmentCount } from '../path/geometry.ts'
import { isGroup } from '../path/docTree.ts'
import type { Box } from './transform.ts'
import { itemBox } from './transform.ts'

/** Which part of a path the pointer landed on. */
export type HitKind = 'handle' | 'anchor' | 'segment' | 'fill'

export interface Hit {
  kind: HitKind
  itemId: string
  /** Subpath index (all kinds except 'fill'). */
  sub?: number
  /** Node index for 'anchor' / 'handle'. */
  idx?: number
  /** Which handle of the node, for 'handle'. */
  handle?: 'in' | 'out'
  /** Segment index and parameter, for 'segment'. */
  seg?: number
  t?: number
  /** Distance in viewBox units from the pointer to what was hit. */
  dist: number
  /** The exact point hit (on-curve for 'segment'). */
  point?: Vec
}

/* ---------------------------------------------------------- flattening */

/**
 * Polyline approximation of a subpath, cached by `nodes` identity. Fill
 * hit-testing needs a polygon; re-flattening on every pointermove over a
 * hundred-path document is the kind of thing that makes a canvas feel heavy,
 * and the node arrays are immutable so the cache can never go stale.
 */
const polyCache = new WeakMap<object, Vec[]>()

/** Samples per curved segment. 12 is well under a pixel at normal zoom. */
const FLATTEN_STEPS = 12

export function flattenSubPath(sp: SubPath): Vec[] {
  const cached = polyCache.get(sp.nodes)
  if (cached) return cached
  const pts: Vec[] = []
  const count = segmentCount(sp)
  if (sp.nodes.length > 0) pts.push({ x: sp.nodes[0].x, y: sp.nodes[0].y })
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    // A straight segment needs no interior samples at all.
    const straight =
      c1.x === p0.x && c1.y === p0.y && c2.x === p3.x && c2.y === p3.y
    if (straight) {
      pts.push({ x: p3.x, y: p3.y })
      continue
    }
    for (let k = 1; k <= FLATTEN_STEPS; k++) {
      pts.push(cubicAt(p0, c1, c2, p3, k / FLATTEN_STEPS))
    }
  }
  polyCache.set(sp.nodes, pts)
  return pts
}

/* ------------------------------------------------------------ fill tests */

/**
 * Whether a point lies inside a closed polyline (odd-crossing rule).
 *
 * Distinct from {@link pointInPath}, which asks about a whole item under its
 * fill rule: this answers "is the point in THIS loop", which is what you need
 * to decide which blob of a multi-blob region was clicked.
 */
export function pointInPolygon(p: Vec, poly: readonly Vec[]): boolean {
  return windingOf(p, poly) % 2 !== 0
}

/** Absolute area of a closed polyline — ranks a blob's outer loop above holes. */
export function polygonArea(poly: readonly Vec[]): number {
  let a = 0
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

/** Signed crossing count of a ray from `p` through a closed polyline. */
function windingOf(p: Vec, poly: readonly Vec[]): number {
  let w = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j]
    const b = poly[i]
    if (a.y <= p.y) {
      if (b.y > p.y && cross(a, b, p) > 0) w++
    } else if (b.y <= p.y && cross(a, b, p) < 0) w--
  }
  return w
}

function cross(a: Vec, b: Vec, p: Vec): number {
  return (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y)
}

/**
 * Whether the point is inside the item's filled area, honouring its fill rule
 * — so a click through the hole of a donut correctly misses it and selects
 * whatever is behind.
 */
export function pointInPath(item: PathItem, p: Vec): boolean {
  let winding = 0
  let crossings = 0
  for (const sp of item.subPaths) {
    if (sp.nodes.length < 2) continue
    const poly = flattenSubPath(sp)
    if (item.fillRule === 'evenodd') {
      crossings += Math.abs(windingOf(p, poly)) % 2 === 1 ? 1 : 0
      // evenodd counts each subpath's parity independently, then XORs them.
      continue
    }
    winding += windingOf(p, poly)
  }
  return item.fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0
}

/** Distance from a point to a polyline, in the polyline's units. */
function distToPolyline(p: Vec, poly: readonly Vec[], closed: boolean): number {
  let best = Infinity
  const n = poly.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % n]
    best = Math.min(best, distToSegment(p, a, b))
  }
  return best
}

export function distToSegment(p: Vec, a: Vec, b: Vec): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len2 = vx * vx + vy * vy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
}

/**
 * Whether a click at `p` should select this item: inside the fill, or within
 * `tol` of its outline. The outline slack is what makes a hairline shape or an
 * unfilled (stroke-only) path clickable at all.
 */
export function itemHitBy(item: PathItem, p: Vec, tol: number): boolean {
  const filled = item.fill !== 'none'
  if (filled && pointInPath(item, p)) return true
  const slack = tol + (item.stroke ? item.stroke.width / 2 : 0)
  for (const sp of item.subPaths) {
    if (sp.nodes.length < 2) continue
    if (distToPolyline(p, flattenSubPath(sp), sp.closed) <= slack) return true
  }
  return false
}

/* --------------------------------------------------------- item picking */

/**
 * The topmost item under the point. Walks the tree back-to-front so the
 * frontmost hit wins, and reports the outermost enclosing group when
 * `groupsAreAtomic` — clicking a grouped shape selects the group, which is what
 * grouping is for; a second click (handled by the caller as "enter group")
 * drills in.
 */
export function pickItem(
  items: readonly DocItem[],
  p: Vec,
  tol: number,
  opts: { groupsAreAtomic?: boolean; skipIds?: ReadonlySet<string> } = {},
): { id: string; leafId: string } | null {
  const atomic = opts.groupsAreAtomic !== false
  const skip = opts.skipIds

  const search = (
    list: readonly DocItem[],
    topGroupId: string | null,
  ): { id: string; leafId: string } | null => {
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i]
      if (!it.visible || skip?.has(it.id)) continue
      if (isGroup(it)) {
        const hit = search(it.children, atomic ? (topGroupId ?? it.id) : null)
        if (hit) return hit
        continue
      }
      if (it.kind !== 'path') continue
      if (itemHitBy(it, p, tol)) {
        return { id: topGroupId ?? it.id, leafId: it.id }
      }
    }
    return null
  }
  return search(items, null)
}

/* ------------------------------------------------------- node / handle */

export interface NodeHitOptions {
  /** Grab radius for anchors, in viewBox units. */
  anchorTol: number
  /** Grab radius for handle dots. */
  handleTol: number
  /** Max distance to count as "on the curve". */
  segmentTol: number
  /** Only these nodes show handles, so only they can be grabbed by handle. */
  handlesVisibleFor?: ReadonlySet<string>
}

/**
 * Resolve the pointer against ONE path in node-edit mode, in the documented
 * priority order. Returns null when nothing is close enough.
 */
export function pickNodePart(item: PathItem, p: Vec, opts: NodeHitOptions): Hit | null {
  // 1. Handles — only on nodes that are actually showing them.
  let bestHandle: Hit | null = null
  for (let sub = 0; sub < item.subPaths.length; sub++) {
    const nodes = item.subPaths[sub].nodes
    for (let idx = 0; idx < nodes.length; idx++) {
      if (opts.handlesVisibleFor && !opts.handlesVisibleFor.has(`${sub}:${idx}`)) continue
      const node = nodes[idx]
      for (const which of ['in', 'out'] as const) {
        const h = which === 'in' ? node.hIn : node.hOut
        if (!h) continue
        const d = Math.hypot(h.x - p.x, h.y - p.y)
        if (d <= opts.handleTol && (!bestHandle || d < bestHandle.dist)) {
          bestHandle = { kind: 'handle', itemId: item.id, sub, idx, handle: which, dist: d, point: h }
        }
      }
    }
  }
  if (bestHandle) return bestHandle

  // 2. Anchors.
  let bestAnchor: Hit | null = null
  for (let sub = 0; sub < item.subPaths.length; sub++) {
    const nodes = item.subPaths[sub].nodes
    for (let idx = 0; idx < nodes.length; idx++) {
      const n = nodes[idx]
      const d = Math.hypot(n.x - p.x, n.y - p.y)
      if (d <= opts.anchorTol && (!bestAnchor || d < bestAnchor.dist)) {
        bestAnchor = { kind: 'anchor', itemId: item.id, sub, idx, dist: d, point: { x: n.x, y: n.y } }
      }
    }
  }
  if (bestAnchor) return bestAnchor

  // 3. The curve itself — the drag target that lets you bend a segment
  //    directly instead of hunting for its handles.
  const near = nearestPointOnItem(item, p)
  if (near && near.dist <= opts.segmentTol) {
    return {
      kind: 'segment',
      itemId: item.id,
      sub: near.sub,
      seg: near.seg,
      t: near.t,
      dist: near.dist,
      point: near.point,
    }
  }
  return null
}

/* ------------------------------------------------------------- marquee */

export function boxesIntersect(a: Box, b: Box): boolean {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h
}

export function boxContains(outer: Box, inner: Box): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export function pointInBox(box: Box, p: Vec): boolean {
  return p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h
}

/** Normalize two drag corners into a positive-size box. */
export function boxFromPoints(a: Vec, b: Vec): Box {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  }
}

/**
 * Ids a marquee selects. `touch` mode takes anything the rubber band grazes
 * (crossing selection); the default requires full containment, which is the
 * behaviour that lets you drag a band across a busy canvas and get only what
 * you framed.
 */
export function marqueeItems(
  items: readonly DocItem[],
  box: Box,
  opts: { touch?: boolean; groupsAreAtomic?: boolean } = {},
): string[] {
  const hit: string[] = []
  const test = opts.touch ? boxesIntersect : boxContains
  const walk = (list: readonly DocItem[]) => {
    for (const it of list) {
      if (!it.visible) continue
      if (isGroup(it)) {
        if (opts.groupsAreAtomic !== false) {
          const b = itemBox(it)
          if (b && test(box, b)) {
            hit.push(it.id)
            continue
          }
          // A group only partly inside a containment marquee selects nothing —
          // descending would break the group's atomicity.
          if (opts.touch) walk(it.children)
          continue
        }
        walk(it.children)
        continue
      }
      const b = itemBox(it)
      if (b && test(box, b)) hit.push(it.id)
    }
  }
  walk(items)
  return hit
}

/** Node keys ('sub:idx') of one path whose anchors fall inside the marquee. */
export function marqueeNodes(item: PathItem, box: Box): string[] {
  const keys: string[] = []
  for (let sub = 0; sub < item.subPaths.length; sub++) {
    const nodes = item.subPaths[sub].nodes
    for (let idx = 0; idx < nodes.length; idx++) {
      if (pointInBox(box, nodes[idx])) keys.push(`${sub}:${idx}`)
    }
  }
  return keys
}
