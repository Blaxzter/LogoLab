// Phase 1 of the planar-subdivision tracer (plan §Phase 1): extract the boundary
// network of the segmentation label map as a planar graph on the pixel-corner
// lattice. Every boundary between two regions becomes ONE edge (a chain of unit
// "crack" segments between two junctions, or a pure closed loop), carrying the
// ordered label pair on its two sides. Phase 2 fits each edge once; Phase 3
// assembles regions from shared edges so adjacent regions are byte-coincident.
//
// Lattice: corners at integer (cx,cy), cx∈0..w, cy∈0..h, indexed cy*(w+1)+cx.
// A "crack" is the unit lattice segment between two 4-adjacent pixels of
// different labels; out-of-bounds AND transparent (label -1) collapse to one
// exterior label EXT so border-touching and floating regions both close.
// Directions: 0=E(+x) 1=S(+y) 2=W(-x) 3=N(-y) (screen coords, y down).
//
// Pure & deterministic: integer keys, fixed scan orders, no PRNG/Date.

import type { Vec } from '../path/types'

/** Exterior / transparent label (out-of-bounds and source label -1). */
export const EXT = -1

export interface PlanarEdge {
  id: number
  /** Ordered lattice corner coordinates, start→end (canonical direction). */
  pts: Vec[]
  /** Junction corner index at each end, or -1 for a pure loop (closed). */
  startV: number
  endV: number
  /** Region label on the left / right of the canonical start→end traversal. */
  left: number
  right: number
  /** Lattice direction leaving startV / of the final step arriving endV (0..3). */
  dirStart: number
  dirEnd: number
  closed: boolean
}

export interface PlanarNetwork {
  width: number
  height: number
  edges: PlanarEdge[]
  /** Lattice corner indices that are junctions (crack degree ≥ 3). */
  junctions: number[]
}

const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

