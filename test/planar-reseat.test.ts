// §10.4 — junction re-seat on fitted-primitive intersection (planarReseat.ts).
//
// Where an occluding straight edge crosses a disc near-tangentially, the label
// map's three-colour meeting point SLIDES along the shared tangent: the colour
// needle between the two boundaries is sub-pixel thin near the true crossing, so
// its pixels are annexed by a neighbour class and the lattice junction lands
// several px away. The fit honours the pinned vertex, so the straight edge's
// last segment bends off its own line to reach it ("the line gets pulled into
// the circle" — gradient-flat, user-reported). The re-seat pass moves such a
// junction to the intersection of its two strongest incident fitted primitives,
// repairs the mangled terminal caps, and straightens the occluder chord.
//
// The fixture reproduces the SLIDE deterministically: a disc crossed by a dark
// half-plane at gradient-flat's exact geometry, with the thin background needle
// past the true crossing hand-annexed to the dark class (what AA + quantization
// do to the real raster).
//
// Asserts: the slid junction returns to the primitive intersection, the
// occluder line stays straight through the crossing, the chord straightens,
// ordinary (unslid) junctions are untouched, and the pass is deterministic.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ensureImageData } from '../src/devtest/nodeHarness.ts'
import { tracePlanar } from '../src/lib/trace/planarAssemble.ts'
import { planarBeautify, type SnapOptions } from '../src/lib/trace/planarBeautify.ts'
import { reseatJunctions, weldConvergedJunctions } from '../src/lib/trace/planarReseat.ts'
import type { BeautifyOptions } from '../src/lib/trace/beautify.ts'
import type { EdgeRef, SharedEdge, Topology, Vec, Vertex } from '../src/lib/path/types.ts'

ensureImageData()

const W = 512, H = 512
const OPTS: BeautifyOptions = { fidelity: 1.5, relationFrac: 0.1, hvAngleDeg: 0 }

// gradient-flat's geometry @512: disc c=(174,256) r=76; occluder line
// (200,174)→(348,338) — centre distance 74.2, sagitta ~1.8px, 12° incidence.
const CX = 174, CY = 256, R = 76
const LA = { x: 200, y: 174 }, LB = { x: 348, y: 338 }
const LLEN = Math.hypot(LB.x - LA.x, LB.y - LA.y)
const LD = { x: (LB.x - LA.x) / LLEN, y: (LB.y - LA.y) / LLEN }
/** Signed distance to the occluder line (+ = dark side) / param along it (px). */
const lineDist = (x: number, y: number): number => (x - LA.x) * LD.y - (y - LA.y) * LD.x
const lineT = (x: number, y: number): number => (x - LA.x) * LD.x + (y - LA.y) * LD.y
/** True line×circle junctions (the answer sheet). */
function trueJunctions(): [Vec, Vec] {
  const t0 = (CX - LA.x) * LD.x + (CY - LA.y) * LD.y
  const fx = LA.x + t0 * LD.x, fy = LA.y + t0 * LD.y
  const h = Math.sqrt(R * R - ((CX - fx) ** 2 + (CY - fy) ** 2))
  return [
    { x: fx - h * LD.x, y: fy - h * LD.y },
    { x: fx + h * LD.x, y: fy + h * LD.y },
  ]
}
const [J1, J2] = trueJunctions()

/**
 * Label map: 0 = bg, 1 = disc, 2 = dark half-plane over the disc. `annex` > 0
 * hand-annexes the thin bg needle for that many px past the second crossing to
 * the DARK class — the junction slides along the arc, exactly the raster's
 * failure. 0 ⇒ an ideally-quantized map (the control).
 */
function occludedDisc(annex: number): Int32Array {
  const labels = new Int32Array(W * H)
  const t2 = lineT(J2.x, J2.y)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = x + 0.5, py = y + 0.5
      const dark = lineDist(px, py) >= 0
      const disc = Math.hypot(px - CX, py - CY) <= R
      let l = dark ? 2 : disc ? 1 : 0
      if (l === 0 && annex > 0) {
        const t = lineT(px, py)
        if (t > t2 && t < t2 + annex && lineDist(px, py) > -2.5 && !disc) l = 2
      }
      labels[y * W + x] = l
    }
  return labels
}

const beautify = (t: ReturnType<typeof tracePlanar>, snap: SnapOptions = {}): Topology =>
  planarBeautify({ vertices: t.vertices, edges: t.edges }, t.loopsByLabel, OPTS, snap)

