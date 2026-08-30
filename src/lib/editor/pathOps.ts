// Structural surgery on a path's subpaths: reverse, open/close, break apart,
// join two ends, and split one compound path into its pieces.
//
// The invariant every one of these preserves: a node's hIn is the control that
// governs the segment ARRIVING at it and hOut the one LEAVING it. Reversing a
// subpath therefore has to swap the two on every node, not just reverse the
// array — the single most common way to get this wrong, and the result is a
// path that renders identically until you drag a handle and it jumps.

import type { PathItem, PathNode, SubPath, Vec } from '../path/types.ts'

/** Swap a node's handles — used wherever traversal direction flips. */
export function flipNode(node: PathNode): PathNode {
  return { ...node, hIn: node.hOut, hOut: node.hIn }
}

/** Reverse one subpath's direction, keeping the geometry identical. */
export function reverseSubPath(sp: SubPath): SubPath {
  const nodes = sp.nodes.map(flipNode).reverse()
  // A closed loop's start node is arbitrary, but reversing an OPEN path must
  // keep the same two endpoints, which plain reversal already does.
  return { nodes, closed: sp.closed }
}

/** Reverse one subpath of an item (or every subpath when `sub` is null). */
export function reversePath(item: PathItem, sub: number | null = null): PathItem {
  const subPaths = item.subPaths.map((sp, i) =>
    sub === null || i === sub ? reverseSubPath(sp) : sp,
  )
  return { ...item, subPaths, loops: undefined }
}

/** Close an open subpath (its last node joins back to its first). */
export function closeSubPath(item: PathItem, sub: number): PathItem {
  const sp = item.subPaths[sub]
  if (!sp || sp.closed || sp.nodes.length < 3) return item
  const subPaths = item.subPaths.slice()
  subPaths[sub] = { nodes: sp.nodes, closed: true }
  return { ...item, subPaths, loops: undefined }
}

/**
 * Open a closed subpath by cutting it at `idx`, so the loop becomes a strand
 * that starts and ends at that node. The node is DUPLICATED — a cut produces
 * two coincident endpoints, which is what lets you then drag them apart.
 */
export function openSubPathAt(item: PathItem, sub: number, idx: number): PathItem {
  const sp = item.subPaths[sub]
  if (!sp || !sp.closed || sp.nodes.length < 2) return item
  const n = sp.nodes.length
  const rotated = Array.from({ length: n }, (_, i) => sp.nodes[(idx + i) % n])
  const first = rotated[0]
  const nodes = [
    { ...first, hIn: null },
    ...rotated.slice(1),
    { ...first, hOut: null },
  ]
  const subPaths = item.subPaths.slice()
  subPaths[sub] = { nodes, closed: false }
  return { ...item, subPaths, loops: undefined }
}

/**
 * Split an OPEN subpath in two at an interior node, duplicating that node so
 * each half keeps an endpoint there.
 */
export function breakAt(item: PathItem, sub: number, idx: number): PathItem {
  const sp = item.subPaths[sub]
  if (!sp) return item
  if (sp.closed) return openSubPathAt(item, sub, idx)
  if (idx <= 0 || idx >= sp.nodes.length - 1) return item

  const left: SubPath = {
    nodes: [...sp.nodes.slice(0, idx), { ...sp.nodes[idx], hOut: null }],
    closed: false,
  }
  const right: SubPath = {
    nodes: [{ ...sp.nodes[idx], hIn: null }, ...sp.nodes.slice(idx + 1)],
    closed: false,
  }
  const subPaths = item.subPaths.slice()
  subPaths.splice(sub, 1, left, right)
  return { ...item, subPaths, loops: undefined }
}

/**
 * Join two open endpoints. Same subpath ⇒ it closes; different subpaths ⇒ they
 * merge into one, reversing whichever needs it so the two chosen ends meet.
 *
 * `weld` collapses the two endpoints into one node at their midpoint (the
 * normal case — you are closing a gap). Without it both nodes survive, joined
 * by a new segment, which is what you want when the ends are far apart.
 */
