// §42 — rounded polygons (src/lib/trace/planarFit/fillet.ts). A closed loop that is nothing
// but straight runs joined by tangent arcs is emitted as exactly those lines and arcs.
//
// The outlines here are synthetic so the answer is exact: a radius is a number, a tangent
// node either carries the line's direction or it does not. Each test is one rule of the
// fit, and the refusals matter as much as the readings — every one of them is a false
// positive that was measured before the rule that stops it existed:
//   • a DISC's flat extremes certify as "runs" (the weak-run rule);
//   • a SECTOR's arc meets its lines at corners, not tangents (a weak run is never kept);
//   • a gap is read the SHORT way round unless the chain itself goes the long way;
//   • a corner under the radius floor stays SHARP, and a loop with no arc at all is not
//     this fit's business.
// The end-to-end gate is `round-polys` in test/truth-gate.test.ts.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitFilletLoop, type FilletDiagRecord } from '../src/lib/trace/planarFit.ts'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { planarBeautify } from '../src/lib/trace/planarBeautify.ts'
import { DEFAULT_BEAUTIFY_OPTIONS } from '../src/lib/trace/beautify.ts'
import type { PathNode, Vec } from '../src/lib/path/types.ts'

type P = [number, number]

/** A closed outline as chain points ~1px apart: a polygon with a tangent arc of radius
 *  `radii[i]` at vertex i (0 ⇒ sharp). `jitter` moves every point along the normal by a
 *  deterministic ±amount, which is what a measured sub-pixel chain looks like. */
function outline(pts: P[], radii: number[], jitter = 0.06): Vec[] {
  const n = pts.length
  const out: Vec[] = []
  let k = 0
  const push = (x: number, y: number, nx: number, ny: number): void => {
    const j = jitter * Math.sin(k++ * 1.7)
    out.push({ x: x + nx * j, y: y + ny * j })
  }
  const line = (ax: number, ay: number, bx: number, by: number): void => {
    const len = Math.hypot(bx - ax, by - ay)
    if (len < 1e-9) return
    const steps = Math.max(1, Math.round(len))
    for (let s = 0; s < steps; s++) {
      const t = s / steps
      push(ax + (bx - ax) * t, ay + (by - ay) * t, -(by - ay) / len, (bx - ax) / len)
    }
  }
  const ends: { tin: P; tout: P; c: P | null; r: number; a0: number; sweep: number }[] = []
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i - 1 + n) % n]
    const [vx, vy] = pts[i]
    const [qx, qy] = pts[(i + 1) % n]
    const li = Math.hypot(vx - px, vy - py)
    const lo = Math.hypot(qx - vx, qy - vy)
    const ux = (vx - px) / li
    const uy = (vy - py) / li
    const wx = (qx - vx) / lo
    const wy = (qy - vy) / lo
    const r = radii[i] ?? 0
    if (r <= 0) {
      ends.push({ tin: [vx, vy], tout: [vx, vy], c: null, r: 0, a0: 0, sweep: 0 })
      continue
    }
    const cross = ux * wy - uy * wx
    const turn = Math.acos(Math.max(-1, Math.min(1, ux * wx + uy * wy)))
    const t = r * Math.tan(turn / 2)
    const s = cross > 0 ? 1 : -1
    const tin: P = [vx - ux * t, vy - uy * t]
    const c: P = [tin[0] - s * uy * r, tin[1] + s * ux * r]
    ends.push({
      tin,
      tout: [vx + wx * t, vy + wy * t],
      c,
      r,
      a0: Math.atan2(tin[1] - c[1], tin[0] - c[0]),
      sweep: s * turn,
    })
  }
  for (let i = 0; i < n; i++) {
    const e = ends[i]
    if (e.c) {
      const steps = Math.max(2, Math.round(Math.abs(e.sweep) * e.r))
      for (let s = 0; s < steps; s++) {
        const a = e.a0 + (e.sweep * s) / steps
        push(e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a), Math.cos(a), Math.sin(a))
      }
    }
    const nx = ends[(i + 1) % n]
    line(e.tout[0], e.tout[1], nx.tin[0], nx.tin[1])
  }
  return out
}

