// The skeleton as a graph: junction NODES and the pixel CHAINS between them, with the
// two clean-ups a thinned skeleton always needs before it can be read as strokes.
//
//  - Spurs. Thinning grows a short branch at every corner, every butt cap (one toward
//    each corner of the cap) and every place the ink is a little fatter. A branch that
//    ends free and is shorter than ~1.5× the local radius is such an artifact; it is
//    pruned, and a node the pruning leaves with two chains dissolves into one chain
//    (with one chain it becomes that chain's free end). A corner is found again by the
//    fitter, from the turn, and its apex rebuilt from the arms there (fit.ts).
//  - Split crossings. Two strokes crossing at an angle short of 90° thin to two
//    Y-junctions joined by a short run along the bisector, not to one X. Where the four
//    outer arms of such a pair line up as two straight lines through it, the run is
//    contracted to one 4-arm node so the pairing in assemble.ts can hand each line
//    straight through (`weldCrossings`).
//
// Everything is in integer pixel indices here; profile.ts turns chains into sub-pixel
// centrelines afterwards. Radii come from the distance transform (`dt`).

import { connectivity8 } from './thin.ts'

export interface SkelNode {
  id: number
  /** Centroid of the junction pixels (px). */
  x: number
  y: number
  /** Inscribed radius at the node (px) — the largest DT among its pixels. */
  r: number
  pixels: number[]
  /** Incident chain ids (a chain that starts and ends here appears twice). */
  chains: number[]
  alive: boolean
  /** Several junction clusters contracted into one (`contractClusterLinks`,
   *  `weldCrossings`): the skeleton inside is not the stroke, so its arms are cut
   *  back to the zone and re-joined at their lines' meet. */
  welded?: boolean
}

export interface SkelChain {
  id: number
  /** Skeleton pixel indices in order, from `a`'s side to `b`'s side. Never includes node pixels. */
  pixels: number[]
  /** Node ids at each end, or -1 for a free end. */
  a: number
  b: number
  /** A ring with no node at all (a stroked circle). */
  closed: boolean
  /** Arc length through the pixel centres (px). */
  len: number
  alive: boolean
}

export interface SkeletonGraph {
  nodes: SkelNode[]
  chains: SkelChain[]
  width: number
  height: number
}

/** Free-ending branches shorter than this many local radii are thinning artifacts. */
export const SPUR_K = 1.5
/** …plus this many px, so a 1px stroke's r=0.5 still prunes its one-pixel corner spurs. */
export const SPUR_PLUS = 1.5
/** A short branch whose tip still reads this share of the node's radius is a stub, not a spur. */
export const SPUR_TIP_RADIUS = 0.75

const N8 = (w: number): number[] => [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]