/** The junction vertex nearest a point. */
function nearestVertex(topo: Topology, p: Vec): { v: Vec; d: number } {
  let best: Vec = topo.vertices[0]
  let bd = Infinity
  for (const v of topo.vertices) {
    const d = Math.hypot(v.x - p.x, v.y - p.y)
    if (d < bd) { bd = d; best = v }
  }
  return { v: best, d: bd }
}

/** Max deviation from the occluder line over every fitted point of `e` that
 *  projects into the crossing zone (t ∈ [zone0, zone1]). */
function maxLineDevInZone(e: SharedEdge, zone0: number, zone1: number): number {
  let maxD = 0
  for (let s = 0; s + 1 < e.nodes.length; s++) {
    const p = e.nodes[s], q = e.nodes[s + 1]
    const c1 = p.hOut ?? p, c2 = q.hIn ?? q
    for (let k = 0; k <= 24; k++) {
      const t = k / 24, u = 1 - t
      const x = u * u * u * p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * q.x
      const y = u * u * u * p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * q.y
      const lt = lineT(x, y)
      if (lt < zone0 || lt > zone1) continue
      maxD = Math.max(maxD, Math.abs(lineDist(x, y)))
    }
  }
  return maxD
}

/** The dark|bg run arriving at the slid junction: open, EVERY node on the line
 *  (within the mangle margin), the longest such — excludes the arc (far middle
 *  nodes) and the short chord. */
function occluderEdge(topo: Topology): SharedEdge {
  let best: SharedEdge | null = null
  let bestSpan = 0
  for (const e of topo.edges) {
    if (e.closed || e.nodes.length < 2) continue
    if (!e.nodes.every((nd) => Math.abs(lineDist(nd.x, nd.y)) < 6)) continue
    const a = e.nodes[0], b = e.nodes[e.nodes.length - 1]
    const span = Math.hypot(a.x - b.x, a.y - b.y)
    const nearJ2 = Math.hypot(a.x - J2.x, a.y - J2.y) < 15 || Math.hypot(b.x - J2.x, b.y - J2.y) < 15
    if (nearJ2 && span > bestSpan) { best = e; bestSpan = span }
  }
  assert.ok(best, 'found the occluder edge')
  return best!
}

test('reseat: a slid junction returns to the fitted-primitive intersection', () => {
  const t = tracePlanar(occludedDisc(9), W, H)

  const off = beautify(t, { reseat: false, width: W, height: H })
  const on = beautify(t, { width: W, height: H })

  // Without the pass the junction sits where the annexed needle put it — px away.
  const slid = nearestVertex(off, J2)
  assert.ok(slid.d > 3, `the fixture slides the junction (${slid.d.toFixed(2)}px from true)`)
  // With it, the vertex returns to the crossing. The residual is TANGENTIAL fit
  // noise (it slides along both primitives — invisible), so the hard assertions
  // are lying ON the line and ON the circle; the distance bound is looser.
  const fixed = nearestVertex(on, J2)
  assert.ok(fixed.d < 3.5, `re-seated junction near the true crossing (${fixed.d.toFixed(2)}px, was ${slid.d.toFixed(2)}px)`)
  assert.ok(Math.abs(lineDist(fixed.v.x, fixed.v.y)) < 0.8, `…on the occluder line (${lineDist(fixed.v.x, fixed.v.y).toFixed(2)}px)`)
  const rdev = Math.hypot(fixed.v.x - CX, fixed.v.y - CY) - R
  assert.ok(Math.abs(rdev) < 0.8, `…on the circle (${rdev.toFixed(2)}px)`)
})

test('reseat: the occluder line stays straight through the crossing (no pull), chord straightens', () => {
  const t = tracePlanar(occludedDisc(9), W, H)
  const zone0 = lineT(J1.x, J1.y) - 30
  const zone1 = lineT(J2.x, J2.y) + 30

  const off = beautify(t, { reseat: false, width: W, height: H })
  const on = beautify(t, { width: W, height: H })

  const bentDev = maxLineDevInZone(occluderEdge(off), zone0, zone1)
  const straightDev = maxLineDevInZone(occluderEdge(on), zone0, zone1)
  assert.ok(bentDev > 1.5, `without re-seat the line bends into the disc (${bentDev.toFixed(2)}px)`)
  assert.ok(straightDev < 0.9, `with re-seat it stays straight (${straightDev.toFixed(2)}px, was ${bentDev.toFixed(2)}px)`)

  // The disc|dark chord between the junctions: exactly two nodes, straight, on the line.
  const chord = on.edges.find((e) => {
    if (e.closed || e.nodes.length !== 2) return false
    return e.nodes.every((nd) => Math.abs(lineDist(nd.x, nd.y)) < 1.5 && Math.hypot(nd.x - CX, nd.y - CY) < R + 1.5)
  })
  assert.ok(chord, 'the occluder chord is a 2-node straight edge on the line')
  assert.equal(chord!.nodes[0].hOut, null)
  assert.equal(chord!.nodes[1].hIn, null)
})

