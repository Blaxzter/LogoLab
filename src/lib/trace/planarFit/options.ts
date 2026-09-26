// PlanarFitOptions, its defaults, and the flat-art line cost.

import type { Vec } from '../../path/types'
import type { ApexDiag } from './apex.ts'
import type { PinDiag } from './pin.ts'

export interface PlanarFitOptions {
  /** Curve-fit tolerance ε (px): RDP split threshold and cubic-discard bound. */
  epsilon: number
  /** Pre-smoothing passes over the staircase (endpoints pinned). */
  smoothPasses: number
  lineCost: number
  cubicCost: number
  /**
   * Macro-turn angle (deg) above which an interior staircase vertex is a corner and is
   * pinned through pre-smoothing, so a sharp point isn't melted into a curve before the
   * fitter sees it. 60° is the one definition of "sharp" the pipeline shares
   * (geomScore.sharpCorners and planarBeautify's CORNER_TURN use it too). A clean arc
   * trips the ±4px window only below ~7.6px local radius; small closed discs, whose
   * staircase can still read 2–5 corners, are handled by `discExplainsLoop`.
   * ≥180 disables corner pinning (only endpoints are pinned).
   */
  cornerTurnDeg: number
  /**
   * Opt-in junction refinement (planarJunction.ts): place each junction vertex at the
   * sub-pixel intersection of its incident edge arms instead of the integer lattice
   * corner, and give two edges a region runs straight through a junction a shared G¹
   * tangent. An alternative to the co-circular arc snap; it is a trade-off rather than
   * an improvement, so it stays off. `false` ⇒ integer-lattice junctions.
   */
  refineJunctions: boolean
  /** Co-circular open-arc snap (planarBeautify): a ring split into arcs by band junctions
   *  snaps to one circle so it stops kinking. */
  arcSnap: boolean
  /**
   * Junction re-seat (planarReseat.ts): a degree-3 junction that slid along a
   * near-tangent boundary crossing (the label map's colour needle is sub-pixel thin
   * there, so the lattice junction lands px away from the true crossing) is moved to the
   * intersection of its two strongest incident fitted primitives, and the mangled
   * terminal caps are re-emitted from those primitives. On by default.
   */
  junctionReseat: boolean
  /**
   * Scale-relative snap tolerance (0 = off). The circle / ellipse / co-circular snaps in
   * planarBeautify accept a primitive on radial deviation ≤ `fidelity`, an absolute px
   * test, which lets a small square cell round into a blob. When > 0 each snap's
   * tolerance becomes `min(fidelity, localScaleK · r)`, with r the fitted primitive's
   * radius, so a small shape is held to a fraction of its own size.
   */
  localScaleK: number
  /**
   * Contrast-rank threading (planarThread.ts). Where a weak colour boundary (a
   * posterization band seam) ends on a strong one that continues through, move the
   * junction onto a fit of the strong boundary across it, instead of pinning a long
   * edge to the seam's integer lattice corner. Needs the palette; without one, or with
   * this false, nothing moves.
   */
  fitThrough: boolean
  /**
   * Corner-junction placement, the other half of `fitThrough`: where the strong
   * boundary turns at the junction, place it at the intersection of the two strong arms'
   * own fitted lines instead of the integer lattice corner. Same preconditions as
   * `fitThrough`; `false` keeps the lattice corner.
   */
  cornerJunctions: boolean
  /** The corner-turn veto in planarBeautify that refuses to round a sharp-cornered loop
   *  into a disc. Exposed so `localScaleK` can be compared as a replacement for it. */
  cornerVeto: boolean
  /**
   * Through-chains: before the co-circular family pass clusters open arcs, join the ones
   * the topology says continue one another — at each junction, rank every pairing of the
   * incident arms by how straight the boundary runs across and take the matching. A ring
   * cut by crossings then arrives as one arc instead of fragments whose own circle fits
   * are noise.
   */
  chainArcs: boolean
  /**
   * Sub-pixel edge placement (planarSubpixel.ts): before fitting, displace each chain's
   * interior points from the crack lattice to the iso-0.5 crossing of the local
   * two-colour coverage profile, read from the source raster along the chain normal.
   * Only effective when tracePlanar is given the source image; label-only callers are
   * unaffected.
   */
  subpixelEdges: boolean
  /** Refuse the sub-pixel estimator at any chain point whose sample window is not fully
   *  inside the raster (see planarSubpixel's truncated-window guard). */
  subpixelWindowGuard: boolean
  /**
   * Internal, set per edge by assemblePlanar: pin each snapped apex's handle directions
   * onto its fitted arm lines. Only meaningful on a sub-pixel displaced chain, where the
   * arc fits' end tangents are free within ε and rotate toward the bisector (the
   * displaced evidence near an apex is genuinely smooth), which can drop a right angle
   * below the 60° sharp bar. The arm lines read the true flank directions, and the pin
   * restores the corner without moving it.
   */
  pinCornerTangents?: boolean
  /** Diagnostic sink, called once per tangent-pin candidate with the rotation the pin
   *  wants and how straight the arm is (`bench/pinDiag.ts`). Never changes the fit. */
  pinDiag?: PinDiag
  /** Diagnostic sink, called once per corner the apex snap considers: where the lattice
   *  put it, where the arm intersection wants it, which rule decided, and the arm evidence
   *  (`bench/apexDiag.ts`). Never changes the fit. */
  apexDiag?: ApexDiag
  /** Diagnostic overrides for corner-detection constants; each defaults to the module
   *  constant it names. Production never sets them. */
  cornerWindow?: number
  cornerMerge?: number
  /** Forces `armGap(steps)` to this value on every arm (censor and cap-trim). */
  armGapFixed?: number
  snapSpan?: number
  /** The short-arm bypass floor in samples per arm (default SHORT_ARM_SAMPLES). */
  shortArmSamples?: number
  /** Fewest samples both arms need before their line directions are handed to the
   *  tangent pin (default ARM_PIN_SAMPLES). */
  armPinSamples?: number
  /** A short-armed reconstruction is checked against the raster whenever it moved further
   *  than this (default SHORT_ARM_PROBE_MIN px); Infinity switches the probe off. */
  shortArmProbeMin?: number
  /** Refuse an apex reconstruction that lands further than APEX_OVERSHOOT_MAX past the
   *  coverage the source raster carries (see `apexReach`). Default true. */
  apexEvidence?: boolean
  /**
   * How far, in px, the corner's own region still has coverage in the source raster
   * walking from `from` toward `to`. Supplied per edge by assemblePlanar, which holds
   * the raster and the palette; absent (no image, no palette, an EXT side) ⇒ no raster
   * check, so label-only callers are unaffected.
   */
  apexReach?: ApexReach
  /** Diagnostic overrides for the apex evidence constants. */
  apexOvershootMax?: number
  apexReachFrac?: number
  /**
   * The apex snap's arm model. A line is right while the arm's samples sit on it; where
   * they bow off it, the line is a chord of a curve and the chord intersection slides
   * along the other arm (a small needle grows into a letterform's stems). Such an arm is
   * replaced by its tangent at the tip and the apex placed on the intersection of the
   * fitted primitives, with a near-parallel conditioning guard (PARALLEL_TIP_DEG).
   * `false` keeps the chord-only snap.
   */
  arcArms: boolean
  /** Diagnostic overrides for the arc-arm constants. `arcArmModel`: 'tangent' replaces a
   *  bent arm's chord with its anchored tangent line (the chord rotated by the measured
   *  chord-to-tangent angle — no radius estimate); 'circle' intersects fitted circles
   *  (exact on large clean arcs, unstable on ~8px windows). */
  arcArmBowMin?: number
  arcArmDevK?: number
  parallelTipDeg?: number
  arcArmModel?: 'tangent' | 'circle'
  /** false ⇒ the tangent pin keeps the chord directions while the apex still moves. */
  arcPin?: boolean
  /** Minimum arm samples before the reported dir switches to the model tangent (the
   *  tangent pin consumes it); shorter windows measure their tangent as noise. */
  arcPinMinN?: number
  /** Minimum arm samples before the arm may upgrade at all (model and pin both). */
  arcArmMinN?: number
  /** Minimum half-turn (deg) between the window's two half-fits before the arm counts as
   *  curved. A straight staircase's halves agree within ~5° of noise. */
  arcPhiMinDeg?: number
  /** Minimum chord-estimated tip angle (deg) for the model to apply. At an acute tip the
   *  intersection amplifies tangent noise by 1/sin(tip), and the chord model errs short
   *  there, which is the safe side. */
  arcTipMinDeg?: number
  /** Minimum corrected turn (deg) for the tangent dirs to reach the tangent pin. Tangents
   *  that leave the turn near the 60° sharp bar would rotate handles until the corner
   *  reads smooth. */
  arcPinTurnMinDeg?: number
  /** Diagnostic sink: one record per candidate the occluder-chord pass weighed, with the
   *  value each gate saw (`bench/chordDiag.ts`). */
  onChord?: import('../planarReseat.ts').ChordObserver
  /** Diagnostic sink: one record per degree-3 junction the re-seat weighed — each arm's
   *  verdict, the winning pair, the move (`bench/reseatDiag.ts`). */
  onReseatVerdict?: import('../planarReseat.ts').ReseatObserver
  /** Diagnostic overrides for the re-seat's arm-certification constants; every field
   *  defaults to the constant. */
  reseatTune?: import('../planarReseat.ts').ReseatTune
  /** Diagnostic sink: one record per region loop the co-circular arc snap weighed,
   *  naming the gate that declined it (`bench/ringDiag.ts`). */
  onArcLoop?: import('../planarBeautify.ts').ArcLoopObserver
}

/** See PlanarFitOptions.apexReach. Returns Infinity when it cannot judge. */
export type ApexReach = (from: Vec, to: Vec) => number

export const DEFAULT_PLANAR_FIT: PlanarFitOptions = {
  epsilon: 1.0,
  smoothPasses: 2,
  // Conservative line/cubic balance (line marginally cheaper). The flat path raises
  // lineCost above cubicCost (FLAT_LINE_COST) to de-facet curves; gradient art keeps
  // this value, where the higher cost hurt band seams.
  lineCost: 3.9,
  cubicCost: 4,
  cornerTurnDeg: 60,
  refineJunctions: false,
  arcSnap: true,
  junctionReseat: true,
  localScaleK: 0,
  cornerVeto: true,
  chainArcs: true,
  fitThrough: true,
  cornerJunctions: true,
  subpixelEdges: true,
  subpixelWindowGuard: true,
  arcArms: true,
}

/** Flat-art line cost: > cubicCost so the DP prefers a cubic on any span where a
 *  cubic fits within ε — borderline-curved spans become smooth cubics instead of
 *  kinked chords. ε-bounded, so fidelity is unaffected; values above 4.5 change
 *  nothing further. */
export const FLAT_LINE_COST = 4.5
