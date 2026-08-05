// SUB-PIXEL EDGE PLACEMENT for the planar tracer (§0 #8, benchmarks §15).
//
// The planar engine samples every boundary on the INTEGER crack lattice between label
// regions, so its geometry is quantized before anything is fitted: measured, the raw
// chains sit a CONSTANT ~0.224px from the authored geometry at every resolution — the
// quantization floor of integer-lattice sampling — and the fit only reproduces it
// ("fit adds" ≤ 1.0×, §15.3). The sub-pixel information exists in the anti-aliasing;
// this pass reads it.
//
// WHY THIS SHAPE — the shared-edge constraint. The CRISP engine (subpixel.ts) already
// places vertices at true iso-0.5 crossings, but its coverage field is per-region mask;
// two neighbouring regions each get their own contour and nothing makes them agree. The
// planar structure solves that BY CONSTRUCTION: each boundary is stored ONCE
// (PlanarEdge.pts) and referenced by both regions, so displacing the stored chain — the
// same move §14's threadJunctions makes for junction positions — keeps adjacent regions
// byte-coincident with no reconciliation step at all.
//
// THE ESTIMATOR, per interior chain point:
//   1. local left-normal n from the chain tangent (left = e.left's side, matching
//      stepLabels' convention in planarNetwork.ts);
//   2. two FAR anchors at ±FAR px along n — expected to be PURE region colour. Both are
//      verified against the LABEL MAP: the pixel containing each anchor must carry the
//      edge's own left/right label, else the point is left on the lattice. This one
//      guard covers junction neighbourhoods (a third region inside the window), thin
//      features (the opposite wall inside the window) and the image border, without
//      special-casing any of them;
//   3. the local contrast axis is farL − farR — LOCAL, not the palette entry, so shaded
//      fills and posterization bands measure their own contrast (§14 reads the palette
//      because it needs a global weak/strong CLASSIFICATION; this pass only needs the
//      direction to project onto);
//   4. coverage f(s) = ⟨I(s) − farR, axis⟩ / |axis|² along n — f(−FAR) = 0, f(+FAR) = 1
//      by construction — and the edge is the f = 0.5 crossing, found by linear
//      interpolation between the bracketing samples (the marching-squares move, applied
//      on the shared chain);
//   5. guards, each of which leaves the point ON the lattice rather than guessing:
//      weak contrast (the axis is too short for f to be signal), an unexplainable near
//      sample (its colour is far from the [farR, farL] segment — a third colour is
//      leaking in), a non-monotone profile (not a single edge), and a displacement
//      beyond MAX_DISP (a 1px-AA crack cannot honestly move further; a larger answer
//      means the model does not apply here).
//
// An EXACT axis-aligned edge yields f(−NEAR) = 0, f(+NEAR) = 1 and the interpolated
// crossing lands at δ = 0 precisely — pixel-exact art (checker) is untouched, in float
// as well as in spirit.
//
// Pure & deterministic: reads the image and label map, writes nothing, no PRNG/Date.

import type { Vec } from '../path/types'
import { EXT, type PlanarEdge, type PlanarNetwork } from './planarNetwork.ts'

export interface SourceImage {
  data: Uint8ClampedArray | Uint8Array
  width: number
  height: number
}

/** Distance (px) of the pure-colour anchors along the normal. Far enough that a 1px AA
 *  ramp has decayed (±1.75 clears the ~1px resvg ramp with margin), near enough that the
 *  label guard still protects thin features (a 2px bar keeps its anchors inside). */
const FAR = 1.75
/** Distance (px) of the blend samples that bracket the crack. */
const NEAR = 0.5
/** Accept threshold for the recovered offset. A crack separates two differently-labelled
 *  pixels, so the true iso-crossing of a ~1px AA ramp lies within ~±0.75px of it; an
 *  estimate beyond that is a model failure (wide blur, shading), not a measurement. */
const MAX_DISP = 0.75
/** Minimum |farL − farR| (RGB euclidean). Below this the projection axis is noise —
 *  ~ΔE 5, the same order as §14's weak-seam floor. */
