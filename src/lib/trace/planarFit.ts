// Phase 2 of the planar tracer: fit each PlanarEdge's lattice staircase polyline
// to a low-node chain of lines / cubic Béziers, ONCE. Junction endpoints are
// pinned (so the two edges meeting there share an exact anchor) and forced to
// corner. Reuses the crisp tracer's stable numerics — `fitSingleCubic` (Schneider
// + Newton) and `lineFit` from curveFit.ts — wrapped in an OPEN (acyclic) RDP +
// evidence-based corner score + linear DP that mirror fitClosedLoop's recipe
// without its cyclic wraparound. Pure-loop edges reuse `fitClosedLoop` directly.
//
// The crisp tracer gets smoothness from a coverage-field Gaussian before marching
// squares; a crack polyline has none, so we pre-smooth the interior (endpoints
// pinned) to melt the 90° staircase, and let the ε cubic-fit tolerance absorb the
// residual. Pure & deterministic (fixed iteration counts, no PRNG).

import type { PathNode, Vec } from '../path/types'
import { fitClosedLoop, fitSingleCubic, junctionCosts, lineFit, type CurveFitOptions } from './curveFit.ts'

export interface PlanarFitOptions {
  /** Curve-fit tolerance ε (px): RDP + cubic-discard, as in the crisp tracer. */
  epsilon: number
  /** Pre-smoothing passes over the staircase (endpoints pinned). */
  smoothPasses: number
  lineCost: number
  cubicCost: number
  /**
   * Macro-turn angle (deg) above which an interior staircase vertex is a CORNER and
   * is PINNED through pre-smoothing — so a sharp valley/point isn't melted into a
   * curve before the fitter sees it. 60° = the ONE definition of "sharp" the whole
   * pipeline shares (geomScore.sharpCorners and planarBeautify's CORNER_TURN both
   * call ≥60° a corner; the detector demanding 70° made every 60–70° authored
   * corner structurally invisible — gear-teeth's 67.3° roots, §10.6). Smooth shapes
   * stay untouched: even at 60° a clean arc trips the ±4px window only below
   * ~7.6px local radius, and a tiny closed blob collapses to <2 apexes, which the
   * cornered path already rejects. ≥180 disables (pre-smoothing pins only
   * endpoints, the legacy behaviour — used to assert byte-identity).
   */
  cornerTurnDeg: number
  /**
   * §22 / issue #23 — **BUILT, MEASURED AND REJECTED (default false).** Keep reading: the
   * numbers below are all real, and they are exactly why this shipped and had to be pulled.
   *
   * How the macro turn at a candidate vertex is READ.
   * The shipped reading is the angle between two CHORDS taken +/-`CORNER_WINDOW` POINTS
   * along the chain; on the integer lattice each chord endpoint carries up to half a
   * pixel of quantization, which is ~7 deg of direction error over a 4px chord — and on a
   * steep diagonal, where a run of collinear staircase steps can fill the whole window,
   * the error is SYSTEMATIC rather than random: the chord snaps to the run's own
   * direction. Measured, a corner authored at exactly 60.0 deg reads 45.0 (§21.2), so it
   * never clears a 60 deg bar. With this on, a candidate the chord already reads within
   * `cornerEvidenceReachDeg` of the bar gets a SECOND opinion — the turn between two
   * least-squares arm directions, each fitted over as many samples as stay straight to
   * within `cornerEvidenceEps` — and the SHARPER of the two readings wins. One-sided by
   * construction (§17's ARM_BOW shape): it can only promote a vertex to corner, never
   * demote one, so every corner the shipped reading finds is still found. `false`
   * restores the chords-only reading byte-identically — and that is the shipped path.
   *
   * WHY IT IS OFF. On the metrics it was a clean win: +54 authored corners recovered
   * across 128 gallery marks with one lost, `gear-teeth` 53 → 57/60, `logo-ibm` chamfer
   * 0.2064 → 0.1978. On the /labs/ab review it put a visible KINK in smooth boundary all
   * over the corpus — chupa-chups' brown ellipse, instagram's lower ring, the mastercard
   * wordmark's `m`. Counted afterwards: 9 traced sharp corners on chupa-chups with no
   * authored corner within 2.5px (the furthest 25.5px away), 7 on instagram (one 46px
   * away), 2 on mastercard.
   *
   * NOTHING IN THE GATE SET COULD SEE IT, and that is the lesson worth keeping:
   * `cornersRecovered` counts authored corners RECOVERED and has no precision term, so
   * minting corners is free by it (and sometimes scores as a gain); chamfer/p95 barely
   * move for a C⁰ kink on a short arc — chupa-chups' +0.0120 was the whole signal, and it
   * was read as a trade. The co-circular veto that was supposed to stop this fits a
   * CIRCLE, and the fixture control it was calibrated against is four DISCS: guard and
   * control shared an assumption, so the control could only ever confirm the guard. Real
   * smooth boundary is ellipses and curvature-varying blends, where the veto never fires.
   *
   * Do not re-enable this without a PRECISION lens first — a gate that fails when smooth
   * authored boundary gains a C⁰ kink. §22.5 states what it has to measure.
   */
  cornerTurnEvidence?: boolean
  /** EXPERIMENT KNOBS for the §22 sweep (src/devtest/turnDiag.ts --sweep) — default to
   *  the constants below; the shipped values are read off the corpus. */
  cornerEvidenceEps?: number
  cornerEvidenceMaxK?: number
  cornerEvidenceReachDeg?: number
  cornerEvidenceGap?: number
  /** false ⇒ apply the promotion at EVERY vertex that reads sharper, instead of only at
   *  the non-max-suppressed one. Exists so the fusion it causes stays measurable: it costs
   *  gear-teeth 4 of its 60 corners (docs §22.3). */
  cornerEvidenceSuppress?: boolean
  /**
   * EXPERIMENTAL (off by default). Place each junction VERTEX at the sub-pixel
   * intersection of its incident edge arms instead of the integer lattice corner,
   * and weld two edges a region runs straight THROUGH a junction to a shared G¹
   * tangent (planarJunction.ts). An alternative to the co-circular arc snap (§1d)
   * for the ring "pull"; measured weaker + corpus-moving, kept behind this flag for
   * the Test view A/B. `false` ⇒ raw integer-lattice junctions (the shipped path).
   *
   * Re-measured against GROUND TRUTH 2026-07-14 (docs/vectorization-benchmarks.md
   * §9.3): a tradeoff, not a win — helps cross-bars/gradient-flat, hurts
   * aa-seam/bloom/petals; 10 better vs 14 worse on the 106 flat twins. Stays off.
   */
  refineJunctions: boolean
  /**
   * Co-circular open-arc snap (planarBeautify §1d): a ring split into arcs by band
   * junctions snaps to ONE circle so it stops kinking. On by default (it rides the
   * fidelity dial). `false` disables it — the pre-1d baseline, for the Test view A/B.
   */
  arcSnap: boolean
  /**
   * Junction re-seat (planarReseat.ts, §10.4): a degree-3 junction that SLID along
   * a near-tangent boundary crossing (the label map's colour needle is sub-pixel
   * thin there, so the lattice junction lands px away from the true crossing) is
   * moved to the intersection of its two strongest incident fitted primitives, and
   * the mangled terminal caps are re-emitted from those primitives. On by default
   * (rides the fidelity dial with the rest of planarBeautify); `false` disables —
   * the pre-§10.4 baseline, for the Test view A/B.
   */
  junctionReseat: boolean
  /**
   * EXPERIMENTAL scale-relative fidelity (§10 prototype; 0 = off = byte-identical).
   * The circle / ellipse / co-circular SNAP gates in planarBeautify accept a
   * primitive on RADIAL deviation ≤ `fidelity` — a purely SIZE-relative test, which
   * is exactly why an 8px checker cell (0.83px from its best-fit circle) rounds into
   * a blob (§9.8). When > 0, each snap's tolerance becomes
   * `min(fidelity, localScaleK · localScale)`, where `localScale` is the fitted
   * primitive's own radius — the disc/ring's medial radius, cheaply on hand. A big
   * shape keeps the full fidelity budget; a tiny one is held to a fraction of its own
   * size, so a small square's 0.83px deviation exceeds `k·r` and never snaps. This is
   * the concrete `ε_local = min(ε_abs, k·localScale)` of §10, realized for the snaps.
   */
  localScaleK: number
  /**
   * §14 contrast rank (default true). Where a WEAK colour boundary (a posterization
   * band seam) ends on a STRONG one that continues through, fit the strong boundary
   * THROUGH the junction as one chain and split the fitted curve at the junction's
   * projected position — instead of pinning a 100+px edge to the band seam's integer
   * lattice corner (planarThread.ts). Needs the palette: without one, or with this
   * false, nothing threads and the fit is byte-identical to the pre-§14 tracer.
   */
  fitThrough: boolean
  /**
   * §0 #15 corner-junction placement (benchmarks §17, default true). The other half of
   * `fitThrough`: where the strong boundary TURNS at the junction, a through fit is not
   * defined (it would round the corner off, which is why §14's chord-turn gate refuses
   * it) — so such a junction kept its INTEGER lattice corner and carried that error into
   * both arms. It is instead placed on the INTERSECTION of the two strong arms' own
   * fitted lines, or, where only one arm is usable evidence, projected onto that one.
   * Rides `fitThrough`'s preconditions exactly (needs the palette and the same contrast
   * rank); `false` restores the lattice pin — the pre-§17 baseline, for the Test view A/B.
   */
  cornerJunctions: boolean
  /**
   * EXPERIMENTAL (default true = the shipped §9.8 behaviour). The corner-turn veto in
   * planarBeautify that refuses to round a sharp-cornered loop (a checker cell's four
   * right angles) into a disc. Exposed so the scale-relative-ε prototype
   * (`localScaleK`) can be A/B'd as a REPLACEMENT for the veto — §10 claims a full
   * scale-relative ε SUBSUMES it. Leave true in production.
   */
  cornerVeto: boolean
  /**
   * §25 THROUGH-CHAINS (default true). Before the §24 co-circular family pass clusters
   * open arcs, join the ones the TOPOLOGY says continue one another: at each junction rank
   * every pairing of the incident arms by how straight the boundary runs across, and take
   * the matching. A ring cut by crossings then arrives as one arc instead of a handful of
   * fragments whose own circle fits are noise (§24.8's blocker, benchmarks §25).
   *
   * `false` restores the §24 tracer byte-identically. Keep it — §24.1's lesson is that a
   * diagnostic naming the first failing gate cannot tell you the gate is load-bearing, and
   * the counterfactual costs one flag.
   */
  chainArcs: boolean
  /**
   * §0 #8 sub-pixel edge placement (benchmarks §15, default true). Before fitting,
   * displace each edge chain's interior points from their integer crack-lattice
   * position to the iso-0.5 crossing of the LOCAL two-colour coverage profile, read
   * from the source raster along the chain normal (planarSubpixel.ts). Sharedness is
   * free: the chain is stored once and referenced by both regions. Only effective
   * when the caller hands tracePlanar the source image — callers that pass labels
   * alone (tests, diagnostics) are byte-identical by construction. `false` restores
   * the pure lattice chains — the pre-§15 baseline, for the Test view A/B.
   */
  subpixelEdges: boolean
  /**
   * INTERNAL (set per-edge by assemblePlanar, never in defaults): pin each snapped
   * apex's handle DIRECTIONS onto its fitted arm lines. Only meaningful on a §15
   * sub-pixel displaced chain, where the arc fits' end tangents are free within ε and
   * rotate toward the bisector (the displaced evidence near an apex is genuinely
   * smooth, so nothing anchors the tangent) — a 91° authored corner read 77° from the
   * lattice fit and 51° displaced, crossing the 60° sharp bar. The arm lines read the
   * true flank directions at any scale, and the pin restores the corner without
   * touching its position. Absent/false ⇒ byte-identical fits.
   */
  pinCornerTangents?: boolean
  /**
   * DIAGNOSTIC (never in defaults, never read back): a sink called once per tangent-pin
   * candidate with the evidence behind it — the rotation the pin wants, and how straight
   * the arm that would supply it actually is. `src/devtest/pinDiag.ts` histograms this
   * across the corpus; attaching it cannot change the fit.
   */
  pinDiag?: PinDiag
  /**
   * DIAGNOSTIC (never in defaults, never read back): a sink called once per corner the
   * apex snap CONSIDERS — where the lattice put it, where the arm intersection wants it,
   * which rule decided, and how much evidence each arm had. `src/devtest/apexDiag.ts`
   * joins this with the source raster to ask whether a reconstruction ran past the ink
   * (issue #17); attaching it cannot change the fit.
   */
  apexDiag?: ApexDiag
  /**
   * EXPERIMENT KNOBS for the issue-#36 paired corner census (`src/devtest/cornerScaleDiag.ts
   * --fit k=v`): each defaults to the module constant it names, so a counterfactual runs on
   * the SAME census without editing constants (the §28.1 `tune` idiom). Production never
   * sets them; absent ⇒ byte-identical.
   */
  cornerWindow?: number
  cornerMerge?: number
  /** Forces `armGap(steps)` to this value on every arm (censor AND cap-trim). */
  armGapFixed?: number
  snapSpan?: number
  /** The short-arm bypass floor in SAMPLES per arm (default SHORT_ARM_SAMPLES). 7 reproduces
   *  the pre-§31 `SNAP_GAP + 4` step rule on every arm whose gap is 1 — the red gate's
   *  "before" arm (test/planar-short-arm.test.ts). */
  shortArmSamples?: number
  /** Fewest samples BOTH arms need before their line directions are handed to the §15
   *  tangent pin (default ARM_PIN_SAMPLES). The apex and the tangent are two claims on
   *  different evidence — see ARM_PIN_SAMPLES. */
  armPinSamples?: number
  /** §31: a SHORT-ARMED reconstruction (either arm under ARM_PIN_SAMPLES) is checked against
   *  the raster whenever it moved further than this (default SHORT_ARM_PROBE_MIN px), not
   *  only past APEX_OVERSHOOT_MAX; Infinity switches the probe off for the census. */
  shortArmProbeMin?: number
  /**
   * §18 / issue #17 (default true). Refuse an apex reconstruction that lands further than
   * APEX_OVERSHOOT_MAX past the coverage the SOURCE RASTER actually carries — see
   * `apexReach`. `false` restores the pre-§18 snap, for the Test view A/B.
   */
  apexEvidence?: boolean
  /**
   * §18 / issue #17: how far, in px, the corner's OWN region still has coverage in the
   * source raster walking from `from` toward `to`. Supplied per edge by assemblePlanar,
   * which is the layer that holds both the raster and the two regions' palette colours;
   * absent (no image, no palette, an EXT side) ⇒ the snap is byte-identical to pre-§18 by
   * construction, which keeps every label-only caller — tests, diagnostics, synthetic
   * label maps — unchanged.
   */
  apexReach?: ApexReach
  /** EXPERIMENT KNOBS for the §18 sweep (src/devtest/apexSweep.ts) — default to the
   *  constants. Not tuning surface: the shipped values are read off the corpus. */
  apexOvershootMax?: number
  apexReachFrac?: number
  /**
   * §19 / issue #7 (default true). The apex snap's arm model: a LINE is the right model
   * exactly while the arm's samples sit on it; where they measurably BOW off it, the
   * line is a CHORD of a curve and the chord intersection slides ALONG the other arm —
   * mastercard's 'e' grows a 2px white needle into its stems, and a crotch apex is
   * pushed off the bisector. Such an arm is upgraded to its own fitted CIRCLE and the
   * apex placed on the fitted-primitive intersection (the §10.4 reseat philosophy,
   * applied to the corner snap). Rides with a near-parallel conditioning guard (see
   * PARALLEL_TIP_DEG). `false` restores the chords-only snap — the pre-§19 baseline,
   * for the Test view A/B.
   */
  arcArms: boolean
  /** EXPERIMENT KNOBS for the §19 sweep (src/devtest/needleDiag.ts --sweep) — default
   *  to the constants; the shipped values are read off the corpus. `arcArmModel`:
   *  'tangent' replaces a bent arm's chord with its ANCHORED TANGENT line (anchor = the
   *  smoothed tip-end sample, direction = the chord rotated by the measured
   *  chord-to-tangent angle — no radius estimate involved); 'circle' intersects fitted
   *  circles (exact on large clean arcs, unstable on ~8px letterform windows). */
  arcArmBowMin?: number
  arcArmDevK?: number
  parallelTipDeg?: number
  arcArmModel?: 'tangent' | 'circle'
  /** false ⇒ the §15 pin keeps seeing the pre-§19 CHORD directions while the apex still
   *  moves — isolates apex-placement effect from pin-direction effect in the sweep. */
  arcPin?: boolean
  /** Minimum arm samples before the reported dir switches to the model tangent (the §15
   *  pin consumes it). Short windows measure their tangent as noise — gear-teeth's tooth
   *  flanks (n 5–11) lost 10 corners to it — while the letterform/counter windows that
   *  need the correction have n ≥ 12. */
  arcPinMinN?: number
  /** Minimum arm samples before the arm may upgrade AT ALL (model and pin both): below
   *  it the chord stays, byte-identically. Gear-teeth's marginal 67° roots shuffle
   *  (2 won / 3 lost) when flank windows this short take the model. */
  arcArmMinN?: number
  /** Minimum measured half-turn (deg) between the window's two half-fits before the arm
   *  counts as CURVED. The direction disagreement is the curvature, measured over ≥6
   *  samples a side; a straight staircase's halves agree within ~5° of noise while the
   *  needle family's arcs turn 15°+ per half-window. */
  arcPhiMinDeg?: number
  /** Minimum chord-estimated tip angle (deg) for the model to apply at all. At an
   *  ACUTE tip the intersection amplifies tangent noise by 1/sin(tip), and the chord
   *  model errs SHORT there — the safe side (§18's acute-counter @256 held its p95
   *  only with this floor). The needle family measures 50–115°. */
  arcTipMinDeg?: number
  /** Minimum corrected TURN (deg) for the tangent dirs to reach the §15 pin. The pin
   *  exists to restore a corner's sharpness; corrected tangents that leave the turn
   *  near the 60° sharp bar would rotate handles until the corner READS smooth —
   *  gear-teeth's marginal roots read turn 46–59° corrected and flipped exactly there. */
  arcPinTurnMinDeg?: number
  /** DIAGNOSTIC out-sink (chordDiag.ts / issue #14): one record per candidate the
   *  occluder-chord pass weighed, with the value each gate saw. Undefined in production
   *  and the pass is byte-identical without it — it exists because a candidate rejected by
   *  the chord's length bound (once the absolute `CHORD_MAX_LEN`, §28) was otherwise
   *  indistinguishable from an edge that was never a candidate, so the audit's "measured
   *  dead above ~1024" claim could not be re-checked. */
  onChord?: import('./planarReseat.ts').ChordObserver
  /** DIAGNOSTIC out-sink (reseatDiag.ts / issue #14): one record per degree-3 junction the
   *  §10.4 re-seat weighed — each arm's primitive verdict and why it was refused, the pair
   *  that won, the move. Undefined in production; the pass is byte-identical without it. */
  onReseatVerdict?: import('./planarReseat.ts').ReseatObserver
  /** DIAGNOSTIC dial (reseatDiag.ts / issue #39): counterfactual values for the re-seat's
   *  arm-certification constants (`ARM_MAX`, `LINE_TOL`, `CIRC_TOL`, `MIN_ARC_ARM`,
   *  `CAP_MAX`), so the audit's "hold the arm at an ARTWORK fraction" recipe runs without
   *  editing the module. Undefined in production; every field defaults to the constant. */
  reseatTune?: import('./planarReseat.ts').ReseatTune
  /** DIAGNOSTIC out-sink (ringDiag.ts / issue #10): one record per region loop the §1d
   *  co-circular arc snap weighed, naming the gate that declined it. Undefined in
   *  production; the snap is byte-identical without it. */
  onArcLoop?: import('./planarBeautify.ts').ArcLoopObserver
}

