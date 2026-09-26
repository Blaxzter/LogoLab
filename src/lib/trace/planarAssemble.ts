// Planar trace assembly: place the junction vertices, fit every edge once, then
// assemble each region's boundary as ordered loops of shared-edge references via a
// half-edge face walk on the lattice rotational system. Loops are oriented for
// nonzero fill (outer CCW, holes CW) by flipping EdgeRef loops, so materializeRegion
// stays a pure forward concatenation and the two regions on a shared edge reference
// identical geometry.

import type { EdgeRef, PathNode, SharedEdge, Vec, Vertex } from '../path/types'
import { cubicAt, segmentControls, segmentCount } from '../path/geometry.ts'
import { buildPlanarNetwork, EXT, type PlanarNetwork } from './planarNetwork.ts'
import { detectCorners, detectLoopCorners, discExplainsLoop, fitCorneredLoop, fitCorneredOpen, fitLoopEdge, fitOpenArc, presmooth, type ApexReach, type PlanarFitOptions, DEFAULT_PLANAR_FIT } from './planarFit.ts'
import { srgbToLab, deltaE76 } from './lab.ts'
import { subpixelJunctions, smoothThroughJunctions } from './planarJunction.ts'
import { subpixelEdgeChains, type SourceImage } from './planarSubpixel.ts'
import { threadJunctions, type ThreadColor } from './planarThread.ts'
import { reverseEdgeNodes } from '../path/topology.ts'

export interface PlanarTrace {
  vertices: Vertex[]
  edges: SharedEdge[]
  /** Per region label → its boundary loops (outer + holes), oriented for nonzero. */
  loopsByLabel: Map<number, EdgeRef[][]>
}

/** Direction rotation that selects the next half-edge keeping the face on one
 *  consistent side (validated by the per-pixel relabel check). */
const ROT = [1, 2, 3] // try clockwise turns from the reverse direction first

// --- Raster evidence for apex reconstruction -------------------------------------
// planarFit is pure geometry; this layer holds both the source raster and the two
// regions' colours, so the probe is built here and handed down as a closure
// (PlanarFitOptions.apexReach). See APEX_OVERSHOOT_MAX in planarFit.ts for its use.

/** Coverage below this means the own region is absent. */
const APEX_ALPHA_FLOOR = 0.1
/** Walk step (px) along the reconstruction ray. */
const APEX_STEP = 0.25
/** How far behind the lattice vertex (px) the own region is identified — inside the
 *  corner, beyond the reach of anti-aliasing and of the reconstruction. */
const APEX_BEHIND = 2.5
/** Below this own↔other ΔE the projection is noise and the probe declines to judge. */
const APEX_MIN_SEP = 10

/**
 * Builds a probe for how far the corner's own region still has coverage in the source
 * raster, walking from `from` toward `to`. Coverage is recovered by projecting the
 * sampled colour onto the own↔other line in sRGB, where the rasterizer composited it
 * (the mixing line would curve in Lab). Sampling is bilinear, since nearest-neighbour
 * would quantize the measured trail into whole pixels.
 *
 * "Own" is whichever region the raster shows behind `from`, so convex and concave
 * corners need no separate treatment.
 *
 * Returns null when the two colours are too close to judge (no veto); the probe
 * returns Infinity for a degenerate ray.
 */
function apexReachFor(image: SourceImage, a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): ApexReach | null {
  const la = srgbToLab(a.r, a.g, a.b)
  const lb = srgbToLab(b.r, b.g, b.b)
  if (deltaE76(la, lb) < APEX_MIN_SEP) return null
  const { data, width, height } = image
  const px = (x: number, y: number, k: number): number => data[(y * width + x) * 4 + k]
  const at = (x: number, y: number, out: [number, number, number]): void => {
    const cx = Math.max(0, Math.min(width - 1.001, x))
    const cy = Math.max(0, Math.min(height - 1.001, y))
    const x0 = Math.floor(cx)
    const y0 = Math.floor(cy)
    const fx = cx - x0
    const fy = cy - y0
    for (let k = 0; k < 3; k++) {
      const t = px(x0, y0, k) * (1 - fx) + px(x0 + 1, y0, k) * fx
      const u = px(x0, y0 + 1, k) * (1 - fx) + px(x0 + 1, y0 + 1, k) * fx
      out[k] = t * (1 - fy) + u * fy
    }
  }
  const buf: [number, number, number] = [0, 0, 0]
  return (from: Vec, to: Vec): number => {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const len = Math.hypot(dx, dy)
    if (len < 1e-9) return Infinity
    const ux = dx / len
    const uy = dy / len
    at(from.x - ux * APEX_BEHIND, from.y - uy * APEX_BEHIND, buf)
    const behind = srgbToLab(buf[0], buf[1], buf[2])
    const own = deltaE76(behind, la) <= deltaE76(behind, lb) ? a : b
    const other = own === a ? b : a
    const vx = own.r - other.r
    const vy = own.g - other.g
    const vz = own.b - other.b
    const den = vx * vx + vy * vy + vz * vz
    let reach = 0
    let miss = 0
    for (let t = APEX_STEP; t <= len; t += APEX_STEP) {
      at(from.x + ux * t, from.y + uy * t, buf)
      const alpha = ((buf[0] - other.r) * vx + (buf[1] - other.g) * vy + (buf[2] - other.b) * vz) / den
      if (alpha >= APEX_ALPHA_FLOOR) {
        reach = t
        miss = 0
      } else if (++miss >= 2) break
    }
    return reach
  }
}