const MIN_CONTRAST = 12
/** Max distance of a near sample from its projection onto the [farR, farL] segment.
 *  A genuine coverage blend lies ON the segment (the §9.5 blend-line model, eps 10);
 *  beyond this a third colour is present and the estimate would be polluted. */
const RESIDUAL_MAX = 16
/**
 * ANCHOR FLATNESS: |I(±FAR) − I(±(FAR+1))| must stay under this (RGB euclidean), or the
 * anchor sits in a RAMP, not in flat region colour, and the whole profile is polluted.
 * The label guard alone cannot catch this: inside a ~3.5px bar the anchor at 1.75px
 * carries the bar's label but never its pure colour (the opposite wall's AA reaches it),
 * so both walls' iso estimates bias INWARD and the bar narrows — measured @256 on
 * bar-caps, where three narrowed bars tripped the area guard into the staircase
 * fallback (parsimony 5.99×), and on annulus, whose ring interiors are similarly
 * pinched between walls at coarse rasters. A genuine flat anchor reads ~0 here; a
 * shallow authored gradient reads a few RGB per px and stays under the tolerance. */
const ANCHOR_FLAT_MAX = 10
/** f must not step backwards by more than this between successive samples — a
 *  non-monotone profile is not a single edge crossing. */
const MONO_EPS = 0.15
/**
 * CORNER SELF-GUARD. The AA iso-line ROUNDS every corner (shaves a tip, fills a root),
 * so a displaced chain curves smoothly into an apex and the fit faithfully melts it —
 * measured twice: gear-teeth's 67.3° roots fell 28→6 recovered, and the gallery
 * witnesses' small letterform corners fell 87.8% → 75.6% recovered @512 even with a
 * detector-driven guard, because a corner with ~3px arms reads far below any windowed
 * turn threshold on the LATTICE chain (§10.6's window-dilution regime). The displaced
 * chain does not have that problem: its staircase noise is gone, so a high local turn ON
 * THE DISPLACED CHAIN is a real corner at ANY feature size. Where the turn over ±TURN_WIN
 * displaced steps exceeds TURN_MAX, the chain reverts to the lattice for ±TURN_GUARD
 * steps — the fitters then see the exact staircase they were calibrated on there, and the
 * corner machinery (detect / snap-to-arms) behaves as before this pass existed.
 * TURN_MAX 35°: a genuine circle only reaches 33° at r ≈ 7px (turn ≈ 2·win/r), so real
 * small discs keep their displacement; anything sharper than ~35° is not an arc the
 * fitters would keep smooth anyway. */
const TURN_WIN = 4
const TURN_MAX_DEG = 35
const TURN_GUARD = 5

/**
 * Compute sub-pixel positions for every edge chain in the network. Returns edgeId →
 * displaced pts (same length, same indices — corner indices detected on the raw chain
 * remain valid). Open-edge ENDPOINTS are never displaced: junction placement is its own
 * problem (§14 thread / §0 #15), and the assemble step pins them to the junction vertex.
 * Chains the estimator declines are returned as-is (the caller can use identity).
 */