/** See PlanarFitOptions.apexReach. Returns Infinity when it cannot judge. */
export type ApexReach = (from: Vec, to: Vec) => number

export const DEFAULT_PLANAR_FIT: PlanarFitOptions = {
  epsilon: 1.0,
  smoothPasses: 2,
  // Conservative line/cubic balance (line marginally cheaper). The FLAT path bumps
  // lineCost above cubicCost in planarFitOptionsFor to de-facet curves; gradient
  // art keeps this value (the bump worsened the headphones-grad seam past tol).
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
  arcArms: true,
  // OFF: built, measured, and REJECTED on visual review — see the option's doc above
  // and docs/vectorization-benchmarks.md §22.
  cornerTurnEvidence: false,
}

/** Flat-art line cost: > cubicCost so the DP prefers a CUBIC on any span where a
 *  cubic fits within ε — borderline-curved spans become smooth cubics instead of
 *  kinked chords (Affinity ~14 lines vs our old ~67). ε-bounded ⇒ fidelity-safe;
 *  measured −24 chords on Schild at identical ΔE/SSIM/node-count. ≥4.5 saturates. */
export const FLAT_LINE_COST = 4.5

const MAX_SPAN = 20
const MAX_FIT_POINTS = 64
const MAX_EVIDENCE_WINDOW = 24
/** ±px window the macro-turn corner test looks across (spans the unit staircase). */
const CORNER_WINDOW = 4
/**
 * §22 (issue #23) — the evidence-bounded turn reading. Every one of these sits MID-PLATEAU
 * on the end-to-end sweep (`turnDiag --sweep`, the defect rack plus the whole corner
 * watchlist): the shipped triple, ±1 notch on any knob, all measure the same 169/172 on
 * `corner-turns` and 57/60 on `gear-teeth`, and each has a named edge past which it costs
 * something. They are not free parameters.
 *
 * MIN_K matches CORNER_WINDOW so the second opinion never reads a SHORTER span than the
 * chord it is second-guessing. MAX_K bounds the reach — 14 and 20 measure identically, 8
 * collapses the whole gain (164/172, gear back to 53). EPS is the fit's own default
 * tolerance, because "these samples are explained by a straight line" is exactly the
 * question the fitter asks; 0.9 and 1.1 measure identically, 1.5 costs the rack 7 corners
 * by reading a curve's own bow as arm evidence. REACH_DEG gates WHICH candidates get the
 * second opinion — a vertex the chord already reads within this many degrees of the bar.
 * That is not just a work bound: it is the statement that a corner must be locally sharp
 * AND confirmed by its arms, never arm evidence alone. 15 and 32 measure identically; past
 * ~35 the gate is effectively open and `gear-teeth` falls 57 → 52, because promotions on
 * gently-bending flanks reshape the clusters its teeth are read from.
 */
const CORNER_EVIDENCE_MIN_K = CORNER_WINDOW
const CORNER_EVIDENCE_MAX_K = 16
const CORNER_EVIDENCE_EPS = 1.0
const CORNER_EVIDENCE_REACH_DEG = 25
const CORNER_EVIDENCE_GAP = 0
/** Apex-merge distance for the loop/open corner detectors (§10.6): sits between
 *  the two scales it must separate — ABOVE a rasterized tip's shoulder pair
 *  (≤ ~2px), BELOW the smallest corner spacing the corpus asks the tracer to keep
 *  (gear-teeth's 7.5px chords). At the old 5 it fused real corner pairs 3–5px
 *  apart; 3 measured +5 recovered corners on gear-teeth, no spurious apexes. */
const CORNER_MERGE = 3

// --- vector helpers ---------------------------------------------------------
const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const neg = (a: Vec): Vec => ({ x: -a.x, y: -a.y })
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
function unit(a: Vec): Vec {
  const l = Math.hypot(a.x, a.y)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l }
}
function perpDistance(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return dist(p, a)
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len
}

/** Drop consecutive duplicate points (keeps endpoints). */
function dedup(pts: Vec[]): Vec[] {
  const out: Vec[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (!last || dist2(last, p) > 1e-12) out.push({ x: p.x, y: p.y })
  }
  return out
}

/**
 * Pre-smooth a polyline to melt the unit staircase. `pinEnds` keeps the first &
 * last point fixed (junction anchors); a closed loop smooths cyclically. `pinned`
 * holds extra indices that must NOT move — the detected sharp corners, so they
 * survive the melt. A few fixed passes of a [0.25, 0.5, 0.25] window —
 * deterministic, endpoint-preserving.
 */
export function presmooth(pts: Vec[], passes: number, pinEnds: boolean, pinned?: ReadonlySet<number>): Vec[] {
  if (pts.length < 3 || passes <= 0) return pts.map((p) => ({ x: p.x, y: p.y }))
  let cur = pts.map((p) => ({ x: p.x, y: p.y }))
  const n = cur.length
  for (let pass = 0; pass < passes; pass++) {
    const next = cur.map((p) => ({ x: p.x, y: p.y }))
    const lo = pinEnds ? 1 : 0
    const hi = pinEnds ? n - 1 : n
    for (let i = lo; i < hi; i++) {
      if (pinned && pinned.has(i)) continue
      const a = cur[(i - 1 + n) % n]
      const b = cur[i]
      const c = cur[(i + 1) % n]
      next[i] = { x: 0.25 * a.x + 0.5 * b.x + 0.25 * c.x, y: 0.25 * a.y + 0.5 * b.y + 0.25 * c.y }
    }
    cur = next
  }
  return cur
}

// --- §22 (issue #23): how a candidate vertex's macro TURN is READ -----------
/**
 * The reading options the four turn-readers share. Threaded rather than global so a
 * label-only caller (tests, diagnostics, synthetic label maps) and the §22 sweep can both
 * pin the reading explicitly; omitted ⇒ the shipped defaults.
 */
export interface TurnRead {
  /** false ⇒ the chords-only reading, byte-identically (the pre-§22 path). */
  evidence?: boolean
  eps?: number
  maxK?: number
  /** false ⇒ promote every vertex that reads sharper, not only the NMS'd one. */
  suppress?: boolean
  /** Samples nearest the candidate to SKIP before an arm window starts — §10.6's
   *  `SNAP_GAP` idea (the rounded part of a rasterized tip is not arm evidence) applied to
   *  the reading. Ships at 0: measured, it is a bad trade (docs §22.2). */
  gap?: number
  /** Only a candidate the chord already reads within this many degrees of the bar is
   *  re-read. ≥180 (the default) ⇒ ungated: measured to cost 16 of 85 corpus gains at 30°
   *  and 43 at 10°, for no measurable saving anywhere it mattered. */
  reachDeg?: number
}
export const turnReadOf = (opts: PlanarFitOptions): TurnRead => ({
  evidence: opts.cornerTurnEvidence,
  eps: opts.cornerEvidenceEps,
  maxK: opts.cornerEvidenceMaxK,
  reachDeg: opts.cornerEvidenceReachDeg,
  gap: opts.cornerEvidenceGap,
  suppress: opts.cornerEvidenceSuppress,
})

/**
 * One arm's direction at `i`, read over the LONGEST span the evidence supports: grow away
 * from `i` in direction `sign` while the accumulated samples stay within `eps` of their own
 * least-squares line, from `minK` up to `maxK` steps, and return that line's direction
 * oriented along the chain's TRAVEL. On a straight arm the span reaches far and the
 * staircase averages out of the direction; on a curve it stops as soon as the curvature
 * shows, which is what keeps a small circle from reading as a corner. Null when the chain
 * ends before `minK` steps (an open edge's junction anchor).
 */
function evidenceArmDir(
  pts: Vec[],
  i: number,
  sign: -1 | 1,
  closed: boolean,
  minK: number,
  maxK: number,
  eps: number,
  gap: number,
): { x: number; y: number; k: number } | null {
  const n = pts.length
  const idx = (o: number): number => {
    const j = i + sign * o
    if (closed) return ((j % n) + n) % n
    return j < 0 || j >= n ? -1 : j
  }
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let syy = 0
  let m = 0
  let bestX = 0
  let bestY = 0
  let bestK = -1
  for (let k = 0; k <= maxK; k++) {
    const j = idx(gap + k)
    if (j < 0) break
    const p = pts[j]
    sx += p.x
    sy += p.y
    sxx += p.x * p.x
    sxy += p.x * p.y
    syy += p.y * p.y
    m++
    if (k < minK) continue
    // Least-squares line of the accumulated window (the `armLine` estimator, taken from
    // running sums so growing the window costs O(1) rather than a refit).
    const mx = sx / m
    const my = sy / m
    const cxx = sxx / m - mx * mx
    const cxy = sxy / m - mx * my
    const cyy = syy / m - my * my
    const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy)
    const dx = Math.cos(theta)
    const dy = Math.sin(theta)
    let bow = 0
    for (let o = 0; o <= k; o++) {
      const q = pts[idx(gap + o)]
      const dev = Math.abs((q.x - mx) * dy - (q.y - my) * dx)
      if (dev > bow) bow = dev
    }
    // The shortest window is accepted unconditionally: below `minK` there is no span at
    // which a staircase looks straight, and refusing there would just hand the answer back
    // to the chord this reading exists to second-guess.
    if (k > minK && bow > eps) break
    bestX = dx
    bestY = dy
    bestK = k
  }
  if (bestK < 0) return null
  // The fitted line is un-oriented: aim it away from `i`, then flip the INCOMING side so
  // both arms run along the chain's travel and their dot product is the turn's cosine.
  const tip = pts[idx(gap + bestK)]
  const s = bestX * (tip.x - pts[i].x) + bestY * (tip.y - pts[i].y) >= 0 ? 1 : -1
  const span = gap + bestK
  return sign > 0 ? { x: bestX * s, y: bestY * s, k: span } : { x: -bestX * s, y: -bestY * s, k: span }
}