/** Build the graph of a 1-px skeleton. `dt` is the distance transform of the ink mask. */
export function skeletonGraph(skel: Uint8Array, dt: Float32Array, width: number, height: number): SkeletonGraph {
  const n = width * height
  const off = N8(width)
  // Neighbour count and Yokoi connectivity per skeleton pixel: `count` tells an end
  // (≤1) from the rest, `conn` a junction (≥3) from a run (2) — a run pixel can have
  // three neighbours where two of them touch, and must not read as a junction.
  const count = new Uint8Array(n)
  const conn = new Uint8Array(n)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      if (!skel[i]) continue
      let c = 0
      for (const o of off) if (skel[i + o]) c++
      count[i] = c
      conn[i] = connectivity8(skel, i, width)
    }
  }
  // Junction clusters → nodes.
  const nodeOf = new Int32Array(n).fill(-1)
  const nodes: SkelNode[] = []
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (!skel[i] || count[i] < 3 || nodeOf[i] >= 0) continue
    const id = nodes.length
    const node: SkelNode = { id, x: 0, y: 0, r: 0, pixels: [], chains: [], alive: true }
    nodeOf[i] = id
    stack.length = 0
    stack.push(i)
    while (stack.length) {
      const p = stack.pop()!
      node.pixels.push(p)
      for (const o of off) {
        const q = p + o
        if (skel[q] && count[q] >= 3 && nodeOf[q] < 0) {
          nodeOf[q] = id
          stack.push(q)
        }
      }
    }
    let sx = 0
    let sy = 0
    for (const p of node.pixels) {
      sx += p % width
      sy += (p / width) | 0
      if (dt[p] > node.r) node.r = dt[p]
    }
    node.x = sx / node.pixels.length
    node.y = sy / node.pixels.length
    nodes.push(node)
  }

  // Chains. Walk from every node pixel's non-node neighbours, then from free ends,
  // then whatever is left closes on itself.
  const inChain = new Uint8Array(n)
  const chains: SkelChain[] = []
  const stepLen = (p: number, q: number): number => {
    const d = Math.abs(q - p)
    return d === 1 || d === width ? 1 : Math.SQRT2
  }
  /** The next pixel from `cur` not `prev` and not yet in a chain; orthogonal neighbours
   *  win over a diagonal that only shortcuts one of them. Returns -1 at a free end. */
  const next = (cur: number, prev: number): number => {
    let orth = -1
    let diag = -1
    for (let k = 0; k < 8; k++) {
      const q = cur + off[k]
      if (!skel[q] || q === prev || inChain[q]) continue
      if (nodeOf[q] >= 0) {
        // Reaching a junction cluster ends the chain there; prefer an orthogonal
        // node pixel if both kinds are adjacent (either lands on the same node).
        if (k % 2 === 0) return q
        if (diag < 0) diag = q
        continue
      }
      if (k % 2 === 0) {
        if (orth < 0) orth = q
      } else if (diag < 0) diag = q
    }
    return orth >= 0 ? orth : diag
  }
  const walk = (start: number, from: number, aNode: number): void => {
    const chain: SkelChain = { id: chains.length, pixels: [], a: aNode, b: -1, closed: false, len: 0, alive: true }
    let prev = from
    let cur = start
    while (cur >= 0 && nodeOf[cur] < 0) {
      inChain[cur] = 1
      chain.pixels.push(cur)
      const q = next(cur, prev)
      if (q >= 0) chain.len += stepLen(cur, q)
      prev = cur
      cur = q
    }
    if (cur >= 0) chain.b = nodeOf[cur]
    if (chain.pixels.length === 0) {
      // Two adjacent junction clusters with nothing between them: a zero-length chain
      // still records the adjacency so the weld / contraction can see it.
      if (aNode >= 0 && chain.b >= 0 && aNode !== chain.b) {
        chains.push(chain)
        nodes[aNode].chains.push(chain.id)
        nodes[chain.b].chains.push(chain.id)
      }
      return
    }
    chains.push(chain)
    if (chain.a >= 0) nodes[chain.a].chains.push(chain.id)
    if (chain.b >= 0) nodes[chain.b].chains.push(chain.id)
  }
  for (const node of nodes) {
    for (const p of node.pixels) {
      for (const o of off) {
        const q = p + o
        if (!skel[q] || inChain[q]) continue
        if (nodeOf[q] >= 0) {
          if (nodeOf[q] !== node.id && nodeOf[q] > node.id) walk(q, p, node.id)
          continue
        }
        walk(q, p, node.id)
      }
    }
  }
  for (let i = 0; i < n; i++) if (skel[i] && !inChain[i] && nodeOf[i] < 0 && count[i] <= 1) walk(i, -1, -1)
  for (let i = 0; i < n; i++) {
    if (!skel[i] || inChain[i] || nodeOf[i] >= 0) continue
    // A ring: walk until it comes back around.
    const chain: SkelChain = { id: chains.length, pixels: [], a: -1, b: -1, closed: true, len: 0, alive: true }
    let prev = -1
    let cur = i
    while (cur >= 0 && !inChain[cur]) {
      inChain[cur] = 1
      chain.pixels.push(cur)
      const q = next(cur, prev)
      prev = cur
      cur = q
    }
    // A leftover of fewer than four pixels is a walker's crumb (a pixel a chain stepped
    // over on its diagonal), not a ring.
    if (chain.pixels.length < 4) continue
    for (let k = 0; k < chain.pixels.length; k++)
      chain.len += stepLen(chain.pixels[k], chain.pixels[(k + 1) % chain.pixels.length])
    chains.push(chain)
  }
  return { nodes, chains, width, height }
}