/** Build the full planar trace from a label map. `palette` (label → colour) is
 *  optional and feeds the contrast-ranked junction placement and the apex probe.
 *  `image` (the source raster the labels were segmented from) is optional and feeds
 *  sub-pixel edge placement and the apex probe; without it every chain stays on the
 *  integer crack lattice, which is what label-only callers (tests, synthetic maps) get. */
export function tracePlanar(
  labels: Int32Array,
  width: number,
  height: number,
  opts: PlanarFitOptions = DEFAULT_PLANAR_FIT,
  palette?: readonly ThreadColor[],
  image?: SourceImage,
): PlanarTrace {
  const net = buildPlanarNetwork(labels, width, height)
  // Read the sub-pixel edge position out of the source anti-aliasing
  // (planarSubpixel.ts). Computed on the raw network, before junction placement, so
  // threadJunctions still reads the raw lattice chains it is calibrated on.
  const subpix = image && opts.subpixelEdges
    ? subpixelEdgeChains(net, labels, image, undefined, opts.subpixelWindowGuard)
    : undefined
  return assemblePlanar(net, opts, palette, subpix, image)
}

export function assemblePlanar(
  net: PlanarNetwork,
  opts: PlanarFitOptions,
  palette?: readonly ThreadColor[],
  subpix?: ReadonlyMap<number, Vec[]>,
  /** Source raster read by the apex evidence probe. Absent ⇒ no probe. */
  image?: SourceImage,
): PlanarTrace {
  const cw = net.width + 1
  // --- vertices: one per junction corner ---
  // Contrast-ranked placement (planarThread.ts): where a weak boundary (e.g. a band
  // seam) ends on a strong edge that continues through, the junction is placed on a
  // fit through the strong arms rather than on the integer lattice corner, which
  // would tilt the strong boundary; where the strong boundary turns a corner there,
  // the junction goes to its arms' line intersection. Needs the palette. With
  // refineJunctions (experimental, off by default) every junction instead moves to
  // its sub-pixel arm intersection. Incident edge endpoints are pinned to moved
  // vertices below; all other junctions keep their lattice corner.
  const juncPos = opts.refineJunctions
    ? subpixelJunctions(net, cw)
    : palette && opts.fitThrough
      ? threadJunctions(net, palette, opts.cornerJunctions !== false)
      : null
  const vidByCorner = new Map<number, number>()
  const vertices: Vertex[] = []
  for (const c of net.junctions) {
    const id = vertices.length
    vidByCorner.set(c, id)
    const p = juncPos?.get(c)
    vertices.push({ id, x: p ? p.x : c % cw, y: p ? p.y : (c / cw) | 0 })
  }

  // --- fit every edge once ---
  const edges: SharedEdge[] = []
  interface EdgeMeta {
    left: number
    right: number
    dirStart: number
    dirEnd: number
    startV: number // vertex id or -1
    endV: number
    closed: boolean
  }
  const meta: EdgeMeta[] = []
  for (const e of net.edges) {
    // Pin open-edge endpoints to moved junction positions so the fitted arc ends
    // exactly on the shared vertex. e.pts is reused when nothing moved.
    let latticePts = e.pts
    if (juncPos && !e.closed) {
      const sp0 = e.startV >= 0 ? juncPos.get(e.startV) : undefined
      const sp1 = e.endV >= 0 ? juncPos.get(e.endV) : undefined
      if (sp0 || sp1) {
        latticePts = e.pts.map((p) => ({ x: p.x, y: p.y }))
        if (sp0) latticePts[0] = { x: sp0.x, y: sp0.y }
        if (sp1) latticePts[latticePts.length - 1] = { x: sp1.x, y: sp1.y }
      }
    }
    // Sharp corners are found on the raw staircase and pinned through pre-smoothing
    // so a point isn't melted into a curve before the fitter sees it.
    let nodes: PathNode[]
    const corners = detectCorners(latticePts, opts.cornerTurnDeg, e.closed, opts.cornerWindow)
    // Two chains coexist. Corner detection and the area guard read `latticePts`, since
    // their thresholds are calibrated on the integer staircase; the fit reads `pts`,
    // the sub-pixel displaced chain. The displacement preserves indices, so corners
    // found on one address the same points in the other. (planarSubpixel already
    // reverts corner zones to the lattice, because the anti-aliasing iso-line rounds
    // every apex.) Without sub-pixel data, pts === latticePts.
    const sub = subpix?.get(e.id)
    let pts = latticePts
    // Displaced chains also pin corner tangents: the arc fits' end tangents are free
    // within ε, and on a smooth displaced chain they rotate toward the bisector,
    // softening real corners.
    let edgeOpts = opts
    if (sub) {
      pts = sub.map((p) => ({ x: p.x, y: p.y }))
      const n = pts.length
      if (!e.closed) {
        pts[0] = { x: latticePts[0].x, y: latticePts[0].y }
        pts[n - 1] = { x: latticePts[n - 1].x, y: latticePts[n - 1].y }
      }
      edgeOpts = { ...opts, pinCornerTangents: true }
    }
    // Hand the fit this edge's raster evidence probe: the two regions it separates
    // are "own" and "other" at any corner on it. An EXT side has no colour, so no probe.
    if (image && palette && e.left !== EXT && e.right !== EXT && palette[e.left] && palette[e.right]) {
      const reach = apexReachFor(image, palette[e.left], palette[e.right])
      if (reach) edgeOpts = { ...edgeOpts, apexReach: reach }
    }
    // Diagnostics only: tag apex records with the edge id, which the fitter does not know.
    if (opts.apexDiag) {
      const sink = opts.apexDiag
      const eid = e.id
      edgeOpts = { ...edgeOpts, apexDiag: (r) => sink({ ...r, edge: eid }) }
    }
    if (e.closed) {
      // A closed loop with ≥2 sharp corners is fitted corner-first (snap each corner to
      // its sub-pixel arm intersection, then fit the arcs between them) so the apex is
      // an exact node, not a beveled pair. Otherwise the smooth closed-loop fitter runs.
      let loopCorners = detectLoopCorners(latticePts, opts.cornerTurnDeg, opts.cornerWindow, opts.cornerMerge)
      // A small disc's staircase reads as a few false corners; when one circle explains
      // the loop better than those corners' straight arms, it is fitted smooth and the
      // pins are dropped with the corners (see discExplainsLoop).
      let loopPins = corners
      if (discExplainsLoop(latticePts, loopCorners)) {
        loopCorners = []
        loopPins = new Set()
      }
      nodes =
        loopCorners.length >= 2
          ? fitCorneredLoop(pts, loopCorners, edgeOpts)
          : fitLoopEdge(presmooth(pts, opts.smoothPasses, false, loopPins), opts)
      // Area guard. A fit can keep every sample within ε and still pinch a thin
      // loop's two walls together: a thin bar's cap corners (1–2px apart) fuse into
      // one apex, the wall arcs pin to the same point, and the region collapses to a
      // line or triangle. Boundary tolerance cannot see this; area can. If the fit
      // keeps < 75% of the raw loop's area, fall back to the exact staircase corners
      // (an axis-aligned bar is just its 4 corners). A normal blob's fit drifts by a
      // small fraction of ε·perimeter and never approaches the threshold. Both sides
      // read the lattice chain: the reference area is the label map's own.
      const rawArea = Math.abs(polySignedArea(latticePts))
      if (rawArea >= 4 && Math.abs(polySignedArea(flattenNodes(nodes))) < rawArea * 0.75) {
        // If the fit used displaced points, first refit from the lattice chain; only
        // a fit that pinches there too falls back to the staircase, which costs many
        // more nodes.
        if (sub) {
          nodes =
            loopCorners.length >= 2
              ? fitCorneredLoop(latticePts, loopCorners, opts)
              : fitLoopEdge(presmooth(latticePts, opts.smoothPasses, false, loopPins), opts)
        }
        if (Math.abs(polySignedArea(flattenNodes(nodes))) < rawArea * 0.75) {
          nodes = staircaseCorners(latticePts)
        }
      }
    } else {
      // An open edge with sharp interior corners gets the same corner-first fit as
      // closed loops (fitCorneredOpen); otherwise the smooth open-arc fit.
      nodes =
        corners.size > 0
          ? fitCorneredOpen(pts, corners, edgeOpts)
          : fitOpenArc(presmooth(pts, opts.smoothPasses, true, corners), opts)
    }
    const startV = e.startV >= 0 ? vidByCorner.get(e.startV)! : -1
    const endV = e.endV >= 0 ? vidByCorner.get(e.endV)! : -1
    edges.push({ id: e.id, nodes, closed: e.closed, startVertex: e.closed ? null : startV, endVertex: e.closed ? null : endV })
    meta.push({ left: e.left, right: e.right, dirStart: e.dirStart, dirEnd: e.dirEnd, startV, endV, closed: e.closed })
  }

  // --- directed half-edges over the non-closed edges ---
  // heId = edgeIndex*2 + (reversed?1:0). label = region on the left of travel.
  interface HalfEdge {
    edgeIdx: number
    reversed: boolean
    label: number
    tailV: number
    headV: number
    leaveDir: number
    arriveDir: number
  }
  const halfEdges: HalfEdge[] = []
  const outDir = new Map<number, number[]>() // vertexId → [E,S,W,N] heId or -1
  const ensureOut = (v: number): number[] => {
    let a = outDir.get(v)
    if (!a) outDir.set(v, (a = [-1, -1, -1, -1]))
    return a
  }
  for (let i = 0; i < net.edges.length; i++) {
    const m = meta[i]
    if (m.closed) continue
    const fwd: HalfEdge = { edgeIdx: i, reversed: false, label: m.left, tailV: m.startV, headV: m.endV, leaveDir: m.dirStart, arriveDir: m.dirEnd }
    const rev: HalfEdge = { edgeIdx: i, reversed: true, label: m.right, tailV: m.endV, headV: m.startV, leaveDir: (m.dirEnd + 2) % 4, arriveDir: (m.dirStart + 2) % 4 }
    const fId = halfEdges.push(fwd) - 1
    const rId = halfEdges.push(rev) - 1
    ensureOut(fwd.tailV)[fwd.leaveDir] = fId
    ensureOut(rev.tailV)[rev.leaveDir] = rId
  }

  // next(he): at the head vertex, rotate clockwise from the reverse of the
  // arrival direction to the first present outgoing half-edge (rotational system).
  const nextHe = (heId: number): number => {
    const he = halfEdges[heId]
    const out = outDir.get(he.headV)
    if (!out) return -1
    const reverse = (he.arriveDir + 2) % 4
    for (const step of ROT) {
      const k = (reverse + step) % 4
      if (out[k] >= 0) return out[k]
    }
    return out[reverse] >= 0 ? out[reverse] : -1
  }

  const loopsByLabel = new Map<number, EdgeRef[][]>()
  const pushLoop = (label: number, loop: EdgeRef[]): void => {
    if (label === EXT) return
    let arr = loopsByLabel.get(label)
    if (!arr) loopsByLabel.set(label, (arr = []))
    arr.push(loop)
  }

  // --- face walk over junction-anchored half-edges ---
  const visited = new Uint8Array(halfEdges.length)
  for (let h0 = 0; h0 < halfEdges.length; h0++) {
    if (visited[h0]) continue
    const loop: EdgeRef[] = []
    let h = h0
    let guard = 0
    const maxIter = halfEdges.length + 4
    while (h >= 0 && !visited[h] && guard++ < maxIter) {
      visited[h] = 1
      const he = halfEdges[h]
      loop.push({ edge: net.edges[he.edgeIdx].id, reversed: he.reversed })
      h = nextHe(h)
      if (h === h0) break
    }
    if (loop.length > 0) pushLoop(halfEdges[h0].label, loop)
  }

  // --- closed-loop edges: each is one single-edge loop for both adjacent labels ---
  for (let i = 0; i < net.edges.length; i++) {
    const m = meta[i]
    if (!m.closed) continue
    const id = net.edges[i].id
    pushLoop(m.left, [{ edge: id, reversed: false }])
    pushLoop(m.right, [{ edge: id, reversed: true }])
  }

  // --- orient each region's loops for nonzero (outer CCW, holes CW) ---
  const edgeById = new Map<number, SharedEdge>()
  for (const e of edges) edgeById.set(e.id, e)
  for (const loops of loopsByLabel.values()) orientLoops(loops, edgeById)

  // refineJunctions: weld straight-through junctions to a shared G¹ tangent.
  if (opts.refineJunctions) smoothThroughJunctions(edges, loopsByLabel)

  return { vertices, edges, loopsByLabel }
}