/**
 * The CO-CIRCULAR veto on a promotion. Two straight arms always "explain" a small enough
 * circle — that is the whole failure mode of reading a turn over a longer span, and
 * `detectCorners` documents the opposite as a promise ("a smooth shape — even a tiny
 * circle — returns ∅"). Measured on `corner-turns`' four smooth discs @256, the
 * unvetoed reading breaks that promise outright: the 12px and 18px discs pick up 6 and 8
 * sharp corners each. So before a promotion may create a corner, the SAME samples are
 * offered to a single circle; if one explains them to the same tolerance the two lines
 * did, this is a curve and the promotion is refused. A real corner cannot be fitted this
 * way — a circle through a V deviates by most of the arm length.
 */
function coCircular(pts: Vec[], i: number, closed: boolean, kIn: number, kOut: number, eps: number): boolean {
  const n = pts.length
  const w: Vec[] = []
  for (let o = -kIn; o <= kOut; o++) {
    const j = closed ? ((i + o) % n + n) % n : i + o
    if (j < 0 || j >= n) return false
    w.push(pts[j])
  }
  const dev = circleMaxDev(w)
  return dev !== null && dev <= eps
}

/**
 * The macro-turn COSINE at every index — what all four readers (`detectCorners`,
 * `detectLoopCorners`, `detectOpenCorners`, `resolveLoopCaps`) test against their
 * threshold. Outside [lo, hi) the value is 1 (no turn), as before.
 *
 * The base reading is the shipped one: the angle between two CHORDS taken ±`win` POINTS
 * along the chain. §22 adds a second opinion from `evidenceArmDir` and keeps the SHARPER
 * of the two — a ONE-SIDED promotion (§17's `ARM_BOW` shape). One-sidedness is not a
 * stylistic choice here, it is what the corpus measured: as a REPLACEMENT the evidence
 * reading gains 85 authored corners but drops 13 the chord finds today, while as a
 * promotion it gains the same 85 and drops none — and, because the promoted field is
 * smoother, it still non-max-suppresses to 220 FEWER unexplained sites than the chord
 * reading alone (docs §22.2).
 */
function readTurnCos(
  pts: Vec[],
  closed: boolean,
  win: number,
  lo: number,
  hi: number,
  turnDeg: number,
  read?: TurnRead,
): Float64Array {
  const n = pts.length
  const cos = new Float64Array(n)
  cos.fill(1)
  const wrap = (i: number): number => ((i % n) + n) % n
  const useEvidence = read?.evidence !== false
  const eps = read?.eps ?? CORNER_EVIDENCE_EPS
  const maxK = read?.maxK ?? CORNER_EVIDENCE_MAX_K
  const reachDeg = read?.reachDeg ?? CORNER_EVIDENCE_REACH_DEG
  const gap = read?.gap ?? CORNER_EVIDENCE_GAP
  const suppress = read?.suppress !== false
  const reachCos = Math.cos((Math.max(0, turnDeg - reachDeg) * Math.PI) / 180)
  const thrCos = Math.cos((turnDeg * Math.PI) / 180)
  for (let i = lo; i < hi; i++) {
    const b = closed ? pts[wrap(i - win)] : pts[Math.max(0, i - win)]
    const a = closed ? pts[wrap(i + win)] : pts[Math.min(n - 1, i + win)]
    const inDir = unit(sub(pts[i], b))
    const outDir = unit(sub(a, pts[i]))
    cos[i] = inDir.x * outDir.x + inDir.y * outDir.y
  }
  if (!useEvidence) return cos
  const ev = new Float64Array(n)
  ev.fill(1)
  for (let i = lo; i < hi; i++) {
    if (cos[i] > reachCos) continue
    const dIn = evidenceArmDir(pts, i, -1, closed, CORNER_EVIDENCE_MIN_K, maxK, eps, gap)
    const dOut = evidenceArmDir(pts, i, 1, closed, CORNER_EVIDENCE_MIN_K, maxK, eps, gap)
    if (!dIn || !dOut) continue
    const c = dIn.x * dOut.x + dIn.y * dOut.y
    // Only a reading that would actually MINT a corner has to answer the curve question,
    // which keeps the circle fit off every other vertex.
    if (c < thrCos && coCircular(pts, i, closed, dIn.k, dOut.k, eps)) continue
    ev[i] = c
  }
  // The promotion is NON-MAX-SUPPRESSED before it is applied, and that is load-bearing,
  // not tidiness. Both cluster readers (`detectLoopCorners`, `detectOpenCorners`) emit ONE
  // apex per RUN of sub-threshold vertices, so a promotion that paints a whole run sharp
  // FUSES neighbouring corners into one. That is how it was found — the first draft cost
  // `gear-teeth` 53 → 50 of 60 by welding each tooth's tip and root into a single cluster,
  // precisely the two-scale trade §10.6 rejected — and it is still what the sweep measures
  // with everything else in place: `cornerEvidenceSuppress: false` reads `corner-turns`
  // 169 → 162 of 172 (BELOW the chord reading's own 164) and `sharp-star` 11 → 10.
  // Suppressed, the promotion lands on one vertex per neighbourhood: a corner the chord
  // missed becomes its own cluster and no existing run grows by more than a vertex.
  // `cos` is mutated as this loop runs, so an earlier promotion also suppresses a later
  // one within `win` — which is the same rule, applied to the promotions themselves.
  for (let i = lo; i < hi; i++) {
    if (ev[i] >= cos[i]) continue
    if (!suppress) {
      cos[i] = ev[i]
      continue
    }
    let isMin = true
    for (let j = i - win; j <= i + win && isMin; j++) {
      const k = closed ? wrap(j) : j
      if (k === i || k < lo || k >= hi) continue
      // A promotion is only offered where the CHORD found nothing. Both cluster readers
      // fuse apexes within `CORNER_MERGE` px and keep the FIRST, and the loop reader picks
      // a cluster's apex by max perp-to-chord — so a promotion landing beside a corner the
      // chord already found can displace or swallow it, and the reading stops being
      // one-sided where it matters most. Measured on `logo-ibm`, whose 70° stripe chevrons
      // sit ~5px apart: unguarded, §22 cost it 122 → 118 of 127 recovered corners while
      // improving its boundary error, which is exactly the all-gates-green trade §10.4
      // named. Guarded, the promotion can only ADD a corner in a neighbourhood that had
      // none.
      if (cos[k] < thrCos) isMin = false
      else if (ev[k] < ev[i] || (ev[k] === ev[i] && k < i)) isMin = false
    }
    if (isMin) cos[i] = ev[i]
  }
  return cos
}

/**
 * Indices of MACRO corners on a lattice staircase: vertices where the path
 * direction turns by more than `turnDeg`, measured over a ±`win` px window so the
 * unit stair-steps of a straight diagonal (constant macro direction) are NOT
 * corners but a genuine sharp valley/point IS. Non-max-suppressed within the
 * window. `closed` wraps the windows; otherwise the endpoint region (already
 * pinned by `presmooth`) is skipped. A smooth shape — even a tiny circle — returns
 * ∅ at the default threshold, so its pre-smoothing is unchanged. `turnDeg ≥ 180`
 * ⇒ ∅ (corner pinning disabled).
 */
export function detectCorners(
  pts: Vec[],
  turnDeg: number,
  closed: boolean,
  win = CORNER_WINDOW,
  read?: TurnRead,
): Set<number> {
  const out = new Set<number>()
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return out
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const lo = closed ? 0 : win
  const hi = closed ? n : n - win
  const cos = readTurnCos(pts, closed, win, lo, hi, turnDeg, read)
  for (let i = lo; i < hi; i++) {
    if (cos[i] >= thr) continue // not sharp enough
    let isLocalMin = true
    for (let j = i - win; j <= i + win; j++) {
      const k = closed ? wrap(j) : j
      if (k === i || (!closed && (k < lo || k >= hi))) continue
      if (cos[k] < cos[i]) {
        isLocalMin = false
        break
      }
    }
    if (isLocalMin) out.add(wrap(i))
  }
  return out
}

// --- open Ramer–Douglas–Peucker (endpoints always kept) ---------------------
function openRDP(pts: Vec[], eps: number): number[] {
  const n = pts.length
  if (n <= 2) return pts.map((_, i) => i)
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    const a = pts[lo]
    const b = pts[hi]
    let maxD = -1
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(pts[i], a, b)
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (maxD > eps && idx >= 0) {
      keep[idx] = 1
      stack.push([lo, idx], [idx, hi])
    }
  }
  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

// --- evidence-based corner score over an OPEN arc (clamped windows) ---------
/** Points dense[i-k .. i+k] clamped to [0, n-1] (side<0: i-k..i, side>0: i..i+k). */
function windowClamped(dense: Vec[], i: number, k: number, side = 0): Vec[] {
  const n = dense.length
  const lo = Math.max(0, side > 0 ? i : i - k)
  const hi = Math.min(n - 1, side < 0 ? i : i + k)
  const out: Vec[] = []
  for (let o = lo; o <= hi; o++) out.push(dense[o])
  return out
}

/** Least-squares circle through `pts` (Kasa), or null when degenerate. Exported for
 *  the §14 continuation test. */
export function fitCircle(pts: Vec[]): { cx: number; cy: number; r: number } | null {
  const n = pts.length
  if (n < 3) return null
  let mx = 0
  let my = 0
  for (const p of pts) {
    mx += p.x
    my += p.y
  }
  mx /= n
  my /= n
  let uu = 0, vv = 0, uv = 0, uuu = 0, vvv = 0, uvv = 0, vuu = 0
  for (const p of pts) {
    const u = p.x - mx
    const v = p.y - my
    uu += u * u
    vv += v * v
    uv += u * v
    uuu += u * u * u
    vvv += v * v * v
    uvv += u * v * v
    vuu += v * u * u
  }
  const det = uu * vv - uv * uv
  if (Math.abs(det) < 1e-9) return null
  const b1 = (uuu + uvv) / 2
  const b2 = (vvv + vuu) / 2
  const uc = (b1 * vv - b2 * uv) / det
  const vc = (uu * b2 - uv * b1) / det
  const r2 = uc * uc + vc * vc + (uu + vv) / n
  if (!(r2 > 0)) return null
  return { cx: uc + mx, cy: vc + my, r: Math.sqrt(r2) }
}
/** Max radial deviation of `pts` from their best-fit circle (null when degenerate).
 *  Exported for the §14 continuation test — "does this boundary curve SMOOTHLY
 *  through the junction" is the same question the evidence score asks locally. */
export function circleMaxDev(pts: Vec[]): number | null {
  const c = fitCircle(pts)
  if (!c) return null
  let maxD = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x - c.cx, p.y - c.cy) - c.r)
    if (d > maxD) maxD = d
  }
  return maxD
}
function coverage(dense: Vec[], i: number, eps: number, kind: 'line' | 'circle' | 'wedge'): number {
  const kMax = Math.min(dense.length, MAX_EVIDENCE_WINDOW)
  let cover = 1
  for (let k = 1; k <= kMax; k++) {
    if (kind === 'wedge') {
      const lf = lineFit(windowClamped(dense, i, k, -1))
      const rf = lineFit(windowClamped(dense, i, k, 1))
      if (!lf || !rf) break
      if (Math.max(lf.maxDev, rf.maxDev) > eps) break
    } else if (kind === 'circle') {
      const dev = circleMaxDev(windowClamped(dense, i, k))
      if (dev !== null && dev > eps) break
    } else {
      const fit = lineFit(windowClamped(dense, i, k))
      if (!fit) break
      if (fit.maxDev > eps) break
    }
    cover = 2 * k + 1
  }
  return cover
}
function softF(x: number): number {
  return 1 - 1 / (1 + 5 * (x - 1))
}
/** c ∈ [−1 smooth … +1 corner] at open-arc index i (mirrors cornerScoreAtIndex). */
function openCornerScore(dense: Vec[], i: number, eps: number): number {
  const L = coverage(dense, i, eps, 'line')
  const S = coverage(dense, i, eps, 'circle')
  const C = coverage(dense, i, eps, 'wedge')
  if (L >= S) return -L / Math.max(L, C)
  if (S >= C) return -softF((S + 1) / (C + 1))
  return softF((C + 1) / (S + 1))
}

/** One-sided tangent at an open-arc index, oriented forward (toward +i). */
function openTangent(dense: Vec[], i: number, eps: number): Vec {
  const n = dense.length
  const half = eps / 2
  const fwd = unit(sub(dense[Math.min(n - 1, i + 1)], dense[Math.max(0, i - 1)]))
  let best = fwd
  const kMax = Math.min(n, MAX_EVIDENCE_WINDOW)
  for (let k = 1; k <= kMax; k++) {
    const fit = lineFit(windowClamped(dense, i, k))
    if (!fit) break
    if (fit.rms > half) break
    best = fit.dir
  }
  return best.x * fwd.x + best.y * fwd.y < 0 ? neg(best) : best
}

// --- candidates + open DP ---------------------------------------------------
type Cont = 0 | 1
interface Candidate {
  a: number
  len: number
  line: boolean
  startCont: Cont
  endCont: Cont
  cost: number
  c1: Vec
  c2: Vec
}

function orient(t: Vec, ref: Vec): Vec {
  return t.x * ref.x + t.y * ref.y < 0 ? neg(t) : t
}
function subsample(arc: Vec[], cap: number): Vec[] {
  const n = arc.length
  if (n <= cap) return arc
  const out: Vec[] = []
  for (let i = 0; i < cap - 1; i++) out.push(arc[Math.floor((i * (n - 1)) / (cap - 1))])
  out.push(arc[n - 1])
  return out
}
function lineDeviation(arc: Vec[]): { maxDev: number; sqErr: number } {
  const a = arc[0]
  const b = arc[arc.length - 1]
  let maxD = 0
  let sq = 0
  for (let i = 1; i < arc.length - 1; i++) {
    const d = perpDistance(arc[i], a, b)
    sq += d * d
    if (d > maxD) maxD = d
  }
  return { maxDev: maxD, sqErr: sq }
}

/**
 * Fit an OPEN dense polyline (junction→junction) to PathNodes. Endpoints are
 * pinned and forced to corner; interior joins choose corner vs smooth from the
 * evidence score via a min-cost linear DP over an over-complete candidate set.
 */