export function subpixelEdgeChains(
  net: PlanarNetwork,
  labels: Int32Array,
  image: SourceImage,
): Map<number, Vec[]> {
  const { width: w, height: h, data } = image
  const labelAt = (x: number, y: number): number => {
    // The pixel containing continuous point (x, y); lattice corners sit BETWEEN pixels,
    // but every sampled point is ±FAR/±NEAR off the corner along a non-degenerate
    // normal, so the floor is well-defined where it matters.
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    return xi < 0 || yi < 0 || xi >= w || yi >= h ? EXT : labels[yi * w + xi]
  }

  /** Bilinear sample over pixel centers; clamped at the border. Returns [r, g, b]. */
  const bilin = (x: number, y: number, out: Float64Array): void => {
    const u = Math.min(w - 1, Math.max(0, x - 0.5))
    const v = Math.min(h - 1, Math.max(0, y - 0.5))
    const x0 = Math.min(w - 2, Math.max(0, Math.floor(u)))
    const y0 = Math.min(h - 2, Math.max(0, Math.floor(v)))
    const fx = Math.min(1, Math.max(0, u - x0))
    const fy = Math.min(1, Math.max(0, v - y0))
    const i00 = (y0 * w + x0) * 4
    const i10 = i00 + 4
    const i01 = i00 + w * 4
    const i11 = i01 + 4
    const w00 = (1 - fx) * (1 - fy)
    const w10 = fx * (1 - fy)
    const w01 = (1 - fx) * fy
    const w11 = fx * fy
    for (let c = 0; c < 3; c++) {
      out[c] = data[i00 + c] * w00 + data[i10 + c] * w10 + data[i01 + c] * w01 + data[i11 + c] * w11
    }
  }

  // Scratch buffers (hot loop; no per-point allocation).
  const farL = new Float64Array(3)
  const farR = new Float64Array(3)
  const nearS = new Float64Array(3)
  const flatS = new Float64Array(3)

  const out = new Map<number, Vec[]>()

  for (const e of net.edges) {
    // Border chains (region against the canvas edge / transparency) stay on the lattice:
    // there is no second colour to read a crossing from.
    if (e.left === EXT || e.right === EXT) continue
    const pts = e.pts
    const n = pts.length
    if (n < 3) continue

    let displaced: Vec[] | null = null
    const lo = e.closed ? 0 : 1
    const hi = e.closed ? n - 1 : n - 2

    for (let i = lo; i <= hi; i++) {
      const p = pts[i]
      // Local tangent over a ±1 window (closed chains wrap; walkLoop stores no
      // duplicate endpoint, so the wrap is clean).
      const prev = e.closed ? pts[(i - 1 + n) % n] : pts[i - 1]
      const next = e.closed ? pts[(i + 1) % n] : pts[i + 1]
      const tx = next.x - prev.x
      const ty = next.y - prev.y
      const tl = Math.hypot(tx, ty)
      if (tl < 1e-9) continue
      // Left normal: rotate the tangent so it points into e.left's pixels (for an E step
      // the left label is the N pixel — see stepLabels in planarNetwork.ts).
      const nx = ty / tl
      const ny = -tx / tl

      // Far anchors must land in their OWN region's pixels — the one guard that covers
      // junction neighbourhoods, thin features and the border alike.
      if (labelAt(p.x + FAR * nx, p.y + FAR * ny) !== e.left) continue
      if (labelAt(p.x - FAR * nx, p.y - FAR * ny) !== e.right) continue

      bilin(p.x + FAR * nx, p.y + FAR * ny, farL)
      bilin(p.x - FAR * nx, p.y - FAR * ny, farR)
      const ax = farL[0] - farR[0]
      const ay = farL[1] - farR[1]
      const az = farL[2] - farR[2]
      const c2 = ax * ax + ay * ay + az * az
      if (c2 < MIN_CONTRAST * MIN_CONTRAST) continue

      // Anchor flatness (see ANCHOR_FLAT_MAX): an anchor sitting in a ramp — the
      // opposite wall of a thin feature, a wide blur — is not a pure-colour witness.
      bilin(p.x + (FAR + 1) * nx, p.y + (FAR + 1) * ny, flatS)
      let d0 = flatS[0] - farL[0], d1 = flatS[1] - farL[1], d2 = flatS[2] - farL[2]
      if (d0 * d0 + d1 * d1 + d2 * d2 > ANCHOR_FLAT_MAX * ANCHOR_FLAT_MAX) continue
      bilin(p.x - (FAR + 1) * nx, p.y - (FAR + 1) * ny, flatS)
      d0 = flatS[0] - farR[0]; d1 = flatS[1] - farR[1]; d2 = flatS[2] - farR[2]
      if (d0 * d0 + d1 * d1 + d2 * d2 > ANCHOR_FLAT_MAX * ANCHOR_FLAT_MAX) continue

      // Coverage profile along the normal: f(-FAR) = 0 and f(+FAR) = 1 by construction.
      let ok = true
      let f1 = 0 // f(-NEAR)
      let f2 = 0 // f(+NEAR)
      for (let k = 0; k < 2; k++) {
        const s = k === 0 ? -NEAR : NEAR
        bilin(p.x + s * nx, p.y + s * ny, nearS)
        const dx = nearS[0] - farR[0]
        const dy = nearS[1] - farR[1]
        const dz = nearS[2] - farR[2]
        const f = (dx * ax + dy * ay + dz * az) / c2
        // Explainability: the sample must lie near the [farR, farL] segment — a genuine
        // two-colour coverage blend does; a third colour leaking in does not.
        const t = Math.min(1, Math.max(0, f))
        const rx = dx - t * ax
        const ry = dy - t * ay
        const rz = dz - t * az
        if (rx * rx + ry * ry + rz * rz > RESIDUAL_MAX * RESIDUAL_MAX) {
          ok = false
          break
        }
        if (k === 0) f1 = f
        else f2 = f
      }
      if (!ok) continue
      // A single edge crossing is monotone in s (f rises toward the left region).
      if (f1 > f2 + MONO_EPS || f1 < -MONO_EPS || f2 > 1 + MONO_EPS) continue

      // Locate f = 0.5 by linear interpolation between the bracketing samples.
      let delta: number
      if (f1 >= 0.5) {
        // Crossing between -FAR (f=0) and -NEAR (f=f1).
        delta = -FAR + ((0.5 - 0) / Math.max(1e-9, f1 - 0)) * (FAR - NEAR)
      } else if (f2 <= 0.5) {
        // Crossing between +NEAR (f=f2) and +FAR (f=1).
        delta = NEAR + ((0.5 - f2) / Math.max(1e-9, 1 - f2)) * (FAR - NEAR)
      } else {
        // The typical case: between the two near samples.
        delta = -NEAR + ((0.5 - f1) / Math.max(1e-9, f2 - f1)) * (2 * NEAR)
      }
      if (!Number.isFinite(delta) || Math.abs(delta) > MAX_DISP) continue
      if (delta === 0) continue

      if (!displaced) displaced = pts.map((q) => ({ x: q.x, y: q.y }))
      displaced[i] = { x: p.x + delta * nx, y: p.y + delta * ny }
    }

    if (displaced) {
      revertCorners(displaced, pts, e.closed)
      out.set(e.id, displaced)
    }
  }
  return out
}