test('reseat: an ideally-quantized junction is untouched (MIN_MOVE guard)', () => {
  const t = tracePlanar(occludedDisc(0), W, H)
  const off = beautify(t, { reseat: false, width: W, height: H })
  const on = beautify(t, { width: W, height: H })
  assert.deepEqual(on, off, 'no annexed needle ⇒ no junction slid ⇒ byte-identical output')
})

test('reseat: deterministic', () => {
  const a = beautify(tracePlanar(occludedDisc(9), W, H), { width: W, height: H })
  const b = beautify(tracePlanar(occludedDisc(9), W, H), { width: W, height: H })
  assert.deepEqual(a, b)
})

// --- terminal arc re-emit: junction-local sweep ------------------------------
// A circle-arm terminal segment is re-emitted as an arc slice into the corrected
// vertex. The sweep-side hint is the ORIGINAL cap's midpoint — and on a mangled
// cap that points AWAY from the correction, the hint lands on the wrong angular
// side of the (tiny) from→to span, which arcSlice honours as a near-full-circle
// sweep: a ghost disc ballooning out of a sliver edge (soft-alpha logo art: a
// 5.9px cap re-emitted as a 356° arc of its r≈81 arm). The re-emit must stay
// junction-local no matter where the hint falls.

test('reseat: a terminal arc re-emit never laps the fitted circle (mangled-cap hint)', () => {
  // Circle O=(200,200) r=80; P(θ°) on it. The circle arm runs P(31°)→P(1°) as a
  // 3°-chord polyline, then a mangled 2-chord cap to the vertex at P(-1°) — so
  // the cap midpoint sits at ≈P(0°), angularly BEHIND the arm's last node. The
  // occluder line passes through H=P(3°) at 20° to the tangent, its straight run
  // stopping 4px short of the vertex (the bent cap the re-seat repairs). The
  // corrected vertex is H: the terminal re-emit spans P(1°)→P(3°) — 2°, not 358°.
  const O = { x: 200, y: 200 }, R2 = 80
  const P = (deg: number): Vec => ({
    x: O.x + R2 * Math.cos((deg * Math.PI) / 180),
    y: O.y + R2 * Math.sin((deg * Math.PI) / 180),
  })
  const corner = (p: Vec): SharedEdge['nodes'][number] => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' })
  const Vold = P(-1)
  const Hx = P(3)
  // Line through H at 20° to the circle tangent there.
  const th = (3 * Math.PI) / 180
  const rot = (v: Vec, deg: number): Vec => {
    const a = (deg * Math.PI) / 180
    return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) }
  }
  const dir = rot({ x: -Math.sin(th), y: Math.cos(th) }, 20)
  const at = (t: number): Vec => ({ x: Hx.x + t * dir.x, y: Hx.y + t * dir.y })

  const arcNodes = []
  for (let deg = 31; deg >= 1; deg -= 3) arcNodes.push(corner(P(deg)))
  arcNodes.push(corner(Vold))
  const vertices: Vertex[] = [
    { id: 0, x: Vold.x, y: Vold.y },
    { id: 1, ...P(31) },
    { id: 2, ...at(-100) },
    { id: 3, x: Vold.x - 9, y: Vold.y - 10 },
  ]
  const edges: SharedEdge[] = [
    { id: 0, closed: false, startVertex: 1, endVertex: 0, nodes: arcNodes }, // circle arm + mangled cap
    { id: 1, closed: false, startVertex: 2, endVertex: 0, nodes: [corner(at(-100)), corner(at(-9)), corner(Vold)] }, // line arm + bent cap
    { id: 2, closed: false, startVertex: 0, endVertex: 3, nodes: [corner(Vold), corner({ x: Vold.x - 6, y: Vold.y - 3 }), corner({ x: Vold.x - 9, y: Vold.y - 10 })] }, // kinked spoke: no primitive
  ]

  const { moved } = reseatJunctions(edges, vertices, W, H)
  assert.ok(moved.has(0), 'the fixture junction is re-seated')
  const v = vertices[0]
  assert.ok(Math.hypot(v.x - Hx.x, v.y - Hx.y) < 0.5, 'vertex lands on the line×circle intersection')

  // THE regression: every point of the circle arm stays inside its own angular
  // window. With the wrong-way sweep the re-emit wraps the whole circle (angles
  // cover ±180°) and bbox ≈ 2r; junction-local it spans [1°, 31°] + slack.
  for (const nd of edges[0].nodes) {
    for (const p of [nd, nd.hIn, nd.hOut]) {
      if (!p) continue
      const deg = (Math.atan2(p.y - O.y, p.x - O.x) * 180) / Math.PI
      assert.ok(deg > -10 && deg < 42, `arm point stays junction-local (${deg.toFixed(1)}°)`)
    }
  }
})

