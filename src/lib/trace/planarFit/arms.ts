// Arm evidence for the corner snap: snap windows, arm lines, and the curved-arm models.

import type { Vec } from '../../path/types'
import { dist, fitCircle } from './geom.ts'
import type { PlanarFitOptions } from './options.ts'

export const SNAP_GAP = 3 // skip this many px nearest the tip (the rounded part) per arm
export const SNAP_SPAN = 14 // …and fit the arm line over up to this many px beyond the gap
/**
 * Fewest samples an arm may carry and still earn a reconstruction. Below it the arm line
 * is staircase noise and the corner keeps its lattice vertex; the displacement cap and
 * the raster evidence veto hold the noisy regime above it. Don't lower it: at 4 samples
 * the detector starts inventing corners on small arcs. Stated in samples, not steps, so
 * it stays consistent with the gap: a span clamped by an open chain's end with the full
 * 3px gap is 3 samples, not 6.
 */
export const SHORT_ARM_SAMPLES = 5
/**
 * Floor at which a corner's arm line directions are trusted as tangents for the tangent
 * pin, on both sides. An intersection tolerates a bowed arm (two chords still cross near
 * the corner); a tangent does not — rotating a handle onto a long chord on a curved
 * letterform bows the adjacent arc. So a corner with a short side takes its apex from
 * the intersection and keeps the fit's own tangents.
 */
export const ARM_PIN_SAMPLES = SNAP_GAP + 4
/**
 * How far (px) a short-armed reconstruction may move before the raster is asked whether
 * the corner is really out there (the `apexReach` probe, otherwise consulted only past
 * APEX_OVERSHOOT_MAX). Short arms admit detector false positives on tight smooth nodes,
 * whose chord lines cross outside the ink; an eroded true corner leaves a coverage trail
 * along the ray, a chord crossing on a convex arc leaves none.
 */
export const SHORT_ARM_PROBE_MIN = 0.5

/**
 * Scale-aware snap gap. The fixed 3px gap is right for a long arm (skip the AA-rounded
 * tip, plenty of evidence beyond), but on a short inter-corner arc it discards most of
 * the arm and the fitted arm line misplaces the apex by px. The gap scales with the arc:
 * ≥13 steps keep the full 3px gap, an 8-step chord drops to 1. A corner whose arms are
 * that short has sub-px rounding anyway.
 */
export function armGap(steps: number): number {
  return Math.min(SNAP_GAP, Math.max(1, ((steps - 1) / 4) | 0))
}

/** A straight arm may extend its sample window this far (see armSamples). */
export const SNAP_SPAN_MAX = 40
/** Max perp deviation (px) for an extension point to count as "still the same
 *  straight arm" — just above the ±0.5px staircase quantization. */
export const SNAP_COLLINEAR = 0.75

/**
 * An arm line with the evidence that says whether it is a tangent at all: the max
 * perpendicular deviation of its own samples (`bow`) and the window's chord length.
 * A straight arm's samples sit on the line (bow ≈ the ±0.5px staircase, far less on a
 * sub-pixel displaced chain); a curved arm's line is a chord, and its bow is the arc's
 * sagitta over that window. The tangent pin needs the distinction: a chord's direction
 * is not the boundary's direction at the apex.
 */
export interface ArmFit {
  /** Unit direction, oriented along the chain's travel by the caller. On a curved arm
   *  this is the model tangent at the snapped apex, else the fitted line's direction. */
  dir: Vec
  /** Max |perpendicular deviation| of the arm samples from the fitted line, px — the
   *  curvature evidence, kept line-based even when the arm upgrades to a curve model. */
  bow: number
  /** Distance between the first and last arm sample, px. */
  chord: number
  /** Number of samples in the window. */
  n: number
  /** Which arm model placed this arm's side of the apex. Absent = line. */
  kind?: 'line' | 'circle' | 'tangent'
}

/** Least-squares line through `pts` → a point on it (`c`) and a unit direction (`d`). */
export function armLine(pts: Vec[]): { c: Vec; d: Vec } {
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= pts.length
  my /= pts.length
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of pts) {
    const dx = p.x - mx
    const dy = p.y - my
    sxx += dx * dx
    sxy += dx * dy
    syy += dy * dy
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy)
  return { c: { x: mx, y: my }, d: { x: Math.cos(theta), y: Math.sin(theta) } }
}

