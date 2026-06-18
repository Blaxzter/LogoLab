// Affine & cubic-Bézier geometry over the editable path model. Everything is
// immutable: functions return fresh objects and share untouched structure, so
// callers (the node editor, the store) can rely on reference equality.
//
// Segment convention (see ./types): the cubic between node i and node i+1 is
// (anchor_i, hOut_i, hIn_{i+1}, anchor_{i+1}); a null handle collapses onto
// its anchor, and closed subpaths have an implicit last→first segment.

import type { Affine, NodeKind, NodeRef, PathItem, PathNode, SubPath, Vec } from './types'

const EPS = 1e-6

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0]

/** True when an affine is (numerically) the identity. */
export function isIdentityAffine(m: Affine): boolean {
  return (
    Math.abs(m[0] - 1) < EPS &&
    Math.abs(m[1]) < EPS &&
    Math.abs(m[2]) < EPS &&
    Math.abs(m[3] - 1) < EPS &&
    Math.abs(m[4]) < EPS &&
    Math.abs(m[5]) < EPS
  )
}

/**
 * Parse an SVG `transform` attribute (matrix/translate/scale/rotate/skewX/
 * skewY, whitespace- or comma-separated) into a single composed Affine.
 * Per the SVG spec the list composes left-to-right — `transform="A B"` maps a
 * point p to A(B(p)). Returns identity for null/empty/unparseable input.
 */
export function parseTransformAttr(s: string | null | undefined): Affine {
  let m: Affine = IDENTITY
  if (!s) return m
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(s))) {
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (!args.every(Number.isFinite)) continue
    const t = transformFn(match[1].toLowerCase(), args)
    if (t) m = composeAffine(m, t)
  }
  return m
}

/** One parsed transform function → Affine (null when arity is invalid). */
function transformFn(name: string, args: number[]): Affine | null {
  switch (name) {
    case 'matrix':
      return args.length === 6 ? [args[0], args[1], args[2], args[3], args[4], args[5]] : null
    case 'translate':
      return args.length >= 1 ? [1, 0, 0, 1, args[0], args[1] ?? 0] : null
    case 'scale': {
      if (args.length < 1) return null
      const sx = args[0]
      return [sx, 0, 0, args.length > 1 ? args[1] : sx, 0, 0]
    }
    case 'rotate': {
      if (args.length < 1) return null
      const a = (args[0] * Math.PI) / 180
      const rot: Affine = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]
      if (args.length < 3) return rot
      // rotate(a cx cy) = translate(cx cy) rotate(a) translate(-cx -cy)
      const [, cx, cy] = args
      return composeAffine(composeAffine([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy])
    }
    case 'skewx':
      return args.length >= 1 ? [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0] : null
    case 'skewy':
      return args.length >= 1 ? [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0] : null
    default:
      return null
  }
}

/** Compose two affines: result maps p to outer(inner(p)). */
export function composeAffine(outer: Affine, inner: Affine): Affine {
  const [a1, b1, c1, d1, e1, f1] = outer
  const [a2, b2, c2, d2, e2, f2] = inner
  return [
    a1 * a2 + c1 * b2,
    b1 * a2 + d1 * b2,
    a1 * c2 + c1 * d2,
    b1 * c2 + d1 * d2,
    a1 * e2 + c1 * f2 + e1,
    b1 * e2 + d1 * f2 + f1,
  ]
}

/** Apply an affine to a point. */
export function applyAffine(m: Affine, p: Vec): Vec {
  return {
    x: m[0] * p.x + m[2] * p.y + m[4],
    y: m[1] * p.x + m[3] * p.y + m[5],
  }
}

/** Serialize an affine as an SVG `matrix(a b c d e f)` attribute value. */
export function affineToString(m: Affine): string {
  // toFixed(8) then Number() trims float noise without losing real precision.
  return `matrix(${m.map((n) => String(Number(n.toFixed(8)))).join(' ')})`
}

/**
 * Apply an affine to every anchor and handle. Exact: cubic Béziers are
 * invariant under affine maps, so no re-fitting is needed.
 */
