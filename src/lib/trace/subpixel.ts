// Sub-pixel contour tracer — the "crisp edges" alternative to potrace.
//
// potrace hard-thresholds each mask to black/white and traces the pixel-grid
// boundary, so anti-aliasing information is thrown away and a single global
// corner knob has to be both sharp on corners and smooth on curves. This tracer
// instead:
//   1. turns the mask into a CONTINUOUS coverage field (a small Gaussian melts
//      the staircase / lumpy noise into a smooth field),
//   2. extracts the iso=0.5 contour with MARCHING SQUARES, placing every vertex
//      at its true sub-pixel crossing,
//   3. simplifies each loop (Ramer–Douglas–Peucker), detects genuine CORNERS by
//      turn angle, and fits minimal cubic Béziers per smooth span with the
//      Schneider algorithm.
//
// The result is crisp, low-node curves with correct corners — and it is pure JS
// (no WASM, no GPL), so it also runs under `node --test`. Loops are emitted with
// consistent nesting and the path is filled even-odd, which renders holes
// correctly without caring about winding direction.

import type { PathNode, SubPath, Vec } from '../path/types'

export interface CrispOptions {
  /** Gaussian blur sigma (px) applied to the coverage field before contouring. */
  smooth: number
  /** Drop closed loops enclosing less area than this (despeckle). */
  turdsize: number
  /** Turn angle (degrees) above which a vertex stays a hard corner. */
  cornerThreshold: number
  /** Ramer–Douglas–Peucker tolerance (px). */
  simplifyEpsilon: number
  /** Max Schneider fit error (px) before a span is split. */
  fitTolerance: number
}

const ISO = 0.5

/**
 * Trace a binary/coverage mask (opaque black shapes on opaque white, the same
 * input potrace takes) into sub-pixel cubic subpaths, in mask pixel space.
 */
export function traceMaskCrisp(mask: ImageData, opts: CrispOptions): SubPath[] {
  const { width, height } = mask
  const field = buildCoverage(mask, opts.smooth)
  const loops = marchingSquares(field, width, height)

  const subPaths: SubPath[] = []
  for (const loop of loops) {
    if (Math.abs(signedArea(loop)) < opts.turdsize) continue
    const simplified = rdpClosed(loop, opts.simplifyEpsilon)
    if (simplified.length < 3) continue
    const sp = fitLoop(simplified, opts)
    if (sp) subPaths.push(sp)
  }
  return subPaths
}

// ---------------------------------------------------------------------------
// Coverage field
// ---------------------------------------------------------------------------

/**
 * Inside (black, lum < 128) → 1, else 0, then a small separable Gaussian with
 * edge-clamp so full-bleed regions keep their value at the border. Marching
 * squares treats out-of-bounds as 0, which closes border-touching loops exactly
 * at the image edge.
 */
function buildCoverage(mask: ImageData, sigma: number): Float32Array {
  const { width: w, height: h, data } = mask
  const f = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2]
    f[i] = lum < 128 ? 1 : 0
  }
  if (sigma <= 0.01) return f
  return gaussianBlur(f, w, h, sigma)
}

/** Separable Gaussian blur with clamped borders. */
function gaussianBlur(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel[i + radius] = v
    sum += v
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  // Horizontal.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k))
        acc += src[y * w + xx] * kernel[k + radius]
      }
      tmp[y * w + x] = acc
    }
  }
  // Vertical.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k))
        acc += tmp[yy * w + x] * kernel[k + radius]
      }
      out[y * w + x] = acc
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Marching squares → closed sub-pixel loops
// ---------------------------------------------------------------------------

/**
 * Extract iso=0.5 contours as closed polylines (sub-pixel vertices). Cells are
 * iterated over a one-cell-padded grid (out-of-bounds field = 0) so loops close
 * at the image border. Crossings are keyed by grid-edge identity, so segments
 * from adjacent cells share endpoints exactly and stitch into clean loops.
 */