/** The corner self-guard (see TURN_MAX_DEG above): measure the local turn on the
 *  DISPLACED chain and revert to the lattice around every corner-sharp zone. */
function revertCorners(displaced: Vec[], lattice: Vec[], closed: boolean): void {
  const n = displaced.length
  if (n < 2 * TURN_WIN + 1) return
  const cosMax = Math.cos((TURN_MAX_DEG * Math.PI) / 180)
  const at = (i: number): Vec => (closed ? displaced[((i % n) + n) % n] : displaced[Math.min(n - 1, Math.max(0, i))])
  const sharp: number[] = []
  const lo = closed ? 0 : TURN_WIN
  const hi = closed ? n - 1 : n - 1 - TURN_WIN
  for (let i = lo; i <= hi; i++) {
    const a = at(i - TURN_WIN)
    const b = at(i)
    const c = at(i + TURN_WIN)
    const ux = b.x - a.x
    const uy = b.y - a.y
    const vx = c.x - b.x
    const vy = c.y - b.y
    const ul = Math.hypot(ux, uy)
    const vl = Math.hypot(vx, vy)
    if (ul < 1e-9 || vl < 1e-9) continue
    if ((ux * vx + uy * vy) / (ul * vl) < cosMax) sharp.push(i)
  }
  for (const i of sharp) {
    for (let o = -TURN_GUARD; o <= TURN_GUARD; o++) {
      const j = closed ? (((i + o) % n) + n) % n : Math.min(n - 1, Math.max(0, i + o))
      displaced[j] = { x: lattice[j].x, y: lattice[j].y }
    }
  }
}

/** Re-export for callers that only need the type. */
export type { PlanarEdge }