const box = (cx: number, cy: number, w: number, h: number): P[] => [
  [cx - w / 2, cy - h / 2],
  [cx + w / 2, cy - h / 2],
  [cx + w / 2, cy + h / 2],
  [cx - w / 2, cy + h / 2],
]
const rot = (pts: P[], cx: number, cy: number, deg: number): P[] => {
  const a = (deg * Math.PI) / 180
  return pts.map(([x, y]) => [
    cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a),
    cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a),
  ])
}
const circle = (cx: number, cy: number, r: number, jitter = 0.06): Vec[] => {
  const steps = Math.round(2 * Math.PI * r)
  return Array.from({ length: steps }, (_, i) => {
    const a = (i * 2 * Math.PI) / steps
    const j = jitter * Math.sin(i * 1.7)
    return { x: cx + (r + j) * Math.cos(a), y: cy + (r + j) * Math.sin(a) }
  })
}
const all = (pts: Vec[]): Uint8Array => new Uint8Array(pts.length).fill(1)

/** Fit, and return the nodes with the diagnostic record. */
function fit(
  pts: Vec[],
  measured: Uint8Array | null = all(pts),
): { nodes: PathNode[] | null; rec: FilletDiagRecord | null } {
  let rec: FilletDiagRecord | null = null
  const nodes = fitFilletLoop(pts, measured, (r) => (rec = r))
  return { nodes, rec }
}

/** Tangent break at node i (deg): handle when there is one, else the chord. */
function breakAt(nodes: PathNode[], i: number): number {
  const n = nodes.length
  const cur = nodes[i]
  const prev = nodes[(i - 1 + n) % n]
  const next = nodes[(i + 1) % n]
  const a = cur.hIn ?? prev.hOut ?? prev
  const b = cur.hOut ?? next.hIn ?? next
  const ix = cur.x - a.x
  const iy = cur.y - a.y
  const ox = b.x - cur.x
  const oy = b.y - cur.y
  const d = (ix * ox + iy * oy) / (Math.hypot(ix, iy) * Math.hypot(ox, oy))
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI
}
const arcsOf = (rec: FilletDiagRecord | null): number[] =>
  (rec?.gaps ?? []).filter((g) => g.kind === 'fillet').map((g) => g.r)

test('a rounded rectangle is four lines and four quarter arcs, G¹ at every join', () => {
  const { nodes, rec } = fit(outline(box(100, 80, 120, 70), [14, 14, 14, 14]))
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  assert.equal(nodes.length, 8)
  for (const r of arcsOf(rec)) assert.ok(Math.abs(r - 14) < 0.2, `radius ${r.toFixed(2)} for an authored 14`)
  for (let i = 0; i < nodes.length; i++) {
    assert.equal(nodes[i].kind, 'smooth')
    // A tangent node carries ONE handle — the arc's — and the line leaves it bare.
    assert.ok((nodes[i].hIn === null) !== (nodes[i].hOut === null), `node ${i} is not a line–arc join`)
    assert.ok(breakAt(nodes, i) < 0.01, `node ${i} breaks ${breakAt(nodes, i).toFixed(3)}°`)
  }
})

test('it does not lean on the lattice: the same rect at 25° reads the same', () => {
  const { nodes, rec } = fit(outline(rot(box(100, 80, 120, 70), 100, 80, 25), [14, 14, 14, 14]))
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  assert.equal(nodes.length, 8)
  for (const r of arcsOf(rec)) assert.ok(Math.abs(r - 14) < 0.2, `radius ${r.toFixed(2)}`)
})