/** Live incident chains of a node. */
export function nodeDegree(g: SkeletonGraph, node: SkelNode): number {
  return node.chains.filter((c) => g.chains[c].alive).length
}

/**
 * Prune spurs and dissolve the nodes that leaves trivial, to a fixpoint. A free-ending
 * chain shorter than `SPUR_K · r + SPUR_PLUS` (r = its node's inscribed radius) is
 * dropped. A node left with two chains is spliced out (the chains join, its pixels
 * between them); one with a single chain becomes that chain's free end.
 */
export function pruneSpurs(g: SkeletonGraph, dt: Float32Array): void {
  for (;;) {
    let changed = false
    for (const c of g.chains) {
      if (!c.alive || c.closed) continue
      const free = c.a < 0 !== c.b < 0
      if (!free) continue
      const node = g.nodes[c.a >= 0 ? c.a : c.b]
      if (!node.alive) continue
      if (c.len >= SPUR_K * node.r + SPUR_PLUS) continue
      // Short — but a real stub (the nub on top of an umbrella) reaches PAST the
      // junction's own radius and keeps its own half-width at its tip, where thinning's
      // branch toward a corner is a pixel or two long, or has run out of ink. Both
      // tests, because a round join is a disc of radius r about the apex and a spur
      // running into it keeps reading r for its whole (short) length.
      const tip = c.a >= 0 ? c.pixels[c.pixels.length - 1] : c.pixels[0]
      if (tip !== undefined && c.len > node.r + 1 && dt[tip] >= SPUR_TIP_RADIUS * node.r) continue
      c.alive = false
      changed = true
    }
    for (const node of g.nodes) {
      if (!node.alive) continue
      const live = node.chains.filter((id) => g.chains[id].alive)
      if (live.length >= 3) continue
      if (live.length === 0) {
        node.alive = false
        changed = true
        continue
      }
      if (live.length === 1) {
        // The chain now ends free, with the node's pixels as its last steps.
        const c = g.chains[live[0]]
        absorbNode(g, c, node, dt)
        node.alive = false
        changed = true
        continue
      }
      // Two chains: splice into one. Where that was a corner, the fitter finds it again
      // from the turn and rebuilds the apex from the arms (fit.ts) — with the raster's
      // say on whether it is a corner at all, which the graph cannot have.
      const [ia, ib] = live
      if (ia === ib) {
        // A single chain that starts and ends at this node: a ring through a former
        // junction.
        const c = g.chains[ia]
        c.closed = true
        c.a = -1
        c.b = -1
        node.alive = false
        changed = true
        continue
      }
      spliceThrough(g, g.chains[ia], g.chains[ib], node)
      node.alive = false
      changed = true
    }
    if (!changed) break
  }
}

/** Orient `c` so that it ENDS at `node`, in place. */
function orientToEnd(c: SkelChain, node: SkelNode): void {
  if (c.b === node.id) return
  c.pixels.reverse()
  const t = c.a
  c.a = c.b
  c.b = t
}

/** A chain's remaining node becomes its free end, taking the node's nearest pixel. */
function absorbNode(g: SkeletonGraph, c: SkelChain, node: SkelNode, dt: Float32Array): void {
  void dt
  orientToEnd(c, node)
  // Append the node pixels in walking order from the chain's last pixel.
  const last = c.pixels[c.pixels.length - 1]
  c.pixels.push(...orderFrom(node.pixels, last, g.width))
  c.b = -1
  recomputeLen(c, g.width)
}

/** Join two chains meeting at `node` into `p` (which keeps its id); `q` dies. */
function spliceThrough(g: SkeletonGraph, p: SkelChain, q: SkelChain, node: SkelNode): void {
  orientToEnd(p, node)
  // q must START at the node.
  if (q.a !== node.id) {
    q.pixels.reverse()
    const t = q.a
    q.a = q.b
    q.b = t
  }
  const last = p.pixels[p.pixels.length - 1] ?? q.pixels[0]
  const mid = last !== undefined ? orderFrom(node.pixels, last, g.width) : node.pixels.slice()
  p.pixels.push(...mid, ...q.pixels)
  p.b = q.b
  if (p.b >= 0) {
    const far = g.nodes[p.b]
    far.chains = far.chains.map((id) => (id === q.id ? p.id : id))
  }
  q.alive = false
  q.pixels = []
  recomputeLen(p, g.width)
}

