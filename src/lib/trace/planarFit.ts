// Edge fitting for the planar tracer: fit each PlanarEdge's lattice staircase
// polyline, once, to a low-node chain of lines and cubic Béziers. Junction
// endpoints are pinned (so the edges meeting there share an exact anchor) and
// forced to corner. Uses the numerics in curveFit.ts — `fitSingleCubic` (Schneider
// + Newton) and `lineFit` — wrapped in an open (acyclic) RDP + evidence-based corner
// score + linear DP that mirrors fitClosedLoop's recipe without its cyclic
// wraparound. Pure-loop edges use `fitClosedLoop` directly.
//
// A crack polyline has no smoothness of its own, so the interior is pre-smoothed
// (endpoints and detected corners pinned) to melt the 90° staircase, and the ε
// cubic-fit tolerance absorbs the residual. Sharp corners are then localized to
// their sub-pixel apex from the two arm lines and the chain is fitted as open arcs
// between them.
//
// Pure and deterministic (fixed iteration counts, no PRNG).
// Design notes and measurements: docs/vectorization-benchmarks.md.

// The implementation lives in ./planarFit/; this file is the public entry and re-exports
// exactly what the single-file module exported.
export { DEFAULT_PLANAR_FIT, FLAT_LINE_COST, type ApexReach, type PlanarFitOptions } from './planarFit/options.ts'
export { circleMaxDev, fitCircle, presmooth } from './planarFit/geom.ts'
export { detectCorners, detectLoopCorners, detectOpenCorners } from './planarFit/corners.ts'
export { fitOpenArc } from './planarFit/openFit.ts'
export { armLine, type ArmFit } from './planarFit/arms.ts'
export type { ApexDiag, ApexDiagRecord, ApexOutcome } from './planarFit/apex.ts'
export { discExplainsLoop } from './planarFit/disc.ts'
export { resolveLoopCaps } from './planarFit/caps.ts'
export type { PinDiag, PinDiagRecord } from './planarFit/pin.ts'
export { fitCorneredLoop, fitLoopEdge } from './planarFit/loopFit.ts'
export { fitCorneredOpen } from './planarFit/openCorneredFit.ts'
