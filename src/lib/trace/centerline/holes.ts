// Round holes: the evidence that a stroke around them is a RING.
//
// Where strokes end on a small ring (a windmill's sails on its hub), the ink of the ring
// and of the strokes merges, and the medial axis between the junctions stops following
// the ring: it runs as a chord, and two chords meeting at a junction are exactly what a
// corner looks like. No reading of the skeleton can tell them apart. The hole can. The
// paper the ring encloses is untouched by what ends on the ring's outside, and its edge
// is a circle; the ring's centreline is that circle grown by half the stroke width
// (assemble.ts `ringPair`).

import { fitCircle } from '../planarFit/geom.ts'

export interface Hole {
  /** The hole's edge as a circle (px, pixel-corner coordinates). */
  cx: number
  cy: number
  r: number
}

/** A hole's edge pixels must lie within this share of its radius (or a pixel) of one circle. */
export const HOLE_ROUND_TOL = 0.08
/** Holes smaller than this radius (px) are too few pixels to call round. */
export const HOLE_MIN_R = 2.5

/**
 * Every enclosed paper component (4-connected, not touching the raster's border) whose
 * edge is a circle and whose area is that circle's. An annulus (a ring inside a ring) or a
 * hole with an island in it has an inner edge as well and is not one circle, so it is
 * not returned.
 */
export function roundHoles(ink: Uint8Array, width: number, height: number): Hole[] {
  const n = width * height
  const seen = new Uint8Array(n)
  const out: Hole[] = []
  const stack: number[] = []
  const members: number[] = []
  for (let s = 0; s < n; s++) {
    if (ink[s] || seen[s]) continue
    stack.length = 0
    members.length = 0
    stack.push(s)
    seen[s] = 1
    let open = false
    const edge: { x: number; y: number }[] = []
    while (stack.length) {
      const p = stack.pop()!
      members.push(p)
      const x = p % width
      const y = (p / width) | 0
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) open = true
      let onEdge = false
      for (const q of [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]) {
        if (q < 0) continue
        if (ink[q]) {
          onEdge = true
          continue
        }
        if (seen[q]) continue
        seen[q] = 1
        stack.push(q)
      }
      if (onEdge) edge.push({ x: x + 0.5, y: y + 0.5 })
    }
    if (open || edge.length < 8) continue
    const c = fitCircle(edge)
    if (!c || c.r < HOLE_MIN_R) continue
    const tol = Math.max(1, HOLE_ROUND_TOL * c.r)
    if (edge.some((p) => Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r) > tol)) continue
    // The edge pixels' centres sit half a pixel inside the edge; the area must be the
    // disc's, or the edge was one circle around something that is not a disc.
    const rEdge = c.r + 0.5
    if (Math.abs(members.length - Math.PI * rEdge * rEdge) > 0.2 * Math.PI * rEdge * rEdge) continue
    out.push({ cx: c.cx, cy: c.cy, r: rEdge })
  }
  return out
}