function marchingSquares(field: Float32Array, w: number, h: number): Vec[][] {
  const F = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= w || y >= h ? 0 : field[y * w + x]

  const pts = new Map<string, Vec>()
  // adjacency: edgeId -> connected edgeIds (degree ≤ 2 ⇒ pure loops)
  const adj = new Map<string, string[]>()

  const hKey = (x: number, y: number) => 'h:' + x + ':' + y
  const vKey = (x: number, y: number) => 'v:' + x + ':' + y

  // Lazily compute & cache a crossing point on a grid edge.
  const hPoint = (x: number, y: number): string => {
    const id = hKey(x, y)
    if (!pts.has(id)) {
      const a = F(x, y)
      const b = F(x + 1, y)
      const t = (ISO - a) / (b - a || 1e-12)
      pts.set(id, { x: x + clamp01(t), y })
    }
    return id
  }
  const vPoint = (x: number, y: number): string => {
    const id = vKey(x, y)
    if (!pts.has(id)) {
      const a = F(x, y)
      const b = F(x, y + 1)
      const t = (ISO - a) / (b - a || 1e-12)
      pts.set(id, { x, y: y + clamp01(t) })
    }
    return id
  }

  const link = (a: string, b: string) => {
    let la = adj.get(a)
    if (!la) adj.set(a, (la = []))
    let lb = adj.get(b)
    if (!lb) adj.set(b, (lb = []))
    la.push(b)
    lb.push(a)
  }

  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = F(x, y) >= ISO
      const tr = F(x + 1, y) >= ISO
      const bl = F(x, y + 1) >= ISO
      const br = F(x + 1, y + 1) >= ISO
      const code = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0)
      if (code === 0 || code === 15) continue

      // Edges of this cell.
      const T = () => hPoint(x, y)
      const B = () => hPoint(x, y + 1)
      const L = () => vPoint(x, y)
      const R = () => vPoint(x + 1, y)

      switch (code) {
        case 1: link(L(), B()); break
        case 2: link(B(), R()); break
        case 3: link(L(), R()); break
        case 4: link(T(), R()); break
        case 6: link(T(), B()); break
        case 7: link(L(), T()); break
        case 8: link(T(), L()); break
        case 9: link(T(), B()); break
        case 11: link(T(), R()); break
        case 12: link(L(), R()); break
        case 13: link(B(), R()); break
        case 14: link(L(), B()); break
        case 5: {
          // Saddle: TR+BL inside. Resolve by cell average.
          const avg = (F(x, y) + F(x + 1, y) + F(x, y + 1) + F(x + 1, y + 1)) / 4
          if (avg >= ISO) {
            link(L(), T()); link(B(), R())
          } else {
            link(T(), R()); link(L(), B())
          }
          break
        }
        case 10: {
          // Saddle: TL+BR inside.
          const avg = (F(x, y) + F(x + 1, y) + F(x, y + 1) + F(x + 1, y + 1)) / 4
          if (avg >= ISO) {
            link(T(), R()); link(L(), B())
          } else {
            link(L(), T()); link(B(), R())
          }
          break
        }
      }
    }
  }

  // Stitch loops by walking the degree-2 adjacency.
  const visited = new Set<string>()
  const loops: Vec[][] = []
  for (const start of adj.keys()) {
    if (visited.has(start)) continue
    const loop: Vec[] = []
    let prev = ''
    let cur = start
    while (cur && !visited.has(cur)) {
      visited.add(cur)
      loop.push(pts.get(cur)!)
      const neighbors = adj.get(cur) ?? []
      const next = neighbors.find((n) => n !== prev && !visited.has(n))
      prev = cur
      cur = next ?? ''
    }
    if (loop.length >= 3) loops.push(loop)
  }
  return loops
}

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t)

/** Signed area of a closed polyline (shoelace). */
function signedArea(p: Vec[]): number {
  let a = 0
  for (let i = 0, n = p.length; i < n; i++) {
    const q = p[(i + 1) % n]
    a += p[i].x * q.y - q.x * p[i].y
  }
  return a / 2
}

// ---------------------------------------------------------------------------
// Simplification (Ramer–Douglas–Peucker, closed)
// ---------------------------------------------------------------------------

