// Two CONSTRUCTED cases where scale-relative fidelity (§10.1) demonstrably GREIFT —
// each isolates one of the two things it does that the shipped path does not.
//
//   node src/devtest/scaleRelDemo.ts
//
// DEMO 1 — SUBSTITUTION (veto OFF): a field of small SQUARES next to small CIRCLES.
//   Turn the §9.8 corner-turn veto off and the tracer's only guard is gone: every
//   square rounds to a blob. Scale-relative ε alone puts it back — squares kept
//   square, circles kept round — discriminating by SIZE, no turn test. This is the
//   §10 thesis (the veto is a special case of the scale gate) made visible.
//
// DEMO 2 — THE VETO'S BLIND SPOT (veto ON, the shipped default): a small FLAT ellipse.
//   Its turns are gentle (< 60°, so the veto is blind) and it is a hair too small for
//   the ellipse snap (min-axis < 2·fidelity), so the shipped tracer rounds it to a
//   perfect CIRCLE — a flat ellipse becomes a round dot. Scale-relative ε refuses,
//   because the ellipse sits > k·r from any circle. The veto cannot catch this;
//   scale can. (Narrow — sub-6px flat ellipses — which is why it ships default-off.)

import { tracePlanar } from '../lib/trace/planarAssemble.ts'
import { planarBeautify, type SnapOptions } from '../lib/trace/planarBeautify.ts'
import { DEFAULT_BEAUTIFY_OPTIONS } from '../lib/trace/beautify.ts'
import { flatten, fitCircle, maxRadialDev } from '../lib/trace/circleFit.ts'
import type { PathNode } from '../lib/path/types.ts'

const OPTS = { ...DEFAULT_BEAUTIFY_OPTIONS } // fidelity 1.5
const K = 0.15

const isRounded = (nodes: PathNode[]): boolean =>
  nodes.length >= 4 && nodes.every((n) => n.kind === 'smooth' && !!n.hIn && !!n.hOut)

/** Paint one filled shape of `label` into L (kind: 'square' half-side a, or 'circle' radius a). */
function paint(L: Int32Array, w: number, cx: number, cy: number, a: number, kind: 'square' | 'circle', label: number): void {
  for (let y = cy - a - 1; y <= cy + a + 1; y++)
    for (let x = cx - a - 1; x <= cx + a + 1; x++) {
      const inside = kind === 'square' ? Math.abs(x - cx) <= a && Math.abs(y - cy) <= a : (x - cx) ** 2 + (y - cy) ** 2 <= a * a
      if (inside) L[y * w + x] = label
    }
}

/** Beautify the trace under `snap` and return, per shape label, whether its loop rounded. */
function roundedByLabel(L: Int32Array, w: number, h: number, snap: SnapOptions): Map<number, boolean> {
  const trace = tracePlanar(L, w, h)
  const topo = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS, snap)
  const byId = new Map(topo.edges.map((e) => [e.id, e]))
  const out = new Map<number, boolean>()
  for (const [label, loops] of trace.loopsByLabel) {
    if (label <= 0 || loops.length !== 1 || loops[0].length !== 1) continue
    out.set(label, isRounded(byId.get(loops[0][0].edge)!.nodes))
  }
  return out
}

// ── DEMO 1 ────────────────────────────────────────────────────────────────────────
console.log('DEMO 1 — SUBSTITUTION: small squares + small circles, corner-turn veto OFF\n')
{
  const w = 200, h = 90
  const L = new Int32Array(w * h)
  let lab = 1
  const squares: number[] = []
  const circles: number[] = []
  for (let i = 0; i < 9; i++) {
    paint(L, w, 20 + i * 20, 25, 5, 'square', lab); squares.push(lab++)
  }
  for (let i = 0; i < 9; i++) {
    paint(L, w, 20 + i * 20, 65, 5, 'circle', lab); circles.push(lab++)
  }
  for (const [label, snap] of [
    ['veto OFF, k=0   (no guard at all)', { cornerVeto: false, localScaleK: 0 }],
    [`veto OFF, k=${K} (scale-relative only)`, { cornerVeto: false, localScaleK: K }],
  ] as [string, SnapOptions][]) {
    const r = roundedByLabel(L, w, h, snap)
    const sqRounded = squares.filter((s) => r.get(s)).length
    const ciRound = circles.filter((s) => r.get(s)).length
    console.log(
      `  ${label.padEnd(38)}  squares rounded-to-blob: ${sqRounded}/9 ${sqRounded === 0 ? '✓ kept square' : '✗ BUG'}` +
        `   ·   circles still round: ${ciRound}/9 ${ciRound === 9 ? '✓' : '✗'}`,
    )
  }
}

// ── DEMO 2 ────────────────────────────────────────────────────────────────────────
console.log('\nDEMO 2 — VETO BLIND SPOT: a small FLAT ellipse, corner-turn veto ON (shipped default)\n')
{
  const w = 40, h = 40, a = 5, ry = 0.55
  const L = new Int32Array(w * h)
  const cx = w / 2, cy = h / 2, b = a * ry
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 <= 1) L[y * w + x] = 1
  const trace = tracePlanar(L, w, h)
  const eid = trace.loopsByLabel.get(1)![0][0].edge
  const raw = flatten({ nodes: trace.edges.find((e) => e.id === eid)!.nodes, closed: true })
  const c = fitCircle(raw)!
  console.log(`  authored: a flat ellipse ~${2 * a}×${Math.round(2 * b)}px (ratio ${ry}); best-fit circle r=${c.r.toFixed(2)}, radial dev ${maxRadialDev(raw, c).toFixed(2)}px, k·r=${(K * c.r).toFixed(2)}px`)
  for (const [label, snap] of [
    ['shipped (veto ON, k=0)   ', { cornerVeto: true, localScaleK: 0 }],
    [`feature (veto ON, k=${K})`, { cornerVeto: true, localScaleK: K }],
  ] as [string, SnapOptions][]) {
    const topo = planarBeautify({ vertices: trace.vertices, edges: trace.edges }, trace.loopsByLabel, OPTS, snap)
    const rounded = isRounded(topo.edges.find((e) => e.id === eid)!.nodes)
    console.log(`  ${label}  →  ${rounded ? '✗ ROUNDED to a circle (a flat ellipse became a round dot)' : '✓ kept elliptical (shape preserved)'}`)
  }
}