/** `armLine` plus the straightness evidence (see ArmFit). `dir` is returned raw — the
 *  caller orients it along the chain's travel. */
export function armFitOf(pts: Vec[]): { line: { c: Vec; d: Vec }; fit: ArmFit } {
  const line = armLine(pts)
  let bow = 0
  for (const p of pts) {
    const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
    if (dev > bow) bow = dev
  }
  return { line, fit: { dir: line.d, bow, chord: dist(pts[0], pts[pts.length - 1]), n: pts.length } }
}

/** Max interior tip angle (deg) for a corner reconstruction. A fitted tip this close to
 *  straight contradicts the ≥60°-turn corner definition by ≥30°: the "corner" is a
 *  staircase jog whose intersection is ill-conditioned along the boundary, and the reach
 *  probe cannot refuse it because the ray runs along a real edge whose AA fringe reads as
 *  coverage. */
export const PARALLEL_TIP_DEG = 150
/** An arm's samples must bow at least this far (px) off their fitted line before the
 *  line is treated as a chord of a curve. Below it the line is within the staircase's
 *  own noise (the same regime as SNAP_COLLINEAR). */
export const ARC_ARM_BOW_MIN = 0.5
/** The fitted circle ('circle' model) must explain the samples: radial deviation at most
 *  this fraction of the line's own bow, floored at SNAP_COLLINEAR (±0.5px quantization
 *  means even a perfectly circular arm cannot fit below it) — or the arm keeps the line. */
export const ARC_ARM_DEV_K = 0.5
/** See PlanarFitOptions.arcPinMinN / arcArmMinN / arcPhiMinDeg / arcTipMinDeg /
 *  arcPinTurnMinDeg. */
export const ARC_PIN_MIN_N = 12
export const ARC_ARM_MIN_N = 12
export const ARC_PHI_MIN_DEG = 10
export const ARC_TIP_MIN_DEG = 45
export const ARC_PIN_TURN_MIN_DEG = 70

/** An arm circle (Kasa fit — see fitCircle). */
export type ArmCircle = { cx: number; cy: number; r: number }

/** Box-smooth a window (endpoints pinned). The raw samples near a corner are ±0.5px
 *  staircase (the sub-pixel pass reverts displacement there), and any shape statistic
 *  read off them — a Kasa radius, a sagitta — is step noise otherwise. */
export function boxSmooth(ptsArm: Vec[], passes = 2): Vec[] {
  let sm = ptsArm
  for (let pass = 0; pass < passes && sm.length >= 3; pass++) {
    const next = sm.slice()
    for (let i = 1; i < sm.length - 1; i++) {
      next[i] = {
        x: (sm[i - 1].x + sm[i].x + sm[i + 1].x) / 3,
        y: (sm[i - 1].y + sm[i].y + sm[i + 1].y) / 3,
      }
    }
    sm = next
  }
  return sm
}

/** The arm circle, when the samples earn it — null keeps the line model. */
export function armCircle(sm: Vec[], fit: ArmFit, opts: PlanarFitOptions): ArmCircle | null {
  const circ = fitCircle(sm)
  if (!circ) return null
  let dev = 0
  for (const p of sm) {
    const d = Math.abs(Math.hypot(p.x - circ.cx, p.y - circ.cy) - circ.r)
    if (d > dev) dev = d
  }
  if (dev > Math.max(SNAP_COLLINEAR, (opts.arcArmDevK ?? ARC_ARM_DEV_K) * fit.bow)) return null
  return circ
}

/**
 * The 'tangent' arm model: the line the arm's own curve is travelling at the tip end of
 * the window. A bent arm's LSQ line is a chord — offset by the sagitta and rotated by the
 * chord-to-tangent angle, both of which displace the apex along the other arm.
 *
 * The window is split at its middle and each half gets its own LSQ line; on a uniform arc
 * the two half directions disagree by θ/2 (θ the window's arc turn), and the tangent at
 * the tip end is the tip half's direction continued by another θ/4. Everything is read as
 * a direction over ≥6 samples: a sagitta statistic reads step phase and AA fattening as
 * curvature, and a Kasa radius on an ~8px window is noise. A straight staircase arm's
 * halves agree within noise, so the model degrades to the chord and polygonal art keeps
 * its corners.
 */