/** RDP on a closed loop: anchor the two extreme points, simplify both arcs. */
function rdpClosed(loop: Vec[], eps: number): Vec[] {
  const n = loop.length
  if (n < 4) return loop.slice()
  // Pick the two farthest-apart points as stable anchors.
  let iA = 0
  let iB = 0
  let best = -1
  for (let i = 1; i < n; i++) {
    const d = dist2(loop[0], loop[i])
    if (d > best) {
      best = d
      iB = i
    }
  }
  best = -1
  for (let i = 0; i < n; i++) {
    const d = dist2(loop[iB], loop[i])
    if (d > best) {
      best = d
      iA = i
    }
  }
  const arc1 = sliceCyclic(loop, iA, iB)
  const arc2 = sliceCyclic(loop, iB, iA)
  const s1 = rdpOpen(arc1, eps)
  const s2 = rdpOpen(arc2, eps)
  // Concatenate, dropping the shared endpoints' duplicates.
  return s1.slice(0, -1).concat(s2.slice(0, -1))
}

/** The whole loop as an open polyline starting and ending at `start`. */
function fullCycle(loop: Vec[], start: number): Vec[] {
  const n = loop.length
  const out: Vec[] = []
  for (let k = 0; k <= n; k++) out.push(loop[(start + k) % n])
  return out
}

function sliceCyclic(loop: Vec[], from: number, to: number): Vec[] {
  const n = loop.length
  const out: Vec[] = []
  let i = from
  while (true) {
    out.push(loop[i])
    if (i === to) break
    i = (i + 1) % n
  }
  return out
}

