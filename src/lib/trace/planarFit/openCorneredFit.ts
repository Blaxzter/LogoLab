// Open-edge cornered fitting: the arm snap + cap-trim on a junction→junction edge, with weak-turn pruning.

import type { PathNode, Vec } from '../../path/types'
import { snapApex } from './apex.ts'
import { SNAP_GAP, SNAP_SPAN, SNAP_SPAN_MAX, armGap, type ArmFit } from './arms.ts'
import { CORNER_MERGE, CORNER_WINDOW, detectOpenCorners } from './corners.ts'
import { dist, presmooth, sub, unit } from './geom.ts'
import { arcSmoothPasses } from './loopFit.ts'
import { fitOpenArc } from './openFit.ts'
import type { PlanarFitOptions } from './options.ts'
import { pinHandle } from './pin.ts'

/**
 * Open-edge counterpart of `fitCorneredLoop`: sharp corners interior to a
 * junction→junction edge get the same sub-pixel arm snap + cap-trim, so a tip that a
 * junction happened to split onto an open edge doesn't keep its raw lattice vertex
 * and hook around the eroded cap remnants. Differences from the loop version, both
 * forced by openness:
 *   • arm windows clamp at the endpoints instead of wrapping;
 *   • the edge's own endpoints are never snapped and never trimmed — they are
 *     junction anchors that must stay byte-coincident with sibling edges.
 */
export function fitCorneredOpen(pts: Vec[], pinned: ReadonlySet<number>, opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const fallback = (): PathNode[] => fitOpenArc(presmooth(pts, opts.smoothPasses, true, pinned), opts)
  // Clustered corners (one per feature, like the loop path) — the raw `pinned`
  // set has both staircase shoulders of a vertex, which must not become two
  // breakpoints (a 2-node chamfer where the art has one corner).
  let C = detectOpenCorners(pts, opts.cornerTurnDeg, opts.cornerWindow ?? CORNER_WINDOW, opts.cornerMerge ?? CORNER_MERGE)
  if (n < 2 * SNAP_GAP + 3) return fallback()
  const snapSpan = opts.snapSpan ?? SNAP_SPAN
  const gapOf = (steps: number): number => opts.armGapFixed ?? armGap(steps)

  // Prune-and-refit loop: a detected corner whose fitted junction comes out
  // nearly straight was a local staircase jog (e.g. the boundary bending into a
  // junction's AA neighbourhood), not a real corner — forcing a hard breakpoint
  // there asserts geometry the art doesn't have. Detection can't tell (the ±win
  // raw turn is above threshold); the fit can. Each pass drops the weak
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

    // Tangent pin, as in fitCorneredLoop. It matters more here: the weak-turn prune
    // below reads these tangents, so a displaced chain's softened tangents would get a
    // genuine corner pruned outright, not just rounded.
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

    // Stitch: each interior breakpoint is one hard node — arriving hIn, leaving
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
    // detection accepts turns ≥ cornerTurnDeg; a jog fits nearly straight.
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