// ---------------------------------------------------------------------------
// Orientation: flips EdgeRef loops so the loops themselves carry the nonzero
// winding (outer CCW, holes CW by nesting depth) and materialize stays forward-only.
// ---------------------------------------------------------------------------

function orientLoops(loops: EdgeRef[][], edges: Map<number, SharedEdge>): void {
  const polys = loops.map((loop) => flattenEdgeRefLoop(loop, edges))
  if (loops.length === 1) {
    if (polySignedArea(polys[0]) < 0) flipLoop(loops[0])
    return
  }
  for (let i = 0; i < loops.length; i++) {
    let depth = 0
    for (let j = 0; j < loops.length; j++) if (j !== i && loopInside(polys[i], polys[j])) depth++
    const wantPositive = depth % 2 === 0
    if (polySignedArea(polys[i]) > 0 !== wantPositive) flipLoop(loops[i])
  }
}

/** Reverse a loop's traversal: reverse edge order and toggle each ref. */
function flipLoop(loop: EdgeRef[]): void {
  loop.reverse()
  for (const r of loop) r.reversed = !r.reversed
}

/** Flatten an EdgeRef loop into a dense polygon for winding/containment tests. */
function flattenEdgeRefLoop(loop: EdgeRef[], edges: Map<number, SharedEdge>): Vec[] {
  const nodes: PathNode[] = []
  for (const ref of loop) {
    const e = edges.get(ref.edge)
    if (!e) continue
    const arc = ref.reversed ? reverseEdgeNodes(e.nodes) : e.nodes
    for (const n of arc) nodes.push(n)
  }
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }))
  const sp = { nodes, closed: true }
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < 6; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 6))
  }
  return pts
}