export function joinEnds(
  item: PathItem,
  a: { sub: number; idx: number },
  b: { sub: number; idx: number },
  weld = true,
): PathItem {
  const spA = item.subPaths[a.sub]
  const spB = item.subPaths[b.sub]
  if (!spA || !spB || spA.closed || spB.closed) return item
  if (!isEndpoint(spA, a.idx) || !isEndpoint(spB, b.idx)) return item

  if (a.sub === b.sub) {
    if (a.idx === b.idx) return item
    const closed = closeSubPath(item, a.sub)
    return weld ? closed : closed
  }

  // Orient both strands so A ends where B begins.
  const strandA = a.idx === 0 ? reverseSubPath(spA) : spA
  const strandB = b.idx === 0 ? spB : reverseSubPath(spB)

  let nodes: PathNode[]
  if (weld) {
    const tail = strandA.nodes[strandA.nodes.length - 1]
    const head = strandB.nodes[0]
    const merged: PathNode = {
      x: (tail.x + head.x) / 2,
      y: (tail.y + head.y) / 2,
      hIn: tail.hIn,
      hOut: head.hOut,
      // The welded node is a corner unless both sides were already smooth —
      // guessing "smooth" would silently bend two strands that met at an angle.
      kind: tail.kind === 'smooth' && head.kind === 'smooth' ? 'smooth' : 'corner',
    }
    nodes = [...strandA.nodes.slice(0, -1), merged, ...strandB.nodes.slice(1)]
  } else {
    nodes = [...strandA.nodes, ...strandB.nodes]
  }

  const subPaths = item.subPaths.filter((_, i) => i !== a.sub && i !== b.sub)
  subPaths.splice(Math.min(a.sub, b.sub), 0, { nodes, closed: false })
  return { ...item, subPaths, loops: undefined }
}

function isEndpoint(sp: SubPath, idx: number): boolean {
  return !sp.closed && (idx === 0 || idx === sp.nodes.length - 1)
}

/**
 * Split a compound path into one item per subpath. The caller supplies fresh
 * ids; holes become their own filled shapes, which is the honest result — a
 * hole only exists relative to the shape it was punched through.
 */
export function splitCompound(item: PathItem, nextId: () => string): PathItem[] {
  if (item.subPaths.length < 2) return [item]
  return item.subPaths.map((sp) => ({
    ...item,
    id: nextId(),
    subPaths: [sp],
    loops: undefined,
  }))
}

/** Merge several paths' subpaths into one compound path (keeps the first's paint). */
export function combinePaths(items: PathItem[]): PathItem | null {
  if (items.length === 0) return null
  const [first, ...rest] = items
  return {
    ...first,
    subPaths: [...first.subPaths, ...rest.flatMap((it) => it.subPaths)],
    // A compound path built from overlapping shapes is only legible with
    // evenodd — nonzero would fill the "hole" whenever the windings agree.
    fillRule: 'evenodd',
    loops: undefined,
  }
}

/** Distance between two points — the gap a join would weld. */
export function endpointGap(item: PathItem, a: { sub: number; idx: number }, b: { sub: number; idx: number }): number {
  const na = item.subPaths[a.sub]?.nodes[a.idx]
  const nb = item.subPaths[b.sub]?.nodes[b.idx]
  if (!na || !nb) return Infinity
  return Math.hypot(na.x - nb.x, na.y - nb.y)
}

/** Every open endpoint of an item, as node refs. */
export function openEndpoints(item: PathItem): { sub: number; idx: number; point: Vec }[] {
  const out: { sub: number; idx: number; point: Vec }[] = []
  item.subPaths.forEach((sp, sub) => {
    if (sp.closed || sp.nodes.length === 0) return
    const first = sp.nodes[0]
    const last = sp.nodes[sp.nodes.length - 1]
    out.push({ sub, idx: 0, point: { x: first.x, y: first.y } })
    if (sp.nodes.length > 1) {
      out.push({ sub, idx: sp.nodes.length - 1, point: { x: last.x, y: last.y } })
    }
  })
  return out
}