export function transformSubPaths(subPaths: SubPath[], m: Affine): SubPath[] {
  return subPaths.map((sp) => ({
    closed: sp.closed,
    nodes: sp.nodes.map((node) => {
      const a = applyAffine(m, node)
      return {
        x: a.x,
        y: a.y,
        hIn: node.hIn ? applyAffine(m, node.hIn) : null,
        hOut: node.hOut ? applyAffine(m, node.hOut) : null,
        kind: node.kind,
      }
    }),
  }))
}

/** Evaluate a cubic Bézier at parameter t ∈ [0, 1]. */
export function cubicAt(p0: Vec, c1: Vec, c2: Vec, p3: Vec, t: number): Vec {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  }
}

/** Number of drawable segments in a subpath (closed adds the wrap segment). */
export function segmentCount(sp: SubPath): number {
  return sp.closed ? sp.nodes.length : sp.nodes.length - 1
}

/** Effective cubic controls of segment `seg` (null handles → anchors). */
export function segmentControls(sp: SubPath, seg: number): { p0: Vec; c1: Vec; c2: Vec; p3: Vec } {
  const a = sp.nodes[seg]
  const b = sp.nodes[(seg + 1) % sp.nodes.length]
  const p0 = { x: a.x, y: a.y }
  const p3 = { x: b.x, y: b.y }
  return {
    p0,
    c1: a.hOut ? { x: a.hOut.x, y: a.hOut.y } : p0,
    c2: b.hIn ? { x: b.hIn.x, y: b.hIn.y } : p3,
    p3,
  }
}

const NEAREST_SAMPLES = 24

/**
 * Closest point on any segment of the item to `pt`. Coarse-samples every
 * segment, then sharpens the winner with golden-section search on the squared
 * distance. Used for hit-testing and node insertion. Null when the item has
 * no drawable segments.
 */
export function nearestPointOnItem(
  item: PathItem,
  pt: Vec,
): { sub: number; seg: number; t: number; point: Vec; dist: number } | null {
  let bestSub = -1
  let bestSeg = -1
  let bestT = 0
  let bestD2 = Infinity

  for (let sub = 0; sub < item.subPaths.length; sub++) {
    const sp = item.subPaths[sub]
    if (sp.nodes.length < 2) continue
    const count = segmentCount(sp)
    for (let seg = 0; seg < count; seg++) {
      const { p0, c1, c2, p3 } = segmentControls(sp, seg)
      for (let k = 0; k <= NEAREST_SAMPLES; k++) {
        const t = k / NEAREST_SAMPLES
        const p = cubicAt(p0, c1, c2, p3, t)
        const d2 = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2
        if (d2 < bestD2) {
          bestD2 = d2
          bestSub = sub
          bestSeg = seg
          bestT = t
        }
      }
    }
  }
  if (bestSub < 0) return null

  // Golden-section refinement inside the winning sample's neighborhood.
  const { p0, c1, c2, p3 } = segmentControls(item.subPaths[bestSub], bestSeg)
  const f = (t: number) => {
    const p = cubicAt(p0, c1, c2, p3, t)
    return (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2
  }
  const phi = (Math.sqrt(5) - 1) / 2
  let lo = Math.max(0, bestT - 1 / NEAREST_SAMPLES)
  let hi = Math.min(1, bestT + 1 / NEAREST_SAMPLES)
  let x1 = hi - phi * (hi - lo)
  let x2 = lo + phi * (hi - lo)
  let f1 = f(x1)
  let f2 = f(x2)
  for (let it = 0; it < 20; it++) {
    if (f1 < f2) {
      hi = x2
      x2 = x1
      f2 = f1
      x1 = hi - phi * (hi - lo)
      f1 = f(x1)
    } else {
      lo = x1
      x1 = x2
      f1 = f2
      x2 = lo + phi * (hi - lo)
      f2 = f(x2)
    }
  }
  const tRef = (lo + hi) / 2
  // Keep whichever of coarse / refined ended up closer (refinement can only
  // wander inside the same basin, but guard against flat plateaus).
  const t = f(tRef) <= bestD2 ? tRef : bestT
  const point = cubicAt(p0, c1, c2, p3, t)
  return { sub: bestSub, seg: bestSeg, t, point, dist: Math.hypot(point.x - pt.x, point.y - pt.y) }
}

/**
 * Split segment `seg` of subpath `sub` at parameter `t` (de Casteljau) and
 * insert the split point as a new node. Straight segments stay straight: the
 * new node gets null handles instead of collapsed ones.
 */
export function insertNode(item: PathItem, sub: number, seg: number, t: number): PathItem {
  const sp = item.subPaths[sub]
  if (!sp || sp.nodes.length < 2 || seg < 0 || seg >= segmentCount(sp)) return item
  const iA = seg
  const iB = (seg + 1) % sp.nodes.length
  const a = sp.nodes[iA]
  const b = sp.nodes[iB]
  const { p0, c1, c2, p3 } = segmentControls(sp, seg)

  const nodes = sp.nodes.slice()
  // "Effective controls on the anchors" also catches degenerate non-null handles.
  const isLine =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) < EPS && Math.hypot(c2.x - p3.x, c2.y - p3.y) < EPS
  if (isLine) {
    nodes.splice(seg + 1, 0, {
      x: p0.x + (p3.x - p0.x) * t,
      y: p0.y + (p3.y - p0.y) * t,
      hIn: null,
      hOut: null,
      kind: 'corner',
    })
  } else {
    const lerp = (u: Vec, v: Vec): Vec => ({ x: u.x + (v.x - u.x) * t, y: u.y + (v.y - u.y) * t })
    const p01 = lerp(p0, c1)
    const p12 = lerp(c1, c2)
    const p23 = lerp(c2, p3)
    const p012 = lerp(p01, p12)
    const p123 = lerp(p12, p23)
    const mid = lerp(p012, p123)
    nodes[iA] = { ...a, hOut: p01 }
    nodes[iB] = { ...b, hIn: p23 }
    // Splice after updating iB: when the segment wraps (iB === 0) the insert
    // index is nodes.length, which leaves index 0 untouched.
    nodes.splice(seg + 1, 0, { x: mid.x, y: mid.y, hIn: p012, hOut: p123, kind: 'smooth' })
  }
  return replaceSubPath(item, sub, { ...sp, nodes })
}