function rdpOpen(pts: Vec[], eps: number): Vec[] {
  if (pts.length < 3) return pts.slice()
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: [number, number][] = [[0, pts.length - 1]]
  while (stack.length) {
    const [lo, hi] = stack.pop()!
    let maxD = -1
    let idx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDistance(pts[i], pts[lo], pts[hi])
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
  const out: Vec[] = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

// ---------------------------------------------------------------------------
// Corner detection + curve fitting
// ---------------------------------------------------------------------------

/** Arc-length neighbourhood (px) used to measure turn for corner detection. */
const CORNER_SUPPORT = 2.5

/** Fit a simplified closed loop into a cubic SubPath. */
function fitLoop(loop: Vec[], opts: CrispOptions): SubPath | null {
  const n = loop.length
  if (n < 3) return null

  const corners = detectCorners(loop, opts.cornerThreshold, CORNER_SUPPORT)

  // No genuine corners (e.g. a circle): break the loop at its sharpest vertex
  // so it is fit as one closed smooth arc.
  if (corners.length === 0) corners.push(sharpestVertex(loop))

  // Build arcs between consecutive corners (wrapping), fit each, and assemble.
  const nodes: PathNode[] = []
  if (corners.length === 1) {
    // Corner-less loop: one closed smooth arc that wraps all the way around.
    appendBeziers(nodes, fitArc(fullCycle(loop, corners[0]), opts.fitTolerance), true)
  } else {
    for (let c = 0; c < corners.length; c++) {
      const a = corners[c]
      const b = corners[(c + 1) % corners.length]
      const arc = sliceCyclic(loop, a, b)
      appendBeziers(nodes, fitArc(arc, opts.fitTolerance), c === 0)
    }
  }
  // The loop closes: merge the trailing anchor into the first node's hIn.
  if (nodes.length >= 2) {
    const last = nodes[nodes.length - 1]
    const first = nodes[0]
    if (near(last, first)) {
      first.hIn = last.hIn
      nodes.pop()
    }
  }
  // Re-tag corner/smooth from final handle geometry.
  for (let i = 0; i < nodes.length; i++) tagKind(nodes[i])
  if (nodes.length < 2) return null
  return { nodes, closed: true }
}

/** Append a chain of cubic segments to the node list (sharing anchors). */
function appendBeziers(nodes: PathNode[], beziers: Bezier[], first: boolean): void {
  for (let i = 0; i < beziers.length; i++) {
    const bz = beziers[i]
    // Collinear controls ⇒ emit a true line (null handles): smaller, cleaner SVG.
    const line = isLineBezier(bz)
    const hOut = line ? null : handle(bz.p0, bz.c1)
    const hIn = line ? null : handle(bz.p3, bz.c2)
    if (i === 0 && first) {
      nodes.push({ x: bz.p0.x, y: bz.p0.y, hIn: null, hOut, kind: 'corner' })
    } else {
      // p0 equals the existing last node — just set its outgoing handle.
      nodes[nodes.length - 1].hOut = hOut
    }
    nodes.push({ x: bz.p3.x, y: bz.p3.y, hIn, hOut: null, kind: 'corner' })
  }
}

/** True when both control points sit (within ε) on the chord — a straight segment. */
function isLineBezier(bz: Bezier): boolean {
  const eps = 0.08
  return perpDistance(bz.c1, bz.p0, bz.p3) < eps && perpDistance(bz.c2, bz.p0, bz.p3) < eps
}

/** A control point relative to its anchor, collapsed to null when coincident. */
function handle(anchor: Vec, control: Vec): Vec | null {
  return Math.hypot(control.x - anchor.x, control.y - anchor.y) < 1e-6
    ? null
    : { x: control.x, y: control.y }
}

/** Tag a node smooth when its handles are roughly collinear-opposite. */
function tagKind(node: PathNode): void {
  if (!node.hIn || !node.hOut) {
    node.kind = 'corner'
    return
  }
  const ix = node.x - node.hIn.x
  const iy = node.y - node.hIn.y
  const ox = node.hOut.x - node.x
  const oy = node.hOut.y - node.y
  const li = Math.hypot(ix, iy)
  const lo = Math.hypot(ox, oy)
  if (li < 1e-9 || lo < 1e-9) {
    node.kind = 'corner'
    return
  }
  node.kind = (ix * ox + iy * oy) / (li * lo) > Math.cos((35 * Math.PI) / 180) ? 'smooth' : 'corner'
}

/**
 * Corners are vertices where the polyline turns by more than `thresholdDeg`,
 * measured between points roughly `support` px back and forward along the loop
 * (so a 90° corner split into two staircase chamfer vertices is still caught).
 * Non-maximal candidates inside the support window are suppressed.
 */
function detectCorners(loop: Vec[], thresholdDeg: number, support: number): number[] {
  const n = loop.length
  const thr = (thresholdDeg * Math.PI) / 180
  const turn = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const back = walkArc(loop, i, -1, support)
    const fwd = walkArc(loop, i, 1, support)
    const a = sub(loop[i], back)
    const b = sub(fwd, loop[i])
    const la = Math.hypot(a.x, a.y)
    const lb = Math.hypot(b.x, b.y)
    if (la < 1e-9 || lb < 1e-9) continue
    let cos = (a.x * b.x + a.y * b.y) / (la * lb)
    cos = cos < -1 ? -1 : cos > 1 ? 1 : cos
    turn[i] = Math.acos(cos)
  }

  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    if (turn[i] <= thr) continue
    let localMax = true
    for (const dir of [-1, 1] as const) {
      let j = i
      let acc = 0
      while (true) {
        const k = (j + dir + n) % n
        const step = dist(loop[j], loop[k])
        // Only compare vertices that actually fall inside the support window —
        // a far neighbour (a long straight edge) must not suppress this corner.
        if (acc + step > support) break
        acc += step
        j = k
        if (j === i) break
        // Strict greater, with index tie-break so equal twin chamfers collapse.
        if (turn[j] > turn[i] || (turn[j] === turn[i] && j < i)) {
          localMax = false
          break
        }
      }
      if (!localMax) break
    }
    if (localMax) corners.push(i)
  }
  return corners
}

/** Walk `support` px along the loop from `i` in `dir`, returning the landing point. */
function walkArc(loop: Vec[], i: number, dir: number, support: number): Vec {
  const n = loop.length
  let j = i
  let acc = 0
  while (acc < support) {
    const k = (j + dir + n) % n
    acc += dist(loop[j], loop[k])
    j = k
    if (j === i) break
  }
  return loop[j]
}