test('a stadium is two lines and two half turns', () => {
  const { nodes, rec } = fit(outline(box(100, 60, 130, 36), [18, 18, 18, 18]))
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  // Each cap: tangent point, one node at the 90° split, tangent point.
  assert.equal(nodes.length, 6)
  assert.deepEqual(
    rec!.gaps.map((g) => Math.round(g.turn)),
    [180, 180],
  )
  for (const r of arcsOf(rec)) assert.ok(Math.abs(r - 18) < 0.15, `cap radius ${r.toFixed(2)}`)
})

test('round and sharp corners in one loop: the sharp ones land on the line intersection', () => {
  const tab = box(100, 80, 120, 70)
  const { nodes, rec } = fit(outline(tab, [16, 16, 0, 0]))
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  assert.equal(nodes.length, 6)
  const corners = nodes.filter((nd) => nd.kind === 'corner')
  assert.equal(corners.length, 2)
  for (const c of corners) {
    const d = Math.min(...[tab[2], tab[3]].map(([x, y]) => Math.hypot(x - c.x, y - c.y)))
    assert.ok(d < 0.15, `sharp corner ${d.toFixed(2)}px off its authored vertex`)
    assert.equal(c.hIn, null)
    assert.equal(c.hOut, null)
  }
})

test('a concave fillet turns the other way and is still one arc', () => {
  const L: P[] = [
    [40, 40],
    [90, 40],
    [90, 100],
    [160, 100],
    [160, 150],
    [40, 150],
  ]
  const { nodes, rec } = fit(outline(L, [0, 0, 16, 0, 0, 0]))
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  assert.equal(nodes.length, 7)
  assert.equal(arcsOf(rec).length, 1)
  assert.ok(Math.abs(arcsOf(rec)[0] - 16) < 0.2)
})

test('a map pin: the head goes the LONG way round, tangent to both flanks', () => {
  // Head r = 30 at (100, 70); the flanks meet 56 below its centre.
  const r = 30
  const al = Math.asin(r / 56)
  const px = r * Math.cos(al)
  const py = r * Math.sin(al)
  const pts: Vec[] = []
  const tip: P = [100, 126]
  const a: P = [100 + px, 70 + py]
  const b: P = [100 - px, 70 + py]
  const seg = (p: P, q: P): void => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
    for (let s = 0; s < Math.round(len); s++)
      pts.push({ x: p[0] + ((q[0] - p[0]) * s) / Math.round(len), y: p[1] + ((q[1] - p[1]) * s) / Math.round(len) })
  }
  seg(tip, a)
  const a0 = Math.atan2(py, px)
  const sweep = -(Math.PI + 2 * al)
  const steps = Math.round(Math.abs(sweep) * r)
  for (let s = 0; s < steps; s++)
    pts.push({ x: 100 + r * Math.cos(a0 + (sweep * s) / steps), y: 70 + r * Math.sin(a0 + (sweep * s) / steps) })
  seg(b, tip)
  const { nodes, rec } = fit(pts)
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  const head = rec!.gaps.find((g) => g.kind === 'fillet')!
  assert.ok(Math.abs(head.r - r) < 0.2, `head radius ${head.r.toFixed(2)}`)
  assert.ok(Math.abs(head.turn - (180 + (2 * al * 180) / Math.PI)) < 1, `head sweeps ${head.turn.toFixed(1)}°`)
  const tipNode = nodes.find((nd) => nd.kind === 'corner')!
  assert.ok(Math.hypot(tipNode.x - tip[0], tipNode.y - tip[1]) < 0.2, 'the tip is the flanks’ intersection')
})

test('a disc is not a rounded polygon, at any size', () => {
  for (const r of [14, 40, 80, 200]) {
    const { nodes, rec } = fit(circle(120, 120, r))
    assert.equal(nodes, null, `r = ${r} read as ${JSON.stringify(rec?.gaps.map((g) => Math.round(g.turn)))}`)
  }
})

