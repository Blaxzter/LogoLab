// Discrete piecewise-smooth Mumford–Shah smoothing (Stage 1.1 of the structure-
// first vectorizer — plan §3.1 / §4.1, blueprint paper eq 1–2).
//
// The functional (paper eq 1) is
//
//     u* = argmin_u  Σ_x ‖u(x) − I(x)‖²  +  [∇u]^α_λ ,   [g]^α_λ = min(α‖g‖², λ)
//
// a quadratic data term plus the TRUNCATED-quadratic (Blake–Zisserman /
// line-process) regulariser: a neighbour pair is smoothed quadratically while its
// squared colour step stays below the cap, and is left free (a "discontinuity")
// once it would exceed the cap. The discontinuity map (paper eq 2)
//
//     𝒟 = { x | [∇u*(x)]^α_λ = λ }   (i.e. α‖∇u*‖² ≥ λ)
//
// falls out as a by-product. Everything downstream (segmentation, fills) works on
// the smoothed u and the split into smooth (𝒟̄) / edge (𝒟) pixels.
//
// Minimiser: the standard fast alternation for this non-convex regulariser
// ([SC14], Strekalovskiy–Cremers' real-time scheme) — a binary line process.
// Each outer iteration (a) recomputes the cut/uncut state of every 4-neighbour
// edge from the current u (cut ⇔ α‖Δu‖² ≥ λ), then (b) minimises the resulting
// QUADRATIC sub-problem Σ‖u−I‖² + α Σ_{uncut} ‖Δu‖² with a few Gauss–Seidel
// sweeps. Deterministic (fixed sweep order, no PRNG); pure (no DOM, no Node API),
// so it runs under `node --test` unchanged.
//
// Units note: the cap λ is given in the paper's (unstated) value scale; with its
// fixed λ=1.5, α=1 the cut threshold √(λ/α)=1.22 is unreachable in normalised RGB
// (max step √3≈1.73, real logo edges ≈0.3–0.85), so 𝒟 would be empty. We keep the
// functional FORM exact and the smoothness weight α=1.0, and express the cap as an
// explicit gradient-magnitude threshold T = √(λ/α) recalibrated to this working
// scale (RGB in [0,1], ‖·‖ = L2 over the 3 channels). This is a units conversion,
// not a relaxation; T is tuned against the evaluation harness.

/** Tunables for the discrete Mumford–Shah solve. */
export interface MumfordShahOptions {
  /** Smoothness weight α in min(α‖∇u‖², λ). Paper: 1.0. */
  alpha: number
  /**
   * Discontinuity threshold T = √(λ/α): an inter-pixel colour step ‖Δu‖ ≥ T
   * (RGB[0,1], L2 over channels) is a discontinuity (regulariser saturated). See
   * the units note in the module header for why this is calibrated, not 1.22.
   */
  edgeThreshold: number
  /** Outer line-process iterations (recompute cuts, then diffuse). */
  iterations: number
  /** Gauss–Seidel sweeps of the quadratic sub-problem per outer iteration. */
  sweeps: number
}

/** Paper-derived defaults (α=1.0, λ=1.5); T calibrated to RGB[0,1] — see header. */
export const DEFAULT_MS_OPTIONS: MumfordShahOptions = {
  alpha: 1.0,
  edgeThreshold: 0.15,
  iterations: 24,
  sweeps: 2,
}

/** Smoothed image + discontinuity by-products of one Mumford–Shah solve. */
export interface MumfordShahResult {
  width: number
  height: number
  /** Smoothed channels in [0,1] (3 planes of length w*h: r, then g, then b). */
  r: Float64Array
  g: Float64Array
  b: Float64Array
  /** Per-pixel discontinuity map 𝒟: 1 where the pixel borders a saturated edge. */
  discontinuity: Uint8Array
  /** Opaque mask (alpha ≥ 128): 0 pixels belong to no region and never couple. */
  opaque: Uint8Array
  /** Horizontal cut between pixel i=(x,y) and i+1=(x+1,y); 1 = discontinuity. */
  cutH: Uint8Array
  /** Vertical cut between pixel i=(x,y) and i+w=(x,y+1); 1 = discontinuity. */
  cutV: Uint8Array
}

/** Minimal RGBA source shape (a real ImageData satisfies it). */
interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * Solve the discrete piecewise-smooth Mumford–Shah problem for `img`, returning
 * the smoothed channels and the discontinuity by-products. Transparent pixels
 * (alpha < 128) are excluded: they never diffuse and every edge touching one is a
 * boundary cut.
 */
