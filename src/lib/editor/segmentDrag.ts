// Dragging a curve directly — grab the stroke anywhere between two anchors and
// bend it, instead of hunting for the two handles that control it.
//
// With P0 and P3 fixed, moving B(t) by d requires
//
//   b1·ΔC1 + b2·ΔC2 = d,   b1 = 3(1-t)²t,  b2 = 3(1-t)t²
//
// We take the minimum-norm solution
//
//   ΔC1 = d·b1/(b1²+b2²),   ΔC2 = d·b2/(b1²+b2²)
//
// so grabbing near one end mostly moves that end's handle and grabbing the
// middle shares the move equally, keeping the curve under the cursor.

import type { PathItem, PathNode, SubPath, Vec } from '../path/types.ts'
import { moveHandleNode, segmentControls } from '../path/geometry.ts'

/**
 * Lower clamp on t. Near an anchor the basis weights vanish and the required
 * control-point move explodes, so closer drags behave as one at this t.
 */
const T_CLAMP = 0.08

/** Solve the two control-point deltas for moving B(t) by `d`. */
export function solveSegmentDrag(t: number, d: Vec): { dc1: Vec; dc2: Vec } {
  const tc = Math.max(T_CLAMP, Math.min(1 - T_CLAMP, t))
  const b1 = 3 * (1 - tc) * (1 - tc) * tc
  const b2 = 3 * (1 - tc) * tc * tc
  const denom = b1 * b1 + b2 * b2
  if (denom < 1e-12) return { dc1: { x: 0, y: 0 }, dc2: { x: 0, y: 0 } }
  return {
    dc1: { x: (d.x * b1) / denom, y: (d.y * b1) / denom },
    dc2: { x: (d.x * b2) / denom, y: (d.y * b2) / denom },
  }
}

/**
 * Bend segment `seg` of subpath `sub` so the point at parameter `t` lands on
 * `to`, keeping both endpoints where they are.
 *
 * A straight segment (both handles collapsed) grows handles on the first drag.
 * `from` is the on-curve point at pointerdown, not the previous frame's, so a
 * long drag cannot accumulate drift.
 */
export function dragSegment(
  item: PathItem,
  sub: number,
  seg: number,
  t: number,
  from: Vec,
  to: Vec,
  opts: { mirrorSmooth?: boolean } = {},
): PathItem {
  const sp = item.subPaths[sub]
  if (!sp) return item
  const n = sp.nodes.length
  if (n < 2) return item
  const aIdx = seg
  const bIdx = (seg + 1) % n
  const a = sp.nodes[aIdx]
  const b = sp.nodes[bIdx]
  if (!a || !b) return item

  const { c1, c2 } = segmentControls(sp, seg)
  const { dc1, dc2 } = solveSegmentDrag(t, { x: to.x - from.x, y: to.y - from.y })

  const nextC1: Vec = { x: c1.x + dc1.x, y: c1.y + dc1.y }
  const nextC2: Vec = { x: c2.x + dc2.x, y: c2.y + dc2.y }

  const mirror = opts.mirrorSmooth !== false
  // moveHandleNode re-mirrors the opposite handle when the node is smooth, so a
  // bend propagates across a smooth joint exactly as dragging the handle would.
  const nextA = moveHandleNode(a, 'out', nextC1, mirror)
  const nextB = moveHandleNode(b, 'in', nextC2, mirror)

  const nodes = sp.nodes.slice()
  nodes[aIdx] = nextA
  nodes[bIdx] = nextB
  const subPaths = item.subPaths.slice()
  subPaths[sub] = { nodes, closed: sp.closed }
  return { ...item, subPaths }
}

/**
 * Move a whole segment bodily, anchors and handles (the Alt-drag variant);
 * its neighbours stretch to follow.
 */
export function translateSegment(item: PathItem, sub: number, seg: number, dx: number, dy: number): PathItem {
  const sp = item.subPaths[sub]
  if (!sp) return item
  const n = sp.nodes.length
  if (n < 2) return item
  const aIdx = seg
  const bIdx = (seg + 1) % n
  const nodes = sp.nodes.map((node, i) => (i === aIdx || i === bIdx ? shiftNode(node, dx, dy) : node))
  const subPaths = item.subPaths.slice()
  subPaths[sub] = { nodes, closed: sp.closed }
  return { ...item, subPaths }
}

function shiftNode(node: PathNode, dx: number, dy: number): PathNode {
  return {
    ...node,
    x: node.x + dx,
    y: node.y + dy,
    hIn: node.hIn ? { x: node.hIn.x + dx, y: node.hIn.y + dy } : null,
    hOut: node.hOut ? { x: node.hOut.x + dx, y: node.hOut.y + dy } : null,
  }
}

/** True when the segment has no curvature — both controls sit on the anchors. */
export function isStraightSegment(sp: SubPath, seg: number): boolean {
  const { p0, c1, c2, p3 } = segmentControls(sp, seg)
  return c1.x === p0.x && c1.y === p0.y && c2.x === p3.x && c2.y === p3.y
}