export function fitOpenArc(densePts: Vec[], opts: PlanarFitOptions): PathNode[] {
  const dense = dedup(densePts)
  const n = dense.length
  if (n < 2) return []
  if (n === 2) {
    return [
      { x: dense[0].x, y: dense[0].y, hIn: null, hOut: null, kind: 'corner' },
      { x: dense[1].x, y: dense[1].y, hIn: null, hOut: null, kind: 'corner' },
    ]
  }
  const eps = opts.epsilon
  const keyIdx = openRDP(dense, eps)
  const m = keyIdx.length
  if (m < 2) {
    return [
      { x: dense[0].x, y: dense[0].y, hIn: null, hOut: null, kind: 'corner' },
      { x: dense[n - 1].x, y: dense[n - 1].y, hIn: null, hOut: null, kind: 'corner' },
    ]
  }
  const tangents = keyIdx.map((i) => openTangent(dense, i, eps))
  const scores = keyIdx.map((i) => openCornerScore(dense, i, eps))
  const junc = scores.map(junctionCosts)
  const delta = 1e-6 * eps

  // Candidate set: a line between adjacent key vertices, plus cubics between any
  // pair (≤ MAX_SPAN) for the four C⁰/G¹ endpoint combos, each discarded if its
  // deviation exceeds ε.
  const byStart: Candidate[][] = Array.from({ length: m }, () => [])
  for (let a = 0; a < m; a++) {
    const fromIdx = keyIdx[a]
    const maxLen = Math.min(m - 1 - a, MAX_SPAN)
    for (let len = 1; len <= maxLen; len++) {
      const b = a + len
      const toIdx = keyIdx[b]
      const arc = subsample(dense.slice(fromIdx, toIdx + 1), MAX_FIT_POINTS)
      if (arc.length < 2) break
      if (len === 1) {
        const ld = lineDeviation(arc)
        if (ld.maxDev <= eps) {
          byStart[a].push({ a, len, line: true, startCont: 0, endCont: 0, cost: opts.lineCost + delta * ld.sqErr, c1: arc[0], c2: arc[arc.length - 1] })
        }
      }
      const freeStart = unit(sub(dense[fromIdx + 1], dense[fromIdx]))
      const freeEnd = unit(sub(dense[toIdx - 1], dense[toIdx]))
      const startDirs: [Cont, Vec][] = [
        [0, freeStart],
        [1, orient(tangents[a], freeStart)],
      ]
      const endDirs: [Cont, Vec][] = [
        [0, freeEnd],
        [1, orient(neg(tangents[b]), freeEnd)],
      ]
      let interG1 = 0
      for (let p = 1; p < len; p++) interG1 += junc[a + p].g1
      let anyFit = false
      for (const [sc, sd] of startDirs) {
        for (const [ec, ed] of endDirs) {
          const fit = fitSingleCubic(arc, sd, ed)
          if (fit.maxDev > eps) continue
          anyFit = true
          byStart[a].push({ a, len, line: false, startCont: sc, endCont: ec, cost: opts.cubicCost + delta * fit.sqErr + interG1, c1: fit.c1, c2: fit.c2 })
        }
      }
      if (!anyFit && len > 1) break
    }
  }

  // Open linear DP. dp[p][cont] = min cost to reach key-vertex p arriving with
  // continuity `cont`. Endpoints (0 and m-1) are corners: the first candidate
  // starts C⁰, the last ends C⁰.
  const INF = Infinity
  const cost: number[][] = Array.from({ length: m }, () => [INF, INF])
  const back: ({ from: number; fromCont: Cont; cand: Candidate } | null)[][] = Array.from({ length: m }, () => [null, null])
  cost[0][0] = 0
  for (let p = 0; p < m - 1; p++) {
    for (const tin of [0, 1] as Cont[]) {
      const base = cost[p][tin]
      if (!Number.isFinite(base)) continue
      for (const c of byStart[p]) {
        const isFirst = p === 0
        let jcost = 0
        if (isFirst) {
          if (c.startCont !== 0) continue // endpoint is a forced corner
        } else {
          jcost = tin === 1 && c.startCont === 1 ? junc[p].g1 : junc[p].c0
        }
        const q = p + c.len
        if (q > m - 1) continue
        const total = base + jcost + c.cost
        if (total < cost[q][c.endCont]) {
          cost[q][c.endCont] = total
          back[q][c.endCont] = { from: p, fromCont: tin, cand: c }
        }
      }
    }
  }
  // Final endpoint must arrive as a corner (endCont 0).
  let endCont: Cont = 0
  if (!Number.isFinite(cost[m - 1][0])) {
    if (!Number.isFinite(cost[m - 1][1])) return polylineNodes(keyIdx, dense) // fallback: corner polyline
    endCont = 1
  }

  // Reconstruct the chosen candidates (forward order).
  const chosen: Candidate[] = []
  let p = m - 1
  let t: Cont = endCont
  while (p > 0) {
    const b = back[p][t]
    if (!b) break
    chosen.push(b.cand)
    p = b.from
    t = b.fromCont
  }
  chosen.reverse()
  if (chosen.length === 0) return polylineNodes(keyIdx, dense)

  // Materialize to OPEN PathNodes (no wrap). Anchor i shared between seg i-1/i.
  const segs = chosen.map((c) => ({
    p0: dense[keyIdx[c.a]],
    p3: dense[keyIdx[c.a + c.len]],
    hOut: c.line ? null : { x: c.c1.x, y: c.c1.y },
    hIn: c.line ? null : { x: c.c2.x, y: c.c2.y },
    startCont: c.startCont,
    endCont: c.endCont,
  }))
  const nodes: PathNode[] = []
  for (let s = 0; s < segs.length; s++) {
    const seg = segs[s]
    const prev = s > 0 ? segs[s - 1] : null
    const smooth = prev !== null && seg.startCont === 1 && prev.endCont === 1
    nodes.push({
      x: seg.p0.x,
      y: seg.p0.y,
      hIn: prev && prev.hIn ? { x: prev.hIn.x, y: prev.hIn.y } : null,
      hOut: seg.hOut ? { x: seg.hOut.x, y: seg.hOut.y } : null,
      kind: smooth ? 'smooth' : 'corner',
    })
  }
  // Final endpoint anchor.
  const lastSeg = segs[segs.length - 1]
  nodes.push({
    x: lastSeg.p3.x,
    y: lastSeg.p3.y,
    hIn: lastSeg.hIn ? { x: lastSeg.hIn.x, y: lastSeg.hIn.y } : null,
    hOut: null,
    kind: 'corner',
  })
  return nodes
}

/** Fallback: straight polyline through the key vertices, all corners. */
function polylineNodes(keyIdx: number[], dense: Vec[]): PathNode[] {
  return keyIdx.map((i) => ({ x: dense[i].x, y: dense[i].y, hIn: null, hOut: null, kind: 'corner' as const }))
}

// --- sharp-corner CLOSED-loop fitting (anti-bevel) --------------------------
// `detectCorners` + corner-pinned presmooth keep a sharp apex from being MELTED,
// but the closed-loop fitter (fitClosedLoop) still places its key vertices on the
// rounded staircase AROUND a tip — two nodes straddling the apex with a short
// segment cutting across it (a visible bevel; the apex itself is never a node).
// For a loop that has ≥2 genuine sharp corners we instead localize each corner to
// its sub-pixel APEX (the intersection of its two arms), split the loop there, and
// fit each arc as an OPEN arc pinned at the snapped corners — so every corner is
// one exact sharp node. Smooth loops (circles, gradient blobs) have <2 corners and
// never take this path, so their fit is unchanged.

const SNAP_GAP = 3 // skip this many px nearest the tip (the rounded part) per arm
const SNAP_SPAN = 14 // …and fit the arm line over up to this many px beyond the gap
/**
 * Fewest samples an arm may carry and still earn a reconstruction (§31, issue #36). §10.6
 * wrote the short-arm bypass as `SNAP_GAP + 4` STEPS of span — "3 censored + 4 samples"
 * under the then-fixed gap of 3 — and swept it upward only (11/14 collapse recall to
 * 57–62%). With `armGap` censoring a single step on a short arm, a 5–6-step window carries
 * 5–6 samples, and the paired census (src/devtest/cornerScaleDiag.ts) measured the bypass
 * refusing an intersection CLOSER to the authored corner than the lattice vertex it kept
 * on 6 of 8 gear-teeth corners at the lab raster (0.54 vs 1.04 px mean, max 0.78 vs 2.46):
 * the §10.6 displacement cap and the §18 evidence veto, both younger than the bypass, now
 * hold the noisy regime the bypass was written for. Measured walls: 4 samples invents
 * corners on corner-turns @256 (inv 5 → 9) and costs bar-caps @256 placement; at 5 every
 * watchlist case is byte-stable except gear-teeth's own placement (@512 mean 0.615 →
 * 0.542, p90 1.20 → 0.99, max 2.46 → 2.06). Stated in samples
 * so it stays consistent with the gap it follows: a span clamped by an open chain's end
 * (fitCorneredOpen) with the full 3-px gap is 3 samples, not 6.
 */
const SHORT_ARM_SAMPLES = 5
/**
 * …and the floor at which a corner's arm LINE DIRECTIONS are trusted as tangents for the
 * §15 pin — the old bypass floor, kept for the claim it was actually good for, on BOTH
 * sides. The 5-sample floor above admits a population the pin never saw (§15.7/§15.8
 * calibrated it on corners whose two arms both carried ≥ 7 samples), and the census
 * measured what the pin does there: on `stripe` @512 both admitted apexes land closer to
 * their authored corners (0.99 → 0.53 px, 0.35 → 0.31) and chamfer still rises 0.194 →
 * 0.209 — the corner's LONG arm on a curved letterform is a 14-sample chord with 0.86 px
 * of bow, and rotating the handle onto it bows the adjacent arc; pinning only the long
 * side measured the same 0.209. An intersection is tolerant of that bow (two chords still
 * cross near the corner); a tangent is not. So a corner with a short side takes its apex
 * from the intersection and keeps the fit's own tangents on both sides — exactly the pin
 * population the old rule had, and byte-identical for every corner it admitted.
 */
const ARM_PIN_SAMPLES = SNAP_GAP + 4
/**
 * §31: how far a short-armed reconstruction may move before the raster is asked whether the
 * corner is out there (§18's `apexReach` probe, otherwise consulted only past
 * APEX_OVERSHOOT_MAX 2.5). The population the 5-sample floor admits includes the
 * detector's false positives on tight SMOOTH authored nodes — a kink the old bypass had
 * left at its lattice vertex — whose two chord lines cross OUTSIDE the ink and slide the
 * kink 1–2.4 px off the boundary (sony, intel-wm, mercado-pago @512). The raster settles it
 * the way §18 settled the acute counters: an eroded true corner leaves a coverage trail
 * along the ray, a chord crossing on a convex arc leaves none.
 */
const SHORT_ARM_PROBE_MIN = 0.5

/**
 * SCALE-AWARE snap gap (§10.6): the fixed 3px gap is right for a long arm (skip
 * the AA-rounded tip, plenty of evidence beyond), but on a SHORT inter-corner arc
 * it discards most of the arm — a gear tooth's ~8-step chord keeps only ~5
 * phase-noise samples, and the fitted arm line misplaces the apex 2.6–4.4px (past
 * the scorer's 2.5px radius). The gap scales with the arc so short arms keep their
 * evidence: ≥13 steps keep the full 3px gap (long-arm behaviour byte-identical);
 * an 8-step chord drops to gap 1. The erosion risk the gap guards against shrinks
 * with the same scale — a corner whose arms are that short has sub-px rounding.
 */
function armGap(steps: number): number {
  return Math.min(SNAP_GAP, Math.max(1, ((steps - 1) / 4) | 0))
}

/**
 * SCALE-AWARE smoothing for an inter-corner arc (§10.6): presmooth exists to melt
 * a LONG staircase before fitting; a short arc between two snapped corners has
 * almost no staircase to melt, and each pass bends its few interior points inward
 * — the fitted end tangents rotate with them, and a 67° authored joint reads
 * < 60° (not-a-corner) off geometry the smoothing invented. Full passes from 16
 * points up (long-arc behaviour unchanged), one pass down to 9, raw below.
 */
function arcSmoothPasses(passes: number, arcLen: number): number {
  return arcLen >= 16 ? passes : arcLen >= 9 ? Math.min(passes, 1) : 0
}

/** A straight arm may extend its sample window this far (see armSamples). */
const SNAP_SPAN_MAX = 40
/** Max perp deviation (px) for an extension point to count as "still the same
 *  straight arm" — just above the ±0.5px staircase quantization. */
const SNAP_COLLINEAR = 0.75

/**
 * An arm line WITH the evidence that says whether it is a tangent at all: the max
 * perpendicular deviation of its own samples (`bow`) and the window's chord length.
 * A straight arm's samples sit on the line (bow ≈ the raster's own ±0.5px staircase,
 * far less on a §15-displaced chain); a CURVED arm's line is a chord, and its bow is
 * the arc's sagitta over that window. The §15 tangent pin needs the distinction: a
 * chord's direction is not the boundary's direction at the apex.
 */