export interface ArmTangent {
  /** Anchored tangent line at the window's tip end — the intersection target, and the
   *  direction the tangent pin consumes. */
  c: Vec
  d: Vec
}

export function armTangent(sm: Vec[], line: { c: Vec; d: Vec }, phiMinDeg: number): ArmTangent | null {
  if (sm.length < 8) return null
  const half = sm.length >> 1
  const tipHalf = sm.slice(0, half)
  const farHalf = sm.slice(half)
  const tip = armLine(tipHalf)
  const far = armLine(farHalf)
  // Orient both along the full line's direction so the signed turn between them is
  // well-defined (armLine's direction sign is arbitrary).
  const alignTo = (d: Vec, ref: Vec): Vec => (d.x * ref.x + d.y * ref.y >= 0 ? d : { x: -d.x, y: -d.y })
  const dTip = alignTo(tip.d, line.d)
  const dFar = alignTo(far.d, line.d)
  // Signed half-turn φ (far → tip); the end tangent continues the same turning by φ/2.
  const sin = dFar.x * dTip.y - dFar.y * dTip.x
  const cos = dFar.x * dTip.x + dFar.y * dTip.y
  const phi = Math.atan2(sin, cos)
  // The curvature gate: see PlanarFitOptions.arcPhiMinDeg.
  if (Math.abs(phi) < (phiMinDeg * Math.PI) / 180) return null
  const rot = phi / 2
  const cr = Math.cos(rot)
  const sr = Math.sin(rot)
  return {
    // Anchor: the tip half's own line, evaluated at the tip-end sample's projection —
    // a denoised point on the boundary at the window's corner end.
    c: (() => {
      const t0 = (sm[0].x - tip.c.x) * dTip.x + (sm[0].y - tip.c.y) * dTip.y
      return { x: tip.c.x + t0 * dTip.x, y: tip.c.y + t0 * dTip.y }
    })(),
    d: { x: dTip.x * cr - dTip.y * sr, y: dTip.x * sr + dTip.y * cr },
  }
}

/** Intersection candidates (0–2) of two arm primitives, each a line or a circle. */
export function armIntersections(
  aLine: { c: Vec; d: Vec },
  aCirc: ArmCircle | null,
  bLine: { c: Vec; d: Vec },
  bCirc: ArmCircle | null,
): Vec[] {
  const circleLine = (circ: ArmCircle, line: { c: Vec; d: Vec }): Vec[] => {
    const t0 = (circ.cx - line.c.x) * line.d.x + (circ.cy - line.c.y) * line.d.y
    const qx = line.c.x + t0 * line.d.x
    const qy = line.c.y + t0 * line.d.y
    const h2 = circ.r * circ.r - ((qx - circ.cx) ** 2 + (qy - circ.cy) ** 2)
    if (h2 < 0) return []
    const h = Math.sqrt(h2)
    return [
      { x: qx + h * line.d.x, y: qy + h * line.d.y },
      { x: qx - h * line.d.x, y: qy - h * line.d.y },
    ]
  }
  if (aCirc && bCirc) {
    const dx = bCirc.cx - aCirc.cx
    const dy = bCirc.cy - aCirc.cy
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return []
    const a = (aCirc.r * aCirc.r - bCirc.r * bCirc.r + d * d) / (2 * d)
    const h2 = aCirc.r * aCirc.r - a * a
    if (h2 < 0) return []
    const h = Math.sqrt(h2)
    const mx = aCirc.cx + (a * dx) / d
    const my = aCirc.cy + (a * dy) / d
    return [
      { x: mx + (h * -dy) / d, y: my + (h * dx) / d },
      { x: mx - (h * -dy) / d, y: my - (h * dx) / d },
    ]
  }
  if (aCirc) return circleLine(aCirc, bLine)
  if (bCirc) return circleLine(bCirc, aLine)
  return [] // line×line is handled by the caller
}

/** Unit tangent of `circ` at `at`, oriented to agree with `along`. */
export function circleTangentAt(circ: ArmCircle, at: Vec, along: Vec): Vec {
  let tx = -(at.y - circ.cy)
  let ty = at.x - circ.cx
  const l = Math.hypot(tx, ty) || 1
  tx /= l
  ty /= l
  return tx * along.x + ty * along.y >= 0 ? { x: tx, y: ty } : { x: -tx, y: -ty }
}