// --- converged-pair weld (§10.4 second half) --------------------------------
// A rasterized degree-4 crossing = two degree-3 junctions + a micro-edge. Once
// the re-seat converges the pair, weldConvergedJunctions fuses it into ONE
// vertex — but ONLY with re-seat evidence: an equally short micro-edge that the
// re-seat never touched is (possibly) a real thin feature and must survive
// (the §9.3 beverage-box lesson that keeps the blanket weld off).

function microPairTopology(): { vertices: Vertex[]; edges: SharedEdge[]; loops: Map<number, EdgeRef[][]> } {
  const line = (id: number, sv: number, ev: number, ax: number, ay: number, bx: number, by: number): SharedEdge => ({
    id,
    closed: false,
    startVertex: sv,
    endVertex: ev,
    nodes: [
      { x: ax, y: ay, hIn: null, hOut: null, kind: 'corner' },
      { x: bx, y: by, hIn: null, hOut: null, kind: 'corner' },
    ],
  })
  // A quad of two micro-edges (left pair converged, right pair untouched) and
  // two long edges, bounding one face each way.
  const vertices: Vertex[] = [
    { id: 0, x: 100, y: 100 },
    { id: 1, x: 101.2, y: 100.3 }, // 1.24px from v0 — the converged pair
    { id: 2, x: 200, y: 100 },
    { id: 3, x: 201.4, y: 100.2 }, // 1.41px from v2 — no re-seat evidence
  ]
  const edges: SharedEdge[] = [
    line(0, 0, 1, 100, 100, 101.2, 100.3), // micro (converged)
    line(1, 1, 2, 101.2, 100.3, 200, 100), // long
    line(2, 2, 3, 200, 100, 201.4, 100.2), // micro (untouched)
    line(3, 3, 0, 201.4, 100.2, 100, 100), // long
  ]
  const cycle: EdgeRef[] = [0, 1, 2, 3].map((edge) => ({ edge, reversed: false }))
  const loops = new Map<number, EdgeRef[][]>([
    [0, [cycle.map((r) => ({ ...r }))]],
    [1, [cycle.map((r) => ({ ...r, reversed: true })).reverse()]],
  ])
  return { vertices, edges, loops }
}

test('weld: fuses ONLY the re-seat-converged pair; an untouched micro-edge survives', () => {
  const { vertices, edges, loops } = microPairTopology()
  weldConvergedJunctions(vertices, edges, loops, W, H, new Set([0]))

  // v0/v1 fused into one vertex at the centroid; the micro-edge is gone.
  assert.equal(vertices.length, 3)
  const fusedV = vertices.find((v) => v.id === 0)!
  assert.ok(Math.abs(fusedV.x - 100.6) < 1e-9 && Math.abs(fusedV.y - 100.15) < 1e-9, 'fused at the pair centroid')
  assert.ok(!vertices.some((v) => v.id === 1), 'the fused-away vertex is pruned')
  assert.ok(!edges.some((e) => e.id === 0), 'the converged micro-edge is contracted')
  // …and excised from every loop.
  for (const loopSet of loops.values())
    for (const loop of loopSet) assert.ok(loop.every((r) => r.edge !== 0))
  // Incident edges re-anchor on the fused vertex.
  const e1 = edges.find((e) => e.id === 1)!
  assert.equal(e1.startVertex, 0)
  assert.ok(Math.abs(e1.nodes[0].x - 100.6) < 1e-9)
  const e3 = edges.find((e) => e.id === 3)!
  assert.equal(e3.endVertex, 0)
  assert.ok(Math.abs(e3.nodes[1].x - 100.6) < 1e-9)
  // The equally-short but NON-converged pair v2/v3 is untouched.
  assert.ok(edges.some((e) => e.id === 2), 'no re-seat evidence ⇒ the micro-edge survives')
  assert.ok(vertices.some((v) => v.id === 2) && vertices.some((v) => v.id === 3))
})

test('weld: no moved vertices ⇒ graph untouched', () => {
  const { vertices, edges, loops } = microPairTopology()
  const before = JSON.stringify({ vertices, edges, loops: [...loops] })
  weldConvergedJunctions(vertices, edges, loops, W, H, new Set())
  assert.equal(JSON.stringify({ vertices, edges, loops: [...loops] }), before)
})