/** The node's pixels ordered by a greedy nearest-neighbour walk from `from`. */
function orderFrom(pixels: number[], from: number, width: number): number[] {
  const left = pixels.slice()
  const out: number[] = []
  let cur = from
  const cx = (p: number): number => p % width
  const cy = (p: number): number => (p / width) | 0
  while (left.length) {
    let best = 0
    let bd = Infinity
    for (let k = 0; k < left.length; k++) {
      const d = (cx(left[k]) - cx(cur)) ** 2 + (cy(left[k]) - cy(cur)) ** 2
      if (d < bd) {
        bd = d
        best = k
      }
    }
    cur = left[best]
    out.push(cur)
    left.splice(best, 1)
  }
  return out
}

function recomputeLen(c: SkelChain, width: number): void {
  let L = 0
  for (let k = 1; k < c.pixels.length; k++) {
    const d = Math.abs(c.pixels[k] - c.pixels[k - 1])
    L +=
      d === 1 || d === width
        ? 1
        : Math.hypot(
            (c.pixels[k] % width) - (c.pixels[k - 1] % width),
            ((c.pixels[k] / width) | 0) - ((c.pixels[k - 1] / width) | 0),
          )
  }
  c.len = L
}

/** Direction (unit) a chain travels as it ARRIVES at `node`, read over the last `span` px. */
export function arrivalDirection(
  g: SkeletonGraph,
  c: SkelChain,
  node: SkelNode,
  span: number,
  end: 'a' | 'b' = c.b === node.id ? 'b' : 'a',
): { x: number; y: number } | null {
  const w = g.width
  const pts = end === 'b' ? c.pixels : c.pixels.slice().reverse()
  if (pts.length === 0) return null
  // From the pixel ~span back to the node centroid.
  let acc = 0
  let k = pts.length - 1
  while (k > 0 && acc < span) {
    const d = Math.abs(pts[k] - pts[k - 1])
    acc += d === 1 || d === w ? 1 : Math.SQRT2
    k--
  }
  const sx = pts[k] % w
  const sy = (pts[k] / w) | 0
  const dx = node.x - sx
  const dy = node.y - sy
  const len = Math.hypot(dx, dy)
  if (len < 1e-6) return null
  return { x: dx / len, y: dy / len }
}

/** A junction–junction chain no longer than this many radii (+1 px) is one junction's
 *  cluster: thinning's one- and two-pixel links inside an asterisk centre. Not more —
 *  at two radii the 2 px staff-and-stem junctions of a score merged into welded
 *  clusters and its note heads lost their stems. A split CROSSING (a figure-8's middle:
 *  two junctions a stroke width apart) is `weldCrossings`' job, which checks that the
 *  arms go THROUGH; a door frame's two junctions sit four radii apart and stay two. */
export const CLUSTER_LINK_K = 0.6

/**
 * Merge junction clusters that thinning split by a pixel or two: an 8-arm asterisk
 * centre comes out as three or four junction pixels joined by one-pixel chains, and
 * read one by one each pairs the wrong arms. A chain between two nodes no longer
 * than `CLUSTER_LINK_K · r + 1` is such a link; its nodes become one, flagged
 * `welded` so every arm is cut back to the zone and re-joined at the meet (the
 * skeleton inside such a cluster is not the stroke). Repeats to a fixpoint.
 */
export function contractClusterLinks(g: SkeletonGraph, dt: Float32Array): void {
  for (;;) {
    let merged = false
    for (const link of g.chains) {
      if (!link.alive || link.closed || link.a < 0 || link.b < 0 || link.a === link.b) continue
      const A = g.nodes[link.a]
      const B = g.nodes[link.b]
      if (!A.alive || !B.alive) continue
      if (link.len > CLUSTER_LINK_K * Math.max(A.r, B.r) + 1) continue
      mergeNodes(g, A, B, link, dt)
      merged = true
    }
    if (!merged) break
  }
}

