// The apex snap: arm-intersection reconstruction, its raster-evidence veto, and the apex diagnostics.

import type { Vec } from '../../path/types'
import {
  ARC_ARM_BOW_MIN, ARC_ARM_MIN_N, ARC_PHI_MIN_DEG, ARC_PIN_MIN_N, ARC_PIN_TURN_MIN_DEG, ARC_TIP_MIN_DEG,
  ARM_PIN_SAMPLES, PARALLEL_TIP_DEG, SHORT_ARM_PROBE_MIN, SHORT_ARM_SAMPLES, SNAP_COLLINEAR, SNAP_SPAN,
  armCircle, armFitOf, armIntersections, armLine, armTangent, boxSmooth, circleTangentAt,
  type ArmCircle, type ArmFit, type ArmTangent,
} from './arms.ts'
import { dist, fitCircle } from './geom.ts'
import { DEFAULT_PLANAR_FIT, type PlanarFitOptions } from './options.ts'

/**
 * Which rule decided where a corner's apex ended up. Every value but `reconstructed`
 * (and `cap`) keeps the raw lattice/chain vertex — they are the snap's refusals.
 */
export type ApexOutcome =
  | 'reconstructed' //  the arm-line intersection, inside the displacement cap
  | 'short-arm' //      neighbours too close to fit an arm at all
  | 'few-samples' //    a window with < 2 points on one side
  | 'parallel' //       the two arm lines are near-collinear (no intersection)
  | 'over-cap' //       the intersection ran further than the geometric cap allows
  | 'past-evidence' //  it ran past the coverage the raster carries
  | 'cap' //            placed by the cap resolver (arm ∩ cap-chord), not the apex snap

/** One corner the apex snap considered (`bench/apexDiag.ts`). Observational only.
 *  See PlanarFitOptions.apexDiag. */
export interface ApexDiagRecord {
  /** Shared-edge id. Attached by assemblePlanar — the fitter does not know it. */
  edge?: number
  /** The chain vertex the corner was detected at (lattice, or sub-pixel displaced). */
  cx: number
  cy: number
  /** Where the apex ended up — equal to (cx,cy) on every outcome but `reconstructed`. */
  ax: number
  ay: number
  /** dist((ax,ay), (cx,cy)) — how far the reconstruction moved the apex. */
  moved: number
  outcome: ApexOutcome
  /** The displacement cap in force (0 when the snap bailed before computing one). */
  allow: number
  /** Arm windows in chain steps, as the caller capped them. */
  inSpan: number
  outSpan: number
  /** Per-side tip censor (`armGap`) the caller chose — the samples skipped nearest the
   *  apex before the arm window starts. */
  inGap: number
  outGap: number
  /** Arm evidence, −1 where the arm was never fitted. */
  inBow: number
  outBow: number
  inChord: number
  outChord: number
  inN: number
  outN: number
  /** The raw arm intersection the estimator proposed, before any selector (cap, evidence
   *  veto, short-arm bypass) decided — NaN where no intersection exists. On `short-arm` it
   *  is the plain base-window line∩line, computed for the record only. */
  hx: number
  hy: number
  /** Interior angle between the two fitted arm lines at the apex (deg); −1 without arms.
   *  Acute tips — where a slow convergence throws the intersection far — read small. */
  tipDeg: number
  /** How far the own region's coverage reaches along the reconstruction ray, px.
   *  −1 when no probe was attached or the snap never got as far as asking. */
  reach: number
  /** Which model placed each arm's side of the apex. Absent = line. */
  inKind?: 'line' | 'circle' | 'tangent'
  outKind?: 'line' | 'circle' | 'tangent'
}

export type ApexDiag = (r: ApexDiagRecord) => void

/**
 * The corner snap: place the apex on the intersection of the two arm models flanking it
 * (each sampled [gap..span] px away so the rounded tip is excluded), also returning the
 * two fitted arm directions (unit, oriented along the chain's travel: `inArm` into the
 * apex, `outArm` away from it) whenever the reconstruction had usable arm evidence —
 * null on the lattice-fallback paths. The tangent pin consumes them: on a sub-pixel
 * displaced chain the fitted arcs' end tangents at an apex rotate toward the bisector,
 * while the arm models read the true flank directions. An arm is a line while its
 * samples sit on one and an anchored tangent where they measurably curve; `winding`
 * (±1 for loops, 0 for open chains) feeds the concavity test.
 */