/**
 * Delete the referenced nodes. Subpaths survive only with ≥ 2 nodes (open) /
 * ≥ 3 nodes (closed); returns null when nothing drawable remains.
 */
export function deleteNodes(item: PathItem, refs: NodeRef[]): PathItem | null {
  const bySub = new Map<number, Set<number>>()
  for (const ref of refs) {
    let set = bySub.get(ref.sub)
    if (!set) bySub.set(ref.sub, (set = new Set()))
    set.add(ref.idx)
  }

  const subPaths: SubPath[] = []
  for (let sub = 0; sub < item.subPaths.length; sub++) {
    const sp = item.subPaths[sub]
    const dead = bySub.get(sub)
    if (!dead || dead.size === 0) {
      subPaths.push(sp)
      continue
    }
    const nodes = sp.nodes.filter((_, idx) => !dead.has(idx))
    if (nodes.length >= (sp.closed ? 3 : 2)) subPaths.push({ ...sp, nodes })
  }
  if (subPaths.length === 0) return null
  return { ...item, subPaths }
}

/** Translate the referenced anchors together with their handles. */
export function moveNodes(item: PathItem, refs: NodeRef[], dx: number, dy: number): PathItem {
  const bySub = new Map<number, Set<number>>()
  for (const ref of refs) {
    let set = bySub.get(ref.sub)
    if (!set) bySub.set(ref.sub, (set = new Set()))
    set.add(ref.idx)
  }

  const subPaths = item.subPaths.map((sp, sub) => {
    const moved = bySub.get(sub)
    if (!moved || moved.size === 0) return sp
    return {
      ...sp,
      nodes: sp.nodes.map((node, idx) => (moved.has(idx) ? translateNode(node, dx, dy) : node)),
    }
  })
  return { ...item, subPaths }
}