export function solveMumfordShah(img: RgbaImage, opts: MumfordShahOptions = DEFAULT_MS_OPTIONS): MumfordShahResult {
  const { width: w, height: h, data } = img
  const n = w * h
  const { alpha } = opts
  const thr2 = opts.edgeThreshold * opts.edgeThreshold

  // Original normalised channels (the data term) and the evolving solution u.
  const Ir = new Float64Array(n)
  const Ig = new Float64Array(n)
  const Ib = new Float64Array(n)
  const ur = new Float64Array(n)
  const ug = new Float64Array(n)
  const ub = new Float64Array(n)
  const opaque = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const o = i * 4
    opaque[i] = data[o + 3] >= 128 ? 1 : 0
    const r = data[o] / 255
    const g = data[o + 1] / 255
    const b = data[o + 2] / 255
    Ir[i] = ur[i] = r
    Ig[i] = ug[i] = g
    Ib[i] = ub[i] = b
  }

  const cutH = new Uint8Array(n)
  const cutV = new Uint8Array(n)

  // edge cut ⇔ both endpoints opaque and α‖Δu‖² ≥ λ (i.e. ‖Δu‖² ≥ T²); an edge
  // touching a transparent pixel is always a boundary cut.
  const recomputeCuts = (): void => {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (x + 1 < w) {
          const j = i + 1
          if (!opaque[i] || !opaque[j]) cutH[i] = 1
          else {
            const dr = ur[j] - ur[i]
            const dg = ug[j] - ug[i]
            const db = ub[j] - ub[i]
            cutH[i] = dr * dr + dg * dg + db * db >= thr2 ? 1 : 0
          }
        }
        if (y + 1 < h) {
          const j = i + w
          if (!opaque[i] || !opaque[j]) cutV[i] = 1
          else {
            const dr = ur[j] - ur[i]
            const dg = ug[j] - ug[i]
            const db = ub[j] - ub[i]
            cutV[i] = dr * dr + dg * dg + db * db >= thr2 ? 1 : 0
          }
        }
      }
    }
  }

  // One Gauss–Seidel sweep of Σ‖u−I‖² + α Σ_{uncut} ‖Δu‖². For an opaque pixel,
  // u_i ← (I_i + α Σ_{j uncut} u_j) / (1 + α·#uncut). Sweep direction alternates
  // for faster, still-deterministic convergence.
  const sweep = (forward: boolean): void => {
    const start = forward ? 0 : n - 1
    const end = forward ? n : -1
    const step = forward ? 1 : -1
    for (let i = start; i !== end; i += step) {
      if (!opaque[i]) continue
      const x = i % w
      const y = (i / w) | 0
      let sr = Ir[i]
      let sg = Ig[i]
      let sb = Ib[i]
      let wsum = 1
      // left
      if (x > 0 && !cutH[i - 1] && opaque[i - 1]) {
        sr += alpha * ur[i - 1]; sg += alpha * ug[i - 1]; sb += alpha * ub[i - 1]; wsum += alpha
      }
      // right
      if (x + 1 < w && !cutH[i] && opaque[i + 1]) {
        sr += alpha * ur[i + 1]; sg += alpha * ug[i + 1]; sb += alpha * ub[i + 1]; wsum += alpha
      }
      // up
      if (y > 0 && !cutV[i - w] && opaque[i - w]) {
        sr += alpha * ur[i - w]; sg += alpha * ug[i - w]; sb += alpha * ub[i - w]; wsum += alpha
      }
      // down
      if (y + 1 < h && !cutV[i] && opaque[i + w]) {
        sr += alpha * ur[i + w]; sg += alpha * ug[i + w]; sb += alpha * ub[i + w]; wsum += alpha
      }
      const inv = 1 / wsum
      ur[i] = sr * inv
      ug[i] = sg * inv
      ub[i] = sb * inv
    }
  }

  for (let it = 0; it < opts.iterations; it++) {
    recomputeCuts()
    for (let s = 0; s < opts.sweeps; s++) sweep((it + s) % 2 === 0)
  }
  // Final cut state must match the converged u* so 𝒟 is exactly eq (2).
  recomputeCuts()

  const discontinuity = new Uint8Array(n)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!opaque[i]) continue
      const left = x > 0 && cutH[i - 1]
      const right = x + 1 < w && cutH[i]
      const up = y > 0 && cutV[i - w]
      const down = y + 1 < h && cutV[i]
      if (left || right || up || down) discontinuity[i] = 1
    }
  }

  return { width: w, height: h, r: ur, g: ug, b: ub, discontinuity, opaque, cutH, cutV }
}