export interface ArmFit {
  /** Unit direction, oriented along the chain's travel by the caller. On a §19 circle
   *  arm this is the tangent AT the snapped apex (a chord's direction is not the
   *  boundary's direction there — §15.8's crown lesson), else the fitted line's. */
  dir: Vec
  /** Max |perpendicular deviation| of the arm samples from the fitted LINE, px — the
   *  curvature evidence, kept line-based even when the arm upgrades to a circle. */
  bow: number
  /** Distance between the first and last arm sample, px. */
  chord: number
  /** Number of samples in the window. */
  n: number
  /** Which §19 model placed this arm's side of the apex. Absent = line (pre-§19 shape). */
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
function armFitOf(pts: Vec[]): { line: { c: Vec; d: Vec }; fit: ArmFit } {
  const line = armLine(pts)
  let bow = 0
  for (const p of pts) {
    const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
    if (dev > bow) bow = dev
  }
  return { line, fit: { dir: line.d, bow, chord: dist(pts[0], pts[pts.length - 1]), n: pts.length } }
}

// (snapCornerToArms, the p-only wrapper, was deleted 2026-08-11 — every caller goes
// through snapApex/snapCornerToArmsFull, which need the options and the arm fits.)

/**
 * Which rule decided where a corner's apex ended up. Every value but `reconstructed`
 * keeps the raw lattice/chain vertex — they are the snap's four refusals, named so a
 * histogram can tell "the arms placed this" from "the arms were not trusted".
 */
export type ApexOutcome =
  | 'reconstructed' //  the arm-line intersection, inside the displacement cap
  | 'short-arm' //      §10.6 bypass: neighbours too close to fit an arm at all
  | 'few-samples' //    a window with < 2 points on one side
  | 'parallel' //       the two arm lines are near-collinear (no intersection)
  | 'over-cap' //       the intersection ran further than the GEOMETRIC cap allows
  | 'past-evidence' //  §18: it ran past the coverage the RASTER carries
  | 'cap' //            §10.7: placed by the cap resolver (arm ∩ cap-chord), not the apex snap

/** One corner the apex snap considered, for the histogram behind any change to it
 *  (`src/devtest/apexDiag.ts`). Observational only — attaching a sink never changes the
 *  fit. See PlanarFitOptions.apexDiag. */
export interface ApexDiagRecord {
  /** Shared-edge id. Attached by assemblePlanar — the fitter does not know it. */
  edge?: number
  /** The chain vertex the corner was detected at (lattice, or §15-displaced). */
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
   *  apex before the arm window starts. Recipe 5 of the absolute-px audit (issue #36). */
  inGap: number
  outGap: number
  /** Arm evidence, −1 where the arm was never fitted. */
  inBow: number
  outBow: number
  inChord: number
  outChord: number
  inN: number
  outN: number
  /** The raw arm intersection the ESTIMATOR proposed, before any selector (cap, evidence
   *  veto, short-arm bypass) decided — NaN where no intersection exists. On `short-arm` it
   *  is the plain base-window line∩line, computed for the record only (issue #36: measure
   *  the estimator before the selector). */
  hx: number
  hy: number
  /** Interior angle between the two fitted arm lines at the apex (deg); −1 without arms.
   *  Acute tips — where a slow convergence throws the intersection far — read small. */
  tipDeg: number
  /** §18: how far the own region's coverage reaches along the reconstruction ray, px.
   *  −1 when no probe was attached or the snap never got as far as asking. */
  reach: number
  /** §19: which model placed each arm's side of the apex. Absent = line. */
  inKind?: 'line' | 'circle' | 'tangent'
  outKind?: 'line' | 'circle' | 'tangent'
}

export type ApexDiag = (r: ApexDiagRecord) => void

/** §19 (issue #7): a fitted tip this close to straight contradicts the ≥60°-turn corner
 *  definition by ≥30° — the "corner" is a staircase jog whose intersection is
 *  ill-conditioned ALONG the boundary. Census @512 flat: reconstructions with fitted tips
 *  147–163° land 3.6–5.1px from the authored corner where the lattice vertex was
 *  0.35–1.0px off (instagram 5.05 vs 0.35), and §18's reach probe cannot refuse them —
 *  the ray runs along a real edge whose AA fringe reads as coverage. */
const PARALLEL_TIP_DEG = 150
/** §19: an arm's samples must bow at least this far off their fitted line before the
 *  line is treated as a chord of a curve and upgraded to a fitted circle. Below it the
 *  line model is within the staircase's own noise (SNAP_COLLINEAR 0.75 is the same
 *  regime) and the pre-§19 path is byte-identical. */
const ARC_ARM_BOW_MIN = 0.5
/** §19: the fitted circle must EXPLAIN the samples — radial deviation at most this
 *  fraction of the line's own bow, floored at SNAP_COLLINEAR (the staircase's own ±0.5px
 *  quantization means even a perfectly circular arm cannot fit below it; the line path
 *  extends under the same 0.75px reading of "on the model") — or the arm keeps the line. */
const ARC_ARM_DEV_K = 0.5
/** §19: see PlanarFitOptions.arcPinMinN / arcArmMinN / arcPhiMinDeg / arcTipMinDeg. */
const ARC_PIN_MIN_N = 12
const ARC_ARM_MIN_N = 12
const ARC_PHI_MIN_DEG = 10
const ARC_TIP_MIN_DEG = 45
const ARC_PIN_TURN_MIN_DEG = 70

/** A §19 arm circle (the file's own Kasa fit — see fitCircle above). */
type ArmCircle = { cx: number; cy: number; r: number }

/** Box-smooth a window (endpoints pinned): the raw samples are ±0.5px staircase (§15's
 *  corner self-guard deliberately reverts sub-pixel displacement near a corner), and any
 *  shape statistic read off them — a Kasa radius, a sagitta — is step noise otherwise
 *  (measured: Kasa r 1.7–4.1 where the authored arc is r≈14). */
function boxSmooth(ptsArm: Vec[], passes = 2): Vec[] {
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

/** The §19 arm circle, when the samples earn it — null keeps the line model. */
function armCircle(sm: Vec[], fit: ArmFit, opts: PlanarFitOptions): ArmCircle | null {
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
 * The §19 'tangent' arm model: the LINE the arm's own curve is actually travelling at
 * the tip end of the window. A bent arm's LSQ line is a CHORD — offset by the sagitta
 * and rotated by the chord-to-tangent angle, both of which displace the apex
 * intersection along the other arm.
 *
 * HALF-SPLIT, not sagitta. The window is split at its middle and each half gets its own
 * LSQ line; on a uniform arc the two half directions disagree by θ/2 (θ the window's arc
 * turn) and the tangent at the tip END is the tip half's direction continued by another
 * θ/4. Everything is measured as a DIRECTION over ≥6 samples, which is what makes it
 * robust where two rejected models were not: a sagitta statistic reads step-phase and AA
 * fattening as curvature (the parabola model over-rotated an acute @256 tip 2.2px past
 * its authored apex, and a 2·|s̄|/bow coherence gate was non-separable at any K — it even
 * cost gear-teeth corners), and a Kasa radius on an ~8px window collapses to noise
 * (r 1.7–4.1 where the authored arc is r≈14). A straight STAIRCASE arm's halves agree
 * within noise, so the model degrades to the chord it replaced — polygonal art keeps its
 * pre-§19 corners without needing a classifier to say so.
 */
interface ArmTangent {
  /** Anchored tangent line at the window's tip end — the intersection target, and the
   *  direction the §15 pin consumes. */
  c: Vec
  d: Vec
}

function armTangent(sm: Vec[], line: { c: Vec; d: Vec }, phiMinDeg: number): ArmTangent | null {
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
    // a denoised point ON the boundary at the window's corner end.
    c: (() => {
      const t0 = (sm[0].x - tip.c.x) * dTip.x + (sm[0].y - tip.c.y) * dTip.y
      return { x: tip.c.x + t0 * dTip.x, y: tip.c.y + t0 * dTip.y }
    })(),
    d: { x: dTip.x * cr - dTip.y * sr, y: dTip.x * sr + dTip.y * cr },
  }
}

/** Intersection candidates (0–2) of two arm primitives, each a line or a circle. */
function armIntersections(
  aLine: { c: Vec; d: Vec }, aCirc: ArmCircle | null,
  bLine: { c: Vec; d: Vec }, bCirc: ArmCircle | null,
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
  return [] // line×line is the caller's own (pre-§19) math
}

/** Unit tangent of `circ` at `at`, oriented to agree with `along`. */
function circleTangentAt(circ: ArmCircle, at: Vec, along: Vec): Vec {
  let tx = -(at.y - circ.cy)
  let ty = at.x - circ.cx
  const l = Math.hypot(tx, ty) || 1
  tx /= l
  ty /= l
  return tx * along.x + ty * along.y >= 0 ? { x: tx, y: ty } : { x: -tx, y: -ty }
}

/**
 * The corner snap: place the apex on the intersection of the two arm models flanking it
 * (each sampled [gap..span] px away so the rounded tip is excluded), ALSO returning the
 * two fitted arm DIRECTIONS (unit, oriented along the chain's travel: `inDir` INTO the
 * apex, `outDir` AWAY from it) whenever the reconstruction had usable arm evidence —
 * null on every lattice-fallback path. The §15 tangent pin consumes them: on a
 * sub-pixel displaced chain the fitted arcs' end tangents at an apex are free within ε
 * and rotate toward the bisector (a 91° authored corner read 77° from the lattice fit
 * and 51° displaced — under the 60° sharp bar), while the arm models read the true
 * flank directions at any resolution. An arm is a LINE while its samples sit on one and
 * a §19 anchored tangent where they measurably curve; `winding` (±1 for loops, 0 for
 * open chains) feeds the §19 concavity read.
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
  // Base window [gap..span], then extend up to `max` while the arm stays COLLINEAR.
  // A 1-in-14 staircase (a shallow star tip, slope ~0.07) shows less than ONE unit
  // step inside the base window, so its fitted slope is pure step-phase noise — and
  // at a ~4° tip angle every slope error multiplies ~1/tan(4°) ≈ 14× into AXIAL apex
  // error (the 2.78px left-tip overshoot). Straight arms earn the longer window
  // (3 steps nail the slope); a curved arm fails the collinearity test at its first
  // extension and keeps the base window, so ring/blob corners are unmoved.
  // Gaps are per-side (armGap): a short inter-corner arc keeps its evidence.
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
  // SHORT-ARM bypass (§10.6, re-derived in §31): reconstruction (arm-line intersection)
  // exists to recover an apex the raster ERODED — a shallow tip whose true corner sits
  // px past the lattice. It needs arm evidence to earn that (slope error divides by
  // tan(tip angle)): an arm carrying fewer than SHORT_ARM_SAMPLES samples is phase
  // noise, and its RAW cluster apex — already sub-px correct on a feature that small
  // (gear-teeth @256 measured the bypass right 11:6) — is kept. See SHORT_ARM_SAMPLES
  // for the census that moved the floor from 7 steps of span to 5 samples.
  const inSamples = inSpan - inGap + 1
  const outSamples = outSpan - outGap + 1
  if (Math.min(inSamples, outSamples) < (opts.shortArmSamples ?? SHORT_ARM_SAMPLES)) {
    // Diagnostic only: what the plain base-window estimator WOULD have said, so the
    // census can score the bypass as a selector. Never computed in production.
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
  // Orient along chain travel: `a` was sampled BEFORE the apex (in), `b` AFTER (out).
  const orient = (d: Vec, from: Vec, to: Vec): Vec => {
    const s = d.x * (to.x - from.x) + d.y * (to.y - from.y)
    return s >= 0 ? { x: d.x, y: d.y } : { x: -d.x, y: -d.y }
  }
  const inArm: ArmFit = { ...aFit.fit, dir: orient(a.d, pts[wrap(c - inSpan)], pts[c]) }
  const outArm: ArmFit = { ...bFit.fit, dir: orient(b.d, pts[c], pts[wrap(c + outSpan)]) }
  // The arms handed back are the §15 pin's evidence; a corner with a side under
  // ARM_PIN_SAMPLES places its apex (below) and pins nothing on either side. Byte-identical
  // for every corner the old 7-step floor admitted, since both of its sides carry ≥ 7
  // samples by construction.
  const pinMin = opts.armPinSamples ?? ARM_PIN_SAMPLES
  const pinOk = Math.min(inSamples, outSamples) >= pinMin
  const pinArm = (arm: ArmFit, _samples: number): ArmFit | null => (pinOk ? arm : null)
  // §19 near-parallel guard (issue #7's family A): interior angle between the two arms
  // as rays leaving the apex — a straight run reads 180°. See PARALLEL_TIP_DEG.
  if (opts.arcArms) {
    const cosI = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
    if ((Math.acos(cosI) * 180) / Math.PI > (opts.parallelTipDeg ?? PARALLEL_TIP_DEG)) {
      return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples))
    }
  }
  // §19 arm model (issue #7): where an arm's samples measurably bow off their line, the
  // line is a CHORD of a curve and the chord intersection slides along the other arm.
  // 'tangent' (default) replaces the chord with the arm's anchored tangent line at the
  // tip end of the window; 'circle' intersects fitted circles instead — exact on large
  // clean arcs, measured unstable on ~8px letterform windows. Straight arms keep the
  // pre-§19 line untouched either way.
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
  // Tip floor: the chord-estimated interior angle, from the already-oriented arm dirs.
  // See PlanarFitOptions.arcTipMinDeg — below it the chords stay, byte-identically.
  // CONCAVE corners (a notch INTO the loop's interior — the crotch family) are exempt:
  // their chord-tips under-read because both walls curve INTO the notch (a 77° authored
  // crotch reads 37.6°), while every population the floor protects — lens tips,
  // sharp-star points — is a CONVEX corner of its enclosed region.
  const cosTip = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
  const turnCross = inArm.dir.x * outArm.dir.y - inArm.dir.y * outArm.dir.x
  const concave = winding !== 0 && turnCross * winding < 0
  const tipOk = concave || (Math.acos(cosTip) * 180) / Math.PI >= (opts.arcTipMinDeg ?? ARC_TIP_MIN_DEG)
  // CO-CIRCULAR window extension: the line path grows a straight arm's evidence while
  // collinear (collect/inMax); a curved arm's evidence stops dead at the span cap even
  // where its arc continues cleanly — and at n=12 the half-split φ sits at its own noise
  // floor (the witness 'e' corner's two MIRROR arms read φ on opposite sides of the
  // gate). So a bent arm may extend while new samples stay on its own fitted circle; a
  // KINKED window (gear) breaks circle-consistency at once and extends nothing.
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
    // the chord crossing — the §10.6/§18 caps below still bound whatever comes out.
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
  // Report each arm's direction as the tangent AT the apex; the §15 pin consumes it.
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
  // Re-check conditioning on the FINAL tangents: a noisy shape model can rotate two
  // moderately-turning chords into near-collinearity (a fitted tip of 172.7° slipped
  // through the chord-side guard on the witness mark), and such a "corner" both places
  // badly and reads smooth downstream. Same bound as the chord-side guard.
  if (opts.arcArms && (inArm.kind || outArm.kind)) {
    const cosF = Math.min(1, Math.max(-1, -(inArm.dir.x * outArm.dir.x + inArm.dir.y * outArm.dir.y)))
    if ((Math.acos(cosF) * 180) / Math.PI > (opts.parallelTipDeg ?? PARALLEL_TIP_DEG)) {
      return keep('parallel', pinArm(inArm, inSamples), pinArm(outArm, outSamples), 0, hitOut)
    }
  }
  // SCALE-AWARE displacement cap (§10.6): how far the reconstructed apex may move
  // off the lattice corner is bounded by the EVIDENCE. A long-armed corner (an
  // eroded shallow star tip) legitimately reconstructs several px past the lattice
  // vertex and its arm fits have the samples to earn that. A SHORT-armed corner is
  // the opposite on both counts: its arm lines are phase-noise (the intersection
  // wanders px off a corner whose raw vertex is already sub-px correct — a gear
  // tooth's lattice corner beats its own reconstruction), and a corner that small
  // carries sub-px erosion, so there is nothing to reconstruct. Past the cap we
  // keep the lattice corner.
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
 * §18 (issue #17) — how far past the raster's own evidence a reconstruction may land.
 *
 * The arm-line intersection is the right answer for a raster-ERODED tip: a shallow star
 * point genuinely sits px beyond the last labelled pixel, and reconstructing it is what
 * §10.2 measured as sharp-star's 11/11 corner recall. It is the wrong answer for an ACUTE
 * CURVED counter, where each "arm line" is a chord leaning into the lens and the two
 * chords cross px past the real tip — logo-instagram's 'a' counter lands 3.4px above its
 * own tip, where the source luminance is 57 (solid ink).
 *
 * The two cases are indistinguishable by geometry — same code, same spans, similar bows
 * (§17.1 measured `bow` NOT separable: ≤ 0.79 holds 51 authored-straight arms and 100
 * authored-bent ones). What separates them is the RASTER: erosion leaves a decaying trail
 * of partial coverage between the lattice vertex and the true corner — that trail IS the
 * erosion — while a counter reconstructed into its own stem has no trail at all, coverage
 * falling off a cliff at the lattice vertex.
 *
 * So the first term of the rule is the overshoot past that trail (`moved − reach`), read
 * off the corpus rather than guessed (src/devtest/apexDiag.ts, @512). Worst overshoot
 * among the reconstructions that must SURVIVE — every control whose recall this snap buys:
 *
 *     sharp-star 0.85 · gear-teeth 1.92 · fedex 1.89 · seam-corner 0.75 · cross-bars 0.37
 *     band-cross 0.37 · wedge-counter 0.21 · acute-counter's own eroded spikes −1.08
 *
 * …against the defect population: `acute-counter` 7 of 15 past 2px (worst 6.47 @512,
 * 10.25 @256), logo-instagram 20, logo-chupa-chups 12, logo-coca-cola 15. 2.5 leaves every
 * survivor @512 untouched (2.0 would start clipping gear-teeth and fedex for 3px of
 * `acute-counter` Σ — blast radius is worth more than that) and sits under the defect mass.
 */
const APEX_OVERSHOOT_MAX = 2.5

/**
 * …and the second half of the rule, because the overshoot ALONE is not separable — this is
 * the measurement that killed the obvious version. `acute-counter`'s own eroded 10° spike
 * @256 reconstructs 7.57px with the trail reaching 5.00 (overshoot 2.57) and lands 0.50px
 * from its authored apex; a `gear-teeth` tooth @256 overshoots 3.55. Both are RIGHT, and
 * both sit inside the overshoot range of the lens tips this veto exists to refuse
 * (6.23–10.25 @256). A distance threshold that spares them spares the defect too.
 *
 * What does separate is what FRACTION of the way the raster's own material covers. Erosion
 * only hides the last sub-pixel sliver of a tip, so the trail runs most of the distance
 * (the spikes: 5.00/7.57 = 0.66, 3.75/5.98 = 0.63, and past 1.0 at finer rasters). An
 * over-reconstruction leaves the shape at the lattice vertex and keeps going, so the trail
 * covers a minority of it (the lens tips: 0.00–0.53, median 0.20).
 *
 * So the reconstruction is corrected only when it BOTH runs > APEX_OVERSHOOT_MAX past the
 * evidence AND the evidence covers less than this fraction of it. 0.6 is the middle of the
 * measured gap (defect ratios top out at 0.53, the surviving spikes start at 0.63) and the
 * sweep is red on either side of it: at 0.70 the @256 spike is corrected and lands 7.07px
 * from its authored apex instead of 0.50. Corner recall on every control — sharp-star
 * 11/11, gear-teeth 52/60, bar-caps 43/43, cross-bars 10/10, band-cross 25/25, checker
 * 3556/3588 — is byte-identical under every rule in the sweep, at 256 and 512 both.
 */
const APEX_REACH_FRAC = 0.6

/**
 * The apex snap, its §18 evidence veto, and the diagnostic emission — the one place both
 * cornered fitters get a corner from. `tipDeg` is the INTERIOR angle between the two arms
 * as rays leaving the apex: `inArm.dir` runs INTO the apex and `outArm.dir` away from it,
 * so a straight run reads 180° and an acute tip reads small. That is the quantity issue
 * #17 is about — the shallower the tip, the further a slope error in either arm throws
 * their intersection along the bisector.
 */
function snapApex(
  pts: Vec[],
  c: number,
  inGap: number,
  outGap: number,
  inSpan: number,
  outSpan: number,
  inMax: number,
  outMax: number,
  opts: PlanarFitOptions,
  /** Loop orientation sign for the §19 concavity read; 0 = open chain / unknown. */
  winding = 0,
): { p: Vec; inArm: ArmFit | null; outArm: ArmFit | null } {
  let full = snapCornerToArmsFull(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts, winding)
  let moved = dist(full.p, pts[c])
  // Only a reconstruction that already moved further than the bound can possibly break it,
  // so the raster probe stays off the hot path for the overwhelming majority of corners.
  let reach = -1
  const overMax = opts.apexOvershootMax ?? APEX_OVERSHOOT_MAX
  const reachFrac = opts.apexReachFrac ?? APEX_REACH_FRAC
  // §31: a short-armed reconstruction is asked the same question at a shorter range — its
  // arms are 5–6 samples, so the intersection is trusted only as far as the raster's own
  // material follows it (see SHORT_ARM_PROBE_MIN).
  const shortArmed = Math.min(inSpan - inGap, outSpan - outGap) + 1 < (opts.armPinSamples ?? ARM_PIN_SAMPLES)
  const probeMin = shortArmed ? Math.min(overMax, opts.shortArmProbeMin ?? SHORT_ARM_PROBE_MIN) : overMax
  if (opts.apexEvidence !== false && opts.apexReach && full.outcome === 'reconstructed' && moved > probeMin) {
    reach = opts.apexReach(pts[c], full.p)
    if (moved - reach > probeMin && reach < reachFrac * moved) {
      // CLAMP to the evidence rather than discard it. Falling all the way back to the
      // lattice vertex was measured and is the wrong correction: where the tip is
      // genuinely (if partly) eroded the truth lies BETWEEN the two, and pinning to the
      // lattice pulls the whole adjacent arc in — `acute-counter` @256 boundary p95
      // 2.13 → 3.46, worse than the overshoot it removed. `reach` is where the raster's
      // own material actually stops, which is the best estimate of the tip either side
      // of this rule has.
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

/**
 * Indices of the sharp corners on a CLOSED staircase loop — ONE per corner. The
 * same ±`win` macro-turn test as `detectCorners`, but each cluster of sub-threshold
 * vertices is collapsed to its geometric APEX (the vertex farthest from its window
 * chord), and apexes within `mergeDist` px fuse (a rasterized tip is often a 1-px
 * plateau = two "shoulder" vertices, possibly split across the loop seam). Sorted
 * ascending. `turnDeg ≥ 180` ⇒ ∅ (disabled). See CORNER_MERGE for why the fuse
 * distance is 3. (Two §10.6 variants were tried and MEASURED WORSE on the real
 * pipeline: a two-scale win∪win−1 apex union — extra fine apexes poison their
 * neighbours' fitted tangents — and a ±2px fine-turn apex re-localization — a
 * staircase reads ~90° at ordinary step vertices too.)
 */
export function detectLoopCorners(pts: Vec[], turnDeg: number, win = CORNER_WINDOW, mergeDist = CORNER_MERGE, read?: TurnRead): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const cos = readTurnCos(pts, true, win, 0, n, turnDeg, read)
  // Cluster consecutive sub-threshold (sharp) vertices; apex = max perp-to-chord.
  const used = new Uint8Array(n)
  const apexes: number[] = []
  for (let s = 0; s < n; s++) {
    if (cos[s] >= thr || used[s]) continue
    let best = s
    let bestDev = -1
    let i = s
    while (cos[wrap(i)] < thr && !used[wrap(i)]) {
      const k = wrap(i)
      used[k] = 1
      const dev = perpDistance(pts[k], pts[wrap(k - win)], pts[wrap(k + win)])
      if (dev > bestDev) {
        bestDev = dev
        best = k
      }
      i++
    }
    apexes.push(best)
  }
  apexes.sort((a, b) => a - b)
  if (apexes.length < 2) return apexes
  // Fuse near-coincident apexes (consecutive, plus the cyclic first/last pair).
  const merged: number[] = []
  for (const a of apexes) {
    const last = merged[merged.length - 1]
    if (last !== undefined && dist(pts[a], pts[last]) <= mergeDist) continue
    merged.push(a)
  }
  if (merged.length >= 2 && dist(pts[merged[0]], pts[merged[merged.length - 1]]) <= mergeDist) merged.pop()
  return merged
}

/**
 * BAR-END CAP resolver (§0 #6b). Inside a cap narrower than ~2·CORNER_WINDOW the
 * ±win turn test cannot separate the two 90° shoulders: every vertex on the cap
 * sees BOTH shoulders through the window and reads a diluted 60–90° turn, so the
 * sub-threshold run structure — and with it the apex count and placement — is
 * staircase-phase lottery. Measured on the bar-caps rack @512 (capDiag.ts): a 7px
 * cap emits 1 apex (the far corner bevels away), 3 apexes (each fitted node
 * carries only 38–52° of the cap's turn — present but blunt, the exact failure
 * §10.6 rejected the two-scale union for), or 2 apexes a px off the corners
 * (cubic end-tangent wobble on the ≤7px arc reads 45° at a true corner).
 *
 * The resolver re-reads each apex GROUP (sub-threshold runs joined across gaps
 * ≤ joinGap) and classifies it as a CAP on three pieces of evidence:
 *   • through-turn: travel direction REVERSES across the group (≥ throughDeg —
 *     a bar end U-turns; a gear root→tip zigzag nets ~13° and never qualifies);
 *   • chord: the group spans a cap-sized chord (chordMin..chordMax px — a
 *     rasterized tip plateau is ≤2px and stays a tip; an 8px+ cap or a checker
 *     cell edge already resolves into two clean shoulder runs and is left alone);
 *   • flatness: every group vertex sits within `flat` px of the group chord (a
 *     sharp-star tip V dips several px below its shoulder chord and never
 *     qualifies — this is what makes a cap a cap and a tip a tip).
 * A classified cap contributes exactly TWO corners — the group's outermost
 * sub-threshold vertices — and the arc between them is fitted as a straight
 * LINE with both endpoints snapped to the intersection of the adjacent LONG arm
 * with the cap-chord line (the twin corners share one edge, so the whole group
 * interior is that edge's evidence; displacement is capped at snapMax so a bad
 * line can never carry a corner out of tolerance). Unclassified groups keep
 * their detector apexes untouched.
 */
// Calibration (swept one-at-a-time on the real pipeline against bar-caps +
// gear-teeth + sharp-star + checker + cross-bars + hairlines, 2026-07-28):
// every ±1-notch variation of these is measured IDENTICAL on the whole
// watchlist — the values sit on a plateau — except CAP_EXTEND_DEV, whose sweep
// bounds are real: 1.0 costs bar-caps chamfer (0.14 → 0.16), 1.4 starts eating
// gear-teeth corners (51 → 49/60). Only chordMax 0 (resolver OFF) reverts the
// bar-caps failure (43/43 → 30/43).
/** Arms must be ANTI-PARALLEL within this (deg): a butt cap U-turns (~180°). */
const CAP_ANTIPARALLEL_DEG = 150
const CAP_CHORD_MIN = 3
const CAP_CHORD_MAX = 10
/** Max perp deviation (px) of the A..B interior from the A→B chord — what makes
 *  a cap a cap and a star-tip V a tip. */
const CAP_FLAT = 1.3
const CAP_JOIN_GAP = 6
const CAP_SNAP_MAX = 2.5
/** Arm seed starts this many steps OUTSIDE the group center… */
const CAP_ARM_K = 10
/** …and spans this many vertices. Both sides must be straight (collinear). */
const CAP_ARM_SEED = 6
/** Arm-extension tolerance (px). Looser than SNAP_COLLINEAR: an AA edge at a
 *  half-pixel phase CHATTERS ±1px around its mean line (the isophote sits
 *  between two pixel columns), which is noise, not a corner — while the cap
 *  turn deviates 2px+ and still stops the extension. */
const CAP_EXTEND_DEV = 1.2

interface ResolvedCaps {
  /** Revised corner list (raw pts indices, ascending). */
  corners: number[]
  /** Corner index c (a pts index) such that the arc c → next corner is a cap. */
  capStarts: Set<number>
}

export function resolveLoopCaps(pts: Vec[], corners: number[], turnDeg: number, win = CORNER_WINDOW, read?: TurnRead): ResolvedCaps {
  const n = pts.length
  const none = (): ResolvedCaps => ({ corners, capStarts: new Set() })
  if (corners.length < 1 || turnDeg >= 180 || n < 2 * win + 1) return none()
  const wrap = (i: number): number => ((i % n) + n) % n
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  // The SAME reading the detector used, deliberately: a group here is a run of `sharp`
  // vertices, and a corner that falls in no group is DROPPED below. Leaving this on the
  // chord while the detector reads evidence would silently discard exactly the corners
  // §22 exists to recover.
  const cos = readTurnCos(pts, true, win, 0, n, turnDeg, read)
  const sharp = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (cos[i] < thr) sharp[i] = 1
  // Maximal cyclic runs of sub-threshold vertices, in loop order.
  const runs: { s: number; e: number }[] = []
  const seen = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    if (!sharp[i] || seen[i]) continue
    let s = i
    while (sharp[wrap(s - 1)] && wrap(s - 1) !== i) s = wrap(s - 1)
    let e = s
    let len = 1
    seen[s] = 1
    while (sharp[wrap(e + 1)] && wrap(e + 1) !== s) {
      e = wrap(e + 1)
      seen[e] = 1
      len++
      if (len >= n) break
    }
    runs.push({ s, e })
  }
  if (runs.length === 0) return none()
  runs.sort((a, b) => a.s - b.s)
  // Join runs across gaps ≤ joinGap into GROUPS (cyclic — the last may wrap onto
  // the first). A group is one candidate feature: a cap's two shoulder runs, or a
  // fused cap run, or an ordinary lone corner cluster.
  const gap = (a: { e: number }, b: { s: number }): number => wrap(b.s - a.e) - 1
  const groups: { s: number; e: number }[] = []
  let cur = { ...runs[0] }
  for (let k = 1; k < runs.length; k++) {
    if (gap(cur, runs[k]) <= CAP_JOIN_GAP) cur.e = runs[k].e
    else {
      groups.push(cur)
      cur = { ...runs[k] }
    }
  }
  groups.push(cur)
  if (groups.length >= 2 && gap(groups[groups.length - 1], groups[0]) <= CAP_JOIN_GAP) {
    groups[0].s = groups[groups.length - 1].s
    groups.pop()
  }

  const out: number[] = []
  const capStarts = new Set<number>()
  const arcLen = (s: number, e: number): number => wrap(e - s) + 1
  const inGroup = (g: { s: number; e: number }, i: number): boolean => wrap(i - g.s) <= wrap(g.e - g.s)
  // One arm of the cap hypothesis: seed a line fit `armK` steps OUTSIDE the group
  // center (on the long edge, well clear of the confusion zone), then extend it
  // INWARD while collinear — the extension stops at the true corner. Returns the
  // stop vertex + the travel-oriented arm direction, or null when the seed itself
  // is not straight (a checker cell / gear tooth wraps other corners into the
  // seed window and fails here — exactly the art this resolver must not touch).
  const findArm = (m: number, sign: -1 | 1): { stop: number; dir: Vec } | null => {
    const seed: Vec[] = []
    for (let o = CAP_ARM_K + CAP_ARM_SEED - 1; o >= CAP_ARM_K; o--) seed.push(pts[wrap(m + sign * o)])
    let line = armLine(seed)
    for (const p of seed) {
      const dev = Math.abs((p.x - line.c.x) * line.d.y - (p.y - line.c.y) * line.d.x)
      if (dev > SNAP_COLLINEAR) return null
    }
    // Extend inward RE-FITTING the line as each vertex joins (the snapCornerToArms
    // collect trick): a fixed seed slope is step-phase noise on a low-angle
    // staircase and would stop treads early; the refit converges on the true edge
    // and the stop lands at the corner.
    let stop = wrap(m + sign * CAP_ARM_K)
    const acc = seed.slice()
    for (let o = CAP_ARM_K - 1; o >= 0; o--) {
      const i = wrap(m + sign * o)
      const dev = Math.abs((pts[i].x - line.c.x) * line.d.y - (pts[i].y - line.c.y) * line.d.x)
      if (dev > CAP_EXTEND_DEV) break
      acc.push(pts[i])
      line = armLine(acc)
      stop = i
    }
    // Orient the fitted direction ALONG TRAVEL (ascending index order).
    const a = pts[wrap(m + sign * (CAP_ARM_K + CAP_ARM_SEED - 1))]
    const b = pts[wrap(m + sign * CAP_ARM_K)]
    const travel = sign === -1 ? sub(b, a) : sub(a, b)
    const d = travel.x * line.d.x + travel.y * line.d.y >= 0 ? line.d : neg(line.d)
    return { stop, dir: d }
  }
  for (const g of groups) {
    const members = corners.filter((c) => inGroup(g, c))
    const span = arcLen(g.s, g.e)
    // Classification — see the header comment. All evidence-gated; any failure
    // leaves the group's detector apexes exactly as they were.
    let cap: { a: number; b: number } | null = null
    if (span <= 24 && span < n - 2 * (CAP_ARM_K + CAP_ARM_SEED)) {
      const m = wrap(g.s + (span >> 1))
      const armIn = findArm(m, -1)
      const armOut = findArm(m, 1)
      if (armIn && armOut && armIn.stop !== armOut.stop) {
        const A = armIn.stop
        const B = armOut.stop
        const chord = dist(pts[A], pts[B])
        const cosT = armIn.dir.x * armOut.dir.x + armIn.dir.y * armOut.dir.y
        const uturn = (Math.acos(Math.max(-1, Math.min(1, cosT))) * 180) / Math.PI
        if (chord >= CAP_CHORD_MIN && chord <= CAP_CHORD_MAX && uturn >= CAP_ANTIPARALLEL_DEG) {
          let maxDev = 0
          for (let i = A; i !== B; i = wrap(i + 1)) maxDev = Math.max(maxDev, perpDistance(pts[i], pts[A], pts[B]))
          if (maxDev <= CAP_FLAT) cap = { a: A, b: B }
        }
      }
    }
    if (cap) {
      out.push(cap.a, cap.b)
      capStarts.add(cap.a)
    } else out.push(...members)
  }
  out.sort((a, b) => a - b)
  // Dedup (a group end could coincide with a member of a neighbouring group).
  const dedup: number[] = []
  for (const c of out) if (dedup[dedup.length - 1] !== c) dedup.push(c)
  return { corners: dedup, capStarts }
}

/** Least-squares line through the INTERIOR staircase vertices of a cap arc (its
 *  two corners excluded — they sit on the shoulder rounding). Falls back to the
 *  corner-to-corner chord when the interior is too short to fit. */
function capChordLine(pts: Vec[], cIn: number, cOut: number): { c: Vec; d: Vec } {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const interior: Vec[] = []
  for (let i = wrap(cIn + 1); i !== cOut; i = wrap(i + 1)) interior.push(pts[i])
  if (interior.length >= 2) return armLine(interior)
  const d = unit(sub(pts[cOut], pts[cIn]))
  return { c: { x: pts[cIn].x, y: pts[cIn].y }, d }
}

/** Snap one cap corner to the intersection of its LONG arm's fitted line with the
 *  shared cap-chord line. `sign` −1 ⇒ the long arm precedes the corner (an arc
 *  ENDS at this cap), +1 ⇒ it follows (an arc STARTS here). Falls back to the raw
 *  lattice vertex when the arm is degenerate or the intersection runs away. */
function snapCapCorner(pts: Vec[], c: number, sign: -1 | 1, toLong: number, capLine: { c: Vec; d: Vec }, snapMax: number): Vec {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const gapN = armGap(toLong)
  const span = Math.min(SNAP_SPAN, Math.max(gapN + 1, toLong - 1))
  const arm: Vec[] = []
  for (let o = gapN; o <= span; o++) arm.push(pts[wrap(c + sign * o)])
  if (arm.length < 2) return { x: pts[c].x, y: pts[c].y }
  const a = armLine(arm)
  const det = a.d.x * -capLine.d.y - a.d.y * -capLine.d.x
  if (Math.abs(det) < 1e-6) return { x: pts[c].x, y: pts[c].y }
  const rx = capLine.c.x - a.c.x
  const ry = capLine.c.y - a.c.y
  const t = (rx * -capLine.d.y - ry * -capLine.d.x) / det
  const ix = a.c.x + t * a.d.x
  const iy = a.c.y + t * a.d.y
  if (dist({ x: ix, y: iy }, pts[c]) > snapMax) return { x: pts[c].x, y: pts[c].y }
  return { x: ix, y: iy }
}

/**
 * Fit a closed loop that has sharp corners without beveling them: snap each corner
 * to its sub-pixel arm intersection, split the raw staircase at the corners, and
 * fit each arc as an open arc pinned at the snapped corners (so the arm staircase
 * still melts but the corners stay exact). Stitch the arcs into one closed node
 * list, each corner a single hard node. Falls back to `fitLoopEdge` if the corners
 * collapse to fewer than two distinct points.
 *
 * Cap arcs (resolveLoopCaps) are the exception to arc fitting: a classified cap
 * is emitted as a straight LINE between its two snapped corners — the evidence
 * says it IS a line, and a cubic fitted over ≤7 ragged points bends its end
 * tangents enough to read a true 90° corner as 45° (§0 #6b, capDiag).
 */
/** Max rotation (deg) the §15 tangent pin may apply to an apex handle. Beyond this the
 *  arm-line and the fitted tangent genuinely disagree — a curved arm — and the line is
 *  not the boundary's tangent, so pinning would flatten real curvature at the corner. */
const PIN_ROTATE_MAX_DEG = 30

/**
 * …and the same rule stated in the units the CURVE feels (§15.8, issue #11). An angle cap
 * alone bounds the wrong quantity: rotating a handle moves the curve in proportion to the
 * handle's LENGTH, so the same 29° that is a harmless nudge on a 2px handle swings a 26px
 * one 13px sideways. That is what closed the counter of a script 'a' on the reported
 * witness — an arm line measured over 10px of boundary, extrapolated onto a handle steering
 * 34px of curve.
 *
 * The pin exists to correct a TANGENT, so bound its side effect by the fit's own tolerance:
 * moving one cubic control point by d moves the curve by at most max{3t(1−t)²} = 4/9 of d,
 * and a correction that moves the curve further than ε is no longer a tangent correction —
 * it is a re-fit onto evidence the fit itself rejected. Derived, not calibrated: measured
 * over tier 0 + the gallery witnesses (703 applied pins, src/devtest/pinDiag.ts), 99% move
 * the control point < 2.0px and the whole tier-0 corpus stays under 1.9px, so this bound is
 * inert on the population it was NOT aimed at, and the witness's 13.1px is 5.8× outside it.
 */
const PIN_CURVE_BASIS = 4 / 9

/** One tangent-pin candidate, for the histogram behind any change to the pin's gate
 *  (`src/devtest/pinDiag.ts`). Observational only — attaching a sink never changes the
 *  fit. See PlanarFitOptions.pinDiag. */
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
 *  keeping its length. `hIn` sits BEHIND the apex along the incoming direction; `hOut`
 *  AHEAD along the outgoing one. No-op on absent handles, past PIN_ROTATE_MAX, and past the
 *  curve-displacement bound (PIN_CURVE_BASIS). */
function pinHandle(node: PathNode, which: 'hIn' | 'hOut', arm: ArmFit, eps: number, diag?: PinDiag): void {
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
  // What the rotation does to the control point (the chord of the rotation), and through it
  // to the curve. Both caps: the angle says the arm line disagrees with the fit; the curve
  // displacement says the disagreement is big enough to matter at this handle's reach.
  const shift = 2 * len * Math.sin((rotDeg * Math.PI) / 360)
  const applied = cos >= Math.cos((PIN_ROTATE_MAX_DEG * Math.PI) / 180) && PIN_CURVE_BASIS * shift <= eps
  diag?.({ x: node.x, y: node.y, side: which === 'hIn' ? 'in' : 'out', rotDeg, bow: arm.bow, chord: arm.chord, n: arm.n, handle: len, applied })
  if (!applied) return
  node[which] = { x: node.x + len * sx, y: node.y + len * sy }
}

export function fitCorneredLoop(pts: Vec[], corners: number[], opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const resolved = resolveLoopCaps(pts, corners.slice().sort((a, b) => a - b), opts.cornerTurnDeg, opts.cornerWindow ?? CORNER_WINDOW, turnReadOf(opts))
  const snapSpan = opts.snapSpan ?? SNAP_SPAN
  const gapOf = (steps: number): number => opts.armGapFixed ?? armGap(steps)
  // Diagnostic only (issue #36): a cap-resolved corner is placed by the resolver, not the
  // apex snap, and the census still needs a record for it.
  const capRecord = (c: number, p: Vec, toPrev: number, toNext: number): void => {
    if (!opts.apexDiag) return
    opts.apexDiag({
      cx: pts[c].x, cy: pts[c].y, ax: p.x, ay: p.y, moved: dist(p, pts[c]), outcome: 'cap', allow: CAP_SNAP_MAX,
      inSpan: Math.min(snapSpan, Math.max(gapOf(toPrev) + 1, toPrev - 1)), outSpan: Math.min(snapSpan, Math.max(gapOf(toNext) + 1, toNext - 1)),
      inGap: gapOf(toPrev), outGap: gapOf(toNext), hx: NaN, hy: NaN,
      inBow: -1, outBow: -1, inChord: -1, outChord: -1, inN: -1, outN: -1, tipDeg: -1, reach: -1, inKind: 'line', outKind: 'line',
    })
  }
  const C = resolved.corners
  // Cap pairing BEFORE the coincident-drop below: start → its twin (the next
  // corner). A pair whose members don't both survive the drop reverts to normal.
  const capPartner = new Map<number, number>()
  const capLineOf = new Map<number, { c: Vec; d: Vec }>()
  for (const s of resolved.capStarts) {
    const k = C.indexOf(s)
    const partner = C[(k + 1) % C.length]
    capPartner.set(s, partner)
    capLineOf.set(s, capChordLine(pts, s, partner))
  }
  // Loop orientation for the §19 concavity read (signed shoelace area; y-down).
  let area2 = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    area2 += p.x * q.y - q.x * p.y
  }
  const winding = area2 > 0 ? 1 : area2 < 0 ? -1 : 0
  // Snap each corner, capping arm samples to the gap to its neighbour corners.
  // Arm DIRECTIONS ride along for the §15 tangent pin (null wherever the snap fell
  // back to the lattice or the corner is cap-resolved — those get no pin).
  const armDirsAll: ({ inArm: ArmFit | null; outArm: ArmFit | null } | null)[] = []
  const snappedAll: Vec[] = C.map((c, k) => {
    const prev = C[(k - 1 + C.length) % C.length]
    const next = C[(k + 1) % C.length]
    const toPrev = wrap(c - prev)
    const toNext = wrap(next - c)
    // Cap corners: intersection of the LONG arm with the shared cap-chord line
    // (snapCapCorner). The long arm is on the non-cap side.
    if (capPartner.has(c)) {
      armDirsAll.push(null)
      const p = snapCapCorner(pts, c, -1, toPrev, capLineOf.get(c)!, CAP_SNAP_MAX)
      capRecord(c, p, toPrev, toNext)
      return p
    }
    if (capPartner.get(prev) === c) {
      armDirsAll.push(null)
      const p = snapCapCorner(pts, c, 1, toNext, capLineOf.get(prev)!, CAP_SNAP_MAX)
      capRecord(c, p, toPrev, toNext)
      return p
    }
    const inGap = gapOf(toPrev)
    const outGap = gapOf(toNext)
    const inSpan = Math.min(snapSpan, Math.max(inGap + 1, toPrev - 1))
    const outSpan = Math.min(snapSpan, Math.max(outGap + 1, toNext - 1))
    // Collinear straight arms may grow their evidence window up to SNAP_SPAN_MAX,
    // still never past the neighbouring corner.
    const inMax = Math.min(SNAP_SPAN_MAX, Math.max(inGap + 1, toPrev - 1))
    const outMax = Math.min(SNAP_SPAN_MAX, Math.max(outGap + 1, toNext - 1))
    const full = snapApex(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts, winding)
    armDirsAll.push({ inArm: full.inArm, outArm: full.outArm })
    return full.p
  })
  // Drop corners whose snapped point coincides with the previous (a shoulder pair
  // that both resolved onto the same apex) — incl. the cyclic first/last pair.
  const idx: number[] = []
  const snap: Vec[] = []
  const armDirs: ({ inArm: ArmFit | null; outArm: ArmFit | null } | null)[] = []
  for (let k = 0; k < C.length; k++) {
    const last = snap[snap.length - 1]
    if (last && dist(last, snappedAll[k]) < 1) continue
    idx.push(C[k])
    snap.push(snappedAll[k])
    armDirs.push(armDirsAll[k])
  }
  if (snap.length >= 2 && dist(snap[0], snap[snap.length - 1]) < 1) {
    idx.pop()
    snap.pop()
    armDirs.pop()
  }
  if (idx.length < 2) return fitLoopEdge(presmooth(pts, opts.smoothPasses, false), opts)
  // A cap arc is line-pinned only while its start and twin are still ADJACENT
  // survivors — a drop that touched either reverts the pair to a normal arc.
  const capStarts = new Set<number>()
  for (const [s, partner] of capPartner) {
    const k = idx.indexOf(s)
    if (k >= 0 && idx[(k + 1) % idx.length] === partner) capStarts.add(s)
  }

  // Fit each arc between consecutive corners (snapped endpoints pinned & sharp).
  const arcs = idx.length
  const fitted: PathNode[][] = []
  for (let k = 0; k < arcs; k++) {
    const a = idx[k]
    const b = idx[(k + 1) % arcs]
    if (capStarts.has(a)) {
      // Classified cap: a straight line between the two snapped corners. The
      // group interior IS this line's evidence (capChordLine), and a cubic over
      // ≤7 ragged points would wobble its end tangents (§0 #6b).
      const A = snap[k]
      const B = snap[(k + 1) % arcs]
      fitted.push([
        { x: A.x, y: A.y, hIn: null, hOut: null, kind: 'corner' },
        { x: B.x, y: B.y, hIn: null, hOut: null, kind: 'corner' },
      ])
      continue
    }
    const arc: Vec[] = []
    let i = a
    while (true) {
      arc.push({ x: pts[i].x, y: pts[i].y })
      if (i === b) break
      i = wrap(i + 1)
    }
    // Censor the cap remnants before pinning: the gap staircase points nearest
    // each corner are the rounded/eroded part — the exact points snapCornerToArms
    // skips when placing the apex. Left in, they sit laterally OFF the apex→arm
    // line (an eroded shallow tip keeps a 1px plateau there), so the fit chases
    // them and arrives at the snapped corner from the wrong side — sharp-star's
    // right tip rendered as an S-hook with an extra node. The trim mirrors the
    // scale-aware armGap (a short arc's snap kept its near-corner evidence, so
    // the arc fit keeps it too), and only while ≥ 2 interior points survive so
    // short arcs (a small checker cell edge) keep their evidence.
    const trim = Math.min(gapOf(arc.length - 1), Math.max(0, (arc.length - 4) >> 1))
    const kept = arc.slice(trim, arc.length - trim)
    kept[0] = { x: snap[k].x, y: snap[k].y }
    kept[kept.length - 1] = { x: snap[(k + 1) % arcs].x, y: snap[(k + 1) % arcs].y }
    fitted.push(fitOpenArc(presmooth(kept, arcSmoothPasses(opts.smoothPasses, kept.length), true), opts))
  }

  // §15 TANGENT PIN (pinCornerTangents — set only for sub-pixel displaced chains).
  // Rotate each apex-adjacent HANDLE onto its fitted arm-line direction, keeping the
  // handle's length and the apex position. The arc fit's end tangent is free within ε,
  // and on a displaced (genuinely smooth) chain it rotates toward the bisector — the
  // corner survives as a node but its measured turn softens below the 60° sharp bar
  // (chupa-chups: authored 91°, lattice fit 77°, displaced 51°). The arm line is the
  // same evidence the apex POSITION already trusts. ROTATE_MAX caps the correction:
  // a larger disagreement means the arm is genuinely curved and the line is not its
  // tangent — leave the fit alone there.
  if (opts.pinCornerTangents) {
    for (let k = 0; k < arcs; k++) {
      const dirs = armDirs[k]
      if (!dirs) continue
      const arriving = fitted[(k - 1 + arcs) % arcs]
      const leaving = fitted[k]
      if (dirs.inArm && arriving.length >= 2) pinHandle(arriving[arriving.length - 1], 'hIn', dirs.inArm, opts.epsilon, opts.pinDiag)
      if (dirs.outArm && leaving.length >= 2) pinHandle(leaving[0], 'hOut', dirs.outArm, opts.epsilon, opts.pinDiag)
    }
  }

  // Stitch into a closed node list: each shared corner is one node carrying the
  // arriving arc's hIn and the leaving arc's hOut, tagged corner.
  const out: PathNode[] = []
  for (let k = 0; k < arcs; k++) {
    const cur = fitted[k]
    if (cur.length < 2) continue
    const start = cur[0]
    const prev = out[out.length - 1]
    if (prev) prev.hOut = start.hOut ? { x: start.hOut.x, y: start.hOut.y } : null
    else out.push({ x: start.x, y: start.y, hIn: null, hOut: start.hOut ? { x: start.hOut.x, y: start.hOut.y } : null, kind: 'corner' })
    for (let j = 1; j < cur.length - 1; j++) out.push(cur[j])
    const last = cur[cur.length - 1]
    if (k === arcs - 1) out[0].hIn = last.hIn ? { x: last.hIn.x, y: last.hIn.y } : null
    else out.push({ x: last.x, y: last.y, hIn: last.hIn ? { x: last.hIn.x, y: last.hIn.y } : null, hOut: null, kind: 'corner' })
  }
  return out.length >= 2 ? out : fitLoopEdge(presmooth(pts, opts.smoothPasses, false), opts)
}

/**
 * Indices of the sharp corners INTERIOR to an OPEN staircase polyline — ONE per
 * corner. `detectLoopCorners` with the cyclic wrap replaced by clamped windows:
 * each cluster of sub-threshold vertices collapses to its geometric apex (max
 * perp deviation from the window chord) and apexes within `mergeDist` px fuse,
 * so a vertex's two staircase shoulders never yield two corners. The endpoint
 * regions (± `win`, junction anchors) are excluded, as in `detectCorners`.
 */
export function detectOpenCorners(pts: Vec[], turnDeg: number, win = CORNER_WINDOW, mergeDist = CORNER_MERGE, read?: TurnRead): number[] {
  const n = pts.length
  if (turnDeg >= 180 || n < 2 * win + 1) return []
  const thr = Math.cos((turnDeg * Math.PI) / 180)
  const lo = win
  const hi = n - win
  const cos = readTurnCos(pts, false, win, lo, hi, turnDeg, read)
  const apexes: number[] = []
  for (let s = lo; s < hi; s++) {
    if (cos[s] >= thr) continue
    let best = s
    let bestDev = -1
    let i = s
    while (i < hi && cos[i] < thr) {
      const dev = perpDistance(pts[i], pts[Math.max(0, i - win)], pts[Math.min(n - 1, i + win)])
      if (dev > bestDev) {
        bestDev = dev
        best = i
      }
      i++
    }
    apexes.push(best)
    s = i // resume after the cluster (loop's s++ steps past it)
  }
  // Fuse near-coincident apexes (consecutive; keep the first, as the loop does).
  const merged: number[] = []
  for (const a of apexes) {
    const last = merged[merged.length - 1]
    if (last !== undefined && dist(pts[a], pts[last]) <= mergeDist) continue
    merged.push(a)
  }
  return merged
}

/**
 * Open-edge counterpart of `fitCorneredLoop`: sharp corners INTERIOR to a
 * junction→junction edge get the same sub-pixel arm snap + cap-trim. Without
 * this, an outline tip that a junction happened to split onto an open edge (the
 * gradient-flat triangle apex — its left arm crosses the white circle) kept its
 * raw pinned lattice vertex, and the DP fit around the AA-eroded cap remnants —
 * arriving from the wrong side as a short hook with an extra smooth node, the
 * exact pathology the cap-trim note in fitCorneredLoop describes. Differences
 * from the loop version, both forced by openness:
 *   • arm windows CLAMP at the endpoints instead of wrapping;
 *   • the edge's own endpoints are never snapped and never trimmed — they are
 *     junction anchors that must stay byte-coincident with sibling edges.
 */
export function fitCorneredOpen(pts: Vec[], pinned: ReadonlySet<number>, opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const fallback = (): PathNode[] => fitOpenArc(presmooth(pts, opts.smoothPasses, true, pinned), opts)
  // Clustered corners (one per feature, like the loop path) — the raw `pinned`
  // set has BOTH staircase shoulders of a vertex, which must not become two
  // breakpoints (a 2-node chamfer where the art has one corner).
  let C = detectOpenCorners(pts, opts.cornerTurnDeg, opts.cornerWindow ?? CORNER_WINDOW, opts.cornerMerge ?? CORNER_MERGE, turnReadOf(opts))
  if (n < 2 * SNAP_GAP + 3) return fallback()
  const snapSpan = opts.snapSpan ?? SNAP_SPAN
  const gapOf = (steps: number): number => opts.armGapFixed ?? armGap(steps)

  // Prune-and-refit loop: a detected corner whose FITTED junction comes out
  // nearly straight was a local staircase jog (e.g. the boundary bending into a
  // junction's AA neighbourhood), not a real corner — forcing a hard breakpoint
  // there asserts geometry the art doesn't have. Detection can't tell (the ±win
  // raw turn IS above threshold); the fit can. Each pass drops the weak
  // breakpoints and refits without them; terminates because C strictly shrinks.
  for (;;) {
    if (C.length === 0) return fallback()

    const armDirsAll: { inArm: ArmFit | null; outArm: ArmFit | null }[] = []
    const snappedAll: Vec[] = C.map((c, k) => {
      const toPrev = c - (k > 0 ? C[k - 1] : 0)
      const toNext = (k < C.length - 1 ? C[k + 1] : n - 1) - c
      const inGap = gapOf(toPrev)
      const outGap = gapOf(toNext)
      // Same spans as the loop version, additionally clamped so no window index
      // leaves [0, n-1] (open: there is nothing to wrap onto).
      const inSpan = Math.min(snapSpan, Math.max(inGap + 1, toPrev - 1), c)
      const outSpan = Math.min(snapSpan, Math.max(outGap + 1, toNext - 1), n - 1 - c)
      const inMax = Math.min(SNAP_SPAN_MAX, Math.max(inGap + 1, toPrev - 1), c)
      const outMax = Math.min(SNAP_SPAN_MAX, Math.max(outGap + 1, toNext - 1), n - 1 - c)
      const full = snapApex(pts, c, inGap, outGap, inSpan, outSpan, inMax, outMax, opts)
      armDirsAll.push({ inArm: full.inArm, outArm: full.outArm })
      return full.p
    })
    // Drop corners whose snap collapsed onto the previous breakpoint or an endpoint.
    const idx: number[] = []
    const snap: Vec[] = []
    const armDirs: { inArm: ArmFit | null; outArm: ArmFit | null }[] = []
    for (let k = 0; k < C.length; k++) {
      const prevPin = snap[snap.length - 1] ?? pts[0]
      if (dist(prevPin, snappedAll[k]) < 1 || dist(pts[n - 1], snappedAll[k]) < 1) continue
      idx.push(C[k])
      snap.push(snappedAll[k])
      armDirs.push(armDirsAll[k])
    }
    if (idx.length === 0) return fallback()

    // Fit each piece between consecutive breakpoints. Corner ends are cap-trimmed
    // (censor the SNAP_GAP eroded points, as in fitCorneredLoop) and pinned to the
    // snapped apex; endpoint ends keep the exact junction anchor untrimmed.
    const bounds = [0, ...idx, n - 1]
    const pins: Vec[] = [pts[0], ...snap, pts[n - 1]]
    const fitted: PathNode[][] = []
    for (let k = 0; k + 1 < bounds.length; k++) {
      const piece = pts.slice(bounds[k], bounds[k + 1] + 1)
      const pieceGap = gapOf(piece.length - 1)
      let trimS = k > 0 ? pieceGap : 0
      let trimE = k + 1 < bounds.length - 1 ? pieceGap : 0
      // Trim only while ≥ 2 interior points survive (short pieces keep evidence).
      while (trimS + trimE > Math.max(0, piece.length - 4)) {
        if (trimE >= trimS && trimE > 0) trimE--
        else if (trimS > 0) trimS--
        else break
      }
      const kept = piece.slice(trimS, piece.length - trimE).map((p) => ({ x: p.x, y: p.y }))
      kept[0] = { x: pins[k].x, y: pins[k].y }
      kept[kept.length - 1] = { x: pins[k + 1].x, y: pins[k + 1].y }
      fitted.push(fitOpenArc(presmooth(kept, arcSmoothPasses(opts.smoothPasses, kept.length), true), opts))
    }

    // §15 TANGENT PIN — same as fitCorneredLoop's, and doubly load-bearing here: the
    // weak-turn prune below reads these very tangents to decide whether a corner is
    // REAL, so a displaced chain's softened tangents would get a genuine corner
    // pruned outright, not just rounded.
    if (opts.pinCornerTangents) {
      for (let k = 0; k < idx.length; k++) {
        const dirs = armDirs[k]
        if (!dirs) continue
        const arriving = fitted[k]
        const leaving = fitted[k + 1]
        if (dirs.inArm && arriving.length >= 2) pinHandle(arriving[arriving.length - 1], 'hIn', dirs.inArm, opts.epsilon, opts.pinDiag)
        if (dirs.outArm && leaving && leaving.length >= 2) pinHandle(leaving[0], 'hOut', dirs.outArm, opts.epsilon, opts.pinDiag)
      }
    }

    // Stitch: each interior breakpoint is ONE hard node — arriving hIn, leaving
    // hOut — remembering where each landed for the weak-turn check below.
    const out: PathNode[] = []
    const jointAt: number[] = [] // out[] index of breakpoint k (parallel to idx)
    let ok = true
    for (const cur of fitted) {
      if (cur.length < 2) {
        ok = false
        break
      }
      if (out.length === 0) {
        for (const nd of cur) out.push({ x: nd.x, y: nd.y, hIn: nd.hIn ? { ...nd.hIn } : null, hOut: nd.hOut ? { ...nd.hOut } : null, kind: nd.kind })
      } else {
        const joint = out[out.length - 1]
        jointAt.push(out.length - 1)
        joint.hOut = cur[0].hOut ? { x: cur[0].hOut.x, y: cur[0].hOut.y } : null
        joint.kind = 'corner'
        for (let j = 1; j < cur.length; j++) {
          const nd = cur[j]
          out.push({ x: nd.x, y: nd.y, hIn: nd.hIn ? { ...nd.hIn } : null, hOut: nd.hOut ? { ...nd.hOut } : null, kind: nd.kind })
        }
      }
    }
    if (!ok || out.length < 2) return fallback()

    // Weak-turn prune: fitted tangents at each breakpoint. A real corner that
    // detection accepts turns ≥ cornerTurnDeg (70°); a jog fits nearly straight.
    const weak = new Set<number>()
    for (let k = 0; k < jointAt.length; k++) {
      const i = jointAt[k]
      const nd = out[i]
      const inFrom = nd.hIn ?? { x: out[i - 1].x, y: out[i - 1].y }
      const outTo = nd.hOut ?? { x: out[i + 1].x, y: out[i + 1].y }
      const a = unit(sub(nd, inFrom))
      const b = unit(sub(outTo, nd))
      const cosT = a.x * b.x + a.y * b.y
      if (cosT > COS_WEAK_CORNER) weak.add(idx[k])
    }
    if (weak.size === 0) return out
    C = C.filter((c) => !weak.has(c))
  }
}

/** Fitted-turn floor for an open-edge breakpoint (30°): well below any true
 *  detected corner (the detector's own floor is 60°), well above the ~3° of a
 *  smoothly absorbed jog. */
const COS_WEAK_CORNER = Math.cos((30 * Math.PI) / 180)

/**
 * Fit a pure closed-loop edge (no junction) reusing the crisp tracer's
 * `fitClosedLoop`. Returns closed-loop nodes, or a coarse fallback.
 */
export function fitLoopEdge(densePts: Vec[], opts: PlanarFitOptions): PathNode[] {
  const fitOpts: CurveFitOptions = { epsilon: opts.epsilon, lineCost: opts.lineCost, cubicCost: opts.cubicCost }
  const nodes = fitClosedLoop(densePts, fitOpts)
  if (nodes && nodes.length >= 2) return nodes
  // Degenerate tiny loop: keep its dedup'd polygon as corners.
  const d = dedup(densePts)
  return d.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const }))
}