/**
 * Drag one handle to `to`. With `mirror` on a smooth node, the opposite
 * handle is re-aimed to stay collinear (opposite side of the anchor) while
 * keeping its own length; a degenerate drag (|to − anchor| < ε) leaves the
 * opposite handle untouched.
 */
export function moveHandle(
  item: PathItem,
  ref: NodeRef,
  which: 'in' | 'out',
  to: Vec,
  mirror: boolean,
): PathItem {
  const sp = item.subPaths[ref.sub]
  const node = sp?.nodes[ref.idx]
  if (!sp || !node) return item

  const next: PathNode = { ...node }
  const handle = { x: to.x, y: to.y }
  if (which === 'in') next.hIn = handle
  else next.hOut = handle

  if (mirror && node.kind === 'smooth') {
    const opposite = which === 'in' ? node.hOut : node.hIn
    const dx = to.x - node.x
    const dy = to.y - node.y
    const len = Math.hypot(dx, dy)
    if (opposite && len >= EPS) {
      const oppLen = Math.hypot(opposite.x - node.x, opposite.y - node.y)
      const mirrored = { x: node.x - (dx / len) * oppLen, y: node.y - (dy / len) * oppLen }
      if (which === 'in') next.hOut = mirrored
      else next.hIn = mirrored
    }
  }
  return replaceNode(item, ref, next)
}

/**
 * Change how a node joins its segments. 'corner' only flips the flag;
 * 'smooth' aligns both handles onto one averaged tangent, preserving each
 * existing handle's length and creating any missing handle at 1/3 of the
 * distance to the neighboring anchor.
 */
export function setNodeKind(item: PathItem, ref: NodeRef, kind: NodeKind): PathItem {
  const sp = item.subPaths[ref.sub]
  const node = sp?.nodes[ref.idx]
  if (!sp || !node) return item
  if (kind === 'corner') return replaceNode(item, ref, { ...node, kind: 'corner' })

  const count = sp.nodes.length
  const nextAnchor = ref.idx < count - 1 ? sp.nodes[ref.idx + 1] : sp.closed && count > 1 ? sp.nodes[0] : null
  const prevAnchor = ref.idx > 0 ? sp.nodes[ref.idx - 1] : sp.closed && count > 1 ? sp.nodes[count - 1] : null

  // Near-zero handles carry no direction; treat them as missing.
  const lenOf = (h: Vec | null) => (h ? Math.hypot(h.x - node.x, h.y - node.y) : 0)
  const hOut = node.hOut && lenOf(node.hOut) >= EPS ? node.hOut : null
  const hIn = node.hIn && lenOf(node.hIn) >= EPS ? node.hIn : null

  const dirOut = hOut ? normalize(hOut.x - node.x, hOut.y - node.y) : null
  const dirIn = hIn ? normalize(node.x - hIn.x, node.y - hIn.y) : null
  let tangent: Vec | null = null
  if (dirOut && dirIn) {
    // Exactly opposed directions cancel; fall back to the outgoing one.
    tangent = normalize(dirOut.x + dirIn.x, dirOut.y + dirIn.y) ?? dirOut
  } else if (dirOut || dirIn) {
    tangent = dirOut ?? dirIn
  } else if (nextAnchor && prevAnchor) {
    tangent = normalize(nextAnchor.x - prevAnchor.x, nextAnchor.y - prevAnchor.y)
  } else if (nextAnchor) {
    tangent = normalize(nextAnchor.x - node.x, nextAnchor.y - node.y)
  } else if (prevAnchor) {
    tangent = normalize(node.x - prevAnchor.x, node.y - prevAnchor.y)
  }
  if (!tangent) return replaceNode(item, ref, { ...node, kind: 'smooth' })

  const outLen = hOut ? lenOf(hOut) : nextAnchor ? Math.hypot(nextAnchor.x - node.x, nextAnchor.y - node.y) / 3 : 0
  const inLen = hIn ? lenOf(hIn) : prevAnchor ? Math.hypot(prevAnchor.x - node.x, prevAnchor.y - node.y) / 3 : 0
  return replaceNode(item, ref, {
    ...node,
    kind: 'smooth',
    hOut: outLen >= EPS ? { x: node.x + tangent.x * outLen, y: node.y + tangent.y * outLen } : node.hOut,
    hIn: inLen >= EPS ? { x: node.x - tangent.x * inLen, y: node.y - tangent.y * inLen } : node.hIn,
  })
}