/** Flatten a fitted closed node loop to a polygon (6 samples per segment, like
 *  flattenEdgeRefLoop; area only needs the coarse shape). */
function flattenNodes(nodes: PathNode[]): Vec[] {
  if (nodes.length < 2) return nodes.map((n) => ({ x: n.x, y: n.y }))
  const sp = { nodes, closed: true }
  const pts: Vec[] = []
  const count = segmentCount(sp)
  for (let seg = 0; seg < count; seg++) {
    const { p0, c1, c2, p3 } = segmentControls(sp, seg)
    for (let k = 0; k < 6; k++) pts.push(cubicAt(p0, c1, c2, p3, k / 6))
  }
  return pts
}

/** The exact polygon of a raw crack-lattice ring: direction-change points only
 *  (collinear runs merged — an axis-aligned bar reduces to its 4 corners). The
 *  area-guard fallback: zero drift from the label map, at staircase node cost. */
function staircaseCorners(pts: Vec[]): PathNode[] {
  // Drop a duplicated closing point so the cyclic direction test is clean.
  const ring = pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].y === pts[pts.length - 1].y ? pts.slice(0, -1) : pts.slice()
  const n = ring.length
  const out: PathNode[] = []
  for (let i = 0; i < n; i++) {
    const a = ring[(i - 1 + n) % n]
    const b = ring[i]
    const c = ring[(i + 1) % n]
    const abx = b.x - a.x, aby = b.y - a.y
    const bcx = c.x - b.x, bcy = c.y - b.y
    // Keep b when the direction changes (turn or reversal); skip mid-run points.
    if (abx * bcy - aby * bcx !== 0 || abx * bcx + aby * bcy <= 0) {
      out.push({ x: b.x, y: b.y, hIn: null, hOut: null, kind: 'corner' })
    }
  }
  return out.length >= 3 ? out : ring.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, kind: 'corner' as const }))
}

function polySignedArea(poly: Vec[]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

function loopInside(inner: Vec[], outer: Vec[]): boolean {
  const samples = Math.min(9, inner.length)
  let inside = 0
  let total = 0
  for (let s = 0; s < samples; s++) {
    const k = Math.floor((s * inner.length) / samples)
    total++
    if (pointInPolygon(inner[k], outer)) inside++
  }
  return inside * 2 > total
}

function pointInPolygon(p: Vec, poly: Vec[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}
