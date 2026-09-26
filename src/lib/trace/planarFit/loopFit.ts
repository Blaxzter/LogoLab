// Closed-loop fitting: the cornered (anti-bevel) loop fit and the plain pure-loop fit.

import type { PathNode, Vec } from '../../path/types'
import { fitClosedLoop, type CurveFitOptions } from '../curveFit.ts'
import { snapApex } from './apex.ts'
import { SNAP_SPAN, SNAP_SPAN_MAX, armGap, type ArmFit } from './arms.ts'
import { CAP_SNAP_MAX, capChordLine, resolveLoopCaps, snapCapCorner } from './caps.ts'
import { CORNER_WINDOW } from './corners.ts'
import { dedup, dist, presmooth } from './geom.ts'
import { fitOpenArc } from './openFit.ts'
import type { PlanarFitOptions } from './options.ts'
import { pinHandle } from './pin.ts'

// --- sharp-corner closed-loop fitting (anti-bevel) --------------------------
// `detectCorners` + corner-pinned presmooth keep a sharp apex from being melted,
// but the closed-loop fitter (fitClosedLoop) still places its key vertices on the
// rounded staircase around a tip — two nodes straddling the apex with a short
// segment cutting across it (a visible bevel). For a loop with ≥2 genuine sharp
// corners we instead localize each corner to its sub-pixel apex (the intersection
// of its two arms), split the loop there, and fit each arc as an open arc pinned
// at the snapped corners, so every corner is one exact sharp node. Smooth loops
// have <2 corners and never take this path.

/**
 * Scale-aware smoothing for an inter-corner arc. presmooth exists to melt a long
 * staircase; a short arc between two snapped corners has almost none, and each pass
 * bends its few interior points inward, rotating the fitted end tangents until a real
 * joint reads below the corner bar. Full passes from 16 points up, one pass down to 9,
 * raw below.
 */