function snapCornerToArmsFull(
  pts: Vec[], c: number, inGap: number, outGap: number, inSpan: number, outSpan: number, inMax = 0, outMax = 0,
  opts: PlanarFitOptions = DEFAULT_PLANAR_FIT,
  winding = 0,
): { p: Vec; inArm: ArmFit | null; outArm: ArmFit | null; outcome: ApexOutcome; allow: number; hit: Vec | null } {
  const n = pts.length
  const keep = (outcome: ApexOutcome, inArm: ArmFit | null, outArm: ArmFit | null, allow = 0, hit: Vec | null = null) => ({
    p: { x: pts[c].x, y: pts[c].y }, inArm, outArm, outcome, allow, hit,
  })
  const wrap = (i: number): number => ((i % n) + n) % n
  // Base window [gap..span], then extend up to `max` while the arm stays collinear.
  // A shallow staircase (slope ~1/14) shows less than one unit step inside the base
  // window, so its fitted slope is step-phase noise, and at a narrow tip every slope
  // error multiplies by ~1/tan(tip) into apex error along the axis. Straight arms earn
  // the longer window; a curved arm fails the collinearity test at its first extension
  // and keeps the base window. Gaps are per side (armGap).
  const collect = (sign: -1 | 1, gap: number, span: number, max: number): Vec[] => {
    const out: Vec[] = []
    for (let o = gap; o <= span; o++) out.push(pts[wrap(c + sign * o)])
    let line = out.length >= 2 ? armLine(out) : null
    for (let o = span + 1; line && o <= max; o++) {
      const p = pts[wrap(c + sign * o)]
      const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
      if (dev > SNAP_COLLINEAR) break
      out.push(p)
      line = armLine(out)
    }
    return out
  }
  // Short-arm bypass: reconstruction exists to recover an apex the raster eroded — a
  // shallow tip whose true corner sits px past the lattice — and needs arm evidence to
  // earn that. An arm with fewer than SHORT_ARM_SAMPLES samples is phase noise, and the
  // raw cluster apex, already sub-px correct on a feature that small, is kept.
  const inSamples = inSpan - inGap + 1
  const outSamples = outSpan - outGap + 1
  if (Math.min(inSamples, outSamples) < (opts.shortArmSamples ?? SHORT_ARM_SAMPLES)) {
    // Diagnostic only: what the plain base-window estimator would have said.
    let diagHit: Vec | null = null
    if (opts.apexDiag) {
      const a0 = collect(-1, inGap, inSpan, inSpan)
      const b0 = collect(1, outGap, outSpan, outSpan)
      if (a0.length >= 2 && b0.length >= 2) diagHit = lineIntersect(armLine(a0), armLine(b0))
    }
    return keep('short-arm', null, null, 0, diagHit)
  }
  const inPts = collect(-1, inGap, inSpan, inMax)
  const outPts = collect(1, outGap, outSpan, outMax)
  if (inPts.length < 2 || outPts.length < 2) return keep('few-samples', null, null)
  const aFit = armFitOf(inPts)
  const bFit = armFitOf(outPts)
  const a = aFit.line
  const b = bFit.line
  // Orient along chain travel: `a` was sampled before the apex (in), `b` after (out).
  const orient = (d: Vec, from: Vec, to: Vec): Vec => {
    const s = d.x * (to.x - from.x) + d.y * (to.y - from.y)
    return s >= 0 ? { x: d.x, y: d.y } : { x: -d.x, y: -d.y }
  }
  const inArm: ArmFit = { ...aFit.fit, dir: orient(a.d, pts[wrap(c - inSpan)], pts[c]) }
  const outArm: ArmFit = { ...bFit.fit, dir: orient(b.d, pts[c], pts[wrap(c + outSpan)]) }
  // The arms handed back are the tangent pin's evidence; a corner with a side under
  // ARM_PIN_SAMPLES places its apex (below) and pins nothing on either side.
  const pinMin = opts.armPinSamples ?? ARM_PIN_SAMPLES
  const pinOk = Math.min(inSamples, outSamples) >= pinMin
  const pinArm = (arm: ArmFit, _samples: number): ArmFit | null => (pinOk ? arm : null)
  // Near-parallel guard: interior angle between the two arms as rays leaving the apex —
  // a straight run reads 180°. See PARALLEL_TIP_DEG.
  if (opts.arcArms) {
    const cosI = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
    if ((Math.acos(cosI) * 180) / Math.PI > (opts.parallelTipDeg ?? PARALLEL_TIP_DEG)) {
      return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples))
    }
  }
  // Arm model: where an arm's samples measurably bow off their line, the line is a chord
  // of a curve and the chord intersection slides along the other arm. 'tangent' (default)
  // replaces the chord with the arm's anchored tangent line at the tip end of the window;
  // 'circle' intersects fitted circles instead. Straight arms keep the line either way.
  const bowMin = opts.arcArmBowMin ?? ARC_ARM_BOW_MIN
  const model = opts.arcArmModel ?? 'tangent'
  let aL: { c: Vec; d: Vec } = a
  let bL: { c: Vec; d: Vec } = b
  let circA: ArmCircle | null = null
  let circB: ArmCircle | null = null
  let tanA: ArmTangent | null = null
  let tanB: ArmTangent | null = null
  const armMinN = opts.arcArmMinN ?? ARC_ARM_MIN_N
  const phiMin = opts.arcPhiMinDeg ?? ARC_PHI_MIN_DEG
  // Tip floor: the chord-estimated interior angle (see PlanarFitOptions.arcTipMinDeg);
  // below it the chords stay. Concave corners (a notch into the loop's interior) are
  // exempt: both walls curve into the notch, so their chord tip under-reads badly, while
  // the acute tips the floor protects are convex corners of their region.
  const cosTip = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
  const turnCross = inArm.dir.x * outArm.dir.y - inArm.dir.y * outArm.dir.x
  const concave = winding !== 0 && turnCross * winding < 0
  const tipOk = concave || (Math.acos(cosTip) * 180) / Math.PI >= (opts.arcTipMinDeg ?? ARC_TIP_MIN_DEG)
  // Co-circular window extension: the line path grows a straight arm's evidence while
  // collinear (collect/inMax), but a curved arm's evidence would stop at the span cap
  // even where its arc continues cleanly, leaving the half-split φ at its noise floor.
  // So a bent arm may extend while new samples stay on its own fitted circle; a kinked
  // window breaks circle-consistency at once and extends nothing.
  const extendArc = (base: Vec[], sign: -1 | 1, span: number, max: number): Vec[] => {
    if (base.length < 8 || max <= span) return base
    const circ = fitCircle(boxSmooth(base))
    if (!circ) return base
    const out = base.slice()
    for (let o = span + 1; o <= max; o++) {
      const p = pts[wrap(c + sign * o)]
      if (Math.abs(Math.hypot(p.x - circ.cx, p.y - circ.cy) - circ.r) > 1.0) break
      out.push(p)
    }
    return out
  }
  if (opts.arcArms && tipOk && aFit.fit.bow > bowMin && aFit.fit.n >= armMinN) {
    const sm = boxSmooth(extendArc(inPts, -1, inSpan, inMax))
    if (model === 'circle') circA = armCircle(sm, aFit.fit, opts)
    else {
      tanA = armTangent(sm, a, phiMin)
      if (tanA) aL = tanA
    }
  }
  if (opts.arcArms && tipOk && bFit.fit.bow > bowMin && bFit.fit.n >= armMinN) {
    const sm = boxSmooth(extendArc(outPts, 1, outSpan, outMax))
    if (model === 'circle') circB = armCircle(sm, bFit.fit, opts)
    else {
      tanB = armTangent(sm, b, phiMin)
      if (tanB) bL = tanB
    }
  }
  const lineHit = (): Vec | null => {
    const det = aL.d.x * -bL.d.y - aL.d.y * -bL.d.x
    if (Math.abs(det) < 1e-6) return null
    const rx = bL.c.x - aL.c.x
    const ry = bL.c.y - aL.c.y
    const t = (rx * -bL.d.y - ry * -bL.d.x) / det
    return { x: aL.c.x + t * aL.d.x, y: aL.c.y + t * aL.d.y }
  }
  let hit: Vec | null
  if (!circA && !circB) hit = lineHit()
  else {
    // Two circles that fail to meet (fit noise on a near-tangent crotch) fall back to
    // the chord crossing; the caps below still bound whatever comes out.
    const cands = armIntersections(aL, circA, bL, circB)
    if (cands.length === 0) hit = lineHit()
    else {
      hit = cands[0]
      for (const p of cands) if (dist(p, pts[c]) < dist(hit, pts[c])) hit = p
    }
  }
  if (!hit) return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples))
  const ix = hit.x
  const iy = hit.y
  const hitOut: Vec = { x: ix, y: iy }
  // Report each arm's direction as the tangent at the apex; the tangent pin consumes it.
  const pinMinN = opts.arcPinMinN ?? ARC_PIN_MIN_N
  // Corrected turn: from the model tangents where they exist, else the chords.
  const dInF = tanA ? orient(tanA.d, pts[wrap(c - inSpan)], pts[c]) : circA ? circleTangentAt(circA, hit, inArm.dir) : inArm.dir
  const dOutF = tanB ? orient(tanB.d, pts[c], pts[wrap(c + outSpan)]) : circB ? circleTangentAt(circB, hit, outArm.dir) : outArm.dir
  const cosC = Math.min(1, Math.max(-1, -(dInF.x * dOutF.x + dInF.y * dOutF.y)))
  const turnC = 180 - (Math.acos(cosC) * 180) / Math.PI
  const pinTurnOk = turnC >= (opts.arcPinTurnMinDeg ?? ARC_PIN_TURN_MIN_DEG)
  const rePinA = opts.arcPin !== false && aFit.fit.n >= pinMinN && pinTurnOk
  const rePinB = opts.arcPin !== false && bFit.fit.n >= pinMinN && pinTurnOk
  if (circA) {
    if (rePinA) inArm.dir = circleTangentAt(circA, hit, inArm.dir)
    inArm.kind = 'circle'
  } else if (tanA) {
    if (rePinA) inArm.dir = orient(tanA.d, pts[wrap(c - inSpan)], pts[c])
    inArm.kind = 'tangent'
  }
  if (circB) {
    if (rePinB) outArm.dir = circleTangentAt(circB, hit, outArm.dir)
    outArm.kind = 'circle'
  } else if (tanB) {
    if (rePinB) outArm.dir = orient(tanB.d, pts[c], pts[wrap(c + outSpan)])
    outArm.kind = 'tangent'
  }
  // Re-check conditioning on the final tangents: a noisy shape model can rotate two
  // moderately-turning chords into near-collinearity, and such a "corner" both places
  // badly and reads smooth downstream. Same bound as the chord-side guard.
  if (opts.arcArms && (inArm.kind || outArm.kind)) {
    const cosF = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
    if ((Math.acos(cosF) * 180) / Math.PI > (opts.parallelTipDeg ?? PARALLEL_TIP_DEG)) {
      return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples), 0, hitOut)
    }
  }
  // Scale-aware displacement cap: how far the reconstructed apex may move off the
  // lattice corner is bounded by the evidence. A long-armed corner (an eroded shallow
  // tip) legitimately reconstructs several px past the lattice vertex. A short-armed
  // corner's arm lines are phase noise and it carries only sub-px erosion, so there is
  // little to reconstruct. Past the cap we keep the lattice corner.
  const shortSpan = Math.min(inSpan, outSpan)
  const allow = shortSpan >= (opts.snapSpan ?? SNAP_SPAN) ? Math.max(inSpan, outSpan) : Math.max(2, 0.5 * shortSpan)
  if (dist({ x: ix, y: iy }, pts[c]) > allow) return keep('over-cap', pinArm(inArm, inSamples), pinArm(outArm, outSamples), allow, hitOut)
  return { p: { x: ix, y: iy }, inArm: pinArm(inArm, inSamples), outArm: pinArm(outArm, outSamples), outcome: 'reconstructed', allow, hit: hitOut }
}