test('a sector is not one either: its arc meets the lines at corners', () => {
  const R = 60
  const pts: Vec[] = []
  const c: P = [60, 140]
  const a0 = (-80 * Math.PI) / 180
  const a1 = (-5 * Math.PI) / 180
  const p0: P = [c[0] + R * Math.cos(a0), c[1] + R * Math.sin(a0)]
  const p1: P = [c[0] + R * Math.cos(a1), c[1] + R * Math.sin(a1)]
  for (let s = 0; s < R; s++) pts.push({ x: c[0] + ((p0[0] - c[0]) * s) / R, y: c[1] + ((p0[1] - c[1]) * s) / R })
  const steps = Math.round((a1 - a0) * R)
  for (let s = 0; s < steps; s++)
    pts.push({
      x: c[0] + R * Math.cos(a0 + ((a1 - a0) * s) / steps),
      y: c[1] + R * Math.sin(a0 + ((a1 - a0) * s) / steps),
    })
  for (let s = 0; s < R; s++) pts.push({ x: p1[0] + ((c[0] - p1[0]) * s) / R, y: p1[1] + ((c[1] - p1[1]) * s) / R })
  assert.equal(fit(pts).nodes, null)
})

test('a squircle is smooth and not made of arcs', () => {
  const pts: Vec[] = []
  for (let i = 0; i < 360; i++) {
    const t = (i * Math.PI) / 180
    const cx = Math.cos(t)
    const sy = Math.sin(t)
    pts.push({
      x: 100 + 60 * Math.sign(cx) * Math.sqrt(Math.abs(cx)),
      y: 100 + 60 * Math.sign(sy) * Math.sqrt(Math.abs(sy)),
    })
  }
  assert.equal(fit(pts).nodes, null)
})

test('sharp stays sharp: a polygon is left to the corner fit, and so is a corner under the radius floor', () => {
  assert.equal(fit(outline(box(100, 80, 120, 70), [0, 0, 0, 0])).rec?.verdict, 'no-fillet')
  // r = 2: what anti-aliasing does to a sharp corner. Every gap reads as a corner.
  const soft = fit(outline(box(100, 80, 120, 70), [2, 2, 2, 2]))
  assert.equal(soft.nodes, null)
  assert.equal(soft.rec?.verdict, 'no-fillet')
})

test('one loop, one answer: corners that read alike are all sharp or all round', () => {
  // A hexagon whose corners stand ~1px off their vertices sits ON the stand-off floor;
  // jitter decides each corner separately unless the loop is read as a whole.
  const hex: P[] = Array.from({ length: 6 }, (_, i) => [
    120 + 70 * Math.cos((i * Math.PI) / 3),
    120 + 70 * Math.sin((i * Math.PI) / 3),
  ])
  for (const r of [5.5, 6, 6.5, 7, 7.5]) {
    const { rec } = fit(outline(hex, [r, r, r, r, r, r], 0.12))
    const kinds = new Set((rec?.gaps ?? []).map((g) => g.kind))
    assert.ok(kinds.size <= 1, `r = ${r}: mixed ${[...kinds].join(' + ')}`)
  }
})

test('strays and outliers: a slanted side with a lattice point every fourth step still reads', () => {
  const pts = outline(rot(box(100, 80, 120, 70), 100, 80, 20), [14, 14, 14, 14])
  const measured = all(pts)
  // The estimator declines at the inside corner of each stair step: half a pixel off.
  for (let i = 3; i < pts.length; i += 4) {
    measured[i] = 0
    pts[i] = { x: pts[i].x + 0.45, y: pts[i].y - 0.3 }
  }
  const strays = fit(pts, measured)
  assert.ok(strays.nodes, `strays: ${strays.rec?.verdict}`)
  for (const r of arcsOf(strays.rec)) assert.ok(Math.abs(r - 14) < 0.4, `radius ${r.toFixed(2)} with strays`)

  // …and one measured point that is simply wrong does not decide the loop.
  const clean = outline(box(100, 80, 120, 70), [14, 14, 14, 14])
  clean[10] = { x: clean[10].x, y: clean[10].y + 0.5 }
  assert.ok(fit(clean).nodes, 'one outlier on an arc')
})