function sharpestVertex(loop: Vec[]): number {
  const n = loop.length
  let bestI = 0
  let bestCos = 2
  for (let i = 0; i < n; i++) {
    const prev = loop[(i - 1 + n) % n]
    const cur = loop[i]
    const next = loop[(i + 1) % n]
    const ax = cur.x - prev.x
    const ay = cur.y - prev.y
    const bx = next.x - cur.x
    const by = next.y - cur.y
    const la = Math.hypot(ax, ay)
    const lb = Math.hypot(bx, by)
    if (la < 1e-9 || lb < 1e-9) continue
    const cos = (ax * bx + ay * by) / (la * lb)
    if (cos < bestCos) {
      bestCos = cos
      bestI = i
    }
  }
  return bestI
}

// ---------------------------------------------------------------------------
// Schneider cubic Bézier fitting (Graphics Gems, "An Algorithm for Automatically
// Fitting Digitized Curves").
// ---------------------------------------------------------------------------

interface Bezier {
  p0: Vec
  c1: Vec
  c2: Vec
  p3: Vec
}

/** Fit an OPEN polyline arc with one or more cubic Béziers. */
function fitArc(points: Vec[], tolerance: number): Bezier[] {
  if (points.length < 2) return []
  if (points.length === 2) {
    const d = dist(points[0], points[1]) / 3
    const t = unit(sub(points[1], points[0]))
    return [
      {
        p0: points[0],
        c1: add(points[0], scale(t, d)),
        c2: sub(points[1], scale(t, d)),
        p3: points[1],
      },
    ]
  }
  const tHat1 = unit(sub(points[1], points[0]))
  const tHat2 = unit(sub(points[points.length - 2], points[points.length - 1]))
  return fitCubic(points, tHat1, tHat2, tolerance)
}

function fitCubic(d: Vec[], tHat1: Vec, tHat2: Vec, tol: number): Bezier[] {
  if (d.length === 2) {
    const dd = dist(d[0], d[1]) / 3
    return [{ p0: d[0], c1: add(d[0], scale(tHat1, dd)), c2: add(d[1], scale(tHat2, dd)), p3: d[1] }]
  }

  let u = chordLengthParameterize(d)
  let bez = generateBezier(d, u, tHat1, tHat2)
  let { error, split } = computeMaxError(d, bez, u)
  if (error < tol) return [bez]

  // A few Newton-Raphson reparameterizations before giving up and splitting.
  if (error < tol * tol) {
    for (let i = 0; i < 4; i++) {
      const uPrime = reparameterize(d, u, bez)
      bez = generateBezier(d, uPrime, tHat1, tHat2)
      const e = computeMaxError(d, bez, uPrime)
      if (e.error < tol) return [bez]
      u = uPrime
      error = e.error
      split = e.split
    }
  }

  const tHatCenter = unit(sub(d[split - 1], d[split + 1]))
  const left = fitCubic(d.slice(0, split + 1), tHat1, tHatCenter, tol)
  const right = fitCubic(d.slice(split), negate(tHatCenter), tHat2, tol)
  return left.concat(right)
}

function generateBezier(d: Vec[], u: number[], tHat1: Vec, tHat2: Vec): Bezier {
  const n = d.length
  const A: [Vec, Vec][] = []
  for (let i = 0; i < n; i++) {
    A.push([scale(tHat1, 3 * u[i] * (1 - u[i]) * (1 - u[i])), scale(tHat2, 3 * u[i] * u[i] * (1 - u[i]))])
  }
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < n; i++) {
    c00 += dot(A[i][0], A[i][0])
    c01 += dot(A[i][0], A[i][1])
    c11 += dot(A[i][1], A[i][1])
    const ui = u[i]
    const b0 = (1 - ui) ** 3
    const b1 = 3 * ui * (1 - ui) ** 2
    const b2 = 3 * ui * ui * (1 - ui)
    const b3 = ui ** 3
    // tmp = d[i] − [P0·(B0+B1) + P3·(B2+B3)], with P0 = d[0], P3 = d[n−1].
    const tmp = sub(d[i], add(scale(d[0], b0 + b1), scale(d[n - 1], b2 + b3)))
    x0 += dot(A[i][0], tmp)
    x1 += dot(A[i][1], tmp)
  }
  const det = c00 * c11 - c01 * c01
  let alphaL = 0
  let alphaR = 0
  if (Math.abs(det) > 1e-12) {
    alphaL = (x0 * c11 - x1 * c01) / det
    alphaR = (c00 * x1 - c01 * x0) / det
  }
  const segLength = dist(d[0], d[n - 1])
  const epsilon = 1e-6 * segLength
  if (alphaL < epsilon || alphaR < epsilon) {
    // Fall back to Wu/Barsky heuristic (handles at 1/3 chord).
    const d3 = segLength / 3
    return {
      p0: d[0],
      c1: add(d[0], scale(tHat1, d3)),
      c2: add(d[n - 1], scale(tHat2, d3)),
      p3: d[n - 1],
    }
  }
  return {
    p0: d[0],
    c1: add(d[0], scale(tHat1, alphaL)),
    c2: add(d[n - 1], scale(tHat2, alphaR)),
    p3: d[n - 1],
  }
}