/** Intersection of two lines given as point + unit direction; null when parallel. */
function lineIntersect(a: { c: Vec; d: Vec }, b: { c: Vec; d: Vec }): Vec | null {
  const det = a.d.x * -b.d.y - a.d.y * -b.d.x
  if (Math.abs(det) < 1e-6) return null
  const rx = b.c.x - a.c.x
  const ry = b.c.y - a.c.y
  const t = (rx * -b.d.y - ry * -b.d.x) / det
  return { x: a.c.x + t * a.d.x, y: a.c.y + t * a.d.y }
}

/**
 * How far (px) past the raster's own evidence a reconstruction may land.
 *
 * The arm-line intersection is the right answer for a raster-eroded tip: a shallow point
 * genuinely sits px beyond the last labelled pixel. It is the wrong answer for an acute
 * curved counter, where each arm line is a chord leaning into the lens and the two chords
 * cross px past the real tip, inside solid ink.
 *
 * The two cases are indistinguishable by geometry (arm bow does not separate them). The
 * raster does: erosion leaves a decaying trail of partial coverage between the lattice
 * vertex and the true corner, while a counter reconstructed into its own stem has none —
 * coverage falls off a cliff at the lattice vertex. The rule bounds the overshoot past
 * that trail (`moved − reach`). Real eroded corners overshoot by under ~2px; tightening
 * this below 2.5 starts refusing them.
 */