export function arcSmoothPasses(passes: number, arcLen: number): number {
  return arcLen >= 16 ? passes : arcLen >= 9 ? Math.min(passes, 1) : 0
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
 * is emitted as a straight line between its two snapped corners — a cubic fitted
 * over ≤7 ragged points bends its end tangents enough to read a true 90° corner
 * as 45°.
 */

export function fitCorneredLoop(pts: Vec[], corners: number[], opts: PlanarFitOptions): PathNode[] {
  const n = pts.length
  const wrap = (i: number): number => ((i % n) + n) % n
  const resolved = resolveLoopCaps(
    pts,
    corners.slice().sort((a, b) => a - b),
    opts.cornerTurnDeg,
    opts.cornerWindow ?? CORNER_WINDOW,
  )
  const snapSpan = opts.snapSpan ?? SNAP_SPAN
  const gapOf = (steps: number): number => opts.armGapFixed ?? armGap(steps)
  // Diagnostic only: a cap-resolved corner is placed by the resolver, not the apex snap,
  // but still gets a record.
  const capRecord = (c: number, p: Vec, toPrev: number, toNext: number): void => {
    if (!opts.apexDiag) return
    opts.apexDiag({
      cx: pts[c].x,
      cy: pts[c].y,
      ax: p.x,
      ay: p.y,
      moved: dist(p, pts[c]),
      outcome: 'cap',
      allow: CAP_SNAP_MAX,
      inSpan: Math.min(snapSpan, Math.max(gapOf(toPrev) + 1, toPrev - 1)),
      outSpan: Math.min(snapSpan, Math.max(gapOf(toNext) + 1, toNext - 1)),
      inGap: gapOf(toPrev),
      outGap: gapOf(toNext),
      hx: NaN,
      hy: NaN,
      inBow: -1,
      outBow: -1,
      inChord: -1,
      outChord: -1,
      inN: -1,
      outN: -1,
      tipDeg: -1,
      reach: -1,
      inKind: 'line',
      outKind: 'line',
    })
  }
  const C = resolved.corners
  // Cap pairing before the coincident-drop below: start → its twin (the next
  // corner). A pair whose members don't both survive the drop reverts to normal.
  const capPartner = new Map<number, number>()
  const capLineOf = new Map<number, { c: Vec; d: Vec }>()
  for (const s of resolved.capStarts) {
    const k = C.indexOf(s)
    const partner = C[(k + 1) % C.length]
    capPartner.set(s, partner)
    capLineOf.set(s, capChordLine(pts, s, partner))
  }
  // Loop orientation for the concavity test (signed shoelace area; y-down).
  let area2 = 0
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    area2 += p.x * q.y - q.x * p.y
  }
  const winding = area2 > 0 ? 1 : area2 < 0 ? -1 : 0
  // Snap each corner, capping arm samples to the gap to its neighbour corners.
  // Arm directions ride along for the tangent pin (null wherever the snap fell back
  // to the lattice or the corner is cap-resolved — those get no pin).
  const armDirsAll: ({ inArm: ArmFit | null; outArm: ArmFit | null } | null)[] = []
  const snappedAll: Vec[] = C.map((c, k) => {
    const prev = C[(k - 1 + C.length) % C.length]
    const next = C[(k + 1) % C.length]
    const toPrev = wrap(c - prev)
    const toNext = wrap(next - c)
    // Cap corners: intersection of the long arm with the shared cap-chord line
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
  // A cap arc is line-pinned only while its start and twin are still adjacent
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
      // group interior is this line's evidence (capChordLine), and a cubic over
      // ≤7 ragged points would wobble its end tangents.
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
    // Censor the cap remnants before pinning: the gap staircase points nearest each
    // corner are the rounded/eroded part the apex snap skips. Left in, they sit
    // laterally off the apex→arm line, so the fit chases them and arrives at the
    // snapped corner from the wrong side (an S-hook with an extra node). The trim
    // mirrors armGap, and only while ≥ 2 interior points survive so short arcs keep
    // their evidence.
    const trim = Math.min(gapOf(arc.length - 1), Math.max(0, (arc.length - 4) >> 1))
    const kept = arc.slice(trim, arc.length - trim)
    kept[0] = { x: snap[k].x, y: snap[k].y }
    kept[kept.length - 1] = { x: snap[(k + 1) % arcs].x, y: snap[(k + 1) % arcs].y }
    fitted.push(fitOpenArc(presmooth(kept, arcSmoothPasses(opts.smoothPasses, kept.length), true), opts))
  }

  // Tangent pin (pinCornerTangents — set only for sub-pixel displaced chains). Rotate
  // each apex-adjacent handle onto its fitted arm-line direction, keeping the handle's
  // length and the apex position. On a displaced chain the arc fit's end tangent rotates
  // toward the bisector and the corner's turn softens below the 60° sharp bar; the arm
  // line is the same evidence the apex position already trusts. pinHandle caps the
  // correction where the arm is genuinely curved.
  if (opts.pinCornerTangents) {
    for (let k = 0; k < arcs; k++) {
      const dirs = armDirs[k]
      if (!dirs) continue
      const arriving = fitted[(k - 1 + arcs) % arcs]
      const leaving = fitted[k]
      if (dirs.inArm && arriving.length >= 2)
        pinHandle(arriving[arriving.length - 1], 'hIn', dirs.inArm, opts.epsilon, opts.pinDiag)
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
    else
      out.push({
        x: start.x,
        y: start.y,
        hIn: null,
        hOut: start.hOut ? { x: start.hOut.x, y: start.hOut.y } : null,
        kind: 'corner',
      })
    for (let j = 1; j < cur.length - 1; j++) out.push(cur[j])
    const last = cur[cur.length - 1]
    if (k === arcs - 1) out[0].hIn = last.hIn ? { x: last.hIn.x, y: last.hIn.y } : null
    else
      out.push({
        x: last.x,
        y: last.y,
        hIn: last.hIn ? { x: last.hIn.x, y: last.hIn.y } : null,
        hOut: null,
        kind: 'corner',
      })
  }
  return out.length >= 2 ? out : fitLoopEdge(presmooth(pts, opts.smoothPasses, false), opts)
}

/**
 * Fit a pure closed-loop edge (no junction) with curveFit's `fitClosedLoop`.
 * Returns closed-loop nodes, or a coarse fallback.
 */
export function fitLoopEdge(densePts: Vec[], opts: PlanarFitOptions): PathNode[] {
  const fitOpts: CurveFitOptions = { epsilon: opts.epsilon, lineCost: opts.lineCost, cubicCost: opts.cubicCost }
  const nodes = fitClosedLoop(densePts, fitOpts)
  if (nodes && nodes.length >= 2) return nodes
  // Degenerate tiny loop: keep its dedup'd polygon as corners.
  const d = dedup(densePts)
  return d.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const }))
}
