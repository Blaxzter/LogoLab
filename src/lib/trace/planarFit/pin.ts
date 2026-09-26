// Tangent pin: rotate an apex handle onto its fitted arm direction, within the fit tolerance.

import type { PathNode } from '../../path/types'
import type { ArmFit } from './arms.ts'

/** Max rotation (deg) the tangent pin may apply to an apex handle. Beyond this the arm
 *  line and the fitted tangent genuinely disagree — a curved arm — and pinning would
 *  flatten real curvature at the corner. */
const PIN_ROTATE_MAX_DEG = 30

/**
 * The same rule in the units the curve feels. An angle cap alone bounds the wrong
 * quantity: rotating a handle moves the curve in proportion to the handle's length, so
 * the same 29° that is a harmless nudge on a 2px handle swings a 26px one 13px sideways
 * (enough to close a letter's counter).
 *
 * The pin exists to correct a tangent, so its side effect is bounded by the fit's own
 * tolerance: moving one cubic control point by d moves the curve by at most
 * max{3t(1−t)²} = 4/9 of d, and a correction that moves the curve further than ε is a
 * re-fit onto evidence the fit itself rejected. Derived, not calibrated; ordinary pins
 * sit well inside it.
 */
const PIN_CURVE_BASIS = 4 / 9

/** One tangent-pin candidate (`bench/pinDiag.ts`). Observational only.
 *  See PlanarFitOptions.pinDiag. */
export interface PinDiagRecord {
  /** Apex position. */
  x: number
  y: number
  /** Which handle of the apex node. */
  side: 'in' | 'out'
  /** Angle between the fitted handle and the arm-line direction (deg). */
  rotDeg: number
  /** Max deviation of the arm samples from their own line — 0 = a straight arm. */
  bow: number
  /** Chord length of the arm window (px) and its sample count. */
  chord: number
  n: number
  /** Handle length (px) — the pin keeps it and rotates only the direction. */
  handle: number
  /** Did the pin actually rotate this handle. */
  applied: boolean
}

export type PinDiag = (r: PinDiagRecord) => void

/** Rotate one handle of an apex node onto `arm.dir` (unit, oriented along chain travel),
 *  keeping its length. `hIn` sits behind the apex along the incoming direction; `hOut`
 *  ahead along the outgoing one. No-op on absent handles, past PIN_ROTATE_MAX, and past the
 *  curve-displacement bound (PIN_CURVE_BASIS). */
export function pinHandle(node: PathNode, which: 'hIn' | 'hOut', arm: ArmFit, eps: number, diag?: PinDiag): void {
  const h = node[which]
  if (!h) return
  const vx = h.x - node.x
  const vy = h.y - node.y
  const len = Math.hypot(vx, vy)
  if (len < 1e-9) return
  const dir = arm.dir
  const sx = which === 'hIn' ? -dir.x : dir.x
  const sy = which === 'hIn' ? -dir.y : dir.y
  const cos = Math.min(1, Math.max(-1, (vx * sx + vy * sy) / len))
  const rotDeg = (Math.acos(cos) * 180) / Math.PI
  // How far the rotation moves the control point (the chord of the rotation), and through
  // it the curve. The angle cap says the arm line disagrees with the fit; the curve cap
  // says the disagreement matters at this handle's reach.
  const shift = 2 * len * Math.sin((rotDeg * Math.PI) / 360)
  const applied = cos >= Math.cos((PIN_ROTATE_MAX_DEG * Math.PI) / 180) && PIN_CURVE_BASIS * shift <= eps
  diag?.({
    x: node.x,
    y: node.y,
    side: which === 'hIn' ? 'in' : 'out',
    rotDeg,
    bow: arm.bow,
    chord: arm.chord,
    n: arm.n,
    handle: len,
    applied,
  })
  if (!applied) return
  node[which] = { x: node.x + len * sx, y: node.y + len * sy }
}