/** Translate the whole item (every anchor and handle). */
export function translateItem(item: PathItem, dx: number, dy: number): PathItem {
  return {
    ...item,
    subPaths: item.subPaths.map((sp) => ({
      ...sp,
      nodes: sp.nodes.map((node) => translateNode(node, dx, dy)),
    })),
  }
}

/**
 * Bounding box over anchors and control points — a cheap superset of the true
 * curve bounds, plenty for selection rectangles and zoom-to-fit. Null when
 * the item has no nodes.
 */
export function itemBounds(item: PathItem): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (p: Vec) => {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  for (const sp of item.subPaths) {
    for (const node of sp.nodes) {
      consider(node)
      if (node.hIn) consider(node.hIn)
      if (node.hOut) consider(node.hOut)
    }
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Tight bounding box over the actual drawn curve — cubic extrema, not the
 * control hull — in the subpaths' own coordinate space. Used to resolve
 * `objectBoundingBox` gradient coordinates on import, where the box must match
 * the geometry SVG renderers use. Null when there are no drawable segments.
 */
export function subPathsTightBounds(subPaths: SubPath[]): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (p: Vec) => {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  for (const sp of subPaths) {
    const count = segmentCount(sp)
    for (let seg = 0; seg < count; seg++) {
      const { p0, c1, c2, p3 } = segmentControls(sp, seg)
      consider(p0)
      consider(p3)
      for (const t of cubicExtremaTs(p0.x, c1.x, c2.x, p3.x)) consider(cubicAt(p0, c1, c2, p3, t))
      for (const t of cubicExtremaTs(p0.y, c1.y, c2.y, p3.y)) consider(cubicAt(p0, c1, c2, p3, t))
    }
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Parameters t ∈ (0,1) where a 1-D cubic Bézier's derivative is zero. */
function cubicExtremaTs(p0: number, c1: number, c2: number, p3: number): number[] {
  // B'(t)=0 ⇒ a·t² + b·t + c = 0 with the coefficients below (derived from the
  // standard cubic, divided through by the common factor of 3).
  const d0 = c1 - p0
  const d1 = c2 - c1
  const d2 = p3 - c2
  const a = d0 - 2 * d1 + d2
  const b = 2 * (d1 - d0)
  const c = d0
  const ts: number[] = []
  const inRange = (t: number) => t > EPS && t < 1 - EPS
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) > EPS) {
      const t = -c / b
      if (inRange(t)) ts.push(t)
    }
    return ts
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return ts
  const s = Math.sqrt(disc)
  const t1 = (-b + s) / (2 * a)
  const t2 = (-b - s) / (2 * a)
  if (inRange(t1)) ts.push(t1)
  if (inRange(t2)) ts.push(t2)
  return ts
}

function normalize(x: number, y: number): Vec | null {
  const len = Math.hypot(x, y)
  if (len < EPS) return null
  return { x: x / len, y: y / len }
}

function translateNode(node: PathNode, dx: number, dy: number): PathNode {
  return {
    x: node.x + dx,
    y: node.y + dy,
    hIn: node.hIn ? { x: node.hIn.x + dx, y: node.hIn.y + dy } : null,
    hOut: node.hOut ? { x: node.hOut.x + dx, y: node.hOut.y + dy } : null,
    kind: node.kind,
  }
}

function replaceSubPath(item: PathItem, sub: number, sp: SubPath): PathItem {
  const subPaths = item.subPaths.slice()
  subPaths[sub] = sp
  return { ...item, subPaths }
}

function replaceNode(item: PathItem, ref: NodeRef, node: PathNode): PathItem {
  const sp = item.subPaths[ref.sub]
  const nodes = sp.nodes.slice()
  nodes[ref.idx] = node
  return replaceSubPath(item, ref.sub, { ...sp, nodes })
}