function computeMaxError(d: Vec[], bez: Bezier, u: number[]): { error: number; split: number } {
  let maxDist = 0
  let split = Math.floor(d.length / 2)
  for (let i = 1; i < d.length - 1; i++) {
    const p = bezierAt(bez, u[i])
    const d2 = dist2(p, d[i])
    if (d2 > maxDist) {
      maxDist = d2
      split = i
    }
  }
  return { error: Math.sqrt(maxDist), split }
}

function reparameterize(d: Vec[], u: number[], bez: Bezier): number[] {
  return u.map((ui, i) => newtonRaphson(bez, d[i], ui))
}

function newtonRaphson(bez: Bezier, point: Vec, u: number): number {
  const q = bezierAt(bez, u)
  // First/second derivatives of the cubic.
  const q1 = [
    scale(sub(bez.c1, bez.p0), 3),
    scale(sub(bez.c2, bez.c1), 3),
    scale(sub(bez.p3, bez.c2), 3),
  ]
  const q2 = [scale(sub(q1[1], q1[0]), 2), scale(sub(q1[2], q1[1]), 2)]
  const qu = bezier2At(q1, u)
  const quu = bezier1At(q2, u)
  const num = (q.x - point.x) * qu.x + (q.y - point.y) * qu.y
  const den = qu.x * qu.x + qu.y * qu.y + (q.x - point.x) * quu.x + (q.y - point.y) * quu.y
  if (Math.abs(den) < 1e-12) return u
  return u - num / den
}

function chordLengthParameterize(d: Vec[]): number[] {
  const u = [0]
  for (let i = 1; i < d.length; i++) u.push(u[i - 1] + dist(d[i], d[i - 1]))
  const total = u[u.length - 1] || 1
  return u.map((v) => v / total)
}

// Bézier evaluators for cubic / quadratic / linear control sets.
function bezierAt(b: Bezier, t: number): Vec {
  const mt = 1 - t
  const a = mt * mt * mt
  const c = 3 * mt * mt * t
  const e = 3 * mt * t * t
  const g = t * t * t
  return {
    x: a * b.p0.x + c * b.c1.x + e * b.c2.x + g * b.p3.x,
    y: a * b.p0.y + c * b.c1.y + e * b.c2.y + g * b.p3.y,
  }
}
function bezier2At(p: Vec[], t: number): Vec {
  const mt = 1 - t
  return {
    x: mt * mt * p[0].x + 2 * mt * t * p[1].x + t * t * p[2].x,
    y: mt * mt * p[0].y + 2 * mt * t * p[1].y + t * t * p[2].y,
  }
}
function bezier1At(p: Vec[], t: number): Vec {
  return { x: (1 - t) * p[0].x + t * p[1].x, y: (1 - t) * p[0].y + t * p[1].y }
}

// ---------------------------------------------------------------------------
// Small vector helpers
// ---------------------------------------------------------------------------

const sub = (a: Vec, b: Vec): Vec => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Vec, b: Vec): Vec => ({ x: a.x + b.x, y: a.y + b.y })
const scale = (a: Vec, s: number): Vec => ({ x: a.x * s, y: a.y * s })
const negate = (a: Vec): Vec => ({ x: -a.x, y: -a.y })
const dot = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y)
const dist2 = (a: Vec, b: Vec): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
const near = (a: Vec, b: Vec): boolean => dist2(a, b) < 1e-6
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