/** Build the planar boundary network from a label map. */
export function buildPlanarNetwork(labels: Int32Array, width: number, height: number): PlanarNetwork {
  const cw = width + 1
  const labelAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? EXT : labels[y * width + x]

  // A crack exists on a lattice segment iff the two pixels it separates differ.
  // crackE(cx,cy): horizontal crack (cx,cy)→(cx+1,cy), between N pixel (cx,cy-1)
  // and S pixel (cx,cy). crackS(cx,cy): vertical crack (cx,cy)→(cx,cy+1), between
  // W pixel (cx-1,cy) and E pixel (cx,cy).
  const crackE = (cx: number, cy: number): boolean =>
    cx >= 0 && cx < width && cy >= 0 && cy <= height && labelAt(cx, cy - 1) !== labelAt(cx, cy)
  const crackS = (cx: number, cy: number): boolean =>
    cy >= 0 && cy < height && cx >= 0 && cx <= width && labelAt(cx - 1, cy) !== labelAt(cx, cy)

  // Is there a crack leaving corner (cx,cy) in direction d?
  const crackInDir = (cx: number, cy: number, d: number): boolean => {
    switch (d) {
      case 0: return crackE(cx, cy)
      case 1: return crackS(cx, cy)
      case 2: return crackE(cx - 1, cy)
      default: return crackS(cx, cy - 1)
    }
  }
  const degree = (cx: number, cy: number): number =>
    (crackInDir(cx, cy, 0) ? 1 : 0) +
    (crackInDir(cx, cy, 1) ? 1 : 0) +
    (crackInDir(cx, cy, 2) ? 1 : 0) +
    (crackInDir(cx, cy, 3) ? 1 : 0)

  // Labels to the left / right of a unit step from (cx,cy) in direction d.
  const stepLabels = (cx: number, cy: number, d: number): { left: number; right: number } => {
    switch (d) {
      case 0: return { left: labelAt(cx, cy - 1), right: labelAt(cx, cy) } // E
      case 1: return { left: labelAt(cx, cy), right: labelAt(cx - 1, cy) } // S
      case 2: return { left: labelAt(cx - 1, cy), right: labelAt(cx - 1, cy - 1) } // W
      default: return { left: labelAt(cx - 1, cy - 1), right: labelAt(cx, cy - 1) } // N
    }
  }

  // Consumed bitmaps (undirected cracks): each crack belongs to exactly one edge.
  const consumedE = new Uint8Array(width * (height + 1)) // E-crack at (cx,cy): cy*width+cx
  const consumedS = new Uint8Array((width + 1) * height) // S-crack at (cx,cy): cy*(width+1)+cx
  const crackKey = (cx: number, cy: number, d: number): { arr: Uint8Array; i: number } => {
    switch (d) {
      case 0: return { arr: consumedE, i: cy * width + cx }
      case 2: return { arr: consumedE, i: cy * width + (cx - 1) }
      case 1: return { arr: consumedS, i: cy * cw + cx }
      default: return { arr: consumedS, i: (cy - 1) * cw + cx }
    }
  }
  const isConsumed = (cx: number, cy: number, d: number): boolean => {
    const k = crackKey(cx, cy, d)
    return k.arr[k.i] === 1
  }
  const consume = (cx: number, cy: number, d: number): void => {
    const k = crackKey(cx, cy, d)
    k.arr[k.i] = 1
  }

  const isJunction = (cx: number, cy: number): boolean => degree(cx, cy) >= 3
  const cidx = (cx: number, cy: number): number => cy * cw + cx

  const edges: PlanarEdge[] = []
  const junctions: number[] = []
  let nextId = 0

  // Walk one chain of cracks from corner (sx,sy) leaving in direction d0 until a
  // junction (or a degree≠2 dead end / back to a junction). Consumes its cracks.
  const walkChain = (sx: number, sy: number, d0: number): PlanarEdge => {
    const pts: Vec[] = [{ x: sx, y: sy }]
    let cx = sx
    let cy = sy
    let d = d0
    const startV = cidx(sx, sy)
    const first = stepLabels(cx, cy, d)
    let dirEnd = d
    for (;;) {
      consume(cx, cy, d)
      dirEnd = d
      cx += DX[d]
      cy += DY[d]
      pts.push({ x: cx, y: cy })
      if (isJunction(cx, cy) || degree(cx, cy) !== 2) break
      // Degree-2 interior corner: continue along the one crack that isn't the
      // reverse of how we arrived.
      const back = (d + 2) % 4
      let next = -1
      for (let k = 0; k < 4; k++) {
        if (k !== back && crackInDir(cx, cy, k)) {
          next = k
          break
        }
      }
      if (next < 0) break
      d = next
    }
    return {
      id: nextId++,
      pts,
      startV,
      endV: cidx(cx, cy),
      left: first.left,
      right: first.right,
      dirStart: d0,
      dirEnd,
      closed: false,
    }
  }

  // Pass A — junction-anchored edges. Junctions ascending; directions 0..3.
  for (let cy = 0; cy <= height; cy++) {
    for (let cx = 0; cx <= width; cx++) {
      if (!isJunction(cx, cy)) continue
      junctions.push(cidx(cx, cy))
      for (let d = 0; d < 4; d++) {
        if (crackInDir(cx, cy, d) && !isConsumed(cx, cy, d)) edges.push(walkChain(cx, cy, d))
      }
    }
  }

  // Pass B — pure loops (no junction): every remaining crack lies on a closed
  // degree-2 boundary. Seed from the lowest unconsumed crack in fixed order.
  const walkLoop = (sx: number, sy: number, d0: number): PlanarEdge => {
    const pts: Vec[] = [{ x: sx, y: sy }]
    let cx = sx
    let cy = sy
    let d = d0
    const first = stepLabels(cx, cy, d)
    let dirEnd = d
    for (;;) {
      consume(cx, cy, d)
      dirEnd = d
      cx += DX[d]
      cy += DY[d]
      if (cx === sx && cy === sy) break // closed the loop
      pts.push({ x: cx, y: cy })
      const back = (d + 2) % 4
      let next = -1
      for (let k = 0; k < 4; k++) {
        if (k !== back && crackInDir(cx, cy, k)) {
          next = k
          break
        }
      }
      if (next < 0) break
      d = next
    }
    return { id: nextId++, pts, startV: -1, endV: -1, left: first.left, right: first.right, dirStart: d0, dirEnd, closed: true }
  }

  // Vertical cracks then horizontal, fixed order, seeding any still unconsumed.
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx <= width; cx++) {
      if (crackS(cx, cy) && !isConsumed(cx, cy, 1)) edges.push(walkLoop(cx, cy, 1))
    }
  }
  for (let cy = 0; cy <= height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      if (crackE(cx, cy) && !isConsumed(cx, cy, 0)) edges.push(walkLoop(cx, cy, 0))
    }
  }

  return { width, height, edges, junctions }
}