const APEX_OVERSHOOT_MAX = 2.5

/**
 * The second half of the evidence rule. Overshoot alone does not separate the cases: a
 * genuinely eroded narrow spike at a coarse raster can overshoot the trail by more than
 * APEX_OVERSHOOT_MAX and still be right. What separates them is the fraction of the way
 * the raster's own material covers. Erosion hides only the last sliver of a tip, so the
 * trail runs most of the distance (≳0.63); an over-reconstruction leaves the shape at the
 * lattice vertex and keeps going, so the trail covers a minority (≲0.53).
 *
 * A reconstruction is corrected only when it both runs more than APEX_OVERSHOOT_MAX past
 * the evidence and the evidence covers less than this fraction of it.
 */
const APEX_REACH_FRAC = 0.6

/**
 * The apex snap, its raster-evidence veto, and the diagnostic emission — the one place
 * both cornered fitters get a corner from. `tipDeg` is the interior angle between the two
 * arms as rays leaving the apex (`inArm.dir` runs into the apex, `outArm.dir` away from
 * it), so a straight run reads 180° and an acute tip reads small: the shallower the tip,
 * the further a slope error in either arm throws their intersection along the bisector.
 */
export function snapApex(
  pts: Vec[],
  c: number,
  inGap: number,
  outGap: number,
  inSpan: number,
  outSpan: number,
  inMax: number,
  outMax: number,
  opts: PlanarFitOptions,
  /** Loop orientation sign for the concavity test; 0 = open chain / unknown. */
  winding = 0,
): { p: Vec; inArm: ArmFit | null; outArm: ArmFit | null } {
  let full = snapCornerToArmsFull(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts, winding)
  let moved = dist(full.p, pts[c])
  // Only a reconstruction that already moved further than the bound can break it, so the
  // raster probe stays off the hot path for most corners.
  let reach = -1
  const overMax = opts.apexOvershootMax ?? APEX_OVERSHOOT_MAX
  const reachFrac = opts.apexReachFrac ?? APEX_REACH_FRAC
  // A short-armed reconstruction is asked the same question at a shorter range (see
  // SHORT_ARM_PROBE_MIN).
  const shortArmed = Math.min(inSpan - inGap, outSpan - outGap) + 1 < (opts.armPinSamples ?? ARM_PIN_SAMPLES)
  const probeMin = shortArmed ? Math.min(overMax, opts.shortArmProbeMin ?? SHORT_ARM_PROBE_MIN) : overMax
  if (opts.apexEvidence !== false && opts.apexReach && full.outcome === 'reconstructed' && moved > probeMin) {
    reach = opts.apexReach(pts[c], full.p)
    if (moved - reach > probeMin && reach < reachFrac * moved) {
      // Clamp to the evidence rather than fall back to the lattice vertex: where the tip
      // is partly eroded the truth lies between the two, and pinning to the lattice pulls
      // the whole adjacent arc in. `reach` is where the raster's own material stops.
      const k = reach / moved
      full = {
        p: { x: pts[c].x + (full.p.x - pts[c].x) * k, y: pts[c].y + (full.p.y - pts[c].y) * k },
        inArm: full.inArm, outArm: full.outArm, outcome: 'past-evidence', allow: full.allow, hit: full.hit,
      }
      moved = reach
    }
  }
  if (opts.apexDiag) {
    const a = full.inArm
    const b = full.outArm
    let tipDeg = -1
    if (a && b) {
      const cosI = Math.min(1, Math.max(-1, -(a.dir.x * b.dir.x + a.dir.y * b.dir.y)))
      tipDeg = (Math.acos(cosI) * 180) / Math.PI
    }
    opts.apexDiag({
      cx: pts[c].x, cy: pts[c].y,
      ax: full.p.x, ay: full.p.y,
      moved,
      outcome: full.outcome,
      allow: full.allow,
      inSpan, outSpan, inGap, outGap,
      hx: full.hit?.x ?? NaN, hy: full.hit?.y ?? NaN,
      inBow: a?.bow ?? -1, outBow: b?.bow ?? -1,
      inChord: a?.chord ?? -1, outChord: b?.chord ?? -1,
      inN: a?.n ?? -1, outN: b?.n ?? -1,
      tipDeg,
      reach,
      inKind: a?.kind ?? 'line', outKind: b?.kind ?? 'line',
    })
  }
  return { p: full.p, inArm: full.inArm, outArm: full.outArm }
}