test('a lattice chain: an upright rounded rect reads, a disc does not', () => {
  const W = 160
  const H = 120
  const label = (inside: (x: number, y: number) => boolean): Int32Array => {
    const L = new Int32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) L[y * W + x] = inside(x + 0.5, y + 0.5) ? 1 : 0
    return L
  }
  const rr = (x: number, y: number): boolean => {
    const dx = Math.max(0, Math.abs(x - 80) - (50 - 12))
    const dy = Math.max(0, Math.abs(y - 60) - (35 - 12))
    return Math.abs(x - 80) <= 50 && Math.abs(y - 60) <= 35 && dx * dx + dy * dy <= 12 * 12
  }
  const rect = tracePlanar(label(rr), W, H)
  assert.equal(rect.rounded.size, 1, 'the rounded rect is read off the staircase')
  const e = rect.edges.find((ed) => rect.rounded.has(ed.id))!
  assert.equal(e.nodes.length, 8)

  // The top of a disc is a dead-straight row of cracks until the circle drops a pixel.
  const disc = tracePlanar(
    label((x, y) => (x - 80) ** 2 + (y - 60) ** 2 <= 45 * 45),
    W,
    H,
  )
  assert.equal(disc.rounded.size, 0)
})

test('a rounded polygon is exempt from the circle / ellipse snap', () => {
  // A SoundCloud bar: two straight segments a side meeting at an 8° vertex at the waist,
  // and round caps. It is within fidelity of an ellipse, has no 60° corner to veto the
  // snap, and that snap turned a correctly read bar into a spindle.
  const bar: P[] = [
    [92, 30],
    [108, 30],
    [113, 100],
    [108, 170],
    [92, 170],
    [87, 100],
  ]
  const { nodes, rec } = fit(outline(bar, [7.5, 7.5, 0, 7.5, 7.5, 0]))
  assert.ok(nodes, `not read: ${rec?.verdict}`)
  assert.equal(nodes.filter((nd) => nd.kind === 'corner').length, 2, 'the two waist vertices are kept')
  const loops = new Map([[1, [[{ edge: 0, reversed: false }]]]])
  const topoOf = (nd: PathNode[]) => ({
    vertices: [],
    edges: [{ id: 0, nodes: nd, closed: true, startVertex: null, endVertex: null }],
  })
  const kept = planarBeautify(topoOf(nodes), loops, DEFAULT_BEAUTIFY_OPTIONS, { rounded: new Set([0]) })
  assert.deepEqual(kept.edges[0].nodes, nodes, 'the bar keeps its lines, caps and waist')

  // The mechanism on a loop the snap certainly takes: a rounded square 1.2px from a circle.
  const k = (4 / 3) * Math.tan(Math.PI / 8) * 34
  const sq: PathNode[] = []
  for (let q = 0; q < 4; q++) {
    const a = (q * Math.PI) / 2
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    // Side q runs along (ux, uy) at distance 40 from the centre; its corner is at its end.
    const ex = 100 + ux * 6 + uy * 40
    const ey = 100 + uy * 6 - ux * 40
    const fx = 100 + ux * 40 + uy * 6
    const fy = 100 + uy * 40 - ux * 6
    sq.push({ x: ex, y: ey, hIn: null, hOut: { x: ex + ux * k, y: ey + uy * k }, kind: 'smooth' })
    sq.push({ x: fx, y: fy, hIn: { x: fx + uy * k, y: fy - ux * k }, hOut: null, kind: 'smooth' })
  }
  assert.equal(
    planarBeautify(topoOf(sq), loops, DEFAULT_BEAUTIFY_OPTIONS).edges[0].nodes.length,
    4,
    'snapped to a circle',
  )
  assert.equal(
    planarBeautify(topoOf(sq), loops, DEFAULT_BEAUTIFY_OPTIONS, { rounded: new Set([0]) }).edges[0].nodes.length,
    8,
    'left alone when the loop is a certified rounded polygon',
  )
})
