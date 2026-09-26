// Disc veto: whether one circle explains a small loop better than the polygon its corners claim.

import type { Vec } from '../../path/types'
import { fitCircle } from './geom.ts'

/** A loop is only offered to the disc reading when one circle fits its lattice samples
 *  this closely (px). A rasterized disc's staircase sits 0.4–0.9px off its own circle at
 *  every size measured; anything further is not a disc the ±win reading misread. */
const DISC_LOOP_MAX_DEV = 1.0

/**
 * Disc veto on a loop's corners. The ±`win` chord reading turns ≥60° on the staircase of
 * any disc under r ≈ 6px, so `detectLoopCorners` finds 2–5 "corners" on a small dot, the
 * loop is fitted corner-first, and planarBeautify's corner veto then refuses the circle
 * snap — small dots trace as lumpy polygons depending on sub-pixel phase.
 *
 * Radial deviation alone cannot decide it (a 6–8px square sits about as close to its
 * circle as a disc does), so the circle is asked to beat the polygon the corners claim:
 * a least-squares line through each arm's own samples. A real polygon's arms are straight
 * to the staircase's own noise; a disc's arms are arcs, and a line leaves their sagitta.
 * The arms are fitted rather than taken as apex-to-apex chords because the apex lands a
 * lattice step off a small square's corner, and that chord cuts across it. Squares ≤6px,
 * 6px triangles and small pentagons/hexagons still round — a circle already describes
 * them to within their staircase.
 */
export function discExplainsLoop(pts: Vec[], corners: number[]): boolean {
  const n = pts.length
  if (corners.length < 2 || n < 3) return false
  const c = fitCircle(pts)
  if (!c) return false
  let circMax = 0
  let circSq = 0
  for (const p of pts) {
    const e = Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
    if (e > circMax) circMax = e
    circSq += e * e
  }
  if (circMax > DISC_LOOP_MAX_DEV) return false
  // Five or more "corners" on a loop one circle already hugs to within a pixel: the
  // staircase of a 9px dot is a near-octagon whose short arms are straight, so the arm
  // test below cannot see it. No square, diamond or triangle reads ≥5 corners.
  if (corners.length >= 5) return true
  let armSq = 0
  let armN = 0
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]
    const len = (((corners[(k + 1) % corners.length] - a) % n) + n) % n
    const arm: Vec[] = []
    for (let o = 0; o <= len; o++) arm.push(pts[(a + o) % n])
    if (arm.length < 2) continue
    // Total-least-squares line through the arm (principal axis of its samples).
    let mx = 0
    let my = 0
    for (const p of arm) {
      mx += p.x
      my += p.y
    }
    mx /= arm.length
    my /= arm.length
    let sxx = 0
    let syy = 0
    let sxy = 0
    for (const p of arm) {
      const dx = p.x - mx
      const dy = p.y - my
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
    const ux = Math.cos(th)
    const uy = Math.sin(th)
    for (const p of arm) {
      const e = -(p.x - mx) * uy + (p.y - my) * ux
      armSq += e * e
      armN++
    }
  }
  return armN > 0 && Math.sqrt(circSq / n) < Math.sqrt(armSq / armN)
}