/** Fold node B and the chain `link` between them into node A. */
function mergeNodes(g: SkeletonGraph, A: SkelNode, B: SkelNode, link: SkelChain, dt: Float32Array): void {
  for (const id of B.chains) {
    if (id === link.id) continue
    const c = g.chains[id]
    if (c.a === B.id) c.a = A.id
    if (c.b === B.id) c.b = A.id
    A.chains.push(id)
  }
  A.chains = A.chains.filter((id) => id !== link.id)
  link.alive = false
  const nA = A.pixels.length
  const nB = B.pixels.length
  A.x = (A.x * nA + B.x * nB) / (nA + nB)
  A.y = (A.y * nA + B.y * nB) / (nA + nB)
  A.pixels.push(...B.pixels, ...link.pixels)
  A.r = Math.max(A.r, B.r)
  for (const p of link.pixels) if (dt[p] > A.r) A.r = dt[p]
  A.welded = true
  B.alive = false
  B.chains = []
}

/**
 * Weld a split crossing: two degree-3 nodes joined by a chain no longer than
 * `maxK · max(rA, rB)` whose four OUTER arms form two straight lines through the pair
 * (each arm at A continues into one at B within `turnDeg`, and the two continuations use
 * different arms). Contracts the pair to one node at the intersection of the two lines,
 * the joining chain dropped. Repeats until no pair qualifies.
 */
export function weldCrossings(g: SkeletonGraph, dt: Float32Array, maxK = 12, turnDeg = 25): void {
  const cosMin = Math.cos((turnDeg * Math.PI) / 180)
  for (;;) {
    let welded = false
    for (const mid of g.chains) {
      if (!mid.alive || mid.closed || mid.a < 0 || mid.b < 0 || mid.a === mid.b) continue
      const A = g.nodes[mid.a]
      const B = g.nodes[mid.b]
      if (!A.alive || !B.alive || nodeDegree(g, A) !== 3 || nodeDegree(g, B) !== 3) continue
      const r = Math.max(A.r, B.r)
      if (mid.len > maxK * r) continue
      const span = Math.max(4, 3 * r)
      // Every arm END at the node, not every chain: a lobe of a figure-8 is one chain
      // with BOTH ends on the same node, and read by chain id it gave one direction
      // twice — so the crossing never welded and the loop fell open.
      const arms = (node: SkelNode): { c: SkelChain; d: { x: number; y: number } }[] => {
        const out: { c: SkelChain; d: { x: number; y: number } }[] = []
        for (const id of new Set(node.chains)) {
          if (id === mid.id) continue
          const c = g.chains[id]
          if (!c.alive) continue
          for (const end of ['a', 'b'] as const) {
            if ((end === 'a' ? c.a : c.b) !== node.id) continue
            const d = arrivalDirection(g, c, node, span, end)
            if (d) out.push({ c, d })
          }
        }
        return out
      }
      const aA = arms(A)
      const aB = arms(B)
      if (aA.length !== 2 || aB.length !== 2) continue
      // Arm i at A continues into arm j at B when the direction INTO A equals the
      // direction OUT of B (= −arrival at B), and the line through A's arm passes near B.
      const through = (a: { d: { x: number; y: number } }, b: { d: { x: number; y: number } }): boolean =>
        a.d.x * -b.d.x + a.d.y * -b.d.y >= cosMin
      const ok = (through(aA[0], aB[0]) && through(aA[1], aB[1])) || (through(aA[0], aB[1]) && through(aA[1], aB[0]))
      if (!ok) continue
      // Contract: B's other chains move to A; the mid chain dies; A sits between.
      // Read both positions BEFORE the merge: mergeNodes already moves A to the
      // pixel-weighted centroid, and averaging that with B again put A 3/4 of the way to B.
      const mx = (A.x + B.x) / 2
      const my = (A.y + B.y) / 2
      mergeNodes(g, A, B, mid, dt)
      A.x = mx
      A.y = my
      welded = true
    }
    if (!welded) break
  }
}
